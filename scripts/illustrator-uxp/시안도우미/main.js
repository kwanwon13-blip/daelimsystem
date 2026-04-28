/**
 * 시안 도우미 — UXP 플러그인 main 로직
 *
 * 이 파일은 UXP 환경에서 실행됨.
 * Illustrator 조작은 ExtendScript를 app.executeScript로 호출 (가장 안정적).
 */

// ── UXP API 핸들 ──
const ilst = require('illustrator');
const app = ilst.app;
const lfs = require('uxp').storage.localFileSystem;

// ── 마스터 사전 ──
const KIND_DICT = [
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

const BRAND_DICT = [
  "포스코이앤씨","DL이앤씨","현대산업개발","요진건설","동명이엔지","삼성라코스",
  "두산","쌍용건설","이상테크윈","대림건설","한신공영","우정은","보성세이프",
  "GC녹십자EM","오엠알오","극동건설","관보토건(주)","글로벌텍 나이스텍"
];

const VENDOR_DICT = [
  "공장","코리아","한진","라코스","현진","대풍","배너스토어","한양안전",
  "세계로","풍아몰","이용전","대영","현대상사","건우","동방사","서진","kep","풍아"
];

const OPTION_DICT = [
  "양면","단면",
  "사방타공","상단1타공","상단2타공","상단3타공","4방타공","6방타공",
  "양면테이프","리무버양면테이프",
  "화이트보드코팅","유포부착","유포유광","축광시트","바니쉬코팅",
  "자립","프레임","상단걸이","아일렛","아일렛타공","집게부착","벨크로부착",
  "A4아크릴포켓","A3아크릴포켓","파일케이스","클리어파일",
  "고무자석부착","음성경보기","멀티넘버링N4"
];

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

// ── 상태 표시 ──
function showStatus(msg, level) {
  const el = $("status");
  el.textContent = msg;
  el.className = level || "";
  if (msg) setTimeout(() => { el.textContent = ""; el.className = ""; }, 8000);
}

// ── 미리보기 빌드 ──
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
}

// ── 입력 이벤트 ──
function wireInputs() {
  ["spec","kind","opt","qty-single","qty-each","qty-total","date-month","date-day"].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener("input", updatePreview);
  });
  document.querySelectorAll('input[name="qty-mode"]').forEach(rb => {
    rb.addEventListener("change", () => {
      const mode = document.querySelector('input[name="qty-mode"]:checked').value;
      $("qty-multi-row").classList.toggle("hidden", mode !== "multi");
      $("qty-single").disabled = (mode === "multi");
      updatePreview();
    });
  });
  // 날짜 초기값
  const d = new Date();
  $("date-month").value = d.getMonth() + 1;
  $("date-day").value = d.getDate();
}

// ══════════════════════════════════════════════════════════
// DRAWER 제어
// ══════════════════════════════════════════════════════════
let drawerTargetInput = null;

function openDrawer(paneId) {
  $("drawer").classList.remove("hidden");
  ["pane-pick","pane-option","pane-save"].forEach(id => {
    $(id).classList.toggle("hidden", id !== paneId);
  });
}

function closeDrawer() {
  $("drawer").classList.add("hidden");
  drawerTargetInput = null;
}

// ── 사전 검색 (pane-pick) ──
let pickCurrentDict = [];
function openPick(dict, target) {
  drawerTargetInput = target;
  pickCurrentDict = dict;
  $("pick-search").value = target.value || "";
  refreshPickList();
  openDrawer("pane-pick");
  $("pick-search").focus();
}

function refreshPickList() {
  const query = $("pick-search").value.toLowerCase();
  const list = $("pick-list");
  list.innerHTML = "";
  pickCurrentDict.forEach(item => {
    if (!query || item.toLowerCase().includes(query)) {
      const div = document.createElement("div");
      div.className = "item";
      div.textContent = item;
      div.addEventListener("click", () => {
        // 단일 선택 강조
        list.querySelectorAll(".item.selected").forEach(el => el.classList.remove("selected"));
        div.classList.add("selected");
      });
      div.addEventListener("dblclick", () => {
        if (drawerTargetInput) {
          drawerTargetInput.value = item;
          drawerTargetInput.dispatchEvent(new Event("input"));
        }
        closeDrawer();
      });
      list.appendChild(div);
    }
  });
}

function pickConfirm() {
  const sel = $("pick-list").querySelector(".item.selected");
  if (drawerTargetInput) {
    if (sel) drawerTargetInput.value = sel.textContent;
    else if ($("pick-search").value) drawerTargetInput.value = $("pick-search").value;
    drawerTargetInput.dispatchEvent(new Event("input"));
  }
  closeDrawer();
}

// ── 옵션 다중 선택 (pane-option) ──
function openOption(target) {
  drawerTargetInput = target;
  $("opt-search").value = "";
  $("opt-custom").value = "";
  refreshOptList();
  openDrawer("pane-option");
}

