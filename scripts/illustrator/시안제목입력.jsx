#targetengine "session"
/**
 * 시안제목입력.jsx — 통합 palette (모든 동작 내부 inline)
 *
 * - 팝업 없음. 모든 입력/검색/저장이 같은 palette 내부에서 처리됨
 * - drawer 영역 1개를 공유: ▼/+옵션/💾저장 누르면 거기 컨텐츠 등장
 */

$.global.__designerScriptPath = $.fileName;

var CONFIG = {
  DESIGN_ROOT: "D:\\",
  YEAR: new Date().getFullYear() + "시안작업"
};

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

var OPTION_DICT = [
  "양면","단면",
  "사방타공","상단1타공","상단2타공","상단3타공","4방타공","6방타공",
  "양면테이프","리무버양면테이프",
  "화이트보드코팅","유포부착","유포유광","축광시트","바니쉬코팅",
  "자립","프레임","상단걸이","아일렛","아일렛타공","집게부착","벨크로부착",
  "A4아크릴포켓","A3아크릴포켓","파일케이스","클리어파일",
  "고무자석부착","음성경보기","멀티넘버링N4"
];

// ── 유틸 ────────────────────────────────────────
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
  if (d.옵션) parts.push(sanitize(d.옵션));
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
function ensureFolder(p) {
  var f = new Folder(p);
  if (!f.exists) f.create();
  return f;
}

// ── 일러스트 저장 함수 ──────────────────────────
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
    tf1.textRange.characterAttributes.size = data.fontSize1 || 24;
    if (data.alignCenter) {
      try { tf1.textRange.paragraphAttributes.justification = Justification.CENTER; } catch(e) {}
    }
  } catch(e) {}
  if (data.line2) {
    var tf2 = doc.textFrames.add();
    tf2.contents = data.line2;
    try { tf2.position = [centerX - 100, topY - (data.fontSize1 || 24) - 20]; } catch(e) {}
    try {
      tf2.textRange.characterAttributes.size = data.fontSize2 || 18;
      if (data.alignCenter) {
        try { tf2.textRange.paragraphAttributes.justification = Justification.CENTER; } catch(e) {}
      }
    } catch(e) {}
  }
}

