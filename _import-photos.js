// _import-photos.js — 47K v2 분류 CSV → photos.db 마이그레이션
// 한 번만 실행. 사진 파일은 사전에 data/photos/ 로 복사되어 있어야 함.
//
// 사용법:
//   node _import-photos.js <csv 경로>
//   예: node _import-photos.js "D:\카톡사진모음\_분류결과_v2.csv"

const fs = require('fs');
const path = require('path');
const dbPhotos = require('./db-photos');

// ========== 정규화 룰 (회사명/현장명 통일) ==========

const EMPTY_TOKENS = new Set([
  '', '-', '미상', '미기재', '미기입', '없음', '(없음)',
  '(정보 없음)', '정보 없음', '현장', '건설현장', '건설 현장',
  '시공현장', '현장사무실', '현장명(없으면 빈문자열)',
  '건설사명(없으면 빈문자열)', '안전', '우리현장', '현장소장',
]);

const CONSTRUCTOR_MAP = {
  // 포스코 계열
  'POSCO': '포스코', 'posco': '포스코', '포스코': '포스코',
  '포스코이앤씨': '포스코이앤씨', '(주)포스코이앤씨': '포스코이앤씨',
  '주식회사 포스코이앤씨': '포스코이앤씨',
  '포스코건설': '포스코이앤씨',
  // HDC 현대산업개발
  'HDC': 'HDC현대산업개발', 'HDC 현대산업개발': 'HDC현대산업개발',
  'HDC현대산업개발': 'HDC현대산업개발',
  'HDC HYUNDAI DEVELOPMENT': 'HDC현대산업개발',
  // 현대건설
  '현대건설': '현대건설', '현대건설(주)': '현대건설',
  '(주)현대건설': '현대건설', 'HYUNDAI E&C': '현대건설',
  // DL 이앤씨
  'DL E&C': 'DL이앤씨', 'DL이앤씨': 'DL이앤씨',
  'DL Construction': 'DL이앤씨', 'DAELIM': 'DL이앤씨',
  '(주)DL이앤씨': 'DL이앤씨',
  // DL건설
  'DL건설': 'DL건설',
  'DL Engineering & Construction': 'DL건설',
  // 대림에스엠
  'DAELIM SM': '대림에스엠', '대림에스엠': '대림에스엠',
  '대림에스엠(주)': '대림에스엠', '(주)대림에스엠': '대림에스엠',
  // 두산
  'DOOSAN': '두산건설', '두산': '두산건설', '두산건설': '두산건설',
  '두산건설(주)': '두산건설', 'DOOSAN E&C': '두산건설',
  // 요진
  'YOJIN': '요진건설산업', 'YOJIN 요진건설산업': '요진건설산업',
  '요진건설': '요진건설산업', '요진건설산업': '요진건설산업',
  '(주)요진건설산업': '요진건설산업',
  // 한신공영
  '한신공영': '한신공영', '한신공영(주)': '한신공영',
  '(주)한신공영': '한신공영', 'HANSHIN': '한신공영',
  // 쌍용건설
  '쌍용건설': '쌍용건설', '쌍용건설(주)': '쌍용건설',
  '(주)쌍용건설': '쌍용건설', 'SSANGYONG': '쌍용건설',
  // 롯데
  '롯데건설': '롯데건설', '롯데건설(주)': '롯데건설',
  'LOTTE E&C': '롯데건설',
  // GS
  'GS건설': 'GS건설', 'GS건설(주)': 'GS건설',
  'GS E&C': 'GS건설',
  // 기타
  '한일시멘트': '한일시멘트', '한일시멘트(주)': '한일시멘트',
  '안전건설자재': '(자사)안전건설자재', '안전건설': '(자사)안전건설자재',
  'K2 Safety': 'K2 Safety', 'K2': 'K2 Safety', 'K2세이프티': 'K2 Safety',
  'GC 녹십자EM': 'GC녹십자EM', 'GC녹십자EM': 'GC녹십자EM', '녹십자EM': 'GC녹십자EM',
  'LS ELECTRIC': 'LS일렉트릭', 'LS일렉트릭': 'LS일렉트릭', 'LS Electric': 'LS일렉트릭',
  'KUKDONG': '국동건설', '국동건설': '국동건설',
  'THEHUE': '더휴', 'THE HUE': '더휴', '더휴': '더휴',
  'ANYANG': '안양시', '안양시': '안양시',
};

function normalizeText(s) {
  if (!s) return '';
  return String(s).trim().replace(/\s+/g, ' ');
}

function stripCompanySuffix(s) {
  return s.replace(/\(주\)|㈜|주식회사/g, '').replace(/\s+/g, ' ').trim();
}

