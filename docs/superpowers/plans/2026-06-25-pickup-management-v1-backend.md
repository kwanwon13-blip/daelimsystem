# 픽업관리 v1 — 백엔드 구현 플랜 (A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 픽업 요청을 SQLite에 저장하고 날짜별 취합·품목 라인체크·카톡파싱·공유텍스트를 제공하는 `/api/pickup` 백엔드를 만든다. (UI는 별도 플랜 B)

**Architecture:** 순수 로직(`lib/pickup-logic.js`)은 TDD로, DB는 기존 `db-sqlite.js` 패턴(테이블 + CRUD 객체)에, 라우트는 기존 `routes/vendors.js` 패턴(`requireAuth` → `db.sql?SQLite:JSON폴백` → `safeBody` → `auditLog`)에 그대로 맞춘다. 픽업 데이터는 워크플로와 무관한 독립 SQLite 테이블.

**Tech Stack:** Node.js, Express, better-sqlite3(설치됨 v12.8), `node:assert`(테스트), 기존 미들웨어(auth/audit/sanitize), `utils/notify.js`.

**참조 스펙:** `docs/superpowers/specs/2026-06-25-pickup-management-design.md` (§4 데이터모델, §5 상태, §6 API, §8 파싱, §9 권한, §10 알림)

---

## 파일 구조

| 파일 | 책임 | 신규/수정 |
|------|------|-----------|
| `lib/pickup-logic.js` | 순수 함수: 상태 롤업·마감판정·카톡파싱·공유텍스트·업체그룹 | 신규 |
| `tests/pickup-logic.test.js` | 위 순수함수 단위테스트 | 신규 |
| `db-sqlite.js` | vendors ALTER 7컬럼 + pickup_* 테이블 + pickup CRUD 객체 + export | 수정 |
| `routes/pickup.js` | `/api/pickup` 라우트 (권한게이트 포함) | 신규 |
| `routes/vendors.js` | POST/PUT에 신규 vendor 필드 7개 화이트리스트 추가 | 수정 |
| `server.js` | `app.use('/api/pickup', ...)` 마운트 | 수정 |
| `data/설정.json` | `pickup.cutoffTime` 기본값 (런타임에 읽음, 파일 직접수정 불필요) | — |

**상태/우선순위 코드 규약(전 파일 공통):**
- item.status: `requested` | `pickedUp` | `notPicked` | `cancelled`
- request.status(롤업): `requested` | `inCourse` | `completed` | `partial` | `notPicked` | `cancelled`
- priority: `normal` | `urgent` | `todayMust`
- sourceType: `manual` | `workflow` (eCount는 2차)

---

## Task 1: 순수 로직 `lib/pickup-logic.js` (TDD)

**Files:**
- Create: `lib/pickup-logic.js`
- Test: `tests/pickup-logic.test.js`

순수 함수 5개: `computeRequestStatus`, `computeIsLate`, `parseKakaoPickup`, `buildShareText`, `groupByVendor`. DB·날짜·랜덤 의존 없음(전부 인자로 주입) → 결정적 테스트.

- [ ] **Step 1: 실패하는 테스트 작성** — `tests/pickup-logic.test.js`

