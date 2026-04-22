# 워크스페이스 AI 기록 & 프로젝트 — 설계 문서

**작성일**: 2026-04-22
**작성자**: Claude (남관원 님과 브레인스토밍)
**대상 기능**: 워크스페이스의 AI 상호작용(Claude 텍스트 + Gemini 이미지)을 영구 저장·그룹화·재사용·팀 공유할 수 있는 기반 시스템
**범위**: Level 0 (MVP) — 이후 Level 1 (프롬프트 템플릿), Level 2 (실행 가능한 스킬)로 확장 예정

---

## 1. 배경과 문제

현재 워크스페이스의 AI 기능은 전부 **휘발성**이다.

| 기능 | 질문(프롬프트) 저장 | 답변 저장 |
|------|--------------------|----------|
| 빠른 도움(정리/요약/번역) | ❌ 없음 | ❌ 패널 닫으면 사라짐 |
| AI 템플릿(업무일지 등) | ❌ 없음 | ✅ 페이지 블록으로만 남음 |
| Gemini 이미지 | 🔸 이미지 캡션 100자만 | ✅ 파일 + 블록 |
| 자유 채팅 | ❌ 없음 | ❌ 덮어써짐 |

**결과**: 좋은 프롬프트를 재사용 못 함, 답변을 다시 못 찾음, 팀원에게 공유 못 함, 감사 추적 불가능.

## 2. 전체 목표와 3단계 로드맵

**최종 목표**: 직원이 AI 와 협업해서 만든 "결과물 + 과정 + 재사용 가능한 양식 + 자동화 스크립트" 가 누적되고 공유되는 **회사 내부 AI 지식베이스**.

| 단계 | 내용 | 완료 기간 추정 |
|------|------|---------------|
| **Level 0** (본 설계 범위) | AI 기록 자동 저장 + 프로젝트(폴더) 그룹화 + 공유 + 검색 + 재사용 | 2~3주 |
| Level 0.5 (옵션) | 프로젝트 내 대화 이어가기 (이전 Q&A 를 문맥으로 전달) | +1주 |
| Level 1 | 프롬프트 템플릿 저장 + 파일 업로드 → AI 실행 | +2~3주 |
| Level 2 (장기) | AI 생성 스크립트 저장·실행·편집, 샌드박스 | 별도 설계 |

본 문서는 **Level 0 에 한정**한다.

## 3. Level 0 범위 (포함/제외)

**포함 (MVP)**

- 모든 AI 호출(Claude 텍스트, Gemini 이미지, 템플릿, 빠른 도움)의 질문/답변 자동 저장
- 왼쪽 사이드바에 `✦ AI 기록` 섹션 추가 (`내 페이지` / `팀 공유` 와 동급)
- "프로젝트" (폴더) 개념: 사용자가 생성, 이모지+이름, 기록을 드래그로 이동
- 페이지에서 질문 시 해당 페이지 전용 프로젝트에 자동 분류
- AI 패널(페이지 내 ✦ 패널)에 "최근 5개" 미니 히스토리 탭
- 상세 뷰에서 "페이지에 삽입", "복제해서 다시 질문", "공유", "프로젝트 이동", "삭제"
- 질문 텍스트 / 답변 텍스트 / 프로젝트 / 타입 / 날짜 범위 검색·필터
- 공유 3모드: `나만 보기` / `특정 직원` / `전체 공유` (페이지 공유 UX 재사용)
- 실패한 호출도 기록 (에러 메시지 포함, 재시도 참고용)

**제외 (Level 0 에서 안 함)**

- 대화 이어가기 (문맥 전달) — Level 0.5
- 외부 비밀 링크 공유 — AI 기록은 내부 지식이므로 굳이 불필요
- 태그 — 프로젝트 + 전문 검색으로 충분. 필요해지면 Level 0.5 에서 검토
- 프롬프트 템플릿 라이브러리 — Level 1
- 파일 업로드 + AI 처리 — Level 1
- 코드 생성·실행 — Level 2
- 모바일 최적화 — 기본 반응형만 적용, 전용 UX 는 나중

## 4. 데이터 모델

기존 `업무데이터.db` (SQLite) 에 테이블 2개 추가. 기존 하이브리드 패턴 유지 (SQLite 우선 + JSON 폴백은 `ai_*.json` 으로).

