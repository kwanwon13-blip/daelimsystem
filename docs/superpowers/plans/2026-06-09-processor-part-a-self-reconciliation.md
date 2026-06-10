# 처리기 Part A — 스크립트 자가검산 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 마감 스크립트가 `[RECON]` 검산표를 출력하면, 자동점검이 "원본 합계 = 결과 + 제외", "행 커버리지"를 판정해 ✅/🚩 표시 (허위경보 없이). 없으면 기존 보수적 점검으로 폴백.

**Architecture:** 순수 함수 `parseRecon`(stdout→recon객체)·`judgeRecon`(recon→verdict)을 `lib/ledger-autocheck.js`에 추가하고 `autocheckLedger`가 recon 있으면 우선 적용. 레퍼런스로 `make_persys.py`가 `[RECON]` 출력. AI 생성 스크립트도 출력하도록 `buildGenerationInstruction`에 지시 추가.

**Tech Stack:** Node.js(CommonJS), Python(openpyxl), 테스트 `node tests/*.test.js`(node:assert), `python -m py_compile`.

**선행:** `docs/superpowers/specs/2026-06-09-processor-verification-and-input-robustness-design.md` Part A. (B 입력정규화·C 미리보기는 별도 계획.)

---

## File Structure
| 파일 | 책임 |
|------|------|
| `lib/ledger-autocheck.js` (수정) | `parseRecon`·`judgeRecon` 추가, `autocheckLedger` 통합, `formatVerdictKorean`에 recon 줄 |
| `tests/ledger-autocheck.test.js` (수정) | 위 순수함수·통합 테스트 |
| `.claude/skills/persys-ledger/scripts/make_persys.py` (수정) | `[RECON]` 출력 (레퍼런스) |
| `lib/ledger-router.js` (수정) | `buildGenerationInstruction`에 `[RECON]` 지시 |
| `tests/ledger-router.test.js` (수정) | 지시문에 RECON 포함 확인 |

---

## Task 1: `parseRecon` + `judgeRecon` (순수)

**Files:** Modify `lib/ledger-autocheck.js`, Test `tests/ledger-autocheck.test.js`

- [ ] **Step 1: 실패 테스트 추가** — `tests/ledger-autocheck.test.js` 의 `console.log('PASS ledger-autocheck');` **앞**에 삽입:

```js
  // --- parseRecon: stdout 에서 마지막 [RECON] 한 줄 파싱 ---
  {
    const out = '스킬 실행\n[OK] 검증 통과\n[RECON] {"raw_rows":120,"raw_total":45000000,"excluded_rows":3,"excluded_total":150000,"excluded_note":"매출할인","out_rows":117,"out_total":44850000}\n완료';
    const r = ac.parseRecon(out);
    assert.ok(r && r.raw_total === 45000000 && r.out_rows === 117);
  }
  assert.strictEqual(ac.parseRecon('아무 [RECON] 없음'), null);
  assert.strictEqual(ac.parseRecon('[RECON] {깨진json'), null);
  // --- judgeRecon: 균형 OK → pass ---
  {
    const v = ac.judgeRecon({ raw_rows: 120, raw_total: 45000000, excluded_rows: 3, excluded_total: 150000, out_rows: 117, out_total: 44850000 });
    assert.strictEqual(v.status, 'pass');
    assert.strictEqual(v.reasons.length, 0);
  }
  // --- judgeRecon: 합계 안 맞음 → warn ---
  {
    const v = ac.judgeRecon({ raw_rows: 120, raw_total: 45000000, excluded_rows: 3, excluded_total: 150000, out_rows: 117, out_total: 43850000 });
    assert.strictEqual(v.status, 'warn');
    assert.ok(/합계/.test(v.reasons.join(' ')));
  }
  // --- judgeRecon: 행 누락 → warn (원본 120 = 결과 100 + 제외 3 → 17행 샘) ---
  {
    const v = ac.judgeRecon({ raw_rows: 120, raw_total: 45000000, excluded_rows: 3, excluded_total: 150000, out_rows: 100, out_total: 44850000 });
    assert.strictEqual(v.status, 'warn');
    assert.ok(/행|누락/.test(v.reasons.join(' ')));
  }
  // --- 반올림 오차는 통과 (행수 비례 허용) ---
  {
    const v = ac.judgeRecon({ raw_rows: 120, raw_total: 45000050, excluded_rows: 3, excluded_total: 150000, out_rows: 117, out_total: 44850000 });
    assert.strictEqual(v.status, 'pass');
  }
```