```javascript
const assert = require('node:assert');
const L = require('../lib/pickup-logic');

// ── computeRequestStatus: 롤업 ──
assert.strictEqual(L.computeRequestStatus([]), 'requested');
assert.strictEqual(L.computeRequestStatus([], { courseConfirmed: true }), 'inCourse');
assert.strictEqual(L.computeRequestStatus([{ status: 'cancelled' }, { status: 'cancelled' }]), 'cancelled');
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'pickedUp' }]), 'completed');
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'cancelled' }]), 'completed'); // 취소 제외 전부 수거
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'notPicked' }]), 'partial');
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'requested' }]), 'partial');
assert.strictEqual(L.computeRequestStatus([{ status: 'notPicked' }, { status: 'notPicked' }]), 'notPicked');
assert.strictEqual(L.computeRequestStatus([{ status: 'requested' }, { status: 'requested' }]), 'requested');
assert.strictEqual(L.computeRequestStatus([{ status: 'requested' }], { courseConfirmed: true }), 'inCourse');

// ── computeIsLate: 같은날 + 마감 이후만 late ──
const at0930 = new Date(2026, 5, 25, 9, 30); // 6/25 09:30 (로컬)
const at1030 = new Date(2026, 5, 25, 10, 30);
assert.strictEqual(L.computeIsLate(at0930, '10:00', '2026-06-25', '2026-06-25'), false); // 마감 전
assert.strictEqual(L.computeIsLate(at1030, '10:00', '2026-06-25', '2026-06-25'), true);  // 마감 후
assert.strictEqual(L.computeIsLate(at1030, '10:00', '2026-06-26', '2026-06-25'), false); // 픽업이 내일 → late 아님
assert.strictEqual(L.computeIsLate(at1030, '', '2026-06-25', '2026-06-25'), false);       // 마감 미설정

// ── parseKakaoPickup: #업체 기준 그룹 + 품목/규격/수량 추출 ──
const parsed = L.parseKakaoPickup('#라코스\n현수막 600x900 3개\n배너 2장\n#세원계측기\n압력계 1');
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].vendorGuess, '라코스');
assert.strictEqual(parsed[0].items.length, 2);
assert.deepStrictEqual(parsed[0].items[0], { itemName: '현수막', spec: '600x900', qty: 3, unit: '개' });
assert.deepStrictEqual(parsed[0].items[1], { itemName: '배너', spec: '', qty: 2, unit: '장' });
assert.strictEqual(parsed[1].vendorGuess, '세원계측기');
assert.deepStrictEqual(parsed[1].items[0], { itemName: '압력계', spec: '', qty: 1, unit: '' });

// 업체헤더 없이 시작하면 vendorGuess '' 그룹
const noHeader = L.parseKakaoPickup('볼트 5개');
assert.strictEqual(noHeader.length, 1);
assert.strictEqual(noHeader[0].vendorGuess, '');
assert.strictEqual(noHeader[0].items[0].itemName, '볼트');

// ── buildShareText ──
const text = L.buildShareText('2026-06-25', [
  { vendorName: '라코스', items: [{ itemName: '현수막', spec: '600x900', qty: 3, unit: '개' }] },
  { vendorName: '세원', items: [{ itemName: '압력계', spec: '', qty: 1, unit: '' }] },
]);
assert.ok(text.includes('2026-06-25'));
assert.ok(text.includes('[라코스]'));
assert.ok(text.includes('현수막 600x900 3개'));
assert.ok(text.includes('[세원]'));

// ── groupByVendor ──
const grouped = L.groupByVendor([
  { vendorId: 'v1', vendorName: '라코스', items: [{ itemName: 'A' }] },
  { vendorId: 'v1', vendorName: '라코스', items: [{ itemName: 'B' }] },
  { vendorId: 'v2', vendorName: '세원', items: [{ itemName: 'C' }] },
]);
assert.strictEqual(grouped.length, 2);
const g1 = grouped.find(g => g.vendorId === 'v1');
assert.strictEqual(g1.items.length, 2); // 두 요청의 품목 합쳐짐

console.log('✅ pickup-logic 테스트 통과');
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node tests/pickup-logic.test.js`
Expected: FAIL — `Cannot find module '../lib/pickup-logic'`

- [ ] **Step 3: 최소 구현** — `lib/pickup-logic.js`

