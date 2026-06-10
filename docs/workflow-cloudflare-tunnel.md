# Workflow Cloudflare Tunnel Notes

## Purpose
- Factory-side users cannot access the office ERP server directly.
- Expose only the ERP HTTP service through Cloudflare Tunnel when the server PC is online.
- Keep file storage paths based on the server PC, not the local developer PC.

## Server-Only Values To Confirm
- ERP server root: `D:\price-list-app`
- Main app URL: `http://127.0.0.1:3000` on the server PC
- Workflow file storage root: confirm on server before hardcoding or migrating
- Tunnel hostname: decide after Cloudflare account/domain check

## Intended Workflow Behavior
- Design uploads proof images/JPG and AI originals in ERP.
- Design sets the requested completion date per proof file.
- Factory receives ERP workflow notifications through the tunneled ERP URL.
- Factory replies with available production date and reason per proof file.
- All comments stay attached to the proof/file card.

## Do Not Do
- Do not use local PC paths as workflow file storage rules.
- Do not expose local development server through the tunnel.
- Do not store tunnel tokens in this repository.

## Quick Tunnel Kit (2026-06-10 추가 — 서버 PC 3단계)

`scripts/cloudflare-tunnel/` 폴더가 git 으로 전파된다. 서버 PC에서:

1. `git-pull-server.bat` 실행 (키트 받기)
2. `scripts\cloudflare-tunnel\` 폴더에 `tunnel-env.bat` 생성 (한 번만, 커밋 안 됨):
   ```bat
   set ERP_ADMIN_ID=admin
   set ERP_ADMIN_PW=실제비밀번호
   ```
3. `tunnel-start.bat` 더블클릭
   - 첫 실행 시 cloudflared.exe 자동 다운로드
   - 터널 URL 발급 → ERP 워크플로우 "외부 다운로드 주소"에 **자동 등록**
   - 죽으면 5초 후 자동 재시작 + 새 URL 재등록 (quick tunnel 은 재시작마다 URL 변경)

확인: ERP 워크플로우 탭에서 영업지원팀/과거내역 카드에 "🔗외부" 버튼이 보이면 활성화된 것.

### Named tunnel 업그레이드 (고정 주소가 필요해지면)
quick tunnel URL 은 재시작마다 바뀐다(자동 재등록으로 커버되지만, 메일로 이미 보낸 옛 링크는 끊김).
오래 가는 링크가 필요하면: Cloudflare 계정 + 도메인 → 서버 PC에서 `cloudflared tunnel login` →
named tunnel 생성 → `tunnel-env.bat` 에 `set TUNNEL_ORIGIN=...` 대신 cloudflared 서비스 설치.
토큰/cert 는 서버 PC에만 두고 레포에 올리지 않는다.
