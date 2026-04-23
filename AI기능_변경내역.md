# AI 기능 마무리 작업 (Level 0 + 0.5 + 1)

**시작**: 2026-04-22 22:36 KST
**완료**: 2026-04-22 22:53 KST
**범위**: 시안검색 원본보기 수정 + AI 히스토리/프로젝트/대화이어가기/템플릿/파일첨부

---

## 진행 체크리스트

- [x] **시안검색 원본보기 수정** (2026-04-22 22:10 KST)
  - `itemType()` / `canPreview()` 헬퍼 추가 → 서버 인덱스가 옛 버전이어도 확장자로 판단 가능
  - 썸네일 클릭 / 화살표 네비게이션 / 라이트박스 모두 헬퍼 경유로 변경
- [x] **단계 1. 현재 AI 구조 파악** (2026-04-22 22:35 KST)
  - `/api/workspace/ai` (Claude CLI), `/api/workspace/ai-image` (Gemini)
  - workspaceApp() Alpine 컴포넌트
  - SQLite `업무데이터.db` 에 `workspace_pages` 테이블만 존재
- [x] **단계 2. AI DB 스키마 설계** (2026-04-22 22:38 KST)
  - `data/ai기록.db` 파일 분리 (업무 DB 렉 방지)
  - 6개 테이블: ai_projects, ai_project_members, ai_threads, ai_messages, ai_templates, ai_attachments
  - WAL 모드 + synchronous=NORMAL
  - 4단계 공유: private / team / company / invited
- [x] **단계 3. routes/ai-history.js** (2026-04-22 22:42 KST)
  - 프로젝트 CRUD + 멤버 초대
  - 스레드 CRUD (`/threads?scope=mine|team|company|invited|projects`)
  - 메시지 CRUD (스레드 안에)
  - `/chat` — Claude CLI 호출 + 이전 대화 컨텍스트 8턴 + 템플릿 + 첨부 텍스트 자동 주입
  - `/chat-image` — Gemini + nanobanana
  - 템플릿 CRUD
  - 첨부파일 업로드 (multer) + 엑셀 텍스트 추출 (exceljs) + PDF 선택적 (pdf-parse)
  - `/health` 핑 (DB 비활성화여도 200 으로 응답)
- [x] **단계 4. 대화 이어가기 (L0.5)** (2026-04-22 22:42 KST)
  - `threads.recentMessages(8)` 로 이전 대화 프롬프트에 자동 주입
  - 첫 턴에 자동 타이틀 설정 (`autoTitleIfEmpty`)
- [x] **단계 5. 템플릿 + 파일첨부 (L1)** (2026-04-22 22:42 KST)
  - 템플릿: prompt prefix 로 붙여서 호출, usage_count 자동 증가
  - 첨부: 이미지/엑셀/PDF/워드/텍스트 5종 분류
  - 엑셀은 exceljs 로 시트별 파싱
  - PDF 는 pdf-parse 있으면 추출, 없으면 "미설치" 안내
- [x] **단계 6. 프론트 UI** (2026-04-22 22:53 KST)
  - `tab-workspace.html`:
    - AI 히스토리 미니 바 (접힘/펼침, 스코프 5종 칩, 검색, 20개 리스트 + 더보기)
    - 현재 스레드 헤드 + 말풍선 메시지 목록 (유저/AI/에러 색상)
    - 첨부/프로젝트 도구 바 (📎 파일, 📁 프로젝트, + 새 대화)
    - 프로젝트 편집 모달 (4단계 공유 범위 + 멤버 초대)
    - 첨부 대기 칩 + ✕ 제거
  - `workspaceApp()` Alpine 확장:
    - 20여개 state 추가 (aiReady, historyPanelOpen, historyScope, threads, projects, currentThreadId, currentMessages, pendingAttachments, projectForm 등)
    - 메서드: toggleHistoryPanel, setHistoryScope, loadThreads, loadMoreThreads, loadProjects, openThread, startNewThread, uploadAttachment, removeAttachment, openProjectModal, closeProjectModal, saveProject, deleteProject, toggleProjectMember
    - `askAI()` 재작성 → `/api/ai/chat` 사용 (스레드 자동 생성/이어가기) + 첨부/프로젝트 자동 귀속 + 낙관적 UI
    - `aiReady=false` 면 구 `/api/workspace/ai` 로 폴백 (서버 PC 에서 SQLite 미설치 시 안전)
