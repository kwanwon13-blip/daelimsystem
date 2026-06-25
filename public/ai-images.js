// ─── AI 이미지 저장소 클라이언트 로직 ──────────────────────────
// routes/ai-history.js 의 /images · /image-collections 에 배선.
// 인증: 세션 쿠키(credentials:'include'), 401 → ERP 메인('/')로.
// ai-chat.js 의 embed/캐시버스트 패턴을 미러.

const API = '/api/ai';
const KRW_RATE = 1400;

const state = {
  images: [],
  collections: [],
  tags: [],            // 수집된 태그 목록
  view: 'all',         // 'all' | 'favorite' | 'none' | 앨범 id(숫자)
  activeTag: '',
  q: '',
  sort: 'recent',
  offset: 0,
  limit: 60,
  hasMore: false,
  loading: false,
  selectMode: false,
  selected: new Set(),
  detailId: null,
  detailDirty: false,  // 상세 편집 변경 여부
};

const $ = (id) => document.getElementById(id);

// ── 유틸 ──
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function krw(usd) {
  const n = Number(usd) || 0;
  return '₩' + Math.round(n * KRW_RATE).toLocaleString('ko-KR');
}
function fmtDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  // 'YYYY-MM-DDTHH:mm...' 또는 'YYYY-MM-DD HH:mm...'
  const d = s.slice(0, 10);
  return d.replace(/-/g, '.');
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const s = String(iso).replace('T', ' ');
  return s.slice(0, 16).replace(/-/g, '.');
}
function parseTags(tagStr) {
  return String(tagStr || '').split(',').map(t => t.trim()).filter(Boolean);
}
function basename(p) {
  return String(p || '').split('/').pop().split('\\').pop();
}
let _toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
}

async function copyTextToClipboard(text) {
  const value = String(text == null ? '' : text);
  const api = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (api && typeof api.writeText === 'function') {
    try { await api.writeText(value); return true; } catch (_) {}
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length);
    return document.execCommand && document.execCommand('copy');
  } finally { document.body.removeChild(ta); }
}

// ── 인증 래퍼: 401 이면 메인으로 ──
async function apiFetch(path, opt) {
  const o = Object.assign({ credentials: 'include' }, opt || {});
  const r = await fetch(API + path, o);
  if (r.status === 401) { window.location.href = '/'; throw new Error('unauthorized'); }
  return r;
}
async function apiJson(path, opt) {
  const r = await apiFetch(path, opt);
  if (!r.ok) {
    let msg = r.status;
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(String(msg));
  }
  return r.json();
}
function jsonBody(method, obj) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) };
}

// ── 데이터 로드 ──
async function loadCollections() {
  try {
    const data = await apiJson('/image-collections');
    state.collections = (data && data.collections) || [];
  } catch (e) {
    if (String(e.message) !== 'unauthorized') console.error('앨범 로드 실패', e);
    state.collections = [];
  }
  renderAlbums();
  renderMoveMenu();
}

function buildQuery() {
  const p = new URLSearchParams();
  p.set('sort', state.sort);
  p.set('limit', String(state.limit));
  p.set('offset', String(state.offset));
  if (state.q) p.set('q', state.q);
  if (state.activeTag) p.set('tag', state.activeTag);
  if (state.view === 'favorite') p.set('favorite', '1');
  else if (state.view === 'none') p.set('collectionId', 'none');
  else if (typeof state.view === 'number' || /^\d+$/.test(String(state.view))) p.set('collectionId', String(state.view));
  return p.toString();
}

async function loadImages(append) {
  if (state.loading) return;
  state.loading = true;
  if (!append) {
    state.offset = 0;
    const ls = $('loadingState');
    ls.textContent = '이미지를 불러오는 중…';
    ls.style.color = '';
    ls.style.display = '';
    $('imgGrid').style.display = 'none';
    $('emptyState').style.display = 'none';
    $('loadMoreWrap').style.display = 'none';
  } else {
    $('loadMoreBtn').textContent = '불러오는 중…';
  }
  try {
    const data = await apiJson('/images?' + buildQuery());
    const list = (data && data.images) || [];
    if (append) state.images = state.images.concat(list);
    else state.images = list;
    state.hasMore = list.length >= state.limit;
    state.offset = state.images.length;
    collectTags();
    renderGrid();
  } catch (e) {
    if (String(e.message) !== 'unauthorized') {
      const ls = $('loadingState');
      ls.textContent = '불러오기 실패: ' + e.message;
      ls.style.color = '#dc2626';
      ls.style.display = '';
      $('imgGrid').style.display = 'none';
      $('emptyState').style.display = 'none';
    }
  } finally {
    state.loading = false;
    $('loadMoreBtn').textContent = '더 보기';
  }
}

