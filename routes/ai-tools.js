/**
 * routes/ai-tools.js — Claude API Tool Use 정의 + 실행 함수
 *
 * 설계:
 * - 각 도구는 { name, description, input_schema, execute(input, ctx) } 구조
 * - execute 는 async 함수. 결과는 JSON 직렬화 가능해야 함
 * - 파일 생성 도구는 result 에 `{ __artifact: {...} }` 를 포함 → 엔진이 artifact 저장 + URL 노출
 * - ctx: { userId, userName, threadId, req, db, salaryDb, ai }
 *
 * 관리자 전용 도구는 isAdminOnly: true 로 표시 → 직원 세션에선 tools 목록에서 자동 제외
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ai = require('../db-ai');

// DB 모듈 (동적 로드 — 순환참조 회피)
function getDb() { return require('../db'); }
function getSalaryDb() {
  try { return require('../db-salary'); } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════════
// 도구: 엑셀 파일 생성
// ══════════════════════════════════════════════════════════════
const createExcel = {
  name: 'create_excel',
  description: '표 형식의 데이터를 엑셀(.xlsx) 파일로 생성합니다. 직원이 다운로드할 수 있는 파일을 만들고 URL을 반환합니다. 여러 시트 지원.',
  input_schema: {
    type: 'object',
    properties: {
      filename: {
        type: 'string',
        description: '파일명 (확장자 제외, 한글 가능). 예: "2026년4월_매출현황"',
      },
      sheets: {
        type: 'array',
        description: '생성할 시트들',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '시트 이름' },
            headers: {
              type: 'array',
              items: { type: 'string' },
              description: '헤더 행 (첫 줄)',
            },
            rows: {
              type: 'array',
              items: { type: 'array' },
              description: '데이터 행들 (각 행은 값 배열)',
            },
          },
          required: ['name', 'headers', 'rows'],
        },
      },
    },
    required: ['filename', 'sheets'],
  },
  async execute(input, ctx) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = '대림에스엠ERP AI';
    wb.created = new Date();

    for (const sheet of (input.sheets || [])) {
      const ws = wb.addWorksheet(sheet.name || '시트1');
      // 헤더 스타일
      ws.addRow(sheet.headers || []);
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F6EF7' } };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

      // 데이터 행
      for (const row of (sheet.rows || [])) {
        ws.addRow(row);
      }

      // 컬럼 너비 자동 (대략)
      (sheet.headers || []).forEach((h, i) => {
        const col = ws.getColumn(i + 1);
        let maxLen = String(h).length;
        (sheet.rows || []).forEach(r => {
          const v = r[i];
          if (v != null) maxLen = Math.max(maxLen, String(v).length);
        });
        col.width = Math.min(40, Math.max(10, maxLen + 2));
      });
    }

    const safeName = sanitizeFilename(input.filename || 'output') + '.xlsx';
    const stored = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.xlsx`;
    const outPath = path.join(ai.OUTPUT_DIR, stored);
    await wb.xlsx.writeFile(outPath);
    const size = fs.statSync(outPath).size;

    const art = ai.artifacts.create({
      ownerId: ctx.userId,
      threadId: ctx.threadId,
      messageId: null,
      originalName: safeName,
      storedName: stored,
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size,
      kind: 'excel',
    });

    return {
      success: true,
      message: `엑셀 파일 "${safeName}" 생성 완료. 다운로드 링크 제공됨.`,
      filename: safeName,
      sizeBytes: size,
      __artifact: art,
    };
  }
};

// ══════════════════════════════════════════════════════════════
// 도구: PDF 파일 생성 (HTML → PDF)
// ══════════════════════════════════════════════════════════════
const createPdf = {
  name: 'create_pdf',
  description: 'HTML 내용을 PDF 파일로 생성합니다. 보고서·안내문 등에 사용. A4 세로 기본.',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: '파일명 (확장자 제외)' },
      title: { type: 'string', description: '문서 제목 (없으면 filename 사용)' },
      html: {
        type: 'string',
        description: 'PDF 로 변환할 HTML 본문. <style> 포함 가능. body 태그는 자동 래핑됨',
      },
      landscape: { type: 'boolean', description: '가로 방향 여부 (기본 false)' },
    },
    required: ['filename', 'html'],
  },
  async execute(input, ctx) {
    let puppeteer;
    try { puppeteer = require('puppeteer'); }
    catch(e) { throw new Error('puppeteer 미설치 — 서버에서 npm install 필요'); }

    const title = input.title || input.filename;
    const fullHtml = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: "Malgun Gothic","맑은 고딕",sans-serif; font-size: 12pt; line-height: 1.6; color: #333; padding: 0; margin: 0; }
  h1,h2,h3 { color: #1f2937; margin-top: 1.2em; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th,td { border: 1px solid #d1d5db; padding: 6px 10px; font-size: 11pt; }
  th { background: #f3f4f6; font-weight: 600; }
</style></head><body>${input.html}</body></html>`;

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    let pdfBuffer;
    try {
      const page = await browser.newPage();
      await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
      pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        landscape: !!input.landscape,
        margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
      });
    } finally {
      await browser.close();
    }

    const safeName = sanitizeFilename(input.filename || 'output') + '.pdf';
    const stored = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.pdf`;
    const outPath = path.join(ai.OUTPUT_DIR, stored);
    fs.writeFileSync(outPath, pdfBuffer);
    const size = pdfBuffer.length;

    const art = ai.artifacts.create({
      ownerId: ctx.userId,
      threadId: ctx.threadId,
      messageId: null,
      originalName: safeName,
      storedName: stored,
      mime: 'application/pdf',
      size,
      kind: 'pdf',
    });

    return {
      success: true,
      message: `PDF 파일 "${safeName}" 생성 완료.`,
      filename: safeName,
      sizeBytes: size,
      __artifact: art,
    };
  }
};

// ══════════════════════════════════════════════════════════════
// 도구: 직원 정보 조회
// ══════════════════════════════════════════════════════════════
const queryEmployee = {
  name: 'query_employee',
  description: '등록된 직원 목록 및 기본 정보를 조회합니다. 이름/부서/입사일/직책 등 확인에 사용. 개인 급여/생년월일 등 민감 정보는 제외됨.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '이름 검색 (부분 일치)' },
      department: { type: 'string', description: '부서 ID 또는 이름' },
      companyId: { type: 'string', description: '회사 ID (예: dalim-sm)' },
      status: { type: 'string', enum: ['approved', 'pending', 'resigned', 'all'], description: '기본 approved' },
    },
  },
  async execute(input, ctx) {
    const db = getDb();
    const uData = db.loadUsers();
    const org = db['조직관리'].load();
    const deptMap = new Map();
    for (const d of (org.departments || [])) deptMap.set(d.id, d.name);

    const statusFilter = input.status || 'approved';
    let list = (uData.users || []).filter(u => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (input.name && !((u.name || '').includes(input.name))) return false;
      if (input.department) {
        const isMatch = u.department === input.department ||
          deptMap.get(u.department) === input.department;
        if (!isMatch) return false;
      }
      if (input.companyId && u.companyId !== input.companyId) return false;
      return true;
    });

    // 민감 필드 제거 후 반환
    return {
      success: true,
      count: list.length,
      employees: list.slice(0, 100).map(u => ({
        id: u.id,
        name: u.name,
        userId: u.userId,
        department: deptMap.get(u.department) || u.department || '',
        position: u.position || '',
        hireDate: u.hireDate || '',
        status: u.status,
        companyId: u.companyId || '',
        // 주의: 비밀번호, 생년월일, 주민번호 등은 절대 포함 X
      }))
    };
  }
};

// ══════════════════════════════════════════════════════════════
// 도구: 출퇴근 조회 (월별 요약)
// ══════════════════════════════════════════════════════════════
const queryAttendance = {
  name: 'query_attendance',
  description: '특정 월의 출퇴근 요약을 조회합니다. 이름별 정상일수·지각·연차·결근 집계 반환.',
  input_schema: {
    type: 'object',
    properties: {
      year: { type: 'number', description: '연도 (예: 2026)' },
      month: { type: 'number', description: '월 (1-12)' },
      employeeName: { type: 'string', description: '특정 직원 이름 (생략 시 전체)' },
    },
    required: ['year', 'month'],
  },
  async execute(input, ctx) {
    // 내부적으로 /api/attendance/summary 로직 재활용
    try {
      const attendance = require('../db-attendance');
      const summary = attendance.summaryByMonth
        ? attendance.summaryByMonth(input.year, input.month)
        : null;
      if (!summary) {
        return { success: false, error: '출퇴근 집계 모듈을 찾을 수 없습니다' };
      }
      let result = Array.isArray(summary) ? summary : [];
      if (input.employeeName) {
        result = result.filter(r => (r.employeeName || r.name || '').includes(input.employeeName));
      }
      return {
        success: true,
        year: input.year,
        month: input.month,
        count: result.length,
        records: result.slice(0, 100),
      };
    } catch (e) {
      return { success: false, error: `출퇴근 조회 실패: ${e.message}` };
    }
  }
};

// ══════════════════════════════════════════════════════════════
// 도구: 매출/견적 조회
// ══════════════════════════════════════════════════════════════
const querySales = {
  name: 'query_sales',
  description: '견적·매출 데이터를 조회합니다. 기간·거래처·품목별 필터 가능.',
  input_schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '시작일 YYYY-MM-DD' },
      to: { type: 'string', description: '종료일 YYYY-MM-DD' },
      vendorName: { type: 'string', description: '거래처 이름 (부분일치)' },
      limit: { type: 'number', description: '최대 반환 건수 (기본 50)' },
    },
  },
  async execute(input, ctx) {
    try {
      const db = getDb();
      const quotes = db['견적저장'].load();
      const arr = Array.isArray(quotes) ? quotes : (quotes.items || quotes.quotes || []);
      let list = arr;
      if (input.from) list = list.filter(q => (q.date || q.createdAt || '') >= input.from);
      if (input.to)   list = list.filter(q => (q.date || q.createdAt || '') <= input.to + 'Z');
      if (input.vendorName) list = list.filter(q => (q.vendor || q.vendorName || '').includes(input.vendorName));
      const limit = Math.min(input.limit || 50, 200);
      const slim = list.slice(0, limit).map(q => ({
        id: q.id,
        date: q.date || q.createdAt || '',
        vendor: q.vendor || q.vendorName || '',
        total: q.total || q.totalAmount || 0,
        itemCount: Array.isArray(q.items) ? q.items.length : 0,
        note: q.note || q.memo || '',
      }));
      const sumTotal = list.reduce((s, q) => s + (q.total || q.totalAmount || 0), 0);
      return {
        success: true,
        count: list.length,
        returned: slim.length,
        sumTotal,
        quotes: slim,
      };
    } catch (e) {
      return { success: false, error: `매출 조회 실패: ${e.message}` };
    }
  }
};

// ══════════════════════════════════════════════════════════════
// 도구: 이메일 초안 생성 (실제 발송 X — 초안만)
// ══════════════════════════════════════════════════════════════
// 안전을 위해 실제 발송은 별도 토글로 나중에 추가.
// 지금은 "초안 만들어서 복사·붙여넣기 가능하게" 수준.
const draftEmail = {
  name: 'draft_email',
  description: '이메일 초안을 작성합니다. 받는사람·제목·본문을 구성해서 반환 (실제 발송은 되지 않음 — 사용자가 검토 후 직접 보내야 함).',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: '받는사람 이메일' },
      subject: { type: 'string', description: '제목' },
      body: { type: 'string', description: '본문 (평문/HTML 모두 가능)' },
      attachFileIds: {
        type: 'array', items: { type: 'number' },
        description: '첨부할 ai_artifacts ID 배열 (생성된 엑셀/PDF)',
      },
    },
    required: ['to', 'subject', 'body'],
  },
  async execute(input, ctx) {
    const attachments = (input.attachFileIds || []).map(id => {
      const a = ai.artifacts.get(id);
      if (!a) return null;
      return {
        id: a.id,
        name: a.original_name,
        url: `/api/ai/artifacts/${a.id}/download`,
      };
    }).filter(Boolean);
    return {
      success: true,
      message: '이메일 초안이 준비되었습니다. 사용자가 검토 후 직접 발송해야 합니다.',
      draft: {
        to: input.to,
        subject: input.subject,
        body: input.body,
        attachments,
      },
    };
  }
};

// ══════════════════════════════════════════════════════════════
// 도구: 현재 날짜·시간
// ══════════════════════════════════════════════════════════════
const getCurrentDatetime = {
  name: 'get_current_datetime',
  description: '현재 서버 날짜와 시간(KST)을 반환합니다. "오늘", "지금" 같은 상대 표현 해석에 사용.',
  input_schema: { type: 'object', properties: {} },
  async execute(input, ctx) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const weekday = ['일','월','화','수','목','금','토'][now.getDay()];
    return {
      iso: now.toISOString(),
      date: `${y}-${m}-${d}`,
      time: `${hh}:${mm}`,
      weekday,
      display: `${y}년 ${m}월 ${d}일 (${weekday}요일) ${hh}:${mm}`,
    };
  }
};

// ══════════════════════════════════════════════════════════════
// 도구 레지스트리
// ══════════════════════════════════════════════════════════════
const ALL_TOOLS = [
  createExcel,
  createPdf,
  queryEmployee,
  queryAttendance,
  querySales,
  draftEmail,
  getCurrentDatetime,
];

// Claude API 로 보낼 tools 정의 (execute 제외)
function toolsForClaude(isAdmin = false) {
  return ALL_TOOLS
    .filter(t => isAdmin || !t.isAdminOnly)
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
}

// 이름으로 도구 찾기 + 실행
async function executeTool(name, input, ctx) {
  const tool = ALL_TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`알 수 없는 도구: ${name}`);
  return await tool.execute(input || {}, ctx);
}

// ══════════════════════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════════════════════
function sanitizeFilename(name) {
  return String(name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')  // Windows 금지 문자
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = {
  ALL_TOOLS,
  toolsForClaude,
  executeTool,
};
