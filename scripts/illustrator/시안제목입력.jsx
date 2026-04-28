/**
 * 시안제목입력.jsx — 시안 안에 박는 표준 텍스트 입력 도우미 (palette 모드)
 *
 * 기능:
 * - palette 윈도우 (계속 떠있음, 디자이너 작업 방해 X)
 * - 패널별 접기/펴기 (▼/▶ 토글)
 * - 텍스트 삽입 후에도 창이 살아있음 (여러 번 삽입 가능)
 *
 * 설치: File > Scripts > Other Script... 로 이 파일 선택
 *       또는 일러스트 설치폴더\Presets\ko_KR\스크립트\ 에 복사
 */

// 표준 상품명 사전
var KIND_DICT = [
  // 출력물
  "현수막","배너","타포린","깃발","어깨띠",
  "포맥스","3t포맥스","5t포맥스","1t포맥스","10t포맥스",
  "후렉스","그레이플렉스","폼보드","화이트보드",
  "스티커","실사","시트커팅","유포","합성지",
  "A형철판","A형간판","X배너","피켓",
  "PE간판","PE소형","PE대형","잔넬","돌출표찰","표지판","액자","등신대",
  "천막","캐노피","아크릴포켓",
  // 원자재
  "아연파이프","각관","각파이프","철판","강판","갈바","칼라철판",
  "SUS","스텐","알미늄","동판",
  "(CH)현수막","(CH)솔벤현수막","(CH)점착현수막",
  "이노폼","솔벤시트","ITM합성지","PVC-CAL","무광코팅지","코팅필름",
  "반사시트","축광시트","안개시트","페트지","돔보커팅",
  "고무자석","자석",
  // 안전자재
  "안전모","안전화","안전조끼","헬멧","보호구","마스크","보안경",
  "가림막","휀스","반사경","라바콘","칼라콘",
  // 금속자재
  "앵글","브라켓","경첩","프레임","틀제작","문틀","지주",
  // 부자재
  "아크릴","렉산","합판","MDF","테이프","본드","실리콘",
  "페인트","래커","락카","볼트","피스",
  "LED","전구","형광등","스위치","케이블"
];

// ══════════════════════════════════════════════════════════
// 접을 수 있는 패널 헬퍼
// ══════════════════════════════════════════════════════════
function makeCollapsiblePanel(parent, title, defaultOpen) {
  var wrap = parent.add("group");
  wrap.orientation = "column";
  wrap.alignChildren = "fill";
  wrap.spacing = 0;

  var header = wrap.add("group");
  header.alignment = "fill";
  var toggleBtn = header.add("button", undefined, (defaultOpen !== false ? "▼ " : "▶ ") + title);
  toggleBtn.preferredSize.height = 24;
  toggleBtn.alignment = "fill";

  var content = wrap.add("panel", undefined);
  content.orientation = "column";
  content.alignChildren = "fill";
  content.margins = 12;
  content.spacing = 8;
  content.visible = defaultOpen !== false;

  toggleBtn.onClick = function() {
    content.visible = !content.visible;
    toggleBtn.text = (content.visible ? "▼ " : "▶ ") + title;
    try {
      wrap.window.layout.layout(true);
      wrap.window.layout.resize();
    } catch(e) {}
  };
  // 외부에서 일괄 접기/펴기용
  content.setOpen = function(state) {
    content.visible = state;
    toggleBtn.text = (state ? "▼ " : "▶ ") + title;
  };
  return content;
}

