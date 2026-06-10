---
name: verifier-erp
description: Use when verifying ERP changes on a running app — workflow transitions, date guards, API behavior, or UI/색상 consistency screenshots. Trigger phrases: 검증해줘, 실제로 동작하나, 화면 확인, verify, QA on this repo.
---

# verifier-erp — 이 레포 라이브 검증 레시피

코드를 읽는 게 아니라 **서버를 실제로 띄우고 HTTP/화면을 때려서** 검증한다.
검증 시나리오는 드라이버 스크립트에 누적한다 (이 폴더).

## 1. 서버 기동 (격리 필수)

```bash
cd <레포루트>
PORT=3217 DESIGN_ROOT="<레포루트>\outputs\verify\design-root" node server.js   # 백그라운드로
```

- **`DESIGN_ROOT` 생략 금지.** 기본값이 `D:\` 라서 잡 생성/업로드가 **로컬 D: 드라이브에 실제 폴더를 만든다** (routes/design.js:26). 격리 루트는 미리 `mkdir -p`.
- 포트 3000(운영)·3001(CAPS)·3002(데몬) 피해서 3217 사용.
- data/는 워크트리 로컬이라 운영과 격리됨. 첫 부팅 시 **admin/admin** 자동 생성.
- 종료는 TaskStop(백그라운드 ID)으로. taskkill 금지(운영 프로세스 위험).

## 2. 드라이버 실행

```bash
node .claude/skills/verifier-erp/verify-workflow-live.js   # API 시나리오 30개 (PASS/FAIL + exit code)
node .claude/skills/verifier-erp/shot-erp.js               # UI 스크린샷 4장
```

- 증거: `outputs/verify/api-evidence.json`, `outputs/verify/0*.png` → **Read 도구로 PNG를 직접 눈으로 확인할 것.**
- 재실행 안전: 드라이버 Phase 0이 이전 테스트 잡(`검증*`)을 앱 API로 정리(abort-empty→취소). FS 삭제 안 함.
- API 드라이버가 보드 시드도 깔아줌(각 칸 1카드 + 과거내역 2건) → 스크린샷은 그 직후가 보기 좋다.

## 3. 함정 (전부 실제로 밟은 것)

| 함정 | 해법 |
|------|------|
| 한글 JSON을 curl -d로 보내면 인코딩 깨져 저장됨(mojibake 잡) | 항상 **node fetch**로 호출 (드라이버처럼) |
| bash `/tmp`와 node의 `/tmp`가 다른 폴더 (git-bash vs C:\tmp) | 파일 경유 말고 node 스크립트 안에서 fetch |
| `PUT /api/workflow/jobs/:id`는 부분 업데이트 아님 — title 폴백 없음 | UI처럼 **전체 job 객체** spread 후 변경분 덮어쓰기 |
| 워크플로우 핸드오프 confirm()/alert() 다이얼로그 | puppeteer `page.on('dialog', accept)` |
| 업로드는 multipart 필드명 `files`, 회사/현장 없으면 400 | 잡에 companyName/projectName 먼저 |
| 외부(터널) 버튼은 base URL 없으면 안 보임 | `POST /api/workflow/settings/public-link` 로 공개주소 설정(사설IP는 400) |

## 4. 새 검증 추가하는 법

verify-workflow-live.js 에 `check()/probe()` 한 줄씩 추가. 형식: `check('이름', 조건, '상세')`.
새 기능 검증 = 새 드라이버 파일 추가보다 **기존 드라이버에 시나리오 누적**이 우선.
