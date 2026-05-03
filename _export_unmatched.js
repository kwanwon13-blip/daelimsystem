// 미매칭 63건 → 엑셀 (사장님 체크/무시 컬럼 + 카테고리 분류)
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const RESULTS = path.join(__dirname, '_pptx_slides', '_rematch_results.jsonl');
const OUT = path.join(__dirname, '_pptx_slides', '_미매칭_검수목록.xlsx');

function classify(spec, mats, frag, reason) {
  const f = String(frag || '').toLowerCase();
  if (spec && spec.includes('*')) {
    const [w, h] = spec.split('*').map(Number);
    if (Math.max(w||0, h||0) <= 200) return 'A. 작은부속';
  }
  if (f.includes('시안 type')) return 'B. 깃발 매출누락';
  if (mats.includes('후렉스') || /호이스트/.test(f)) {
    if (spec && spec.includes('*')) {
      const [w, h] = spec.split('*').map(Number);
      if ((w||0) >= 2000) return 'C. 호이스트 미매칭';
    }
  }
  if (reason === '사이즈 후보 없음') return 'D. 사이즈 학습풀누락';
  if (String(reason).includes('점수미달')) return 'E. fuzzy 점수미달';
  return 'F. 기타';
}

(async () => {
  const lines = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(l => l.trim());
  const items = [];
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch(_){ continue; }
    if (!j.rematch) continue;
    const site = j.rematch.matchedSite || '-';
    for (const m of j.rematch.matches) {
      if (m.matched) continue;
      items.push({
        cat: classify(m.extractedSpec, m.extractedMaterials || [], m.ocrFragment, m.reason),
        date: j.date, pptxCat: j.cat, image: j.image, site,
        frag: (m.ocrFragment || '').replace(/\n/g, ' / '),
        spec: m.extractedSpec, mats: (m.extractedMaterials || []).join(','),
        qty: m.extractedQty, reason: m.reason,
      });
    }
  }
  // 카테고리 + 일자 정렬
  items.sort((a, b) => (a.cat + a.date).localeCompare(b.cat + b.date));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('미매칭 검수');
  ws.columns = [
    { header: '카테고리', key: 'cat', width: 22 },
    { header: '일자', key: 'date', width: 12 },
    { header: 'PPTX', key: 'pptxCat', width: 8 },
    { header: '슬라이드', key: 'image', width: 26 },
    { header: '추출현장', key: 'site', width: 18 },
    { header: '추출사이즈', key: 'spec', width: 14 },
    { header: '추출재질', key: 'mats', width: 18 },
    { header: '추출수량', key: 'qty', width: 8 },
    { header: 'OCR 라인', key: 'frag', width: 60 },
    { header: '실패사유', key: 'reason', width: 24 },
    { header: '체크/무시 (사장님)', key: 'action', width: 18 },
    { header: '메모', key: 'memo', width: 40 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  ws.getRow(1).alignment = { horizontal: 'center' };

  let prevCat = '';
  for (const it of items) {
    const row = ws.addRow(it);
    // 카테고리 바뀔 때 구분
    if (it.cat !== prevCat) {
      row.font = { bold: true };
      prevCat = it.cat;
    }
    // 카테고리별 색
    const colors = {
      'A. 작은부속': 'FFFEF3C7', // 노랑 (무시 후보)
      'B. 깃발 매출누락': 'FFFEE2E2', // 빨강 (검수)
      'C. 호이스트 미매칭': 'FFFEE2E2',
      'D. 사이즈 학습풀누락': 'FFFEE2E2',
      'E. fuzzy 점수미달': 'FFFEF9C3',
      'F. 기타': 'FFE5E7EB',
    };
    if (colors[it.cat]) {
      row.eachCell((c) => {
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[it.cat] } };
      });
    }
  }

  // 카테고리별 요약 sheet
  const ws2 = wb.addWorksheet('요약');
  ws2.addRow(['카테고리', '건수', '권장 처리']);
  ws2.getRow(1).font = { bold: true };
  const summary = items.reduce((s, it) => { s[it.cat] = (s[it.cat] || 0) + 1; return s; }, {});
  const advice = {
    'A. 작은부속': '대부분 무시 — 작은 라벨/스티커는 매출에 묶음 등록되거나 누락 패턴',
    'B. 깃발 매출누락': '검수 — 매출 등록 빠진 듯',
    'C. 호이스트 미매칭': '검수 — 학습풀에 정확 사이즈 없으면 매출 보완',
    'D. 사이즈 학습풀누락': '검수 — 매출 등록 누락 또는 다른 사이즈로 묶음',
    'E. fuzzy 점수미달': '검수 — 사이즈 살짝 다름. 같은 거래일 가능성 있음',
    'F. 기타': '검수',
  };
  for (const [cat, n] of Object.entries(summary).sort()) {
    ws2.addRow([cat, n, advice[cat] || '']);
  }
  ws2.columns.forEach(c => { c.width = 30; });

  await wb.xlsx.writeFile(OUT);
  console.log(`✓ 저장: ${OUT}`);
  console.log(`총 ${items.length}건`);
  for (const [cat, n] of Object.entries(summary).sort()) console.log(`  ${cat}: ${n}건`);
})();
