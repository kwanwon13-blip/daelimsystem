# ERP AI 업무 처리기 — 4단계: 결재 통합 배선 (라이브 실행 계획)

> **주의:** 이 계획은 **운영 중인 결재 시스템 + 프론트엔드**를 건드린다. 샌드박스에서 단위테스트가 안 되는 부분(프론트 Alpine 렌더, 라이브 결재 흐름)이 있으므로 **서버에서 단계별로 확인하며** 실행한다. 실제 휴가·인사 결재가 깨지지 않게 주의.

**상태:** 백엔드 엔진은 완성·테스트됨(커밋 `b3a0ce6`).
- `lib/skill-promote.js` — 승인된 작업을 재사용 스킬로 저장(SKILL.md+make_generated.py+템플릿+레지스트리).
- `lib/skill-registry.js` — 번들+동적 스킬 해석.
- `lib/agent-runtime.js` — 게이트(583/589)가 `reusableScriptName`로 동적 스킬도 탐지·실행.

**이 계획이 배선하는 것(남은 부분):** 생성(generate) 결과 → 결재 생성 → 승인(등록)→promote / 고쳐서 다시 / 반려 → 프론트 3버튼·미리보기.

---

## 데이터 흐름

```
[Phase 3 generate 모드] 일반 에이전트가 결과 xlsx + make_generated.py 생성 (workspace)
   │  (generate 완료 감지)
   ▼
[Task A] 산출물을 "승인 대기 보관함"으로 안정 복사:
   data/ai-pending-skills/<approvalId>/  ← make_generated.py, 결과.xlsx, 전월양식.xlsx, meta.json
   + 결재 문서 1건 생성 (type:'ai_task', status:'pending', formData에 위 경로·자동점검·거래처명)
   ▼
[사장님] 결재함에서 확인 (알림·뱃지는 기존 결재 메커니즘으로 자동)
   ├─ 등록  → [Task B] promoteSkill(pending → .claude/skills/<slug>) → 다음부터 자동 재사용
   ├─ 고쳐서 다시 → [Task B] 보관 원본+양식+사장님 코멘트로 generate 재실행 → 새 대기건
   └─ 반려  → pending 폴더 정리, 문서 rejected
```

**핵심 설계:** workspace 는 휘발성이라, 승인 시점에 쓸 수 있도록 generate 완료 즉시 **안정 폴더(`data/ai-pending-skills/<approvalId>/`)로 복사**하고 그 경로를 결재 formData 에 보관한다.

---

## Task A — generate 완료 → 결재 생성 (백엔드)

**신규 파일:** `lib/ai-task-approval.js`
- `capturePending({ approvalId, workspaceDir, files, scriptName='make_generated.py', templatePath, vendorName, check })`
  - `data/ai-pending-skills/<approvalId>/` 생성, make_generated.py·결과 xlsx·템플릿 복사, `meta.json`(vendorName, check, 파일목록) 기록. 복사된 경로 반환.
- `createAiTaskApproval(db, { authorId, authorName, approverId, approverName, vendorName, pendingDir, resultFiles, check })`
  - `uData = db.loadUsers(); uData.approvals.push({ id: db.generateId('appr'), type:'ai_task', title:`[AI] ${vendorName} 마감 — 새 작업유형 등록`, status:'pending', authorId, authorName, approverId, approverName, effectiveApproverId:approverId, companyId:'dalim-sm', formData:{ vendorName, pendingDir, resultFiles, check, scriptName:'make_generated.py' }, createdAt }); db.saveUsers(uData);`
  - 가능하면 `notify(approverId, 'approval', '[AI] 새 작업유형 승인 대기', 'approvals')`.
- **순수 분리:** `buildAiTaskDoc({...})` (doc 객체 생성, db 없이) → 단위테스트 대상. `createAiTaskApproval` 은 그 위에 db 저장만.

**테스트:** `tests/ai-task-approval.test.js` — `buildAiTaskDoc` 가 type/status/formData 필드를 올바로 만드는지(가짜 generateId 주입), `capturePending` 가 temp dir 에 파일·meta.json 복사하는지(Phase4 엔진 테스트 방식과 동일하게 os.tmpdir).

**배선 (agent-runtime.js):** generate 모드(=`generationPrefix` 설정됨)로 돌린 일반 에이전트가 **성공 완료**하는 지점(일반 에이전트 done 직전, 현재 ≈1013줄 부근)에서:
- `generationPrefix` 가 비어있지 않고(=generate 모드) 산출 파일이 있으면 → `approvalId = db.generateId('appr')`; `capturePending(...)`; `createAiTaskApproval(...)`; 결과 메시지에 "📋 사장님 결재함에 '등록 대기'로 올렸어요" 한 줄.
- approverId 결정: 관리자(사장님) userId. (설정에서 읽거나 admin 역할 사용자 첫 명. 구현 시 확인.)
- **승인자(approverId) 출처는 구현 시 확정** — 설정값/관리자 자동선택. (라이브 확인 필요)

