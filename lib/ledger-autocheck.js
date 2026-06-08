'use strict';
// 마감 결과 자동점검(보수적) — 허위 경보 최소화. exitCode===0 성공 경로에서 호출.

// 순수 판정: 파일별 행정보 + stdout → verdict
function judgeLedgerRun({ files = [], stdout = '' } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { status: 'fail', reasons: ['결과 파일이 생성되지 않았습니다.'], summary: { fileCount: 0, totalRows: 0 } };
  }
  const reasons = [];
  let status = 'pass';
  for (const f of files) {
    if ((f.maxRows || 0) < 2) {
      status = 'warn';
      reasons.push(`결과 파일 "${f.name}"에 데이터가 거의 없습니다 (확인 필요).`);
    }
  }
  if (/\[WARN\]|\[ERROR\]/i.test(String(stdout || ''))) {
    if (status === 'pass') status = 'warn';
    reasons.push('처리 중 경고 메시지가 있었습니다 — 결과를 한 번 확인하세요.');
  }
  const totalRows = files.reduce((s, f) => s + (f.maxRows || 0), 0);
  return { status, reasons, summary: { fileCount: files.length, totalRows } };
}

// 순수 포매터: verdict → 한국어 텍스트 블록
function formatVerdictKorean(verdict = {}) {
  const map = { pass: '✅ 점검 통과', warn: '🚩 확인 필요', fail: '🚩 실패' };
  const icon = map[verdict.status] || '🚩 확인 필요';
  const lines = ['────────────────', `📋 자동점검: ${icon}`];
  if (verdict.summary) {
    lines.push(` · 생성 파일 ${verdict.summary.fileCount}개 · 데이터 행 합계 ${verdict.summary.totalRows}행`);
  }
  for (const r of (verdict.reasons || [])) lines.push(` · ${r}`);
  lines.push('────────────────');
  return lines.join('\n');
}

module.exports = { judgeLedgerRun, formatVerdictKorean };
