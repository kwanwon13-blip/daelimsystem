const crypto = require('crypto');

const COMPANY_PROFILES = {
  SM: {
    code: 'SM',
    label: '대림에스엠',
    targetErp: 'ECOUNT',
    targetLabel: '이카운트',
    outputAction: 'api-register',
  },
  COMPANY: {
    code: 'COMPANY',
    label: '대림컴퍼니',
    targetErp: 'E2E',
    targetLabel: 'E2E',
    outputAction: 'excel-export',
  },
};

function inferTargetErp(companyCode) {
  return COMPANY_PROFILES[companyCode]?.targetErp || null;
}

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[()\[\]{}<>]/g, '')
    .replace(/\s+/g, '');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  const n = toNumber(value);
  return n === null ? null : Math.round(n);
}

function normalizeItem(item = {}) {
  return {
    item_code: cleanText(item.item_code || item.code),
    item_name: cleanText(item.item_name || item.name),
    spec: cleanText(item.spec),
    quantity: toNumber(item.quantity),
    unit: cleanText(item.unit),
    unit_price: roundMoney(item.unit_price),
    amount: roundMoney(item.amount),
    vat: roundMoney(item.vat),
  };
}

function buildDocumentFingerprint(statement = {}, items = []) {
  const normalizedItems = (items || []).map(normalizeItem).map((item) => ({
    c: normalizeKey(item.item_code),
    n: normalizeKey(item.item_name),
    s: normalizeKey(item.spec),
    q: item.quantity,
    p: item.unit_price,
    a: item.amount,
    v: item.vat,
  }));

  const canonical = JSON.stringify({
    company: statement.company_code || '',
    class: statement.doc_class || '',
    date: statement.doc_date || '',
    vendor: normalizeKey(statement.norm_vendor || statement.vendor_name),
    supply: roundMoney(statement.supply_amount),
    vat: roundMoney(statement.vat_amount),
    total: roundMoney(statement.total_amount),
    items: normalizedItems,
  });

  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function addIssue(issues, severity, field, message, details = null) {
  issues.push({ severity, field, message, details });
}

function sum(values) {
  return values.reduce((acc, value) => acc + (toNumber(value) || 0), 0);
}

function validateStatement(statement = {}, items = [], duplicateCandidates = []) {
  const issues = [];
  const profile = COMPANY_PROFILES[statement.company_code] || null;
  const targetErp = statement.target_erp || inferTargetErp(statement.company_code);
  const normalizedItems = (items || []).map(normalizeItem);

  if (!profile) addIssue(issues, 'error', 'company_code', '회사 구분이 필요합니다.');
  if (statement.doc_class !== '매입' && statement.doc_class !== '매출') {
    addIssue(issues, 'error', 'doc_class', '매입/매출 구분이 필요합니다.');
  }
  if (profile && targetErp !== profile.targetErp) {
    addIssue(issues, 'error', 'target_erp', `${profile.label} 자료는 ${profile.targetLabel} 대상으로 처리해야 합니다.`);
  }
  if (!statement.doc_date) addIssue(issues, 'error', 'doc_date', '거래 일자가 필요합니다.');
  if (!cleanText(statement.norm_vendor || statement.vendor_name)) {
    addIssue(issues, 'error', 'vendor', '거래처명이 필요합니다.');
  }

  const supply = roundMoney(statement.supply_amount);
  const vat = roundMoney(statement.vat_amount);
  const total = roundMoney(statement.total_amount);
  if (supply === null && total === null && normalizedItems.length === 0) {
    addIssue(issues, 'error', 'amount', '금액 또는 품목 라인이 필요합니다.');
  }
  if (statement.doc_class === '매입' && normalizedItems.length === 0) {
    addIssue(issues, 'error', 'items', '매입 입력에는 품목 라인이 필요합니다.');
  }
  if (supply !== null && vat !== null && total !== null && Math.abs(supply + vat - total) > 1) {
    addIssue(issues, 'error', 'total_amount', '공급가액 + 부가세가 합계와 맞지 않습니다.', {
      supply,
      vat,
      total,
      expected: supply + vat,
    });
  }

  if (normalizedItems.length > 0) {
    normalizedItems.forEach((item, index) => {
      const row = index + 1;
      if (!item.item_name) addIssue(issues, 'error', `items.${index}.item_name`, `${row}행 품목명이 필요합니다.`);
      if (!item.amount && item.amount !== 0) addIssue(issues, 'warning', `items.${index}.amount`, `${row}행 공급가액 확인이 필요합니다.`);
      if (item.quantity !== null && item.unit_price !== null && item.amount !== null) {
        const expected = Math.round(item.quantity * item.unit_price);
        if (Math.abs(expected - item.amount) > 1) {
          addIssue(issues, 'warning', `items.${index}.amount`, `${row}행 수량 x 단가가 공급가액과 다릅니다.`, {
            expected,
            amount: item.amount,
          });
        }
      }
    });

    const lineSupply = sum(normalizedItems.map((item) => item.amount));
    if (supply !== null && lineSupply > 0 && Math.abs(lineSupply - supply) > 1) {
      addIssue(issues, 'warning', 'supply_amount', '라인 공급가액 합계가 문서 공급가액과 다릅니다.', {
        lineSupply,
        supply,
      });
    }
  }

  if (profile?.targetErp === 'ECOUNT') {
    if (!statement.vendor_biz_no) {
      addIssue(issues, 'warning', 'vendor_biz_no', '사업자번호 또는 거래처 코드 매칭 확인이 필요합니다.');
    }
  }

  for (const cand of duplicateCandidates || []) {
    if (cand.reason === 'file_hash' || cand.reason === 'document_fingerprint') {
      const severity = cand.status === 'rejected' ? 'warning' : 'error';
      addIssue(issues, severity, 'duplicate', `이미 처리된 것으로 보이는 자료가 있습니다. #${cand.id} ${cand.source_file || ''}`.trim(), cand);
    } else if (cand.reason === 'similar_business_key') {
      addIssue(issues, 'warning', 'duplicate', `거래처/일자/금액이 같은 자료가 있습니다. #${cand.id} ${cand.source_file || ''}`.trim(), cand);
    }
  }

  const blockingIssues = issues.filter((issue) => issue.severity === 'error');
  const warningIssues = issues.filter((issue) => issue.severity === 'warning');
  return {
    profile,
    targetErp,
    issues,
    blockingIssues,
    warningIssues,
    canConfirm: blockingIssues.length === 0,
    documentFingerprint: buildDocumentFingerprint(statement, items),
  };
}

function summarizeWorkflow(validation) {
  return {
    targetErp: validation.targetErp,
    targetLabel: validation.profile?.targetLabel || '',
    companyLabel: validation.profile?.label || '',
    canConfirm: validation.canConfirm,
    issueCount: validation.issues.length,
    blockingCount: validation.blockingIssues.length,
    warningCount: validation.warningIssues.length,
  };
}

module.exports = {
  COMPANY_PROFILES,
  inferTargetErp,
  buildDocumentFingerprint,
  validateStatement,
  summarizeWorkflow,
  normalizeItem,
  toNumber,
};