### 4.1 `ai_projects` (프로젝트 = 폴더)

```sql
CREATE TABLE ai_projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    TEXT    NOT NULL,             -- 소유자 userId
  name        TEXT    NOT NULL,             -- 프로젝트명
  emoji       TEXT    DEFAULT '📁',
  description TEXT,                          -- 선택적 설명
  linked_page_id INTEGER,                   -- 페이지 전용 프로젝트면 page ID (workspace_pages.id 참조, FK 없이 soft)
  share_mode  TEXT    DEFAULT 'private',     -- 'private' | 'specific' | 'all'
  shared_with TEXT    DEFAULT '[]',          -- JSON array of userIds
  pinned      INTEGER DEFAULT 0,
  created_at  TEXT    DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_ai_projects_owner ON ai_projects(owner_id, updated_at DESC);
CREATE INDEX idx_ai_projects_linked_page ON ai_projects(linked_page_id);
```

### 4.2 `ai_entries` (질문/답변 1건)

```sql
CREATE TABLE ai_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id       TEXT    NOT NULL,
  project_id     INTEGER,                           -- NULL = "(미분류)"
  type           TEXT    NOT NULL,                  -- 'chat' | 'template' | 'image' | 'quick_help'
  prompt         TEXT    NOT NULL,
  response       TEXT,                              -- Claude 텍스트 답변
  image_url      TEXT,                              -- 이미지 생성 결과 경로
  metadata       TEXT    DEFAULT '{}',              -- JSON: { template_mode, blocks_count, ... }
  source_page_id INTEGER,                           -- 어느 페이지에서 호출했는지 (NULL = 사이드바)
  share_mode     TEXT    DEFAULT 'inherit',         -- 'private' | 'specific' | 'all' | 'inherit'
                                                    -- inherit = 프로젝트 설정 따름
  shared_with    TEXT    DEFAULT '[]',
  status         TEXT    NOT NULL,                  -- 'success' | 'error'
  error          TEXT,                              -- 실패 시 에러 메시지
  duration_ms    INTEGER,                           -- 호출 소요시간
  created_at     TEXT    DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_ai_entries_owner_created ON ai_entries(owner_id, created_at DESC);
CREATE INDEX idx_ai_entries_project ON ai_entries(project_id, created_at DESC);
CREATE INDEX idx_ai_entries_page ON ai_entries(source_page_id);
```

**공유 상속 규칙**
- 기록의 `share_mode = 'inherit'` 이면 조회 시 프로젝트의 `share_mode` 를 따름
- 특정 기록만 별도로 공유하거나 비공개화하려면 해당 기록의 `share_mode` 를 직접 설정

**미분류 처리**
- 별도 레코드 없이 `project_id IS NULL` 로만 표현
- UI 에서는 가상의 "(미분류)" 프로젝트로 렌더링
- 사용자가 만든 첫 프로젝트로 이동 시 `project_id` 업데이트

**페이지-프로젝트 자동 연결 규칙**
- 페이지 AI 패널에서 질문 시:
  1. 해당 페이지와 연결된 프로젝트(`linked_page_id = page.id`) 있는지 확인
  2. 없으면 자동 생성: 이름=페이지 제목, 이모지=페이지 이모지
  3. 생성된/기존 프로젝트에 기록 추가
- 페이지 삭제 시: 프로젝트는 남기고 `linked_page_id` 만 NULL 처리 (기록은 보존)

## 5. API 엔드포인트

기존 `/api/workspace/ai` 와 `/api/workspace/ai-image` 는 **그대로 유지**하되, 내부에서 자동으로 ai_entries 에 저장하도록 수정.

