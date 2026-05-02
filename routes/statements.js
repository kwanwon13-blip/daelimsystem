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

    // 슬라이드 안의 텍스트도 같이 (시안 문구 확인 / 보조 정보용)
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
      // multer 가 latin1 로 한글 파일명 받아서 깨짐 → utf8 로 변환
      try { file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch(_){}
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
const pptMatchedRows = new Map(); // parentPptx -> Set(learning row key)

function resetQueueStatsIfIdle() {
  if (queue.length === 0 && processing === 0) {
    queueStats = { total: 0, processed: 0, failed: 0, startedAt: null };
  }
}

function inferDateFromName(name) {
  const m = String(name || '').match(/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function getPptMatchDayRange(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return 10;
  const day = d.getDate();
  if (day <= 3 || day >= 26) return 10;
  return 7;
}

function parentPptxKey(name) {
  return String(name || '').replace(/\s*\(슬라이드\s*\d+\)\s*$/i, '');
}

function getPptUsedSet(parentPptx) {
  const key = parentPptxKey(parentPptx);
  if (!key) return null;
  if (!pptMatchedRows.has(key)) pptMatchedRows.set(key, new Set());
  return pptMatchedRows.get(key);
}

function resolveUploadFile(storedFile) {
  const base = path.basename(String(storedFile || ''));
  if (!base) return null;
  const resolved = path.resolve(UPLOAD_DIR, base);
  const root = path.resolve(UPLOAD_DIR);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function deleteUploadFile(storedFile) {
  const filePath = resolveUploadFile(storedFile);
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (e) {
    console.warn('[statements] upload file delete failed:', e.message);
    return false;
  }
}

function deleteStoredFileIfUnused(storedFile) {
  if (!storedFile || dbSt.countByStoredFile(storedFile) > 0) return false;
  return deleteUploadFile(storedFile);
}

function pptxSourceFromSlide(storedFile) {
  const m = String(storedFile || '').match(/^pptx_(st_\d+_[a-f0-9]+)_s\d+\.[^.]+$/i);
  return m ? `${m[1]}.pptx` : null;
}

function deletePptxSourceIfNoSlides(slideStoredFile) {
  const sourceFile = pptxSourceFromSlide(slideStoredFile);
  if (!sourceFile) return false;
  const prefix = 'pptx_' + path.basename(sourceFile, '.pptx') + '_s';
  const refs = dbSt.db.prepare('SELECT COUNT(*) as n FROM statements WHERE stored_file LIKE ?').get(prefix + '%').n;
  if (refs > 0) return false;
  return deleteUploadFile(sourceFile);
}

function deleteStatementWithFile(id) {
  const st = dbSt.getById(id);
  if (!st) return null;
  const storedFile = st.stored_file;
  const deleted = dbSt.deleteStatement(id);
  const fileDeleted = deleteStoredFileIfUnused(storedFile);
  const pptxDeleted = deletePptxSourceIfNoSlides(storedFile);
  return { statement: deleted || st, fileDeleted, pptxDeleted };
}

// AI 추출 — Claude Code CLI 사용 (사용자 구독 안에서, 비용 0)
// extra: { isPptxSlide, inferredDate, parentPptx } — PPTX 시안일 때 일자별 정답 컨텍스트 주입용
async function extractStatement(filePath, mimeType, hint, extra = {}) {
  const cli = require('../lib/claude-cli');
  const learningPool = require('../lib/learning-pool');
  const hintText = hint ? `\n[힌트: ${hint}]\n` : '';

  // 4분할 학습 풀 컨텍스트 추가
  let poolCtx = '';
  if (learningPool.pool.loaded) {
    // PPTX 시안인 경우 = 컴퍼니 매출 → 같은 일자 실제 등록행 정답으로 직접 보여줌
    if (extra.isPptxSlide && extra.inferredDate) {
      const slideCtx = learningPool.getSlideContext(extra.inferredDate);
      poolCtx = `

==== ⚡ 핵심 학습 정답 — PPT 날짜 주변 실제 등록된 매출 행 ====
파일명: ${extra.parentPptx || ''}  /  추정 일자: ${extra.inferredDate}
${slideCtx}

**중요: PPT 전체/주변 날짜 정답 패턴을 참조해서 시안에서 똑같은 표현을 추출하세요.**
- 월말 작업이 다음달 1일 매출로 이월될 수 있으므로 파일명 날짜와 시안 납품일이 달라도 주변 날짜 정답을 우선 확인
- 같은 규격(예: 2000*1200)이 있으면 그 거래처/품명 표현을 그대로 사용
- "포맥스 게시판" 같은 새 표현 만들지 말 것 — 정답에 "3t포맥스+집게14개" 같이 있으면 그거 사용
- 결합 품명 (X+Y+Z)는 정답 패턴 그대로
==== /학습 정답 ====
`;
    } else {
      // 일반 명세서 — TOP 거래처/품목 컨텍스트
      poolCtx = `

==== 학습 풀 컨텍스트 (실제 등록된 거래처/품목 — 매칭 시 정식명 사용) ====
${learningPool.getContext('SM', '매입', { topVendors: 25, topItems: 30 })}
--- SM 매입 ---
${learningPool.getContext('SM', '매출', { topVendors: 25, topItems: 30 })}
--- SM 매출 ---
${learningPool.getContext('COMPANY', '매입', { topVendors: 15, topItems: 20 })}
--- COMPANY 매입 ---

위 목록에서 매칭되면 그 정식 표기 사용. 매칭 안 되면 명세서에 적힌 그대로.
==== /학습 풀 ====
`;
    }
  }
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

PPTX 시안 케이스 추출 가이드 (⚠️ 거래처 룰 매우 중요):
- doc_type = "PPTX시안", doc_class = "매출", company_code = "COMPANY"
- doc_date = 시안 안의 "납품 X/X" 또는 "설치 X/X" 날짜 (없으면 null)
- items[0] = { item_name: 시안 가운데 표제 품명 (예: "AL 바닥 논슬립 스티커"), spec: 표제 안 규격 (예: "500*500"), quantity: 시안 옆 수량 합계 }

**🚨 vendor_name 룰 (절대 룰):**
시안의 좌상단 로고/회사명은 영업회사 표시일 뿐 — 그대로 vendor_name 에 적지 말 것!
컴퍼니 매출 거래처는 정해져 있음 (15곳뿐):
  1. 대림에스엠(주) ← 대부분 시안 (자매법인 내부거래, 약 80%)
  2. 주식회사 동명이엔지
  3. 디자인포트
  4. 이상테크윈(주)
  5. (주)보성세이프
  6. 주)삼성라코스산업안전 (시안 표기: "라코스")
  7. 금강컴퍼니 *주식회사 지케이금강으로 변경 (시안 표기: "금강" 또는 "지케이금강")
  8. 경안상사
  9. (주)정수이엔지
  10. 녹색안전산업, 주식회사 지케이금강, 주식회사 아신렌탈 등

vendor_name 결정 룰:
- 시안 우상단/표제에 "라코스" 표기 → "주)삼성라코스산업안전"
- 시안에 "이상테크" → "이상테크윈(주)"
- 시안에 "동명" → "주식회사 동명이엔지"
- 시안에 "보성" → "(주)보성세이프"
- 시안에 "디자인포트" → "디자인포트"
- 시안에 "경안" → "경안상사"
- 시안에 "정수" → "(주)정수이엔지"
- 시안에 "지케이" / "금강" → "금강컴퍼니 *주식회사 지케이금강으로 변경"
- **위 8곳 외 모든 케이스 (DL E&C, 현대산업개발, 요진, 한신공영, 두산, 퍼시스 등) → "대림에스엠(주)"**
  (이건 대림에스엠이 영업해서 받은 발주를 컴퍼니가 인쇄하고 → 대림에스엠으로 자매법인 매출하는 구조. 시안의 거래처 로고는 발주 출처 표시일 뿐.)

norm_vendor = 시안 우상단 현장명 또는 프로젝트명 (예: "서울원 IPARK", "GTX-B3-1공구", "느티마을3단지")
supply_amount, vat_amount, total_amount = null (시안엔 단가 없음, 단가표 매칭으로 채움)

vendor_name 은 항상 "상대방 회사명" (우리 회사 X)

규칙:
- 금액은 모두 숫자 (콤마 제거). 추출 안 되면 null
- 날짜는 YYYY-MM-DD. 추출 안 되면 null
- items 배열이 비면 빈 배열 []
- JSON 외 텍스트 절대 출력하지 마세요${poolCtx}`;

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
    if (item.isPptxSlide) {
      const learningPool = require('../lib/learning-pool');
      const companySalesRows = learningPool.pool.COMPANY_매출?.rows || 0;
      if (companySalesRows <= 0) {
        dbSt.createStatement({
          source_file: item.originalName,
          stored_file: path.basename(item.filePath),
          uploaded_by: item.uploadedBy,
          raw_extract: '[학습자료 없음: 컴퍼니 매출 정답 엑셀 0행]',
          doc_type: 'PPTX시안',
          doc_class: '매출',
          company_code: 'COMPANY',
          doc_date: item.inferredDate || null,
          status: 'pending',
          notes: '학습자료가 서버에 로드되지 않아 AI 임의 등록을 중단했습니다. learning-data 엑셀 배포 후 다시 업로드하세요.',
        }, []);
        queueStats.failed++;
        console.warn(`[statements] 학습자료 없음 - PPTX 처리 중단: ${item.originalName}`);
        return;
      }
    }
    const ext = await extractStatement(item.filePath, item.mimeType, item.hint, {
      isPptxSlide: item.isPptxSlide,
      inferredDate: item.inferredDate,
      parentPptx: item.parentPptx,
    });
    const p = ext.parsed || {};
    // 회사 코드 정규화 ("SM" / "COMPANY" / null 만 허용)
    let companyCode = (p.company_code === 'SM' || p.company_code === 'COMPANY') ? p.company_code : null;
    let docClass = (p.doc_class === '매입' || p.doc_class === '매출') ? p.doc_class : null;
    // PPTX 시안은 무조건 컴퍼니 매출 (사장님 룰)
    if (item.isPptxSlide) {
      companyCode = 'COMPANY';
      docClass = '매출';
    }
    // 일자 — AI 추출 우선, 안 되면 PPTX 파일명에서 추출
    const docDate = p.doc_date || item.inferredDate || null;

    // 학습 풀 후처리 매칭 (컴퍼니 매출 PPTX 시안용)
    // AI 가 추출한 거 무시하고, 같은 일자의 진짜 등록 데이터로 덮어쓰기
    let autoItems = p.items || [];
    if (companyCode === 'COMPANY' && docClass === '매출' && item.isPptxSlide && item.inferredDate) {
      const learningPool = require('../lib/learning-pool');
      const aiItem = autoItems[0] || {};
      const matchText = [item.hint, ext.raw, p.notes].filter(Boolean).join('\n');
      const usedRows = getPptUsedSet(item.parentPptx);
      const dayRange = getPptMatchDayRange(item.inferredDate || docDate);
      const match = learningPool.matchCompanySaleItem(aiItem, {
        dateStr: item.inferredDate,
        altDateStr: docDate,
        vendorHint: p.vendor_name,
        textHint: matchText,
        dayRange,
        excludeKeys: usedRows,
      });
      console.log(`[learning-pool] PPTX ${item.originalName} 일자 ${item.inferredDate}: ±${dayRange}일 후보 ${match.candidateCount}개 / 규격후보 ${match.exactSpecCount}개 / 점수 ${match.score} / ${match.reason}`);

      if (match.matched) {
        const matched = match.matched;
        const amount = Number(matched.amount) || ((Number(matched.qty) || 0) * (Number(matched.price) || 0)) || 0;
        const vat = Math.round(amount * 0.1);
        console.log(`[learning-pool] ✓ 매칭: AI"${aiItem.item_name}/${aiItem.spec}" → DB"${matched.item}/${matched.spec}" (${match.reason})`);
        autoItems = [{
          item_name: matched.item,
          spec: matched.spec,
          quantity: matched.qty,
          unit_price: matched.price || 0,
          amount,
          vat,
          notes: `학습매칭: ${match.reason} / score ${match.score}`,
        }];
        if (matched.vendor) p.vendor_name = matched.vendor;
        p.supply_amount = amount;
        p.vat_amount = vat;
        p.total_amount = amount + vat;
        if (usedRows) usedRows.add(learningPool.companySaleRowKey(matched));
      } else {
        const top = (match.candidates || []).slice(0, 3)
          .map(c => `${c.row.item}/${c.row.spec}/${c.row.qty}개/${c.row.price}원(${c.score})`)
          .join(' | ');
        console.log(`[learning-pool] ✗ 매칭 실패: ${match.reason} / 후보: ${top || '없음'}`);
        if (autoItems[0]) {
          autoItems[0].notes = `학습매칭실패: ${match.reason}${top ? ' / 후보 ' + top : ''}`;
        }
      }
    }
    const stId = dbSt.createStatement({
      source_file: item.originalName,
      stored_file: path.basename(item.filePath),
      uploaded_by: item.uploadedBy,
      raw_extract: ext.raw,
      doc_type: p.doc_type || null,
      doc_class: docClass,
      company_code: companyCode,
      doc_date: docDate,
      vendor_name: p.vendor_name || null,
      vendor_biz_no: p.vendor_biz_no || null,
      norm_vendor: (p.vendor_name || '').trim() || null,
      supply_amount: typeof p.supply_amount === 'number' ? Math.round(p.supply_amount) : null,
      vat_amount: typeof p.vat_amount === 'number' ? Math.round(p.vat_amount) : null,
      total_amount: typeof p.total_amount === 'number' ? Math.round(p.total_amount) : null,
      status: 'pending',
      notes: p.notes || null,
    }, autoItems);
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
    // 큐 다 끝나면 같은 거래처+일자 자동 병합 (컴퍼니 매출 — PPTX 시안 후처리)
    if (queue.length === 0 && processing === 0 && queueStats.total > 0) {
      try {
        const r = dbSt.mergeByVendorDate({ companyCode: 'COMPANY', docClass: '매출', status: 'pending' });
        if (r.mergedGroups > 0) {
          console.log(`[statements] 자동 병합: ${r.mergedGroups}개 그룹 → ${r.mergedStatements}건 통합 (라인 ${r.totalLines}개 이동)`);
        }
      } catch (e) { console.error('[statements] 자동 병합 실패:', e.message); }
    }
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
        // 파일명에서 일자 자동 추출 (YYYYMMDD 패턴)
        const inferredDate = inferDateFromName(f.originalname);
        const pptText = slides
          .map(sl => `슬라이드 ${sl.slideIndex}: ${sl.slideText || ''}`)
          .join('\n')
          .slice(0, 12000);
        for (const sl of slides) {
          const imgName = `pptx_${path.basename(f.path, '.pptx')}_s${sl.slideIndex}.${sl.ext}`;
          const imgPath = path.join(UPLOAD_DIR, imgName);
          fs.writeFileSync(imgPath, sl.imageBuffer);
          queue.push({
            filePath: imgPath,
            originalName: `${f.originalname} (슬라이드 ${sl.slideIndex})`,
            mimeType: `image/${sl.ext === 'jpg' ? 'jpeg' : sl.ext}`,
            uploadedBy: req.user.userId,
            hint: `PPTX 시안 — 현재 슬라이드 ${sl.slideIndex}/${slides.length} 텍스트: "${sl.slideText}"${inferredDate ? ` / 파일명 일자: ${inferredDate}` : ''}\n\n[전체 PPT 텍스트]\n${pptText}`,
            isPptxSlide: true,
            inferredDate,                              // 파일명 기반 일자
            parentPptx: f.originalname,                // 원본 PPTX 파일명
            slideIndex: sl.slideIndex,
            slideCount: slides.length,
            pptText,
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
// 검토전으로 되돌리기
router.post('/:id(\\d+)/reset', requireAuth, (req, res) => {
  const result = dbSt.setStatus(parseInt(req.params.id), 'pending', null);
  res.json({ ok: true, statement: result });
});
// 삭제
router.delete('/:id(\\d+)', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const st = dbSt.getById(id);
  if (!st) return res.status(404).json({ ok: false, error: 'not found' });
  if (st.status === 'confirmed') {
    return res.status(400).json({ ok: false, error: '확정 자료는 바로 삭제할 수 없습니다. 반려 또는 검토전으로 되돌린 뒤 삭제해주세요.' });
  }
  const result = deleteStatementWithFile(id);
  res.json({ ok: true, fileDeleted: !!(result?.fileDeleted || result?.pptxDeleted) });
});

router.post('/cleanup', requireAuth, (req, res) => {
  const body = req.body || {};
  const status = body.status || 'rejected';
  if (status !== 'rejected') {
    return res.status(400).json({ ok: false, error: '반려 자료만 일괄 삭제할 수 있습니다.' });
  }
  const rows = dbSt.listCleanupCandidates({
    status,
    month: body.month || null,
    companyCode: body.companyCode || null,
    docClass: body.docClass || null,
    q: body.q || '',
    limit: body.limit || 50000,
  });
  const fileRefs = new Map();
  const pptxRefs = new Map();
  for (const row of rows) {
    if (!row.stored_file) continue;
    fileRefs.set(row.stored_file, (fileRefs.get(row.stored_file) || 0) + 1);
    const pptxSource = pptxSourceFromSlide(row.stored_file);
    if (pptxSource) pptxRefs.set(pptxSource, (pptxRefs.get(pptxSource) || 0) + 1);
  }
  let removableFiles = 0;
  for (const [storedFile, candidateRefs] of fileRefs.entries()) {
    if (dbSt.countByStoredFile(storedFile) <= candidateRefs) removableFiles++;
  }
  for (const [sourceFile, candidateSlideRefs] of pptxRefs.entries()) {
    const prefix = 'pptx_' + path.basename(sourceFile, '.pptx') + '_s';
    const refs = dbSt.db.prepare('SELECT COUNT(*) as n FROM statements WHERE stored_file LIKE ?').get(prefix + '%').n;
    if (refs <= candidateSlideRefs && resolveUploadFile(sourceFile) && fs.existsSync(resolveUploadFile(sourceFile))) removableFiles++;
  }

  if (body.dryRun !== false) {
    return res.json({ ok: true, dryRun: true, count: rows.length, fileCount: removableFiles });
  }

  let deleted = 0;
  let filesDeleted = 0;
  for (const row of rows) {
    const result = deleteStatementWithFile(row.id);
    if (result) {
      deleted++;
      if (result.fileDeleted) filesDeleted++;
      if (result.pptxDeleted) filesDeleted++;
    }
  }
  res.json({ ok: true, dryRun: false, deleted, filesDeleted });
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

  // 명세서 일자순 정렬 (일자별 명세서 생성)
  stmts.sort((a, b) => (a.doc_date || '').localeCompare(b.doc_date || ''));

  // ── E2E 양식 시트 (11컬럼, 일자별 정렬됨) ──
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

// ── 4분할 학습 데이터 풀 — 폴더 기반 자동 분류 ──
// learning-data/ 폴더 구조 그대로 사용 (분할별 명확히 분리)
const LEARNING_DIR = path.join(__dirname, '..', 'learning-data');

const FOLDER_LABELS = {
  '01_에스엠매입':     '① 에스엠 매입',
  '02_에스엠매출':     '② 에스엠 매출',
  '03_컴퍼니매입':     '③ 컴퍼니 매입',
  '04_컴퍼니매출':     '④ 컴퍼니 매출',
  '99_품목마스터':     '🔧 품목/거래처 마스터',
  '_무관_나이스텍':    '⑤ 나이스텍 (별도 회사)',
};

router.get('/data-sources', requireAuth, (req, res) => {
  const sources = {};
  for (const label of Object.values(FOLDER_LABELS)) sources[label] = [];

  if (!fs.existsSync(LEARNING_DIR)) {
    return res.json({ ok: true, sources, dirs: [], note: 'learning-data 폴더 없음 — 만들어야 함' });
  }

  // 분할별 폴더 순회
  for (const [folder, label] of Object.entries(FOLDER_LABELS)) {
    const dir = path.join(LEARNING_DIR, folder);
    if (!fs.existsSync(dir)) continue;
    // data/ 서브폴더 + 루트의 README 무시
    const dataDirs = [dir, path.join(dir, 'data')];
    for (const d of dataDirs) {
      if (!fs.existsSync(d)) continue;
      try {
        const files = fs.readdirSync(d).filter(f =>
          /\.(xlsx|xls|csv|db)$/i.test(f) && !f.startsWith('~$') && f !== 'README.md'
        );
        for (const f of files) {
          const fp = path.join(d, f);
          const stat = fs.statSync(fp);
          sources[label].push({
            file: f,
            path: fp,
            size: stat.size,
            sizeKb: Math.round(stat.size / 1024),
            mtime: stat.mtime,
            subfolder: path.basename(d),  // 'data' 또는 분할 폴더명
          });
        }
      } catch (e) { /* 무시 */ }
    }
  }

  // 정렬 (최근 수정순)
  for (const k of Object.keys(sources)) {
    sources[k].sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  }

  res.json({ ok: true, sources, learningDir: LEARNING_DIR });
});

// 같은 거래처+일자 자동 병합 (PPTX 처리 후 호출)
router.post('/merge-by-vendor-date', requireAuth, (req, res) => {
  const { companyCode = 'COMPANY', docClass = '매출', status = 'pending' } = req.body || {};
  try {
    const result = dbSt.mergeByVendorDate({ companyCode, docClass, status });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 컴퍼니 매출 PPTX/시안 행을 학습 엑셀 기준으로 다시 매칭
router.post('/rematch-company-sales', requireAuth, (req, res) => {
  const learningPool = require('../lib/learning-pool');
  const { month = null, status = 'pending' } = req.body || {};
  if ((learningPool.pool.COMPANY_매출?.rows || 0) <= 0) {
    return res.status(409).json({
      ok: false,
      error: '컴퍼니 매출 학습자료가 0행입니다. learning-data 엑셀을 서버에 배포하고 학습 풀을 다시 로드하세요.',
      stats: learningPool.getStats(),
    });
  }

  try {
    const where = [`s.company_code = 'COMPANY'`, `s.doc_class = '매출'`];
    const params = {};
    if (status && status !== 'all') { where.push(`s.status = @status`); params.status = status; }
    if (month) { where.push(`s.month_key = @month`); params.month = month; }

    const rows = dbSt.db.prepare(`
      SELECT
        s.id AS statement_id, s.source_file, s.raw_extract, s.doc_date, s.vendor_name, s.norm_vendor, s.notes AS statement_notes,
        i.id AS item_id, i.line_no, i.item_name, i.spec, i.quantity, i.unit, i.unit_price, i.amount, i.vat, i.notes AS item_notes
      FROM statements s
      JOIN statement_items i ON i.statement_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY s.id, i.line_no
    `).all(params);

    const updateItem = dbSt.db.prepare(`
      UPDATE statement_items
      SET item_name = @item_name, spec = @spec, quantity = @quantity, unit_price = @unit_price,
          amount = @amount, vat = @vat, notes = @notes
      WHERE id = @id
    `);
    const updateVendor = dbSt.db.prepare(`
      UPDATE statements SET vendor_name = @vendor, norm_vendor = @vendor WHERE id = @id
    `);
    const updateSums = dbSt.db.prepare(`
      UPDATE statements
      SET supply_amount = @supply, vat_amount = @vat, total_amount = @total
      WHERE id = @id
    `);
    const sumItems = dbSt.db.prepare(`
      SELECT SUM(amount) AS supply, SUM(vat) AS vat
      FROM statement_items WHERE statement_id = ?
    `);

    let matched = 0;
    let ambiguous = 0;
    let failed = 0;
    const touched = new Set();
    const usedByPpt = new Map();
    const textByPpt = new Map();
    const samples = [];

    for (const r of rows) {
      const key = parentPptxKey(r.source_file);
      if (!key) continue;
      const cur = textByPpt.get(key) || '';
      const add = [`원본:${r.source_file}`, r.raw_extract, r.statement_notes, r.item_notes, r.item_name, r.spec].filter(Boolean).join('\n');
      textByPpt.set(key, (cur + '\n' + add).slice(0, 16000));
    }

    const tx = dbSt.db.transaction(() => {
      for (const r of rows) {
        const dateStr = inferDateFromName(r.source_file) || r.doc_date;
        const pptKey = parentPptxKey(r.source_file);
        const dayRange = getPptMatchDayRange(dateStr || r.doc_date);
        if (pptKey && !usedByPpt.has(pptKey)) usedByPpt.set(pptKey, new Set());
        const excludeKeys = pptKey ? usedByPpt.get(pptKey) : null;
        const m = learningPool.matchCompanySaleItem({
          item_name: r.item_name,
          spec: r.spec,
          quantity: r.quantity,
        }, {
          dateStr,
          altDateStr: r.doc_date,
          vendorHint: r.vendor_name || r.norm_vendor,
          textHint: [textByPpt.get(pptKey), r.source_file, r.raw_extract, r.statement_notes, r.item_notes, r.item_name, r.spec].filter(Boolean).join('\n'),
          dayRange,
          excludeKeys,
        });

        if (!m.matched) {
          if (m.reason === 'ambiguous') ambiguous++;
          else failed++;
          if (samples.length < 8) {
            samples.push({
              id: r.statement_id,
              item: r.item_name,
              spec: r.spec,
              reason: m.reason,
              candidates: (m.candidates || []).slice(0, 3).map(c => ({
                item: c.row.item,
                spec: c.row.spec,
                qty: c.row.qty,
                price: c.row.price,
                score: c.score,
              })),
            });
          }
          continue;
        }

        const mr = m.matched;
        const amount = Number(mr.amount) || ((Number(mr.qty) || 0) * (Number(mr.price) || 0)) || 0;
        const vat = Math.round(amount * 0.1);
        updateItem.run({
          id: r.item_id,
          item_name: mr.item,
          spec: mr.spec,
          quantity: mr.qty,
          unit_price: mr.price || 0,
          amount,
          vat,
          notes: `학습재매칭: ${m.reason} / score ${m.score}`,
        });
        if (mr.vendor) updateVendor.run({ id: r.statement_id, vendor: mr.vendor });
        if (excludeKeys) excludeKeys.add(learningPool.companySaleRowKey(mr));
        touched.add(r.statement_id);
        matched++;
      }

      for (const id of touched) {
        const sums = sumItems.get(id);
        const supply = Math.round(Number(sums?.supply) || 0);
        const vat = Math.round(Number(sums?.vat) || 0);
        updateSums.run({ id, supply, vat, total: supply + vat });
      }
    });
    tx();

    res.json({ ok: true, scanned: rows.length, matched, ambiguous, failed, updatedStatements: touched.size, samples });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 학습 풀 상태/통계
router.get('/learning-pool/stats', requireAuth, (req, res) => {
  const learningPool = require('../lib/learning-pool');
  res.json({ ok: true, ...learningPool.getStats() });
});

// 학습 풀 다시 로드 (자료 추가했을 때)
router.post('/learning-pool/reload', requireAuth, async (req, res) => {
  const learningPool = require('../lib/learning-pool');
  try {
    const stats = await learningPool.load();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 거래처 검색 (자동완성 / F2 검색)
router.get('/learning-pool/search-vendor', requireAuth, (req, res) => {
  const learningPool = require('../lib/learning-pool');
  const { company, docClass, q } = req.query;
  const results = learningPool.findVendor(company, docClass, q);
  res.json({ ok: true, results });
});

// 품목 검색
router.get('/learning-pool/search-item', requireAuth, (req, res) => {
  const learningPool = require('../lib/learning-pool');
  const { company, docClass, q } = req.query;
  const results = learningPool.findItem(company, docClass, q);
  res.json({ ok: true, results });
});

// 거래처별 결합 패턴 (④ 컴퍼니 매출)
router.get('/learning-pool/combos', requireAuth, (req, res) => {
  const learningPool = require('../lib/learning-pool');
  const { vendor } = req.query;
  const results = learningPool.getCombosForVendor(vendor);
  res.json({ ok: true, results });
});

// 엑셀 미리보기 (SheetJS 로 브라우저에서 렌더링) - 파일 raw 응답
router.get('/data-source-file', requireAuth, (req, res) => {
  const fp = req.query.path;
  if (!fp) return res.status(400).send('path 필수');

  const root = path.resolve(LEARNING_DIR);
  const requested = path.resolve(String(fp));
  const rel = path.relative(root, requested);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(403).send('허용된 경로 아님 (learning-data 안만 가능)');
  }
  if (!/\.(xlsx|xls|csv|db)$/i.test(requested)) return res.status(400).send('허용되지 않는 파일 형식');
  if (!fs.existsSync(requested)) return res.status(404).send('파일 없음');
  res.sendFile(requested);
});

// ── 시안 문구 확인 (이미지 JPG/PNG) ──
// 카톡 시안 이미지 → Claude Code CLI 로 다국어 텍스트 추출 + 명백한 오타/문자 오류 확인
// (사용자 구독 안에서, 비용 0)
router.post('/spell-check', requireAuth, upload.array('files', 50), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ ok: false, error: '파일 없음' });
  const cli = require('../lib/claude-cli');
  const results = [];

  const PROMPT = `이 이미지는 인쇄·사인물·간판·스티커 등에 들어갈 시안 이미지입니다.
시각 디자인/레이아웃/색상/폰트 품질은 평가하지 말고, **이미지 안의 문구와 문자만** 확인하세요.
한국어, 영어, 중국어, 태국어, 미얀마어 등 여러 언어가 섞여 있을 수 있습니다.
보이는 텍스트는 원문 언어 그대로 추출하고, **명백한** 오타/철자 오류/문자 깨짐만 보고하세요.

JSON 만 출력:
{
  "text": "시안 텍스트 (원문 언어 그대로, 줄바꿈 포함, 보이는 그대로 정확히)",
  "issues": [
    { "type": "오타|철자|문자깨짐|사이즈|숫자|기타", "message": "문제 설명", "found": "시안에 적힌 정확한 표현", "suggest": "수정 제안" }
  ]
}

**엄격 규칙 (반드시 준수):**

1. **글자가 완벽히 안 보이거나 흐리면 issues 추가 금지.** 추측 X. 확신 없으면 정상으로 간주.
2. 다음 케이스는 **절대 issues 에 넣지 마라**:
   - 다른 언어라는 이유 자체 (태국어/미얀마어/중국어/영어가 보이는 것은 정상)
   - 원문 언어를 한국어로 번역하거나 의역한 제안
   - 중국어 간체/번체 차이, 태국어/미얀마어의 띄어쓰기 없음, 로마자 표기 차이처럼 현지 표기 관습일 수 있는 것
   - 한국어 정상 표현 (예: "안전복착용", "안전모착용", "보안경착용", "안전장갑착용", "안전화착용", "방독마스크착용", "방진마스크착용", "귀마개착용" 모두 정상)
   - 디자인 의도된 띄어쓰기 (예: "화 상 주 의", "고 온 경 고" 처럼 글자 사이 공백은 디자인 — 오타 아님)
   - 단위가 다른 표기 (예: "300*400" 가로세로 mm 와 "3T" 두께는 다른 단위 — 통일 불필요)
   - 한국 사인물 표준 표기 ("담당자", "주소", "현장" 등 그대로 OK)
   - 산수 추론 ("X개씩 Y종 = Z개" 같은 수량 검증 절대 하지 마라)
   - 글자가 명확히 안 보여서 추측한 의심
3. **진짜 오타/철자 오류 = 해당 언어에서 명백히 잘못된 단어, 누락/중복 글자, 깨진 문자, 잘못 들어간 자모/문자**만.
   예시: "되요"(O→돼요), "할 수 잇다"(O→있다), "환경" 인데 "환겅" 이라고 적힘
4. 동일 시안 안에서 같은 단어/품명/규격인데 서로 다르게 쓴 경우만 불일치 issue 로 보고.
5. **확신 없으면 issues=[].** false positive 가 false negative 보다 훨씬 안 좋음.

text 는 시안 안 글자 그대로. 번역하지 마라. 안 보이는 글자는 적지 마라 (추측 X).
JSON 외 텍스트 절대 X.`;

  // 동시 호출 (CLI 가 격리된 cwd 로 spawn 되어 병렬 가능)
  // 시안 문구 확인은 Sonnet (속도 우선) — 사장님 구독 안에서 무료, 3배 빠름
  await Promise.all(files.map(async (f) => {
    try {
      const r = await cli.callClaudeCli(PROMPT, [f.path], { model: 'claude-sonnet-4-6' });
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

module.exports = router;
