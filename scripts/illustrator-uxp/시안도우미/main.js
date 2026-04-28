/**
 * 시안 도우미 — 단순화 버전 (네이티브 UXP API)
 *
 * 핵심 변경:
 * - 모든 입력 필드를 항상 보이게 (drawer/popup 제거)
 * - HTML datalist 로 네이티브 콤보박스 (타이핑 + 자동완성)
 * - + 옵션은 inline sub-panel 토글
 * - 시안 저장 form 항상 보임 — 한 화면에 다
 */

const ilst = require('illustrator');
const { app, core } = ilst;
const lfs = require('uxp').storage.localFileSystem;

// 저장 옵션 클래스 (UXP 글로벌)
let IllustratorSaveOptions, PDFSaveOptions, ExportOptionsJPEG;
let Compatibility, PDFCompatibility, ExportType, OutputFlattening, Justification;
try {
  IllustratorSaveOptions = ilst.IllustratorSaveOptions || globalThis.IllustratorSaveOptions;
  PDFSaveOptions = ilst.PDFSaveOptions || globalThis.PDFSaveOptions;
  ExportOptionsJPEG = ilst.ExportOptionsJPEG || globalThis.ExportOptionsJPEG;
  Compatibility = ilst.Compatibility || globalThis.Compatibility;
  PDFCompatibility = ilst.PDFCompatibility || globalThis.PDFCompatibility;
  ExportType = ilst.ExportType || globalThis.ExportType;
  OutputFlattening = ilst.OutputFlattening || globalThis.OutputFlattening;
  Justification = ilst.Justification || globalThis.Justification;
} catch (e) { /* fall through */ }

// ── 마스터 사전 (폴백 — 서버 API 실패 시 사용) ──
let KIND_DICT = [
  "현수막","배너","타포린","깃발","어깨띠",
  "포맥스","3t포맥스","5t포맥스","1t포맥스","10t포맥스",
  "후렉스","그레이플렉스","폼보드","화이트보드",
  "스티커","실사","시트커팅","유포","합성지",
  "A형철판","A형간판","X배너","피켓",
  "PE간판","PE소형","PE대형","잔넬","돌출표찰","표지판","액자","등신대",
  "천막","캐노피","아크릴포켓",
  "아연파이프","각관","각파이프","철판","강판","갈바","칼라철판",
  "SUS","스텐","알미늄","동판",
  "(CH)현수막","(CH)솔벤현수막","(CH)점착현수막",
  "이노폼","솔벤시트","ITM합성지","PVC-CAL","무광코팅지","코팅필름",
  "반사시트","축광시트","안개시트","페트지","돔보커팅",
  "고무자석","자석",
  "안전모","안전화","안전조끼","헬멧","보호구","마스크","보안경",
  "가림막","휀스","반사경","라바콘","칼라콘",
  "앵글","브라켓","경첩","프레임","틀제작","문틀","지주",
  "아크릴","렉산","합판","MDF","테이프","본드","실리콘",
  "페인트","래커","락카","볼트","피스",
  "LED","전구","형광등","스위치","케이블"
];
let BRAND_DICT = [
  "포스코이앤씨","DL이앤씨","현대산업개발","요진건설","동명이엔지","삼성라코스",
  "두산","쌍용건설","이상테크윈","대림건설","한신공영","우정은","보성세이프",
  "GC녹십자EM","오엠알오","극동건설","관보토건(주)","글로벌텍 나이스텍"
];
let VENDOR_DICT = [
  "공장","코리아","한진","라코스","현진","대풍","배너스토어","한양안전",
  "세계로","풍아몰","이용전","대영","현대상사","건우","동방사","서진","kep","풍아"
];
// OPTION_DICT — 서버 마스터 API 에서 동적 로드. 실패 시 아래 폴백 사용.
// 폴백: v7 마스터 빈도 Top (오프라인 모드 안전망)
let OPTION_DICT = [
  "양면","단면","사방타공","타공",
  "양면테이프","벨크로",
  "아일렛","자립","집게","클램프",
  "아크릴포켓","클리어파일","은경아크릴",
  "화이트보드코팅","반사시트","축광시트",
  "넘버링","LED",
  "이마돌출","상단처마","천정다보","이동식바퀴","아스테지"
];

