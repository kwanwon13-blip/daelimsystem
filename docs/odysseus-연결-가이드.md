# Odysseus + 클로드 구독 연결 가이드 (Windows)

목표: Odysseus(셀프호스팅 AI 워크스페이스)를 띄우고, **통역 서버를 통해 사장님 클로드 구독으로** 채팅. 그 다음 마감 스킬을 꽂는다.

```
[Odysseus] ──OpenAI 요청──▶ [통역서버 :8765] ──claude -p──▶ [클로드 구독]
```

통역서버(`claude-bridge.js`)는 **이미 완성·검증**됐다(단발/스트리밍 OK). 아래는 사장님이 PC에서 할 단계.

---

## 1단계: 통역 서버 켜기 (로컬 PC)

명령창(cmd 또는 PowerShell)에서 ERP 폴더로 이동 후:
```
node claude-bridge.js
```
- 뜨면: `http://127.0.0.1:8765/v1` ← 이 창은 **켜둔 채로** 둔다.
- 전제: 이 PC에 `claude` 가 로그인돼 있어야 함(평소 ERP 챗이 쓰던 그 claude).
- 확인: 다른 창에서 `curl http://127.0.0.1:8765/health` → `{"ok":true...}` 나오면 정상.

## 2단계: Odysseus 설치·실행 (도커 없이 = 제일 간단)

```
git clone https://github.com/pewdiepie-archdaemon/odysseus.git
cd odysseus
powershell -ExecutionPolicy Bypass -File .\launch-windows.ps1
```
- 처음 실행하면 **admin 임시 비밀번호**가 명령창에 출력된다(메모).
- 브라우저에서 `http://localhost:7000` (안 되면 `:7860`) 접속 → admin + 그 비번으로 로그인.
- (요구사항: Python 3.11+. 없으면 launch 스크립트가 안내하거나, python.org 에서 설치.)

## 3단계: Odysseus에 "통역 서버"를 모델로 등록

Odysseus의 **Settings → Models/Providers → Add (OpenAI 호환)**:
| 항목 | 값 |
|------|-----|
| Base URL | `http://127.0.0.1:8765/v1` |
| API Key | 아무거나 (예: `sk-local`) — 통역서버는 키 검사 안 함 |
| Model | `claude-opus-4-8` |

> ⚠️ **Odysseus를 도커로 돌렸다면**: 1단계를 `CLAUDE_BRIDGE_HOST=0.0.0.0 node claude-bridge.js` 로 띄우고, Base URL 을 `http://host.docker.internal:8765/v1` 로.

## 4단계: 채팅 테스트

Odysseus에서 새 채팅 → "안녕" 입력 → **클로드가 한국어로 답하면 성공.** (요금 없이 구독으로!)

## 5단계: 퍼시스 마감 스킬 꽂기

`odysseus-kit/skills/` 폴더에 준비해둔 퍼시스 스킬을 Odysseus의 스킬 폴더로 복사:
```
odysseus/data/skills/거래처마감/persys-ledger/
   ├─ SKILL.md
   └─ make_persys.py
```
- Odysseus를 재시작하거나 Settings → Skills 에서 새로고침 → 스킬 인식.
- 채팅에서 "퍼시스 마감해줘" + 판매현황 파일 첨부 → 에이전트가 스킬대로 실행.
- ※ Odysseus의 작업 경로/파이썬 환경에 따라 SKILL.md 안의 스크립트 경로 1줄을 맞춰야 할 수 있음(연결 후 같이 확인).

---

## 막히면 체크
- 통역서버 창에 빨간 에러? → `claude` 로그인 만료일 수 있음(`claude -p "hi"` 로 확인).
- Odysseus가 모델을 못 찾음? → Base URL 끝에 `/v1` 붙었는지, 통역서버 창이 켜져 있는지.
- 도커면 `127.0.0.1` 대신 `host.docker.internal`.

## 이 구조의 핵심
- **Odysseus 코드는 안 건드림** → 만든 사람들이 업데이트하면 그대로 좋아짐.
- 우리는 **통역서버 + 꽂는 스킬**만 챙김 → 안 깨지고 재사용(ERP도 같은 통역서버 사용 가능).