// ══════════════════════════════════════════════════════════
// Palette 윈도우 (계속 떠있음)
// ══════════════════════════════════════════════════════════
function showPalette() {
  var dlg = new Window("palette", "시안 제목 텍스트 입력");
  dlg.orientation = "column";
  dlg.alignChildren = "fill";
  dlg.preferredSize.width = 480;
  dlg.spacing = 4;

  // ─── 시안 정보 패널 (접기 가능)
  var infoPanel = makeCollapsiblePanel(dlg, "시안 정보", true);

  function addRow(parent, label) {
    var g = parent.add("group");
    g.orientation = "row";
    g.alignChildren = ["left", "center"];
    var lbl = g.add("statictext", undefined, label);
    lbl.preferredSize.width = 70;
    return g;
  }

  // 규격
  var rowSpec = addRow(infoPanel, "규격");
  var specType = rowSpec.add("dropdownlist", undefined, ["가로*세로", "지름(파이)", "자유입력"]);
  specType.preferredSize.width = 90;
  specType.selection = 0;
  var specW = rowSpec.add("edittext", undefined, "");
  specW.characters = 6;
  var specStar = rowSpec.add("statictext", undefined, "*");
  var specH = rowSpec.add("edittext", undefined, "");
  specH.characters = 6;
  var specFree = rowSpec.add("edittext", undefined, "");
  specFree.characters = 16;
  specFree.visible = false;

  function updateSpecMode() {
    var t = specType.selection.text;
    if (t === "가로*세로") {
      specW.visible = true; specStar.visible = true; specH.visible = true; specFree.visible = false;
      specStar.text = "*";
    } else if (t === "지름(파이)") {
      specW.visible = true; specStar.visible = true; specH.visible = false; specFree.visible = false;
      specStar.text = "파이";
    } else {
      specW.visible = false; specStar.visible = false; specH.visible = false; specFree.visible = true;
    }
  }

  // 상품명
  var rowKind = addRow(infoPanel, "상품명");
  var kindList = rowKind.add("dropdownlist", undefined, KIND_DICT);
  kindList.preferredSize.width = 200;
  kindList.selection = 0;
  rowKind.add("statictext", undefined, "또는");
  var kindOther = rowKind.add("edittext", undefined, "");
  kindOther.characters = 14;

  // 옵션
  var rowOpt = addRow(infoPanel, "옵션");
  var optInput = rowOpt.add("edittext", undefined, "");
  optInput.characters = 35;
  rowOpt.add("statictext", undefined, "(예: 반사실사/단면)");

  // 수량
  var rowQty = addRow(infoPanel, "수량");
  var qtyInput = rowQty.add("edittext", undefined, "1");
  qtyInput.characters = 6;
  rowQty.add("statictext", undefined, "개");
  var multiCheck = rowQty.add("checkbox", undefined, "다중 디자인");
  var multiEachLabel = rowQty.add("statictext", undefined, "(각");
  var multiEach = rowQty.add("edittext", undefined, "");
  multiEach.characters = 4;
  var multiTotalLabel = rowQty.add("statictext", undefined, "개씩 총");
  var multiTotal = rowQty.add("edittext", undefined, "");
  multiTotal.characters = 5;
  rowQty.add("statictext", undefined, "개)");
  multiEachLabel.visible = false; multiEach.visible = false;
  multiTotalLabel.visible = false; multiTotal.visible = false;

  // 납품일
  var rowDate = addRow(infoPanel, "납품일");
  var d = new Date();
  var dateMonth = rowDate.add("edittext", undefined, String(d.getMonth() + 1));
  dateMonth.characters = 3;
  rowDate.add("statictext", undefined, "/");
  var dateDay = rowDate.add("edittext", undefined, String(d.getDate()));
  dateDay.characters = 3;
  rowDate.add("statictext", undefined, "(M/D)");

  // ─── 미리보기 패널 (접기 가능)
  var previewPanel = makeCollapsiblePanel(dlg, "미리보기", true);
  var previewLine1 = previewPanel.add("statictext", undefined, "(입력하면 여기 표시)");
  previewLine1.preferredSize.width = 440;
  try { previewLine1.graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 12); } catch(e) {}
  var previewLine2 = previewPanel.add("statictext", undefined, "");
  previewLine2.preferredSize.width = 440;

  // ─── 삽입 옵션 패널 (접기 가능, 기본 접힌상태)
  var optionsPanel = makeCollapsiblePanel(dlg, "삽입 옵션", false);
  var insertAtCursor = optionsPanel.add("checkbox", undefined, "현재 선택 위치에 삽입 (안 선택 시 대지 중앙 위)");
  var alignCenter = optionsPanel.add("checkbox", undefined, "가운데 정렬");
  alignCenter.value = true;
  var fontSize1 = optionsPanel.add("group");
  fontSize1.add("statictext", undefined, "1줄 폰트크기:");
  var fontSize1Input = fontSize1.add("edittext", undefined, "24");
  fontSize1Input.characters = 4;
  fontSize1.add("statictext", undefined, "pt    2줄(납품일):");
  var fontSize2Input = fontSize1.add("edittext", undefined, "18");
  fontSize2Input.characters = 4;
  fontSize1.add("statictext", undefined, "pt");

  // ─── 상태 표시 (마지막 삽입 알림)
  var statusGroup = dlg.add("group");
  statusGroup.alignment = "left";
  var statusText = statusGroup.add("statictext", undefined, "");
  statusText.preferredSize.width = 440;
  try { statusText.graphics.foregroundColor = statusText.graphics.newPen(statusText.graphics.PenType.SOLID_COLOR, [0.1, 0.6, 0.2, 1], 1); } catch(e) {}

  // ─── 입력 처리
  function buildSpecText() {
    var t = specType.selection.text;
    if (t === "가로*세로") {
      var w = specW.text.replace(/^\s+|\s+$/g, "");
      var h = specH.text.replace(/^\s+|\s+$/g, "");
      if (w && h) return w + "*" + h;
      return "";
    } else if (t === "지름(파이)") {
      var w2 = specW.text.replace(/^\s+|\s+$/g, "");
      if (w2) return w2 + "파이";
      return "";
    } else {
      return specFree.text.replace(/^\s+|\s+$/g, "");
    }
  }

  function buildKindText() {
    if (kindOther.text) return kindOther.text.replace(/^\s+|\s+$/g, "");
    if (kindList.selection) return kindList.selection.text;
    return "";
  }

  function buildQtyText() {
    if (multiCheck.value) {
      var e = multiEach.text.replace(/^\s+|\s+$/g, "");
      var t = multiTotal.text.replace(/^\s+|\s+$/g, "");
      if (e && t) return "각 " + e + "개씩 총 " + t + "개";
      return "";
    } else {
      var q = qtyInput.text.replace(/^\s+|\s+$/g, "");
      if (q) return q + "개";
      return "";
    }
  }

  function updatePreview() {
    var spec = buildSpecText();
    var kind = buildKindText();
    var opt = optInput.text.replace(/^\s+|\s+$/g, "");
    var qty = buildQtyText();
    var parts = [];
    if (spec) parts.push(spec);
    if (kind) parts.push(kind);
    if (opt) parts.push(opt);
    var line1 = parts.join(" ");
    if (qty) line1 += (line1 ? " - " : "") + qty;
    previewLine1.text = line1 || "(입력하면 여기 표시)";
    var m = dateMonth.text.replace(/^\s+|\s+$/g, "");
    var d2 = dateDay.text.replace(/^\s+|\s+$/g, "");
    if (m && d2) previewLine2.text = "납품: " + m + "/" + d2;
    else previewLine2.text = "";
  }

  // 이벤트 바인딩
  var allInputs = [specW, specH, specFree, kindOther, optInput, qtyInput, multiEach, multiTotal, dateMonth, dateDay];
  for (var ii = 0; ii < allInputs.length; ii++) allInputs[ii].onChanging = updatePreview;
  kindList.onChange = updatePreview;
  specType.onChange = function() { updateSpecMode(); updatePreview(); };
  multiCheck.onClick = function() {
    var v = multiCheck.value;
    multiEachLabel.visible = v; multiEach.visible = v;
    multiTotalLabel.visible = v; multiTotal.visible = v;
    qtyInput.enabled = !v;
    updatePreview();
  };

  // ─── 버튼
  var btnGroup = dlg.add("group");
  btnGroup.alignment = "right";
  var insertBtn = btnGroup.add("button", undefined, "텍스트 삽입");
  insertBtn.preferredSize.width = 110;
  var clearBtn = btnGroup.add("button", undefined, "초기화");
  var saveBtn = btnGroup.add("button", undefined, "💾 시안 저장");
  saveBtn.preferredSize.width = 110;
  var foldBtn = btnGroup.add("button", undefined, "📐 전부 접기");
  foldBtn.preferredSize.width = 110;

  // ─── 액션
  insertBtn.onClick = function() {
    var line1 = previewLine1.text;
    var line2 = previewLine2.text;
    if (line1 === "(입력하면 여기 표시)" || !line1) {
      statusText.text = "⚠️ 규격 또는 상품명을 입력하세요";
      return;
    }
    if (!app.documents.length) {
      statusText.text = "⚠️ 열린 문서가 없습니다";
      return;
    }
    try {
      var doc = app.activeDocument;
      var sz1 = parseInt(fontSize1Input.text) || 24;
      var sz2 = parseInt(fontSize2Input.text) || 18;
      insertTextFrames(doc, {
        line1: line1,
        line2: line2,
        alignCenter: alignCenter.value,
        insertAtCursor: insertAtCursor.value,
        fontSize1: sz1,
        fontSize2: sz2
      });
      statusText.text = "✓ 삽입 완료: \"" + line1 + "\"";
      app.redraw();
    } catch(e) {
      statusText.text = "⚠️ 삽입 오류: " + e.message;
    }
  };

  clearBtn.onClick = function() {
    specW.text = ""; specH.text = ""; specFree.text = "";
    kindOther.text = ""; kindList.selection = 0;
    optInput.text = ""; qtyInput.text = "1";
    multiCheck.value = false; multiCheck.onClick();
    multiEach.text = ""; multiTotal.text = "";
    var nd = new Date();
    dateMonth.text = String(nd.getMonth() + 1);
    dateDay.text = String(nd.getDate());
    updatePreview();
    statusText.text = "초기화됨";
  };

  // 전부 접기/펴기 토글
  var allFolded = false;
  foldBtn.onClick = function() {
    if (allFolded) {
      // 펴기 (시안 정보 + 미리보기는 보이게, 옵션은 닫혀있게 — 기본 상태)
      infoPanel.setOpen(true);
      previewPanel.setOpen(true);
      optionsPanel.setOpen(false);
      foldBtn.text = "📐 전부 접기";
    } else {
      // 접기 (3개 패널 모두 닫음 → 헤더 + 버튼 줄만 남음)
      infoPanel.setOpen(false);
      previewPanel.setOpen(false);
      optionsPanel.setOpen(false);
      foldBtn.text = "📐 전부 펴기";
    }
    allFolded = !allFolded;
    try {
      dlg.layout.layout(true);
      dlg.layout.resize();
    } catch(e) {}
  };

  // 시안 저장 — 같은 폴더의 시안저장.jsx 실행
  saveBtn.onClick = function() {
    if (!app.documents.length) {
      statusText.text = "⚠️ 열린 문서가 없습니다";
      return;
    }
    try {
      var thisFile = new File($.fileName);
      var saveScript = new File(thisFile.parent.fsName + "/시안저장.jsx");
      if (!saveScript.exists) {
        statusText.text = "⚠️ 시안저장.jsx 파일을 찾을 수 없습니다 (같은 폴더에 있어야 함)";
        return;
      }
      $.evalFile(saveScript);
      statusText.text = "✓ 저장 스크립트 실행됨";
    } catch(e) {
      statusText.text = "⚠️ 저장 오류: " + e.message;
    }
  };

  dlg.show();
}

// ══════════════════════════════════════════════════════════
// 텍스트 프레임 삽입
// ══════════════════════════════════════════════════════════
function insertTextFrames(doc, data) {
  var ab = doc.artboards[doc.artboards.getActiveArtboardIndex()];
  var rect = ab.artboardRect;
  var centerX = (rect[0] + rect[2]) / 2;
  var topY = rect[1] - 50;
  var tf1 = doc.textFrames.add();
  tf1.contents = data.line1;
  tf1.position = [centerX - 200, topY];
  try {
    var range1 = tf1.textRange;
    range1.characterAttributes.size = data.fontSize1 || 24;
    if (data.alignCenter) range1.paragraphAttributes.justification = Justification.CENTER;
  } catch(e) {}
  if (data.line2) {
    var tf2 = doc.textFrames.add();
    tf2.contents = data.line2;
    tf2.position = [centerX - 100, topY - (data.fontSize1 || 24) - 20];
    try {
      var range2 = tf2.textRange;
      range2.characterAttributes.size = data.fontSize2 || 18;
      if (data.alignCenter) range2.paragraphAttributes.justification = Justification.CENTER;
    } catch(e) {}
  }
}

try {
  showPalette();
} catch(e) {
  alert("스크립트 오류: " + e.message);
}
