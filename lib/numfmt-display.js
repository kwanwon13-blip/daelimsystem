'use strict';
// Excel numFmt 코드 + 원본값 → 표시 문자열. 실무에 흔한 것만(₩통화/천단위/백분율/날짜),
// 나머지·해석 불가는 원본 그대로(허위 표시 방지). 미리보기 충실도 개선용(백엔드에서 미리 포맷).

function thousands(n, decimals) {
  return Number(n).toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Excel 직렬 날짜(1900 시스템) → 'YYYY-MM-DD'. 1900-03-01 이후 정확. 범위 밖이면 null.
function excelSerialToYmd(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function formatByNumFmt(rawValue, numFmt) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return rawValue;
  const num = Number(rawValue);
  if (!numFmt || Number.isNaN(num)) return rawValue;
  const fmt = String(numFmt);
  const decM = (fmt.match(/\.(0+)/) || ['', ''])[1].length;
  // 백분율
  if (fmt.includes('%')) {
    const dec = (fmt.match(/\.(0+)%/) || ['', ''])[1].length;
    return (num * 100).toFixed(dec) + '%';
  }
  // 날짜 (yyyy/mm/dd 류) — serial date 범위(1900~9999)일 때만
  if ((/[yY]/.test(fmt) || (/[mM]/.test(fmt) && /[dD]/.test(fmt))) && num > 0 && num < 2958466) {
    const ymd = excelSerialToYmd(num);
    if (ymd) return ymd;
  }
  // 통화 ₩
  if (fmt.includes('₩') || /\[\$₩/.test(fmt)) {
    return '₩' + thousands(num, decM);
  }
  // 천단위
  if (fmt.includes('#,##0') || fmt.includes('#,###')) {
    return thousands(num, decM);
  }
  // 소수 자릿수 지정 (0.00 등)
  if (/^0+(\.0+)?$/.test(fmt.replace(/[;_)\-\s]/g, ''))) {
    return num.toFixed(decM);
  }
  return rawValue;
}

module.exports = { formatByNumFmt, excelSerialToYmd };
