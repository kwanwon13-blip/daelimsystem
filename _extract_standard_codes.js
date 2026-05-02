// 학습풀 (컴퍼니 매출 23,274행) → 표준 코드 CSV
// 출력: data/standard-codes.csv + data/standard-codes.json
//
// 1) 학습풀 모든 행을 정규화된 키로 그룹화
// 2) 빈도순 정렬, top N 추출
// 3) 자주쓰는 사이즈 top5 / 평균단가 / 최근사용일자 / 사용빈도 추출
// 4) CSV + JSON 출력 (디자이너 폼이 참조)

const fs = require('fs');
const path = require('path');
const pool = require('./lib/learning-pool');

const OUT_DIR = path.join(__dirname, 'data', 'design-codes');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// 정규화 키: 학습풀 item 컬럼을 그대로 사용 (사장님이 입력한 표준명)
function norm(s) {
  return String(s || '').trim();
}

// 재질 카테고리 추출 (디자이너 폼의 1차 분류)
function detectMaterial(item) {
  const raw = String(item || '');
  const n = raw.toLowerCase();
  // 비용/서비스 (시안 제외 대상)
  if (/^택배비|^설치비|^인건비|^운반비|^운임비|^화물비|^운송비|^배송비/.test(n)) return '비용/서비스';
  // 트레이딩 자재 (시안 제외 대상)
  if (/호이스트/.test(n)) return '트레이딩자재';
  if (/앙카베이스|시멘지주/.test(n)) return '트레이딩자재';
  if (/휀스|펜스|매쉬휀스|가림막휀스/.test(n)) return '트레이딩자재';
  if (/^\d+각파이프|파이프$/.test(n)) return '트레이딩자재';
  if (/^u고리/.test(n)) return '트레이딩자재';
  if (/^쓰레기통|3구쓰레기통/.test(n)) return '트레이딩자재';
  if (/반사경.*이동식바퀴/.test(n)) return '트레이딩자재';
  // 출력물 — 신규 재질 추가
  if (/포맥스/.test(n)) return '포맥스';
  if (/폼보드/.test(n)) return '폼보드';
  if (/페트배너/.test(n)) return '페트배너'; // 규격화된 페트지
  if (/^페트지|페트지$/.test(n)) return '페트지'; // 자유 사이즈 페트
  if (/워킹배너/.test(n)) return '워킹배너';
  if (/타포린/.test(n)) return '타포린';
  if (/현수막/.test(n)) return '현수막';
  if (/후렉스/.test(n)) return '후렉스';
  if (/^pe간판|^pe소형|^pe단면|pe간판/.test(n)) return 'PE간판';
  if (/^a형|a형간판|a형단면|a형양면/.test(n)) return 'A형간판';
  // 철판 3종 분리
  if (/철판자립/.test(n)) return '철판자립';
  if (/철판프레임|철판\+프레임|철판양면.*프레임|철판양면자립|철판양면자립간판/.test(n)) return '철판프레임';
  if (/철판실사|철판.*실사/.test(n)) return '철판실사';
  // 시트류
  if (/반사시트$|^반사시트/.test(n)) return '반사시트';
  if (/pvc시트지|pvc시트/.test(n)) return 'PVC시트';
  if (/시트커팅/.test(n)) return '시트커팅';
  if (/알루미늄uv|알루미늄.*바닥/.test(n)) return '알루미늄UV';
  // 보드류
  if (/화이트보드/.test(n)) return '화이트보드';
  // 스티커 / 자석
  if (/^스티커|^원형스티커|^덧방스티커|^투명스티커|^배면스티커|스티커/.test(n)) return '스티커';
  if (/자석/.test(n)) return '자석';
  // 용접 안전용품 (별도)
  if (/안전모걸이대|안전벨트걸이대|안전조회장|조회단상/.test(n)) return '안전용품';
  // 보관함/거치대 (용접물 다른 종류)
  if (/콤프보관함|보관함/.test(n)) return '보관함';
  if (/거치대|받침대|걸이대/.test(n)) return '거치대';
  // 프레임 (사장님: 검수필요)
  if (/프레임/.test(n)) return '프레임'; // ← 검수필요 플래그 들어갈 것
  return '기타';
}

// 시안 제외 대상 (디자이너 폼에 안 보임)
function isExcludedFromDesign(material) {
  return ['비용/서비스', '트레이딩자재'].includes(material);
}

// 검수 필요 (분류가 애매해서 사장님이 한번 봐야 하는 것)
function needsReview(material, item) {
  if (material === '프레임') return true; // 사장님 말씀: 한번 더 봐야 할듯
  if (material === '기타') return true;   // 미분류 = 검수 필요
  return false;
}

// 두께 추출 (3T/5T/7T 등)
function detectThickness(item) {
  const m = String(item || '').match(/(\d+)\s*[Tt]/);
  return m ? `${m[1]}T` : '';
}

