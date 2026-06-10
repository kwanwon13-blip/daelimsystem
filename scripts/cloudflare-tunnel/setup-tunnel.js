'use strict';
// Cloudflare 계정 쪽 터널 세팅 자동화 (1회용) — API 토큰으로:
//   ① 터널 생성(daelim-erp, 원격관리형) ② ingress: erp.daelimsm.com → http://localhost:3000
//   ③ DNS CNAME(erp → <tunnel>.cfargotunnel.com, proxied) ④ 서버 PC용 tunnel-env.bat 생성
//
// 사용법: node scripts/cloudflare-tunnel/setup-tunnel.js
// 전제:  %USERPROFILE%\.cf-token.txt 에 API 토큰 (권한: Account·Cloudflare Tunnel·Edit + Zone·DNS·Edit)
// 보안:  토큰/터널토큰은 stdout 에 출력하지 않는다. tunnel-env.bat 은 gitignore 대상.
// 재실행 안전: 같은 이름 터널/DNS 있으면 재사용·갱신.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ZONE_NAME = process.env.CF_ZONE || 'daelimsm.com';
const SUBDOMAIN = process.env.CF_SUBDOMAIN || 'erp';
const TUNNEL_NAME = process.env.CF_TUNNEL_NAME || 'daelim-erp';
const ORIGIN = process.env.CF_ORIGIN || 'http://localhost:3000';
const HOSTNAME = `${SUBDOMAIN}.${ZONE_NAME}`;
const API = 'https://api.cloudflare.com/client/v4';

const tokenPath = path.join(os.homedir(), '.cf-token.txt');
if (!fs.existsSync(tokenPath)) { console.error('토큰 파일 없음: ' + tokenPath); process.exit(1); }
const TOKEN = fs.readFileSync(tokenPath, 'utf8').trim();

async function cf(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const msg = (j.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || `HTTP ${r.status}`;
    throw new Error(`${method} ${p} 실패 — ${msg}`);
  }
  return j.result;
}

(async () => {
  // 0) 토큰 검증
  await cf('GET', '/user/tokens/verify');
  console.log('① 토큰 유효 확인');

  // 1) zone → account
  const zones = await cf('GET', `/zones?name=${ZONE_NAME}`);
  if (!zones.length) throw new Error(`zone ${ZONE_NAME} 을 토큰으로 볼 수 없음 — Zone 리소스 권한 확인`);
  const zone = zones[0];
  const accountId = zone.account.id;
  console.log(`② zone ${ZONE_NAME} (계정: ${zone.account.name})`);

  // 2) 터널 생성 또는 재사용 (원격관리형 config_src=cloudflare)
  const existing = await cf('GET', `/accounts/${accountId}/cfd_tunnel?name=${TUNNEL_NAME}&is_deleted=false`);
  let tunnel = existing.find(t => t.name === TUNNEL_NAME);
  if (tunnel) {
    console.log(`③ 기존 터널 재사용: ${TUNNEL_NAME} (${tunnel.id.slice(0, 8)}…)`);
  } else {
    tunnel = await cf('POST', `/accounts/${accountId}/cfd_tunnel`, { name: TUNNEL_NAME, config_src: 'cloudflare' });
    console.log(`③ 터널 생성: ${TUNNEL_NAME} (${tunnel.id.slice(0, 8)}…)`);
  }

  // 3) ingress 설정: erp.daelimsm.com → ERP(3000)
  await cf('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: { ingress: [
      { hostname: HOSTNAME, service: ORIGIN },
      { service: 'http_status:404' },
    ] },
  });
  console.log(`④ 경로 설정: https://${HOSTNAME} → ${ORIGIN}`);

  // 4) DNS CNAME (있으면 갱신)
  const target = `${tunnel.id}.cfargotunnel.com`;
  const recs = await cf('GET', `/zones/${zone.id}/dns_records?name=${HOSTNAME}`);
  const rec = recs.find(r => r.name === HOSTNAME);
  const dnsBody = { type: 'CNAME', name: SUBDOMAIN, content: target, proxied: true, ttl: 1 };
  if (rec) {
    await cf('PUT', `/zones/${zone.id}/dns_records/${rec.id}`, dnsBody);
    console.log(`⑤ DNS 갱신: ${HOSTNAME} → 터널 (proxied)`);
  } else {
    await cf('POST', `/zones/${zone.id}/dns_records`, dnsBody);
    console.log(`⑤ DNS 생성: ${HOSTNAME} → 터널 (proxied)`);
  }

  // 5) 터널 실행 토큰 → 서버 PC용 tunnel-env.bat (stdout 출력 금지!)
  const runToken = await cf('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
  const envBat = [
    'rem Server-PC local secrets for tunnel-start.bat (gitignored, do not commit)',
    `set TUNNEL_TOKEN=${runToken}`,
    `set PUBLIC_HOSTNAME=${HOSTNAME}`,
    'rem Optional: fill these to auto-register the URL into ERP workflow settings on start',
    'rem set ERP_ADMIN_ID=admin',
    'rem set ERP_ADMIN_PW=your-password',
    '',
  ].join('\r\n');
  const outPath = path.join(__dirname, 'tunnel-env.bat');
  fs.writeFileSync(outPath, envBat);
  console.log(`⑥ 서버 PC용 비밀파일 생성: ${outPath} (터널 실행 토큰 포함 — 화면 출력 안 함)`);

  console.log('\n완료. 남은 일: tunnel-env.bat + tunnel-start.bat + tunnel-quick.js 를 서버 PC D:\\price-list-app\\scripts\\cloudflare-tunnel\\ 로 복사 후 tunnel-start.bat 실행.');
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
