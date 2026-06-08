# 시안검색 폴더 증분 인덱싱 + 디스크 캐시 — 설계 스펙

- 날짜: 2026-06-08
- 대상 파일: `routes/design.js` (단일 파일)
- 런타임 생성 파일: `data/design-index-cache.json` (파생 캐시)
- 상태: 승인됨 (구현 대기)

## 1. 배경 / 문제

시안검색 인덱싱은 현재 **재인덱싱할 때마다 `D:\`(DESIGN_ROOT) 전체를 처음부터 다시 스캔**한다.

- `buildDesignIndexAsync()` — 루트부터 깊이 8까지 모든 폴더를 `readdirSync`, 대상 파일마다 `fs.statSync`로 mtime 읽기
- `runDesignIndex()` — 스캔 결과로 `designIndex` 배열을 통째로 교체
- 트리거 3종 모두 전체 재스캔: ① 서버 시작 5초 후 ② 30분 자동 주기 ③ 재인덱싱 버튼(`/design/reindex`)

파일이 많을수록 매 재인덱싱이 오래 걸려 사용자가 기다린다. 변경된 폴더가 하나여도 전체를 다시 읽는 게 핵심 낭비다.

추가로, 인덱스는 메모리에만 존재하므로 **서버 재시작 직후 첫 전체 스캔이 끝날 때까지 검색 결과가 0**이다. (재인덱싱 중 검색은 원자적 교체 덕에 이미 동작 — 예전 인덱스로 응답. 빈 구간은 오직 재시작 직후 첫 스캔뿐.)

## 2. 목표 / 비목표

**목표**
- 변경된 폴더만 다시 스캔하고, 변경 없는 폴더는 이전 결과를 재사용해 재인덱싱 시간을 대폭 단축
- 추가/삭제/이름변경은 정확히 반영
- 내용만 수정된 파일(같은 이름 덮어쓰기)의 mtime staleness는 주기적 전체 재스캔으로 자가 보정
- **인덱스를 디스크에 영속화**해 서버 재시작 직후에도 즉시 검색 가능(빈 구간 제거). 폴더 캐시도 함께 저장해 재시작 후 첫 스캔도 증분으로 수행
- 외부 인터페이스(item 구조, API 응답 형식) 불변 → 프론트엔드/다른 라우터 수정 불필요

**비목표 (YAGNI)**
- `fs.watch` 실시간 감시 (D드라이브 전체 감시는 성능 저하로 이미 제거된 방식)
- DB 도입 (캐시는 단일 JSON 파일로 충분)

## 3. 설계

### 3.1 폴더 캐시 (인메모리)

모듈 레벨에 폴더별 캐시 Map 추가:

```
designDirCache: Map<절대폴더경로, { mtimeMs, items[], subdirs[] }>
```

- `mtimeMs` — 마지막 스캔 시점의 폴더 수정시각
- `items` — 그 폴더에 직접 있는 파일 항목 객체 배열 (현재 인덱스에 들어가는 객체 그대로)
- `subdirs` — 하위 폴더 절대경로 목록 (SKIP_DIRS·dot/$ 필터가 이미 적용된 상태로 저장 → 재사용 시 그대로 재귀)

추가 모듈 상태:
- `lastFullScanAt: number` — 마지막 전체 스캔 시각(ms). 안전망 판단용.

### 3.2 증분 순회 알고리즘

`buildDesignIndexAsync(rootPath, { force = false })` 를 다음과 같이 변경한다.

```
items = []
visited = Set()               // 이번 실행에서 도달한 폴더 (prune용)
dirsScanned = 0, dirsReused = 0, dirCount = 0
queue = [{ dir: rootPath, depth: 0 }]