// 재질별 — 면(양면/단면) 분류가 의미있는 재질만
const SIDE_APPLIES = new Set([
  '포맥스','PE간판','A형간판',
  '철판실사','철판프레임','철판자립',
  '후렉스','폼보드','타포린',
  '반사시트','PVC시트',
]);

// 면 (양면/단면) — 양면테이프/양면접착 같은 옵션은 제외 + 재질 기준 적용
function detectSide(item, material) {
  // 면 분류 자체가 의미없는 재질 (스티커/현수막/자석 등) → 빈값
  if (!SIDE_APPLIES.has(material)) return '';

  const n = String(item || '');
  // "양면테이프", "양면접착" 등은 옵션이지 면 분류 아님 — 그 부분 제거 후 검사
  const cleaned = n
    .replace(/양면테이프/g, '')
    .replace(/양면접착/g, '')
    .replace(/양면벨크로|양면밸크로/g, '');
  if (/양면|양판/.test(cleaned)) return '양면';
  if (/단면/.test(cleaned)) return '단면';
  return '';
}

// 옵션 (사방타공/모서리타공/축광시트/아크릴포켓 등 + 갯수 같이 포함)
function detectOptions(item) {
  const n = String(item || '');
  const opts = [];
  if (/사방타공/.test(n)) opts.push('사방타공');
  if (/모서리타공/.test(n)) opts.push('모서리타공');
  if (/축광시트/.test(n)) opts.push('축광시트');
  if (/반사시트|반사실사/.test(n)) opts.push('반사시트');
  if (/아크릴포켓/.test(n)) opts.push('아크릴포켓');
  if (/클리어파일/.test(n)) opts.push('클리어파일');
  if (/집게/.test(n)) opts.push('집게');
  if (/프레임/.test(n) && !opts.length) opts.push('프레임');
  if (/U자고리|u자고리|반생타공|반생이|밸크로|벨크로/.test(n)) opts.push('걸이옵션');
  if (/양면테이프/.test(n)) opts.push('양면테이프');
  if (/양면접착/.test(n)) opts.push('양면접착');
  if (/양면벨크로|양면밸크로/.test(n)) opts.push('양면벨크로');
  if (/걸이대|받침대|거치대/.test(n)) opts.push('거치/걸이');
  if (/자립/.test(n)) opts.push('자립');
  if (/이마돌출/.test(n)) opts.push('이마돌출');
  if (/안전모걸이대/.test(n)) opts.push('안전모걸이');
  if (/조회장|조회단상/.test(n)) opts.push('조회장');
  if (/걸이|행거/.test(n)) opts.push('기타옵션');
  if (/아일렛/.test(n)) opts.push('아일렛');
  if (/4구|6구|8구|12구|16구/.test(n)) {
    const m = n.match(/(\d+)구/);
    if (m) opts.push(`${m[1]}구`);
  }
  return [...new Set(opts)]; // 중복제거
}