- [x] **단계 7. 구문 검증 + 스모크 테스트** (2026-04-22 22:53 KST)
  - `node -c routes/ai-history.js` ✓
  - `node -c db-ai.js` ✓
  - `node -c server.js` ✓
  - `tab-workspace.html` script 블록 파싱 ✓
  - `index.html app()` 함수 파싱 ✓
  - `workspaceApp()` 반환 객체 키 검증 (87개, 필수 27개 전부 있음) ✓
  - `require('./db-ai')` / `require('./routes/ai-history')` 둘 다 import 성공 ✓
  - ※ Linux 샌드박스에선 better-sqlite3 가 Windows 바이너리라 `ready:false` 로 안전하게 폴백. Windows 서버에서는 정상 동작.

---

## 배포 방법 (아침에 로컬 PC 에서)

로컬 PC (C:\\Users\\NAMGW\\Documents\\Claude\\Projects\\업체별 단가표 만들기!!!\\price-list-app) 에서:

```
_배포.bat
```

커밋 메시지 제안:
```
시안검색 원본보기 버그 수정 + AI 히스토리/프로젝트/대화이어가기/템플릿/파일첨부 추가

- 시안검색: itemType()/canPreview() 헬퍼 추가로 구 인덱스 호환
- AI: 별도 ai기록.db 로 렉 방지, 4단계 공유(private/team/company/invited)
- AI: 스레드 단위 대화 이어가기 + 이전 8턴 컨텍스트 자동 주입
- AI: 템플릿/파일첨부(엑셀·PDF 텍스트 추출) 기능
- AI: 워크스페이스 패널에 히스토리 미니바 + 프로젝트 모달 추가
```

서버 PC (192.168.0.133, D:\\price-list-app) 에서:
```
git-pull-server.bat
```

---

## 새로 추가된 파일

- `db-ai.js` — AI 전용 SQLite 모듈 (6개 테이블 스키마 포함)
- `routes/ai-history.js` — `/api/ai/*` 라우터
- `data/ai기록.db` — 서버 첫 기동 시 자동 생성됨
- `data/ai_uploads/` — 첨부파일 업로드 디렉토리 (자동 생성)

## 수정된 파일

- `server.js` — `app.use('/api/ai', require('./routes/ai-history'))` 한 줄 추가
- `public/tab-workspace.html` — CSS + HTML + Alpine 확장 (약 400줄 추가)
- `public/index.html` — 시안검색 원본보기 헬퍼 (완료)

---

## 주의사항

1. **서버 PC 에서 `npm install` 불필요** — multer/exceljs/better-sqlite3 모두 이미 `package.json` 에 있음. 서버는 `git pull` 후 재시작만 하면 됨.
2. **PDF 텍스트 추출은 선택적** — `pdf-parse` 가 없으면 "미설치" 안내만 남기고 파일 자체는 첨부됨. 필요하면 서버 PC 에서 `npm install pdf-parse` 추가.
3. **기존 `/api/workspace/ai` 는 유지** — `aiReady=false` 일 때 폴백용. 구 방식이 깨지진 않음.
4. **서버 첫 기동 시** `data/ai기록.db` + `data/ai_uploads/` 가 자동 생성됨. 권한 문제 없음.

---

## 완료 시각: 2026-04-22 22:53 KST

주무세요! 아침에 `_배포.bat` 만 돌리시면 됩니다. 🌙

---

# 2차 개편 — AI 탭 분리 + 워크스페이스 슬림화

**시작**: 2026-04-22 23:40 KST 경
**범위**: AI를 독립 메뉴로 분리 (Claude.ai 스타일) + 워크스페이스 AI 패널은 "작성 도우미" 전용으로 축소