while queue:
  { dir, depth } = queue.shift()
  if depth > 8: continue
  visited.add(dir)
  dirCount++
  if dirCount % 20 == 0: await setImmediate   // 이벤트 루프 양보

  try curMtime = statSync(dir).mtimeMs
  catch: designDirCache.delete(dir); continue   // 사라진 폴더 방어

  cached = designDirCache.get(dir)
  if !force and cached and cached.mtimeMs == curMtime:
      // ── 재사용 경로: readdir + 파일별 stat 전부 스킵
      dirsReused++
      items.push(...cached.items)
      for sub in cached.subdirs: queue.push({ dir: sub, depth: depth+1 })
      continue

  // ── 스캔 경로: 변경/신규/force
  dirsScanned++
  try entries = readdirSync(dir, { withFileTypes: true })
  catch: designDirCache.delete(dir); continue

  aiSet = (그 폴더의 .ai 파일 basename 집합)   // 현재 로직 그대로
  dirItems = []; subdirs = []
  for entry in entries:
    if entry.name startsWith '.' or '$': continue
    if SKIP_DIRS.has(entry.name.toLowerCase()): continue
    fullPath = join(dir, entry.name)
    if entry.isDirectory():
      subdirs.push(fullPath)
      queue.push({ dir: fullPath, depth: depth+1 })
    else:
      // 현재의 파일 항목 생성 로직 그대로 (ext 필터, fileType, aiPath 연결,
      //  mtime statSync, searchText 생성) → item 만들어 dirItems.push(item)
  designDirCache.set(dir, { mtimeMs: curMtime, items: dirItems, subdirs })
  items.push(...dirItems)

// prune: 이번 실행에서 도달하지 못한 캐시 항목 제거 (메모리 누수 방지)
for key in designDirCache.keys():
  if !visited.has(key): designDirCache.delete(key)