- [ ] **Step 2: 실패 확인** — Run: `node tests/ledger-autocheck.test.js` → FAIL (`ac.parseRecon is not a function`).

- [ ] **Step 3: 구현** — `lib/ledger-autocheck.js` 의 `module.exports` **앞**에 추가:

```js
// stdout 에서 마지막 [RECON] {json} 한 줄을 파싱. 없거나 깨지면 null.
function parseRecon(stdout) {
  const text = String(stdout || '');
  const re = /\[RECON\]\s*(\{[\s\S]*?\})\s*(?:\n|$)/g;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (!last) return null;
  try {
    const o = JSON.parse(last);
    return (o && typeof o === 'object') ? o : null;
  } catch (_) { return null; }
}

// recon(검산표) → verdict. "원본 = 결과 + 제외"(합계) + 행 커버리지 판정.
// 허위경보 방지: 합계는 행수 비례 + 최소 10원 오차 허용, 행은 정확.
function judgeRecon(recon = {}, { amountTol, rowTol } = {}) {
  const n = Number(recon.raw_rows) || 0;
  const aTol = (amountTol != null) ? amountTol : Math.max(10, n);
  const rTol = (rowTol != null) ? rowTol : 0;
  const rawTotal = Number(recon.raw_total) || 0;
  const outTotal = Number(recon.out_total) || 0;
  const exTotal = Number(recon.excluded_total) || 0;
  const rawRows = Number(recon.raw_rows) || 0;
  const outRows = Number(recon.out_rows) || 0;
  const exRows = Number(recon.excluded_rows) || 0;
  const reasons = [];
  const amtGap = Math.abs(rawTotal - (outTotal + exTotal));
  const rowGap = Math.abs(rawRows - (outRows + exRows));
  if (amtGap > aTol) reasons.push(`합계가 ${amtGap.toLocaleString('ko-KR')}원 안 맞습니다 (원본 ${rawTotal.toLocaleString('ko-KR')} vs 결과+제외 ${(outTotal + exTotal).toLocaleString('ko-KR')}).`);
  if (rowGap > rTol) reasons.push(`행 ${rowGap}건이 결과에도 제외에도 없습니다 — 누락 확인 필요.`);
  return { status: reasons.length ? 'warn' : 'pass', reasons, recon };
}
```

그리고 `module.exports` 에 `parseRecon, judgeRecon` 추가:
```js
module.exports = { judgeLedgerRun, formatVerdictKorean, countNonEmptyRows, autocheckLedger, parseRecon, judgeRecon };
```

- [ ] **Step 4: 통과 확인** — Run: `node tests/ledger-autocheck.test.js` → `PASS ledger-autocheck`