> 라이브 확인: generate 1회 → `data/ai-pending-skills/<id>/` 생성 + 결재함에 'ai_task' pending 뜨는지.

---

## Task B — 승인 핸들러: 등록 / 고쳐서 다시 / 반려 (백엔드)

**수정:** `routes/approvals.js` 승인처리 핸들러(`POST /:id/process`, ≈293~415줄, `action==='approved'` 이후 타입별 분기).
- `if (doc.type === 'ai_task' && action === 'approved')` →
  ```js
  const { promoteSkill } = require('../lib/skill-promote');
  const fd = doc.formData || {};
  const promoted = promoteSkill({
    vendorName: fd.vendorName,
    scriptSrcPath: path.join(fd.pendingDir, fd.scriptName || 'make_generated.py'),
    templateSrcPath: /* fd.pendingDir 안 전월양식 */,
    skillsRoot: path.join(APP_ROOT, '.claude', 'skills'),
    templateRoot: path.join(APP_ROOT, 'data', 'ai-skill-templates'),
    registryPath: path.join(APP_ROOT, 'data', 'ai-skill-registry.json'),
    addedAt: new Date().toISOString(),
  });
  // doc.formData.promotedSlug = promoted.slug; (기록)
  ```
  → 이후 같은 거래처는 라우터가 자동 인식·실행(엔진 이미 완성).
- **고쳐서 다시**: 표준 결재엔 없는 액션. `action==='redo'` (또는 `formData.redoNote`) 추가 → 보관 원본+양식+사장님 코멘트로 generate 재실행을 트리거하고, 기존 문서는 `status:'redone'`, 새 대기건 생성. (재실행 트리거 방법은 라이브에서 확정 — 동기 호출 vs 큐.)
- **반려**: 기존 `rejected` 그대로 + `data/ai-pending-skills/<id>/` 정리(선택).

**주의:** 이 핸들러는 모든 결재(휴가·인사 등)가 지나는 곳. `doc.type==='ai_task'` 가드 안에서만 동작하게 해 **기존 타입 경로를 절대 안 건드리게** 한다. 변경 후 일반 결재 승인/반려가 정상인지 라이브 회귀 확인.

---

## Task C — 프론트엔드: 유형 표시 + 미리보기 + 3버튼 (브라우저 검증 필수)

**`public/approval.js`**
- `typeLabel()`/`typeIcon()` (≈572~576줄)에 `ai_task` 케이스: 라벨 "AI 작업 승인", 아이콘 🤖.
- 함수 추가: `aiTaskAction(id, action)` → `POST /api/approvals/:id/process` 에 `{ action }`('approved'|'redo'|'rejected'), redo면 코멘트 prompt.

**`public/tab-approval.html`**
- 목록 유형 칩(≈176~180): `ai_task` 색/아이콘.
- 상세뷰(≈620~650): `selectedDoc.type==='ai_task'` 면 formData 의 거래처명·자동점검 요약 + **결과 파일 미리보기/다운로드 링크**(artifact 다운로드 방식 재사용) 카드.
- 액션영역(≈710~726): `ai_task` 면 `[✅ 등록] [✏️ 고쳐서 다시] [❌ 반려]` 3버튼 → `aiTaskAction(...)`.

**검증:** 브라우저에서 결재함 진입 → ai_task 문서 열기 → 3버튼·미리보기 렌더 확인. (단위테스트 불가 → 수동.)

---

## 라이브 실행 순서 (안전)
1. Task A 백엔드 + 테스트 → generate 1회로 pending 폴더+결재 생성 확인.
2. Task C 프론트 → 결재함에서 ai_task 문서가 보이고 3버튼 렌더 확인.
3. Task B 승인 핸들러 → "등록" 눌러 promote → 같은 거래처 재업로드 시 자동 실행 확인. **그 전후로 일반 결재(휴가 등) 승인/반려 회귀 확인.**
4. "고쳐서 다시"·"반려" 흐름 확인.

## 리스크 / 가드
- 운영 결재 핸들러·프론트 변경 → **`type==='ai_task'` 분기 안에서만** 동작, 기존 타입 무영향 보장.
- 가능하면 서버 PC 배포 전 로컬에서 먼저 전 과정 확인.
- pending 폴더(`data/ai-pending-skills/`)는 `data/` 안이라 삭제 금지 규칙 대상 — 정리는 해당 폴더만 신중히.

## 완료 기준
- generate → 결재함 'AI 작업 승인' 대기 → 사장님 [등록] → 같은 거래처 다음 파일이 **자동(아는 작업)으로** 처리됨.
- 일반 결재 회귀 이상 없음.