return { items, dirsScanned, dirsReused }
```

**핵심 성질**
- 폴더당 `statSync` 1회는 항상 발생(자식 변경은 부모 mtime을 바꾸지 않으므로 모든 폴더를 stat해 mtime을 확인해야 함). 이게 비용의 하한이며 `fs.watch` 없이는 피할 수 없다.
- 변경 없는 폴더는 비싼 `readdir` + 파일별 `statSync`를 모두 건너뛴다.
- 비용: 현재 `(폴더수 readdir + 파일수 stat)` → 증분 `(폴더수 stat + 변경폴더의 readdir/파일stat)`.
  - 예) 파일 5만·폴더 5천, 변경 없음: 현재 `readdir 5천 + stat 5만` → 증분 `stat 5천`만.

### 3.3 삭제 / 이동 처리

- 폴더 내 파일 삭제/이름변경 → 그 폴더 mtime 변경 → 재스캔 → 정확 반영
- 폴더째 삭제 → 부모 폴더 mtime 변경 → 부모 재스캔 → 새 `subdirs`에서 빠짐
- 재사용된 부모의 `subdirs`에는 항상 실재하는 폴더만 존재(자식 삭제는 부모 mtime을 바꾸므로 부모가 재사용되지 않음). 그래도 stat 실패 시 `catch`로 안전 스킵.
- prune 단계가 도달 불가 캐시 항목을 정리.

### 3.4 주기적 전체 재스캔 안전망

내용만 수정(같은 이름 덮어쓰기)된 파일은 폴더 mtime이 안 바뀔 수 있어 mtime이 stale해질 수 있다(정렬·년도필터에만 영향). 이를 자가 보정:

- 30분 자동 주기는 유지.
- 각 회차에서 `!lastFullScanAt || (now - lastFullScanAt) >= FULL_RESCAN_MS` 이면 그 회차를 `force=true`(전체 스캔)로 실행.
- `FULL_RESCAN_MS` 기본 6시간, `process.env.DESIGN_FULL_RESCAN_MS`로 조정 가능.
- 첫 스캔은 (디스크 캐시 없을 때) 캐시가 비어 자동 전체 스캔.

### 3.5 재인덱싱 버튼 (`POST /design/reindex`)

- 기본 **증분**(빠름 — 사용자 대기 해소).
- `?full=1`(또는 body `{ full: true }`)이면 강제 전체 스캔 escape hatch.
- 응답 메시지에 모드 표기.

### 3.6 상태 표시 강화 (`designIndexStatus`)

기존 필드(`built`, `building`, `count`, `lastBuilt`, `error`)는 **그대로 유지**하고 아래를 추가:

- `lastMode`: `'full' | 'incremental'`
- `lastFullBuilt`: 마지막 전체 스캔 ISO 시각
- `durationMs`: 직전 실행 소요시간
- `dirsScanned`, `dirsReused`: 스캔/재사용 폴더 수
- `fromDisk`: 디스크 캐시에서 로드된 인덱스로 동작 중인지

→ `/design/status`·`/design/search`·`/design/debug` 응답에 자연 노출. 소비처는 status를 그대로 패스스루하므로 필드 추가는 안전.

`runDesignIndex(opts)`는 `mode = (opts.force || designDirCache.size === 0) ? 'full' : 'incremental'`로 판정하고, 완료 시 `mode==='full'`이면 `lastFullScanAt`과 `lastFullBuilt` 갱신. 매 성공 실행 후 `invalidateDesignWorkflowOptions()` 호출(현행 유지) + 디스크 저장 트리거(3.7).

### 3.7 디스크 캐시 (영속화) — 재시작 시 즉시 검색

폴더 캐시를 디스크에 저장해 **서버 재시작 직후 '검색 결과 0' 구간을 제거**한다.

**저장 위치**: `data/design-index-cache.json` (재생성 가능한 파생 캐시 — 삭제해도 자동 재생성)

**저장 포맷**:
```
{
  version: 1,
  designRoot: "D:\\",          // DESIGN_ROOT 불일치 시 캐시 무시
  savedAt: ISO,
  dirs: [ { dir, mtimeMs, subdirs[], items[] }, ... ]   // designDirCache 직렬화
}
```

**쓰기** (`saveIndexCacheToDisk`):
- 매 성공 빌드(full/증분) 완료 후 백그라운드 **비동기** 저장.
- 임시파일(`*.tmp`)에 쓴 뒤 `rename`으로 **원자적 교체** → 부분 손상 방지.
- building 가드로 빌드가 겹치지 않으므로 쓰기도 자연히 분산됨.
- 쓰기 실패(권한 등)는 로그만 남기고 인덱싱 자체는 정상 동작(다음 빌드에 재시도).

**읽기** (`loadIndexCacheFromDisk`, 서버 시작 시):
1. 시작 시 캐시 파일 로드 시도.
2. 유효하면(version·designRoot 일치, JSON 정상) → `designDirCache` 복원 + `designIndex`를 dirCache의 items 평탄화로 **즉시 재구성** → 검색 바로 가능. `designIndexStatus`: `built=true`, `fromDisk=true`, `count=로드수`.
3. 그 후 5초 뒤 정기 인덱서가 **증분 빌드**로 실행되어, 서버가 꺼져 있던 동안의 변경을 반영(이때 검색은 로드된 인덱스로 계속 동작).
4. 캐시 없음/손상/버전·루트 불일치 → 무시하고 기존처럼 첫 전체 스캔(현재 동작과 동일, 안전한 폴백).

**무결성/안전**:
- 로드는 `try/catch`로 감싸 손상 시 폴백.
- 서버 꺼진 동안의 내용수정(in-place) staleness는 6시간 전체 재스캔(또는 버튼 `?full=1`)으로 보정(증분 한계와 동일, 수용).
- 사용자 데이터 파일이 아닌 **자체 파생 캐시만** 기록/원자적 교체 → CLAUDE.md 데이터 보호 규칙(데이터 파일 삭제 금지) 위배 없음.

## 4. 변경 범위

> **구조 결정**: 스펙 초안은 "routes/design.js 단일 파일"이었으나, 그 파일은 require 시 `../db`·`../middleware/auth`를 로드하고 `startDesignIndexer()`가 자동 실행되어 단위 테스트가 불가능하다. 따라서 인덱싱 순수 로직을 `routes/lib/design-indexer.js`로 분리한다 — 이는 이미 존재하는 `routes/lib/design-workflow-storage.js`·`design-parser.js`·`workflow-storage-rules.js`와 동일한 관례다.

- 신규: `routes/lib/design-indexer.js` — 순수 로직 (fs/path만 의존)
  - `buildDesignIndex(rootPath, { force, cache, skipDirs, indexedExts, extToType, maxDepth, onProgress })`
  - `serializeCache`, `deserializeCache`, `loadIndexCache`, `saveIndexCache`, `buildFileItem`
- 신규(테스트): `routes/lib/design-indexer.test.js`, `routes/lib/design-indexer.cache.test.js` (내장 `node:test`)
- 수정: `routes/design.js` — 얇은 소비자로 전환
  - `buildDesignIndexAsync` 인라인 로직 제거 → `designIndexer.buildDesignIndex` 호출
  - `runDesignIndex(opts)` — force/mode 처리 + 상태 필드 확장 + 완료 후 디스크 저장
  - `startDesignIndexer()` + `loadDesignCacheAtStartup()` — 시작 시 디스크 캐시 로드 + 안전망(주기적 force)
  - `POST /design/reindex` — full 파라미터 처리
  - 모듈 상태/상수 추가: `designDirCache`, `lastFullScanAt`, `FULL_RESCAN_MS`, `INDEX_CACHE_PATH`, `MAX_DEPTH`
- 런타임 생성: `data/design-index-cache.json` (파생 캐시, 커밋 대상 아님)
- 불변: 파일 item 객체 구조(`searchText`는 Windows 출력 바이트 동일, 경로 구분자 정규식만 `[\\/]`로 확장), 모든 API 응답 형식, 프론트엔드, 다른 라우터(`design-workflow-storage` 등 소비처)

## 5. 엣지 케이스

- 비대상 파일(.txt 등)만 추가돼 폴더 mtime이 바뀐 경우: 재스캔하되 인덱스 결과는 동일(약간의 낭비, 정확성 OK).
- 깊이 8 제한·SKIP_DIRS·dot/$ 필터: 현재와 동일하게 적용(캐시된 subdirs도 이미 필터된 값).
- 동시 실행 방지: 기존 `building` 가드 유지.
- 이벤트 루프 양보: 폴더 20개마다 `setImmediate` (재사용 경로는 I/O가 없어 빠르게 진행되므로 폴더 기준으로 양보).
- 루트 경로 없음(`fs.existsSync(DESIGN_ROOT)` 실패): 현재처럼 error 설정 후 반환.
- 디스크 캐시 손상/버전불일치/루트변경: 무시하고 전체 스캔 폴백.
- 디스크 쓰기 실패(권한 등): 로그만 남기고 인덱싱 정상 동작.
- 서버 꺼진 동안 파일 변경: 재시작 후 증분 빌드가 폴더 mtime 변경분 반영, in-place 내용수정은 6시간 안전망으로 보정.

## 6. 검증 계획

- **로직 단위 검증**: 임시 폴더 트리 생성 → build → 파일 추가/삭제/내용수정 → 재build → `dirsReused`/`dirsScanned`와 결과 항목이 기대대로인지 assert (OS 무관, 샌드박스에서도 가능).
- **디스크 캐시 검증**: 빌드 후 `data/design-index-cache.json` 생성 확인 → 캐시 로드 후 `designIndex` 재구성 결과가 빌드 결과와 동일한지 확인 → 캐시 파일 손상시켜 폴백(전체 스캔) 동작 확인.
- **실서버 확인(서버 PC)**: 콘솔 로그에 `incremental 완료 ... 재사용 N / durationMs` 출력, 2회차 `durationMs` 급감 확인. 서버 재시작 직후 첫 검색 요청이 (디스크 캐시 로드로) 즉시 결과를 반환하는지 확인.
- **`/design/status`**: `lastMode`, `dirsReused`, `durationMs`, `fromDisk` 노출 확인.
- **정확성**: 새 파일이 증분 후 검색되고, 삭제 파일이 사라지는지 확인.

## 7. 리스크 / 트레이드오프

- 내용수정 파일 mtime staleness → 6시간 전체 재스캔으로 보정(수용됨).
- 메모리: 캐시는 item을 참조로 보유(인덱스와 객체 공유) + 폴더당 소량 메타. 사실상 인덱스 1벌 수준, 허용 범위.
- 폴더당 stat 1회는 유지(하한). 폴더 수가 매우 많아도 파일 stat 제거 효과가 지배적.
- 디스크 캐시 파일 크기: 항목 수에 비례(수만 개 시 십수 MB JSON). 비동기 원자적 쓰기로 블로킹 최소화. `JSON.stringify`는 동기지만 수십 ms 수준으로 허용.