// 현재 로드된 이미지에서 태그 어휘 수집 (사이드바 태그 칩)
function collectTags() {
  const set = new Map();
  for (const img of state.images) {
    for (const t of parseTags(img.tags)) set.set(t, (set.get(t) || 0) + 1);
  }
  // 활성 태그는 항상 보이도록 포함
  if (state.activeTag && !set.has(state.activeTag)) set.set(state.activeTag, 0);
  state.tags = Array.from(set.keys()).sort((a, b) => a.localeCompare(b, 'ko'));
  renderTags();
}

// ── 렌더: 사이드바 ──
function renderAlbums() {
  const wrap = $('albumList');
  if (!state.collections.length) {
    wrap.innerHTML = '<div class="tag-empty" style="padding:6px 9px;">앨범이 없어요</div>';
    return;
  }
  wrap.innerHTML = state.collections.map(c => {
    const active = String(state.view) === String(c.id);
    const cnt = (c.cnt != null ? c.cnt : (c.count != null ? c.count : 0));
    return '<div class="nav-item' + (active ? ' active' : '') + '" data-album="' + c.id + '">' +
      '<span class="material-symbols-outlined">folder</span>' +
      '<span class="nav-item-name">' + escapeHtml(c.name) + '</span>' +
      '<button class="album-edit-btn" data-album-edit="' + c.id + '" title="앨범 편집"><span class="material-symbols-outlined">edit</span></button>' +
      '<span class="nav-item-count">' + cnt + '</span>' +
      '</div>';
  }).join('');
}
function renderTags() {
  const wrap = $('tagChips');
  if (!state.tags.length) {
    wrap.innerHTML = '<span class="tag-empty">아직 태그가 없어요</span>';
    return;
  }
  wrap.innerHTML = state.tags.map(t =>
    '<span class="tag-chip' + (state.activeTag === t ? ' active' : '') + '" data-tag="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</span>'
  ).join('');
}
function syncNavActive() {
  document.querySelectorAll('.nav-item').forEach(el => {
    const v = el.getAttribute('data-view');
    const alb = el.getAttribute('data-album');
    let on = false;
    if (v) on = (String(state.view) === v);
    else if (alb) on = (String(state.view) === alb);
    el.classList.toggle('active', on);
  });
  // 상단 제목 갱신
  let title = 'AI 이미지 저장소';
  if (state.view === 'favorite') title = '즐겨찾기';
  else if (state.view === 'none') title = '미분류';
  else if (state.view !== 'all') {
    const c = state.collections.find(c => String(c.id) === String(state.view));
    if (c) title = c.name;
  }
  $('topbarTitle').textContent = title;
}