```
# 프로젝트
GET    /api/workspace/ai/projects                   내 프로젝트 + 팀 공유 프로젝트
POST   /api/workspace/ai/projects                   생성 { name, emoji, description? }
PUT    /api/workspace/ai/projects/:id               수정 (이름, 이모지, 설명, 공유 설정, pinned)
DELETE /api/workspace/ai/projects/:id               삭제 (기록은 미분류로 이동)

# 기록
GET    /api/workspace/ai/entries                    쿼리: ?projectId=&q=&type=&from=&to=&limit=&offset=
GET    /api/workspace/ai/entries/recent             내 최근 5개 (AI 패널용)
GET    /api/workspace/ai/entries/:id                상세
PUT    /api/workspace/ai/entries/:id                프로젝트 이동 or 공유 변경
DELETE /api/workspace/ai/entries/:id

# 기존 AI 엔드포인트 (내부에 저장 훅 추가)
POST   /api/workspace/ai                            기존과 동일 + ai_entries INSERT
POST   /api/workspace/ai-image                      기존과 동일 + ai_entries INSERT
```

**권한 검사**
- 모든 엔드포인트는 `requireAuth` 미들웨어 적용
- 프로젝트/기록 조회: 소유자 본인 OR 공유받은 사람 OR admin
- 수정/삭제: 소유자 본인만 (admin 예외 없음 — 타인 기록을 관리자가 건드리면 신뢰 깨짐)

## 6. UI 구조

### 6.1 사이드바 (왼쪽)

```
워크스페이스 [+]
🔍 페이지 검색...

내 페이지
  📄 거래명세서 정리
  📝 4월 업무일지

팀 공유
  📋 현장 점검 보고

✦ AI 기록                    [+]     ← 새 프로젝트
  📁 현대리바트 현장  (12)
  📁 영업 응대      (5)
  📁 (미분류)       (23)
  📤 팀 공유       (3)              ← 내게 공유된 것 묶음
```

- `AI 기록` 섹션 클릭 시 본문 영역이 **AI 기록 뷰** 로 전환 (현재 페이지는 유지되나 화면에서 벗어남 — Alpine `currentView` 로 관리)
- 각 프로젝트 우클릭(또는 `⋯` 메뉴): 이름 변경, 공유, 삭제, 고정
- `(+)` 버튼: 새 프로젝트 생성 모달

### 6.2 AI 기록 뷰 (본문 영역)

```
┌─ 상단 툴바 ───────────────────────────────┐
│ [프로젝트명] ▼    🔍 검색    [Claude][이미지] │
│ [공유] [설정]                              │
├────────────────────────────────────────┤
│ 오늘                                      │
│  🗨 "이 부분 요약"  — "핵심은..."  ·2시간 전 │
│  🎨 "검정 간판 시안" [썸네일]      ·3시간 전 │
│ 어제                                      │
│  📝 "일일 업무일지"  — "공장 작업..." ·15시간전│
└────────────────────────────────────────┘
```

- 무한 스크롤 (페이지당 50개)
- 각 행 클릭 → 오른쪽에서 상세 패널 슬라이드

### 6.3 상세 패널 (오른쪽 슬라이드)

```
┌─ [X] 상세 보기 ──────────────────────────┐
│ 🗨 Claude — 2026-04-22 14:32 ·2초         │
│                                           │
│ 【질문】                                  │
│ 이 견적서를 정리해줘...                    │
│                                           │
│ 【답변】                                  │
│ 정리된 내용입니다...                       │
│                                           │
│ 프로젝트: 📁 영업 응대 [변경]              │
│ 공유: 🔒 나만 [변경]                      │
│ 출처: 📄 4월 업무일지 [열기]               │
│                                           │
│ [페이지에 삽입] [복제해 다시 질문] [삭제]  │
└──────────────────────────────────────┘
```

- **페이지에 삽입**: 현재 열려있는 워크스페이스 페이지가 있으면 그 페이지의 커서 위치에 답변/이미지 블록 추가. 없으면 "페이지를 먼저 여세요" 토스트
- **복제해 다시 질문**: 프롬프트를 AI 패널 입력창에 복사 → 사용자가 수정 후 재전송 → 새 기록 생성
- **프로젝트 이동**: 드롭다운으로 다른 프로젝트 선택 or 새 프로젝트 생성

### 6.4 AI 패널 "최근" 탭 (페이지 내 ✦ 패널)

```
[ AI 템플릿 ] [ 빠른 도움 ] [ 🕘 최근 ]   ← 탭 추가
────────────────────────────────────
최근 5개:
  🗨 "이거 요약해줘"         ·5분 전
  🎨 "밝은 사무실 사진"      ·10분 전
  🗨 "영어로 번역"           ·15분 전
  📝 "일일 업무일지"         ·1시간 전
  🗨 "이 부분 다시 써줘"     ·2시간 전
[전체 기록 보기 →]
```

