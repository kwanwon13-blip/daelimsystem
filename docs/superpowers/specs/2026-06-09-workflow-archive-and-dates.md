# 워크플로우 — 단계 흐름 + 완료 명세서(과거내역) + 요청/완료가능일

작성·갱신 2026-06-10. 사장님과 합의 확정. 브랜치 `claude/adoring-wozniak-15f7a6`.

## 확정된 일의 순서 (가장 중요)

보드는 **3칸**, 과거내역은 **별도 메뉴**.

```
① 디자인팀 ──(완료가능일 확정)──▶ ② 대림컴퍼니 ──(완료)──▶ ③ 영업지원팀 ──(수령)──▶ [과거내역 메뉴]
```

| 칸 | 들어오는 조건(=이전 단계의 전환 액션) | 누가 누름 |
|----|----|----|
| **① 디자인팀** | 시안을 **올리면** 여기서 대기 (자동으로 안 넘어감) | 디자인 |
| **② 대림컴퍼니** | 공장(=대림컴퍼니)이 **완료가능일 확정** | 대림컴퍼니(공장) |
| **③ 영업지원팀** | 대림컴퍼니가 **완료** 버튼 | 대림컴퍼니 |
| **과거내역(별도 메뉴)** | 영업지원팀이 **수령(가져오기)** | 영업지원팀 |

- 내부 단계 id 유지: design / factory(=대림컴퍼니) / delivery(=영업지원팀). 과거내역 = `status='done'`.
- **공장 = 대림컴퍼니(제작팀)** 동일.

## 전환 규칙 (구현 핵심 — 현재 코드와 차이 있음)

현재 코드는 단계 핸드오프가 "다음 단계로" 일반 버튼 + 완료 시 `status='done'`. 아래로 바꿔야 함:

1. **디자인팀 → 대림컴퍼니**: 디자인이 올린 시안에 대해 **대림컴퍼니가 완료가능일(`factoryAvailableDate`) 입력·확정** → `currentStage='factory'`로 이동. (디자인의 "보내기" 버튼이 아니라, 대림컴퍼니의 날짜확정이 트리거)
2. **대림컴퍼니 → 영업지원팀**: 대림컴퍼니가 **완료** 버튼 → `currentStage='delivery'` + **이 시점에 completionCode 발번**(= 제작완료일 `factory 완료 누른 날` 기준 `YYYYMMDD-001`). ⚠️ 현재는 `status='done'`일 때 발번하므로 **발번 시점을 이 전환으로 이동** 필요.
3. **영업지원팀 → 과거내역**: 영업지원팀 **수령(가져오기)** 버튼 → `status='done'`(과거내역 보관). 파일은 그대로, archive 메타 기록.

## 요청날짜 / 완료가능일 — 단계별 역할
- **요청날짜** = `job.dueDate` (디자인이 정하는 희망일).
- **완료가능일** = `job.factoryAvailableDate` (신규 job 필드, 대림컴퍼니가 정함 = 디자인→대림 전환 트리거).
- 카드/상세 표시:
  - **디자인팀**: 요청날짜 입력. 완료가능일 숨김.
  - **대림컴퍼니**: 요청날짜 🔒읽기전용. 완료가능일 입력 → 확정 시 자기 칸으로 이동.
  - **영업지원팀**: 둘 다 읽기전용 (완료된 것 수령/확인만).

## 과거내역(완료 명세서) — 별도 메뉴
- 데이터: `status='done'` job. 기존 `GET /api/workflow/jobs?status=done` 재사용(decorateJob이 completionCode/completedAt/archiveFileCount/completedByName/archiveUrl/companyName/projectName 노출).
- 표(이카운트 전표식): **코드 | 완료일자 | 업체 | 현장 | 파일 | 작성자 | [보기][받기]**.
  - 코드 = `completionCode`(일별 001). 완료일자 = `completedAt`, **편집 시 코드 재발번**.
- **필터: 검색(코드·업체·현장) / 업체 / 완료기간 / 정렬**. (회사·프로젝트명 다 저장돼 있으니 검색 가능)
- [받기]=완료 ZIP(`archiveUrl`), [보기]=명세서 상세(현장·업체·완료일·파일목록·작성자).
- 위치: 보드 밖 별도 "완료 명세서/과거내역" 메뉴.

