// 라코스 3월 2026 견적 등록 (POST+PUT 방식)
window._uploadBatch2 = async function(payloads) {
  const BASE = 'http://192.168.0.133:3000';
  let ok = 0, fail = 0;
  for (const p of payloads) {
    try {
      // 1) 생성
      const r1 = await fetch(BASE + '/api/quotes', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify(p)
      });
      if (!r1.ok) { fail++; console.error('POST 실패:', p.quoteName, r1.status); continue; }
      const created = await r1.json();
      const id = created.id;
      
      // 2) 날짜/금액/상태 수정 (items 제외하고 PUT)
      const r2 = await fetch(BASE + '/api/quotes/' + id, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        credentials: 'include',
        body: JSON.stringify({
          siteName: p.siteName,
          quoteName: p.quoteName,
          vendorId: p.vendorId,
          vendorName: p.vendorName,
          status: p.status,
          createdAt: p.createdAt,
          totalAmount: p.totalAmount
        })
      });
      if (r2.ok) { ok++; }
      else { fail++; console.error('PUT 실패:', p.quoteName, r2.status); }
    } catch(e) {
      fail++;
      console.error('오류:', p.quoteName, e.message);
    }
    await new Promise(r => setTimeout(r, 120));
  }
  return {ok, fail};
};
'함수 준비 완료';