- [ ] **Step 5: 커밋**
```bash
git add lib/ledger-autocheck.js tests/ledger-autocheck.test.js
git commit -m "feat(autocheck): parseRecon+judgeRecon — 스크립트 검산표로 합계·행 균형 판정" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: `autocheckLedger` 통합 + 표시

**Files:** Modify `lib/ledger-autocheck.js`, Test `tests/ledger-autocheck.test.js`

- [ ] **Step 1: 실패 테스트 추가** — `console.log('PASS ledger-autocheck');` 앞에 삽입:

```js
  // --- autocheckLedger: recon 있으면 합계 검산 반영 (가짜 ExcelJS) ---
  {
    const fakeWs = { rowCount: 3, getRow: () => ({ eachCell: (opt, cb) => cb({ value: 'x' }) }) };
    function FakeWB() { this.worksheets = [fakeWs]; this.xlsx = { readFile: async () => {} }; }
    const stdout = '[RECON] {"raw_rows":10,"raw_total":1000,"excluded_rows":0,"excluded_total":0,"out_rows":10,"out_total":900}';
    const v = await ac.autocheckLedger({ files: [{ name: 'a.xlsx', relPath: 'a.xlsx' }], dir: '/tmp', stdout }, { ExcelJS: { Workbook: FakeWB } });
    assert.strictEqual(v.status, 'warn');       // 1000 ≠ 900+0 → 합계 불일치
    assert.ok(/합계/.test(v.text));              // 표시에 사유
    assert.ok(v.recon && v.recon.raw_total === 1000);
  }
  // --- recon 없으면 기존 보수적 점검 그대로(폴백) ---
  {
    const fakeWs = { rowCount: 3, getRow: () => ({ eachCell: (opt, cb) => cb({ value: 'x' }) }) };
    function FakeWB() { this.worksheets = [fakeWs]; this.xlsx = { readFile: async () => {} }; }
    const v = await ac.autocheckLedger({ files: [{ name: 'a.xlsx', relPath: 'a.xlsx' }], dir: '/tmp', stdout: '[OK]' }, { ExcelJS: { Workbook: FakeWB } });
    assert.strictEqual(v.status, 'pass');
    assert.ok(!v.recon);
  }
```

- [ ] **Step 2: 실패 확인** — Run: `node tests/ledger-autocheck.test.js` → FAIL (status 'pass'거나 recon undefined).

- [ ] **Step 3: 구현** — `autocheckLedger` 의 마지막 부분을 교체. 현재:
```js
  const verdict = judgeLedgerRun({ files: rowInfo, stdout });
  verdict.text = formatVerdictKorean(verdict);
  return verdict;
```
→ 다음으로:
```js
  const verdict = judgeLedgerRun({ files: rowInfo, stdout });
  const recon = parseRecon(stdout);
  if (recon) {
    const rv = judgeRecon(recon);
    verdict.recon = recon;
    if (rv.status === 'warn' && verdict.status === 'pass') verdict.status = 'warn';
    verdict.reasons = verdict.reasons.concat(rv.reasons);
  }
  verdict.text = formatVerdictKorean(verdict);
  return verdict;
```

그리고 `formatVerdictKorean` 의 summary 줄 다음에 recon 줄 추가. 현재:
```js
  if (verdict.summary) {
    lines.push(` · 생성 파일 ${verdict.summary.fileCount}개 · 데이터 행 합계 ${verdict.summary.totalRows}행`);
  }
```
→ 바로 다음에:
```js
  if (verdict.recon) {
    const r = verdict.recon;
    const won = (x) => (Number(x) || 0).toLocaleString('ko-KR');
    lines.push(` · 검산: 입력 ${r.raw_rows}행 ${won(r.raw_total)} = 결과 ${r.out_rows}행 ${won(r.out_total)} + 제외 ${won(r.excluded_total)}${r.excluded_note ? '(' + r.excluded_note + ')' : ''}`);
  }
```

- [ ] **Step 4: 통과 확인** — Run: `node tests/ledger-autocheck.test.js` → `PASS ledger-autocheck`

- [ ] **Step 5: 커밋**
```bash
git add lib/ledger-autocheck.js tests/ledger-autocheck.test.js
git commit -m "feat(autocheck): autocheckLedger가 recon 검산 우선 적용+표시, 없으면 폴백" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `make_persys.py` `[RECON]` 출력 (레퍼런스)

**Files:** Modify `.claude/skills/persys-ledger/scripts/make_persys.py`

근거: `SKIP_ITEMS={'매출할인'}`(34줄), 데이터 루프 230-244줄, `supply_amt=row[8]`(238줄), 항목명 `item=row[4]`(234줄).

- [ ] **Step 1: import json 보장** — 파일 상단 import 블록에 `import json` 이 없으면 추가(있으면 생략).

