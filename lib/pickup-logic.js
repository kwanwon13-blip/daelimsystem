'use strict';

/** 요청 상태 롤업 — 품목 라인들에서 요청 단위 상태 계산 (순수) */
function computeRequestStatus(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const active = list.filter(it => it && it.status !== 'cancelled');
  if (list.length > 0 && active.length === 0) return 'cancelled';
  if (active.length === 0) return opts.courseConfirmed ? 'inCourse' : 'requested';
  const picked = active.filter(it => it.status === 'pickedUp').length;
  const notPicked = active.filter(it => it.status === 'notPicked').length;
  if (picked === active.length) return 'completed';
  if (picked > 0) return 'partial';
  if (notPicked === active.length) return 'notPicked';
  return opts.courseConfirmed ? 'inCourse' : 'requested';
}

/**
 * 마감(추가요청) 판정 — 픽업일이 '오늘'이고 등록시각이 마감 이후면 true (순수)
 * @param {Date} now 등록시각(서버 로컬)
 * @param {string} cutoffHHMM '10:00' (빈값이면 항상 false)
 * @param {string} pickupDate 'YYYY-MM-DD'
 * @param {string} todayStr 서버 로컬 오늘 'YYYY-MM-DD'
 */
function computeIsLate(now, cutoffHHMM, pickupDate, todayStr) {
  if (!cutoffHHMM || !(now instanceof Date) || isNaN(now.getTime())) return false;
  if (pickupDate && todayStr && pickupDate !== todayStr) return false; // 미래 픽업은 추가요청 아님
  const parts = String(cutoffHHMM).split(':');
  const cutoff = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur > cutoff;
}

/** 품목 라인 1줄 파싱 → { itemName, spec, qty, unit } (순수, best-effort) */
function parseItemLine(line) {
  let s = String(line).replace(/^[-*•]\s*/, '').trim();
  let qty = 0, unit = '';
  const qm = s.match(/\s(\d+(?:\.\d+)?)\s*(개|장|롤|박스|매|세트|ea|EA)?\s*$/);
  if (qm) { qty = parseFloat(qm[1]); unit = qm[2] || ''; s = s.slice(0, qm.index).trim(); }
  let spec = '';
  const sm = s.match(/\s(\d+\s*[x*X×]\s*\d+(?:\s*[x*X×]\s*\d+)?)\s*$/);
  if (sm) { spec = sm[1].replace(/\s/g, ''); s = s.slice(0, sm.index).trim(); }
  return { itemName: s, spec, qty, unit };
}

/** 카톡 글 → [{ vendorGuess, items:[{itemName,spec,qty,unit}] }] (순수, 저장 전 후보) */
function parseKakaoPickup(text) {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      cur = { vendorGuess: line.replace(/^#+\s*/, '').trim(), items: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) { cur = { vendorGuess: '', items: [] }; groups.push(cur); }
    cur.items.push(parseItemLine(line));
  }
  return groups.filter(g => g.items.length > 0 || g.vendorGuess);
}

/** 카톡 공유용 텍스트 생성 (순수) */
function buildShareText(dateStr, groups) {
  const out = [`📦 ${dateStr} 픽업`];
  for (const g of (groups || [])) {
    out.push('');
    out.push(`[${g.vendorName || '미지정'}]`);
    for (const it of (g.items || [])) {
      const head = [it.itemName, it.spec].filter(Boolean).join(' ');
      const qtyStr = it.qty ? ` ${it.qty}${it.unit || ''}` : '';
      out.push(`- ${head}${qtyStr}`);
    }
  }
  return out.join('\n');
}

/** vendorId로 요청들을 업체 카드로 묶음 (취합 뷰용, 순수) */
function groupByVendor(requests) {
  const map = new Map();
  for (const r of (requests || [])) {
    const key = r.vendorId || '';
    if (!map.has(key)) map.set(key, { vendorId: r.vendorId, vendorName: r.vendorName, requests: [], items: [] });
    const g = map.get(key);
    g.requests.push(r);
    for (const it of (r.items || [])) g.items.push(it);
  }
  return Array.from(map.values());
}

module.exports = { computeRequestStatus, computeIsLate, parseItemLine, parseKakaoPickup, buildShareText, groupByVendor };
