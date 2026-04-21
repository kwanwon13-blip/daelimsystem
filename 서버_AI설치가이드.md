# 서버 PC Claude Code 설치 가이드

> 워크스페이스 AI 템플릿 기능이 직원들에게도 동작하려면 **실제 서버 기계**에
> Claude Code CLI 가 설치되고 사장님 Pro Max 계정으로 로그인돼 있어야 합니다.
> 이 문서는 서버 기계(`D:\price-list-app\` 가 있는 PC)에서 따라하면 됩니다.

---

## 사전 확인

- 서버 기계가 Windows 10/11 인가? (YES — 배치파일 있음)
- 원격데스크탑으로 접속 가능한가, 아니면 직접 앉을 수 있나?
  (첫 로그인은 브라우저 OAuth 가 필요해서 화면 접근이 필수)
- 인터넷 연결되나? (설치 + 인증 모두 인터넷 필요)

---

## 1단계 — Claude Code 설치

1. 서버 기계에서 브라우저 열고 https://claude.com/download 접속
2. **Windows** 용 설치 파일 다운로드
3. 다운로드된 파일 실행 → 안내 따라 설치
4. 설치 끝나면 바탕화면이나 시작 메뉴에 **Claude** 아이콘 생김

설치 위치 기본값:
`%LOCALAPPDATA%\Programs\claude\`
(이 경로가 Windows PATH 에 자동 추가됨)

---

## 2단계 — PATH 확인

새로 `cmd` 창 열고 (중요: **설치 후 새 창**):

```
claude --version
```

→ 버전 번호 (예: `Claude Code 1.x.x`) 나오면 PATH OK

만약 `'claude'은(는) 내부 또는 외부 명령...` 에러 나면:

- 시작 메뉴 → `환경 변수` 검색 → "시스템 환경 변수 편집"
- Path 에 `%LOCALAPPDATA%\Programs\claude\` 추가
- cmd 창 닫고 새로 열기

---

## 3단계 — Pro Max 로그인

cmd 에서:

```
claude
```

실행하면 대화형 모드로 진입하면서 처음에 **로그인 프롬프트** 뜸.

1. 표시되는 URL 클릭 (또는 복사해서 브라우저 주소창에)
2. 브라우저에서 사장님 Anthropic 계정 로그인 (Pro Max 구독 있는 그 계정)
3. "Authorize Claude Code" 클릭
4. cmd 창으로 돌아와서 인증 완료 메시지 확인
5. `/exit` 또는 Ctrl+C 로 대화형 모드 종료

---

## 4단계 — CLI 동작 확인

cmd 에서:

```
claude -p "안녕 테스트"
```

→ 몇 초 기다리면 한국어 응답 나옴. 여기까지 되면 **CLI 준비 완료**.

stdin 방식도 확인:

```
echo 간판 작업 3건 완료 | claude -p
```

→ 응답 나오면 서버가 쓰는 호출 방식도 OK.

---

## 5단계 — 서버 연동 확인

서버(`테스트서버실행.bat`) 실행 후 브라우저에서:

```
http://localhost:3000/api/workspace/ai-health
```

→ JSON 응답 확인. 결과 해석:

| 필드 | 정상값 | 의미 |
|------|--------|------|
| `ok` | `true` | 전체 OK — AI 템플릿 바로 쓸 수 있음 |
| `cliAvailable` | `true` | claude CLI 가 PATH 에 있음 |
| `authenticated` | `true` | Pro Max 인증 돼있음 |
| `version` | `"Claude Code 1.x.x"` | CLI 버전 |
| `sample` | 짧은 응답 텍스트 | 실제 테스트 응답 (ping 에 대한 답) |

`cliAvailable: false` → 1~2단계 다시
`authenticated: false` → 3단계 다시

---

## 6단계 — 직원 테스트

직원 PC 에서 `http://(서버IP):3000` 접속 → 워크스페이스 탭 → ✦ AI → 템플릿 버튼 누르면 정상 작동.

---

## 서버 재시작 후에도 유지되는가?

- **Claude Code 인증**: 로그인 세션 오래 유지됨. 몇 주~몇 달. 만료되면 위 3단계 다시.
- **Windows 로그아웃/재부팅**: 인증은 보통 유지됨. 단, 세션이 끊기면 재로그인 필요.
- **node 서버 재시작**: 인증에 영향 없음. 재시작만 하면 됨.

---

## 트러블슈팅

**증상**: 직원이 AI 템플릿 버튼 누르면 "Claude CLI가 설치되지 않았습니다"
→ 서버 PC 의 cmd 에서 `claude --version` 직접 쳐보기. 안 되면 PATH 문제.

**증상**: "인증 실패 또는 응답 없음"
→ `claude -p "테스트"` 직접 쳐서 로그인 프롬프트 뜨면 3단계 재실행.

**증상**: 로컬(내 컴터)에선 되는데 서버에선 안 됨
→ 여기 가이드 5단계 `/api/workspace/ai-health` 엔드포인트 호출 결과 보고 판단.

**증상**: 응답이 90초 넘게 안 옴 → timeout
→ 네트워크 문제이거나 Claude 서비스 일시 장애. 잠시 후 재시도.

**증상**: Pro Max 한도 초과
→ 5시간 대기. 장기적으로 직원 많아지면 요청 큐나 캐시 고려.
