---
name: posco-statement
description: Use for POSCO E&C transaction statement PDF generation from eCount 판매현황 workbooks and the POSCO 단가 거래명세서 tool/template. Trigger on 포스코, 포스코이앤씨, POSCO, 거래명세서 PDF, 구매사코드, 적요 코드 such as A283, or template registration for POSCO statements.
---

# POSCO Transaction Statement

For POSCO E&C transaction statements, run the bundled script. Do not hand-build a new generator in chat.

Input:
- Raw workbook: eCount-style `판매현황` sheet with columns `일자-No.`, `거래처명`, `프로젝트명`, `품목명`, `규격`, `수량`, `단가`, `공급가액`, `비고`, `적요`, `적요2`, `적요3`.
- Template workbook: POSCO 거래명세서 tool containing a code table sheet such as `25년 안전용품 단가계약 품목` and a statement sheet such as `오프라인 거래명세서`.

Rules:
- Read only rows whose `적요`/`적요2`/`적요3` contains POSCO item codes such as `A283`, `A257`, `A004`, `A278*5.5`.
- Convert short codes to the template's buyer code using the code table, e.g. `A283` -> `A2500283`, `A004` -> `A2500004`.
- Group rows by the same `일자-No.`. Each group is one transaction statement page.
- If a code has `*숫자`, use the value after `*` as the statement quantity.
- If a code has no `*숫자`, use the raw ERP `수량`.
- If one remark has multiple codes, split them into separate statement lines. Example: `A004 + A278*5.5` becomes two lines.
- After splitting codes, compare `template price * statement quantity` with the raw ERP `공급가액` by source row.
- Rows whose generated amount does not match the raw `공급가액` are held out by default and reported as 확인 필요, because those notes are usually delivery/replacement memos or non-contract settlement lines.
- Preserve the Excel template VLOOKUP approach in the generated workbook by filling the `구매사코드` and `수량` fields rather than hardcoding item/price/unit into those cells.
- Generate a combined PDF with one statement page per `일자-No.` and a filled `.xlsx` workbook for checking.
- If only templates are attached, store them for future runs and report that a raw `판매현황` workbook is still needed.

Command:

```bash
python .claude/skills/posco-statement/scripts/make_posco_statement.py --raw "<판매현황.xlsx>" --template "<포스코 거래명세서 툴.xlsx>" --outdir "<output folder>"
```

The response should be brief and should rely on generated artifacts.
