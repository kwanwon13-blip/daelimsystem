/**
 * 시안저장.jsx — Illustrator 자동 저장 스크립트
 *
 * 기능:
 * 1. 다이얼로그에서 건설사/현장/종류/내용/버전/발주처 선택
 * 2. 자동 폴더 생성 (D:\★건설사\YYYY시안작업\현장\)
 * 3. 한 번에 저장:
 *    - 원본 .ai (CC 호환)
 *    - 발주처별 _발주(xxx).ai (CS6 호환)
 *    - 발주처별 _발주(xxx).jpg
 * 4. ERP에 메타데이터 자동 등록 (Optional)
 *
 * 설치: File > Scripts > Other Script... 로 이 파일 선택
 *       또는 일러스트 설치폴더\Presets\ko_KR\스크립트\ 에 복사
 *
 * 호환: Illustrator CC 2018 이상 (ScriptUI 사용)
 */

// ══════════════════════════════════════════════════════════
// 설정 (사이트별 수정)
// ══════════════════════════════════════════════════════════
var CONFIG = {
  ERP_HOST: "192.168.0.133",
  ERP_PORT: "3000",
  DESIGNER_TOKEN: "designer-default-key-change-in-env",  // .env 의 DESIGNER_TOKEN 과 동일하게
  DESIGN_ROOT: "D:\\",
  YEAR: new Date().getFullYear() + "시안작업",
  // 캐시: 마스터 데이터 로컬 저장 위치 (네트워크 끊겼을 때 폴백)
  MASTER_CACHE_FILE: Folder.userData.fsName + "\\대림에스엠ERP\\masters.json"
};

// ══════════════════════════════════════════════════════════
// 임베디드 기본 마스터 (ERP 연결 실패 시 폴백)
// ══════════════════════════════════════════════════════════
var DEFAULT_MASTERS = {
  vendors: [
    "공장","코리아","한진","라코스","현진","대풍","배너스토어","한양안전",
    "세계로","풍아몰","이용전","대영","현대상사","건우","동방사","서진","kep","풍아"
  ],
  brands: [
    "포스코이앤씨","DL이앤씨","현대산업개발","요진건설","동명이엔지","삼성라코스",
    "두산","쌍용건설","이상테크윈","대림건설","한신공영","우정은","보성세이프",
    "GC녹십자EM","오엠알오","극동건설","관보토건(주)","글로벌텍 나이스텍"
  ],
  // 종류 키워드 (분류룰 기반)
  kinds: [
    "현수막","포맥스","후렉스","폼보드","스티커","간판","A형철판","X배너","피켓",
    "PE간판","잔넬","표지판","고무자석","아크릴포켓","천막","파이프","앵글","브라켓",
    "프레임","철판","갈바","SUS","안전모","안전화","안전조끼","가림막","휀스","반사경",
    "라바콘","테이프","본드","실리콘","페인트","액자"
  ],
  brandSites: {}
};

// ══════════════════════════════════════════════════════════
// HTTP 헬퍼 (Socket 기반 — ExtendScript 호환)
// ══════════════════════════════════════════════════════════
function httpRequest(method, path, body) {
  var conn = new Socket();
  conn.encoding = "UTF-8";
  conn.timeout = 5;
  if (!conn.open(CONFIG.ERP_HOST + ":" + CONFIG.ERP_PORT, "BINARY")) {
    return null;
  }
  var bodyBytes = body ? body.length : 0;
  var req = method + " " + path + " HTTP/1.0\r\n" +
            "Host: " + CONFIG.ERP_HOST + "\r\n" +
            "X-Designer-Token: " + CONFIG.DESIGNER_TOKEN + "\r\n" +
            "Connection: close\r\n";
  if (body) {
    req += "Content-Type: application/json; charset=utf-8\r\n";
    req += "Content-Length: " + bodyBytes + "\r\n";
  }
  req += "\r\n";
  if (body) req += body;
  conn.write(req);
  var reply = "";
  while (!conn.eof) {
    reply += conn.read(8192);
  }
  conn.close();
  var idx = reply.indexOf("\r\n\r\n");
  if (idx < 0) return null;
  return reply.substring(idx + 4);
}

function safeJsonParse(s) {
  if (!s) return null;
  try { return eval('(' + s + ')'); } catch(e) { return null; }
}