// ── 렌더: 그리드 ──
function renderGrid() {
  const grid = $('imgGrid');
  $('loadingState').style.display = 'none';
  if (!state.images.length) {
    grid.style.display = 'none';
    $('emptyState').style.display = '';
    $('loadMoreWrap').style.display = 'none';
    updateSelCount();
    return;
  }
  $('emptyState').style.display = 'none';
  grid.style.display = '';
  grid.innerHTML = state.images.map(tileHtml).join('');
  $('loadMoreWrap').style.display = state.hasMore ? '' : 'none';
  updateSelCount();
}
function tileHtml(img) {
  const sel = state.selected.has(img.id);
  const fav = img.favorite ? ' on' : ' off';
  const thumb = img.url
    ? '<img src="' + escapeHtml(img.url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'ph-fallback\')">'
    : '<span class="ph"><span class="material-symbols-outlined">image</span></span>';
  const title = img.title || (parseTags(img.prompt)[0]) || (img.prompt || '').slice(0, 30) || '제목 없음';
  const meta = [];
  if (img.size) meta.push(escapeHtml(img.size));
  if (img.quality) meta.push(escapeHtml(img.quality));
  let sub = meta.map(m => '<span>' + m + '</span>').join('<span class="dot"></span>');
  const costKrw = '<span class="tile-cost">' + krw(img.cost_usd) + '</span>';
  const dateS = '<span>' + fmtDate(img.created_at) + '</span>';
  sub = [sub, costKrw, dateS].filter(Boolean).join('<span class="dot"></span>');
  return '<div class="tile' + (sel ? ' selected' : '') + '" data-id="' + img.id + '">' +
    '<div class="tile-thumb">' + thumb +
      '<button class="tile-check' + (sel ? ' on' : '') + '" data-check="' + img.id + '" title="선택"><span class="material-symbols-outlined">check</span></button>' +
      '<button class="tile-fav' + fav + '" data-fav="' + img.id + '" title="즐겨찾기"><span class="material-symbols-outlined">star</span></button>' +
    '</div>' +
    '<div class="tile-meta">' +
      '<div class="tile-title">' + escapeHtml(title) + '</div>' +
      '<div class="tile-sub">' + sub + '</div>' +
    '</div>' +
  '</div>';
}

// ── 선택(다중) ──
function updateSelCount() {
  const n = state.selected.size;
  const bar = $('selbar');
  if (n > 0) {
    bar.classList.add('visible');
    $('selCount').textContent = n + '개 선택';
  } else {
    bar.classList.remove('visible');
    $('moveMenu').classList.remove('visible');
  }
}
function toggleSelect(id) {
  id = Number(id);
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const tile = document.querySelector('.tile[data-id="' + id + '"]');
  if (tile) {
    const on = state.selected.has(id);
    tile.classList.toggle('selected', on);
    const chk = tile.querySelector('.tile-check');
    if (chk) chk.classList.toggle('on', on);
  }
  updateSelCount();
}
function clearSelection() {
  state.selected.clear();
  document.querySelectorAll('.tile.selected').forEach(t => t.classList.remove('selected'));
  document.querySelectorAll('.tile-check.on').forEach(t => t.classList.remove('on'));
  updateSelCount();
}

// ── 즐겨찾기 토글 ──
async function toggleFavorite(id) {
  id = Number(id);
  try {
    const data = await apiJson('/images/' + id + '/favorite', { method: 'POST' });
    const fav = data && data.favorite ? 1 : 0;
    const img = state.images.find(i => i.id === id);
    if (img) img.favorite = fav;
    // 즐겨찾기 보기에서 해제하면 목록에서 제거
    if (state.view === 'favorite' && !fav) {
      state.images = state.images.filter(i => i.id !== id);
      renderGrid();
    } else {
      const btn = document.querySelector('.tile-fav[data-fav="' + id + '"]');
      if (btn) { btn.classList.toggle('on', !!fav); btn.classList.toggle('off', !fav); }
    }
    if (state.detailId === id) renderDetailFavState(fav);
  } catch (e) {
    if (String(e.message) !== 'unauthorized') toast('즐겨찾기 실패: ' + e.message);
  }
}

// ── 상세 슬라이드오버 ──
async function openDetail(id) {
  id = Number(id);
  state.detailId = id;
  state.detailDirty = false;
  $('detailBg').classList.add('visible');
  $('detail').classList.add('visible');
  $('detailBody').innerHTML = '<div class="loading-state">불러오는 중…</div>';
  let img = state.images.find(i => i.id === id);
  try {
    const data = await apiJson('/images/' + id);
    if (data && data.image) img = data.image;
  } catch (e) {
    if (String(e.message) === 'unauthorized') return;
    $('detailBody').innerHTML = '<div class="loading-state" style="color:#dc2626;">불러오기 실패: ' + escapeHtml(e.message) + '</div>';
    return;
  }
  if (!img) { closeDetail(); return; }
  // 캐시 갱신
  const idx = state.images.findIndex(i => i.id === id);
  if (idx >= 0) state.images[idx] = img;
  renderDetail(img);
}
function closeDetail() {
  state.detailId = null;
  $('detailBg').classList.remove('visible');
  $('detail').classList.remove('visible');
}
function renderDetailFavState(fav) {
  const btn = document.getElementById('detailFavBtn');
  if (btn) {
    btn.classList.toggle('on', !!fav);
    const ic = btn.querySelector('.material-symbols-outlined');
    if (ic) ic.style.fontVariationSettings = fav ? "'FILL' 1" : "'FILL' 0";
    btn.lastChild.textContent = fav ? ' 즐겨찾기됨' : ' 즐겨찾기';
  }
}
function renderDetail(img) {
  const title = img.title || (img.prompt || '').slice(0, 40) || '제목 없음';
  $('detailHeadTitle').textContent = title;
  const dl = $('detailDownload');
  dl.setAttribute('href', img.url || '#');
  dl.setAttribute('download', img.stored_name || basename(img.url) || 'image.png');

  const tags = parseTags(img.tags);
  const albumOpts = ['<option value="">미분류</option>'].concat(
    state.collections.map(c => '<option value="' + c.id + '"' + (String(c.id) === String(img.collection_id || '') ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>')
  ).join('');

  const metaRows = [];
  if (img.model) metaRows.push(['모델', escapeHtml(img.model)]);
  if (img.size) metaRows.push(['크기', escapeHtml(img.size)]);
  if (img.quality) metaRows.push(['품질', escapeHtml(img.quality)]);
  metaRows.push(['비용', krw(img.cost_usd), 'cost']);
  if (img.owner_name) metaRows.push(['만든이', escapeHtml(img.owner_name)]);
  if (img.created_at) metaRows.push(['생성일', fmtDateTime(img.created_at)]);
  if (img.thread_id) metaRows.push(['출처', '대화 #' + img.thread_id]);
  const metaHtml = metaRows.map(r => '<dt>' + r[0] + '</dt><dd' + (r[2] ? ' class="' + r[2] + '"' : '') + '>' + r[1] + '</dd>').join('');

  const imgHtml = img.url
    ? '<img src="' + escapeHtml(img.url) + '" alt="">'
    : '<span class="ph" style="color:#cbd1da;"><span class="material-symbols-outlined" style="font-size:48px;">image</span></span>';

  $('detailBody').innerHTML =
    '<div class="detail-img">' + imgHtml + '</div>' +

    // 문서화 블록 — 원래 입력 + 최종 프롬프트
    '<div class="detail-block">' +
      '<div class="detail-block-label"><span class="material-symbols-outlined">edit_note</span>원래 입력</div>' +
      '<div class="doc-text' + (img.user_input ? '' : ' muted') + '">' + (img.user_input ? escapeHtml(img.user_input) : '(기록 없음)') + '</div>' +
      '<div class="detail-block-label" style="margin-top:12px;"><span class="material-symbols-outlined">auto_awesome</span>최종 프롬프트</div>' +
      '<div class="doc-prompt" id="detailPromptText">' + escapeHtml(img.prompt || '') + '</div>' +
    '</div>' +

    // 메타
    '<div class="detail-block">' +
      '<div class="detail-block-label"><span class="material-symbols-outlined">info</span>정보</div>' +
      '<dl class="meta-grid">' + metaHtml + '</dl>' +
    '</div>' +

    // 비슷한 이미지 (모아보기) — 0개면 JS 가 숨김. 로드 전 자리만 둠.
    '<div class="detail-block sim-block" id="simBlock" style="display:none;">' +
      '<div class="detail-block-label"><span class="material-symbols-outlined">image_search</span>비슷한 이미지</div>' +
      '<div class="sim-strip" id="simStrip"></div>' +
    '</div>' +

    // 편집: 제목·메모·태그·앨범
    '<div class="detail-block">' +
      '<div class="detail-block-label"><span class="material-symbols-outlined">tune</span>정리</div>' +
      '<div class="field-label">제목</div>' +
      '<input class="field-input" id="editTitle" value="' + escapeHtml(img.title || '') + '" maxlength="200">' +
      '<div class="field-label">메모</div>' +
      '<textarea class="field-input" id="editNote" maxlength="2000" placeholder="이 이미지에 대한 메모…">' + escapeHtml(img.note || '') + '</textarea>' +
      '<div class="field-label">앨범</div>' +
      '<select class="field-input" id="editAlbum">' + albumOpts + '</select>' +
      '<div class="field-label">태그</div>' +
      '<input class="field-input" id="tagInput" placeholder="태그 입력 후 Enter">' +
      '<div class="tag-edit-chips" id="tagEditChips"></div>' +
      '<div class="save-row">' +
        '<button class="btn-save" id="saveDetailBtn" disabled><span class="material-symbols-outlined">check</span>저장</button>' +
      '</div>' +
    '</div>' +

    // 동작
    '<div class="detail-actions">' +
      '<button class="act-btn" id="detailFavBtn"><span class="material-symbols-outlined">star</span>' + (img.favorite ? ' 즐겨찾기됨' : ' 즐겨찾기') + '</button>' +
      '<a class="act-btn" id="detailDlBtn" href="' + escapeHtml(img.url || '#') + '" download="' + escapeHtml(img.stored_name || basename(img.url) || 'image.png') + '"><span class="material-symbols-outlined">download</span>다운로드</a>' +
      '<button class="act-btn" id="copyPromptBtn"><span class="material-symbols-outlined">content_copy</span>프롬프트 복사</button>' +
      '<button class="act-btn" id="regenBtn"><span class="material-symbols-outlined">refresh</span>이걸로 다시</button>' +
      '<button class="act-btn" id="useRefBtn"><span class="material-symbols-outlined">add_photo_alternate</span>참고로 사용</button>' +
      '<button class="act-btn danger" id="deleteDetailBtn"><span class="material-symbols-outlined">delete</span>삭제</button>' +
    '</div>';

  // 편집용 로컬 태그 상태
  detailTags = tags.slice();
  renderDetailTagChips();
  renderDetailFavState(img.favorite);
  wireDetailHandlers(img);
  loadSimilar(img.id);
}

// ── 비슷한 이미지 (모아보기) ──
// GET /images/:id/similar → { ok, images:[ {…행…, _sim} ] }. 타일 클릭 시 그 상세로 전환.
let _simReqId = 0;
async function loadSimilar(id) {
  id = Number(id);
  const reqId = ++_simReqId;   // 빠른 상세 전환 시 늦게 온 응답 무시
  const block = $('simBlock');
  const strip = $('simStrip');
  if (!block || !strip) return;
  try {
    const data = await apiJson('/images/' + id + '/similar?limit=8');
    if (reqId !== _simReqId || state.detailId !== id) return;  // 그새 다른 이미지로 이동했으면 버림
    const list = (data && data.images) || [];
    if (!list.length) { block.style.display = 'none'; strip.innerHTML = ''; return; }
    strip.innerHTML = list.map(simTileHtml).join('');
    block.style.display = '';
  } catch (e) {
    // 비슷한 이미지 실패는 조용히 (상세 본문은 그대로 유지)
    if (reqId !== _simReqId || state.detailId !== id) return;
    block.style.display = 'none';
    strip.innerHTML = '';
  }
}
function simTileHtml(img) {
  const thumb = img.url
    ? '<img src="' + escapeHtml(img.url) + '" alt="" loading="lazy" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'ph-fallback\')">'
    : '<span class="ph"><span class="material-symbols-outlined">image</span></span>';
  const title = img.title || (img.prompt || '').slice(0, 30) || '제목 없음';
  const sim = Number(img._sim) || 0;
  const simBadge = sim > 0 ? '<span class="sim-badge">' + sim + '% 비슷</span>' : '';
  return '<button class="sim-tile" data-sim-id="' + img.id + '" title="' + escapeHtml(title) + '">' +
    '<span class="sim-thumb">' + thumb + simBadge + '</span>' +
    '<span class="sim-title">' + escapeHtml(title) + '</span>' +
  '</button>';
}

let detailTags = [];
function renderDetailTagChips() {
  const wrap = $('tagEditChips');
  if (!wrap) return;
  wrap.innerHTML = detailTags.map((t, i) =>
    '<span class="tag-edit-chip">#' + escapeHtml(t) + '<span class="x" data-rmtag="' + i + '"><span class="material-symbols-outlined">close</span></span></span>'
  ).join('');
}
function markDetailDirty() {
  state.detailDirty = true;
  const btn = $('saveDetailBtn');
  if (btn) btn.disabled = false;
}
function wireDetailHandlers(img) {
  const titleEl = $('editTitle'), noteEl = $('editNote'), albumEl = $('editAlbum'), tagInput = $('tagInput');
  [titleEl, noteEl].forEach(el => el && el.addEventListener('input', markDetailDirty));
  if (albumEl) albumEl.addEventListener('change', markDetailDirty);
  if (tagInput) tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = tagInput.value.trim().replace(/^#/, '');
      if (v && !detailTags.includes(v)) { detailTags.push(v); renderDetailTagChips(); markDetailDirty(); }
      tagInput.value = '';
    }
  });
  const chips = $('tagEditChips');
  if (chips) chips.addEventListener('click', (e) => {
    const x = e.target.closest('[data-rmtag]');
    if (x) { detailTags.splice(Number(x.getAttribute('data-rmtag')), 1); renderDetailTagChips(); markDetailDirty(); }
  });
  const saveBtn = $('saveDetailBtn');
  if (saveBtn) saveBtn.addEventListener('click', () => saveDetail(img.id));
  const favBtn = $('detailFavBtn');
  if (favBtn) favBtn.addEventListener('click', () => toggleFavorite(img.id));
  const copyBtn = $('copyPromptBtn');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const ok = await copyTextToClipboard(img.prompt || '');
    toast(ok ? '프롬프트를 복사했어요' : '복사 실패');
  });
  const regenBtn = $('regenBtn');
  if (regenBtn) regenBtn.addEventListener('click', () => regenerate(img.prompt || ''));
  const refBtn = $('useRefBtn');
  if (refBtn) refBtn.addEventListener('click', () => useAsReference(img));
  const delBtn = $('deleteDetailBtn');
  if (delBtn) delBtn.addEventListener('click', () => deleteImages([img.id], true));
}

