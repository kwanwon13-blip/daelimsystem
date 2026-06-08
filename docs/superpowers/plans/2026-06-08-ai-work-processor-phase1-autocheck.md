# ERP AI 업무 처리기 — 1단계: 출력 자동점검 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 마감 스킬(퍼시스·나이스텍 등) 실행이 끝나면 결과를 **보수적으로 자동점검**해서, 결과 메시지에 `✅ 점검 통과` 또는 `🚩 확인 필요` 한 줄을 붙인다. "지멋대로/빈 결과가 조용히 나가는" 일을 막는 안전 바닥.

**Architecture:** 순수 판정 모듈 `lib/ledger-autocheck.js`(파일 I/O 없는 판정 + xlsx 행수 측정)를 새로 만들고, `lib/agent-runtime.js` 의 `runBundledScriptSkill()` 성공 경로에서 호출해 점검 텍스트를 스트리밍한다. 점검은 **허위 경보를 피하려 매우 보수적** — 결과 파일이 없거나 / 거의 비었거나 / 스크립트가 `[WARN]`·`[ERROR]`를 찍었을 때만 "확인 필요"로 본다.

**Tech Stack:** Node.js (CommonJS), `exceljs` ^4.4.0, 테스트는 `node:assert` + `node tests/<name>.test.js`(프레임워크 없음, 끝에 `console.log('PASS ...')`).

---

## 단계(Phase) 맥락

전체 설계: `docs/superpowers/specs/2026-06-08-ai-work-processor-design.md`. 이 계획서는 **1단계(자동점검)만** 다룬다.

- 이 단계가 구현하는 것: 설계 §4.5 "자동 점검"의 **보수적 부분집합** — 결과 존재/행수/스크립트 경고.
- **이 단계가 일부러 미루는 것**: "원본 합계 = 결과 합계" 정밀 대조. (거래처별 컬럼/제외 규칙을 알아야 해서 허위 경보 위험이 큼 — 설계 §9의 미결 항목. 3단계에서 출력 양식을 직접 만들 때 함께 처리.)
- 마감 스킬은 **agent 모드**(`runBundledScriptSkill`)로 돈다. 이 단계 배선은 그 경로에 한정한다.

---

## File Structure

| 파일 | 책임 | 비고 |
|------|------|------|
| `lib/ledger-autocheck.js` | **신규.** 순수 판정(`judgeLedgerRun`), 한국어 포매터(`formatVerdictKorean`), xlsx 행수 측정(`countNonEmptyRows`), async 오케스트레이터(`autocheckLedger`). | 파일 I/O는 `autocheckLedger`에만. 나머지는 순수 → 단위테스트 쉬움. |
| `tests/ledger-autocheck.test.js` | **신규.** 위 함수들 단위테스트. | `node:assert`, in-memory exceljs, 가짜 ExcelJS 주입. |
| `lib/agent-runtime.js` | **수정.** `runBundledScriptSkill()` 성공 경로(≈714–722줄)에서 `autocheckLedger` 호출 → 점검 텍스트 스트리밍 + `done` 이벤트에 `check` 첨부. | 실패/타임아웃 경로는 그대로(이미 처리됨). |

---

## Task 1: 순수 판정 + 포매터 (`judgeLedgerRun`, `formatVerdictKorean`)

**Files:**
- Create: `lib/ledger-autocheck.js`
- Test: `tests/ledger-autocheck.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

Create `tests/ledger-autocheck.test.js`:

```js
const assert = require('node:assert');
const ac = require('../lib/ledger-autocheck');

