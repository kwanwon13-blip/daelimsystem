// routes/design-codes.js standalone 테스트 (서버 띄우지 않고)
const fs = require('fs');
const path = require('path');

// 테스트 1: 표준 코드 JSON 파일 존재 여부
console.log('=== 테스트 1: standard-codes.json 존재 ===');
const codesPath = path.join(__dirname, 'data', 'design-codes', 'standard-codes.json');
if (!fs.existsSync(codesPath)) {
  console.error('❌ standard-codes.json 없음');
  process.exit(1);
}
const codes = JSON.parse(fs.readFileSync(codesPath, 'utf8'));
console.log(`✓ ${codes.length}개 표준 코드 로드`);
console.log(`  상위 3개:`);
for (const c of codes.slice(0, 3)) {
  console.log(`    "${c.표준명}" (${c.재질}/${c.두께}/${c.면}, 빈도 ${c.사용빈도})`);
}

// 테스트 2: 시안제외 / 검수필요 플래그 분포
console.log('\n=== 테스트 2: 플래그 분포 ===');
const excluded = codes.filter(c => c.시안제외 === 'Y');
const review = codes.filter(c => c.검수필요 === 'Y');
const visible = codes.filter(c => c.시안제외 !== 'Y');
console.log(`시안제외 (디자이너 폼에 안 보임): ${excluded.length}개`);
console.log(`검수필요 (수정 의심): ${review.length}개`);
console.log(`디자이너 폼에 노출되는 항목: ${visible.length}개`);

// 테스트 3: Express 라우터 핸들러 직접 호출
console.log('\n=== 테스트 3: 라우터 핸들러 동작 ===');

// fake req/res
function fakeReq(query = {}, headers = {}) {
  return {
    query,
    headers: { 'x-designer-token': process.env.DESIGNER_TOKEN || 'designer-default-key-change-in-env', ...headers },
    body: {},
  };
}
function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    _done: null,
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; if (this._done) this._done(); return this; },
    send(d) { this.body = d; if (this._done) this._done(); return this; },
    setHeader() { return this; },
  };
  return res;
}

// 라우트 모듈 로드 (Express 라우터)
const router = require('./routes/design-codes');
// router.stack 에서 핸들러 추출
const routes = {};
for (const layer of router.stack) {
  const route = layer.route;
  if (!route) continue;
  const methods = Object.keys(route.methods);
  for (const m of methods) {
    routes[`${m.toUpperCase()} ${route.path}`] = route.stack;
  }
}
console.log('등록된 라우트:', Object.keys(routes));

// 미들웨어를 통과시키는 헬퍼
function runHandlers(stack, req, res) {
  return new Promise((resolve, reject) => {
    res._done = resolve; // res.json/send 호출 시 resolve
    let i = 0;
    function next(err) {
      if (err) return reject(err);
      if (i >= stack.length) return resolve(); // 마지막까지 통과 (res 안 보냄)
      const handler = stack[i++].handle;
      try {
        const ret = handler(req, res, next);
        if (ret && typeof ret.then === 'function') ret.catch(reject);
      } catch (e) { reject(e); }
    }
    next();
  });
}

(async () => {
  // 3-1: GET /list
  const req1 = fakeReq();
  const res1 = fakeRes();
  await runHandlers(routes['GET /list'], req1, res1);
  console.log(`GET /list: status=${res1.statusCode}, items=${res1.body?.items?.length || 0}, total=${res1.body?.total}, hidden=${res1.body?.hidden}`);
  if (res1.statusCode !== 200) {
    console.error('  ❌ /list 실패:', res1.body);
  } else {
    console.log('  ✓ /list 성공');
  }

  // 3-2: GET /search?q=포맥스
  const req2 = fakeReq({ q: '포맥스' });
  const res2 = fakeRes();
  await runHandlers(routes['GET /search'], req2, res2);
  console.log(`GET /search?q=포맥스: status=${res2.statusCode}, items=${res2.body?.items?.length || 0}`);
  if (res2.body?.items?.length > 0) {
    console.log('  상위 매치:');
    for (const r of res2.body.items.slice(0, 3)) {
      console.log(`    "${r.표준명}" (${r.재질}/${r.두께}, 빈도 ${r.사용빈도})`);
    }
  }

  // 3-3: GET /search?q=후렉스
  const req3 = fakeReq({ q: '후렉스' });
  const res3 = fakeRes();
  await runHandlers(routes['GET /search'], req3, res3);
  console.log(`GET /search?q=후렉스: items=${res3.body?.items?.length}`);
  if (res3.body?.items?.length > 0) {
    console.log('  상위 매치:');
    for (const r of res3.body.items.slice(0, 3)) {
      console.log(`    "${r.표준명}" (빈도 ${r.사용빈도})`);
    }
  }

  // 3-4: GET /search?q=580*600 (사이즈 검색)
  const req4 = fakeReq({ q: '580*600' });
  const res4 = fakeRes();
  await runHandlers(routes['GET /search'], req4, res4);
  console.log(`GET /search?q=580*600: items=${res4.body?.items?.length} (사이즈는 검색 대상 아님 — 비어있어야 정상)`);

  // 3-5: 인증 실패 — token 없으면 401
  const reqAuth = fakeReq({}, { 'x-designer-token': '' }); // Token 없음
  delete reqAuth.headers['x-designer-token'];
  const resAuth = fakeRes();
  await runHandlers(routes['GET /list'], reqAuth, resAuth);
  console.log(`GET /list (no token): status=${resAuth.statusCode}, expect 401`);
  if (resAuth.statusCode !== 401) {
    console.error('  ❌ 인증 안 막힘');
  } else {
    console.log('  ✓ 인증 안된 요청 차단 OK');
  }

  // 3-6: POST /export — 엑셀 다운로드 시뮬레이션
  const reqExp = fakeReq();
  reqExp.body = {
    meta: { 일자: '2026-05-02', 거래처: '대림에스엠(주)', 현장: '테스트현장', 카테고리: '출력물' },
    products: [
      { 품명: '5t포맥스+사방타공', 재질: '포맥스', 두께: '5T', 면: '', 옵션: '사방타공',
        사이즈: '580*600', 수량: 35, _matched: true },
      { 품명: '신규특수재질', 재질: '기타', 두께: '', 면: '', 옵션: '',
        사이즈: '300*400', 수량: 1, _matched: false },
    ],
  };
  const resExp = fakeRes();
  let bytesSent = 0;
  resExp.send = function(buf) { bytesSent = buf.length; this.body = buf; return this; };
  await runHandlers(routes['POST /export'], reqExp, resExp);
  console.log(`POST /export: status=${resExp.statusCode}, xlsx ${bytesSent} bytes`);
  if (bytesSent > 1000) {
    fs.writeFileSync('/tmp/test_design_export.xlsx', resExp.body);
    console.log('  ✓ 엑셀 생성됨 → /tmp/test_design_export.xlsx');
  } else {
    console.error('  ❌ 엑셀 생성 실패:', resExp.body);
  }

  console.log('\n=== 모든 테스트 완료 ===');
})();
