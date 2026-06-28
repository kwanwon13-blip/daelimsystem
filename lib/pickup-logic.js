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

/** 품목 라인 1줄 파싱 → { itemName, spec, qty, unit, site? } (순수, best-effort)
 *  괄호 (xxx) 는 현장(site)으로 보존하고 품목명에서 분리한다. */
function parseItemLine(line) {
  let s = String(line).replace(/^[-*•]\s*/, '').trim();
  // 괄호 (...) → 현장(site)으로 추출 (여러 개면 ' / '로 이어붙임)
  let site = '';
  s = s.replace(/[（(]([^（）()]*)[）)]/g, (_, inner) => {
    const t = String(inner).trim();
    if (t) site = site ? site + ' / ' + t : t;
    return ' ';
  }).replace(/\s+/g, ' ').trim();
  let qty = 0, unit = '';
  const qm = s.match(/\s(\d+(?:\.\d+)?)\s*(개|장|롤|박스|매|세트|ea|EA)?\s*$/);
  if (qm) { qty = parseFloat(qm[1]); unit = qm[2] || ''; s = s.slice(0, qm.index).trim(); }
  let spec = '';
  // 규격: 1) 가로x세로(공백 허용) 우선, 2) 없으면 끝의 '숫자로 시작하는 토큰'(270·270mm·5T 등) — 앞에 품목명이 있을 때만(\s 필수, 전체가 숫자면 품목명 보존)
  let sm = s.match(/\s(\d+\s*[x*X×]\s*\d+(?:\s*[x*X×]\s*\d+)?)\s*$/);
  if (!sm) sm = s.match(/\s(\d[\w.x*X×-]*)\s*$/);
  if (sm) { spec = sm[1].replace(/\s/g, ''); s = s.slice(0, sm.index).trim(); }
  const out = { itemName: s, spec, qty, unit };
  if (site) out.site = site;
  return out;
}

/** 한 줄이 '업체 헤더'처럼 보이는지 (순수, 보수적 판정).
 *  - '업체명:' 처럼 콜론으로 끝나거나
 *  - 수량/규격 숫자가 전혀 없고 짧은(공백 포함 ~12자) 한 줄 */
function looksLikeVendorHeader(line) {
  const s = String(line).trim();
  if (!s) return false;
  if (/[:：]\s*$/.test(s)) return true;            // 콜론 종결 → 헤더
  if (/[-*•]\s/.test(s)) return false;             // 불릿 → 품목
  if (/\d/.test(s)) return false;                   // 숫자(수량/규격) 있으면 품목으로 간주
  return s.replace(/\s+/g, '').length <= 12;        // 짧은 텍스트 → 업체명 가능성
}

/** 카톡 글 → [{ vendorGuess, items:[{itemName,spec,qty,unit,site?}] }] (순수, 저장 전 후보).
 *  '#업체' 외에도 '업체명:' / 빈줄로 구분된 블록의 헤더 줄을 너그럽게 업체로 인식.
 *  (과한 추정은 피하고, 단일 라인은 품목으로 본다) */
function parseKakaoPickup(text) {
  const rawLines = String(text || '').split(/\r?\n/);
  // 빈줄 기준으로 블록 분할 (블록 = 연속된 비어있지 않은 줄들)
  const blocks = [];
  let block = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) { if (block.length) { blocks.push(block); block = []; } continue; }
    block.push(line);
  }
  if (block.length) blocks.push(block);

  const groups = [];
  let cur = null;
  const startGroup = (name) => { cur = { vendorGuess: name, items: [] }; groups.push(cur); };

  for (const blk of blocks) {
    // 블록 내에서 헤더줄 판정: # 접두, 콜론 종결, 또는 (2줄 이상 블록의) 헤더 같은 첫 줄
    blk.forEach((line, idx) => {
      const isHash = line.startsWith('#');
      const colonHeader = /[:：]\s*$/.test(line);
      // 블록 첫 줄이 헤더처럼 보이고 뒤에 품목이 따라오면 헤더로
      const blockHeader = idx === 0 && blk.length > 1 && looksLikeVendorHeader(line);
      if (isHash || colonHeader || blockHeader) {
        const name = line.replace(/^#+\s*/, '').replace(/[:：]\s*$/, '').trim();
        startGroup(name);
        return;
      }
      if (!cur) startGroup('');
      cur.items.push(parseItemLine(line));
    });
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
      const siteStr = it.site ? ` (${it.site})` : '';
      out.push(`- ${head}${qtyStr}${siteStr}`);
    }
  }
  return out.join('\n');
}

/** 업체명 정규화 — 자유 업체명 그룹핑/매칭 공용.
 *  소문자·공백제거 + 법인격(㈜/(주)/주식회사/(株))·괄호류·흔한 특수문자 제거.
 *  '라코스' == '라코스(주)' == '㈜라코스'. groupByVendor·자동매칭이 동일 norm 공유. */
function normVendorName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/㈜|\(주\)|주식회사|（주）|\(株\)|（株）|株式会社/g, '')   // 법인격 제거
    .replace(/[（）()【】「」『』\[\]<>{}]/g, '')                       // 괄호류 제거
    .replace(/[.,·・‧·:;/\\\-_~!@#$%^&*+='"`|?]/g, '')                  // 흔한 특수문자 제거
    .replace(/\s+/g, '');                                                // 공백 제거(끝)
}

/** vendorId로 요청들을 업체 카드로 묶음 (취합 뷰용, 순수).
 *  vendorId 가 없으면(자유 업체명 등록) 정규화한 업체명으로 묶는다. */
function groupByVendor(requests) {
  const map = new Map();
  for (const r of (requests || [])) {
    const key = r.vendorId || ('name:' + normVendorName(r.vendorName));
    if (!map.has(key)) map.set(key, { groupKey: key, vendorId: r.vendorId || null, vendorName: r.vendorName, requests: [], items: [] });
    const g = map.get(key);
    g.requests.push(r);
    for (const it of (r.items || [])) g.items.push(it);
  }
  return Array.from(map.values());
}

module.exports = { computeRequestStatus, computeIsLate, parseItemLine, parseKakaoPickup, buildShareText, groupByVendor, normVendorName, looksLikeVendorHeader };
