// 규칙 분류 — keywords.json 의 낱말이 문장에 몇 개 들었는지 세서 가른다. AI 없음.
// 값의 이름과 차례는 criteria.json, 낱말과 기본값은 keywords.json 에서 읽는다. 코드에는 적지 않는다.

import { MASK_TAGS } from './mask.js';

export const DIMS = ['칸', '긴급도', '감정'];

export function labelsOf(criteria) {
  return {
    칸: criteria.순서.차례,
    긴급도: criteria.긴급도.단계.map((s) => s.이름),
    감정: criteria.감정.단계.map((s) => s.이름),
  };
}

const TAG_RE = new RegExp(`\\[(?:${MASK_TAGS.join('|')})\\]`, 'g');

function decide(text, labels, section, fallback) {
  let best = null;
  let bestHits = [];
  // 차례대로 보면서 "더 많을 때만" 바꾼다 → 동점이면 앞의 값이 남는다
  for (const label of labels) {
    const words = section?.[label]?.낱말 ?? [];
    const hits = words.filter((w) => text.includes(w));
    if (hits.length > bestHits.length) {
      best = label;
      bestHits = hits;
    }
  }
  if (best === null) return { 값: fallback.값, 낱말: [], 기본값: true };
  return { 값: best, 낱말: bestHits, 기본값: false };
}

// text 는 이미 가린 문장이어야 한다. [이름] 같은 표시 안의 글자는 낱말로 세지 않는다.
export function classify(text, criteria, keywords) {
  const plain = String(text).replace(TAG_RE, ' ');
  const labels = labelsOf(criteria);
  const fallbacks = keywords.판정.맞는_낱말이_없을_때;
  const out = {};
  for (const d of DIMS) {
    out[d] = decide(plain, labels[d], keywords[d], fallbacks[d]);
  }
  out.이유 = DIMS.map((d) => {
    const r = out[d];
    const why = r.기본값 ? '맞는 낱말 없음 → 기본값' : r.낱말.map((w) => `‘${w}’`).join(' ');
    return `${d} ${r.값}(${why})`;
  }).join(' · ');
  return out;
}
