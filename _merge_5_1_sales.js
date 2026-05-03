// 통합 문서1.xlsx (5/1 매출) → 컴퍼니-매입매출.xlsx 에 append
// 헤더는 그대로 두고 데이터 행만 추가
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const NEW_FILE = path.join(__dirname, 'learning-data', '통합 문서1.xlsx');
const TARGET = path.join(__dirname, 'learning-data', '04_컴퍼니매출', 'data', '컴퍼니-매입매출.xlsx');

(async () => {
  console.log('=== 5/1 매출 데이터 병합 ===');

  // 1. 새 파일 (5/1 데이터) 읽기
  const wbNew = new ExcelJS.Workbook();
  await wbNew.xlsx.readFile(NEW_FILE);
  const wsNew = wbNew.worksheets[0];
  console.log(`신규 파일: ${wsNew.rowCount}행`);

  // 2. 타겟 파일 읽기
  const wbTarget = new ExcelJS.Workbook();
  await wbTarget.xlsx.readFile(TARGET);
  const wsTarget = wbTarget.worksheets[0];
  console.log(`타겟 파일: ${wsTarget.rowCount}행 (병합 전)`);

  // 3. 신규 파일 헤더 비교
  const newHeader = [];
  wsNew.getRow(1).eachCell({ includeEmpty: true }, c => newHeader.push(String(c.value || '').trim()));
  const targetHeader = [];
  wsTarget.getRow(1).eachCell({ includeEmpty: true }, c => targetHeader.push(String(c.value || '').trim()));

  console.log('신규 헤더:', newHeader.slice(0, 15).join(' | '));
  console.log('타겟 헤더:', targetHeader.slice(0, 15).join(' | '));

  // 4. 헤더 일치 확인
  const headerMatch = newHeader.length === targetHeader.length &&
    newHeader.every((h, i) => h === targetHeader[i]);
  if (!headerMatch) {
    console.warn('⚠ 헤더 불일치 — 그래도 진행 (사장님 확인 필요)');
  } else {
    console.log('✓ 헤더 일치');
  }

  // 5. 데이터 행 append (헤더 제외)
  let appended = 0;
  for (let r = 2; r <= wsNew.rowCount; r++) {
    const srcRow = wsNew.getRow(r);
    // 빈 행 skip
    let hasValue = false;
    srcRow.eachCell({ includeEmpty: false }, c => {
      if (c.value !== null && c.value !== undefined && c.value !== '') hasValue = true;
    });
    if (!hasValue) continue;

    // 타겟에 새 행 추가
    const newRow = wsTarget.addRow([]);
    srcRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
      newRow.getCell(colNum).value = cell.value;
      // 셀 스타일 복사 (날짜 등 포맷 유지)
      if (cell.style) newRow.getCell(colNum).style = JSON.parse(JSON.stringify(cell.style));
    });
    appended++;
  }
  console.log(`✓ ${appended}행 append`);
  console.log(`타겟 파일: ${wsTarget.rowCount}행 (병합 후)`);

  // 6. 저장 (원본 덮어쓰기 — 백업은 이미 만들어둠)
  await wbTarget.xlsx.writeFile(TARGET);
  console.log(`✓ 저장 완료: ${TARGET}`);

  // 7. 통합 문서1.xlsx → 백업 폴더로 이동 (원본 보존)
  const archiveDir = path.join(__dirname, 'learning-data', '_보관');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = path.join(archiveDir, '20260501_매출.xlsx');
  fs.renameSync(NEW_FILE, archivePath);
  console.log(`✓ 통합 문서1.xlsx → ${archivePath} 로 이동`);
})();