async function saveDetail(id) {
  const body = {
    title: ($('editTitle') || {}).value || '',
    note: ($('editNote') || {}).value || '',
    tags: detailTags.join(', '),
  };
  const albumEl = $('editAlbum');
  if (albumEl) body.collectionId = albumEl.value === '' ? null : albumEl.value;
  const btn = $('saveDetailBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span>저장 중…'; }
  try {
    const data = await apiJson('/images/' + id, jsonBody('PATCH', body));
    if (data && data.image) {
      const idx = state.images.findIndex(i => i.id === id);
      if (idx >= 0) state.images[idx] = data.image;
    }
    state.detailDirty = false;
    toast('저장했어요');
    // 앨범을 옮겼거나 현재 보기에서 벗어나면 목록 새로고침
    await loadCollections();
    if (state.view !== 'all') await loadImages(false);
    else { collectTags(); renderGrid(); }
  } catch (e) {
    if (String(e.message) !== 'unauthorized') toast('저장 실패: ' + e.message);
  } finally {
    if (btn) { btn.innerHTML = '<span class="material-symbols-outlined">check</span>저장'; btn.disabled = !state.detailDirty; }
  }
}

// "이걸로 다시" — 프롬프트를 들고 AI 챗으로 이동(prefill)
function regenerate(prompt) {
  const url = '/ai-chat.html?embed=1&prefill=' + encodeURIComponent(prompt || '');
  // embed(iframe) 상황이면 부모 탭 전환을 유도, 아니면 현재 창 이동
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'erp:navtab', tab: 'ai', prefill: prompt || '' }, '*');
    } catch (_) {}
  }
  window.location.href = url;
}

