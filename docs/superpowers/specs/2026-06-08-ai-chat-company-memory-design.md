# ERP AI 챗 — 회사 공유 기억(메모리 학습) 설계

작성일: 2026-06-08
대상: ERP 내부 AI 챗 (`/api/ai/chat-stream-cli` = claude CLI 경로, `/api/ai/agent/*` = 에이전트 경로)

## 1. 목적

ERP AI 챗을 **클로드 코드/웹처럼 "대화를 넘어 기억하고 점점 똑똑해지게"** 만든다.

클로드 코드가 똑똑한 이유는 단순하다 — `MEMORY.md`(자동 기억) + `CLAUDE.md`(규칙)를 매 대화 컨텍스트에 자동 주입하기 때문이다. 지금 ERP 챗에는:

- 같은 대화 안의 직전 메시지(최근 20개, `recentMessages`) — 대화 내 기억 ✓
- **수동으로** 타이핑하는 프로젝트 지식(`openKnowledgeModal` → `proj.knowledge`) ✓
- **대화를 넘어 자동으로 쌓이고 주입되는 기억은 없음** ✗

이 ✗ 를 채운다.

## 2. 확정된 방향 (사용자 결정)

- **기억 범위: 회사 공유 기억 위주.** 회사 업무 도메인(거래처·품목코드·마감규칙·용어)을 전 직원의 챗이 공유한다. 개인별 기억은 `scope` 칸만 열어두고 다음 단계로 미룬다.
- **기억 방식: 자동으로 쌓고, 관리자가 솎아냄.** 대화에서 자동 추출·저장하되, 관리자가 "회사 기억" 화면에서 틀린 것을 지우고 좋은 것을 고정(pin)한다.
- **헤르메스(`lib/hermes-client.js`)는 건드리지 않는다.** 메모리는 백엔드(claude CLI / Hermes / API)와 무관하게 **프롬프트에 주입**되므로, 나중에 헤르메스 서버를 세워도 이 메모리 층이 그대로 적용된다.

## 3. 비목표 (이번 범위 밖)

- 개인별(직원별) 기억 — 구조(`scope='user:<id>'`)만 준비, 구현은 다음 단계
- 헤르메스 서버 구축 / 로컬 모델 전환
- `learning-pool.js`(명세서 자동분류용 정형 마스터)와의 병합 — 목적이 다르므로 분리 유지
- 임베딩 기반 의미검색(RAG) — v1 은 카테고리/키워드/최근/고정 기반. 의미검색은 2차

## 4. 아키텍처 — 구성요소 4개 (각각 한 가지 책임)

### 4.1 기억 저장소 — `lib/chat-memory.js` + SQLite 테이블 `chat_memory`

사실(fact) 단위로 저장. `better-sqlite3` 사용(미설치 시 무해하게 비활성).

```sql
CREATE TABLE IF NOT EXISTS chat_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'company',   -- 'company' | 'user:<userId>'(미래)
  category TEXT,                            -- 거래처 | 품목 | 규칙 | 용어 | 기타
  content TEXT NOT NULL,                    -- 기억할 한 줄 사실
  norm_key TEXT,                            -- 정규화 키(중복 판정용)
  source_thread_id INTEGER,                 -- 어느 대화에서 나왔는지
  source_message_id INTEGER,
  created_by TEXT,                          -- 그 대화의 사용자 사번
  hit_count INTEGER DEFAULT 1,             -- 같은 사실 재등장 횟수(신뢰도 가늠)
  pinned INTEGER DEFAULT 0,                 -- 1이면 항상 주입(관리자 고정)
  status TEXT DEFAULT 'active',             -- active | archived(관리자 삭제 = soft)
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cm_scope_status ON chat_memory(scope, status);
CREATE INDEX IF NOT EXISTS idx_cm_norm ON chat_memory(scope, norm_key);
```

공개 API (단일 책임, 단독 테스트 가능):

