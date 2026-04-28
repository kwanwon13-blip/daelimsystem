/**
 * routes/lib/design-parser.js
 * 시안 파일명/경로 파싱 + 분류룰 매칭
 *
 * 입력: 파일경로 또는 파일명
 * 출력: { 월일, 건설사, 현장, 종류, 내용, 버전, 발주처[], 대분류, 소분류 }
 *
 * 비용: 0원 (정규식만)
 */

const path = require('path');

// ── 발주처 통합 매핑 (사용자 확정) ──
const VENDOR_MERGE = {
  '코리아시스템': '코리아',
  '한진현수막': '한진',
  '한양': '한양안전',
  '한양안전실업': '한양안전',
  '대풍산업': '대풍'
};

// 노이즈 (발주처가 아닌 괄호 내용)
const VENDOR_NOISE = new Set([
  '외국어','주','태,캄,미','&디자이너','&디자','수정','반사','추가','신규',
  '수령','참고','복사','대형','미사용','한국어','앞','뒤','북측','남측','동측','서측',
  '최종','중,베','1','2','3','1단지','2단지','3단지'
]);

// ── 분류룰 (컴퍼니-품목정리 신규등록규칙과 동일) ──
const CLASSIFICATION_RULES = [
  ['가공/용역', '운반설치', ['운반비','택배비','퀵','화물비','설치비','출장비','운임']],
  ['가공/용역', '임대료', ['임대료','임대','장비대']],
  ['가공/용역', '용역비', ['용역','작업비','가공비','인건비','공사비','수수료','회의','간담회','세미나','폐기물','재판비','제판비','재단비','제작비','디자인비','출력비','지퍼부착','지퍼비','전기공사','전기세','전기시설','봉제비','개구부보수','기장료','조정료','교육비']],
  ['안전자재', '안전장비', ['안전모','안전화','안전대','안전고깔','안전봉','안전조끼','헬멧','보호구','마스크','보안경','식별띠','작업복','쿨토시','절연장갑','보호렌즈','조끼','안전장갑']],
  ['안전자재', '휀스반사경', ['가림막','휀스','반사경','라바콘','차수막','칼라콘']],
  ['안전자재', '기타안전', ['안전','경광등','용접면']],
  ['원자재', '잉크소모품', ['잉크','토너','XP1000','PU1000','NEWAL','NEW AL','MAINTENANCE','유지보수','A/S','수리비','프린터부속','컷팅기부속','칼날','평판컷팅','자동카플러','에어릴','우레탄바퀴']],
  ['원자재', '금속원자재', ['파이프','각관','각파이프','아연파이프','단관파이프','철판','강판','갈바','칼라철판','HRSTEEL','EGI','SUS','스텐','알미늄','알루미늄','동판','황동','SS400']],
  ['원자재', '원단시트', ['(CH)','그레이플렉스','이노폼','솔벤시트','무광코팅지','코팅지','코팅필름','ITM합성지','ITM','PVC-CAL','PVC1270','PVC시트','PVC점착','반사시트','축광시트','안개시트','페트지','패트지','캐스트시트','돔보커팅','카라시트','솔벤현수막','점착현수막','프리즘솔벤','솔벤','시트지','합성지','유포','투명PC','인테리어필름']],
  ['원자재', '자석', ['자석']],
  ['출력물', '현수막', ['현수막','배너','타포린','깃발','어깨띠']],
  ['출력물', '포맥스', ['포맥스']],
  ['출력물', '후렉스', ['후렉스']],
  ['출력물', '폼보드', ['폼보드']],
  ['출력물', '화이트보드', ['화이트보드']],
  ['출력물', '스티커실사', ['스티커','실사','시트커팅','출력물','출력만']],
  ['출력물', '간판', ['간판','A형','X배너','피켓','PE간판','PE소형','PE대형','잔넬','돌출표찰','표찰','표지판','액자','등신대','입간판','족자','다보액자']],
  ['출력물', '아크릴포켓', ['아크릴포켓']],
  ['출력물', '천막', ['천막','캐노피']],
  ['금속자재', '앵글브라켓', ['앵글','브라켓','경첩','ㄱ자','클램프','크램프']],
  ['금속자재', '프레임', ['프레임','틀제작','문틀','자립','평상','지주','개구부','받침대','출입문']],
  ['부자재', '아크릴렉산', ['아크릴','렉산']],
  ['부자재', '합판우드', ['합판','MDF','우드','목재','아스테이지','아스테지']],
  ['부자재', '접착테이프', ['테이프','본드','실리콘','찍찍이','벨크로','까슬이','보들이','접착제']],
  ['부자재', '도료화학', ['페인트','래커','락카','시너','바니쉬','고체연료','고체알콜']],
  ['부자재', '체결부속', ['볼트','너트','피스','앙카','앵커','나사','와셔','타카','카라비너']],
  ['부자재', '전기조명', ['LED','전구','형광등','스위치','콘센트','케이블','전선','트랜스','안정기','조명','플러그','접지']],
  ['부자재', '고무플라스틱', ['고무','플라스틱','PVC','비닐','풍선인형','방진']],
  ['부자재', '공구장비', ['드릴','그라인더','임팩','호이스트','콤프레샤','컴프레샤','콤프','컴프','프레스기','절단석','줄자','뺀지','스패너','드라이버','몽키','커터','캇타','톱','가위','렌치','척','비트','테파드릴','탭핸들','고속절단기','고주파','용접기']],
  ['부자재', '수납함', ['쓰레기통','건의함','공도구충전함','충전함','보관함','재떨이','저금통']],
  ['부자재', '사무용품', ['컴퓨터','복사지','출력지','포토','티셔츠','파티션','파일케이스','클리어파일']],
  ['기타분류', '기타', []]
];