- [ ] **Step 2: 카운터 + 출력 추가** — 루프(230-244줄)를 카운터가 들어가게 수정. 현재 루프 시작/끝에 카운터를 끼운다. 구체적으로 `projects = {}` 다음 줄에 카운터 초기화:
```python
    recon_raw_rows = 0; recon_raw_total = 0.0
    recon_excluded_rows = 0; recon_excluded_total = 0.0
    recon_out_rows = 0; recon_out_total = 0.0
```
그리고 루프 안에서 `if row[0] is None: continue` 바로 다음에:
```python
        _supply = row[8] or 0
        recon_raw_rows += 1; recon_raw_total += _supply
        if row[4] in SKIP_ITEMS:
            recon_excluded_rows += 1; recon_excluded_total += _supply
```
그리고 `projects[proj][cat].append((...))` 바로 다음 줄에:
```python
        recon_out_rows += 1; recon_out_total += (supply_amt or 0)
```
그리고 `[OK]`/`[WARN]` 출력 블록(246-250줄) **다음**에:
```python
    print('[RECON] ' + json.dumps({
        'raw_rows': recon_raw_rows, 'raw_total': round(recon_raw_total),
        'excluded_rows': recon_excluded_rows, 'excluded_total': round(recon_excluded_total),
        'excluded_note': '매출할인', 'out_rows': recon_out_rows, 'out_total': round(recon_out_total),
    }, ensure_ascii=False))
```

- [ ] **Step 3: 파이썬 문법 검사** — Run: `python -m py_compile ".claude/skills/persys-ledger/scripts/make_persys.py"` (또는 `py -3 -m py_compile ...`)
Expected: 출력 없음, exit 0.

- [ ] **Step 4: 수동 스모크(실서버 1회)** — 실제 퍼시스 판매현황+템플릿으로 마감 실행 → 메시지에 `📋 자동점검: ✅ 점검 통과 · 검산: 입력 N행 ... = 결과 ... + 제외 ...` 가 보이면 정상. (배포 후 사장님 확인.)

- [ ] **Step 5: 커밋**
```bash
git add ".claude/skills/persys-ledger/scripts/make_persys.py"
git commit -m "feat(persys): [RECON] 검산표 출력 — 원본/결과/제외 합계·행수" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `buildGenerationInstruction` 에 `[RECON]` 지시

**Files:** Modify `lib/ledger-router.js`, Test `tests/ledger-router.test.js`

- [ ] **Step 1: 실패 테스트 추가** — `tests/ledger-router.test.js` 의 `buildGenerationInstruction` 테스트 블록에 한 줄 추가:
```js
  assert.ok(/RECON/.test(t), '생성 지시문에 [RECON] 출력 요구가 있어야 함');
```

- [ ] **Step 2: 실패 확인** — Run: `node tests/ledger-router.test.js` → FAIL.

- [ ] **Step 3: 구현** — `buildGenerationInstruction` 의 마지막 안내 줄(`※ 이 결과는 아직 "임시(미승인)"...`) **앞**에 한 줄 추가:
```js
    '6) 결과 생성 후 stdout 에 검산표 한 줄을 출력합니다: [RECON] {"raw_rows":N,"raw_total":원본공급가액합,"excluded_rows":N,"excluded_total":제외합,"excluded_note":"사유","out_rows":N,"out_total":결과공급가액합} (원본=결과+제외 가 맞아야 함).',
```

- [ ] **Step 4: 통과 확인** — Run: `node tests/ledger-router.test.js` → `PASS ledger-router`

- [ ] **Step 5: 커밋**
```bash
git add lib/ledger-router.js tests/ledger-router.test.js
git commit -m "feat(generate): AI 생성 스크립트도 [RECON] 검산표 출력하도록 지시" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 완료 기준
- `node tests/ledger-autocheck.test.js` · `node tests/ledger-router.test.js` → PASS
- `python -m py_compile make_persys.py` → 오류 없음
- (실서버) 퍼시스 마감 시 `검산: 입력=결과+제외` 줄 표시, 합계 안 맞으면 🚩
- recon 없는 기존 스킬은 보수적 점검 그대로(회귀 없음)

## 다음 (이 계획 밖)
- B 입력정규화(.xls/.csv→.xlsx) · C 미리보기 충실도 · 나머지 4개 스크립트 [RECON] 점진