(async () => {
  // --- judgeLedgerRun: 파일 없음 → fail ---
  {
    const v = ac.judgeLedgerRun({ files: [], stdout: '' });
    assert.strictEqual(v.status, 'fail');
    assert.ok(/생성되지/.test(v.reasons.join(' ')));
    assert.strictEqual(v.summary.fileCount, 0);
  }
  // --- judgeLedgerRun: 정상 → pass ---
  {
    const v = ac.judgeLedgerRun({ files: [{ name: 'a.xlsx', maxRows: 20 }, { name: 'b.xlsx', maxRows: 13 }], stdout: '[OK] 검증 통과' });
    assert.strictEqual(v.status, 'pass');
    assert.strictEqual(v.summary.fileCount, 2);
    assert.strictEqual(v.summary.totalRows, 33);
    assert.strictEqual(v.reasons.length, 0);
  }
  // --- judgeLedgerRun: 거의 빈 결과 파일 → warn ---
  {
    const v = ac.judgeLedgerRun({ files: [{ name: 'empty.xlsx', maxRows: 1 }], stdout: '' });
    assert.strictEqual(v.status, 'warn');
    assert.ok(/empty\.xlsx/.test(v.reasons.join(' ')));
  }
  // --- judgeLedgerRun: 스크립트 [WARN] → warn ---
  {
    const v = ac.judgeLedgerRun({ files: [{ name: 'a.xlsx', maxRows: 20 }], stdout: '[WARN] 데이터 이상 3건' });
    assert.strictEqual(v.status, 'warn');
    assert.ok(/경고/.test(v.reasons.join(' ')));
  }
  // --- formatVerdictKorean: pass ---
  {
    const t = ac.formatVerdictKorean({ status: 'pass', reasons: [], summary: { fileCount: 2, totalRows: 33 } });
    assert.ok(/✅ 점검 통과/.test(t));
    assert.ok(/생성 파일 2개/.test(t));
  }
  // --- formatVerdictKorean: warn ---
  {
    const t = ac.formatVerdictKorean({ status: 'warn', reasons: ['결과 파일 "x.xlsx"에 데이터가 거의 없습니다 (확인 필요).'], summary: { fileCount: 1, totalRows: 1 } });
    assert.ok(/🚩 확인 필요/.test(t));
    assert.ok(/x\.xlsx/.test(t));
  }

  console.log('PASS ledger-autocheck');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `node tests/ledger-autocheck.test.js`
Expected: FAIL — `Cannot find module '../lib/ledger-autocheck'` (모듈 미생성).

- [ ] **Step 3: 최소 구현**

Create `lib/ledger-autocheck.js`:

```js
'use strict';
// 마감 결과 자동점검(보수적) — 허위 경보 최소화. exitCode===0 성공 경로에서 호출.

// 순수 판정: 파일별 행정보 + stdout → verdict
function judgeLedgerRun({ files = [], stdout = '' } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { status: 'fail', reasons: ['결과 파일이 생성되지 않았습니다.'], summary: { fileCount: 0, totalRows: 0 } };
  }
  const reasons = [];
  let status = 'pass';
  for (const f of files) {
    if ((f.maxRows || 0) < 2) {
      status = 'warn';
      reasons.push(`결과 파일 "${f.name}"에 데이터가 거의 없습니다 (확인 필요).`);
    }
  }
  if (/\[WARN\]|\[ERROR\]/i.test(String(stdout || ''))) {
    if (status === 'pass') status = 'warn';
    reasons.push('처리 중 경고 메시지가 있었습니다 — 결과를 한 번 확인하세요.');
  }
  const totalRows = files.reduce((s, f) => s + (f.maxRows || 0), 0);
  return { status, reasons, summary: { fileCount: files.length, totalRows } };
}

// 순수 포매터: verdict → 한국어 텍스트 블록
function formatVerdictKorean(verdict = {}) {
  const map = { pass: '✅ 점검 통과', warn: '🚩 확인 필요', fail: '🚩 실패' };
  const icon = map[verdict.status] || '🚩 확인 필요';
  const lines = ['────────────────', `📋 자동점검: ${icon}`];
  if (verdict.summary) {
    lines.push(` · 생성 파일 ${verdict.summary.fileCount}개 · 데이터 행 합계 ${verdict.summary.totalRows}행`);
  }
  for (const r of (verdict.reasons || [])) lines.push(` · ${r}`);
  lines.push('────────────────');
  return lines.join('\n');
}

module.exports = { judgeLedgerRun, formatVerdictKorean };
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `node tests/ledger-autocheck.test.js`
Expected: `PASS ledger-autocheck`

- [ ] **Step 5: 커밋**

```bash
git add lib/ledger-autocheck.js tests/ledger-autocheck.test.js
git commit -m "feat(autocheck): 마감 결과 순수 판정·포매터 (judgeLedgerRun/formatVerdictKorean)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: xlsx 행수 측정 + async 오케스트레이터 (`countNonEmptyRows`, `autocheckLedger`)

**Files:**
- Modify: `lib/ledger-autocheck.js`
- Test: `tests/ledger-autocheck.test.js`

- [ ] **Step 1: 실패하는 테스트 추가**

In `tests/ledger-autocheck.test.js`, insert the following block **immediately before** the `console.log('PASS ledger-autocheck');` line (inside the async IIFE):

```js
  // --- countNonEmptyRows: 실제 exceljs 워크시트(메모리) ---
  {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getCell('A1').value = '헤더';
    ws.getCell('A2').value = '값1';
    ws.getCell('B3').value = 123;
    // 4행은 비움
    assert.strictEqual(ac.countNonEmptyRows(ws), 3);
  }
  // --- autocheckLedger: 가짜 ExcelJS 주입 → 행 충분 → pass ---
  {
    const fakeWs = { rowCount: 3, getRow: () => ({ eachCell: (opt, cb) => cb({ value: 'x' }) }) };
    function FakeWB() { this.worksheets = [fakeWs]; this.xlsx = { readFile: async () => {} }; }
    const v = await ac.autocheckLedger({ files: [{ name: 'a.xlsx', relPath: 'a.xlsx' }], dir: '/tmp', stdout: '' }, { ExcelJS: { Workbook: FakeWB } });
    assert.strictEqual(v.status, 'pass');
    assert.ok(/자동점검/.test(v.text));
  }
  // --- autocheckLedger: 비-xlsx 산출물은 행검사 생략하고 통과(허위경보 방지) ---
  {
    const v = await ac.autocheckLedger({ files: [{ name: 'note.txt' }], dir: '/tmp', stdout: '' }, {});
    assert.strictEqual(v.status, 'pass');
  }
  // --- autocheckLedger: 산출물 0개 → fail ---
  {
    const v = await ac.autocheckLedger({ files: [], dir: '/tmp', stdout: '' }, {});
    assert.strictEqual(v.status, 'fail');
  }
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `node tests/ledger-autocheck.test.js`
Expected: FAIL — `TypeError: ac.countNonEmptyRows is not a function` (아직 미구현).

- [ ] **Step 3: 구현 추가**

In `lib/ledger-autocheck.js`, add these two functions **above** the `module.exports` line:

```js
// exceljs 워크시트의 "비어있지 않은 행" 개수 (셀 위치/거래처별 컬럼을 모르므로 보수적으로 셈)
function countNonEmptyRows(ws) {
  if (!ws) return 0;
  let count = 0;
  const maxR = ws.rowCount || 0;
  for (let r = 1; r <= maxR; r++) {
    const row = ws.getRow(r);
    if (!row) continue;
    let hasVal = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const v = cell && cell.value;
      if (v !== null && v !== undefined && String(v).trim() !== '') hasVal = true;
    });
    if (hasVal) count++;
  }
  return count;
}

