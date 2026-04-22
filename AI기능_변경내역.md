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