function refreshOptList() {
  const query = $("opt-search").value.toLowerCase();
  const list = $("opt-list");
  list.innerHTML = "";
  OPTION_DICT.forEach(item => {
    if (!query || item.toLowerCase().includes(query)) {
      const div = document.createElement("div");
      div.className = "item";
      div.textContent = item;
      div.dataset.value = item;
      div.addEventListener("click", () => {
        div.classList.toggle("checked");
      });
      list.appendChild(div);
    }
  });
}

function optionAdd() {
  const checkedItems = Array.from($("opt-list").querySelectorAll(".item.checked"))
    .map(el => el.dataset.value);
  const customs = $("opt-custom").value.split(",").map(s => s.trim()).filter(Boolean);
  const all = [...checkedItems, ...customs];
  if (all.length > 0 && drawerTargetInput) {
    let current = drawerTargetInput.value;
    all.forEach(opt => current += "+" + opt);
    drawerTargetInput.value = current;
    drawerTargetInput.dispatchEvent(new Event("input"));
  }
  closeDrawer();
}

// ── 시안 저장 form (pane-save) ──
function openSave() {
  $("save-date").value = todayMMDD();
  $("save-kind").value = $("kind").value;
  $("save-opt").value = $("opt").value;
  updateSaveFolder();
  openDrawer("pane-save");
}

function updateSaveFolder() {
  $("save-folder").textContent = buildFolder({
    건설사: $("save-brand").value,
    현장: $("save-site").value
  });
}

// ══════════════════════════════════════════════════════════
// 일러스트 동작 — ExtendScript 브리지
// (UXP의 Illustrator API가 아직 일부만 지원되어
//  안정적인 ExtendScript via executeScript 사용)
// ══════════════════════════════════════════════════════════

async function runES(code) {
  try {
    // Illustrator UXP에서는 app.activeDocument 등의 API를 직접 쓸 수 있지만
    // 이전 .jsx 로직을 그대로 활용하기 위해 ExtendScript 브리지 사용
    // app.executeScript는 Illustrator UXP에서 제공
    return await app.executeScript(code);
  } catch (e) {
    throw new Error("ExtendScript 실행 실패: " + (e.message || e));
  }
}

