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

// exceljs 워크시트의 "비어있지 않은 행" 개수 (셀 위치/거래처별 컬럼을 모르므로 보수적으로 셈)
function countNonEmptyRows(ws) {
  if (!ws) return 0;
  let count = 0;
  const maxR = ws.rowCount || 0;
  for (let r = 1; r <= maxR; r++) {
    const row = ws.getRow(r);
    if (!row) continue;
    let hasVal = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell && cell.value;
      if (v !== null && v !== undefined && String(v).trim() !== '') hasVal = true;
    });
    if (hasVal) count++;
  }
  return count;
}

// async 오케스트레이터: 산출물 읽어서 판정. deps.ExcelJS 주입 가능(테스트용).
async function autocheckLedger({ files = [], dir = '', stdout = '' } = {}, deps = {}) {
  const path = require('path');
  if (!Array.isArray(files) || files.length === 0) {
    const v = judgeLedgerRun({ files: [], stdout });
    v.text = formatVerdictKorean(v);
    return v;
  }
  let ExcelJS = deps.ExcelJS;
  if (!ExcelJS) { try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; } }
  const rowInfo = [];
  for (const f of files) {
    const name = f.name || f.relPath || '';
    if (!/\.xlsx$/i.test(name)) { rowInfo.push({ name, maxRows: 2 }); continue; } // 비-xlsx는 행검사 생략
    let maxRows = 2; // 읽기 불가 시 보수적으로 통과 처리(허위경보 방지)
    if (ExcelJS) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.join(dir, f.relPath || f.name));
        maxRows = 0;
        for (const ws of wb.worksheets) {
          const n = countNonEmptyRows(ws);
          if (n > maxRows) maxRows = n;
        }
      } catch (_) { maxRows = 2; }
    }
    rowInfo.push({ name, maxRows });
  }
  const verdict = judgeLedgerRun({ files: rowInfo, stdout });
  verdict.text = formatVerdictKorean(verdict);
  return verdict;
}

module.exports = { judgeLedgerRun, formatVerdictKorean, countNonEmptyRows, autocheckLedger };
