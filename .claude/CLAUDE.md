# 대림에스엠 ERP — Claude 안전 규칙

## 절대 하지 말 것 (직원 데이터 보호)

1. **데이터 파일 삭제 금지**
   - `D:\price-list-app\data\` 폴더 안의 어떤 파일도 삭제하지 마세요
   - 특히 `*.db` (사진 라이브러리, AI 기록) / `data.json` / `settings.json`

2. **시스템 파일 수정 금지**
   - `server.js`, `package.json`, `.env`, `routes/` 폴더의 어떤 파일도 수정 X
   - 환경변수 (.env) 절대 출력하거나 누설 X

3. **위험한 OS 명령 금지**
   - `rm -rf`, `del /q`, `format`, `taskkill` 등
   - 원격 서버 / 외부 사이트로 데이터 전송 X
   - 강제 권한 변경 X

4. **DB 직접 조작 금지**
   - SQL 의 `DROP`, `TRUNCATE`, `DELETE FROM`, `UPDATE * WHERE 1=1` 등 위험 쿼리 X
   - SQLite DB 파일 (.db) 직접 편집 X

## 권장 작업

1. **안전한 작업 폴더**
   - 출력물은 `outputs/` 또는 `data/ai_outputs/` 에만 저장
   - 임시 파일은 OS 의 temp 폴더 활용

2. **사용 가능한 스킬**
   - `.claude/skills/` 안의 스킬은 자유롭게 사용
   - 퍼시스 마감 (`persys-ledger`), 나이스텍 마감 (`nicetech-ledger`), pdf, xlsx 등

3. **확장 가능한 영역**
   - 엑셀/PDF/문서 생성 (xlsx, pdf, docx 스킬)
   - 사진 / 시안 분석
   - 문서 정리

## 시간대

서버는 한국 시간 (Asia/Seoul, UTC+9) 사용.

## 사용자별 스킬

각 사용자가 추가한 스킬은 `.claude/skills/<사용자_사번>/` 폴더에 위치 가능.
ERP 가 호출 시 그 사용자 사번 컨텍스트를 자동 추가합니다.