## 이미 된 것 (브랜치 커밋)
- 3단계 직선화 + 게이트 제거(4cc4f52, 5016c90), 카드 인라인 액션·칩·날짜배지(1a23047,715664c,dc76f3d), 메일 디자인단계 한정(dc76f3d).
- 완료코드 발번 함수 `assignCompletionCode`(3ee0125) — ⚠️ 발번 **시점**을 위 전환#2(제작완료)로 옮겨야 함.

## 남은 작업 — ✅ A·B 코드 구현 완료 (2026-06-10)

### A. 날짜 역할 정교화 (요청날짜/완료가능일) — ✅ 완료
- [x] 신규 필드 `job.factoryAvailableDate`(완료가능일) — `normalizeJobPayload` + `decorateJob` 노출. 요청날짜는 기존 `job.dueDate`.
- [x] 백엔드 역할 가드: `routes/lib/workflow-stage-rules.js`의 `applyDateRoleGuard` — `dueDate`는 design, `factoryAvailableDate`는 factory 단계에서만 저장. `PUT /jobs/:id` + `POST /jobs`(생성=design) 적용. 서버가 **기존 저장된 단계** 기준으로 판단 → 클라이언트 우회 불가.
- [x] 프론트 상세: design=요청 입력 / factory=요청🔒+완료가능 입력 / delivery=둘 다 🔒(disabled + 잠금 표시).
- [x] 전환 라벨: `stageHandoffLabel` — design→"완료가능일 확정", factory→"완료", delivery→"수령". 카드/상세 버튼·확인창 공통.
- [x] completionCode 발번을 **factory→delivery(제작완료) 핸드오프**로 이동. `completedAt`/`completionCode`는 제작완료(factory done)에 종속, `status='done'`(수령/보관)과 분리. 수령 시 `ensureStagesDone`으로 전 단계 done 확정(도중 reopen 돼도 코드 유실 방지).
- 테스트: `tests/workflow-stage-rules.test.js`(백엔드 순수 로직), `tests/workflow-frontend-dates-links.test.js`(프론트 헬퍼). 코드리뷰 에이전트 지적(MEDIUM 1·LOW 3) 반영 완료.

### B. 다운로드 터널 연결 — ✅ UI 완료 (서버 인프라만 남음)
- **이미 있음(백엔드)**: 공개 엔드포인트 `/api/workflow/public/files/:token/download`, `/public/jobs/:token/files.zip`; 터널 base는 `publicWorkflowLinkState()`가 env(`WORKFLOW_PUBLIC_BASE_URL`/`CLOUDFLARE_TUNNEL_URL`) 또는 설정(`설정.json` workflow.publicBaseUrl)에서 해석. decorateJob이 `publicArchiveUrl`(상대경로) 노출.
- [x] UI: `jobExternalArchiveUrl`/`hasExternalArchiveLink`/`copyJobExternalLink` — "🔗외부" 링크 복사 버튼. 터널 미설정 시 설정 안내 alert.
  - **2026-06-10 정정(사장님 피드백)**: 처음엔 스펙 글자대로 과거내역·전달(delivery)에만 뒀으나, 실제로 외부 다운로드가 필요한 건 **공장(대림컴퍼니)** 임(터널 자체가 공장 외부접속용). → **모든 칸**에 표시로 변경(파일 있고 터널 켜져 있으면 단계 무관). 과거내역 카드·상세 보관 스트립도 유지.
- [ ] **서버 인프라(코드 밖)**: 서버 PC에서 Cloudflare 터널 실제 구동 + base URL 설정 ([docs/workflow-cloudflare-tunnel.md] 참고). 토큰은 레포에 저장 금지.
- 참고: 공개 ZIP은 기존부터 완료 여부와 무관하게 토큰만으로 열림(이번 변경과 무관). 외부 노출이 걱정되면 `status='done'` 게이팅 추가 검토.

## 샘플
- 날짜흐름·명세서 목업 puppeteer 렌더로 확인됨(대화 이미지). 임시파일 `archive-sample.html`,`_shot.js`는 정리 완료(현재 없음).
