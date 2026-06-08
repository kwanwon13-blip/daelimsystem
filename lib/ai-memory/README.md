# AI 메모리 모듈 (`lib/ai-memory`)

`pewdiepie-archdaemon/odysseus`의 메모리 시스템을 **이 ERP(Node.js/Express + better-sqlite3)** 용으로 포팅한 것.
odysseus의 검증된 알고리즘은 그대로 가져오되, 한국어/회사공유/단일저장소에 맞게 고치고 odysseus의 알려진 버그는 처음부터 제거했다.

> 이 폴더는 **신규 모듈**이며 `server.js`/`routes/`/`db.js` 등 기존 파일을 건드리지 않는다. 연결(3곳)은 아래 스니펫을 직접 적용.

## 파일 구성

| 파일 | 역할 | odysseus 원본 |
|------|------|----------------|
| `store.js` | `ai_memories` 테이블 CRUD, scope 가시성/쓰기권한 게이트 | `src/memory.py` + `memory_provider.py` + `routes/memory_routes.py` |
| `tokenizer.js` | **한국어 토크나이저**(조사제거 어간 + 음절 bigram) | `chat_processor.py:_content_tokens` (영문전용 → 교체) |
| `recall.js` | 하이브리드 랭킹(BM25 + 벡터 + recency 5%) + preface 생성 | `chat_processor.py:_hybrid_retrieve` / `build_context_preface` |
| `untrusted.js` | 신뢰경계 가드블록(프롬프트 인젝션 방어) | `src/prompt_security.py` |
| `extractor.js` | 자동추출 + 한국어 정규식 fallback + 3단 중복제거 + 감사(50% 삭제거부) | `services/memory/memory_extractor.py` |
| `index.js` | 조립 파사드 `createAiMemory({db, llm, embedder})` | `app_initializer` 배선 |

## 연결 (직접 적용할 3곳)

### ① 초기화 (서버 부팅 시 1회)
```js
const Database = require('better-sqlite3');
const { createAiMemory } = require('./lib/ai-memory');

// 기존 업무데이터.db 핸들을 재사용하는 게 가장 깔끔.
// db-sqlite.js 끝에 `module.exports.db = db;` 한 줄을 더하면 require로 가져올 수 있다.
const db = require('./db-sqlite').db || new Database(path.join(__dirname,'data','업무데이터.db'));

const aiMem = createAiMemory({
  db,
  llm: claudeAdapter,   // 아래 ③ 어댑터
  embedder: null,       // MVP는 키워드-only. 나중에 임베딩 함수 주입하면 자동으로 벡터 경로 활성.
});
```

### ② 채팅 요청 흐름
```js
// actor: 로그인 사용자 → { user:사번, dept:부서명, isAdmin, isTeamLead }
const actor = { user: req.session.user.사번, dept: req.session.user.부서, isAdmin: req.session.user.role==='admin', isTeamLead: !!req.session.user.팀장 };

// (a) 메모리 preface 생성 → LLM messages 앞에 끼움
const { messages: memMsgs, usedIds } = await aiMem.buildPreface(actor, userMessage, { k: 3 });
const llmMessages = [...memMsgs, ...sessionHistory, { role:'user', content:userMessage }];
// → 이 llmMessages로 평소 LLM 호출. memMsgs[0]은 system(UNTRUSTED 정책), 나머지는 신뢰경계 user 블록.

// (b) 응답 끝난 뒤: 백그라운드 추출 (await 하지 말 것 — 응답 경로를 막지 않게)
aiMem.afterTurn(actor, [...recentTurns, { role:'assistant', content: answer }], {
  sessionId, defaultScope: 'personal',   // 자동추출은 개인 scope. 회사공유 승격은 사람이 검토 후.
}).catch(()=>{});
```

### ③ LLM 어댑터 (회원님 Claude CLI 연결)
`extractor`/`audit`만 LLM이 필요하다. 계약: `llm(messages, {temperature, maxTokens}) => Promise<string>`.
```js
// 기존 ai-chat-cli-mode(Claude CLI 스폰)를 단발 호출로 감싸기:
async function claudeAdapter(messages, { temperature = 0.1, maxTokens = 500 } = {}) {
  // messages: [{role, content}, ...]  →  CLI 1회 호출 후 모델의 '텍스트 1개'를 반환
  // (스트리밍 불필요. JSON만 받으면 됨)
  return await callClaudeCliOnce(messages, { temperature, maxTokens });
}
```