```javascript
'use strict';

/** 요청 상태 롤업 — 품목 라인들에서 요청 단위 상태 계산 (순수) */
function computeRequestStatus(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const active = list.filter(it => it && it.status !== 'cancelled');
  if (list.length > 0 && active.length === 0) return 'cancelled';
  if (active.length === 0) return opts.courseConfirmed ? 'inCourse' : 'requested';
  const picked = active.filter(it => it.status === 'pickedUp').length;
  const notPicked = active.filter(it => it.status === 'notPicked').length;
  if (picked === active.length) return 'completed';
  if (picked > 0) return 'partial';
  if (notPicked === active.length) return 'notPicked';
  return opts.courseConfirmed ? 'inCourse' : 'requested';
}

/**
 * 마감(추가요청) 판정 — 픽업일이 '오늘'이고 등록시각이 마감 이후면 true (순수)
 * @param {Date} now 등록시각(서버 로컬)
 * @param {string} cutoffHHMM '10:00' (빈값이면 항상 false)
 * @param {string} pickupDate 'YYYY-MM-DD'
 * @param {string} todayStr 서버 로컬 오늘 'YYYY-MM-DD'
 */
function computeIsLate(now, cutoffHHMM, pickupDate, todayStr) {
  if (!cutoffHHMM || !(now instanceof Date) || isNaN(now.getTime())) return false;
  if (pickupDate && todayStr && pickupDate !== todayStr) return false; // 미래 픽업은 추가요청 아님
  const parts = String(cutoffHHMM).split(':');
  const cutoff = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur > cutoff;
}

/** 품목 라인 1줄 파싱 → { itemName, spec, qty, unit } (순수, best-effort) */
function parseItemLine(line) {
  let s = String(line).replace(/^[-*•]\s*/, '').trim();
  let qty = 0, unit = '';
  const qm = s.match(/\s(\d+(?:\.\d+)?)\s*(개|장|롤|박스|매|세트|ea|EA)?\s*$/);
  if (qm) { qty = parseFloat(qm[1]); unit = qm[2] || ''; s = s.slice(0, qm.index).trim(); }
  let spec = '';
  const sm = s.match(/\s(\d+\s*[x*X×]\s*\d+(?:\s*[x*X×]\s*\d+)?)\s*$/);
  if (sm) { spec = sm[1].replace(/\s/g, ''); s = s.slice(0, sm.index).trim(); }
  return { itemName: s, spec, qty, unit };
}

/** 카톡 글 → [{ vendorGuess, items:[{itemName,spec,qty,unit}] }] (순수, 저장 전 후보) */
function parseKakaoPickup(text) {
  const lines = String(text || '').split(/\r?\n/);
  const groups = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      cur = { vendorGuess: line.replace(/^#+\s*/, '').trim(), items: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) { cur = { vendorGuess: '', items: [] }; groups.push(cur); }
    cur.items.push(parseItemLine(line));
  }
  return groups.filter(g => g.items.length > 0 || g.vendorGuess);
}

/** 카톡 공유용 텍스트 생성 (순수) */
function buildShareText(dateStr, groups) {
  const out = [`📦 ${dateStr} 픽업`];
  for (const g of (groups || [])) {
    out.push('');
    out.push(`[${g.vendorName || '미지정'}]`);
    for (const it of (g.items || [])) {
      const head = [it.itemName, it.spec].filter(Boolean).join(' ');
      const qtyStr = it.qty ? ` ${it.qty}${it.unit || ''}` : '';
      out.push(`- ${head}${qtyStr}`);
    }
  }
  return out.join('\n');
}

/** vendorId로 요청들을 업체 카드로 묶음 (취합 뷰용, 순수) */
function groupByVendor(requests) {
  const map = new Map();
  for (const r of (requests || [])) {
    const key = r.vendorId || '';
    if (!map.has(key)) map.set(key, { vendorId: r.vendorId, vendorName: r.vendorName, requests: [], items: [] });
    const g = map.get(key);
    g.requests.push(r);
    for (const it of (r.items || [])) g.items.push(it);
  }
  return Array.from(map.values());
}

module.exports = { computeRequestStatus, computeIsLate, parseItemLine, parseKakaoPickup, buildShareText, groupByVendor };
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node tests/pickup-logic.test.js`
Expected: PASS — `✅ pickup-logic 테스트 통과`

- [ ] **Step 5: 커밋**

```bash
git add lib/pickup-logic.js tests/pickup-logic.test.js
git commit -m "feat(pickup): 순수 로직(상태롤업·마감판정·카톡파싱·공유텍스트) + 테스트"
```

---

## Task 2: DB 스키마 + CRUD (`db-sqlite.js`)

**Files:**
- Modify: `db-sqlite.js` (테이블 생성 블록 ~127, 마이그레이션 ~130, CRUD 객체 추가, module.exports)
- Test: `tests/pickup-db.smoke.js` (신규 — 실제 DB 라운드트립 스모크)

- [ ] **Step 1: pickup 테이블 CREATE 추가** — `db-sqlite.js`의 `db.exec(\`...\`)` 블록 안, `idx_quotes_vendorId` 라인 **뒤에**(127번 줄 닫는 백틱 직전) 아래를 추가:

```sql
  CREATE TABLE IF NOT EXISTS pickup_requests (
    id TEXT PRIMARY KEY,
    registrarId TEXT NOT NULL,
    registrarName TEXT DEFAULT '',
    pickupDate TEXT NOT NULL,
    vendorId TEXT NOT NULL,
    vendorName TEXT DEFAULT '',
    preferredTimeSlot TEXT DEFAULT '',
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'requested',
    sourceType TEXT DEFAULT 'manual',
    sourceJobId TEXT DEFAULT NULL,
    sourceRef TEXT DEFAULT NULL,
    memo TEXT DEFAULT '',
    isLate INTEGER DEFAULT 0,
    requestedAt TEXT DEFAULT (datetime('now')),
    courseConfirmedAt TEXT DEFAULT NULL,
    updatedAt TEXT DEFAULT (datetime('now')),
    cancelledAt TEXT DEFAULT NULL,
    cancelledBy TEXT DEFAULT NULL,
    cancelReason TEXT DEFAULT '',
    courseId TEXT DEFAULT NULL,
    FOREIGN KEY (vendorId) REFERENCES vendors(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS pickup_items (
    id TEXT PRIMARY KEY,
    requestId TEXT NOT NULL,
    lineNo INTEGER DEFAULT 0,
    itemName TEXT NOT NULL,
    spec TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    unit TEXT DEFAULT '개',
    status TEXT DEFAULT 'requested',
    pickedQty REAL DEFAULT NULL,
    failReason TEXT DEFAULT '',
    checkedAt TEXT DEFAULT NULL,
    checkedBy TEXT DEFAULT NULL,
    FOREIGN KEY (requestId) REFERENCES pickup_requests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pickup_courses (
    id TEXT PRIMARY KEY,
    pickupDate TEXT NOT NULL,
    courseNumber INTEGER,
    vendorId TEXT,
    vendorName TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    assignedDriver TEXT DEFAULT '',
    vehicle TEXT DEFAULT '',
    sortOrder INTEGER DEFAULT 0,
    confirmedAt TEXT DEFAULT NULL,
    completedAt TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pickup_req_date   ON pickup_requests(pickupDate);
  CREATE INDEX IF NOT EXISTS idx_pickup_req_vendor ON pickup_requests(vendorId);
  CREATE INDEX IF NOT EXISTS idx_pickup_req_status ON pickup_requests(status);
  CREATE INDEX IF NOT EXISTS idx_pickup_req_source ON pickup_requests(sourceJobId);
  CREATE INDEX IF NOT EXISTS idx_pickup_items_req  ON pickup_items(requestId);
  CREATE INDEX IF NOT EXISTS idx_pickup_courses_date ON pickup_courses(pickupDate);
```