// "참고로 사용" — 이 이미지를 참고 이미지로 AI 챗에 넘김(이미지 URL 전달).
// 챗 쪽 참고이미지 수신 처리는 ai-chat 레이어 소관이므로, prefill/postMessage 채널로 URL 을 전달.
function useAsReference(img) {
  if (!img || !img.url) { toast('이미지 주소가 없어요'); return; }
  const ref = img.url;
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ type: 'erp:navtab', tab: 'ai', refImage: ref, prefill: '' }, '*');
    } catch (_) {}
  }
  window.location.href = '/ai-chat.html?embed=1&refImage=' + encodeURIComponent(ref);
}

// ── 삭제 ──
async function deleteImages(ids, fromDetail) {
  ids = ids.map(Number);
  if (!ids.length) return;
  const msg = ids.length === 1 ? '이 이미지를 저장소에서 삭제할까요?\n(원본 파일은 디스크에 보존됩니다)' : ids.length + '개 이미지를 저장소에서 삭제할까요?\n(원본 파일은 디스크에 보존됩니다)';
  if (!window.confirm(msg)) return;
  let okCount = 0;
  for (const id of ids) {
    try {
      await apiJson('/images/' + id, { method: 'DELETE' });
      okCount++;
      state.images = state.images.filter(i => i.id !== id);
      state.selected.delete(id);
    } catch (e) {
      if (String(e.message) === 'unauthorized') return;
    }
  }
  if (fromDetail) closeDetail();
  toast(okCount + '개 삭제했어요');
  await loadCollections();
  collectTags();
  renderGrid();
}

