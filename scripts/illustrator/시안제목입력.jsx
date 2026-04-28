#targetengine "session"
/**
 * 시안제목입력.jsx — 통합 (텍스트 입력 + 시안 저장)
 *
 * 한 palette 안에 모든 기능:
 * - 콤보박스 (검색 가능): 타이핑 + 사전에서 선택
 * - 텍스트 삽입 (시안에 표준 텍스트)
 * - 시안 저장 (같은 스크립트 안의 모달 다이얼로그)
 * - 미니마이즈 토글 (전체 압축)
 */

$.global.__designerScriptPath = $.fileName;

// ══════════════════════════════════════════════════════════
// 설정
// ══════════════════════════════════════════════════════════
var CONFIG = {
  ERP_HOST: "192.168.0.133",
  ERP_PORT: "3000",
  DESIGNER_TOKEN: "designer-default-key-change-in-env",
  DESIGN_ROOT: "D:\\",
  YEAR: new Date().getFullYear() + "시안작업"
};

// ══════════════════════════════════════════════════════════
// 마스터 사전 (combobox 검색용)
// ══════════════════════════════════════════════════════════
var KIND_DICT = [
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

var BRAND_DICT = [
  "포스코이앤씨","DL이앤씨","현대산업개발","요진건설","동명이엔지","삼성라코스",
  "두산","쌍용건설","이상테크윈","대림건설","한신공영","우정은","보성세이프",
  "GC녹십자EM","오엠알오","극동건설","관보토건(주)","글로벌텍 나이스텍"
];

var VENDOR_DICT = [
  "공장","코리아","한진","라코스","현진","대풍","배너스토어","한양안전",
  "세계로","풍아몰","이용전","대영","현대상사","건우","동방사","서진","kep","풍아"
];

// ══════════════════════════════════════════════════════════
// 검색 가능한 사전 팝업 (live filter)
// ══════════════════════════════════════════════════════════
function showPickerPopup(currentValue, dictArray, onSelect) {
  var popup = new Window("dialog", "사전에서 선택 (타이핑으로 검색)");
  popup.orientation = "column";
  popup.alignChildren = "fill";
  popup.preferredSize.width = 320;

  var searchRow = popup.add("group");
  searchRow.add("statictext", undefined, "🔍 검색:");
  var searchInput = searchRow.add("edittext", undefined, currentValue || "");
  searchInput.characters = 25;
  searchInput.active = true;

  var lb = popup.add("listbox", undefined, []);
  lb.preferredSize = [300, 320];

  function refreshList() {
    var query = String(searchInput.text || "").toLowerCase();
    lb.removeAll();
    var matched = [];
    for (var i = 0; i < dictArray.length; i++) {
      var item = dictArray[i];
      if (!query || String(item).toLowerCase().indexOf(query) >= 0) {
        matched.push(item);
      }
    }
    for (var j = 0; j < matched.length; j++) lb.add("item", matched[j]);
    if (lb.items.length > 0) lb.selection = 0;
  }

  searchInput.onChanging = refreshList;
  refreshList();

  var btnRow = popup.add("group");
  btnRow.alignment = "right";
  var okBtn = btnRow.add("button", undefined, "선택", { name: "ok" });
  var cancelBtn = btnRow.add("button", undefined, "취소", { name: "cancel" });

  function pickAndClose() {
    if (lb.selection) {
      onSelect(lb.selection.text);
      popup.close(1);
    } else if (searchInput.text) {
      // 검색어를 그대로 입력값으로 사용
      onSelect(searchInput.text);
      popup.close(1);
    }
  }

  lb.onDoubleClick = pickAndClose;
  okBtn.onClick = pickAndClose;
  cancelBtn.onClick = function() { popup.close(0); };

  popup.show();
}

// ══════════════════════════════════════════════════════════
// 콤보박스 (edittext + ▼ 검색 사전 버튼)
// ══════════════════════════════════════════════════════════
function makeCombo(parent, labelText, dictArray, placeholder, labelWidth) {
  var g = parent.add("group");
  g.orientation = "row";
  g.alignChildren = ["left", "center"];

  var lbl = g.add("statictext", undefined, labelText);
  lbl.preferredSize.width = labelWidth || 60;

  var input = g.add("edittext", undefined, "");
  input.characters = 24;
  if (placeholder) input.helpTip = placeholder;

  if (dictArray && dictArray.length > 0) {
    var pickBtn = g.add("button", undefined, "▼");
    pickBtn.preferredSize = [28, 22];
    pickBtn.helpTip = "사전 검색 + 선택";
    pickBtn.onClick = function() {
      showPickerPopup(input.text, dictArray, function(selected) {
        input.text = selected;
        try { if (input.onChanging) input.onChanging(); } catch(e) {}
      });
    };
  }
  return input;
}

// ══════════════════════════════════════════════════════════
// 파일명/폴더 유틸
// ══════════════════════════════════════════════════════════
function sanitize(s) {
  if (!s) return "";
  return String(s).replace(/[\\\/:*?"<>|]/g, "").replace(/\s+/g, "");
}
function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
function todayMMDD() {
  var d = new Date();
  return pad2(d.getMonth() + 1) + pad2(d.getDate());
}
function buildFileName(d, purpose) {
  var parts = [];
  if (d.월일) parts.push(d.월일);
  if (d.건설사) parts.push(sanitize(d.건설사));
  if (d.현장) parts.push(sanitize(d.현장));
  if (d.종류) parts.push(sanitize(d.종류));
  if (d.내용) parts.push(sanitize(d.내용));
  if (d.버전) parts.push(d.버전);
  var base = parts.join("-");
  if (purpose && purpose !== "원본") base += "-발주(" + purpose + ")";
  return base;
}
function buildFolder(d) {
  var root = CONFIG.DESIGN_ROOT.replace(/[\\\/]+$/, "");
  var folders = [root];
  var brand = String(d.건설사 || "").replace(/[\\\/:*?"<>|]/g, "").replace(/^★+/, "");
  if (brand) folders.push(brand);
  folders.push(CONFIG.YEAR);
  if (d.현장) folders.push(sanitize(d.현장));
  return folders.join("\\");
}
function ensureFolder(folderPath) {
  var f = new Folder(folderPath);
  if (!f.exists) f.create();
  return f;
}

// ══════════════════════════════════════════════════════════
// 일러스트 저장 함수들
// ══════════════════════════════════════════════════════════
function saveAsAI(doc, filePath, compatibility) {
  var opts = new IllustratorSaveOptions();
  opts.compatibility = compatibility;
  opts.fontSubsetThreshold = 100.0;
  opts.pdfCompatible = true;
  opts.embedICCProfile = true;
  opts.compressed = true;
  opts.embedLinkedFiles = false;
  opts.saveMultipleArtboards = false;
  opts.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
  doc.saveAs(new File(filePath), opts);
}
function saveAsPDF(doc, filePath) {
  var opts = new PDFSaveOptions();
  opts.compatibility = PDFCompatibility.ACROBAT7;
  opts.preserveEditability = true;
  opts.generateThumbnails = true;
  opts.optimization = false;
  opts.viewAfterSaving = false;
  opts.acrobatLayers = true;
  doc.saveAs(new File(filePath), opts);
}
function exportJPG(doc, filePath, quality) {
  var opts = new ExportOptionsJPEG();
  opts.qualitySetting = quality || 60;
  opts.antiAliasing = true;
  opts.optimization = true;
  doc.exportFile(new File(filePath), ExportType.JPEG, opts);
}

// ══════════════════════════════════════════════════════════
// 텍스트 프레임 삽입 (defensive)
// ══════════════════════════════════════════════════════════
function insertTextFrames(doc, data) {
  var centerX = 300, topY = 0;
  try {
    var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
    var rect = ab.artboardRect;
    centerX = (rect[0] + rect[2]) / 2;
    topY = rect[1] - 50;
  } catch(e) {}

  var tf1 = doc.textFrames.add();
  tf1.contents = data.line1;
  try { tf1.position = [centerX - 200, topY]; } catch(e) {}
  try {
    tf1.textRange.characterAttributes.size = data.fontSize1;
    if (data.alignCenter) {
      try { tf1.textRange.paragraphAttributes.justification = Justification.CENTER; } catch(e) {}
    }
  } catch(e) {}

  if (data.line2) {
    var tf2 = doc.textFrames.add();
    tf2.contents = data.line2;
    try { tf2.position = [centerX - 100, topY - data.fontSize1 - 20]; } catch(e) {}
    try {
      tf2.textRange.characterAttributes.size = data.fontSize2;
      if (data.alignCenter) {
        try { tf2.textRange.paragraphAttributes.justification = Justification.CENTER; } catch(e) {}
      }
    } catch(e) {}
  }
}

// ══════════════════════════════════════════════════════════
// 시안 저장 모달 다이얼로그 (같은 스크립트 안에서)
// ══════════════════════════════════════════════════════════
function showSaveDialog(prefill) {
  prefill = prefill || {};
  var dlg = new Window("dialog", "💾 시안 저장");
  dlg.orientation = "column";
  dlg.alignChildren = "fill";
  dlg.preferredSize.width = 520;

  var infoP = dlg.add("panel", undefined, "시안 정보");
  infoP.orientation = "column";
  infoP.alignChildren = "fill";
  infoP.margins = 12;
  infoP.spacing = 6;

  // 월일
  var rowD = infoP.add("group");
  rowD.alignChildren = ["left", "center"];
  rowD.add("statictext", undefined, "월일").preferredSize.width = 60;
  var dateInput = rowD.add("edittext", undefined, prefill.월일 || todayMMDD());
  dateInput.characters = 8;

  // 건설사 / 현장 (콤보박스)
  var brandInput = makeCombo(infoP, "건설사", BRAND_DICT, "예: 두산");
  brandInput.text = prefill.건설사 || "";
  var siteInput = makeCombo(infoP, "현장", null, "예: 성수장미");
  siteInput.text = prefill.현장 || "";
  // 종류 / 내용 / 버전
  var kindInput = makeCombo(infoP, "종류", KIND_DICT, "예: A형철판");
  kindInput.text = prefill.종류 || "";
  var descInput = makeCombo(infoP, "내용", null, "예: 실명제");
  descInput.text = prefill.내용 || "";
  var rowV = infoP.add("group");
  rowV.alignChildren = ["left", "center"];
  rowV.add("statictext", undefined, "버전").preferredSize.width = 60;
  var verInput = rowV.add("edittext", undefined, prefill.버전 || "v1");
  verInput.characters = 6;

  // 발주처 (콤보박스, 단일)
  var vendorP = dlg.add("panel", undefined, "발주처 (단일 선택)");
  vendorP.orientation = "column";
  vendorP.alignChildren = "fill";
  vendorP.margins = 12;
  var vendorInput = makeCombo(vendorP, "발주처", VENDOR_DICT, "(없으면 시안만 저장)");
  vendorInput.text = prefill.발주처 || "공장";

  // 저장 형식
  var fmtP = dlg.add("panel", undefined, "저장 형식");
  fmtP.orientation = "row";
  fmtP.alignChildren = "left";
  fmtP.margins = 12;
  fmtP.spacing = 14;
  var saveOriginal = fmtP.add("checkbox", undefined, "원본 .ai (CC)");
  saveOriginal.value = true;
  var saveCS6 = fmtP.add("checkbox", undefined, "발주용 .ai (CS6)");
  saveCS6.value = true;
  var saveJPG = fmtP.add("checkbox", undefined, "발주용 .jpg");
  saveJPG.value = true;
  var savePDF = fmtP.add("checkbox", undefined, "발주용 .pdf");
  savePDF.value = false;

  // 저장 폴더 미리보기
  var folderG = dlg.add("group");
  folderG.add("statictext", undefined, "저장 폴더:");
  var folderText = folderG.add("statictext", undefined, "");
  folderText.preferredSize.width = 400;
  function updateFolder() {
    folderText.text = buildFolder({ 건설사: brandInput.text, 현장: siteInput.text });
  }
  brandInput.onChanging = updateFolder;
  siteInput.onChanging = updateFolder;
  updateFolder();

  // 버튼
  var btnRow = dlg.add("group");
  btnRow.alignment = "right";
  var saveActionBtn = btnRow.add("button", undefined, "💾 한 번에 저장", { name: "ok" });
  saveActionBtn.preferredSize.width = 130;
  var cancelBtn = btnRow.add("button", undefined, "취소", { name: "cancel" });

  saveActionBtn.onClick = function() {
    if (!brandInput.text) { alert("건설사를 입력하세요"); return; }
    if (!kindInput.text) { alert("종류를 입력하세요"); return; }
    if (!saveOriginal.value && !saveCS6.value && !saveJPG.value && !savePDF.value) {
      alert("저장 형식을 1개 이상 선택하세요"); return;
    }

    var data = {
      월일: dateInput.text,
      건설사: brandInput.text,
      현장: siteInput.text,
      종류: kindInput.text,
      내용: descInput.text,
      버전: verInput.text,
      발주처: vendorInput.text
    };

    var folder = buildFolder(data);
    try { ensureFolder(folder); } catch(e) { alert("폴더 생성 실패: " + e.message); return; }

    var doc = app.activeDocument;
    var savedFiles = [];
    var errors = [];
    var baseName = buildFileName(data, "원본");
    var orderName = data.발주처 ? buildFileName(data, data.발주처) : baseName;

    // 1. 원본 .ai (CC)
    if (saveOriginal.value) {
      try {
        var p = folder + "\\" + baseName + ".ai";
        saveAsAI(doc, p, Compatibility.ILLUSTRATOR);
        savedFiles.push(p);
      } catch(e) { errors.push("원본 .ai: " + e.message); }
    }
    // 2. JPG
    if (saveJPG.value) {
      try {
        var pj = folder + "\\" + orderName + ".jpg";
        exportJPG(doc, pj, 60);
        savedFiles.push(pj);
      } catch(e) { errors.push("JPG: " + e.message); }
    }
    // 3. CS6 .ai
    if (saveCS6.value) {
      try {
        var pc = folder + "\\" + orderName + ".ai";
        if (pc === folder + "\\" + baseName + ".ai") pc = folder + "\\" + baseName + "-cs6.ai";
        saveAsAI(doc, pc, Compatibility.ILLUSTRATOR16);
        savedFiles.push(pc);
      } catch(e) { errors.push("CS6 .ai: " + e.message); }
    }
    // 4. PDF
    if (savePDF.value) {
      try {
        var pp = folder + "\\" + orderName + ".pdf";
        saveAsPDF(doc, pp);
        savedFiles.push(pp);
      } catch(e) { errors.push("PDF: " + e.message); }
    }

    var msg = "✅ 저장 완료: " + savedFiles.length + "개\n\n";
    for (var s = 0; s < savedFiles.length; s++) msg += "• " + savedFiles[s].replace(folder + "\\", "") + "\n";
    if (errors.length) {
      msg += "\n⚠️ 오류:\n";
      for (var e2 = 0; e2 < errors.length; e2++) msg += "• " + errors[e2] + "\n";
    }
    msg += "\n폴더: " + folder;
    alert(msg);
    dlg.close(1);
  };
  cancelBtn.onClick = function() { dlg.close(0); };

  dlg.show();
}

// ══════════════════════════════════════════════════════════
// 메인 palette
// ══════════════════════════════════════════════════════════
function showPalette() {
  var dlg = new Window("palette", "시안 도우미");
  dlg.orientation = "column";
  dlg.alignChildren = "fill";
  dlg.preferredSize.width = 480;
  dlg.spacing = 6;
  dlg.margins = 8;

  // 컨텐츠 영역 (미니마이즈 시 숨김)
  var content = dlg.add("group");
  content.orientation = "column";
  content.alignChildren = "fill";
  content.spacing = 6;

  var infoP = content.add("panel", undefined, "시안 정보");
  infoP.orientation = "column";
  infoP.alignChildren = "fill";
  infoP.margins = 10;
  infoP.spacing = 6;

  // 규격 — 검색 사전 없음 (자유입력)
  var specInput = makeCombo(infoP, "규격", null, "예: 600*900 / 550파이");

  // 상품명 — 콤보 (검색 사전 있음)
  var kindInput = makeCombo(infoP, "상품명", KIND_DICT, "예: A형철판");

  // 옵션
  var optInput = makeCombo(infoP, "옵션", null, "예: 반사실사/단면");

  // 수량
  var qtyRow = infoP.add("group");
  qtyRow.alignChildren = ["left", "center"];
  qtyRow.add("statictext", undefined, "수량").preferredSize.width = 60;
  var qtySingleRb = qtyRow.add("radiobutton", undefined, "단일");
  qtySingleRb.value = true;
  var qtyInput = qtyRow.add("edittext", undefined, "1");
  qtyInput.characters = 4;
  qtyRow.add("statictext", undefined, "개   ");
  var qtyMultiRb = qtyRow.add("radiobutton", undefined, "다중");
  var qtyMultiRow = infoP.add("group");
  qtyMultiRow.alignChildren = ["left", "center"];
  qtyMultiRow.add("statictext", undefined, "").preferredSize.width = 60;
  qtyMultiRow.add("statictext", undefined, "각");
  var multiEach = qtyMultiRow.add("edittext", undefined, "");
  multiEach.characters = 4;
  qtyMultiRow.add("statictext", undefined, "개씩 총");
  var multiTotal = qtyMultiRow.add("edittext", undefined, "");
  multiTotal.characters = 6;
  qtyMultiRow.add("statictext", undefined, "개");
  qtyMultiRow.visible = false;

  var dateRow = infoP.add("group");
  dateRow.alignChildren = ["left", "center"];
  dateRow.add("statictext", undefined, "납품일").preferredSize.width = 60;
  var d2 = new Date();
  var dateMonth = dateRow.add("edittext", undefined, String(d2.getMonth() + 1));
  dateMonth.characters = 3;
  dateRow.add("statictext", undefined, "/");
  var dateDay = dateRow.add("edittext", undefined, String(d2.getDate()));
  dateDay.characters = 3;
  dateRow.add("statictext", undefined, "(M/D)");

  var prevP = content.add("panel", undefined, "미리보기");
  prevP.orientation = "column";
  prevP.alignChildren = "fill";
  prevP.margins = 10;
  var prevLine1 = prevP.add("statictext", undefined, "(입력하면 여기 표시)");
  prevLine1.preferredSize.width = 440;
  try { prevLine1.graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 12); } catch(e) {}
  var prevLine2 = prevP.add("statictext", undefined, "");
  prevLine2.preferredSize.width = 440;

  var statusText = content.add("statictext", undefined, "");
  statusText.preferredSize.width = 460;

  function buildQty() {
    if (qtyMultiRb.value) {
      var ee = String(multiEach.text || "").replace(/^\s+|\s+$/g, "");
      var tt = String(multiTotal.text || "").replace(/^\s+|\s+$/g, "");
      if (ee && tt) return "각 " + ee + "개씩 총 " + tt + "개";
      return "";
    }
    var q = String(qtyInput.text || "").replace(/^\s+|\s+$/g, "");
    return q ? q + "개" : "";
  }
  function updatePreview() {
    var spec = String(specInput.text || "").replace(/^\s+|\s+$/g, "");
    var kind = String(kindInput.text || "").replace(/^\s+|\s+$/g, "");
    var opt = String(optInput.text || "").replace(/^\s+|\s+$/g, "");
    var qty = buildQty();
    var parts = [];
    if (spec) parts.push(spec);
    if (kind) parts.push(kind);
    if (opt) parts.push(opt);
    var line1 = parts.join(" ");
    if (qty) line1 += (line1 ? " - " : "") + qty;
    prevLine1.text = line1 || "(입력하면 여기 표시)";
    var m = String(dateMonth.text || "").replace(/^\s+|\s+$/g, "");
    var dd = String(dateDay.text || "").replace(/^\s+|\s+$/g, "");
    prevLine2.text = (m && dd) ? "납품: " + m + "/" + dd : "";
  }
  var allInputs = [specInput, kindInput, optInput, qtyInput, multiEach, multiTotal, dateMonth, dateDay];
  for (var ii = 0; ii < allInputs.length; ii++) allInputs[ii].onChanging = updatePreview;
  qtySingleRb.onClick = function() { qtyMultiRow.visible = false; qtyInput.enabled = true; updatePreview(); };
  qtyMultiRb.onClick = function() { qtyMultiRow.visible = true; qtyInput.enabled = false; updatePreview(); };

  var btnRow = dlg.add("group");
  btnRow.alignment = "right";
  var insertBtn = btnRow.add("button", undefined, "텍스트 삽입");
  insertBtn.preferredSize.width = 100;
  var clearBtn = btnRow.add("button", undefined, "초기화");
  var saveBtn = btnRow.add("button", undefined, "💾 시안 저장");
  saveBtn.preferredSize.width = 110;
  var minBtn = btnRow.add("button", undefined, "_");
  minBtn.preferredSize.width = 30;
  minBtn.helpTip = "최소화/복원";

  insertBtn.onClick = function() {
    var line1 = prevLine1.text;
    var line2 = prevLine2.text;
    if (line1 === "(입력하면 여기 표시)" || !line1) { statusText.text = "⚠️ 규격 또는 상품명 입력하세요"; return; }
    if (!app.documents.length) { statusText.text = "⚠️ 열린 문서가 없습니다"; return; }
    try {
      insertTextFrames(app.activeDocument, { line1: line1, line2: line2, alignCenter: true, fontSize1: 24, fontSize2: 18 });
      statusText.text = "✓ 삽입 완료: " + line1.substring(0, 40);
      try { app.redraw(); } catch(e) {}
    } catch(e) { statusText.text = "⚠️ 삽입 오류: " + (e.message || e.toString()); }
  };
  clearBtn.onClick = function() {
    specInput.text = ""; kindInput.text = ""; optInput.text = ""; qtyInput.text = "1";
    qtySingleRb.value = true; qtyMultiRb.value = false;
    qtyMultiRow.visible = false; qtyInput.enabled = true;
    multiEach.text = ""; multiTotal.text = "";
    var nd = new Date();
    dateMonth.text = String(nd.getMonth() + 1);
    dateDay.text = String(nd.getDate());
    updatePreview();
    statusText.text = "초기화됨";
  };
  saveBtn.onClick = function() {
    if (!app.documents.length) { statusText.text = "⚠️ 열린 문서가 없습니다"; return; }
    try {
      showSaveDialog({ 종류: kindInput.text, 내용: optInput.text });
      statusText.text = "✓ 저장 완료 (또는 취소됨)";
    } catch(e) { statusText.text = "⚠️ 저장 오류: " + (e.message || e.toString()); }
  };
  var minimized = false;
  minBtn.onClick = function() {
    minimized = !minimized;
    content.visible = !minimized;
    minBtn.text = minimized ? "□" : "_";
    minBtn.helpTip = minimized ? "원래 크기로 복원" : "최소화";
  };

  dlg.show();
  return dlg;
}

if (typeof $.global.designerPalette === 'undefined' || $.global.designerPalette === null) {
  try { $.global.designerPalette = showPalette(); }
  catch(e) { alert("팔레트 생성 오류: " + (e.message || e.toString())); }
} else {
  try { $.global.designerPalette.show(); }
  catch(e) {
    $.global.designerPalette = null;
    try { $.global.designerPalette = showPalette(); }
    catch(e2) { alert("재생성 오류: " + (e2.message || e2.toString())); }
  }
}