- [ ] **Step 2: vendors ALTER 마이그레이션 추가** — `db-sqlite.js`의 quote_items.meta 마이그레이션 블록(135번 줄 `} catch...` ) **바로 뒤에** 추가:

```javascript
// ── vendors 픽업 필드 마이그레이션 (없는 컬럼만 ALTER) ──
try {
  const vcols = db.prepare("PRAGMA table_info(vendors)").all().map(c => c.name);
  const adds = [
    ["vendorType", "TEXT DEFAULT '기타'"],
    ["mapSearchKeyword", "TEXT DEFAULT ''"],
    ["contactPerson", "TEXT DEFAULT ''"],
    ["contactPhone", "TEXT DEFAULT ''"],
    ["pickupMemo", "TEXT DEFAULT ''"],
    ["parkingAccessMemo", "TEXT DEFAULT ''"],
    ["isActive", "INTEGER DEFAULT 1"],
  ];
  for (const [col, def] of adds) {
    if (!vcols.includes(col)) db.prepare(`ALTER TABLE vendors ADD COLUMN ${col} ${def}`).run();
  }
} catch (e) { console.warn('vendors 픽업필드 마이그레이션 오류:', e.message); }
```

- [ ] **Step 3: vendors CRUD에 신규 필드 반영** — `db-sqlite.js`의 `vendors` 객체(267~299줄)에서 `create`/`update`의 INSERT/UPDATE에 신규 7컬럼 포함. `vendors.create`를 아래로 교체:

```javascript
  create(v) {
    const id = v.id || generateId('v');
    db.prepare(`
      INSERT INTO vendors (id, name, bizNo, ceo, phone, email, address, note,
        vendorType, mapSearchKeyword, contactPerson, contactPhone, pickupMemo, parkingAccessMemo, isActive)
      VALUES (@id, @name, @bizNo, @ceo, @phone, @email, @address, @note,
        @vendorType, @mapSearchKeyword, @contactPerson, @contactPhone, @pickupMemo, @parkingAccessMemo, @isActive)
    `).run({
      id, name: v.name||'', bizNo: v.bizNo||'', ceo: v.ceo||'', phone: v.phone||'',
      email: v.email||'', address: v.address||'', note: v.note||'',
      vendorType: v.vendorType||'기타', mapSearchKeyword: v.mapSearchKeyword||'',
      contactPerson: v.contactPerson||'', contactPhone: v.contactPhone||'',
      pickupMemo: v.pickupMemo||'', parkingAccessMemo: v.parkingAccessMemo||'',
      isActive: (v.isActive === undefined ? 1 : (v.isActive ? 1 : 0))
    });
    return this.getById(id);
  },
```

그리고 `vendors.update`의 UPDATE 문을 아래로 교체(merged에 신규필드 포함됨):

```javascript
  update(id, changes) {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, id };
    if (merged.isActive !== undefined) merged.isActive = merged.isActive ? 1 : 0;
    db.prepare(`
      UPDATE vendors SET name=@name, bizNo=@bizNo, ceo=@ceo, phone=@phone, email=@email,
        address=@address, note=@note, vendorType=@vendorType, mapSearchKeyword=@mapSearchKeyword,
        contactPerson=@contactPerson, contactPhone=@contactPhone, pickupMemo=@pickupMemo,
        parkingAccessMemo=@parkingAccessMemo, isActive=@isActive
      WHERE id=@id
    `).run(merged);
    return this.getById(id);
  },
```