// ── 다중선택: 태그/이동/다운로드 ──
async function bulkTag() {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  const input = window.prompt('추가할 태그를 입력하세요 (쉼표로 여러 개)');
  if (input == null) return;
  const adds = parseTags(input);
  if (!adds.length) return;
  let ok = 0;
  for (const id of ids) {
    const img = state.images.find(i => i.id === id);
    if (!img) continue;
    const merged = Array.from(new Set(parseTags(img.tags).concat(adds)));
    try {
      const data = await apiJson('/images/' + id, jsonBody('PATCH', { tags: merged.join(', ') }));
      if (data && data.image) img.tags = data.image.tags;
      ok++;
    } catch (e) { if (String(e.message) === 'unauthorized') return; }
  }
  toast(ok + '개에 태그를 추가했어요');
  clearSelection();
  collectTags();
  renderGrid();
}
async function bulkMove(collectionId) {
  const ids = Array.from(state.selected);
  if (!ids.length) return;
  $('moveMenu').classList.remove('visible');
  const cidBody = (collectionId === 'none' || collectionId == null) ? null : collectionId;
  let ok = 0;
  for (const id of ids) {
    try {
      await apiJson('/images/' + id, jsonBody('PATCH', { collectionId: cidBody }));
      ok++;
    } catch (e) { if (String(e.message) === 'unauthorized') return; }
  }
  toast(ok + '개를 옮겼어요');
  clearSelection();
  await loadCollections();
  await loadImages(false);
}
function bulkDownload() {
  const ids = Array.from(state.selected);
  const imgs = state.images.filter(i => ids.includes(i.id) && i.url);
  if (!imgs.length) return;
  // 브라우저 다운로드를 순차로 트리거 (a[download])
  let i = 0;
  const next = () => {
    if (i >= imgs.length) return;
    const img = imgs[i++];
    const a = document.createElement('a');
    a.href = img.url;
    a.download = img.stored_name || basename(img.url) || ('image-' + img.id + '.png');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(next, 400);
  };
  next();
  toast(imgs.length + '개 다운로드를 시작했어요');
}
function renderMoveMenu() {
  const menu = $('moveMenu');
  let html = '<button data-move="none"><span class="material-symbols-outlined">folder_off</span>미분류로</button>';
  html += state.collections.map(c =>
    '<button data-move="' + c.id + '"><span class="material-symbols-outlined">folder</span>' + escapeHtml(c.name) + '</button>'
  ).join('');
  menu.innerHTML = html;
}