const PREFIX_MAP = {
  '출력물':'OUT','원자재':'RAW','금속자재':'MTL',
  '안전자재':'SFT','부자재':'SUB','가공/용역':'SVC','기타분류':'ETC'
};

/** 키워드 기반 대분류/소분류 매칭 */
function classifyKind(name) {
  const s = String(name || '').toLowerCase();
  for (const [daebun, sobun, kws] of CLASSIFICATION_RULES) {
    if (!kws.length) return { 대분류: daebun, 소분류: sobun };
    for (const kw of kws) {
      if (s.includes(kw.toLowerCase())) return { 대분류: daebun, 소분류: sobun };
    }
  }
  return { 대분류: '기타분류', 소분류: '기타' };
}

/** 발주처 정규화 (별칭 → 표준명) */
function normalizeVendor(v) {
  const trimmed = String(v || '').trim();
  if (VENDOR_NOISE.has(trimmed)) return null;
  if (trimmed.length === 0 || trimmed.length > 20) return null;
  return VENDOR_MERGE[trimmed] || trimmed;
}

/**
 * 파일명/경로 파싱
 * @param {string} fullPath - D:\★두산\2026\현장\0429-두산-당진-A형철판-실명제-v1-발주(공장).jpg
 * @param {string} root - 시안 루트 (보통 'D:\\')
 * @returns {object} 파싱 결과
 */