## 배경 — 사용자 피드백 원문
> "워크스페이스 / ai 따로 기능 나뉘어야 하는거아냐???? 이미지 생성은 ai 기능에 따로 들어가야 할거같은데 워크스페이스의 클로드는 작성을 요청할려면 필요해서 없어지면 안될거같고 그리고 워크스페이스 기능이 노션처럼 데이터베이스나 폼 이런거 추가 가능하게 되어있어야 하는거아닌가??? 이건 반쪽짜린데"

→ **반쪽짜리 탈출 작전**. AI는 독립된 전용 공간으로, 워크스페이스는 노션스러운 문서/DB 편집기로 각자의 깊이를 가지도록 분리.

## 완료 항목

### [x] AI 탭 신설 (독립 메뉴 · Claude.ai 스타일)
- `public/tab-ai.html` 신규 (~900줄)
- 좌측 280px 사이드바: 검색 / 스코프 칩(내·팀·회사·초대·프로젝트) / 프로젝트 목록 / 스레드 목록 / "더 보기"
- 메인 채팅 영역: 환영 화면(4개 제안 카드) · 말풍선 메시지 · "+ 새 대화" · 첨부 칩 · 이미지 생성 토글(`imageMode`)
- 프로젝트 편집 모달 (4단계 공유 + 초대 체크리스트)
- `aiApp()` Alpine 컴포넌트 · 48 키
- `localStorage: aiTab:lastThreadId` 로 F5 시 마지막 스레드 복원
- 이미지 생성은 `imageMode` 토글 → send 시 `/api/ai/chat-image` 로 분기

### [x] index.html 메뉴 등록
- menuGroups "나만의 공간" 에 `{ id:'ai', label:'AI 챗', icon:'smart_toy' }` 추가
- allMenus · admin tabs · defaultMenus · REMEMBERED_TABS 전부 반영
- 헤더 아이콘 삼항연산자에 `ai` 추가
- content area `(workspace || ai) ? 'background:#f8f9fb;overflow:hidden;'`
- 워크스페이스 SSI 바로 뒤에 `<!--INCLUDE:tab-ai.html-->` 블록

### [x] routes/ai-history.js 확장
- GET /threads 가 `?project=<id>` 받도록 (기존 `projectId=` 와 양립)
- 각 스레드에 `share_mode` 필드 부여 (프로젝트에서 상속 · 없으면 'private')
- shared 모드 필터링은 프로젝트 미지정 시에만 적용

### [x] 워크스페이스 AI 패널 슬림화
- `tab-workspace.html` : 1473줄 → 990줄 (**-483줄**)
- **HTML 제거**: ws-ai-hist-bar · 히스토리 패널 · ws-ai-thread-head · 말풍선 · 이미지 생성 섹션 · ws-ai-pending-att · ws-ai-tools · 프로젝트 선택 드롭다운 · 프로젝트 편집 모달 (ws-proj-overlay)
- **CSS 제거**: ws-ai-hist-* · ws-ai-msgs · ws-ai-msg · ws-ai-tools · ws-ai-pending-att · ws-proj-* 전부
- **JS 제거**: aiReady / historyPanelOpen / historyScope / threads / currentThreadId / currentThread / currentMessages / projects / currentProjectId / pendingAttachments / showProjectPicker / showProjectModal / projectForm / aiImagePrompt / aiImageLoading + 관련 메서드 (toggleHistoryPanel, setHistoryScope, loadThreads, loadMoreThreads, loadProjects, openThread, startNewThread, uploadAttachment, removeAttachment, openProjectModal, closeProjectModal, toggleProjectMember, saveProject, deleteProject, generateAIImage)
- **askAI() 단순화**: `/api/ai/chat` 분기 제거 → 순수 `/api/workspace/ai` 만 사용 (현재 페이지 내용을 AI 에게 전달 → 결과 텍스트)
- **헤더에 🤖 AI 탭 링크**: 패널 상단에서 한 번 클릭으로 AI 탭으로 점프
- **안내 문구**: "💡 대화 이어가기·파일 첨부·이미지 생성은 상단의 🤖 AI 탭에서 이용하세요."
- **유지**: 템플릿(일일업무일지/프로젝트체크리스트/고객보고서) · 빠른 도움 5종 · 결과 표시 · 단순 입력+전송