// ── 앨범 모달 (생성 / 이름변경+삭제) ──
let modalMode = 'create';  // 'create' | 'edit'
let modalEditId = null;
function openAlbumModal(mode, album) {
  modalMode = mode;
  modalEditId = album ? album.id : null;
  $('modalTitle').textContent = mode === 'create' ? '새 앨범' : '앨범 편집';
  $('modalInput').value = album ? (album.name || '') : '';
  $('modalDelBtn').style.display = mode === 'edit' ? '' : 'none';
  $('modalBg').classList.add('visible');
  setTimeout(() => { $('modalInput').focus(); $('modalInput').select(); }, 30);
}
function closeModal() { $('modalBg').classList.remove('visible'); }
async function submitModal() {
  const name = $('modalInput').value.trim();
  if (!name) { $('modalInput').focus(); return; }
  try {
    if (modalMode === 'create') {
      const data = await apiJson('/image-collections', jsonBody('POST', { name }));
      toast('앨범을 만들었어요');
      closeModal();
      await loadCollections();
      if (data && data.collection) selectView(data.collection.id);
    } else {
      await apiJson('/image-collections/' + modalEditId, jsonBody('PATCH', { name }));
      toast('앨범 이름을 바꿨어요');
      closeModal();
      await loadCollections();
      syncNavActive();
    }
  } catch (e) {
    if (String(e.message) !== 'unauthorized') toast('실패: ' + e.message);
  }
}
async function deleteAlbum() {
  if (modalEditId == null) return;
  if (!window.confirm('앨범을 삭제할까요?\n안에 있던 이미지는 미분류로 이동합니다.')) return;
  try {
    await apiJson('/image-collections/' + modalEditId, { method: 'DELETE' });
    toast('앨범을 삭제했어요');
    closeModal();
    if (String(state.view) === String(modalEditId)) state.view = 'all';
    await loadCollections();
    await loadImages(false);
    syncNavActive();
  } catch (e) {
    if (String(e.message) !== 'unauthorized') toast('삭제 실패: ' + e.message);
  }
}

// ── 보기 전환 ──
function selectView(view) {
  state.view = (typeof view === 'string' && /^\d+$/.test(view)) ? Number(view) : view;
  state.activeTag = '';   // 보기 바꾸면 태그 필터 해제
  clearSelection();
  closeSidebarMobile();
  syncNavActive();
  renderTags();
  loadImages(false);
}
function selectTag(tag) {
  state.activeTag = (state.activeTag === tag) ? '' : tag;
  renderTags();
  loadImages(false);
}

// ── 사이드바(모바일) ──
function closeSidebarMobile() { $('sidebar').classList.remove('open'); }

// ── 사용량 배지 ──
async function loadUsage() {
  try {
    const data = await apiJson('/usage/today');
    const im = data && data.image;
    if (im) {
      const today = im.todayCostKrw != null ? '₩' + Number(im.todayCostKrw).toLocaleString('ko-KR') : krw(im.todayCostUsd);
      const month = im.monthCostKrw != null ? '₩' + Number(im.monthCostKrw).toLocaleString('ko-KR') : krw(im.monthCostUsd);
      $('usageLabel').textContent = '오늘 ' + (im.todayCount || 0) + '장 ' + today + ' · 이번달 ' + month;
      $('usagePill').style.display = '';
    }
  } catch (e) { /* 사용량 실패는 조용히 */ }
}

