'use strict';
// 워크플로우 라이브 검증 드라이버 — 실행 중인 ERP 서버의 실제 HTTP 표면을 때려서
// 날짜역할 가드 / 전환(완료가능일 확정→완료→수령) / 완료코드 발번 시점 / 터널 설정을 검증한다.
//
// 사용법:  node .claude/skills/verifier-erp/verify-workflow-live.js
// 전제:    서버 실행 중 (PORT=3217 node server.js — 격리된 워크트리 data/ 사용)
// 증거:    outputs/verify/api-evidence.json + stdout ✅/❌/🔍 라인

const fs = require('fs');
const path = require('path');

const BASE = process.env.ERP_BASE || 'http://localhost:3217';
const results = [];
let cookie = '';

function record(icon, name, ok, detail) {
  results.push({ icon, name, ok, detail });
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
}
function pass(name, detail) { record('✅', name, true, detail); }
function fail(name, detail) { record('❌', name, false, detail); }
function probe(name, ok, detail) { record(ok ? '🔍' : '❌', name, ok, detail); }
function check(name, cond, detail) { (cond ? pass : fail)(name, detail); }

async function api(method, p, body, isForm) {
  const opts = { method, headers: { Cookie: cookie } };
  if (body && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (body && isForm) opts.body = body;
  const r = await fetch(BASE + p, opts);
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, j };
}

async function createJob(title, extra = {}) {
  const { j } = await api('POST', '/api/workflow/jobs', {
    title, companyName: '검증업체', projectName: '검증현장', dueDate: '2026-06-15', ...extra,
  });
  return j.job;
}
async function getJob(id) { return (await api('GET', `/api/workflow/jobs/${id}`)).j.job; }
async function putJob(job, changes) { return (await api('PUT', `/api/workflow/jobs/${job.id}`, { ...job, ...changes })).j; }
async function handoff(id, stageId = '') { return (await api('POST', `/api/workflow/jobs/${id}/handoff`, { stageId, message: '' })).j; }
async function setStage(id, stageId, status) { return (await api('POST', `/api/workflow/jobs/${id}/stages/${stageId}`, { status })).j; }
async function uploadPng(jobId, name) {
  // 1x1 투명 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('files', new Blob([png], { type: 'image/png' }), name);
  return (await api('POST', `/api/workflow/jobs/${jobId}/files`, fd, true)).j;
}