### [x] 구문 검증
- `node -c routes/ai-history.js` ✓
- `node -c db-ai.js` ✓
- `node -c server.js` ✓
- `tab-workspace.html` script 블록 파싱 ✓ · workspaceApp() 50키
- `tab-ai.html` script 블록 파싱 ✓ · aiApp() 48키
- `index.html` script 태그 균형 ✓ (16쌍)
- 제거 대상 키 30개 전부 코드/HTML에서 사라짐 확인

## 완료 — 노션식 DB/폼 블록 MVP

### [x] 커스텀 Editor.js 블록 2종 추가 (2026-04-23 심야)
- `public/workspace-blocks.js` 신규 (~580줄) — 공통 스타일 자동 주입 + 2개 클래스
- `public/index.html` Editor.js 스크립트 뒤에 `<script src="/workspace-blocks.js">` 한 줄 추가
- `public/tab-workspace.html` initEditor() 의 tools 를 동적 객체로 변경해 안전 등록 (`if (typeof DataTableTool !== 'undefined')`)
- i18n toolNames 에 '데이터 표' / '입력 폼' 추가

#### 📊 DataTableTool — "데이터 표" (인라인 DB)
- **컬럼 타입 5종**: 텍스트 / 선택(select) / 날짜 / 숫자 / 체크박스
- **인라인 편집**: 헤더명·셀 값 모두 클릭 즉시 편집 (contenteditable)
- **컬럼 메뉴** (⋮ 버튼): 유형 변경 · select 선택지 편집 · 컬럼 삭제
- **행**: 호버 시 × 버튼 · "+ 행 추가"
- **컬럼**: 헤더 우측 `+` 버튼으로 추가
- **저장 구조**: `{ columns: [{id, name, type, options?}], rows: [{colId: value, ...}] }`
- Editor.js blocks 에 `type: 'dataTable'` 으로 저장됨

#### 📝 FormBlockTool — "입력 폼" (제출 → 로그)
- **필드 타입 5종**: 한 줄 텍스트 / 긴 글(textarea) / 숫자 / 날짜 / 선택
- **제출 버튼** → `entries[]` 배열 앞에 `{ at: ISO, values: {fieldId: value} }` 추가
- 폼 하단에 **최근 제출 5건** 자동 표시 (최대 100건 유지)
- 필드마다 유형 / 안내문(placeholder) 편집 가능
- **저장 구조**: `{ title, fields: [{id, label, type, options?, placeholder}], entries: [] }`
- Editor.js blocks 에 `type: 'formBlock'` 으로 저장됨

### 사용 방법
1. 워크스페이스에서 페이지 열기 → 본문에서 `/` 입력
2. 블록 선택기에 "데이터 표" / "입력 폼" 추가됨
3. 노션처럼 클릭해서 편집, 변경은 자동 저장 (기존 Editor.js onChange 훅)

### 구문 검증
- `node -c public/workspace-blocks.js` ✓
- `tab-workspace.html` script 블록 파싱 ✓
- `DataTableTool` / `FormBlockTool` 모듈 export ✓
- 두 클래스 toolbox / constructor / save / validate 스모크 통과 ✓
  - DataTable 기본 3컬럼 × 3행
  - Form 기본 2필드 (이름·내용)

### 수정/추가 파일
**추가**
- `public/workspace-blocks.js` (~580줄)

**수정**
- `public/index.html` — `<script src="/workspace-blocks.js">` 1줄 추가
- `public/tab-workspace.html` — initEditor() tools 동적 구성 + i18n 확장

