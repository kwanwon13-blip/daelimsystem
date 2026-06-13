'use strict';
// ERP UI 스크린샷 드라이버 — 로그인 후 지정 탭/상세를 캡처해 outputs/verify/ 에 저장.
// 사용법: node .claude/skills/verifier-erp/shot-erp.js   (서버 실행 중이어야 함)
// 전제:  verify-workflow-live.js 가 시드(검증D/E/F + 과거내역 검증A·B)를 깔아둔 상태가 보기 좋다.

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE = process.env.ERP_BASE || 'http://localhost:3217';
const OUT = path.join(process.cwd(), 'outputs', 'verify');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function clickByText(page, selector, regex) {
  return page.evaluate((sel, reSrc) => {
    const re = new RegExp(reSrc);
    const el = [...document.querySelectorAll(sel)].find(e => re.test((e.textContent || '').trim()) && e.offsetParent !== null);
    if (el) { el.click(); return (el.textContent || '').trim().slice(0, 40); }
    return null;
  }, selector, regex.source);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 로그인은 API로 → 쿠키 주입 (폼 타이핑보다 안정적)
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'admin', password: 'admin' }),
  });
  const token = ((lr.headers.get('set-cookie') || '').match(/session_token=([^;]+)/) || [])[1];
  if (!token) throw new Error('로그인 실패 — admin/admin 부트스트랩 확인');

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 950 });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.setCookie({ name: 'session_token', value: token, url: BASE });

  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(1500);

  const shots = [];
  async function snap(name) {
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file });
    shots.push(file);
    console.log('📸', name);
  }

  // ① 기존 ERP 기준색 — 단가/품목 관리 탭
  const t1 = await clickByText(page, 'button, a', /단가|품목/);
  await sleep(1200);
  await snap('01-pricing-tab');
  console.log('   (탭:', t1, ')');

  // ② 워크플로우 보드 (4칸 + 카드 전환버튼 라벨)
  const t2 = await clickByText(page, 'button, a', /워크플로/);
  await sleep(1800);
  await snap('02-workflow-board');
  console.log('   (탭:', t2, ')');

  // ②-b 사람별 정렬 토글
  const sortBtn = await clickByText(page, '.wf-views button', /사람별/);
  await sleep(900);
  if (sortBtn) await snap('05-person-sort');

  // ③ 상세 — factory 단계 잡(검증E): 요청날짜🔒 + 완료가능일 입력 확인
  const c1 = await clickByText(page, '.wf-card', /검증E/);
  await sleep(1200);
  if (c1) {
    await clickByText(page, 'button', /^상세$/); // 상세 펼치기(있으면)
    await sleep(600);
    await snap('03-detail-factory-datelock');
  } else console.log('⚠️ 검증E 카드 못 찾음');

  // ④ 상세 — 과거내역 done 잡(검증A): 보관 스트립 + 외부 링크 복사 버튼
  const c2 = await clickByText(page, '.wf-arc-row', /검증A/);
  await sleep(1200);
  if (c2) await snap('04-detail-done-archive');
  else console.log('⚠️ 검증A 과거내역 카드 못 찾음');

  await browser.close();
  console.log('\n저장 위치:', OUT);
  console.log(shots.map(s => ' - ' + s).join('\n'));
})().catch(err => { console.error('shot 드라이버 오류:', err.message); process.exitCode = 1; });
