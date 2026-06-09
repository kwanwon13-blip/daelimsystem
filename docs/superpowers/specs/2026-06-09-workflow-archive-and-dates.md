# 워크플로우 — 완료 명세서(저장내역) + 요청/완료가능일 날짜 역할

작성 2026-06-09. 사장님과 샘플로 합의 완료. 브랜치 `claude/adoring-wozniak-15f7a6`.

## 배경 / 이미 된 것
- 3단계 직선화: **디자인팀 → 대림컴퍼니(내부 id `factory`) → 영업지원팀(내부 id `delivery`)**. 무거운 게이트 제거. (커밋 4cc4f52, 5016c90)
- 카드 인라인 액션 [받기][올리기][다음 단계], 칩 정리, 마감/완료 날짜 배지. (1a23047, 715664c, dc76f3d)
- **완료 코드 자동발번 완료(백엔드)**: `completeWorkflowJob`에서 `job.completionCode = YYYYMMDD-순번(001~)`, 같은 날 002/003…, 완료일 바뀌면 재발번, 완료취소 시 제거. (3ee0125)

## 남은 구현 (이 스펙 범위)

### 1) 요청날짜 / 완료가능일 — 단계(역할)별
- **요청날짜** = `job.dueDate` (디자인이 "언제까지" 정하는 희망일).
- **완료가능일** = `job.factoryAvailableDate` (신규 job 필드, 공장이 정함).
- 카드/상세에서 단계별로:
  - **디자인팀(design)**: 요청날짜 **입력 가능**, 완료가능일 숨김("공장이 정함").
  - **대림컴퍼니(factory)**: 요청날짜 **읽기전용(🔒)**, 완료가능일 **입력 가능** → "완료가능일 넘기기".
  - **영업지원팀(delivery)**: 둘 다 읽기전용 — 영업은 **완료된 것 확인만**(= 아래 명세서).
- 백엔드: `PUT /jobs/:id` (saveJob)에서 `dueDate`는 stage가 design일 때만, `factoryAvailableDate`는 factory일 때만 저장(역할 가드). 또는 전용 엔드포인트.
- 프론트: 카드 날짜 영역을 stage 기준으로 input(편집) vs 잠금 표시. (샘플 = archive-sample 날짜흐름 이미지)

### 2) 완료 명세서 (저장내역) 메뉴 — 영업지원팀 확인 화면
- 데이터: `status==='done'` job 목록 (기존 `GET /api/workflow/jobs?status=done` 재사용, decorateJob이 `completionCode`/`completedAt`/`archiveFileCount`/`completedByName`/`archiveUrl` 노출).
- 표(이카운트 전표식): **코드 | 완료일자 | 업체 | 현장 | 파일 | 작성자 | [보기]**.
  - 코드 = `completionCode` (일별 001, 파란 강조).
  - 완료일자 = `completedAt` — **편집 가능** → 변경 시 코드 재발번 + 목록 재배치.
- 필터: 검색(코드·업체·현장) / 업체 / 완료기간(from~to) / 정렬(완료일 최신·오래된). (샘플 = archive-sample 명세서 이미지)
- [보기] = 명세서 상세(현장·업체·완료일·파일목록 미리보기/다운로드·작성자), [받기] = 완료 ZIP(`archiveUrl`).
- 위치: 워크플로우 탭 내 "완료 명세서"(저장내역) 서브메뉴 또는 상태필터 '완료' 전용 화면.

### 3) 완료일자 편집 엔드포인트
- `PUT /api/workflow/jobs/:id/completion-date` body `{ completedAt }` → `job.completedAt` 갱신 후 `assignCompletionCode(data, job)` 재호출 → 코드 재발번. (또는 saveJob 확장)

## 메일 관련(이미 반영)
- 발행/메일 섹션은 디자인 단계에서만 노출(처음 발주용). 다른 팀은 카드 [받기]로 파일만. (dc76f3d)

## 샘플
- 날짜 흐름 / 명세서 목업: 작업 중 puppeteer 렌더로 사장님 확인 완료(대화 이미지). 임시파일 `archive-sample.html`, `_shot.js` 는 구현 후 정리.
