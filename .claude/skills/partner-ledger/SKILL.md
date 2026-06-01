---
name: partner-ledger
description: Use for monthly closing statement workbooks for Hanshin, Yojin, Hongji ENC, Samjin BT, Seondu Engineering, ExteriorN, Korea Geotech, and Geumgwang Steel. Trigger on Korean requests such as 한신공영, 요진건설, 홍지이앤씨, 삼진비티, 선두종합기술, 익스테리어앤, 한국지오텍, 금광스틸, 마감내역서, 판매현황, 현장별 파일 생성, or template registration for these vendors.
---

# Partner Monthly Ledger

For the listed construction partners, do not hand-write a new workbook generator during chat. Run the bundled script.

Supported vendors:
- 한신공영
- 요진건설
- 홍지이앤씨
- 삼진비티
- 선두종합기술
- 익스테리어앤
- 한국지오텍
- 금광스틸

Input:
- Raw workbook: eCount-style `판매현황` sheet with columns `일자-No.`, `거래처명`, `프로젝트명`, `품목명`, `규격`, `수량`, `단가`, `공급가액`.
- Template workbook: partner closing statement format with columns `일자-No.`, `품목명`, `규격`, `수량`, `단가`, `공급가액`.

Rules:
- Group raw rows by vendor and project.
- Create one `.xlsx` per project.
- Copy the template workbook and preserve its first-sheet layout.
- Populate columns A:F.
- In the output workbook, `공급가액` must be a formula: `=수량셀*단가셀` such as `=D2*E2`.
- Use the row's date only on the first line for each date group; subsequent rows on the same date can have a blank date cell.
- If only templates are attached, store them for future runs and report that raw `판매현황` is still needed.

Command:

```bash
python .claude/skills/partner-ledger/scripts/make_partner_ledger.py --raw "<판매현황.xlsx>" --template "<template file or template directory>" --outdir "<output folder>"
```

The response should be brief and should rely on generated files, not a long markdown table.