- [ ] **Step 4: pickup CRUD 객체 추가** — `db-sqlite.js`에서 `vendorPrices` 객체 정의 **뒤**(330번 줄 근처, 다른 CRUD 객체들과 같은 위치)에 추가. `require`는 파일 상단에 `const pickupLogic = require('./lib/pickup-logic');` 한 줄 추가:

```javascript
// ── Pickup (픽업관리) ────────────────────────────────
const pickupRequests = {
  // 날짜별 취합 (요청 + 품목 + 업체 픽업정보)
  getByDate(pickupDate) {
    const reqs = db.prepare('SELECT * FROM pickup_requests WHERE pickupDate = ? ORDER BY requestedAt').all(pickupDate);
    return reqs.map(r => this._hydrate(r));
  },
  getMine(registrarId, pickupDate) {
    const reqs = db.prepare('SELECT * FROM pickup_requests WHERE registrarId = ? AND pickupDate = ? ORDER BY requestedAt DESC')
      .all(registrarId, pickupDate);
    return reqs.map(r => this._hydrate(r));
  },
  getById(id) {
    const r = db.prepare('SELECT * FROM pickup_requests WHERE id = ?').get(id);
    return r ? this._hydrate(r) : null;
  },
  _hydrate(r) {
    const items = db.prepare('SELECT * FROM pickup_items WHERE requestId = ? ORDER BY lineNo, id').all(r.id);
    const v = db.prepare('SELECT name, phone, address, mapSearchKeyword, contactPerson, contactPhone, pickupMemo, parkingAccessMemo FROM vendors WHERE id = ?').get(r.vendorId) || {};
    return { ...r, items, vendor: v };
  },
  // 생성: 요청 1건 + 품목 N개 (트랜잭션)
  create(reqData, items) {
    const id = reqData.id || generateId('pk');
    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO pickup_requests (id, registrarId, registrarName, pickupDate, vendorId, vendorName,
          preferredTimeSlot, priority, status, sourceType, sourceJobId, sourceRef, memo, isLate)
        VALUES (@id, @registrarId, @registrarName, @pickupDate, @vendorId, @vendorName,
          @preferredTimeSlot, @priority, @status, @sourceType, @sourceJobId, @sourceRef, @memo, @isLate)
      `).run({
        id,
        registrarId: reqData.registrarId, registrarName: reqData.registrarName || '',
        pickupDate: reqData.pickupDate, vendorId: reqData.vendorId, vendorName: reqData.vendorName || '',
        preferredTimeSlot: reqData.preferredTimeSlot || '', priority: reqData.priority || 'normal',
        status: 'requested', sourceType: reqData.sourceType || 'manual',
        sourceJobId: reqData.sourceJobId || null, sourceRef: reqData.sourceRef || null,
        memo: reqData.memo || '', isLate: reqData.isLate ? 1 : 0,
      });
      (items || []).forEach((it, i) => {
        db.prepare(`
          INSERT INTO pickup_items (id, requestId, lineNo, itemName, spec, qty, unit, status)
          VALUES (@id, @requestId, @lineNo, @itemName, @spec, @qty, @unit, 'requested')
        `).run({
          id: generateId('pi'), requestId: id, lineNo: i,
          itemName: it.itemName || '', spec: it.spec || '', qty: Number(it.qty) || 0, unit: it.unit || '개',
        });
      });
    });
    create();
    return this.getById(id);
  },
  update(id, changes) {
    const ALLOWED = ['pickupDate', 'preferredTimeSlot', 'priority', 'memo'];
    const sets = ALLOWED.filter(k => changes[k] !== undefined);
    if (sets.length) {
      const sql = 'UPDATE pickup_requests SET ' + sets.map(k => `${k}=@${k}`).join(', ') + ", updatedAt=datetime('now') WHERE id=@id";
      const params = { id }; sets.forEach(k => params[k] = changes[k]);
      db.prepare(sql).run(params);
    }
    return this.getById(id);
  },
  cancel(id, by, reason) {
    db.prepare("UPDATE pickup_items SET status='cancelled' WHERE requestId=?").run(id);
    db.prepare("UPDATE pickup_requests SET status='cancelled', cancelledAt=datetime('now'), cancelledBy=@by, cancelReason=@reason, updatedAt=datetime('now') WHERE id=@id")
      .run({ id, by: by || '', reason: reason || '' });
    return this.getById(id);
  },
  delete(id) {
    return db.prepare('DELETE FROM pickup_requests WHERE id = ?').run(id); // CASCADE로 items 삭제
  },
  // 라인 상태 변경 → 부모 요청 상태 재계산
  setItemStatus(itemId, patch, checkedBy) {
    const item = db.prepare('SELECT * FROM pickup_items WHERE id = ?').get(itemId);
    if (!item) return null;
    db.prepare(`UPDATE pickup_items SET status=@status, pickedQty=@pickedQty, failReason=@failReason,
        checkedAt=datetime('now'), checkedBy=@checkedBy WHERE id=@id`).run({
      id: itemId,
      status: patch.status || item.status,
      pickedQty: (patch.pickedQty === undefined ? item.pickedQty : Number(patch.pickedQty)),
      failReason: patch.failReason !== undefined ? patch.failReason : item.failReason,
      checkedBy: checkedBy || '',
    });
    this._recompute(item.requestId);
    return this.getById(item.requestId);
  },
  _recompute(requestId) {
    const items = db.prepare('SELECT status FROM pickup_items WHERE requestId = ?').all(requestId);
    const req = db.prepare('SELECT courseConfirmedAt FROM pickup_requests WHERE id = ?').get(requestId);
    const status = pickupLogic.computeRequestStatus(items, { courseConfirmed: !!(req && req.courseConfirmedAt) });
    db.prepare("UPDATE pickup_requests SET status=@status, updatedAt=datetime('now') WHERE id=@id").run({ id: requestId, status });
  },
};
```

- [ ] **Step 5: module.exports에 추가** — `db-sqlite.js`의 `module.exports = { ... }`에 `pickupRequests` 추가 (vendors, vendorPrices 옆):

```javascript
  pickupRequests,