// 서버 마스터 API 설정
const MASTER_API_BASE = "http://192.168.0.133:3000/api/master";
const DESIGNER_TOKEN = "designer-default-key-change-in-env";  // env 와 동일

const DESIGN_ROOT = "D:\\";
const YEAR = new Date().getFullYear() + "시안작업";

// ── DOM 헬퍼 ──
const $ = (id) => document.getElementById(id);
const sanitize = (s) => String(s || "").replace(/[\\\/:*?"<>|]/g, "").replace(/\s+/g, "");
const pad2 = (n) => String(n).padStart(2, "0");
const todayMMDD = () => {
  const d = new Date();
  return pad2(d.getMonth() + 1) + pad2(d.getDate());
};

function buildFileName(d, purpose) {
  const parts = [];
  if (d.월일) parts.push(d.월일);
  if (d.건설사) parts.push(sanitize(d.건설사));
  if (d.현장) parts.push(sanitize(d.현장));
  if (d.종류) parts.push(sanitize(d.종류));
  if (d.옵션) parts.push(sanitize(d.옵션));
  if (d.버전) parts.push(d.버전);
  let base = parts.join("-");
  if (purpose && purpose !== "원본") base += `-발주(${purpose})`;
  return base;
}
function buildFolder(d) {
  const root = DESIGN_ROOT.replace(/[\\\/]+$/, "");
  const folders = [root];
  const brand = String(d.건설사 || "").replace(/[\\\/:*?"<>|]/g, "").replace(/^★+/, "");
  if (brand) folders.push(brand);
  folders.push(YEAR);
  if (d.현장) folders.push(sanitize(d.현장));
  return folders.join("\\");
}
function showStatus(msg, level) {
  const el = $("status");
  el.textContent = msg;
  el.className = level || "";
  if (msg) setTimeout(() => { el.textContent = ""; el.className = ""; }, 8000);
}

// ── datalist 채우기 (네이티브 콤보박스) ──
function populateDatalist(id, items) {
  const list = $(id);
  list.innerHTML = "";
  items.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item;
    list.appendChild(opt);
  });
}

// ── 옵션 그리드 ──
function populateOptionGrid() {
  const grid = $("opt-grid");
  grid.innerHTML = "";
  OPTION_DICT.forEach(item => {
    const div = document.createElement("div");
    div.className = "opt-item";
    div.textContent = item;
    div.dataset.value = item;
    div.addEventListener("click", () => div.classList.toggle("checked"));
    grid.appendChild(div);
  });
}

// ── 미리보기 ──
function buildQty() {
  const mode = document.querySelector('input[name="qty-mode"]:checked').value;
  if (mode === "multi") {
    const e = $("qty-each").value.trim();
    const t = $("qty-total").value.trim();
    return e && t ? `각 ${e}개씩 총 ${t}개` : "";
  }
  const q = $("qty-single").value.trim();
  return q ? `${q}개` : "";
}
function updatePreview() {
  const spec = $("spec").value.trim();
  const kind = $("kind").value.trim();
  const opt = $("opt").value.trim();
  const qty = buildQty();
  const parts = [];
  if (spec) parts.push(spec);
  if (kind) parts.push(kind);
  if (opt) parts.push(opt);
  let line1 = parts.join(" ");
  if (qty) line1 += (line1 ? " - " : "") + qty;
  $("preview-line1").textContent = line1 || "(입력하면 여기 표시)";
  const m = $("date-month").value.trim();
  const d = $("date-day").value.trim();
  $("preview-line2").textContent = (m && d) ? `납품: ${m}/${d}` : "";
  // 저장 form 의 종류/옵션도 자동 동기화 (비어있을 때만)
  if (!$("save-kind").value || $("save-kind").dataset.auto) {
    $("save-kind").value = kind;
    $("save-kind").dataset.auto = "1";
  }
  if (!$("save-opt").value || $("save-opt").dataset.auto) {
    $("save-opt").value = opt;
    $("save-opt").dataset.auto = "1";
  }
  updateSaveFolder();
}
function updateSaveFolder() {
  $("save-folder").textContent = buildFolder({
    건설사: $("save-brand").value,
    현장: $("save-site").value
  }) || "D:\\...";
}

// ── 옵션 추가 패널 토글 ──
function toggleOptPanel() {
  $("opt-panel").classList.toggle("hidden");
}
function applyOptions() {
  const checked = Array.from($("opt-grid").querySelectorAll(".opt-item.checked"))
    .map(el => el.dataset.value);
  const customs = $("opt-custom").value.split(",").map(s => s.trim()).filter(Boolean);
  const all = [...checked, ...customs];
  if (all.length === 0) { showStatus("⚠️ 옵션 1개 이상 선택", "warn"); return; }
  let cur = $("kind").value;
  all.forEach(o => cur += "+" + o);
  $("kind").value = cur;
  $("kind").dispatchEvent(new Event("input"));
  // 초기화
  $("opt-grid").querySelectorAll(".opt-item.checked").forEach(el => el.classList.remove("checked"));
  $("opt-custom").value = "";
  $("opt-panel").classList.add("hidden");
  showStatus("✓ 옵션 추가됨: " + all.join(", "));
}

// ══════════════════════════════════════════════════════════
// 텍스트 삽입 (네이티브 UXP)
// ══════════════════════════════════════════════════════════
async function insertText() {
  const line1 = $("preview-line1").textContent;
  const line2 = $("preview-line2").textContent;
  if (line1 === "(입력하면 여기 표시)" || !line1) {
    showStatus("⚠️ 규격 또는 상품명 입력하세요", "warn"); return;
  }
  if (!app.documents || app.documents.length === 0) {
    showStatus("⚠️ 열린 문서가 없습니다", "warn"); return;
  }
  try {
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      let centerX = 300, topY = 0;
      try {
        const ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
        const rect = ab.artboardRect;
        centerX = (rect[0] + rect[2]) / 2;
        topY = rect[1] - 50;
      } catch (e) {}

      const tf1 = doc.textFrames.add();
      tf1.contents = line1;
      try { tf1.position = [centerX - 200, topY]; } catch(e) {}
      try {
        tf1.textRange.characterAttributes.size = 24;
        if (Justification && Justification.CENTER) {
          tf1.textRange.paragraphAttributes.justification = Justification.CENTER;
        }
      } catch(e) {}

      if (line2) {
        const tf2 = doc.textFrames.add();
        tf2.contents = line2;
        try { tf2.position = [centerX - 100, topY - 44]; } catch(e) {}
        try {
          tf2.textRange.characterAttributes.size = 18;
          if (Justification && Justification.CENTER) {
            tf2.textRange.paragraphAttributes.justification = Justification.CENTER;
          }
        } catch(e) {}
      }
    }, { commandName: "시안 텍스트 삽입" });
    showStatus("✓ 삽입 완료: " + line1.substring(0, 40));
  } catch (e) {
    showStatus("⚠️ 삽입 오류: " + (e.message || e), "error");
  }
}

