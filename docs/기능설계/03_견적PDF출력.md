# 1-3. 견적서 PDF 출력 개선

- **난이도**: 하 | **효과**: 상
- **참고**: ERPNext Print Format, SolidInvoice

## 현황
- 현재 PDF 출력 기능 존재 (server.js ~48줄 quote-print.html 참조)
- 개선 방향: 디자인/레이아웃 개선, 회사 로고/직인 삽입

## 수정 파일
| 파일 | 작업 |
|------|------|
| `public/quote-print.html` | 견적서 출력 템플릿 디자인 개선 |
| `server.js` | GET /api/quotes/:id/pdf 엔드포인트 확인/개선 |
| `public/index.html` | 견적 목록에서 PDF 다운로드 버튼 |

## 개선 내용
- 회사 로고 삽입 (data/logo.png 이미 사용 중)
- 직인 이미지 삽입 옵션 (data/stamp.png)
- 부가세 포함/별도 선택 옵션
- 견적 유효기간 표시
- 현장명, 담당자, 연락처 자동 기입

## 구현 방법
```
현재: puppeteer 또는 html-pdf → quote-print.html 렌더링 → PDF
개선: quote-print.html 템플릿만 수정해도 됨
```