### ④ (선택) 관리 라우트 — 새 파일 `routes/ai-memory.js`로 추가 권장
```js
module.exports = function setupAiMemoryRoutes(aiMem, requireLogin) {
  const router = require('express').Router();
  const actorOf = (req)=>({ user:req.session.user.사번, dept:req.session.user.부서,
                            isAdmin:req.session.user.role==='admin', isTeamLead:!!req.session.user.팀장 });

  router.get('/api/ai-memory', requireLogin, (req,res)=> res.json({ memory: aiMem.store.visibleTo(actorOf(req)) }));

  router.post('/api/ai-memory', requireLogin, (req,res)=>{
    const { text, category='fact', scope='personal' } = req.body;
    const a = actorOf(req);
    if (aiMem.store.findExact(a, text)) return res.json({ ok:true, message:'이미 있음' });
    const owner = scope==='personal' ? a.user : null;
    // 회사/팀 scope 쓰기는 권한 확인 후 (canWrite 정책)
    res.json({ ok:true, memory: aiMem.store.add({ text, category, scope, owner, source:'user' }) });
  });

  router.delete('/api/ai-memory/:id', requireLogin, (req,res)=>{
    const r = aiMem.store.remove(actorOf(req), req.params.id);
    if (!r.ok) return res.status(404).json({ error:'not found' });   // 권한없음=404(누출 방지)
    res.json({ ok:true });
  });

  router.post('/api/ai-memory/:id/pin', requireLogin, (req,res)=>{
    const r = aiMem.store.setPinned(actorOf(req), req.params.id, !!req.body.pinned);
    if (!r.ok) return res.status(404).json({ error:'not found' });
    res.json(r);
  });

  router.post('/api/ai-memory/audit', requireLogin, async (req,res)=>{
    res.json(await aiMem.audit(actorOf(req), req.body.scopeKey || ('personal:'+req.session.user.사번)));
  });
  return router;
};
// server.js: app.use(setupAiMemoryRoutes(aiMem, requireLogin));
```

## scope 모델

| scope 값 | 의미 | 가시성 | 쓰기 권한(기본) |
|----------|------|--------|------------------|
| `personal` (+owner=사번) | 개인 메모리 | 본인만 | 본인 |
| `team:<부서명>` | 팀 공유 | 같은 부서 | 팀장/admin |
| `company` | 회사 공통 규칙 | 전원 | admin |

조회 보안 경계는 `store.visibleTo(actor)` **한 곳**에서만 적용된다. recall/extract는 이 결과만 보므로
키워드든 벡터든 자동으로 테넌트 격리된다. (쓰기 권한은 `store.canWrite` 정책으로 주입 교체 가능.)

## recall 랭킹 (odysseus 동일 공식)

- 벡터 O: `0.55·코사인 + 0.40·키워드 + 0.05·recency`
- 벡터 X(초기): `0.95·키워드 + 0.05·recency`
- **recency 최대 5%** — "최신이지만 무관"이 "오래됐지만 관련"을 못 이김.
- 카테고리 부스트(단가/거래처/연락처/이름/규칙/선호) + **정확 코드·문구 일치 시 바닥 0.8**.
- pinned는 항상 주입, extended는 top-k(기본 3)만.

## 벡터(임베딩) 나중에 켜기

`embedder(text)=>Promise<float[]>` 를 `createAiMemory`에 주입하면 끝.
임베딩은 **같은 행(`ai_memories.embedding`)** 에 저장되고 recall은 scope 필터된 후보만 코사인 비교 →
odysseus가 겪은 **벡터 cross-tenant 누수가 구조적으로 불가능**. 별도 벡터DB 인프라 불필요(ERP 규모는 브루트포스로 충분).
기존 행 백필: `for (const m of store.visibleTo(admin)) store.setEmbedding(m.id, await embedder(m.text));`

## odysseus 대비 고친 점 (반면교사 반영)

1. **한국어 토크나이저** — 원본은 `[a-z0-9]+`라 한글 토큰 0개 → recall 붕괴. bigram+조사제거로 교체.
2. **단일 진실원천** — JSON+벡터DB 이원화 제거(드리프트/ fsync 문제 소멸). SQLite WAL 하나로.
3. **벡터에 scope 내장** — 별도 무소유 컬렉션이 아니라 같은 행 → 누수 원천 차단.
4. **scope 명시 sentinel** — null=공유/미할당 모호성 제거(`personal|team:|company`).
5. **권한없음 404** — 존재 은폐(견적/단가 경쟁정보 보호).
6. **쓰기는 코드 게이트** — 프롬프트 숨김이 아니라 `canWrite`로 실제 차단(인젝션 우회 방지).

## 빠른 자가 테스트
```js
const { createAiMemory } = require('./lib/ai-memory');
const aiMem = createAiMemory({ dbPath: ':memory:' });  // llm 없이 키워드 경로만
const a = { user:'1001', dept:'영업부', isAdmin:false, isTeamLead:false };
aiMem.store.add({ text:'대림에스엠 현수막 단가는 3500원.', category:'단가', scope:'personal', owner:'1001' });
aiMem.store.add({ text:'회사 결제는 말일 마감.', category:'규칙', scope:'company' });
console.log(aiMem.recall.hybridRetrieve('현수막 단가 얼마야', aiMem.store.visibleTo(a), { k:3 }));
// → 현수막 단가 메모리가 상위로 떠야 정상
```