// ══════════════════════════════════════════════════════════
// 폴더 생성 + 시안 저장 (네이티브 UXP)
// ══════════════════════════════════════════════════════════
async function ensureFolderNative(folderPath) {
  const url = "file://" + folderPath.replace(/\\/g, "/");
  try {
    return await lfs.getEntryWithUrl(url);
  } catch (e) {
    const parts = folderPath.split("\\").filter(Boolean);
    let curEntry = null;
    try { curEntry = await lfs.getEntryWithUrl("file://" + parts[0] + "/"); } catch (e2) {
      throw new Error("루트 접근 실패: " + parts[0]);
    }
    for (let i = 1; i < parts.length; i++) {
      try { curEntry = await curEntry.getEntry(parts[i]); }
      catch (e3) { curEntry = await curEntry.createFolder(parts[i]); }
    }
    return curEntry;
  }
}

async function saveDocument() {
  if (!$("save-brand").value) { showStatus("⚠️ 건설사 입력하세요", "warn"); return; }
  if (!$("save-kind").value) { showStatus("⚠️ 종류 입력하세요", "warn"); return; }
  const fmtAI = $("fmt-ai").checked;
  const fmtCS6 = $("fmt-cs6").checked;
  const fmtJPG = $("fmt-jpg").checked;
  const fmtPDF = $("fmt-pdf").checked;
  if (!fmtAI && !fmtCS6 && !fmtJPG && !fmtPDF) {
    showStatus("⚠️ 저장 형식 1개 이상 선택", "warn"); return;
  }
  if (!app.documents || app.documents.length === 0) {
    showStatus("⚠️ 열린 문서가 없습니다", "warn"); return;
  }

  const data = {
    월일: $("save-date").value,
    건설사: $("save-brand").value,
    현장: $("save-site").value,
    종류: $("save-kind").value,
    옵션: $("save-opt").value,
    버전: $("save-ver").value,
    발주처: $("save-vendor").value
  };
  const folderPath = buildFolder(data);
  const baseName = buildFileName(data, "원본");
  const orderName = data.발주처 ? buildFileName(data, data.발주처) : baseName;

  let saved = 0;
  const errors = [];

  try {
    const folderEntry = await ensureFolderNative(folderPath);
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (fmtAI) {
        try {
          const file = await folderEntry.createFile(baseName + ".ai", { overwrite: true });
          const opts = new IllustratorSaveOptions();
          opts.compatibility = Compatibility.ILLUSTRATOR;
          opts.fontSubsetThreshold = 100.0;
          opts.pdfCompatible = true;
          opts.embedICCProfile = true;
          opts.compressed = true;
          opts.embedLinkedFiles = false;
          opts.saveMultipleArtboards = false;
          if (OutputFlattening) opts.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
          await doc.saveAs(file, opts);
          saved++;
        } catch (e) { errors.push("원본 .ai: " + (e.message || e)); }
      }
      if (fmtJPG) {
        try {
          const file = await folderEntry.createFile(orderName + ".jpg", { overwrite: true });
          const opts = new ExportOptionsJPEG();
          opts.qualitySetting = 60;
          opts.antiAliasing = true;
          opts.optimization = true;
          await doc.exportFile(file, ExportType.JPEG, opts);
          saved++;
        } catch (e) { errors.push("JPG: " + (e.message || e)); }
      }
      if (fmtCS6) {
        try {
          let cs6Name = orderName + ".ai";
          if (cs6Name === baseName + ".ai") cs6Name = baseName + "-cs6.ai";
          const file = await folderEntry.createFile(cs6Name, { overwrite: true });
          const opts = new IllustratorSaveOptions();
          opts.compatibility = Compatibility.ILLUSTRATOR16;
          opts.fontSubsetThreshold = 100.0;
          opts.pdfCompatible = true;
          opts.embedICCProfile = true;
          opts.compressed = true;
          opts.embedLinkedFiles = false;
          opts.saveMultipleArtboards = false;
          if (OutputFlattening) opts.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
          await doc.saveAs(file, opts);
          saved++;
        } catch (e) { errors.push("CS6 .ai: " + (e.message || e)); }
      }
      if (fmtPDF) {
        try {
          const file = await folderEntry.createFile(orderName + ".pdf", { overwrite: true });
          const opts = new PDFSaveOptions();
          opts.compatibility = PDFCompatibility.ACROBAT7;
          opts.preserveEditability = true;
          opts.generateThumbnails = true;
          opts.optimization = false;
          opts.viewAfterSaving = false;
          opts.acrobatLayers = true;
          await doc.saveAs(file, opts);
          saved++;
        } catch (e) { errors.push("PDF: " + (e.message || e)); }
      }
    }, { commandName: "시안 저장" });

    if (errors.length > 0) {
      showStatus(`⚠️ ${saved}개 저장 / 오류 ${errors.length}: ${errors[0]}`, "warn");
    } else {
      showStatus(`✓ ${saved}개 파일 저장 완료`);
    }
  } catch (e) {
    showStatus("⚠️ 저장 오류: " + (e.message || e), "error");
  }
}