```

- [ ] **Step 6: 스모크 테스트 작성** — `tests/pickup-db.smoke.js`

```javascript
// 실제 업무데이터.db에 픽업요청을 만들고 라인체크/롤업/삭제까지 라운드트립 검증 후 정리
const assert = require('node:assert');
const sql = require('../db-sqlite');

const vendor = sql.vendors.getAll()[0];
assert.ok(vendor, '검증하려면 업체가 최소 1개 필요(업체관리에 등록 후 재시도)');

const req = sql.pickupRequests.create(
  { registrarId: 'smoke', registrarName: '스모크', pickupDate: '2099-01-01', vendorId: vendor.id, vendorName: vendor.name, isLate: false },
  [{ itemName: 'A', spec: '600x900', qty: 2, unit: '개' }, { itemName: 'B', qty: 1 }]
);
try {
  assert.strictEqual(req.status, 'requested');
  assert.strictEqual(req.items.length, 2);
  assert.ok(req.vendor && req.vendor.name === vendor.name, 'vendor 픽업정보 하이드레이션');

  // 한 품목 수거완료 → partial
  let after = sql.pickupRequests.setItemStatus(req.items[0].id, { status: 'pickedUp' }, 'smoke');
  assert.strictEqual(after.status, 'partial');
  // 나머지도 완료 → completed
  after = sql.pickupRequests.setItemStatus(req.items[1].id, { status: 'pickedUp' }, 'smoke');
  assert.strictEqual(after.status, 'completed');

  // 날짜 조회에 잡힘
  const byDate = sql.pickupRequests.getByDate('2099-01-01');
  assert.ok(byDate.find(r => r.id === req.id));
} finally {
  sql.pickupRequests.delete(req.id);
  assert.strictEqual(sql.pickupRequests.getById(req.id), null);
}
console.log('✅ pickup-db 스모크 통과');
```

- [ ] **Step 7: 스모크 실행**

Run: `node tests/pickup-db.smoke.js`
Expected: PASS — `✅ pickup-db 스모크 통과` (업체가 0개면 안내 메시지로 실패 → 업체 1개 등록 후 재실행)

- [ ] **Step 8: 커밋**

```bash
git add db-sqlite.js tests/pickup-db.smoke.js
git commit -m "feat(pickup): SQLite 스키마(vendors ALTER+pickup_requests/items/courses)+CRUD+스모크"
```

---

## Task 3: 라우트 `routes/pickup.js` + 마운트

**Files:**
- Create: `routes/pickup.js`
- Modify: `server.js` (라우트 마운트 1줄), `routes/vendors.js` (신규 vendor 필드 화이트리스트)

- [ ] **Step 1: `routes/vendors.js` POST에 신규필드 추가** — `router.post('/')`의 `db.sql.vendors.create({...})` 인자에 7필드 추가(29~33줄):

```javascript
      const v = db.sql.vendors.create({
        name: req.body.name || '', bizNo: req.body.bizNo || '',
        ceo: req.body.ceo || '', phone: req.body.phone || '', email: req.body.email || '',
        address: req.body.address || '', note: req.body.note || '',
        vendorType: req.body.vendorType || '기타', mapSearchKeyword: req.body.mapSearchKeyword || '',
        contactPerson: req.body.contactPerson || '', contactPhone: req.body.contactPhone || '',
        pickupMemo: req.body.pickupMemo || '', parkingAccessMemo: req.body.parkingAccessMemo || '',
        isActive: req.body.isActive === undefined ? 1 : req.body.isActive
      });