- `addMemory({scope, category, content, sourceThreadId, sourceMessageId, createdBy})` → 정규화 후 중복이면 `hit_count++`(+source 갱신), 아니면 신규 insert. 반환: `{id, deduped}`
- `listMemory({scope, category, status, limit})` → 관리 화면용
- `updateMemory(id, patch)` / `archiveMemory(id)` / `setPinned(id, bool)` → 관리자 편집
- `getInjectionContext({scope, prompt, maxChars})` → 주입용 텍스트. 고정(pinned) 먼저 + 프롬프트 키워드 매칭 + 최근/빈도순으로 채우되 `maxChars` 상한. 반환 예:
  ```
  【회사 기억 — 우리 회사 업무 사실(자동 학습)】
  - [규칙] ○○건설은 견적 단가 부가세 별도로 표기한다
  - [거래처] 이노텍과 이노사인은 같은 회사(사업자만 둘)
  - [용어] "솔벤트" = "솔벤" 으로 표기 통일
  ```

`norm_key`: 소문자 + 공백/괄호 제거(기존 `learning-pool` 의 `norm` 패턴 재사용)로 같은 사실 중복 방지.

### 4.2 기억 추출 — 추출 패스

대화 턴(사용자 메시지 + AI 응답)이 끝나면, **회사 차원에서 기억할 사실만** 뽑아 `addMemory`.

- **트리거:** 응답이 정상 종료(`status='ok'`)된 직후, **비차단(async)** 으로 실행 → 챗 응답 속도에 영향 없음.
- **추출기:** 짧고 싼 호출(작은 모델 API 우선; 없으면 claude CLI 짧은 프롬프트). 입력 = 직전 사용자/AI 메시지(+ 필요 시 직전 몇 턴). 프롬프트 요지:
  > "다음 대화에서 **우리 회사 업무에 두고두고 쓸 사실/규칙/용어/거래처 정보**만 골라 JSON 배열로. 일회성 잡담·그때만 맞는 수치·개인 일정은 제외. 없으면 빈 배열."
  출력 스키마: `[{category, content}]`
- **중복/잡음 방지:** `addMemory` 의 `norm_key` 중복 판정 + 최대 길이 제한 + 빈 배열이면 아무것도 안 함.
- **명시 신호 우대:** 사용자가 "이건 기억해둬 / 항상 / 늘 / 원칙" 류를 쓰면 추출 우선순위↑(휴리스틱, 선택적).
- **실패 시:** 조용히 무시. 메모리는 가산적(additive)이라 실패해도 챗은 멀쩡.

> 비용 메모: 매 턴 추출이 부담되면 (a) 디바운스(한 대화에 1회로 묶기) 또는 (b) 명시 신호가 있을 때만 추출로 좁힐 수 있음. v1 은 "정상 응답 후 async 추출 + 디바운스"를 기본으로 한다.

### 4.3 기억 주입 — 기존 컨텍스트 조립에 1블록 추가

`getInjectionContext` 결과를 **챗·에이전트 양쪽** 시스템 컨텍스트에 끼운다.

- **챗(claude CLI):** `routes/ai-history.js` 의 `chat-stream-cli` 핸들러, `fullPrompt = knowledgeBlock + templatePrefix + ... + priorBlock + prompt` (현재 ~2455행) → `memoryBlock` 추가. `knowledgeBlock`(수동 프로젝트 지식) 바로 옆에 둔다.
- **챗(api/Hermes):** 같은 파일 `/chat`, `/chat-stream` 의 system 구성에도 동일 주입 → 백엔드 무관하게 기억 적용.
- **에이전트:** `lib/agent-runtime.js` 의 `buildSystemContext()` 에 회사 기억 블록 추가.
- **크기 제한:** `maxChars`(예 ~6000자) 상한으로 컨텍스트 폭주 방지. 고정(pinned)은 항상, 나머지는 프롬프트 관련/최근/빈도 순.

### 4.4 관리 화면 — "회사 기억" 모달 (관리자)

방금 추가한 "등록된 마감 양식" 모달(`openSkillTemplatesModal`)과 같은 바닐라 JS 패턴 재사용.

- 카테고리별 그룹(거래처/품목/규칙/용어/기타) + 각 항목: 내용 · 출처(대화 링크) · 빈도 · 고정/삭제 버튼
- 동작: 보기 / 수정 / 삭제(soft archive) / 고정(pin) / 수동 추가
- 접근: 관리자 전용(`req.user.role === 'admin'`). 사이드바 버튼 1개 추가.
- API: `GET/POST/PUT/DELETE /api/ai/memory`. **모든 기억 로직은 `lib/chat-memory.js`(제한 없는 lib/)에 격리**하고, 라우트는 이미 `/api/ai` 로 마운트된 `routes/ai-history.js` 에 얇게 얹어 **`server.js` 신규 등록을 피한다**(아래 §10 참고).