// ══════════════════════════════════════════════════════════
// 이벤트 와이어링
// ══════════════════════════════════════════════════════════
function clearAll() {
  ["spec","kind","opt","qty-each","qty-total"].forEach(id => $(id).value = "");
  $("qty-single").value = "1";
  document.querySelector('input[value="single"]').checked = true;
  $("qty-multi-row").classList.add("hidden");
  $("qty-single").disabled = false;
  const d = new Date();
  $("date-month").value = d.getMonth() + 1;
  $("date-day").value = d.getDate();
  $("save-kind").value = "";
  $("save-opt").value = "";
  delete $("save-kind").dataset.auto;
  delete $("save-opt").dataset.auto;
  updatePreview();
  showStatus("초기화됨");
}

// ══════════════════════════════════════════════════════════
// 서버 마스터 로드 (v7 엑셀 → 서버 → UXP)
// ══════════════════════════════════════════════════════════
async function loadServerMaster() {
  const headers = { "X-Designer-Token": DESIGNER_TOKEN };
  try {
    // 옵션 + 종류 병렬 호출
    const [optRes, kindRes, statusRes] = await Promise.all([
      fetch(`${MASTER_API_BASE}/options?limit=40&minCount=2`, { headers }),
      fetch(`${MASTER_API_BASE}/kinds`, { headers }),
      fetch(`${MASTER_API_BASE}/status`, { headers })
    ]);
    if (!optRes.ok || !kindRes.ok) throw new Error("API 응답 실패");

    const optData = await optRes.json();
    const kindData = await kindRes.json();
    const statusData = await statusRes.json();

    if (Array.isArray(optData.items) && optData.items.length > 0) {
      OPTION_DICT = optData.items.map(o => o.name);
    }
    if (Array.isArray(kindData.items) && kindData.items.length > 0) {
      KIND_DICT = kindData.items;
    }

    const lastP = statusData.lastParsed
      ? new Date(statusData.lastParsed).toLocaleString("ko-KR")
      : "?";
    showStatus(`✓ 서버 마스터 로드 (옵션 ${OPTION_DICT.length}, 종류 ${KIND_DICT.length}) — ${lastP}`);
    return true;
  } catch (e) {
    showStatus(`⚠ 서버 연결 실패 (오프라인 모드): ${e.message || e}`, "warn");
    return false;
  }
}