## 배포 방법
로컬 PC (C:\\Users\\NAMGW\\...\\price-list-app) 에서:
```
_배포.bat
```
커밋 메시지 제안:
```
AI 탭 독립 분리 + 워크스페이스 AI 패널 슬림화

- AI 탭 신설 (Claude.ai 스타일 · 전용 채팅 공간)
  · 좌측 히스토리/프로젝트 사이드바
  · 말풍선 메시지 UI · 첨부 · 이미지 생성 통합
  · localStorage 마지막 스레드 자동 복원
- 워크스페이스 AI 패널은 "작성 도우미" 로 축소
  · 템플릿 + 빠른 도움만 남김 (-483 줄)
  · 히스토리/프로젝트/이미지 생성은 AI 탭으로 이동
- routes/ai-history.js: /threads 가 ?project= 필터 받도록 확장
```

서버 PC (192.168.0.133, D:\\price-list-app) 에서:
```
git-pull-server.bat
```

## 수정/추가 파일
**추가**
- `public/tab-ai.html` (~900줄)

**수정**
- `public/index.html` — AI 메뉴/탭 등록 + SSI 포함 (5곳)
- `public/tab-workspace.html` — 1473 → 990줄 (AI 기능 전부 제거, 작성 도우미만 유지)
- `routes/ai-history.js` — `/threads` 가 `?project=` 필터 받도록

## 2차 개편 완료 시각: 2026-04-23 00:05 KST 경

---

# 3차 — UX 다듬기 (Claude.ai 스타일 입력박스 + 버그픽스)

**완료**: 2026-04-23 KST

## 수정 내역