// ══════════════════════════════════════════════════════════
// 마스터 로드 (ERP → 캐시 → 기본값)
// ══════════════════════════════════════════════════════════
function loadMasters() {
  // 1) ERP 시도
  var resp = httpRequest("GET", "/api/product-design/masters", null);
  var data = safeJsonParse(resp);
  if (data && data.ok && data.masters) {
    saveCache(data.masters);
    return normalizeMasters(data.masters);
  }
  // 2) 로컬 캐시
  var cached = loadCache();
  if (cached) return normalizeMasters(cached);
  // 3) 기본값
  return DEFAULT_MASTERS;
}

function normalizeMasters(m) {
  var out = { vendors: [], brands: [], kinds: [], brandSites: {} };
  if (m.vendors) for (var i = 0; i < m.vendors.length; i++) out.vendors.push(m.vendors[i].name || m.vendors[i]);
  if (m.brands) for (var j = 0; j < m.brands.length; j++) out.brands.push(m.brands[j].name || m.brands[j]);
  if (m.classificationRules) {
    var seen = {};
    for (var k = 0; k < m.classificationRules.length; k++) {
      var rule = m.classificationRules[k];
      if (rule.키워드) for (var w = 0; w < rule.키워드.length; w++) {
        if (!seen[rule.키워드[w]]) { seen[rule.키워드[w]] = 1; out.kinds.push(rule.키워드[w]); }
      }
    }
  }
  if (out.kinds.length === 0) out.kinds = DEFAULT_MASTERS.kinds.slice();
  if (m.brandSites) out.brandSites = m.brandSites;
  return out;
}

function saveCache(data) {
  try {
    var f = new File(CONFIG.MASTER_CACHE_FILE);
    f.parent.create();
    f.encoding = "UTF-8";
    if (f.open("w")) {
      f.write(JSON.stringify(data));
      f.close();
    }
  } catch(e) {}
}

function loadCache() {
  try {
    var f = new File(CONFIG.MASTER_CACHE_FILE);
    if (!f.exists) return null;
    f.encoding = "UTF-8";
    if (f.open("r")) {
      var s = f.read(); f.close();
      return safeJsonParse(s);
    }
  } catch(e) {}
  return null;
}