async function init() {
  // 1. 서버 마스터 시도 (실패 시 폴백 사용)
  await loadServerMaster();

  // 2. datalist + 옵션 그리드 채우기
  populateDatalist("kind-list", KIND_DICT);
  populateDatalist("brand-list", BRAND_DICT);
  populateDatalist("vendor-list", VENDOR_DICT);
  populateOptionGrid();

  // 입력 이벤트
  ["spec","kind","opt","qty-single","qty-each","qty-total","date-month","date-day"].forEach(id => {
    $(id).addEventListener("input", updatePreview);
  });
  document.querySelectorAll('input[name="qty-mode"]').forEach(rb => {
    rb.addEventListener("change", () => {
      const mode = document.querySelector('input[name="qty-mode"]:checked').value;
      $("qty-multi-row").classList.toggle("hidden", mode !== "multi");
      $("qty-single").disabled = (mode === "multi");
      updatePreview();
    });
  });
  // 저장 form 입력 이벤트
  ["save-brand","save-site"].forEach(id => $(id).addEventListener("input", updateSaveFolder));
  // 종류/옵션 직접 수정 시 자동 동기화 해제
  $("save-kind").addEventListener("input", () => delete $("save-kind").dataset.auto);
  $("save-opt").addEventListener("input", () => delete $("save-opt").dataset.auto);

  // 초기값
  const d = new Date();
  $("date-month").value = d.getMonth() + 1;
  $("date-day").value = d.getDate();
  $("save-date").value = todayMMDD();

  // 옵션 추가 패널
  $("kind-opt-btn").addEventListener("click", toggleOptPanel);
  $("opt-add-btn").addEventListener("click", applyOptions);
  $("opt-close-btn").addEventListener("click", () => $("opt-panel").classList.add("hidden"));

  // 메인 액션
  $("btn-insert").addEventListener("click", insertText);
  $("btn-clear").addEventListener("click", clearAll);
  $("btn-save").addEventListener("click", saveDocument);

  updatePreview();
}

init();
