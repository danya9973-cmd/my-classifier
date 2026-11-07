// 화면 — criteria.json · keywords.json · data/answer.json 을 읽어서 그린다.
// 정답과 낱말은 이 파일에 적지 않는다. AI 는 서버 함수(/api/classify)를 거쳐서만 부른다 — 열쇠는 브라우저에 오지 않는다.

import { maskText, MASK_TAGS } from './mask.js';
import { classify, labelsOf, DIMS } from './rules.js';

const AI_URL = '/api/classify';
const AI_CLIENT_TIMEOUT_MS = 75000; // 서버 함수가 Gemini 를 60초까지 기다리므로 그보다 조금 길게
const AI_BATCHES = 4;               // 채점할 때 문장을 몇 번에 나눠 보낼지
const DOWNLOAD_NAME = 'ai_채점결과.json';
const MODEL_KEY = 'my-classifier:model'; // 고른 모델을 이 브라우저에만 기억한다

const $ = (id) => document.getElementById(id);
const state = {
  criteria: null, keywords: null, answer: null, lastAI: null,
  models: [],          // [{id, 이름, 설명}]
  model: null,         // 지금 고른 모델 id
  busy: new Map(),     // 붐빈다고 답한 모델 id → 시각 (화면에 «붐빔» 표시)
};