// ══════════════════════════════════════════════════════════
// 파일명/폴더 유틸
// ══════════════════════════════════════════════════════════
function sanitize(s) {
  if (!s) return "";
  return String(s).replace(/[\\\/:*?"<>|]/g, "").replace(/\s+/g, "");
}

function pad2(n) {
  n = String(n); return n.length < 2 ? "0" + n : n;
}

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
// 일러스트 저장 함수 (사용자 평소 옵션 그대로 반영)
// ══════════════════════════════════════════════════════════

// .ai 저장 — 사용자 캡처 옵션:
//   하위 세트 글꼴 100% / PDF 호환 ✓ / ICC 프로파일 ✓ / 압축 ✓ / 단일 파일
function saveAsAI(doc, filePath, compatibility) {
  var opts = new IllustratorSaveOptions();
  opts.compatibility = compatibility;       // CS6 = ILLUSTRATOR16, CC 호환은 ILLUSTRATOR
  opts.fontSubsetThreshold = 100.0;          // 하위 세트 글꼴 100%
  opts.pdfCompatible = true;                 // PDF 호환 파일 만들기
  opts.embedICCProfile = true;               // ICC 프로파일 포함
  opts.compressed = true;                    // 압축 사용
  opts.embedLinkedFiles = false;             // 연결 파일 포함 안함
  opts.saveMultipleArtboards = false;        // 각 대지를 별도 파일로 저장 안함
  opts.flattenOutput = OutputFlattening.PRESERVEAPPEARANCE;
  doc.saveAs(new File(filePath), opts);
}

// .pdf 저장 — 사용자 캡처 옵션:
//   사전설정 [Illustrator 초기값] / Acrobat 7 (PDF 1.6) / 편집기능보존 ✓ / 축소판 ✓
//   웹 최적화 X / 저장 후 PDF 보기 X / Acrobat 레이어 ✓ / 하이퍼링크 ✓
function saveAsPDF(doc, filePath) {
  var opts = new PDFSaveOptions();
  // 사전설정은 직접 지정 안 하고 호환성+옵션 직접 매칭
  opts.compatibility = PDFCompatibility.ACROBAT7;  // Acrobat 7 (PDF 1.6)
  opts.preserveEditability = true;                  // Illustrator 편집 기능 보존
  opts.generateThumbnails = true;                   // 페이지 축소판 포함
  opts.optimization = false;                        // 빠른 웹 보기를 위한 최적화 X
  opts.viewAfterSaving = false;                     // 저장 후 PDF 보기 X
  opts.acrobatLayers = true;                        // 상위 레벨 레이어에서부터 Acrobat 레이어 만들기
  // 하이퍼링크는 preserveEditability=true 시 자동 유지됨
  doc.saveAs(new File(filePath), opts);
}

function exportJPG(doc, filePath, quality) {
  var opts = new ExportOptionsJPEG();
  opts.qualitySetting = quality || 80;
  opts.antiAliasing = true;
  opts.optimization = true;
  doc.exportFile(new File(filePath), ExportType.JPEG, opts);
}

// ══════════════════════════════════════════════════════════
// 다이얼로그 UI
// ══════════════════════════════════════════════════════════
function showDialog(masters) {
  var dlg = new Window("dialog", "시안 저장 (대림에스엠 ERP)");
  dlg.orientation = "column";
  dlg.alignChildren = "fill";
  dlg.preferredSize.width = 540;

  // 헤더
  var header = dlg.add("group");
  header.alignment = "center";
  header.add("statictext", undefined, "📐 시안 자동 저장").graphics.font = ScriptUI.newFont("Malgun Gothic", "Bold", 14);

  // 메인 입력 패널
  var main = dlg.add("panel", undefined, "시안 정보");
  main.orientation = "column";
  main.alignChildren = "fill";
  main.margins = 14;
  main.spacing = 8;

  function addRow(label, control) {
    var g = main.add("group");
    g.orientation = "row";
    g.alignChildren = ["left", "center"];
    var lbl = g.add("statictext", undefined, label);
    lbl.preferredSize.width = 80;
    return g;
  }

  // 월일
  var rowDate = addRow("월일");
  var dateInput = rowDate.add("edittext", undefined, todayMMDD());
  dateInput.characters = 8;

  // 건설사 (DropDownList)
  var rowBrand = addRow("건설사");
  var brandList = rowBrand.add("dropdownlist", undefined, masters.brands);
  brandList.preferredSize.width = 200;
  if (masters.brands.length > 0) brandList.selection = 0;
  var brandOther = rowBrand.add("edittext", undefined, "");
  brandOther.characters = 15;
  rowBrand.add("statictext", undefined, "← 직접입력");

  // 현장
  var rowSite = addRow("현장명");
  var siteList = rowSite.add("dropdownlist", undefined, []);
  siteList.preferredSize.width = 200;
  var siteOther = rowSite.add("edittext", undefined, "");
  siteOther.characters = 15;
  rowSite.add("statictext", undefined, "← 직접입력");

  function updateSitesForBrand() {
    var brand = (brandOther.text || (brandList.selection ? brandList.selection.text : ""));
    siteList.removeAll();
    var sites = (masters.brandSites && masters.brandSites[brand]) || [];
    for (var i = 0; i < sites.length; i++) {
      siteList.add("item", sites[i].name || sites[i]);
    }
    if (siteList.items.length > 0) siteList.selection = 0;
  }
  brandList.onChange = updateSitesForBrand;
  brandOther.onChanging = updateSitesForBrand;

  // 종류
  var rowKind = addRow("종류");
  var kindList = rowKind.add("dropdownlist", undefined, masters.kinds);
  kindList.preferredSize.width = 200;
  if (masters.kinds.length > 0) kindList.selection = 0;
  var kindOther = rowKind.add("edittext", undefined, "");
  kindOther.characters = 15;
  rowKind.add("statictext", undefined, "← 직접입력");

  // 내용
  var rowDesc = addRow("내용");
  var descInput = rowDesc.add("edittext", undefined, "");
  descInput.characters = 35;

  // 버전
  var rowVer = addRow("버전");
  var verInput = rowVer.add("edittext", undefined, "v1");
  verInput.characters = 4;

  // 발주처 (단일 선택 드롭다운)
  var rowVendor = main.add("group");
  rowVendor.orientation = "row";
  rowVendor.alignChildren = ["left", "center"];
  var lblVendor = rowVendor.add("statictext", undefined, "발주처");
  lblVendor.preferredSize.width = 80;
  // 첫 옵션 = "(없음 — 시안만)"
  var vendorOptions = ["(없음 — 시안만)"].concat(masters.vendors);
  var vendorList = rowVendor.add("dropdownlist", undefined, vendorOptions);
  vendorList.preferredSize.width = 180;
  // 기본: 공장 (있으면), 없으면 (없음)
  var defaultIdx = 0;
  for (var vi = 0; vi < vendorOptions.length; vi++) {
    if (vendorOptions[vi] === "공장") { defaultIdx = vi; break; }
  }
  vendorList.selection = defaultIdx;
  var vendorOther = rowVendor.add("edittext", undefined, "");
  vendorOther.characters = 14;
  rowVendor.add("statictext", undefined, "← 직접입력");

  // 저장 형식
  var fmtPanel = dlg.add("panel", undefined, "저장 형식");
  fmtPanel.orientation = "row";
  fmtPanel.alignChildren = "left";
  fmtPanel.margins = 12;
  fmtPanel.spacing = 18;

  var saveOriginalCC = fmtPanel.add("checkbox", undefined, "원본 .ai (CC)");
  saveOriginalCC.value = true;
  var saveOrderCS6 = fmtPanel.add("checkbox", undefined, "발주용 .ai (CS6)");
  saveOrderCS6.value = true;
  var saveJPG = fmtPanel.add("checkbox", undefined, "발주용 .jpg (저화질)");
  saveJPG.value = true;
  var saveOrderPDF = fmtPanel.add("checkbox", undefined, "발주용 .pdf");
  saveOrderPDF.value = false;  // 기본 OFF (가끔만 사용)
  var registerERP = fmtPanel.add("checkbox", undefined, "ERP 자동 등록 (베타)");
  registerERP.value = false;  // Phase 1 에서는 OFF (Phase 2 엑셀업로드 완성 후 활성화)

  // 폴더 미리보기
  var folderPreview = dlg.add("group");
  folderPreview.add("statictext", undefined, "저장 폴더:");
  var folderText = folderPreview.add("statictext", undefined, "(자동)");
  folderText.preferredSize.width = 400;

  function updatePreview() {
    var brand = brandOther.text || (brandList.selection ? brandList.selection.text : "");
    var site = siteOther.text || (siteList.selection ? siteList.selection.text : "");
    var preview = buildFolder({ 건설사: brand, 현장: site });
    folderText.text = preview;
  }
  brandList.onChange = function() { updateSitesForBrand(); updatePreview(); };
  brandOther.onChanging = function() { updateSitesForBrand(); updatePreview(); };
  siteList.onChange = updatePreview;
  siteOther.onChanging = updatePreview;
  updatePreview();

  // 버튼
  var btnGroup = dlg.add("group");
  btnGroup.alignment = "right";
  var cancelBtn = btnGroup.add("button", undefined, "취소");
  var okBtn = btnGroup.add("button", undefined, "한 번에 저장", { name: "ok" });

  // 결과
  var result = null;
  okBtn.onClick = function() {
    var brand = brandOther.text || (brandList.selection ? brandList.selection.text : "");
    var site = siteOther.text || (siteList.selection ? siteList.selection.text : "");
    var kind = kindOther.text || (kindList.selection ? kindList.selection.text : "");
    if (!brand) { alert("건설사를 선택하거나 입력하세요."); return; }
    if (!kind) { alert("종류를 선택하거나 입력하세요."); return; }

    // 선택된 발주처 (단일)
    var vendor = "";
    if (vendorOther.text) {
      vendor = vendorOther.text.replace(/^\s+|\s+$/g, "");
    } else if (vendorList.selection && vendorList.selection.index > 0) {
      // index 0 은 "(없음 — 시안만)"
      vendor = vendorList.selection.text;
    }
    if (!saveOriginalCC.value && !saveOrderCS6.value && !saveOrderPDF.value && !saveJPG.value) {
      alert("저장 형식 중 1개 이상 선택하세요.");
      return;
    }

    result = {
      월일: dateInput.text,
      건설사: brand,
      현장: site,
      종류: kind,
      내용: descInput.text,
      버전: verInput.text,
      발주처: vendor,  // 단일 (빈 문자열이면 시안만)
      saveOriginalCC: saveOriginalCC.value,
      saveOrderCS6: saveOrderCS6.value,
      saveOrderPDF: saveOrderPDF.value,
      saveJPG: saveJPG.value,
      registerERP: registerERP.value
    };
    dlg.close();
  };
  cancelBtn.onClick = function() { dlg.close(); };

  dlg.show();
  return result;
}

// ══════════════════════════════════════════════════════════
// 메인 실행
// ══════════════════════════════════════════════════════════
function main() {
  if (!app.documents.length) {
    alert("열린 문서가 없습니다. Illustrator에서 시안을 먼저 여세요.");
    return;
  }
  var doc = app.activeDocument;

  // 마스터 로드
  var masters = loadMasters();

  // 다이얼로그
  var data = showDialog(masters);
  if (!data) return; // 취소

  // 폴더 생성
  var folder = buildFolder(data);
  ensureFolder(folder);

  var savedFiles = [];
  var errors = [];

  // 발주처 단일. 빈 문자열이면 시안만 저장.
  var vendor = data.발주처 || "";

  // 공통 base 파일명 (suffix 없는 것 — 원본/JPG용)
  var baseName = buildFileName(data, "원본");  // suffix 안 붙음
  // 발주용 base (suffix 붙음 — vendor 가 비어있으면 baseName 그대로)
  var orderName = vendor ? buildFileName(data, vendor) : baseName;

  // 1. 원본 CC .ai (suffix 없음)
  if (data.saveOriginalCC) {
    try {
      var origPath = folder + "\\" + baseName + ".ai";
      saveAsAI(doc, origPath, Compatibility.ILLUSTRATOR);
      savedFiles.push(origPath);
    } catch(e) { errors.push("원본 .ai 저장 실패: " + e.message); }
  }

  // 2. JPG (저화질, suffix 발주처 있으면 붙음 / 없으면 안붙음)
  if (data.saveJPG) {
    try {
      var jpgPath = folder + "\\" + orderName + ".jpg";
      exportJPG(doc, jpgPath, 60);  // 저화질 (일 준 사람한테 줄 용)
      savedFiles.push(jpgPath);
    } catch(e) { errors.push(".jpg 저장 실패: " + e.message); }
  }

  // 3. CS6 .ai (발주처 suffix 있으면 붙음)
  if (data.saveOrderCS6) {
    try {
      var cs6Path = folder + "\\" + orderName + ".ai";
      // 원본과 같은 이름이면 (발주처 없을 때) suffix 추가
      if (cs6Path === folder + "\\" + baseName + ".ai") {
        cs6Path = folder + "\\" + baseName + "-cs6.ai";
      }
      saveAsAI(doc, cs6Path, Compatibility.ILLUSTRATOR16);
      savedFiles.push(cs6Path);
    } catch(e) { errors.push("CS6 .ai 저장 실패: " + e.message); }
  }

  // 4. PDF (디폴트 OFF, 가끔만)
  if (data.saveOrderPDF) {
    try {
      var pdfPath = folder + "\\" + orderName + ".pdf";
      saveAsPDF(doc, pdfPath);
      savedFiles.push(pdfPath);
    } catch(e) { errors.push("PDF 저장 실패: " + e.message); }
  }

  // 4. ERP 등록
  if (data.registerERP) {
    try {
      var payload = {
        월일: data.월일, 건설사: data.건설사, 현장: data.현장,
        종류: data.종류, 내용: data.내용, 버전: data.버전,
        발주처: data.발주처,
        파일경로: savedFiles,
        savedAt: new Date().toISOString()
      };
      var resp = httpRequest("POST", "/api/product-design/register", JSON.stringify(payload));
      // 응답 무시 - 등록 실패해도 파일은 이미 저장됨
    } catch(e) {}
  }

  // 결과 메시지
  var msg = "✅ 저장 완료: " + savedFiles.length + "개 파일\n\n";
  for (var s = 0; s < savedFiles.length; s++) {
    msg += "• " + savedFiles[s].replace(folder + "\\", "") + "\n";
  }
  if (errors.length > 0) {
    msg += "\n⚠️ 오류:\n";
    for (var er = 0; er < errors.length; er++) msg += "• " + errors[er] + "\n";
  }
  msg += "\n폴더: " + folder;
  alert(msg);
}

try {
  main();
} catch(e) {
  alert("스크립트 오류: " + e.message + (e.line ? "\n(line " + e.line + ")" : ""));
}
