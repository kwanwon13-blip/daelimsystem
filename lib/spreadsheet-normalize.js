'use strict';
// 입력 정규화: .xls/.csv/.xlsm → .xlsx 로 통일 (업로드 문 앞에서 1회). 다운스트림은 .xlsx만 보면 됨.
// SheetJS(xlsx)는 optional require (codebase 의 multer/exceljs/better-sqlite3 패턴과 동일).
// 미설치/손상이면 "조용한 실패" 대신 명확한 에러를 던진다.
const path = require('path');

const CONVERTIBLE = new Set(['.xls', '.csv', '.xlsm']);

function tryRequireXLSX() {
  try { return require('xlsx'); } catch (_) { return null; }
}

// normalizeToXlsx(srcPath, deps?) → { path, converted, originalExt }
//  - .xlsx / 비-스프레드시트(.pdf·이미지 등): 그대로 반환(converted:false)
//  - .xls/.csv/.xlsm: .xlsx 로 변환해 새 경로 반환(converted:true)
//  - 변환 필요한데 라이브러리 없음 → throw(code SPREADSHEET_LIB_MISSING)
//  - 읽기 실패(손상 등) → throw(code SPREADSHEET_UNREADABLE)
// deps.XLSX 를 명시하면 그걸 사용(테스트용), 없으면 require('xlsx').
function normalizeToXlsx(srcPath, deps = {}) {
  const ext = path.extname(String(srcPath || '')).toLowerCase();
  if (!CONVERTIBLE.has(ext)) {
    return { path: srcPath, converted: false, originalExt: ext };
  }
  const XLSX = ('XLSX' in deps) ? deps.XLSX : tryRequireXLSX();
  if (!XLSX) {
    const e = new Error('SPREADSHEET_LIB_MISSING: 변환 라이브러리(xlsx) 미설치 — npm install xlsx 필요');
    e.code = 'SPREADSHEET_LIB_MISSING';
    throw e;
  }
  const outPath = srcPath.replace(/\.[^.]+$/, '.xlsx');
  try {
    const wb = XLSX.readFile(srcPath);
    XLSX.writeFile(wb, outPath);
  } catch (err) {
    const e = new Error('SPREADSHEET_UNREADABLE: 파일을 읽지 못했습니다 (' + (err && err.message) + ')');
    e.code = 'SPREADSHEET_UNREADABLE';
    throw e;
  }
  return { path: outPath, converted: true, originalExt: ext };
}

module.exports = { normalizeToXlsx, CONVERTIBLE };