```

(PUT은 `safeBody` 후 `db.sql.vendors.update(id, req.body)`로 들어가므로 신규필드 자동 반영 — 수정 불필요.)

- [ ] **Step 2: `routes/pickup.js` 생성** — 권한게이트·SQLite·notify 포함:

```javascript
/**
 * routes/pickup.js — 픽업관리 v1 API
 * 권한: pickup_view(조회) / pickup_register(등록·수정·취소) / pickup_check(라인체크)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getReqUser, requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { safeBody } = require('../middleware/sanitize');
const L = require('../lib/pickup-logic');

let notify = () => {};
try { notify = require('../utils/notify').notify || notify; } catch (e) {}

router.use(requireAuth);

// ── 권한 헬퍼 ──
function hasPerm(req, perm) {
  const u = req.user || {};
  return u.role === 'admin' || (Array.isArray(u.permissions) && u.permissions.includes(perm));
}
function requirePerm(perm) {
  return (req, res, next) => hasPerm(req, perm)
    ? next()
    : res.status(403).json({ error: '권한이 없습니다', code: 'PICKUP_FORBIDDEN', need: perm });
}
function pickup() {
  if (!db.sql || !db.sql.pickupRequests) return null;
  return db.sql.pickupRequests;
}
function cutoffTime() {
  try { return (db['설정'] && db['설정'].load().pickup || {}).cutoffTime || '10:00'; }
  catch (e) { return '10:00'; }
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 조회: 날짜별 취합 (업체 그룹 메타 포함) ──
router.get('/requests', requirePerm('pickup_view'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요(better-sqlite3 미설치)' });
    const date = req.query.date || todayStr();
    const requests = P.getByDate(date);
    res.json({ date, requests, groups: L.groupByVendor(requests) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 조회: 내가 등록한 것 ──
router.get('/requests/mine', requirePerm('pickup_view'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const date = req.query.date || todayStr();
    res.json(P.getMine(getReqUser(req), date));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 등록 ──
router.post('/requests', requirePerm('pickup_register'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const b = safeBody(req.body, []);
    if (!b.pickupDate || !b.vendorId) return res.status(400).json({ error: 'pickupDate, vendorId 필수' });
    const vendor = db.sql.vendors.getById(b.vendorId);
    if (!vendor) return res.status(400).json({ error: '없는 업체' });
    const isLate = L.computeIsLate(new Date(), cutoffTime(), b.pickupDate, todayStr());
    const created = P.create({
      registrarId: getReqUser(req), registrarName: (req.user && req.user.name) || '',
      pickupDate: b.pickupDate, vendorId: b.vendorId, vendorName: vendor.name,
      preferredTimeSlot: b.preferredTimeSlot, priority: b.priority, memo: b.memo,
      sourceType: b.sourceType === 'workflow' ? 'workflow' : 'manual',
      sourceJobId: b.sourceJobId || null, isLate,
    }, Array.isArray(b.items) ? b.items : []);
    auditLog(getReqUser(req), '픽업요청 등록', vendor.name + (isLate ? ' (추가요청)' : ''));
    notifyDeliveryTeam(`${isLate ? '🔴추가요청 ' : ''}${vendor.name} 픽업요청 (${b.pickupDate})`);
    res.json(created);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 수정 (등록자 본인 또는 admin) ──
router.put('/requests/:id', requirePerm('pickup_register'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const cur = P.getById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.registrarId !== getReqUser(req) && req.user.role !== 'admin')
      return res.status(403).json({ error: '본인 요청만 수정 가능' });
    const updated = P.update(req.params.id, safeBody(req.body, ['id']));
    auditLog(getReqUser(req), '픽업요청 수정', updated.vendorName);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 취소 ──
router.post('/requests/:id/cancel', requirePerm('pickup_register'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const cur = P.getById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.registrarId !== getReqUser(req) && req.user.role !== 'admin')
      return res.status(403).json({ error: '본인 요청만 취소 가능' });
    const r = P.cancel(req.params.id, getReqUser(req), (req.body && req.body.reason) || '');
    auditLog(getReqUser(req), '픽업요청 취소', cur.vendorName);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 라인(품목) 상태 체크 ──
router.patch('/items/:id/status', requirePerm('pickup_check'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const VALID = ['requested', 'pickedUp', 'notPicked', 'cancelled'];
    const b = req.body || {};
    if (b.status && !VALID.includes(b.status)) return res.status(400).json({ error: '잘못된 상태' });
    const updated = P.setItemStatus(req.params.id, {
      status: b.status, pickedQty: b.pickedQty, failReason: b.failReason,
    }, getReqUser(req));
    if (!updated) return res.status(404).json({ error: 'item not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 카톡 붙여넣기 파싱 (저장 아님, 후보 반환) ──
router.post('/parse-kakao', requirePerm('pickup_register'), express.json(), (req, res) => {
  res.json({ groups: L.parseKakaoPickup((req.body && req.body.text) || '') });
});

// ── 카톡 공유텍스트 ──
router.get('/requests/:date/share-text', requirePerm('pickup_view'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const groups = L.groupByVendor(P.getByDate(req.params.date));
    res.json({ text: L.buildShareText(req.params.date, groups) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 알림: pickup_check 보유자 + admin 에게 (best-effort) ──
function notifyDeliveryTeam(message) {
  try {
    const users = (db['조직관리'].load().users || []).filter(u =>
      u.status === 'approved' && (u.role === 'admin' || (u.permissions || []).includes('pickup_check')));
    for (const u of users) notify(u.userId || u.id, 'pickup', message, '/?tab=pickup');
  } catch (e) { /* 알림 실패는 무시 */ }
}