(async () => {
  await pool.load();

  // 컴퍼니 매출 전체 행 수집 (날짜 무관)
  const allRows = [];
  for (const d of (function*() {
    // 모든 일자 조회 — pool 내부 byDate Map iter
    const internal = require('./lib/learning-pool');
    // pool.getRegisteredByDate 는 dayRange 로 필터하지만 여기선 광범위하게 (1000일)
    for (let yr = 2020; yr <= 2026; yr++) {
      for (let mo = 1; mo <= 12; mo++) {
        for (let day = 1; day <= 31; day++) {
          const key = `${yr}-${String(mo).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
          yield key;
        }
      }
    }
  })()) {
    const rows = pool.getRegisteredByDate(d, { dayRange: 0 });
    for (const r of rows) allRows.push(r);
  }

  console.log(`전체 매출 행: ${allRows.length}`);

  // 표준명 (item) 으로 그룹화
  const groups = new Map();
  for (const r of allRows) {
    const key = norm(r.item);
    if (!key) continue;
    if (!groups.has(key)) {
      const mat = detectMaterial(key);
      groups.set(key, {
        표준명: key,
        재질: mat,
        두께: detectThickness(key),
        면: detectSide(key, mat),
        옵션: detectOptions(key).join(','),
        rows: [],
      });
    }
    groups.get(key).rows.push(r);
  }

  console.log(`표준명 종류: ${groups.size}`);

  // 그룹별 통계 산출
  const records = [];
  for (const g of groups.values()) {
    const rows = g.rows;
    const n = rows.length;

    // 사이즈 빈도
    const specCount = new Map();
    for (const r of rows) {
      const s = String(r.spec || '').replace(/\s/g, '');
      if (!s) continue;
      specCount.set(s, (specCount.get(s) || 0) + 1);
    }
    const topSizes = [...specCount.entries()].sort((a,b) => b[1]-a[1]).slice(0, 5).map(e => e[0]);

    // 평균/최빈 단가
    const prices = rows.map(r => Number(r.price)).filter(p => p > 0);
    const avgPrice = prices.length ? Math.round(prices.reduce((a,b)=>a+b,0) / prices.length) : 0;
    const priceCount = new Map();
    for (const p of prices) priceCount.set(p, (priceCount.get(p) || 0) + 1);
    const modePrice = [...priceCount.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || avgPrice;

    // 최근 사용 일자
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    const lastUsed = dates[dates.length - 1] || '';

    // 카테고리 (categorizeRow 호출)
    const sample = rows[0];
    const category = pool.categorizeRow(sample.item, sample.spec);

    records.push({
      표준명: g.표준명,
      재질: g.재질,
      두께: g.두께,
      면: g.면,
      옵션: g.옵션,
      카테고리: category,
      시안제외: isExcludedFromDesign(g.재질) ? 'Y' : '',
      검수필요: needsReview(g.재질, g.표준명) ? 'Y' : '',
      사용빈도: n,
      자주쓰는사이즈: topSizes.join('|'),
      최빈단가: modePrice,
      평균단가: avgPrice,
      최근사용: lastUsed,
    });
  }

  // 빈도순 정렬
  records.sort((a, b) => b.사용빈도 - a.사용빈도);

  // CSV 저장
  const headers = ['표준명','재질','두께','면','옵션','카테고리','시안제외','검수필요','사용빈도','자주쓰는사이즈','최빈단가','평균단가','최근사용'];
  const csvLines = [headers.join(',')];
  for (const r of records) {
    csvLines.push(headers.map(h => {
      const v = String(r[h] ?? '');
      // CSV 이스케이프
      if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
      return v;
    }).join(','));
  }
  const csvPath = path.join(OUT_DIR, 'standard-codes.csv');
  fs.writeFileSync(csvPath, '﻿' + csvLines.join('\n'), 'utf8'); // BOM for Excel

  // JSON 저장 (폼이 fetch 로 사용)
  const jsonPath = path.join(OUT_DIR, 'standard-codes.json');
  fs.writeFileSync(jsonPath, JSON.stringify(records, null, 2), 'utf8');

  // 통계 출력
  console.log(`\n=== 추출 완료 ===`);
  console.log(`총 표준명: ${records.length}`);
  console.log(`CSV: ${csvPath}`);
  console.log(`JSON: ${jsonPath}`);

  // 빈도 분포 분석
  const top10 = records.slice(0, 10);
  console.log('\n[상위 10개]');
  for (const r of top10) {
    console.log(`  ${r.사용빈도.toString().padStart(4)} | ${r.표준명.padEnd(40)} | ${r.재질}/${r.두께}/${r.면} | 사이즈 ${r.자주쓰는사이즈}`);
  }

  // 90% 커버 확인
  const totalUsage = records.reduce((s, r) => s + r.사용빈도, 0);
  let cum = 0; let cover80 = 0, cover90 = 0, cover95 = 0;
  for (let i = 0; i < records.length; i++) {
    cum += records[i].사용빈도;
    if (!cover80 && cum >= totalUsage * 0.8) cover80 = i + 1;
    if (!cover90 && cum >= totalUsage * 0.9) cover90 = i + 1;
    if (!cover95 && cum >= totalUsage * 0.95) cover95 = i + 1;
  }
  console.log(`\n[커버리지 분석]`);
  console.log(`  상위 ${cover80}개 표준명이 전체 매출의 80% 커버`);
  console.log(`  상위 ${cover90}개가 90% 커버`);
  console.log(`  상위 ${cover95}개가 95% 커버`);

  // 카테고리별 분포
  const byCat = {};
  for (const r of records) {
    if (!byCat[r.카테고리]) byCat[r.카테고리] = { count: 0, usage: 0 };
    byCat[r.카테고리].count++;
    byCat[r.카테고리].usage += r.사용빈도;
  }
  console.log(`\n[카테고리별]`);
  for (const [cat, v] of Object.entries(byCat).sort((a,b) => b[1].usage - a[1].usage)) {
    console.log(`  ${cat}: ${v.count}개 표준명, 매출 ${v.usage}건`);
  }

  // 재질별 분포
  const byMat = {};
  for (const r of records) {
    if (!byMat[r.재질]) byMat[r.재질] = { count: 0, usage: 0 };
    byMat[r.재질].count++;
    byMat[r.재질].usage += r.사용빈도;
  }
  console.log(`\n[재질별]`);
  for (const [mat, v] of Object.entries(byMat).sort((a,b) => b[1].usage - a[1].usage)) {
    console.log(`  ${mat}: ${v.count}개 표준명, 매출 ${v.usage}건`);
  }
})();