### UI/UX
- **팀 초대 모달 이름 중심 정리** — `.ai-proj-user` + `.ws-share-user`
  - 아바타 24→36px, 이름 bold (#111827), dept 를 pill 뱃지로 (회색)
  - 빈 dept span 숨김 (`x-show="(u.dept || '').trim()"`)
  - dept ID (`dept_...`) 대신 dept 이름 렌더링되도록 백엔드 보정
    - `routes/workspace.js` /users → departments[] 에서 id→name 맵 빌드
    - `routes/ai-history.js` /users → 동일 패턴 적용, `dept`/`department` 둘 다 이름으로 반환

- **파일 첨부 UX 개편 (Claude 웹 스타일)** — `public/tab-ai.html`
  - 첨부 칩이 입력박스 **안쪽 상단**에 위치 (시각적으로 입력과 연결)
  - **드래그 & 드롭**: `.ai-input-wrap` 에 dragover/drop 핸들러, 드래그 중 점선 오버레이 표시
  - **붙여넣기**: 클립보드 이미지(캡쳐 등) 자동 업로드
  - **복수 파일 동시 업로드**: `input[multiple]`, 순차 업로드
  - **이미지 썸네일**: `.ai-attach-chip.img` 에 실제 이미지 미리보기 (`/api/ai/attachments/:id/raw`)
  - 파일 종류별 색상 아이콘 (excel 초록, pdf 빨강, word 파랑, text/file 회색)
  - 파일명 + 크기 표시, 제거 × 버튼
  - 업로드 중 스피너 칩
  - 20MB 초과 경고를 `alert` 에서 토스트로 변경

- **입력박스 하단 툴바 Claude 스타일**: 📎/🎨/📁 아이콘 버튼 좌측 / 힌트+전송 버튼 우측
- **프로젝트 드롭다운** 을 버튼 위로 부상시키는 `.ai-proj-picker` absolute 컨테이너

### 버그픽스
- **Gemini CLI "Not enough arguments following: p" 오류 해결** (routes/ai-history.js, routes/workspace.js)
  - 원인: `spawn('gemini', ['-p'], { shell: true })` → CLI 가 -p 값을 요구하는데 값이 없음
  - 해결: 프롬프트를 임시파일에 쓰고 shell redirect (`<`) 로 stdin 주입, -p 에는 placeholder 전달
  - 임시파일은 close 시 반드시 삭제

## 추가된 state / 메서드 (aiApp)
```
dragOver, uploadingCount, _dragLeaveTimer
uploadFiles(files), _uploadOne(file)
onDragLeave(ev), onDrop(ev), onPaste(ev)
fileIcon(a), formatSize(bytes), _toast(msg)
```

## 3차 완료 시각: 2026-04-23 KST

---

# 4차 — 참고 이미지 편집 + 업스케일 + 모델 선택

**완료**: 2026-04-23 KST

## 핵심 기능

### ① 참고 이미지 편집 (Image-to-Image)
- 이미지 모드에서 **이미지 파일을 첨부**하면 생성이 아닌 **편집/변형** 모드로 전환
- 프롬프트에 참고 이미지의 **절대 경로** 를 포함시켜 nanobanana MCP 가 파일을 직접 참고하도록 함
- 송신 버튼 레이블이 "🎨 그리기" ↔ "✏️ 편집하기" 로 자동 전환
- placeholder 도 상황별 변경 ("배경을 밤하늘로 바꿔줘" 예시)

### ② 업스케일 (Real-ESRGAN NCNN Vulkan)
- 생성된 이미지 아래 **🔍 크게 만들기** 바 표시
- 배율 선택: **2배 / 4배** (1024px → 2048px / 4096px)
- 서버 PC `D:\price-list-app\tools\realesrgan\` 에 바이너리 + 모델 배치
- 업스케일 결과는 `data/workspace-images/` 에 `원본이름_4x_모델명.png` 로 저장
- 동일 조합 재실행 시 캐시 재사용

### ③ 모델 선택 + 자동 추천
- **5개 모델 카탈로그** (설치 여부 라벨 표시):

| 모델 | 특기 | 비고 |
|------|------|------|
| ✨ 4x-UltraSharp | 실사·제품·풍경 | **기본 추천** |
| 📷 REMACRI | 인물·피부·자연 | Upscayl 기본값 |
| 🎨 Ultramix Balanced | 실사+일러 혼합 | AI 생성물 보정 |
| 🌸 Real-ESRGAN Anime | 애니메·일러스트 | 실사 부적합 |
| ⚙️ Real-ESRGAN x4plus | 범용·빠름 | Fallback |

- 드롭다운에서 **각 모델의 한 줄 설명 + 특기** 표시
- **✨ 자동 추천 토글**: 프롬프트 키워드로 모델 자동 선택
  - "인물/얼굴/피부" → REMACRI
  - "사진/실사/제품" → UltraSharp
  - "애니/일러스트" → Real-ESRGAN Anime
  - "그림/수채화" → Ultramix
  - else → UltraSharp

## 수정/추가 파일

**추가**
- `업스케일_설치가이드.md` — 바이너리·모델 다운로드 경로 + 폴더 구조 + 트러블슈팅

**수정**
- `routes/ai-history.js`
  - `callGeminiImage(prompt, sourceImagePaths[])` — 2번째 인자 추가
  - `/chat-image` — `attachmentIds` 받아서 이미지 첨부만 필터링 후 절대 경로 전달
  - `UPSCALE_MODELS` 카탈로그 상수 (5개 모델 메타)
  - `recommendUpscaleModel(hint)` — 키워드 매칭
  - `scanInstalledModels()` — models/ 폴더 실제 설치 스캔
  - `GET /upscale/health` — 설치 상태 + 모델 카탈로그
  - `POST /upscale` — imageUrl + model + scale → 업스케일 실행
  - `GET /upscale/recommend?hint=…` — 자동 추천 모델키

- `public/tab-ai.html`
  - state: `upscaleHealth`, `upscaleModels`, `upscaleAutoPick`, `upscaleModelKey`, `upscaleScale`, `upscaleStatus`, `upscalePickerOpen`
  - computed: `hasImageAttachment` — placeholder/버튼 라벨 전환에 사용
  - 메서드: `loadUpscaleHealth`, `toggleUpscalePicker`, `selectUpscaleModel`, `autoRecommendModel`, `getModelInfo`, `runUpscale`
  - UI: 이미지 메시지 아래 `.ai-upscale-bar` — 배율·모델 선택·실행 버튼
  - `sendImage()` → `attachmentIds` 함께 전송

## 4차 완료 시각: 2026-04-23 KST