function parseDesignPath(fullPath, root) {
  const result = {
    원본경로: fullPath,
    파일명: '', 확장자: '',
    월일: '', 건설사: '', 현장: '', 종류: '', 내용: '', 버전: '',
    발주처: [],
    대분류: '기타분류', 소분류: '기타', 제안코드: 'ETC-(신규)',
    파싱오류: []
  };

  if (!fullPath) { result.파싱오류.push('경로 없음'); return result; }

  // 경로 분해 (역슬래시/슬래시 모두 지원)
  const norm = String(fullPath).replace(/\//g, '\\');
  const parts = norm.split('\\').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const ext = (path.extname(fileName) || '').toLowerCase();
  const baseName = fileName.replace(new RegExp('\\' + ext + '$', 'i'), '');
  result.파일명 = fileName;
  result.확장자 = ext;

  // 폴더 구조에서 건설사 (★ 제거)
  // 일반 케이스: D:\★두산\2026\현장\파일.ai → parts: [D:, ★두산, 2026, 현장, 파일.ai]
  // root는 'D:' 또는 '\\\\192.168.0.133\\dd' 같은 형식
  let brandFromFolder = '';
  let siteFromFolder = '';
  // 첫 폴더 (★ 시작 또는 그냥 이름)
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (/^★/.test(seg)) {
      brandFromFolder = seg.replace(/^★+/, '').trim();
      // 그 다음 다음 폴더가 현장명일 가능성 (year 폴더 건너뛰기)
      // 패턴: ★건설사 / 2026[시안작업] / 현장명 / 파일
      if (parts[i+1] && /\d{4}/.test(parts[i+1])) {
        if (parts[i+2] && i+2 < parts.length - 1) {
          siteFromFolder = parts[i+2];
        }
      } else if (parts[i+1] && i+1 < parts.length - 1) {
        siteFromFolder = parts[i+1];
      }
      break;
    }
  }
  if (brandFromFolder) result.건설사 = brandFromFolder;
  if (siteFromFolder) result.현장 = siteFromFolder;

  // 파일명 파싱
  // 발주처 추출 (괄호 안)
  const vendorMatches = baseName.match(/[\(（]([^()（）]+)[\)）]/g) || [];
  const vendors = [];
  for (const m of vendorMatches) {
    const raw = m.replace(/^[\(（]/, '').replace(/[\)）]$/, '').trim();
    const v = normalizeVendor(raw);
    if (v && !vendors.includes(v)) vendors.push(v);
  }
  result.발주처 = vendors;

  // 괄호와 그 내용 제거한 후 토큰화
  let cleanName = baseName.replace(/[\(（][^()（）]*[\)）]/g, '').trim();
  // 발주 키워드 제거
  cleanName = cleanName.replace(/발주/g, '').trim();
  // 구분자: 하이픈 또는 공백
  const tokens = cleanName.split(/[-\s_]+/).filter(Boolean);

  // 첫 토큰: 월일 (4자리 숫자)
  if (tokens.length > 0 && /^\d{4}$/.test(tokens[0])) {
    result.월일 = tokens[0];
    tokens.shift();
  } else if (tokens.length > 0 && /^\d{1,2}$/.test(tokens[0]) && /^\d{1,2}$/.test(tokens[1] || '')) {
    // "04 29" 같은 경우
    result.월일 = String(tokens[0]).padStart(2,'0') + String(tokens[1]).padStart(2,'0');
    tokens.shift(); tokens.shift();
  }

  // 마지막 토큰: 버전 (vN 패턴)
  if (tokens.length > 0 && /^v\d+$/i.test(tokens[tokens.length - 1])) {
    result.버전 = tokens.pop();
  }

  // 토큰 첫 번째: 건설사 (폴더에서 못 가져왔으면)
  if (!result.건설사 && tokens.length > 0) {
    result.건설사 = tokens.shift();
  } else if (tokens.length > 0 && tokens[0] === result.건설사) {
    tokens.shift(); // 폴더에서 가져온 건설사가 파일명 첫 토큰과 같으면 제거
  } else if (tokens.length > 0) {
    // 짧은 약어로 매칭 시도 (예: 폴더 "DL이앤씨" / 파일 "디엘이엔씨")
    const folderBrand = result.건설사;
    if (folderBrand) {
      // 첫 토큰이 건설사 약어/별칭일 수 있음 (한글 변환)
      tokens.shift();
    }
  }

  // 토큰 두 번째: 현장 (폴더에서 못 가져왔으면)
  if (!result.현장 && tokens.length > 0) {
    result.현장 = tokens.shift();
  } else if (tokens.length > 0) {
    // 폴더 현장과 파일명 현장 토큰이 비슷하면 제거
    const folderSite = result.현장 || '';
    const t = tokens[0];
    if (folderSite && (folderSite.includes(t) || t.includes(folderSite))) {
      tokens.shift();
    }
  }

  // 나머지: 종류 + 내용
  // 마지막에서 1개를 종류로, 나머지를 내용으로 처리
  // (실제 패턴: "공사차량진출입로 A형" → 내용:공사차량진출입로 / 종류:A형)
  if (tokens.length >= 2) {
    result.종류 = tokens[tokens.length - 1];
    result.내용 = tokens.slice(0, -1).join(' ');
  } else if (tokens.length === 1) {
    result.종류 = tokens[0];
    result.내용 = '';
  }

  // 분류룰 매칭 (종류+내용 합쳐서)
  const classText = (result.종류 + ' ' + result.내용).trim();
  const cls = classifyKind(classText);
  result.대분류 = cls.대분류;
  result.소분류 = cls.소분류;
  result.제안코드 = PREFIX_MAP[cls.대분류] + '-?????? (마스터 매칭 필요)';

  return result;
}

/**
 * 표준 파일명 생성 (역방향)
 * @param {object} d - { 월일, 건설사, 현장, 종류, 내용, 버전, 발주처 }
 * @param {string} purpose - '원본' | 발주처명
 * @returns {string} 파일명 (확장자 제외)
 */
function buildStandardName(d, purpose) {
  const parts = [];
  if (d.월일) parts.push(d.월일);
  if (d.건설사) parts.push(sanitize(d.건설사));
  if (d.현장) parts.push(sanitize(d.현장));
  if (d.종류) parts.push(sanitize(d.종류));
  if (d.내용) parts.push(sanitize(d.내용));
  if (d.버전) parts.push(d.버전);
  let base = parts.join('-');
  if (purpose && purpose !== '원본') {
    base += `-발주(${purpose})`;
  }
  return base;
}

function sanitize(s) {
  return String(s || '').trim()
    .replace(/[\\/:*?"<>|]/g, '')   // Windows 금지문자
    .replace(/\s+/g, '');             // 공백 제거 (하이픈 통일 원칙)
}

/**
 * 표준 폴더 경로 생성
 * @param {object} d - { 건설사, 현장 }
 * @param {string} year - "2026"
 * @param {string} root - 'D:\\'
 * @returns {string} 폴더 경로
 */
function buildStandardFolder(d, year, root) {
  const r = String(root || 'D:\\').replace(/[\\/]+$/, '');
  let brand = String(d.건설사 || '').trim();
  if (!brand) return r;
  // ★ 자동 부착하지 않음 (신규는 ★ 없이)
  const folders = [r, brand, year + '시안작업'];
  if (d.현장) folders.push(sanitize(d.현장));
  return folders.join('\\');
}

module.exports = {
  parseDesignPath,
  classifyKind,
  normalizeVendor,
  buildStandardName,
  buildStandardFolder,
  CLASSIFICATION_RULES,
  PREFIX_MAP,
};
