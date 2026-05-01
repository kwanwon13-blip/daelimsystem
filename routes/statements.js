/**
 * routes/statements.js — 명세서 일괄 스캔 + AI 추출 + 검토 + 저장
 *
 *   POST  /upload-batch     - 여러 파일 업로드 → 큐에 추가
 *   GET   /queue            - 큐 진행률
 *   GET   /list             - 목록 (검토 그리드)
 *   GET   /:id              - 단일 + 라인 아이템
 *   GET   /:id/file         - 원본 파일 (이미지/PDF) 보기
 *   PATCH /:id              - 검토 수정 (필드 + 라인 아이템)
 *   POST  /:id/confirm      - 확정
 *   POST  /:id/reject       - 반려
 *   DELETE /:id             - 삭제
 *   GET   /stats            - 통계 (월별 / 거래처별)
 *   GET   /export.xlsx      - 확정된 명세서 엑셀 export
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const JSZip = require('jszip');
const { requireAuth } = require('../middleware/auth');
const dbSt = require('../db-statements');

// PPTX → 슬라이드별 시안 본체 이미지 추출
// 한 슬라이드 = 한 매출 라인 = 한 명세서 (parent_pptx 메타로 묶임)
async function splitPptxToSlides(pptxPath) {
  const buf = fs.readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);

  // 슬라이드 파일 목록 (ppt/slides/slide{N}.xml)
  const slideFiles = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const aN = parseInt(a.match(/slide(\d+)/)[1]);
      const bN = parseInt(b.match(/slide(\d+)/)[1]);
      return aN - bN;
    });

  const out = [];
  for (const slideFile of slideFiles) {
    const idx = parseInt(slideFile.match(/slide(\d+)/)[1]);
    const relsFile = `ppt/slides/_rels/slide${idx}.xml.rels`;
    const relsEntry = zip.file(relsFile);
    if (!relsEntry) continue;
    const relsXml = await relsEntry.async('string');

    // 이미지 참조만 추출 (Type=image)
    const imageRefs = [];
    const relRegex = /<Relationship[^>]+Type="[^"]*\/image"[^>]+Target="([^"]+)"/g;
    let m;
    while ((m = relRegex.exec(relsXml)) !== null) {
      // Target 은 보통 "../media/imageN.png" 형태 → "ppt/media/imageN.png" 로 변환
      let target = m[1];
      if (target.startsWith('../')) target = 'ppt/' + target.slice(3);
      else if (!target.startsWith('ppt/')) target = 'ppt/slides/' + target;
      imageRefs.push(target);
    }

    // 가장 큰 이미지 = 시안 본체로 간주
    let biggest = null;
    for (const target of imageRefs) {
      const f = zip.file(target);
      if (!f) continue;
      const data = await f.async('nodebuffer');
      if (!biggest || data.length > biggest.data.length) {
        biggest = { target, data, ext: (target.split('.').pop() || 'png').toLowerCase() };
      }
    }

    // 슬라이드 안의 텍스트도 같이 (시안 오타 검사 / 보조 정보용)
    const slideEntry = zip.file(slideFile);
    let slideText = '';
    if (slideEntry) {
      const xml = await slideEntry.async('string');
      const tx = [];
      const txRegex = /<a:t[^>]*>([^<]*)<\/a:t>/g;
      let tm;
      while ((tm = txRegex.exec(xml)) !== null) {
        if (tm[1] && tm[1].trim()) tx.push(tm[1].trim());
      }
      slideText = tx.join(' | ');
    }

    if (biggest) {
      out.push({
        slideIndex: idx,
        imageBuffer: biggest.data,
        ext: biggest.ext,
        slideText: slideText,
      });
    }
  }

  return out;
}

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'statements');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ts = Date.now();
      const rand = crypto.randomBytes(3).toString('hex');
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      cb(null, `st_${ts}_${rand}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (PPTX 도 받기 위해 증가)
});

// ── AI 큐 ────────────────────────────────────────────────────
// 단순 메모리 큐. 서버 재시작 시 pending 항목은 DB 에 'pending' 상태로 남아있음
// (서버 시작 시 다시 큐에 넣어줌)
const queue = [];
let processing = 0;
const MAX_CONCURRENT = parseInt(process.env.STATEMENT_AI_CONCURRENT || '3', 10);
let queueStats = { total: 0, processed: 0, failed: 0, startedAt: null };

function resetQueueStatsIfIdle() {
  if (queue.length === 0 && processing === 0) {
    queueStats = { total: 0, processed: 0, failed: 0, startedAt: null };
  }
}

// AI 추출 — Claude Code CLI 사용 (사용자 구독 안에서, 비용 0)
async function extractStatement(filePath, mimeType, hint) {
  const cli = require('../lib/claude-cli');
  const hintText = hint ? `\n[힌트: ${hint}]\n` : '';
  const PROMPT = `이 이미지/PDF/시안은 대림에스엠(주) 또는 대림컴퍼니(주)의 거래 자료입니다.
거래명세서, 세금계산서, 매입명세서, 영수증, 또는 디자인 시안(PPTX 슬라이드) 일 수 있습니다.${hintText}

다음 정보를 정확히 추출해서 **JSON 만 출력**하세요. (다른 설명/마크다운 X)

{
  "doc_type": "세금계산서|거래명세서|영수증|매입명세서|PPTX시안|기타",
  "doc_class": "매입|매출",
  "company_code": "SM|COMPANY|null",
  "doc_date": "YYYY-MM-DD",
  "vendor_name": "거래처(상대방) 상호",
  "vendor_biz_no": "사업자등록번호 (XXX-XX-XXXXX 형식, 없으면 null)",
  "supply_amount": 공급가액(숫자, 원),
  "vat_amount": 부가세(숫자),
  "total_amount": 합계(숫자),
  "items": [
    {
      "item_name": "품목명",
      "spec": "규격 (없으면 null)",
      "quantity": 수량,
      "unit": "단위 (개, EA, kg 등)",
      "unit_price": 단가,
      "amount": 공급가액,
      "vat": 부가세
    }
  ],
  "notes": "특이사항 / 비고 (없으면 null)"
}

회사 자동분류 (company_code):
- 받는회사/공급받는자가 "대림에스엠(주)" / "대림에스엠" / 사업자번호 (대림에스엠) → SM
- 받는회사/공급받는자가 "대림컴퍼니(주)" / "대림컴퍼니" / 사업자번호 (대림컴퍼니) → COMPANY
- **PPTX 시안 (디자인 시안 슬라이드) → COMPANY** (시안 = 컴퍼니가 인쇄해서 매출 끊는 작업, 시안의 "DAELIM SM" 로고는 영업회사 표시일 뿐 등록 회사는 컴퍼니)
- 어느 쪽도 명확하지 않으면 → null

매입/매출 자동분류 (doc_class):
- 우리 회사가 받는 사람(공급받는자)이면 → "매입" (=거래처에서 우리한테 매출)
- 우리 회사가 보내는 사람(공급자)이면 → "매출" (=우리가 거래처에 매출)
- PPTX 시안 / 디자인 발주서 → "매출" (시안 = 우리가 매출 작업하는 발주서)

PPTX 시안 케이스 추출 가이드:
- doc_type = "PPTX시안", doc_class = "매출", company_code = "COMPANY"
- vendor_name = 시안 좌상단 거래처/시공사명 (예: "현대산업개발", "DL E&C", "라코스" 등)
- norm_vendor = 시안 우상단 현장명 (예: "서울원 IPARK", "GTX-B3-1공구")
- doc_date = 시안 안의 "납품 X/X" 또는 "설치 X/X" 날짜 (없으면 null)
- items[0] = { item_name: 시안 가운데 표제 품명 (예: "AL 바닥 논슬립 스티커"), spec: 표제 안 규격 (예: "500*500"), quantity: 시안 옆 수량 합계 }
- supply_amount, vat_amount, total_amount = null (시안에는 단가 정보 없음, 나중에 단가표에서 매칭)

vendor_name 은 항상 "상대방 회사명" (우리 회사 X)

규칙:
- 금액은 모두 숫자 (콤마 제거). 추출 안 되면 null
- 날짜는 YYYY-MM-DD. 추출 안 되면 null
- items 배열이 비면 빈 배열 []
- JSON 외 텍스트 절대 출력하지 마세요`;

  // CLI 로 호출 (파일 경로를 첨부) — 사용자 구독 안에서 무료
  const result = await cli.callClaudeCli(PROMPT, [filePath]);
  const text = (result && result.text) || '';
  return { raw: text, parsed: cli.parseJsonFromResponse(text) };
}

async function processQueueItem() {
  if (queue.length === 0) return;
  if (processing >= MAX_CONCURRENT) return;
  const item = queue.shift();
  processing++;
  try {
    const ext = await extractStatement(item.filePath, item.mimeType, item.hint);
    const p = ext.parsed || {};
    // 회사 코드 정규화 ("SM" / "COMPANY" / null 만 허용)
    const companyCode = (p.company_code === 'SM' || p.company_code === 'COMPANY') ? p.company_code : null;
    const docClass = (p.doc_class === '매입' || p.doc_class === '매출') ? p.doc_class : null;
    const stId = dbSt.createStatement({
      source_file: item.originalName,
      stored_file: path.basename(item.filePath),
      uploaded_by: item.uploadedBy,
      raw_extract: ext.raw,
      doc_type: p.doc_type || null,
      doc_class: docClass,
      company_code: companyCode,
      doc_date: p.doc_date || null,
      vendor_name: p.vendor_name || null,
      vendor_biz_no: p.vendor_biz_no || null,
      norm_vendor: (p.vendor_name || '').trim() || null,
      supply_amount: typeof p.supply_amount === 'number' ? Math.round(p.supply_amount) : null,
      vat_amount: typeof p.vat_amount === 'number' ? Math.round(p.vat_amount) : null,
      total_amount: typeof p.total_amount === 'number' ? Math.round(p.total_amount) : null,
      status: 'pending',
      notes: p.notes || null,
    }, p.items || []);
    queueStats.processed++;
    console.log(`[statements] AI 추출 완료 #${stId} - ${item.originalName}`);
  } catch (e) {
    console.error(`[statements] AI 실패 - ${item.originalName}:`, e.message);
    // 실패도 DB 에 기록 (검토 가능)
    try {
      dbSt.createStatement({
        source_file: item.originalName,
        stored_file: path.basename(item.filePath),
        uploaded_by: item.uploadedBy,
        raw_extract: '[AI 추출 실패: ' + e.message + ']',
        status: 'pending',
        notes: 'AI 추출 실패 — 수동 입력 필요',
      });
    } catch (_) {}
    queueStats.failed++;
  } finally {
    processing--;
    setImmediate(processQueueItem); // 다음 항목
  }
}

function tickQueue() {
  while (processing < MAX_CONCURRENT && queue.length > 0) {
    processQueueItem();
  }
}

// ── 라우트 ───────────────────────────────────────────────────

// 다중 업로드 → 큐에 추가 (PPTX 는 슬라이드별로 분리 후 큐에 넣음)
router.post('/upload-batch', requireAuth, upload.array('files', 100), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ ok: false, error: '파일 없음' });
  resetQueueStatsIfIdle();
  if (queueStats.startedAt === null) queueStats.startedAt = Date.now();

  let added = 0;
  const errors = [];
  for (const f of files) {
    const ext = (path.extname(f.originalname || '').toLowerCase());
    try {
      if (ext === '.pptx') {
        // PPTX 분리 → 슬라이드별 임시 이미지 저장 → 슬라이드 1장 = 큐 1건
        const slides = await splitPptxToSlides(f.path);
        for (const sl of slides) {
          const imgName = `pptx_${path.basename(f.path, '.pptx')}_s${sl.slideIndex}.${sl.ext}`;
          const imgPath = path.join(UPLOAD_DIR, imgName);
          fs.writeFileSync(imgPath, sl.imageBuffer);
          queue.push({
            filePath: imgPath,
            originalName: `${f.originalname} (슬라이드 ${sl.slideIndex})`,
            mimeType: `image/${sl.ext === 'jpg' ? 'jpeg' : sl.ext}`,
            uploadedBy: req.user.userId,
            hint: `PPTX 시안 — 슬라이드 텍스트: "${sl.slideText}"`,
            isPptxSlide: true,
          });
          queueStats.total++;
          added++;
        }
        // 원본 PPTX 는 보관 (나중에 다시 분리하거나 다운로드용)
      } else {
        queue.push({
          filePath: f.path,
          originalName: f.originalname,
          mimeType: f.mimetype,
          uploadedBy: req.user.userId,
        });
        queueStats.total++;
        added++;
      }
    } catch (e) {
      console.error(`[statements] 업로드 처리 실패 - ${f.originalname}:`, e.message);
      errors.push({ file: f.originalname, error: e.message });
    }
  }
  tickQueue();
  res.json({ ok: true, added, errors, queue: { ...queueStats, queueLen: queue.length, processing } });
});

// 큐 진행률
router.get('/queue', requireAuth, (req, res) => {
  res.json({
    ok: true,
    total: queueStats.total,
    processed: queueStats.processed,
    failed: queueStats.failed,
    queueLen: queue.length,
    processing,
    startedAt: queueStats.startedAt,
    elapsedMs: queueStats.startedAt ? Date.now() - queueStats.startedAt : 0,
  });
});

// 목록
router.get('/list', requireAuth, (req, res) => {
  const params = {
    status: req.query.status || null,
    month: req.query.month || null,
    vendor: req.query.vendor || null,
    docType: req.query.docType || null,
    docClass: req.query.docClass || null,        // 매입 / 매출
    companyCode: req.query.companyCode || null,  // SM / COMPANY
    q: req.query.q || '',
    limit: parseInt(req.query.limit) || 100,
    offset: parseInt(req.query.offset) || 0,
  };
  res.json({
    ok: true,
    items: dbSt.listStatements(params),
    total: dbSt.countStatements(params),
  });
});

// 통계
router.get('/stats', requireAuth, (req, res) => {
  res.json({ ok: true, ...dbSt.getStats() });
});

// 단일
router.get('/:id(\\d+)', requireAuth, (req, res) => {
  const st = dbSt.getById(parseInt(req.params.id));
  if (!st) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, statement: st });
});

// 원본 파일
router.get('/:id(\\d+)/file', requireAuth, (req, res) => {
  const st = dbSt.getById(parseInt(req.params.id));
  if (!st || !st.stored_file) return res.status(404).send('not found');
  const filePath = path.join(UPLOAD_DIR, st.stored_file);
  if (!fs.existsSync(filePath)) return res.status(404).send('file missing');
  res.sendFile(filePath);
});

// 검토 수정
router.patch('/:id(\\d+)', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const result = dbSt.updateStatement(id, req.body, req.body.items);
  if (!result) return res.status(404).json({ ok: false });
  res.json({ ok: true, statement: result });
});

// 확정
router.post('/:id(\\d+)/confirm', requireAuth, (req, res) => {
  const result = dbSt.setStatus(parseInt(req.params.id), 'confirmed', req.user.userId);
  res.json({ ok: true, statement: result });
});
// 반려
router.post('/:id(\\d+)/reject', requireAuth, (req, res) => {
  const result = dbSt.setStatus(parseInt(req.params.id), 'rejected', req.user.userId);
  res.json({ ok: true, statement: result });
});
// 삭제
router.delete('/:id(\\d+)', requireAuth, (req, res) => {
  dbSt.deleteStatement(parseInt(req.params.id));
  res.json({ ok: true });
});

// E2E 업로드 양식 엑셀 export (컴퍼니 매입/매출용)
// e2e-upload 스킬 양식 그대로: A:일자 ~ K:약어 (11컬럼)
// 라인 아이템 단위로 펼쳐서 기록 (E2E는 한 행에 한 품목)
router.get('/export.xlsx', requireAuth, async (req, res) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const params = {
    status: req.query.status || 'confirmed',
    month: req.query.month || null,
    companyCode: req.query.companyCode || null,
    docClass: req.query.docClass || null,
    limit: 10000,
  };
  const stmts = dbSt.listStatements(params);

  // ── E2E 양식 시트 (11컬럼) ──
  const ws = wb.addWorksheet('E2E 업로드');
  ws.columns = [
    { header: '일자',     key: 'date',  width: 12 },  // A
    { header: '상품분류', key: 'cat',   width: 12 },  // B
    { header: '상품명',   key: 'name',  width: 32 },  // C
    { header: '규격',     key: 'spec',  width: 16 },  // D
    { header: '수량',     key: 'qty',   width: 8 },   // E
    { header: '단가',     key: 'price', width: 12 },  // F
    { header: '금액',     key: 'amt',   width: 14 },  // G
    { header: '세액',     key: 'vat',   width: 12 },  // H
    { header: '합계금액', key: 'total', width: 14 },  // I
    { header: '비고',     key: 'note',  width: 30 },  // J
    { header: '약어',     key: 'abbr',  width: 12 },  // K
  ];
  // 헤더 스타일 (스킬 매뉴얼 그대로)
  const headerRow = ws.getRow(1);
  headerRow.font = { name: '맑은 고딕', bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  // 명세서 → 라인 아이템 펼치기
  let totalRows = 0;
  for (const st of stmts) {
    const full = dbSt.getById(st.id);
    const lines = (full && full.items) || [];
    if (lines.length === 0) {
      // 라인 없으면 명세서 자체를 한 줄로
      ws.addRow({
        date: st.doc_date || '',
        cat: '',
        name: st.norm_vendor || st.vendor_name || '',
        spec: '',
        qty: 1,
        price: st.supply_amount || 0,
        amt: st.supply_amount || 0,
        vat: st.vat_amount || 0,
        total: st.total_amount || 0,
        note: st.notes || '',
        abbr: '',
      });
      totalRows++;
    } else {
      for (const ln of lines) {
        // 수량×단가=금액 검증 + 소수점 단가 보정 (e2e-upload 스킬 룰)
        let qty = Number(ln.quantity) || 0;
        let price = Number(ln.unit_price) || 0;
        let amt = Number(ln.amount) || 0;
        if (qty && price && amt && Math.abs(qty * price - amt) > 0.01) {
          price = Math.round((amt / qty) * 10000) / 10000;  // 소수점 4자리
        }
        const vat = Number(ln.vat) || Math.round(amt * 0.1);
        ws.addRow({
          date: st.doc_date || '',
          cat: '',
          name: ln.item_name || '',
          spec: ln.spec || '',
          qty: qty,
          price: price,
          amt: amt,
          vat: vat,
          total: amt + vat,
          note: ln.notes || st.notes || '',
          abbr: '',
        });
        totalRows++;
      }
    }
  }

  // 데이터 행 스타일
  for (let r = 2; r <= totalRows + 1; r++) {
    const row = ws.getRow(r);
    row.font = { name: '맑은 고딕', size: 10 };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
        right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
      };
    });
    // 숫자 컬럼 포맷 (E:수량, F:단가, G:금액, H:세액, I:합계)
    ['E', 'F', 'G', 'H', 'I'].forEach(col => {
      const cell = row.getCell(col);
      cell.alignment = { horizontal: 'right' };
      cell.numFmt = (col === 'F' && cell.value && !Number.isInteger(cell.value)) ? '#,##0.####' : '#,##0';
    });
    // 일자 가운데 정렬
    row.getCell('A').alignment = { horizontal: 'center' };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // 검증 요약 시트 (참고용)
  const ws2 = wb.addWorksheet('검증요약');
  ws2.columns = [
    { header: '항목', key: 'k', width: 24 },
    { header: '값', key: 'v', width: 30 },
  ];
  const sum = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);
  const supSum = sum(stmts.map(s => s.supply_amount));
  const vatSum = sum(stmts.map(s => s.vat_amount));
  const totSum = sum(stmts.map(s => s.total_amount));
  ws2.addRow({ k: '회사 (companyCode)', v: params.companyCode || '전체' });
  ws2.addRow({ k: '구분 (docClass)', v: params.docClass || '전체' });
  ws2.addRow({ k: '월 (month)', v: params.month || '전체' });
  ws2.addRow({ k: '상태', v: params.status });
  ws2.addRow({ k: '명세서 건수', v: stmts.length });
  ws2.addRow({ k: '라인 아이템 행수', v: totalRows });
  ws2.addRow({ k: '공급가액 합계', v: supSum });
  ws2.addRow({ k: '부가세 합계', v: vatSum });
  ws2.addRow({ k: '합계 합계', v: totSum });
  ws2.getRow(1).font = { bold: true };

  // 파일명
  const tag = [
    params.companyCode === 'COMPANY' ? '대림컴퍼니' : (params.companyCode === 'SM' ? '대림에스엠' : '전체'),
    params.docClass || '매입매출',
    params.month || '전체월',
  ].join('_');
  const filename = encodeURIComponent(`${tag}_E2E업로드.xlsx`);

  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  await wb.xlsx.write(res);
  res.end();
});

// ── 시안 오타 확인 (이미지 JPG/PNG) ──
// 카톡 시안 이미지 → Claude Code CLI 로 텍스트 추출 + 맞춤법/오타/사이즈/숫자 검사
// (사용자 구독 안에서, 비용 0)
router.post('/spell-check', requireAuth, upload.array('files', 50), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ ok: false, error: '파일 없음' });
  const cli = require('../lib/claude-cli');
  const results = [];

  const PROMPT = `이 이미지는 인쇄·사인물·간판·스티커 디자인 시안입니다.
시안 안의 모든 텍스트를 정확히 추출하고, 한글 맞춤법/오타/사이즈 표기 일관성/숫자 오류/이상 표기를 검사하세요.

JSON 만 출력 (다른 설명/마크다운 X):
{
  "text": "시안에 보이는 모든 텍스트 (줄바꿈 포함, 그대로 추출)",
  "issues": [
    { "type": "맞춤법|오타|사이즈|숫자|기타", "message": "문제 설명 (10-40자, 어떤 부분이 의심스러운지 구체적으로)" }
  ]
}

검사 포인트:
- 한글 맞춤법 (예: "되요" → "돼요", "않 됩니다" → "안 됩니다")
- 오타 (예: 받침 누락, 자모 오류)
- 사이즈 표기 일관성 (예: 한 시안에 "500*500" 과 "500x500" 혼용)
- 숫자 일관성 (예: 동일 항목에 다른 수량/금액)
- 거래처명·현장명·연락처의 띄어쓰기/표기

문제 없으면 issues=[]. text 는 시안 안 글자만 (로고/외부 회사명 제외해도 됨).
JSON 외 텍스트 절대 X.`;

  // 동시 호출 (CLI 가 격리된 cwd 로 spawn 되어 병렬 가능)
  await Promise.all(files.map(async (f) => {
    try {
      const r = await cli.callClaudeCli(PROMPT, [f.path]);
      const txt = (r && r.text) || '';
      try {
        const parsed = cli.parseJsonFromResponse(txt);
        results.push({
          file: f.originalname,
          text: parsed.text || '',
          issues: parsed.issues || [],
        });
      } catch (parseErr) {
        results.push({
          file: f.originalname,
          text: '',
          issues: [{ type: 'AI파싱오류', message: parseErr.message + ' / 응답: ' + txt.slice(0, 200) }],
        });
      }
    } catch (e) {
      results.push({
        file: f.originalname,
        text: '',
        issues: [{ type: '처리오류', message: e.message }],
      });
    } finally {
      try { fs.unlinkSync(f.path); } catch(_){}
    }
  }));

  // 업로드 순서 유지
  const order = new Map(files.map((f, i) => [f.originalname, i]));
  results.sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));

  res.json({ ok: true, results });
});

// ── 이카운트 일괄 등록 (에스엠 매입/매출) ──
const ecount = require('../lib/ecount-client');

// 이카운트 키 설정 여부
router.get('/ecount/status', requireAuth, (req, res) => {
  res.json({ ok: true, configured: ecount.isConfigured() });
});

// dry-run / 실제 등록 (분할 단위)
router.post('/ecount/register', requireAuth, async (req, res) => {
  const { docClass, month, dryRun = true } = req.body || {};
  if (!ecount.isConfigured()) return res.status(400).json({ ok: false, error: '이카운트 키 미설정' });

  // 에스엠 + 해당 분할의 확정된 명세서만
  const stmts = dbSt.listStatements({
    status: 'confirmed',
    companyCode: 'SM',
    docClass,
    month: month || null,
    limit: 1000,
  });

  // 명세서 → 라인아이템 펼치기 → 이카운트 BulkDatas 형식으로
  const items = [];
  for (const st of stmts) {
    const full = dbSt.getById(st.id);
    const lines = (full && full.items) || [];
    if (lines.length === 0) {
      items.push({
        statement_id: st.id,
        date: st.doc_date,
        vendor_name: st.norm_vendor || st.vendor_name,
        vendor_biz_no: st.vendor_biz_no,
        item_name: st.norm_vendor || '',
        spec: '',
        qty: 1,
        price: st.supply_amount || 0,
        supply: st.supply_amount || 0,
        vat: st.vat_amount || 0,
        note: st.notes || '',
      });
    } else {
      for (const ln of lines) {
        items.push({
          statement_id: st.id,
          date: st.doc_date,
          vendor_name: st.norm_vendor || st.vendor_name,
          vendor_biz_no: st.vendor_biz_no,
          item_name: ln.item_name || '',
          spec: ln.spec || '',
          qty: Number(ln.quantity) || 0,
          price: Number(ln.unit_price) || 0,
          supply: Number(ln.amount) || 0,
          vat: Number(ln.vat) || Math.round((Number(ln.amount) || 0) * 0.1),
          note: ln.notes || st.notes || '',
        });
      }
    }
  }

  if (items.length === 0) return res.json({ ok: false, error: '등록할 항목 없음', items: 0 });

  try {
    const result = (docClass === '매입')
      ? await ecount.savePurchase(items, { dryRun })
      : await ecount.saveSale(items, { dryRun });
    res.json({
      ok: result.ok,
      dryRun: !!dryRun,
      docClass,
      itemCount: items.length,
      sample: items.slice(0, 3),
      result,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 거래처 / 품목 마스터 조회 (디버그용)
router.get('/ecount/customers', requireAuth, async (req, res) => {
  try { res.json(await ecount.listCustomers({ dryRun: req.query.dryRun==='1' })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/ecount/products', requireAuth, async (req, res) => {
  try { res.json(await ecount.listProducts({ dryRun: req.query.dryRun==='1' })); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 서버 시작 시 — pending 항목 다시 큐에 넣지 않음 (이미 DB 저장됐고 raw_extract 있을 수도)
// 새로 업로드하는 것만 큐 처리.

module.exports = router;