function stripSiteSuffix(s) {
  return s
    .replace(/\s*(현장|건설현장|건설공사|건축공사|공사현장|시공현장)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConstructor(raw) {
  if (!raw) return '';
  const s = normalizeText(raw);
  if (EMPTY_TOKENS.has(s)) return '';
  if (CONSTRUCTOR_MAP[s]) return CONSTRUCTOR_MAP[s];
  const s2 = stripCompanySuffix(s);
  if (CONSTRUCTOR_MAP[s2]) return CONSTRUCTOR_MAP[s2];
  if (EMPTY_TOKENS.has(s2)) return '';
  return s2 || s;
}

function normalizeSite(raw) {
  if (!raw) return '';
  let s = normalizeText(raw);
  if (EMPTY_TOKENS.has(s)) return '';
  // IPARK / I PARK / I-PARK / 아이파크 통일
  s = s.replace(/I[\s-]?PARK/gi, 'IPARK').replace(/아이파크/g, 'IPARK');
  // 데이터센터 표기 통일
  s = s.replace(/\s*데이타센터/g, ' 데이터센터');
  // 현장 접미사 제거
  s = stripSiteSuffix(s);
  if (EMPTY_TOKENS.has(s)) return '';
  return s;
}

function normalizeCategory(raw) {
  if (!raw) return '';
  const parts = String(raw).split('|').map((p) => p.trim()).filter(Boolean);
  const valid = new Set(['용품', '시공현장', '시안주문서', '문서영수증', '기타']);
  for (const p of parts) if (valid.has(p)) return p;
  return parts[0] || '';
}

// ========== 파일명에서 촬영일 추출 ==========

function parseTakenAt(filename) {
  // PC 카톡: KakaoTalk_YYYYMMDD_HHMMSSxxx_NN.jpg
  let m = filename.match(/^KakaoTalk_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  // 톡클라우드: YYYYMMDD_HHMMSS.jpg (또는 (N) 붙음)
  m = filename.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  }
  return null;
}

// ========== CSV 파싱 ==========

function parseCsv(text) {
  // 슬로건 등에 ',' 와 '"' 와 줄바꿈 들어있어서 정확한 RFC 4180 파서 필요
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ========== 메인 ==========

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error('사용법: node _import-photos.js <csv 경로>');
    process.exit(1);
  }

  const photosDir = path.join(__dirname, 'data', 'photos');
  if (!fs.existsSync(photosDir)) {
    fs.mkdirSync(photosDir, { recursive: true });
    console.log(`[생성] ${photosDir}`);
  }

  console.log('[1/3] CSV 읽는 중...');
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const rows = parseCsv(text);
  const header = rows[0];
  console.log(`  컬럼: ${header.join(' | ')}`);
  console.log(`  데이터 행: ${rows.length - 1}`);

  // 컬럼 인덱스 찾기 (v2 형식)
  const idx = (name) => header.indexOf(name);
  const COL = {
    filename: idx('filename'),
    category: idx('카테고리'),
    constructor: idx('건설사'),
    partner: idx('협력사'), // 받지만 사용 안 함
    site: idx('현장'),
    product: idx('제품'),
    size_qty: idx('사이즈수량'),
    slogan: idx('슬로건'),
    keywords: idx('키워드'),
    error: idx('에러'),
  };

  console.log('[2/3] 사진 파일 사이즈 스캔 + 정규화 + DB 임포트...');

  const records = [];
  let missing = 0;
  let errCount = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[COL.filename]) continue;

    const filename = row[COL.filename];
    const filePath = path.join(photosDir, filename);

    let fileSize = null;
    if (fs.existsSync(filePath)) {
      fileSize = fs.statSync(filePath).size;
    } else {
      missing++;
    }

    const errVal = COL.error >= 0 ? row[COL.error] : '';
    if (errVal) errCount++;

    const constructor = row[COL.constructor] || '';
    const site = row[COL.site] || '';

    records.push({
      filename,
      taken_at: parseTakenAt(filename),
      file_size: fileSize,
      category: normalizeCategory(row[COL.category] || ''),
      constructor: constructor,
      site: site,
      product: row[COL.product] || '',
      size_qty: row[COL.size_qty] || '',
      slogan: row[COL.slogan] || '',
      keywords: row[COL.keywords] || '',
      norm_constructor: normalizeConstructor(constructor),
      norm_site: normalizeSite(site),
      ai_processed_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      ai_model: 'gemini-2.5-flash-lite',
    });

    if (records.length % 5000 === 0) {
      console.log(`  진행: ${records.length}`);
    }
  }

  console.log(`\n  총 레코드: ${records.length}`);
  console.log(`  파일 누락 (data/photos/ 에 없음): ${missing}`);
  console.log(`  에러 항목: ${errCount}`);

  console.log('\n[3/3] DB INSERT (트랜잭션 일괄)...');
  dbPhotos.bulkInsert(records);

  // 통계 확인
  const stats = dbPhotos.getStats();
  console.log('\n=== 임포트 완료 ===');
  console.log(`총 ${stats.total} 장 / 표시 가능 ${stats.visible} 장`);
  console.log('\n카테고리:');
  for (const c of stats.byCategory) {
    console.log(`  ${c.category}: ${c.n}`);
  }
  console.log('\n건설사 TOP 10 (정규화 후):');
  for (const c of stats.topConstructors.slice(0, 10)) {
    console.log(`  ${c.name}: ${c.n}`);
  }

  // 동기화 상태 초기화 (현재까지 가장 최신 파일의 mtime)
  const now = new Date().toISOString();
  dbPhotos.setSyncState('initial_import_at', now);

  console.log('\n✅ 마이그레이션 끝.');
  console.log('다음 단계: routes/photos.js (API) + UI 페이지');
}

main().catch((e) => {
  console.error('실패:', e);
  process.exit(1);
});