module.exports = router;
```

- [ ] **Step 3: `server.js`에 마운트** — 다른 `app.use('/api/...', require('./routes/...'))` 라인들 옆에 추가:

```javascript
app.use('/api/pickup', require('./routes/pickup'));
```

- [ ] **Step 4: 서버 기동 + 라우트 스모크** — 서버를 켜고(`node server.js`) admin 세션 쿠키로 호출. (로컬에서 admin 로그인 후 브라우저 콘솔/`curl`)

Run (예시, admin 쿠키 필요):
```bash
curl -s -X POST http://localhost:3000/api/pickup/parse-kakao \
  -H "Content-Type: application/json" -H "x-session-token: <ADMIN_TOKEN>" \
  -d '{"text":"#라코스\n현수막 600x900 3개"}'
```
Expected: `{"groups":[{"vendorGuess":"라코스","items":[{"itemName":"현수막","spec":"600x900","qty":3,"unit":"개"}]}]}`

권한 게이트 확인: `pickup_register` 없는 일반계정으로 `POST /api/pickup/requests` → `403 PICKUP_FORBIDDEN`.

- [ ] **Step 5: 커밋**

```bash
git add routes/pickup.js routes/vendors.js server.js
git commit -m "feat(pickup): /api/pickup 라우트(등록·취합·라인체크·카톡파싱·공유텍스트)+권한게이트+알림"
```

---

## 셀프리뷰 (작성자 체크)

**스펙 커버리지 (플랜 A 범위):**
- §4.1 vendors ALTER 7컬럼 → Task 2 Step 2~3 ✅
- §4.2~4.4 pickup_requests/items/courses + sourceRef → Task 2 Step 1 ✅
- §5 상태 머신(라인→요청 롤업, isLate) → Task 1 `computeRequestStatus`/`computeIsLate` + Task 2 `_recompute` ✅
- §6 API 8종 → Task 3 (requests GET/mine/POST/PUT/cancel, items PATCH, parse-kakao, share-text) ✅
- §8 카톡파싱/공유텍스트(순수+TDD) → Task 1 ✅
- §9 권한게이트(pickup_view/register/check, 본인/ admin) → Task 3 `requirePerm` ✅
- §10 알림(등록 시 납품팀, isLate 강조) → Task 3 `notifyDeliveryTeam` ✅
- §12 리스크: 라인마다 auditLog 금지 → 등록/수정/취소 단위만 로깅 ✅ / FK RESTRICT는 vendor 삭제 시 — 플랜 B에서 isActive 소프트삭제 UX ✅(예정)

**플랜 B(프론트)로 미룬 것:** allMenus/getTabs/menuGroups 메뉴·권한 노출, ROLE_PRESETS(경영관리팀/납품팀), tab-pickup.html(등록 뷰+취합·체크 뷰), 업체팝업 신규필드 입력 UI, 워크플로 "픽업에 추가" 버튼.

**타입 일관성:** item.status/req.status/priority/sourceType 코드값이 Task 1·2·3 전반 동일. CRUD 메서드명(`getByDate`/`getMine`/`getById`/`create`/`update`/`cancel`/`setItemStatus`/`_recompute`) 일관.

**미해결(플랜 B 진입 전 확인):** `utils/notify.js`의 export가 `notify(userId,type,msg,link)`인지 1차 확인(try/catch로 안전망 둠). `db['설정']`/`db['조직관리']` 로더 존재 확인(기존 사용처 있음).