// async 오케스트레이터: 산출물 읽어서 판정. deps.ExcelJS 주입 가능(테스트용).
async function autocheckLedger({ files = [], dir = '', stdout = '' } = {}, deps = {}) {
  const path = require('path');
  if (!Array.isArray(files) || files.length === 0) {
    const v = judgeLedgerRun({ files: [], stdout });
    v.text = formatVerdictKorean(v);
    return v;
  }
  let ExcelJS = deps.ExcelJS;
  if (!ExcelJS) { try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; } }
  const rowInfo = [];
  for (const f of files) {
    const name = f.name || f.relPath || '';
    if (!/\.xlsx$/i.test(name)) { rowInfo.push({ name, maxRows: 2 }); continue; } // 비-xlsx는 행검사 생략
    let maxRows = 2; // 읽기 불가 시 보수적으로 통과 처리(허위경보 방지)
    if (ExcelJS) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.join(dir, f.relPath || f.name));
        maxRows = 0;
        for (const ws of wb.worksheets) {
          const n = countNonEmptyRows(ws);
          if (n > maxRows) maxRows = n;
        }
      } catch (_) { maxRows = 2; }
    }
    rowInfo.push({ name, maxRows });
  }
  const verdict = judgeLedgerRun({ files: rowInfo, stdout });
  verdict.text = formatVerdictKorean(verdict);
  return verdict;
}
```

And update the export line to:

```js
module.exports = { judgeLedgerRun, formatVerdictKorean, countNonEmptyRows, autocheckLedger };
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `node tests/ledger-autocheck.test.js`
Expected: `PASS ledger-autocheck`