- 각 행 클릭: 프롬프트 복사 (아래 입력창으로) — 빠른 재사용
- 행 우측 `⋯`: 페이지에 삽입 / 상세 보기

### 6.5 공유 모달

**페이지 공유 모달 UX 재사용**. 다른 점:
- "🔗 비밀 링크" 섹션 제거 (Level 0 에서는 제외)
- 프로젝트 공유 시: "이 프로젝트의 모든 기록이 공유됩니다" 안내
- 개별 기록 공유 시: "이 기록 하나만 공유" vs "프로젝트 설정을 따름(inherit)"

### 6.6 토스트 알림 (공통 개선)

AI 호출 결과 피드백이 없던 문제 해결. 우측 하단 토스트:
- "✦ AI 답변이 페이지에 추가됐어요"
- "🎨 이미지 생성 완료 — 페이지 끝에 삽입했어요"  
- "📝 업무일지 블록 5개 추가됨"
- 실패: "⚠️ AI 호출 실패 — AI 기록에서 재시도 가능"

토스트는 워크스페이스 공통 컴포넌트로 만들어 다른 기능에서도 재사용.

## 7. 플로우 다이어그램 (텍스트)

### 7.1 페이지에서 Claude 질문

```
[사용자] 페이지 AI 패널에서 "이거 요약해줘" 입력
    ↓
[프론트] POST /api/workspace/ai  { prompt, source_page_id, mode }
    ↓
[서버] 
  1. requireAuth
  2. Claude CLI 실행
  3. 페이지의 linked 프로젝트 조회 or 생성 (linked_page_id = source_page_id)
  4. ai_entries INSERT { owner, project_id, type, prompt, response, source_page_id, status }
  5. 응답 { id, response }
    ↓
[프론트]
  - 답변을 페이지 블록으로 삽입
  - 토스트: "✦ 답변 추가됨 — AI 기록에도 저장됨"
  - AI 패널 "최근" 탭에 반영
```

### 7.2 사이드바에서 새 질문

```
[사용자] 사이드바 "AI 기록" → "(미분류)" 열고 상단 입력창에 질문
    ↓
[프론트] POST /api/workspace/ai  { prompt, project_id, mode }   (source_page_id = null)
    ↓
[서버] 동일. project_id 가 전달되면 그 프로젝트에 저장, 없으면 NULL
    ↓
[프론트] 답변을 상세 패널에 표시. 페이지 블록 삽입 안 함 (요청자가 필요 시 "페이지에 삽입" 누름)
```

### 7.3 공유된 기록 조회

```
[사용자 B] 사이드바 "📤 팀 공유" 클릭
    ↓
[프론트] GET /api/workspace/ai/entries?shared=team
    ↓
[서버]
  - 내 소유 아님
  - 프로젝트 또는 기록의 share_mode = 'all' OR
    share_mode = 'specific' AND shared_with 에 내 userId 포함
  - 필터링된 결과 반환
```

## 8. 에러 처리

| 시나리오 | 처리 |
|---------|------|
| Claude CLI 실패 | `ai_entries.status='error', error='메시지'` 로 저장, 상세 패널에서 재시도 버튼 |
| Gemini 이미지 실패 | 마찬가지, `image_url=null`. 재시도 가능 |
| 네트워크 단절 | 프론트에서 로컬 큐에 임시 저장 → 재연결 시 배치 업로드 (Level 0.5 에서 검토, MVP 는 즉시 에러 토스트만) |
| 공유 권한 부족 | 403 응답, 토스트 |
| 프로젝트 삭제 시 기록 처리 | 기본: 기록은 `(미분류)` 로 이동. 옵션: "기록도 함께 삭제" 체크박스 |
| 페이지 삭제 | 연결된 프로젝트의 `linked_page_id = NULL`. 프로젝트 이름은 그대로 남김 (사용자가 수동 변경/삭제) |

## 9. 테스트 계획