(async () => {
  // ── 로그인 (초기 계정 admin/admin — 서버가 부트스트랩) ──
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'admin', password: 'admin' }),
  });
  cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  check('로그인(admin)', lr.ok && cookie.includes('session_token'), cookie ? '세션 쿠키 획득' : '쿠키 없음');

  // ── Phase 0: 이전 실행의 테스트 잡 정리 (FS 삭제 없이 앱 API로만 — abort-empty → 안 되면 취소) ──
  const all = (await api('GET', '/api/workflow/jobs?status=all')).j.jobs || [];
  let cleaned = 0, cancelled = 0;
  for (const j of all) {
    if (!/^(검증|업로드디버그)/.test(j.title || '')) continue;
    const ab = await api('POST', `/api/workflow/jobs/${j.id}/abort-empty`, {});
    if (ab.status === 200) { cleaned++; continue; }
    if (j.status !== 'cancelled') { await putJob(j, { status: 'cancelled' }); cancelled++; }
  }
  if (cleaned || cancelled) pass('Phase0 이전 테스트 잡 정리', `삭제 ${cleaned} · 취소 ${cancelled}`);

  // ════ A. 메인 흐름: 디자인 → (완료가능일 확정) → 대림컴퍼니 → (완료=발번) → 영업지원 → (수령) ════
  let a = await createJob('검증A 단가표시안', { factoryAvailableDate: '2026-06-25' });
  check('A1 생성=design 단계', a.currentStage === 'design', `stage=${a.currentStage}`);
  check('A1 생성 시 완료가능일 차단(가드)', !a.factoryAvailableDate, `factoryAvailableDate=${JSON.stringify(a.factoryAvailableDate || '')}`);
  check('A1 요청날짜 저장', a.dueDate === '2026-06-15', `dueDate=${a.dueDate}`);

  let r = await putJob(a, { dueDate: '2026-06-16', factoryAvailableDate: '2026-06-25' });
  check('A2 design: 요청날짜 수정 허용', r.job.dueDate === '2026-06-16', `dueDate=${r.job.dueDate}`);
  check('A2 design: 완료가능일 수정 차단', !r.job.factoryAvailableDate, `factoryAvailableDate=${JSON.stringify(r.job.factoryAvailableDate || '')}`);

  const up = await uploadPng(a.id, '검증시안.png');
  check('A3 시안 파일 업로드', up && up.ok === true && Number(up.job?.fileCount) === 1,
    up && up.ok === true ? `fileCount=${up.job.fileCount}` : `error=${up && up.error}`);

  r = await handoff(a.id, 'design'); // = "완료가능일 확정" 버튼
  check('A4 design→factory 전환', r.job.currentStage === 'factory', `stage=${r.job.currentStage}`);
  check('A4 이 시점 완료코드 미발번', !r.job.completionCode, `code=${JSON.stringify(r.job.completionCode || '')}`);

  a = r.job;
  r = await putJob(a, { dueDate: '2026-06-18', factoryAvailableDate: '2026-06-26' });
  check('A5 factory: 요청날짜 잠금(🔒)', r.job.dueDate === '2026-06-16', `dueDate=${r.job.dueDate}`);
  check('A5 factory: 완료가능일 저장', r.job.factoryAvailableDate === '2026-06-26', `factoryAvailableDate=${r.job.factoryAvailableDate}`);

  r = await handoff(a.id, 'factory'); // = "완료" 버튼 (제작완료)
  const codeA = r.job.completionCode || '';
  check('A6 factory→delivery 전환', r.job.currentStage === 'delivery', `stage=${r.job.currentStage}`);
  check('A6 제작완료 시점에 완료코드 발번', /^\d{8}-\d{3}$/.test(codeA), `code=${codeA}`);
  check('A6 제작완료일 기록', !!r.job.completedAt, `completedAt=${r.job.completedAt}`);
  check('A6 아직 수령 전(status active)', r.job.status === 'active', `status=${r.job.status}`);

  a = r.job;
  r = await putJob(a, { dueDate: '2026-06-19', factoryAvailableDate: '2026-06-27' });
  check('A7 delivery: 두 날짜 모두 잠금(🔒)', r.job.dueDate === '2026-06-16' && r.job.factoryAvailableDate === '2026-06-26',
    `dueDate=${r.job.dueDate}, factoryAvailableDate=${r.job.factoryAvailableDate}`);

  r = await handoff(a.id, 'delivery'); // = "수령" 버튼
  check('A8 수령→과거내역(done)', r.job.status === 'done', `status=${r.job.status}`);
  check('A8 보관 메타 기록', r.job.archiveStatus === 'ready' && Number(r.job.archiveFileCount) === 1,
    `archiveStatus=${r.job.archiveStatus}, files=${r.job.archiveFileCount}`);
  check('A8 완료코드 보존(수령해도 유지)', r.job.completionCode === codeA, `code=${r.job.completionCode}`);
  check('A8 외부 ZIP 상대경로 노출', String(r.job.publicArchiveUrl || '').includes('/api/workflow/public/jobs/'), r.job.publicArchiveUrl);

  const done = await api('GET', '/api/workflow/jobs?status=done');
  const inArchive = (done.j.jobs || []).find(j => j.id === a.id);
  check('A9 과거내역 목록에 코드와 함께 노출', !!inArchive && inArchive.completionCode === codeA,
    `archive code=${inArchive && inArchive.completionCode}`);

  // ════ B. 프로브: factory reopen 후 수령해도 코드 유실 없어야 함 (리뷰 MEDIUM 수정 검증) ════
  let b = await createJob('검증B reopen보존');
  await handoff(b.id, 'design');
  r = await handoff(b.id, 'factory');
  const codeB1 = r.job.completionCode;
  probe('B1 제작완료 발번', /^\d{8}-\d{3}$/.test(codeB1 || ''), `code=${codeB1}`);

  r = await setStage(b.id, 'factory', 'ready'); // 제작완료 취소(reopen)
  probe('B2 factory reopen → 코드 회수(의도된 동작)', !r.job.completionCode && r.job.status !== 'done',
    `code=${JSON.stringify(r.job.completionCode || '')}, status=${r.job.status}`);

  r = await handoff(b.id, 'delivery'); // factory가 reopen된 채로 수령 강행
  probe('B3 reopen 채로 수령해도 코드 재발번(미발번 방지)', r.job.status === 'done' && /^\d{8}-\d{3}$/.test(r.job.completionCode || ''),
    `status=${r.job.status}, code=${r.job.completionCode}`);

  // ════ C. 터널(외부 다운로드 주소) 설정 가드 + 공개 ZIP ════
  r = await api('POST', '/api/workflow/settings/public-link', { publicBaseUrl: 'http://192.168.0.133:3000' });
  probe('C1 사설IP 터널주소 거부(400)', r.status === 400, `status=${r.status}, error=${r.j && r.j.error}`);

  r = await api('POST', '/api/workflow/settings/public-link', { publicBaseUrl: 'https://erp-daelim-test.example.com' });
  check('C2 공개 터널주소 저장', r.status === 200 && r.j.publicBaseUrl === 'https://erp-daelim-test.example.com', `base=${r.j && r.j.publicBaseUrl}`);

  const meta = await api('GET', '/api/workflow/meta');
  check('C3 meta에 터널주소 반영(UI 버튼 노출 조건)', meta.j.publicBaseUrl === 'https://erp-daelim-test.example.com', `meta.publicBaseUrl=${meta.j.publicBaseUrl}`);

  const aFinal = await getJob(a.id);
  const zip = await fetch(BASE + aFinal.publicArchiveUrl); // 공개 엔드포인트 — 쿠키 없이
  probe('C4 공개 ZIP 비로그인 다운로드', zip.status === 200 && (zip.headers.get('content-type') || '').includes('zip'),
    `status=${zip.status}, type=${zip.headers.get('content-type')}`);

  // ════ D. 스크린샷용 시드: 각 칸에 카드 하나씩 ════
  await createJob('검증D 디자인대기');
  const e = await createJob('검증E 공장확인중');
  await uploadPng(e.id, '검증E.png');
  await handoff(e.id, 'design');
  await putJob(await getJob(e.id), { factoryAvailableDate: '2026-06-24' });
  const f = await createJob('검증F 수령대기');
  await uploadPng(f.id, '검증F.png');
  await handoff(f.id, 'design');
  await handoff(f.id, 'factory');
  pass('D 시드 완료', 'design=검증D / factory=검증E(완료가능일) / delivery=검증F(코드발번) / 과거내역=검증A·B');

  // ── 증거 저장 + 종합 ──
  const outDir = path.join(process.cwd(), 'outputs', 'verify');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'api-evidence.json'), JSON.stringify({ base: BASE, when: new Date().toISOString(), results }, null, 2));
  const failed = results.filter(x => !x.ok);
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length} (증거: outputs/verify/api-evidence.json)`);
  process.exitCode = failed.length ? 1 : 0;
})().catch(err => { console.error('드라이버 자체 오류:', err); process.exitCode = 1; });