- [ ] **Step 5: 커밋**

```bash
git add lib/ledger-autocheck.js tests/ledger-autocheck.test.js
git commit -m "feat(autocheck): xlsx 행수 측정 + async 오케스트레이터 autocheckLedger" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `runBundledScriptSkill()` 성공 경로에 자동점검 배선

**Files:**
- Modify: `lib/agent-runtime.js` (성공 경로 `done` yield, 현재 ≈714–722줄)

- [ ] **Step 1: 수정 — 점검 호출 + done 에 check 첨부**

In `lib/agent-runtime.js`, find the success-path `done` yield inside `runBundledScriptSkill()` (the one with `durationMs: Date.now() - startedAt`). Replace this exact block:

```js
  yield { type: 'done', data: {
    sessionId: session.sessionId,
    dir: session.dir,
    exitCode,
    durationMs: Date.now() - startedAt,
    files: finalFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    templateSaved: savedTemplates.map(t => t.name),
  }};
```

with:

```js
  // ── 자동점검(보수적): 빈 결과·스크립트 경고만 "확인 필요"로. 결과 반환은 절대 막지 않음. ──
  let ledgerCheck = null;
  try {
    const { autocheckLedger } = require('./ledger-autocheck');
    const verdict = await autocheckLedger({ files: finalFiles, dir: session.dir, stdout: stdoutAll });
    yield { type: 'output', data: { text: '\n' + verdict.text + '\n' } };
    ledgerCheck = { status: verdict.status, reasons: verdict.reasons, summary: verdict.summary };
  } catch (_) { /* 점검 실패는 무시 */ }

  yield { type: 'done', data: {
    sessionId: session.sessionId,
    dir: session.dir,
    exitCode,
    durationMs: Date.now() - startedAt,
    files: finalFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    templateSaved: savedTemplates.map(t => t.name),
    check: ledgerCheck,
  }};
```

- [ ] **Step 2: 문법 검사 (실행 없이 파싱만)**

Run: `node --check lib/agent-runtime.js`
Expected: 출력 없음, exit 0 (문법 오류 없음). 오류 시 메시지 표시되면 수정.

- [ ] **Step 3: 단위테스트 회귀 확인**

Run: `node tests/ledger-autocheck.test.js`
Expected: `PASS ledger-autocheck` (모듈 변경 없으니 그대로 통과).

- [ ] **Step 4: 수동 스모크 (실서버에서 1회)**

서버 실행 후 AI 챗에서 **퍼시스 판매현황 xlsx + (등록된 전월 템플릿)** 으로 마감을 돌린다.
기대: 결과 파일 카드 + 메시지 끝에 아래 블록이 보임.
```
────────────────
📋 자동점검: ✅ 점검 통과
 · 생성 파일 N개 · 데이터 행 합계 M행
────────────────
```
빈 데이터/이상 시 `🚩 확인 필요` + 사유가 보이면 정상.

- [ ] **Step 5: 커밋**

```bash
git add lib/agent-runtime.js
git commit -m "feat(autocheck): 마감 성공 경로에 자동점검 배선 + done.check 첨부" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 완료 기준 (Definition of Done)

- `node tests/ledger-autocheck.test.js` → `PASS ledger-autocheck`
- `node --check lib/agent-runtime.js` → 오류 없음
- 실제 마감 실행 시 결과 메시지에 `📋 자동점검:` 한 줄이 항상 붙는다(통과/확인 필요).
- 빈 결과·스크립트 `[WARN]` 일 때만 `🚩 확인 필요` — 정상 결과에 허위 경보 없음.
- 점검 로직이 실패해도 **결과 파일 반환은 막히지 않는다**(try/catch 보호).

## 다음 단계 (이 계획 범위 밖)

- 2단계: 정직한 라우터 — 모르는 작업은 "모른다"고 멈춤.
- 3단계: 처음 작업 — AI가 틀(스크립트) 생성 + 임시결과.
- 4단계: 결재 통합 — 등록/고쳐서 다시/반려 → 재사용 저장. 이때 출력 양식을 직접 만드므로 "합계 일치" 정밀 대조도 함께.