async function insertText() {
  const line1 = $("preview-line1").textContent;
  const line2 = $("preview-line2").textContent;
  if (line1 === "(입력하면 여기 표시)" || !line1) {
    showStatus("⚠️ 규격 또는 상품명 입력하세요", "warn");
    return;
  }

  const code = `
    (function() {
      if (!app.documents.length) return "NO_DOC";
      var doc = app.activeDocument;
      var centerX = 300, topY = 0;
      try {
        var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
        var rect = ab.artboardRect;
        centerX = (rect[0] + rect[2]) / 2;
        topY = rect[1] - 50;
      } catch(e) {}
      var tf1 = doc.textFrames.add();
      tf1.contents = ${JSON.stringify(line1)};
      try { tf1.position = [centerX - 200, topY]; } catch(e) {}
      try {
        tf1.textRange.characterAttributes.size = 24;
        tf1.textRange.paragraphAttributes.justification = Justification.CENTER;
      } catch(e) {}
      ${line2 ? `
      var tf2 = doc.textFrames.add();
      tf2.contents = ${JSON.stringify(line2)};
      try { tf2.position = [centerX - 100, topY - 44]; } catch(e) {}
      try {
        tf2.textRange.characterAttributes.size = 18;
        tf2.textRange.paragraphAttributes.justification = Justification.CENTER;
      } catch(e) {}
      ` : ''}
      return "OK";
    })();
  `;

  try {
    const result = await runES(code);
    if (result === "NO_DOC") showStatus("⚠️ 열린 문서가 없습니다", "warn");
    else showStatus("✓ 삽입 완료: " + line1.substring(0, 40));
  } catch (e) {
    showStatus("⚠️ 삽입 오류: " + e.message, "error");
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

  const data = {
    월일: $("save-date").value,
    건설사: $("save-brand").value,
    현장: $("save-site").value,
    종류: $("save-kind").value,
    옵션: $("save-opt").value,
    버전: $("save-ver").value,
    발주처: $("save-vendor").value
  };
  const folder = buildFolder(data);
  const baseName = buildFileName(data, "원본");
  const orderName = data.발주처 ? buildFileName(data, data.발주처) : baseName;

  // ExtendScript로 저장 실행 — 폴더 생성 + 4가지 형식
  const code = `
    (function() {
      if (!app.documents.length) return "NO_DOC";
      var doc = app.activeDocument;
      var folder = ${JSON.stringify(folder)};
      var baseName = ${JSON.stringify(baseName)};
      var orderName = ${JSON.stringify(orderName)};
      var saved = [];
      var errors = [];

      // 폴더 생성
      var fObj = new Folder(folder);
      if (!fObj.exists) fObj.create();

      function saveAI(filePath, comp) {
        var opts = new IllustratorSaveOptions();
        opts.compatibility = comp;
        opts.fontSubsetThreshold = 100.0;
        opts.pdfCompatible = true;
        opts.embedICCProfile = true;
        opts.compressed = true;
        opts.embedLinkedFiles = false;
        opts.saveMultipleArtboards = false;
        opts.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
        doc.saveAs(new File(filePath), opts);
      }
      function savePDF(filePath) {
        var opts = new PDFSaveOptions();
        opts.compatibility = PDFCompatibility.ACROBAT7;
        opts.preserveEditability = true;
        opts.generateThumbnails = true;
        opts.optimization = false;
        opts.viewAfterSaving = false;
        opts.acrobatLayers = true;
        doc.saveAs(new File(filePath), opts);
      }
      function expJPG(filePath) {
        var opts = new ExportOptionsJPEG();
        opts.qualitySetting = 60;
        opts.antiAliasing = true;
        opts.optimization = true;
        doc.exportFile(new File(filePath), ExportType.JPEG, opts);
      }

      ${fmtAI ? `try { var p1 = folder + "\\\\" + baseName + ".ai"; saveAI(p1, Compatibility.ILLUSTRATOR); saved.push(p1); } catch(e) { errors.push("원본 .ai: " + e.message); }` : ''}
      ${fmtJPG ? `try { var p2 = folder + "\\\\" + orderName + ".jpg"; expJPG(p2); saved.push(p2); } catch(e) { errors.push("JPG: " + e.message); }` : ''}
      ${fmtCS6 ? `try {
        var p3 = folder + "\\\\" + orderName + ".ai";
        if (p3 === folder + "\\\\" + baseName + ".ai") p3 = folder + "\\\\" + baseName + "-cs6.ai";
        saveAI(p3, Compatibility.ILLUSTRATOR16);
        saved.push(p3);
      } catch(e) { errors.push("CS6 .ai: " + e.message); }` : ''}
      ${fmtPDF ? `try { var p4 = folder + "\\\\" + orderName + ".pdf"; savePDF(p4); saved.push(p4); } catch(e) { errors.push("PDF: " + e.message); }` : ''}

      return JSON.stringify({ saved: saved.length, errors: errors });
    })();
  `;

  try {
    const result = await runES(code);
    if (result === "NO_DOC") { showStatus("⚠️ 열린 문서가 없습니다", "warn"); return; }
    const parsed = JSON.parse(result);
    if (parsed.errors && parsed.errors.length > 0) {
      showStatus(`⚠️ 저장 ${parsed.saved}개 / 오류 ${parsed.errors.length}건: ${parsed.errors[0]}`, "warn");
    } else {
      showStatus(`✓ 저장 완료: ${parsed.saved}개 파일 (${folder})`);
    }
    closeDrawer();
  } catch (e) {
    showStatus("⚠️ 저장 오류: " + e.message, "error");
  }
}

// ══════════════════════════════════════════════════════════
// 이벤트 와이어링
// ══════════════════════════════════════════════════════════
function wireEvents() {
  // 콤보 버튼
  $("kind-pick").addEventListener("click", () => openPick(KIND_DICT, $("kind")));
  $("kind-opt").addEventListener("click", () => openOption($("kind")));

  // 메인 액션
  $("btn-insert").addEventListener("click", insertText);
  $("btn-clear").addEventListener("click", () => {
    ["spec","kind","opt","qty-each","qty-total"].forEach(id => $(id).value = "");
    $("qty-single").value = "1";
    document.querySelector('input[value="single"]').checked = true;
    $("qty-multi-row").classList.add("hidden");
    $("qty-single").disabled = false;
    const d = new Date();
    $("date-month").value = d.getMonth() + 1;
    $("date-day").value = d.getDate();
    updatePreview();
    showStatus("초기화됨");
  });
  $("btn-save").addEventListener("click", openSave);

  // PICK
  $("pick-search").addEventListener("input", refreshPickList);
  $("pick-ok").addEventListener("click", pickConfirm);
  $("pick-cancel").addEventListener("click", closeDrawer);

  // OPTION
  $("opt-search").addEventListener("input", refreshOptList);
  $("opt-add").addEventListener("click", optionAdd);
  $("opt-cancel").addEventListener("click", closeDrawer);

  // SAVE
  $("save-brand").addEventListener("input", updateSaveFolder);
  $("save-site").addEventListener("input", updateSaveFolder);
  $("save-brand-pick").addEventListener("click", () => openPick(BRAND_DICT, $("save-brand")));
  $("save-vendor-pick").addEventListener("click", () => openPick(VENDOR_DICT, $("save-vendor")));
  $("save-exec").addEventListener("click", saveDocument);
  $("save-cancel").addEventListener("click", closeDrawer);
}

// ══════════════════════════════════════════════════════════
// 초기화
// ══════════════════════════════════════════════════════════
wireInputs();
wireEvents();
updatePreview();