async function loadJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} 를 읽지 못했습니다 (${res.status})`);
  return res.json();
}

async function ensureAnswer() {
  // answer.json 은 채점할 때만 연다
  if (!state.answer) state.answer = await loadJSON('data/answer.json');
  return state.answer;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// 가린 문장에서 [이름] 같은 표시만 노란 칸으로 보여 준다 (글은 textContent 로만 넣는다)
const TAG_SPLIT = new RegExp(`(\\[(?:${MASK_TAGS.join('|')})\\])`);
function maskedNode(text, cls) {
  const p = el('p', { class: cls });
  for (const part of text.split(TAG_SPLIT)) {
    if (!part) continue;
    p.append(TAG_SPLIT.test(part) ? el('span', { class: 'mask' }, part) : document.createTextNode(part));
  }
  return p;
}

function foundText(found) {
  const parts = Object.entries(found).map(([tag, n]) => `${tag} ${n}`);
  return parts.length ? `가린 것: ${parts.join(' · ')}` : '가린 것 없음';
}

// 빨갛게 보일 값 — criteria.json 의 긴급도 첫 단계(가장 급한 것: 높음)와 감정 마지막 단계(부정)
const ALERT_TEXT = '경고 메시지: 긴급상황 발생 — 즉시 처리 요망';
function isAlarming(dim, value) {
  const labels = labelsOf(state.criteria);
  if (dim === '긴급도') return labels.긴급도[0] === value;
  if (dim === '감정') return labels.감정.at(-1) === value;
  return false;
}

function pct(n, total) {
  return `${((n / total) * 100).toFixed(1)}%`;
}

/* ---------- 모델 고르기 ---------- */
async function loadModels() {
  // 서버 함수가 있으면 서버 목록(GEMINI_MODEL 반영)을, 없으면 models.json 을 쓴다
  let list = null;
  let def = null;
  try {
    const res = await fetch(AI_URL, { cache: 'no-store' });
    const d = await res.json();
    if (res.ok && Array.isArray(d.models) && d.models.length) { list = d.models; def = d.default; }
  } catch { /* 서버 함수 없음 */ }
  if (!list) {
    const cfg = await loadJSON('models.json');
    list = cfg.모델;
    def = cfg.기본;
  }
  state.models = list;
  let saved = null;
  try { saved = localStorage.getItem(MODEL_KEY); } catch { /* 저장소 막힘 */ }
  const ids = list.map((m) => m.id);
  state.model = ids.includes(saved) ? saved : ids.includes(def) ? def : ids[0];
  renderPicker();
}

function modelName(id) {
  return state.models.find((m) => m.id === id)?.이름 ?? id;
}

function selectModel(id) {
  state.model = id;
  try { localStorage.setItem(MODEL_KEY, id); } catch { /* 저장소 막힘 */ }
  renderPicker();
}

function renderPicker(disabled = false) {
  const box = $('model-picker');
  box.replaceChildren(...state.models.map((m) => {
    const on = m.id === state.model;
    const b = el('button', {
      type: 'button', role: 'radio', class: 'model-btn',
      'aria-checked': String(on), 'data-id': m.id, title: m.id,
    },
    el('span', { class: 'm-name' }, m.이름),
    el('span', { class: 'm-desc' }, state.busy.has(m.id) ? '방금 붐빔' : m.설명));
    if (state.busy.has(m.id)) b.classList.add('busy');
    b.disabled = disabled;
    b.addEventListener('click', () => selectModel(m.id));
    return b;
  }));
  $('model-note').textContent = `지금 고른 모델: ${state.model}`;
}

// 붐빈 모델 말고 다른 모델 버튼들 — 누르면 그 모델을 고르고 onPick(id)
function otherModelButtons(failedId, onPick) {
  return el('div', { class: 'switch-row' },
    state.models.filter((m) => m.id !== failedId).map((m) => {
      const b = el('button', { type: 'button', class: 'switch-btn' }, `${m.이름}로`);
      b.addEventListener('click', () => { selectModel(m.id); onPick(m.id); });
      return b;
    }));
}

/* ---------- AI 부르기 ---------- */
async function askAI(sentences, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_CLIENT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sentences, model }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      error: err.name === 'AbortError'
        ? `서버 함수가 ${AI_CLIENT_TIMEOUT_MS / 1000}초 안에 답하지 않았습니다`
        : `서버 함수에 닿지 못했습니다 (${err.message})`,
      busy: err.name === 'AbortError',
      model,
    };
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch { /* JSON 이 아닌 답 */ }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: `서버 함수가 없거나 알 수 없는 답을 했습니다 (HTTP ${res.status})` };
  }
  if (!res.ok || !data.ok) {
    if (data.busy) state.busy.set(model, Date.now());
    return { ok: false, model: data.model ?? model, error: data.error || `HTTP ${res.status}`, busy: !!data.busy };
  }
  state.busy.delete(model);
  return data;
}

/* ---------- 판정 보여 주기 ---------- */
function ruleVerdict(r) {
  return {
    칸: r.칸.값, 긴급도: r.긴급도.값, 감정: r.감정.값, 이유: r.이유,
    기본값: DIMS.filter((d) => r[d].기본값),
  };
}

function appendVerdict(box, v) {
  // 긴급도 높음 + 감정 부정이 함께면 경고 메시지
  if (isAlarming('긴급도', v.긴급도) && isAlarming('감정', v.감정)) {
    box.append(el('p', { class: 'alert', role: 'alert' }, ALERT_TEXT));
  }
  box.append(
    el('div', { class: 'badges' },
      DIMS.map((d) => {
        const cls = ['badge'];
        if (isAlarming(d, v[d])) cls.push('urgent');
        if (v.기본값?.includes(d)) cls.push('fallback');
        return el('div', { class: cls.join(' ') },
          el('span', { class: 'k' }, d),
          el('span', { class: 'v' }, v[d]));
      })),
    el('p', { class: 'section-title' }, '이유'),
    el('p', { class: 'reason' }, v.이유),
  );
  if (v.기본값?.length) {
    box.append(el('p', { class: 'note-small' }, '* 맞는 낱말이 없어 기본값으로 정했습니다 (keywords.json 의 판정 규칙).'));
  }
}

/* ---------- 탭 ---------- */
function selectTab(which) {
  for (const name of ['classify', 'grade']) {
    const on = name === which;
    $(`tab-${name}`).setAttribute('aria-selected', String(on));
    $(`panel-${name}`).hidden = !on;
  }
}

/* ---------- 분류 ---------- */
async function onClassify(e) {
  e.preventDefault();
  const raw = $('sentence').value.trim();
  const box = $('classify-result');
  const btn = $('classify-btn');
  box.replaceChildren();
  box.hidden = false;
  if (!raw) {
    box.append(el('p', { class: 'hint' }, '문장을 넣어 주세요.'));
    return;
  }
  const { text, found } = maskText(raw);
  const rule = classify(text, state.criteria, state.keywords);

  box.append(
    el('p', { class: 'section-title' }, '가린 문장'),
    maskedNode(text, 'masked'),
    el('p', { class: 'found' }, foundText(found)),
  );
  const waiting = el('p', { class: 'progress' }, 'AI가 가르는 중…');
  box.append(waiting);
  btn.disabled = true;
  const model = state.model;
  const ai = await askAI([text], model); // 가린 문장만 보낸다
  btn.disabled = false;
  waiting.remove();
  renderPicker();

  const one = ai.ok ? ai.results?.[0] : null;
  if (one && !one.error) {
    box.append(el('p', { class: 'source' }, `Gemini(${ai.model})가 갈랐습니다`));
    appendVerdict(box, { 칸: one.칸, 긴급도: one.긴급도, 감정: one.감정, 이유: one.이유 });
  } else {
    box.append(
      el('p', { class: 'notice' }, 'AI 없이 규칙으로 갈랐습니다'),
      el('p', { class: 'note-small fail-reason' }, `AI 실패 이유 (${model}): ${one?.error || ai.error}`),
    );
    if (ai.busy) {
      box.append(
        el('p', { class: 'switch-head' }, `${modelName(model)} 모델이 붐빕니다. 다른 모델로 다시 가르기:`),
        otherModelButtons(model, () => $('classify-form').requestSubmit()),
      );
    }
    appendVerdict(box, ruleVerdict(rule));
  }
}

/* ---------- 채점: 공통 ---------- */
function wrongCards(list) {
  return list.map(({ item, text, judged, miss, error }) => el('div', { class: 'wrong' },
    el('div', {},
      el('span', { class: 'id' }, item.id),
      item.note ? el('span', { class: 'chip' }, item.note) : null,
      error ? el('span', { class: 'chip fail' }, '답 못 받음') : null),
    maskedNode(text, 'text'),
    el('div', { class: 'cmp' },
      DIMS.map((d) => miss.includes(d)
        ? el('span', { class: 'miss' }, `${d}: ${item[d]} → ${judged?.[d] ?? '(없음)'}`)
        : el('span', {}, `${d}: ${item[d]} ✓`))),
    error ? el('p', { class: 'note-small' }, error) : null));
}

function gradeRules(items) {
  const correct = Object.fromEntries(DIMS.map((d) => [d, 0]));
  let allThree = 0;
  let unstable = 0;
  const wrongs = [];
  const perItem = [];
  for (const item of items) {
    const { text } = maskText(item.text);
    const first = classify(text, state.criteria, state.keywords);
    const second = classify(text, state.criteria, state.keywords);
    if (DIMS.some((d) => first[d].값 !== second[d].값)) unstable += 1;
    const judged = ruleVerdict(first);
    const miss = DIMS.filter((d) => judged[d] !== item[d]);
    for (const d of DIMS) if (!miss.includes(d)) correct[d] += 1;
    if (miss.length === 0) allThree += 1;
    else wrongs.push({ item, text, judged, miss });
    perItem.push({ item, text, judged });
  }
  return { total: items.length, correct, allThree, unstable, wrongs, perItem };
}

/* ---------- 채점: 규칙 ---------- */
async function onGrade() {
  const btn = $('grade-btn');
  const out = $('grade-result');
  setGradeButtons(false);
  btn.textContent = '채점하는 중…';
  try {
    const items = await ensureAnswer();
    const g = gradeRules(items);
    const total = g.total;
    const measuredAt = new Date().toLocaleString('ko-KR');
    out.replaceChildren(
      el('h2', { class: 'block-head' }, '규칙 채점'),
      el('div', { class: 'stats' },
        DIMS.map((d) => el('div', { class: 'stat' },
          el('div', { class: 'k' }, `${d} 정확도`),
          el('div', { class: 'v' }, pct(g.correct[d], total)),
          el('div', { class: 's' }, `${g.correct[d]} / ${total} 맞음`))),
        el('div', { class: 'stat' },
          el('div', { class: 'k' }, `${DIMS.join(' · ')} 모두 맞음`),
          el('div', { class: 'v' }, `${g.allThree}`),
          el('div', { class: 's' }, `${total}문장 중 (${pct(g.allThree, total)})`))),
      el('div', { class: 'card conditions' },
        el('strong', {}, '잰 조건'),
        el('ul', {},
          el('li', {}, '판정: 규칙 (keywords.json 낱말 개수 세기, AI 없음)'),
          el('li', {}, `낱말 출처: ${state.keywords.출처}`),
          el('li', {}, `기준: criteria.json version ${state.criteria.version}`),
          el('li', {}, `정답: data/answer.json ${total}문장, 가린 문장으로 판정`),
          el('li', {}, `두 번 잰 흔들림: 두 번 판정이 달라진 문장 ${g.unstable}개`),
          el('li', {}, `잰 때: ${measuredAt}`))),
      el('h3', { class: 'wrong-head' }, `규칙이 틀린 문장 ${g.wrongs.length}개 (정답 → 판정)`),
      ...wrongCards(g.wrongs),
    );
    out.hidden = false;
  } catch (err) {
    out.replaceChildren(el('p', { class: 'error' }, err.message));
    out.hidden = false;
  } finally {
    setGradeButtons(true);
    btn.textContent = '규칙으로 채점';
  }
}

/* ---------- 채점: AI ---------- */
function splitInto(arr, parts) {
  const size = Math.ceil(arr.length / parts);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function setGradeButtons(enabled) {
  $('grade-btn').disabled = !enabled;
  $('ai-grade-btn').disabled = !enabled;
}

// AI 채점 중 모델이 붐비면 멈추고 고르게 한다 → 고른 모델 id, 또는 null(여기서 끝내기)
function askToSwitch(failedId, error, done, total) {
  const box = $('ai-pause');
  return new Promise((resolve) => {
    const finish = (v) => { box.hidden = true; box.replaceChildren(); resolve(v); };
    const stop = el('button', { type: 'button', class: 'switch-btn stop' }, '여기서 끝내기');
    stop.addEventListener('click', () => finish(null));
    box.replaceChildren(
      el('p', { class: 'notice' }, `${done}/${total}에서 멈췄습니다 — ${modelName(failedId)} 모델이 붐빕니다`),
      el('p', { class: 'note-small fail-reason' }, error),
      el('p', { class: 'switch-head' }, '다른 모델로 이어서 하기:'),
      otherModelButtons(failedId, (id) => finish(id)),
      el('p', { class: 'note-small' }, '«여기서 끝내기»를 누르면 남은 문장은 답 못 받은 문장(오답)으로 셉니다.'),
      stop,
    );
    box.hidden = false;
  });
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onGradeAI() {
  const btn = $('ai-grade-btn');
  const progress = $('ai-progress');
  const out = $('ai-grade-result');
  setGradeButtons(false);
  btn.textContent = 'AI 채점 중…';
  progress.hidden = false;
  try {
    const items = await ensureAnswer();
    const total = items.length;
    const masked = items.map((it) => maskText(it.text).text);
    const batches = splitInto(items.map((_, i) => i), AI_BATCHES);
    const ai = new Array(total);
    const usedModel = new Array(total); // 문장마다 어느 모델이 갈랐는지
    let model = state.model;
    let done = 0;
    let stopped = null; // 여기서 끝내기를 눌렀을 때의 이유
    let stoppedAt = 0;  // 그때까지 보낸 문장 수
    renderPicker(true); // 채점 중에는 위의 모델 버튼을 잠근다 (멈췄을 때만 고른다)
    progress.textContent = `AI 채점 중… ${done}/${total} (${modelName(model)})`;

    for (const batch of batches) {
      let res;
      if (stopped) {
        res = { ok: false, error: stopped };
      } else {
        for (;;) {
          res = await askAI(batch.map((i) => masked[i]), model); // 가린 문장만 보낸다
          if (res.ok || !res.busy) break;
          renderPicker(true);
          const next = await askToSwitch(model, res.error, done, total);
          if (!next) { stopped = `채점을 멈춤 (${model} 붐빔)`; stoppedAt = done; break; }
          model = next;
          renderPicker(true);
          progress.textContent = `AI 채점 중… ${done}/${total} (${modelName(model)})`;
        }
      }
      batch.forEach((idx, k) => {
        const r = res.ok ? res.results?.[k] : null;
        ai[idx] = r && !r.error ? r : { error: (r && r.error) || res.error || '답이 없습니다' };
        usedModel[idx] = res.ok || !stopped ? (res.model ?? model) : null;
      });
      done += batch.length;
      progress.textContent = `AI 채점 중… ${done}/${total} (${modelName(model)})`;
    }
    const modelCount = new Map();
    usedModel.forEach((m, i) => { if (m && !ai[i].error) modelCount.set(m, (modelCount.get(m) || 0) + 1); });
    const modelSummary = modelCount.size
      ? [...modelCount].map(([m, n]) => `${m} ${n}문장`).join(' · ')
      : '없음 (답을 받은 문장 없음)';

    // AI 집계 — 답을 못 받은 문장은 오답으로 센다
    const correct = Object.fromEntries(DIMS.map((d) => [d, 0]));
    let allThree = 0;
    let failed = 0;
    const reasons = new Map();
    const wrongs = [];
    items.forEach((item, i) => {
      const r = ai[i];
      if (r.error) {
        failed += 1;
        reasons.set(r.error, (reasons.get(r.error) || 0) + 1);
        wrongs.push({ item, text: masked[i], judged: null, miss: [...DIMS], error: r.error });
        return;
      }
      const miss = DIMS.filter((d) => r[d] !== item[d]);
      for (const d of DIMS) if (!miss.includes(d)) correct[d] += 1;
      if (miss.length === 0) allThree += 1;
      else wrongs.push({ item, text: masked[i], judged: r, miss });
    });

    const rule = gradeRules(items);

    // 두 번 잰 흔들림 — 직전 AI 채점과 판정이 달라진 문장
    // (둘 다 답을 받았고, 같은 모델이 가른 문장만 견준다 — 모델이 다르면 흔들림이 아니다)
    let flicker = null;
    if (state.lastAI && state.lastAI.ai.length === total) {
      let compared = 0;
      let changed = 0;
      let otherModel = 0;
      ai.forEach((r, i) => {
        const prev = state.lastAI.ai[i];
        if (r.error || !prev || prev.error) return;
        if (usedModel[i] !== state.lastAI.usedModel[i]) { otherModel += 1; return; }
        compared += 1;
        if (DIMS.some((d) => r[d] !== prev[d])) changed += 1;
      });
      flicker = { compared, changed, otherModel };
    }
    state.lastAI = { ai, usedModel };

    const measuredAt = new Date();
    const conditions = {
      판정: `AI — Gemini, 서버 함수 ${AI_URL}`,
      모델: modelSummary,
      기준: `criteria.json version ${state.criteria.version}`,
      정답: `data/answer.json ${total}문장`,
      보낸_방식: `가린 문장만, ${batches.length}번에 나눠 보냄 (${batches.map((b) => b.length).join(' · ')}문장)`,
      답_못_받은_문장: `${failed}개 (오답으로 셈)`,
      잰_때: measuredAt.toLocaleString('ko-KR'),
    };

    const row = (label, r, a) => {
      const diff = a - r;
      return el('tr', {},
        el('th', { scope: 'row' }, label),
        el('td', {}, `${r}/${total}`, el('br'), el('span', { class: 'sub-pct' }, pct(r, total))),
        el('td', {}, `${a}/${total}`, el('br'), el('span', { class: 'sub-pct' }, pct(a, total))),
        el('td', { class: diff > 0 ? 'up' : diff < 0 ? 'down' : '' }, diff > 0 ? `+${diff}` : `${diff}`));
    };

    const report = {
      잰_조건: { ...conditions, 모델별_문장_수: Object.fromEntries(modelCount), 잰_때: measuredAt.toISOString() },
      요약: {
        AI: { ...Object.fromEntries(DIMS.map((d) => [d, correct[d]])), 세_항목_모두: allThree, 답_못_받음: failed, 문장_수: total },
        규칙: { ...Object.fromEntries(DIMS.map((d) => [d, rule.correct[d]])), 세_항목_모두: rule.allThree, 문장_수: total },
      },
      두_번_잰_흔들림: flicker ? { 직전_AI_채점과_비교한_문장: flicker.compared, 판정이_달라진_문장: flicker.changed, 모델이_달라_빼고_센_문장: flicker.otherModel } : null,
      문장별: items.map((item, i) => ({
        id: item.id,
        가린_문장: masked[i],
        모델: usedModel[i],
        정답: Object.fromEntries(DIMS.map((d) => [d, item[d]])),
        AI: ai[i].error ? { error: ai[i].error } : { ...Object.fromEntries(DIMS.map((d) => [d, ai[i][d]])), 이유: ai[i].이유 },
        규칙: Object.fromEntries(DIMS.map((d) => [d, rule.perItem[i].judged[d]])),
        ...(item.note ? { note: item.note } : {}),
      })),
    };

    const dlBtn = el('button', { type: 'button', class: 'primary alt' }, 'AI 채점 결과 내려받기');
    dlBtn.addEventListener('click', () => downloadJSON(report, DOWNLOAD_NAME));

    out.replaceChildren(...[
      el('h2', { class: 'block-head' }, 'AI 채점 — 규칙과 나란히'),
      el('div', { class: 'card table-card' },
        el('table', { class: 'compare' },
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col' }, '항목'),
            el('th', { scope: 'col' }, '규칙'),
            el('th', { scope: 'col' }, 'AI'),
            el('th', { scope: 'col' }, '차이'))),
          el('tbody', {},
            DIMS.map((d) => row(d, rule.correct[d], correct[d])),
            row('세 항목 모두', rule.allThree, allThree)))),
      failed
        ? el('p', { class: 'notice' }, `답을 못 받은 문장 ${failed}개 — 오답으로 셌습니다`)
        : null,
      failed
        ? el('ul', { class: 'fail-list' }, [...reasons].map(([why, n]) => el('li', {}, `${why} (${n}개)`)))
        : null,
      el('div', { class: 'card conditions' },
        el('strong', {}, '잰 조건'),
        el('ul', {},
          Object.entries(conditions).map(([k, v]) => el('li', {}, `${k.replaceAll('_', ' ')}: ${v}`)),
          el('li', {}, flicker
            ? `두 번 잰 흔들림: 직전 AI 채점과 같은 모델로 견준 ${flicker.compared}문장 중 판정이 달라진 문장 ${flicker.changed}개`
              + (flicker.otherModel ? ` (모델이 달라 뺀 문장 ${flicker.otherModel}개)` : '')
            : '두 번 잰 흔들림: 한 번 더 «AI로 채점»을 누르면 직전 결과와 견줘 셉니다'))),
      dlBtn,
      el('h3', { class: 'wrong-head' }, `AI가 틀린 문장 ${wrongs.length}개 (정답 → 판정)`),
      ...wrongCards(wrongs),
    ].filter(Boolean));
    out.hidden = false;
    progress.textContent = stopped ? `AI 채점을 멈췄습니다 — ${stoppedAt}/${total}에서` : `AI 채점 끝 — ${done}/${total}`;
  } catch (err) {
    out.replaceChildren(el('p', { class: 'error' }, err.message));
    out.hidden = false;
    progress.hidden = true;
  } finally {
    setGradeButtons(true);
    renderPicker(false);
    $('ai-pause').hidden = true;
    btn.textContent = 'AI로 채점';
  }
}

/* ---------- 시작 ---------- */
async function init() {
  $('tab-classify').addEventListener('click', () => selectTab('classify'));
  $('tab-grade').addEventListener('click', () => selectTab('grade'));
  $('classify-form').addEventListener('submit', onClassify);
  $('grade-btn').addEventListener('click', onGrade);
  $('ai-grade-btn').addEventListener('click', onGradeAI);

  try {
    [state.criteria, state.keywords] = await Promise.all([
      loadJSON('criteria.json'),
      loadJSON('keywords.json'),
    ]);
  } catch (err) {
    const msg = location.protocol === 'file:'
      ? '파일을 직접 열면 설정 파일을 읽을 수 없습니다. 웹 서버로 열어 주세요.'
      : `설정 파일을 읽지 못했습니다: ${err.message}`;
    $('load-error').textContent = msg;
    $('load-error').hidden = false;
    return;
  }

  try {
    await loadModels();
  } catch (err) {
    $('model-note').textContent = `모델 목록을 읽지 못했습니다: ${err.message}`;
  }

  $('classify-btn').disabled = false;
  setGradeButtons(true);
  $('footer').textContent = `${state.criteria.owner} · 기준 version ${state.criteria.version}`;
}

init();
