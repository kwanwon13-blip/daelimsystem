'use strict';
// Cloudflare Quick Tunnel 래퍼 — 서버 PC에서 ERP(3000)를 외부에 노출하고,
// 발급된 trycloudflare URL을 ERP 워크플로우 "외부 다운로드 주소"에 자동 등록한다.
//
// 사용법(서버 PC):  터널시작.bat 더블클릭  (cloudflared.exe 자동 다운로드 포함)
// 직접 실행:        node scripts/cloudflare-tunnel/tunnel-quick.js
//
// 환경변수:
//   ERP_BASE        등록 대상 ERP 주소 (기본 http://127.0.0.1:3000)
//   TUNNEL_ORIGIN   터널이 노출할 원본 (기본 ERP_BASE)
//   ERP_ADMIN_ID    관리자 아이디 (기본 admin)
//   ERP_ADMIN_PW    관리자 비밀번호 (기본 admin — 서버 PC에선 실제 값으로!)
//   CLOUDFLARED     cloudflared 실행파일 경로 (기본: 이 폴더의 cloudflared.exe, 없으면 PATH)
//
// 주의: quick tunnel 은 재시작마다 URL이 바뀐다 → 이 래퍼가 매번 자동 재등록.
//       고정 주소가 필요해지면 named tunnel 로 업그레이드 (docs/workflow-cloudflare-tunnel.md).

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// cloudflared 출력 라인에서 quick tunnel 공개 URL 추출 (테스트: tests/tunnel-url-parse.test.js)
function parseTunnelUrl(line) {
  const m = String(line || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return m ? m[0] : '';
}

async function registerPublicBaseUrl(erpBase, url, adminId, adminPw) {
  const lr = await fetch(erpBase + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: adminId, password: adminPw }),
  });
  if (!lr.ok) throw new Error(`ERP 관리자 로그인 실패(${lr.status}) — ERP_ADMIN_ID/PW 확인`);
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  const sr = await fetch(erpBase + '/api/workflow/settings/public-link', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ publicBaseUrl: url }),
  });
  const j = await sr.json().catch(() => ({}));
  if (!sr.ok || j.ok === false) throw new Error(`외부주소 등록 실패(${sr.status}): ${j.error || ''}`);
  return j;
}

function main() {
  const ERP_BASE = (process.env.ERP_BASE || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const ORIGIN = (process.env.TUNNEL_ORIGIN || ERP_BASE).replace(/\/+$/, '');
  const ADMIN_ID = process.env.ERP_ADMIN_ID || 'admin';
  const ADMIN_PW = process.env.ERP_ADMIN_PW || 'admin';
  const localExe = path.join(__dirname, 'cloudflared.exe');
  const BIN = process.env.CLOUDFLARED || (fs.existsSync(localExe) ? localExe : 'cloudflared');

  console.log(`[tunnel] origin=${ORIGIN} → trycloudflare (등록 대상 ERP: ${ERP_BASE})`);
  const child = spawn(BIN, ['tunnel', '--no-autoupdate', '--url', ORIGIN], { stdio: ['ignore', 'pipe', 'pipe'] });

  let registered = false;
  const onLine = async (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (registered) return;
    const url = parseTunnelUrl(text);
    if (!url) return;
    registered = true;
    console.log(`\n[tunnel] 공개 URL: ${url} → ERP에 자동 등록 중...`);
    try {
      await registerPublicBaseUrl(ERP_BASE, url, ADMIN_ID, ADMIN_PW);
      console.log('[tunnel] 등록 완료 — 워크플로우 외부 받기 링크 활성화됨');
    } catch (e) {
      console.error('[tunnel] 자동 등록 실패:', e.message);
      console.error(`[tunnel] 수동 등록: ERP 워크플로우 설정 → 외부 다운로드 주소에 ${url} 입력`);
    }
  };
  child.stdout.on('data', onLine);
  child.stderr.on('data', onLine); // cloudflared 는 주요 로그를 stderr 로 쓴다

  child.on('exit', (code) => {
    console.log(`[tunnel] cloudflared 종료(code=${code}) — 와치독이 재시작하면 새 URL 로 자동 재등록됨`);
    process.exit(code === 0 ? 0 : 1);
  });
  child.on('error', (e) => {
    console.error('[tunnel] cloudflared 실행 실패:', e.message);
    console.error('[tunnel] cloudflared.exe 가 이 폴더에 있는지, 또는 PATH 에 있는지 확인하세요.');
    process.exit(1);
  });
}

module.exports = { parseTunnelUrl, registerPublicBaseUrl };
if (require.main === module) main();