// ══════════════════════════════════════════════════════════
// 메인 palette — 모든 동작 inline
// ══════════════════════════════════════════════════════════
function showPalette() {
  var dlg = new Window("palette", "시안 도우미");
  dlg.orientation = "column";
  dlg.alignChildren = "fill";
  dlg.preferredSize.width = 540;
  dlg.spacing = 6;
  dlg.margins = 8;

  var content = dlg.add("group");
  content.orientation = "column";
  content.alignChildren = "fill";
  content.spacing = 6;

  // ── 시안 정보 ─────────────────
  var infoP = content.add("panel", undefined, "시안 정보");
  infoP.orientation = "column";
  infoP.alignChildren = "fill";
  infoP.margins = 10;
  infoP.spacing = 5;

  function addRow(parent, label, w) {
    var g = parent.add("group");
    g.orientation = "row";
    g.alignChildren = ["left", "center"];
    var lbl = g.add("statictext", undefined, label);
    lbl.preferredSize.width = w || 60;
    return g;
  }

  // 규격
  var rowSpec = addRow(infoP, "규격");
  var specInput = rowSpec.add("edittext", undefined, "");
  specInput.characters = 36;
  specInput.helpTip = "예: 600*900 / 550파이 / 1020mm*50M";

  // 상품명 + ▼ 사전 + + 옵션
  var rowKind = addRow(infoP, "상품명");
  var kindInput = rowKind.add("edittext", undefined, "");
  kindInput.characters = 24;
  kindInput.helpTip = "예: A형철판 (옵션 추가는 + 옵션 버튼)";
  var kindPickBtn = rowKind.add("button", undefined, "▼ 사전");
  kindPickBtn.preferredSize = [60, 22];
  var kindOptBtn = rowKind.add("button", undefined, "+ 옵션");
  kindOptBtn.preferredSize = [60, 22];

  // 옵션 (현재 추가된 옵션 표시)
  var rowOpt = addRow(infoP, "옵션");
  var optInput = rowOpt.add("edittext", undefined, "");
  optInput.characters = 36;
  optInput.helpTip = "+옵션 버튼으로 추가 가능 / 직접 입력도 OK";

  // 수량
  var rowQty = addRow(infoP, "수량");
  var qtySingleRb = rowQty.add("radiobutton", undefined, "단일");
  qtySingleRb.value = true;
  var qtyInput = rowQty.add("edittext", undefined, "1");
  qtyInput.characters = 4;
  rowQty.add("statictext", undefined, "개   ");
  var qtyMultiRb = rowQty.add("radiobutton", undefined, "다중");
  var qtyMultiRow = infoP.add("group");
  qtyMultiRow.alignChildren = ["left", "center"];
  qtyMultiRow.add("statictext", undefined, "").preferredSize.width = 60;
  qtyMultiRow.add("statictext", undefined, "각");
  var multiEach = qtyMultiRow.add("edittext", undefined, "");
  multiEach.characters = 4;
  qtyMultiRow.add("statictext", undefined, "개씩 총");
  var multiTotal = qtyMultiRow.add("edittext", undefined, "");
  multiTotal.characters = 5;
  qtyMultiRow.add("statictext", undefined, "개");
  qtyMultiRow.visible = false;

  // 납품일
  var rowDate = addRow(infoP, "납품일");
  var d = new Date();
  var dateMonth = rowDate.add("edittext", undefined, String(d.getMonth() + 1));
  dateMonth.characters = 3;
  rowDate.add("statictext", undefined, "/");
  var dateDay = rowDate.add("edittext", undefined, String(d.getDate()));
  dateDay.characters = 3;
  rowDate.add("statictext", undefined, "(M/D)");

  // ── 미리보기 ─────────────────
  var prevP = content.add("panel", undefined, "미리보기");
  prevP.orientation = "column";
  prevP.alignChildren = "fill";
  prevP.margins = 10;
  var prevLine1 = prevP.add("statictext", undefined, "(입력하면 여기 표시)");
  prevLine1.preferredSize.width = 500;
  try { prevLine1.graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 12); } catch(e) {}
  var prevLine2 = prevP.add("statictext", undefined, "");
  prevLine2.preferredSize.width = 500;

  // 상태
  var statusText = content.add("statictext", undefined, "");
  statusText.preferredSize.width = 520;

  // 액션 버튼
  var btnRow = dlg.add("group");
  btnRow.alignment = "right";
  var insertBtn = btnRow.add("button", undefined, "텍스트 삽입");
  insertBtn.preferredSize.width = 100;
  var clearBtn = btnRow.add("button", undefined, "초기화");
  var saveBtn = btnRow.add("button", undefined, "💾 시안 저장");
  saveBtn.preferredSize.width = 110;
  var minBtn = btnRow.add("button", undefined, "_");
  minBtn.preferredSize.width = 30;

  // ══════════════════════════════════════════════════════════
  // DRAWER — 모든 inline 영역이 여기 로드됨 (검색/옵션/저장)
  // ══════════════════════════════════════════════════════════
  var drawer = dlg.add("panel", undefined, "");
  drawer.orientation = "column";
  drawer.alignChildren = "fill";
  drawer.margins = 10;
  drawer.visible = false;

  var drawerMode = null;        // 'pick' | 'option' | 'save'
  var drawerTargetInput = null; // 검색 결과 보낼 input

  // drawer 내부 영역 3개 — 모드에 따라 보임
  var pickArea = drawer.add("group");
  pickArea.orientation = "column";
  pickArea.alignChildren = "fill";
  pickArea.visible = false;

  var optionArea = drawer.add("group");
  optionArea.orientation = "column";
  optionArea.alignChildren = "fill";
  optionArea.visible = false;

  var saveArea = drawer.add("group");
  saveArea.orientation = "column";
  saveArea.alignChildren = "fill";
  saveArea.visible = false;

  // ── PICK (사전 검색) ─────────────────
  var pickHeader = pickArea.add("statictext", undefined, "🔍 사전 검색");
  try { pickHeader.graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 11); } catch(e) {}
  var pickSearchRow = pickArea.add("group");
  pickSearchRow.add("statictext", undefined, "검색:");
  var pickSearchInput = pickSearchRow.add("edittext", undefined, "");
  pickSearchInput.characters = 30;
  var pickList = pickArea.add("listbox", undefined, []);
  pickList.preferredSize = [500, 220];
  var pickBtnRow = pickArea.add("group");
  pickBtnRow.alignment = "right";
  var pickOkBtn = pickBtnRow.add("button", undefined, "선택");
  var pickCancelBtn = pickBtnRow.add("button", undefined, "닫기");

  var pickCurrentDict = [];
  function refreshPickList() {
    var query = String(pickSearchInput.text || "").toLowerCase();
    pickList.removeAll();
    for (var i = 0; i < pickCurrentDict.length; i++) {
      if (!query || String(pickCurrentDict[i]).toLowerCase().indexOf(query) >= 0) {
        pickList.add("item", pickCurrentDict[i]);
      }
    }
    if (pickList.items.length > 0) pickList.selection = 0;
  }
  pickSearchInput.onChanging = refreshPickList;
  pickList.onDoubleClick = function() {
    if (pickList.selection && drawerTargetInput) {
      drawerTargetInput.text = pickList.selection.text;
      try { if (drawerTargetInput.onChanging) drawerTargetInput.onChanging(); } catch(e) {}
    }
    closeDrawer();
  };
  pickOkBtn.onClick = function() {
    if (drawerTargetInput) {
      if (pickList.selection) drawerTargetInput.text = pickList.selection.text;
      else if (pickSearchInput.text) drawerTargetInput.text = pickSearchInput.text;
      try { if (drawerTargetInput.onChanging) drawerTargetInput.onChanging(); } catch(e) {}
    }
    closeDrawer();
  };
  pickCancelBtn.onClick = function() { closeDrawer(); };

  // ── OPTION (다중 선택) ─────────────────
  var optionHeader = optionArea.add("statictext", undefined, "+ 옵션 추가 (다중 선택)");
  try { optionHeader.graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 11); } catch(e) {}
  var optionList = optionArea.add("listbox", undefined, OPTION_DICT, { multiselect: true });
  optionList.preferredSize = [500, 220];
  var optionCustomRow = optionArea.add("group");
  optionCustomRow.add("statictext", undefined, "직접 추가:");
  var optionCustomInput = optionCustomRow.add("edittext", undefined, "");
  optionCustomInput.characters = 32;
  optionCustomInput.helpTip = "쉼표로 구분 (예: 양면,사방타공)";
  var optionBtnRow = optionArea.add("group");
  optionBtnRow.alignment = "right";
  var optionAddBtn = optionBtnRow.add("button", undefined, "상품명에 추가");
  var optionCancelBtn = optionBtnRow.add("button", undefined, "닫기");

  optionAddBtn.onClick = function() {
    var selected = [];
    if (optionList.selection) {
      if (optionList.selection.length !== undefined) {
        for (var s = 0; s < optionList.selection.length; s++) selected.push(optionList.selection[s].text);
      } else {
        selected.push(optionList.selection.text);
      }
    }
    if (optionCustomInput.text) {
      var customs = optionCustomInput.text.split(",");
      for (var c = 0; c < customs.length; c++) {
        var t = customs[c].replace(/^\s+|\s+$/g, "");
        if (t) selected.push(t);
      }
    }
    if (selected.length > 0 && drawerTargetInput) {
      var current = drawerTargetInput.text || "";
      for (var i = 0; i < selected.length; i++) current += "+" + selected[i];
      drawerTargetInput.text = current;
      try { if (drawerTargetInput.onChanging) drawerTargetInput.onChanging(); } catch(e) {}
    }
    closeDrawer();
  };
  optionCancelBtn.onClick = function() { closeDrawer(); };

  // ── SAVE (저장 form) ─────────────────
  var saveHeader = saveArea.add("statictext", undefined, "💾 시안 저장");
  try { saveHeader.graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 11); } catch(e) {}

  function saveRow(parent, label, w) {
    var g = parent.add("group");
    g.orientation = "row";
    g.alignChildren = ["left", "center"];
    var lbl = g.add("statictext", undefined, label);
    lbl.preferredSize.width = w || 70;
    return g;
  }

  var sRow1 = saveRow(saveArea, "월일");
  var saveMonth = sRow1.add("edittext", undefined, todayMMDD());
  saveMonth.characters = 8;

  var sRow2 = saveRow(saveArea, "건설사");
  var saveBrandInput = sRow2.add("edittext", undefined, "");
  saveBrandInput.characters = 28;
  var saveBrandPickBtn = sRow2.add("button", undefined, "▼ 사전");
  saveBrandPickBtn.preferredSize = [60, 22];

  var sRow3 = saveRow(saveArea, "현장");
  var saveSiteInput = sRow3.add("edittext", undefined, "");
  saveSiteInput.characters = 36;

  var sRow4 = saveRow(saveArea, "종류");
  var saveKindInput = sRow4.add("edittext", undefined, "");
  saveKindInput.characters = 36;

  var sRow5 = saveRow(saveArea, "옵션");
  var saveOptInput = sRow5.add("edittext", undefined, "");
  saveOptInput.characters = 36;

  var sRow6 = saveRow(saveArea, "버전");
  var saveVerInput = sRow6.add("edittext", undefined, "v1");
  saveVerInput.characters = 6;

  var sRow7 = saveRow(saveArea, "발주처");
  var saveVendorInput = sRow7.add("edittext", undefined, "공장");
  saveVendorInput.characters = 28;
  var saveVendorPickBtn = sRow7.add("button", undefined, "▼ 사전");
  saveVendorPickBtn.preferredSize = [60, 22];

  var sFmtRow = saveArea.add("group");
  sFmtRow.add("statictext", undefined, "형식").preferredSize.width = 70;
  var saveFmtAI = sFmtRow.add("checkbox", undefined, "원본 .ai (CC)");
  saveFmtAI.value = true;
  var saveFmtCS6 = sFmtRow.add("checkbox", undefined, "발주 .ai (CS6)");
  saveFmtCS6.value = true;
  var saveFmtJPG = sFmtRow.add("checkbox", undefined, ".jpg");
  saveFmtJPG.value = true;
  var saveFmtPDF = sFmtRow.add("checkbox", undefined, ".pdf");
  saveFmtPDF.value = false;

  var sFolderRow = saveArea.add("group");
  sFolderRow.add("statictext", undefined, "저장 폴더:");
  var saveFolderText = sFolderRow.add("statictext", undefined, "");
  saveFolderText.preferredSize.width = 420;

  function updateSaveFolder() {
    saveFolderText.text = buildFolder({ 건설사: saveBrandInput.text, 현장: saveSiteInput.text });
  }
  saveBrandInput.onChanging = updateSaveFolder;
  saveSiteInput.onChanging = updateSaveFolder;

  var saveBtnRow = saveArea.add("group");
  saveBtnRow.alignment = "right";
  var saveExecBtn = saveBtnRow.add("button", undefined, "💾 한 번에 저장");
  saveExecBtn.preferredSize.width = 130;
  var saveCancelBtn = saveBtnRow.add("button", undefined, "닫기");

  saveBrandPickBtn.onClick = function() {
    openPick(BRAND_DICT, saveBrandInput);
  };
  saveVendorPickBtn.onClick = function() {
    openPick(VENDOR_DICT, saveVendorInput);
  };

  saveExecBtn.onClick = function() {
    if (!app.documents.length) { statusText.text = "⚠️ 열린 문서가 없습니다"; return; }
    if (!saveBrandInput.text) { statusText.text = "⚠️ 건설사 입력하세요"; return; }
    if (!saveKindInput.text) { statusText.text = "⚠️ 종류 입력하세요"; return; }
    if (!saveFmtAI.value && !saveFmtCS6.value && !saveFmtJPG.value && !saveFmtPDF.value) {
      statusText.text = "⚠️ 저장 형식 1개 이상 선택"; return;
    }
    var data = {
      월일: saveMonth.text,
      건설사: saveBrandInput.text,
      현장: saveSiteInput.text,
      종류: saveKindInput.text,
      옵션: saveOptInput.text,
      버전: saveVerInput.text,
      발주처: saveVendorInput.text
    };
    var folder = buildFolder(data);
    try { ensureFolder(folder); } catch(e) { statusText.text = "⚠️ 폴더 생성 실패: " + e.message; return; }
    var doc = app.activeDocument;
    var savedFiles = [];
    var errors = [];
    var baseName = buildFileName(data, "원본");
    var orderName = data.발주처 ? buildFileName(data, data.발주처) : baseName;

    if (saveFmtAI.value) {
      try {
        var p1 = folder + "\\" + baseName + ".ai";
        saveAsAI(doc, p1, Compatibility.ILLUSTRATOR);
        savedFiles.push(p1);
      } catch(e) { errors.push("원본 .ai: " + e.message); }
    }
    if (saveFmtJPG.value) {
      try {
        var p2 = folder + "\\" + orderName + ".jpg";
        exportJPG(doc, p2, 60);
        savedFiles.push(p2);
      } catch(e) { errors.push("JPG: " + e.message); }
    }
    if (saveFmtCS6.value) {
      try {
        var p3 = folder + "\\" + orderName + ".ai";
        if (p3 === folder + "\\" + baseName + ".ai") p3 = folder + "\\" + baseName + "-cs6.ai";
        saveAsAI(doc, p3, Compatibility.ILLUSTRATOR16);
        savedFiles.push(p3);
      } catch(e) { errors.push("CS6 .ai: " + e.message); }
    }
    if (saveFmtPDF.value) {
      try {
        var p4 = folder + "\\" + orderName + ".pdf";
        saveAsPDF(doc, p4);
        savedFiles.push(p4);
      } catch(e) { errors.push("PDF: " + e.message); }
    }

    var msg = "✓ 저장 완료: " + savedFiles.length + "개";
    if (errors.length) msg += " / 오류 " + errors.length + "개";
    statusText.text = msg;
    closeDrawer();
  };
  saveCancelBtn.onClick = function() { closeDrawer(); };

  // ── DRAWER 제어 ─────────────────
  function openPick(dict, target) {
    drawerMode = 'pick';
    drawerTargetInput = target;
    pickCurrentDict = dict;
    pickSearchInput.text = target.text || "";
    refreshPickList();
    pickArea.visible = true;
    optionArea.visible = false;
    saveArea.visible = false;
    drawer.visible = true;
  }
  function openOption(target) {
    drawerMode = 'option';
    drawerTargetInput = target;
    optionList.selection = null;
    optionCustomInput.text = "";
    pickArea.visible = false;
    optionArea.visible = true;
    saveArea.visible = false;
    drawer.visible = true;
  }
  function openSave() {
    drawerMode = 'save';
    drawerTargetInput = null;
    // prefill 종류=상품명, 옵션=현재 옵션
    saveKindInput.text = kindInput.text;
    saveOptInput.text = optInput.text;
    updateSaveFolder();
    pickArea.visible = false;
    optionArea.visible = false;
    saveArea.visible = true;
    drawer.visible = true;
  }
  function closeDrawer() {
    drawer.visible = false;
    drawerMode = null;
    drawerTargetInput = null;
  }

  // ── 콤보 버튼 액션 ─────────────────
  kindPickBtn.onClick = function() { openPick(KIND_DICT, kindInput); };
  kindOptBtn.onClick = function() { openOption(kindInput); };

  // ── 미리보기 빌드 ─────────────────
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

  // ── 메인 액션 버튼 ─────────────────
  insertBtn.onClick = function() {
    var line1 = prevLine1.text;
    var line2 = prevLine2.text;
    if (line1 === "(입력하면 여기 표시)" || !line1) { statusText.text = "⚠️ 규격 또는 상품명 입력하세요"; return; }
    if (!app.documents.length) { statusText.text = "⚠️ 열린 문서가 없습니다"; return; }
    try {
      insertTextFrames(app.activeDocument, { line1: line1, line2: line2, alignCenter: true, fontSize1: 24, fontSize2: 18 });
      statusText.text = "✓ 삽입 완료";
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
    openSave();
  };

  var minimized = false;
  minBtn.onClick = function() {
    minimized = !minimized;
    content.visible = !minimized;
    drawer.visible = false;
    minBtn.text = minimized ? "□" : "_";
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