// ── 이벤트 배선 ──
function wire() {
  // 사이드바 보기/앨범/태그 (위임)
  $('sidebar').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-album-edit]');
    if (editBtn) {
      e.stopPropagation();
      const c = state.collections.find(c => String(c.id) === editBtn.getAttribute('data-album-edit'));
      if (c) openAlbumModal('edit', c);
      return;
    }
    const navView = e.target.closest('[data-view]');
    if (navView) { selectView(navView.getAttribute('data-view')); return; }
    const navAlbum = e.target.closest('[data-album]');
    if (navAlbum) { selectView(navAlbum.getAttribute('data-album')); return; }
    const tagChip = e.target.closest('[data-tag]');
    if (tagChip) { selectTag(tagChip.getAttribute('data-tag')); return; }
  });

  $('addAlbumBtn').addEventListener('click', (e) => { e.stopPropagation(); openAlbumModal('create'); });
  $('newAlbumBtn').addEventListener('click', () => openAlbumModal('create'));

  // 검색 (디바운스)
  let searchTimer = null;
  $('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value.trim();
    searchTimer = setTimeout(() => { state.q = v; loadImages(false); }, 280);
  });
  // 정렬
  $('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; loadImages(false); });

  // 그리드 (위임): 즐겨찾기 / 체크 / 타일 클릭
  $('imgGrid').addEventListener('click', (e) => {
    const favBtn = e.target.closest('[data-fav]');
    if (favBtn) { e.stopPropagation(); toggleFavorite(favBtn.getAttribute('data-fav')); return; }
    const chkBtn = e.target.closest('[data-check]');
    if (chkBtn) { e.stopPropagation(); toggleSelect(chkBtn.getAttribute('data-check')); return; }
    const tile = e.target.closest('.tile');
    if (tile) {
      const id = tile.getAttribute('data-id');
      // 선택 모드(이미 선택된 게 있으면)에서는 클릭이 선택 토글
      if (state.selected.size > 0) toggleSelect(id);
      else openDetail(id);
    }
  });
  $('loadMoreBtn').addEventListener('click', () => loadImages(true));

  // 선택 액션바
  $('selCancelBtn').addEventListener('click', clearSelection);
  $('selDeleteBtn').addEventListener('click', () => deleteImages(Array.from(state.selected), false));
  $('selTagBtn').addEventListener('click', bulkTag);
  $('selDownloadBtn').addEventListener('click', bulkDownload);
  $('selMoveBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('moveMenu').classList.toggle('visible');
  });
  $('moveMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-move]');
    if (b) bulkMove(b.getAttribute('data-move'));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.selbar-move')) $('moveMenu').classList.remove('visible');
  });

  // 상세
  $('detailClose').addEventListener('click', closeDetail);
  $('detailBg').addEventListener('click', closeDetail);
  // 비슷한 이미지 타일 클릭 → 그 이미지 상세로 전환 (위임: detailBody 는 정적 노드)
  $('detailBody').addEventListener('click', (e) => {
    const simBtn = e.target.closest('[data-sim-id]');
    if (simBtn) { e.preventDefault(); openDetail(simBtn.getAttribute('data-sim-id')); }
  });

  // 모달
  $('modalCancel').addEventListener('click', closeModal);
  $('modalOk').addEventListener('click', submitModal);
  $('modalDelBtn').addEventListener('click', deleteAlbum);
  $('modalInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitModal(); });
  $('modalBg').addEventListener('click', (e) => { if (e.target === $('modalBg')) closeModal(); });

  // 햄버거(모바일)
  $('hamburgerBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('sidebarBackdrop').addEventListener('click', closeSidebarMobile);

  // ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('modalBg').classList.contains('visible')) closeModal();
      else if ($('detail').classList.contains('visible')) closeDetail();
      else if (state.selected.size) clearSelection();
    }
  });
}

// ── embed 모드 감지 (ERP 메인 탭 안 iframe) — ai-chat.js 미러 ──
function applyEmbed() {
  const isEmbedded = (window.parent !== window) || new URLSearchParams(location.search).get('embed') === '1';
  if (isEmbedded) {
    const footer = document.querySelector('.sidebar-footer');
    if (footer) footer.style.display = 'none';
    document.body.style.background = '#fff';
  }
}

// ── 초기화 ──
function init() {
  applyEmbed();
  wire();
  loadCollections();
  loadImages(false);
  loadUsage();
}
init();