## 5. 데이터 흐름

```
[직원 챗 입력] → claude CLI 응답(정상)
       │
       ├─(주입)  getInjectionContext('company', prompt) → 시스템 컨텍스트에 회사 기억 끼움
       │
       └─(추출, async) 직전 턴 → 추출기 → addMemory(중복제거) → chat_memory
                                                   │
[다음 대화 — 누구든] ──(주입)─────────────────────┘  관련 회사 기억이 자동으로 들어가 있음

[관리자] → "회사 기억" 화면에서 보기/수정/삭제/고정  (솎아내기)
```

## 6. 오류 처리 / 안전

- 추출 실패·주입 실패 → 조용히 폴백, 챗 정상 동작(메모리는 "있으면 더 똑똑").
- `better-sqlite3` 미설치 → `chat-memory` 비활성(주입 빈 문자열, 추출 no-op).
- 주입 크기 상한으로 토큰 폭주 방지.
- 관리자 삭제는 soft(`status='archived'`) — 실수 복구 가능, 출처 추적 유지.
- 자동 추출의 오답 위험은 **관리자 정리 화면**으로 흡수(사용자 결정).

## 7. 기존 코드와의 관계

- `learning-pool.js` — 명세서 자동분류용 **정형 마스터**(거래처/품목코드/정규화룰). 숫자 처리용. **이번 챗 기억과 별개**, 병합하지 않음.
- `proj.knowledge`(수동 프로젝트 지식) — 유지. 회사 기억은 그 **자동판**으로, 같은 주입 통로 옆에 나란히 들어감.
- 헤르메스 — 휴면 유지. 메모리는 프롬프트 주입이라 백엔드 무관 적용.

## 8. v1 완료 기준

1. 대화에서 회사 사실이 자동으로 `chat_memory` 에 쌓인다(중복 제거).
2. 다음 대화(다른 직원 포함)에 관련 회사 기억이 자동 주입돼 AI가 "기억"한다.
3. 관리자가 "회사 기억" 화면에서 보기/수정/삭제/고정할 수 있다.
4. 챗·에이전트 양쪽에서 동작한다.
5. 메모리 계층이 실패해도 기존 챗은 그대로 동작한다.

## 9. 향후(2차 이후)

- 개인별 기억(`scope='user:<id>'`) — 구조는 준비됨
- 의미검색(임베딩) 기반 관련 기억 선별
- 헤르메스 세션 메모리와의 연동(서버 구축 시)
- `learning-pool` 마스터를 챗 기억이 참조/표면화

## 10. 파일 수정 주의 (`.claude/CLAUDE.md`)

프로젝트 안전 규칙에 "`server.js` 및 `routes/` 폴더 수정 자제"가 있다. 이 기능은 본질적으로 AI 챗(=`routes/ai-history.js`, `lib/agent-runtime.js`)을 건드려야 하므로:

- **신규 로직은 전부 `lib/chat-memory.js`(제한 없는 lib/)에 격리** → 건드리는 시스템 파일 최소화.
- 주입(4.3)·라우트(4.4)는 **이미 마운트된 `routes/ai-history.js` 에만** 얹어 `server.js` 신규 등록을 피한다.
- 그래도 `routes/ai-history.js`·`agent-runtime.js` 편집은 불가피 → 구현 전 사용자에게 한 번 더 확인하고, 커밋만(로컬), 배포는 사용자 지시 시.

## 11. 미해결/플랜에서 정할 것

- 추출기 모델: 작은 API 모델(`lib/openai-client.js`) vs 짧은 claude CLI — 비용/속도 보고 플랜에서 확정.
- 추출 트리거 세부: "정상 응답 후 async + 대화당 1회 디바운스" 가 기본. 명시신호(기억해둬) 우대는 선택.
- 주입 선별 기본 점수식(고정 → 키워드매칭 → 빈도 → 최근) 가중치.