- **DB 마이그레이션**: 기존 데이터 영향 없음 확인 (테이블 2개 추가만)
- **폴백 테스트**: SQLite 미설치 환경에서 JSON 폴백 동작 (기존 패턴 준수)
- **권한 테스트**:
  - A의 private 기록을 B가 조회 시 403
  - A가 B에게 specific 공유 시 B 조회 가능, C 불가
  - admin 은 타인 기록 조회는 가능 but 수정/삭제 불가 확인
- **페이지 자동연결 테스트**:
  - 페이지에서 첫 질문 → 프로젝트 자동 생성
  - 같은 페이지에서 두 번째 질문 → 기존 프로젝트에 추가
  - 페이지 삭제 후 프로젝트 조회 → 남아있음, linked_page_id=NULL
- **기존 AI 기능 회귀 테스트**:
  - 템플릿, 빠른 도움, 이미지 생성이 기존과 동일하게 동작하면서 기록만 추가되는지
- **성능**: 기록 1만 건 상태에서 검색/필터 응답 시간 < 500ms

## 10. 마이그레이션 / 배포

- **DB 스키마 추가는 idempotent**: `CREATE TABLE IF NOT EXISTS`
- 기존 서버 재시작만으로 활성화 (별도 마이그레이션 스크립트 불필요)
- 롤백: 새 테이블 두 개 DROP 만 하면 기존 기능 영향 없음
- 2-PC 배포: 로컬에서 코드 수정 → GitHub push → 서버 PC `git-pull-server.bat` (CLAUDE.md 명시 플로우 준수)

## 11. 구현 순서 (PR 쪼개기)

| # | 내용 | 예상 |
|---|------|-----|
| PR-1 | DB 스키마 (`ai_projects`, `ai_entries` 테이블) + migrate 스크립트 + JSON 폴백 스토어 | 1일 |
| PR-2 | 백엔드: 프로젝트 CRUD, 기록 CRUD, 권한 체크 | 2일 |
| PR-3 | 백엔드: 기존 AI 엔드포인트에 저장 훅 추가 + 페이지 자동연결 로직 | 1일 |
| PR-4 | 프론트: 사이드바 "AI 기록" 섹션 + 프로젝트 목록 + 생성/이름변경 | 2일 |
| PR-5 | 프론트: AI 기록 뷰 (목록 + 검색 + 필터 + 상세 패널) | 2일 |
| PR-6 | 프론트: 상세 패널 액션 (페이지에 삽입, 복제 재질문, 프로젝트 이동, 삭제) | 1~2일 |
| PR-7 | 프론트: AI 패널 "최근" 탭 | 1일 |
| PR-8 | 프론트: 공유 모달 (페이지 공유 UX 재사용) | 1~2일 |
| PR-9 | 공통 토스트 컴포넌트 + 기존 AI 동작에 토스트 적용 | 1일 |
| PR-10 | 통합 QA + 성능 스팟 테스트 + 문서 업데이트 | 1일 |

**총: 약 13~15일**. 매 PR 마다 독립 배포 가능. 중간에 실제 사용해보면서 우선순위 조정 가능.

## 12. 열린 질문 / 후속 검토

- **Level 0.5 로 언제 넘어갈지**: 프로젝트 내 대화 이어가기(문맥 전달). 실제로 써보면서 "맥락 없어서 답답하다" 는 피드백 나오면 착수.
- **전문 검색 엔진 필요 여부**: 기록이 수만 건이 되면 SQLite LIKE 만으로는 느림. FTS5 확장 적용 검토 (SQLite 내장).
- **기록 삭제 정책**: 현재 설계는 "무제한 보관". 1년 지난 기록 아카이브 기능 필요한지 장기 관찰.
- **AI 호출 비용 가시화**: metadata 에 tokens/cost 저장해두면 월별 사용량 리포트 가능. MVP 에서는 스펙에 포함하되 UI 에는 노출 안 함.

---

**승인이 필요한 부분**:
1. 본 설계대로 Level 0 진행
2. Level 0.5 (대화 이어가기) 는 실제 사용 후 재검토
3. Level 1 (템플릿 + 파일 업로드) 는 Level 0 완성 후 별도 브레인스토밍

사장님(남관원 님)이 본 문서 훑어보신 뒤 수정/추가 의견 주시면 반영하고, 이상 없으면 **writing-plans** 단계로 넘어가 실제 구현 계획을 씁니다.
