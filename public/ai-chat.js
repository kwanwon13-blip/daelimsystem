// ─── AI 챗 클라이언트 로직 ──────────────────────────────────
const MODELS = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', desc: '가장 강력 · 복잡한 분석 · 추론' },
  { id: 'claude-sonnet-4-7', label: 'Claude Sonnet 4.7', desc: '빠르고 똑똑함 · 일반 업무' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', desc: '가장 빠름 · 간단 질문' },
];
const DEFAULT_MODEL_ID = MODELS[0].id; // Opus 4.7 기본
// 이전 버전 모델 ID 가 저장돼 있으면 (오래된 ID) 무시하고 새 기본값으로
const _saved = localStorage.getItem('ai_chat_model_v2');
const SAVED_MODEL = (_saved && MODELS.find(m => m.id === _saved)) ? _saved : DEFAULT_MODEL_ID;

const state = {
  threads: [], filteredThreads: [], activeThreadId: null, searchQuery: '',
  messages: [], streaming: false, attachments: [],
  imageMode: false, usage: null,
  modelId: SAVED_MODEL,
  apiKeyAvailable: null,
};

const $ = (id) => document.getElementById(id);
const input = $('composerInput'), sendBtn = $('sendBtn'), composerEl = $('composer');
const threadListEl = $('threadList'), threadListLoading = $('threadListLoading'), threadSearchEl = $('threadSearch');
const topbarTitleEl = $('topbarTitle'), messagesEl = $('messages'), emptyStateEl = $('emptyState');
const attachmentsRowEl = $('attachmentsRow'), attachBtn = $('attachBtn'), fileInput = $('fileInput');
const dropOverlay = $('dropOverlay'), imageModeBtn = $('imageModeBtn'), composerHint = $('composerHint');
const usagePill = $('usagePill'), usageLabel = $('usageLabel');
const modelBtn = $('modelBtn'), modelMenu = $('modelMenu'), modelLabel = $('modelLabel');
const previewModalBg = $('previewModalBg'), previewBody = $('previewBody');
const previewTitle = $('previewTitle'), previewClose = $('previewClose'), previewDownload = $('previewDownload');

// 마크다운
if (window.marked) {
  marked.setOptions({ breaks: true, gfm: true,
    highlight: (code, lang) => {
      try {
        if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value;
        return hljs.highlightAuto(code).value;
      } catch (e) { return code; }
    }
  });
}
function md(text) {
  if (!text) return '';
  try {
    const html = marked.parse(String(text));
    return window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
  } catch (e) { return escapeHtml(text); }
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024*1024) return (n/1024).toFixed(0) + 'KB';
  return (n/1024/1024).toFixed(1) + 'MB';
}

// 입력창
function autoResize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  updateSendBtn();
}
function updateSendBtn() {
  const hasText = !!input.value.trim();
  const hasReadyAtt = state.attachments.some(a => !a.uploading);
  const uploading = state.attachments.some(a => a.uploading);
  sendBtn.disabled = state.streaming || uploading || (!hasText && !hasReadyAtt);
}
input.addEventListener('input', autoResize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) sendMessage(); }
});
sendBtn.addEventListener('click', () => { if (!sendBtn.disabled) sendMessage(); });

// 새 대화
$('newChatBtn').addEventListener('click', () => {
  if (state.streaming) return;
  state.activeThreadId = null;
  state.messages = []; state.attachments = [];
  renderAttachments();
  topbarTitleEl.textContent = '새 대화';
  renderMessagesFull();
  renderThreadList();
  input.focus();
});

// 이미지 모드
imageModeBtn.addEventListener('click', () => {
  state.imageMode = !state.imageMode;
  imageModeBtn.classList.toggle('active', state.imageMode);
  composerEl.classList.toggle('image-mode', state.imageMode);
  input.placeholder = state.imageMode
    ? '만들고 싶은 이미지를 설명하세요. 예: 깔끔한 사무실 책상에 노트북과 커피'
    : '무엇이든 물어보세요. 파일은 드래그하거나 📎로 첨부.';
  composerHint.textContent = state.imageMode
    ? '🎨 이미지 생성 모드 — 1장당 10~30초 소요 · 일일 한도 적용'
    : 'Enter 로 전송 · Shift+Enter 줄바꿈 · 파일을 끌어다 놓을 수 있어요';
  if (state.imageMode) { loadUsage(); usagePill.style.display = ''; }
  else { usagePill.style.display = 'none'; }
});

// 모델 선택
function setModel(id) {
  state.modelId = id;
  localStorage.setItem('ai_chat_model_v2', id);
  const m = MODELS.find(x => x.id === id) || MODELS[0];
  modelLabel.textContent = m.label;
}
function buildModelMenu() {
  modelMenu.innerHTML = MODELS.map(m => {
    const active = m.id === state.modelId;
    return '<button data-id="' + m.id + '" style="display:block;width:100%;text-align:left;padding:8px 10px;border-radius:6px;background:' + (active ? '#eff3ff' : 'transparent') + ';color:' + (active ? '#4f6ef7' : '#1f2937') + ';font-size:13px;font-weight:' + (active ? '600' : '500') + ';">' +
      '<div>' + m.label + (active ? ' <span class="material-symbols-outlined" style="font-size:13px;vertical-align:middle;">check</span>' : '') + '</div>' +
      '<div style="font-size:11px;color:#9ca3af;font-weight:400;">' + m.desc + '</div>' +
    '</button>';
  }).join('');
}
modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  buildModelMenu();
  modelMenu.style.display = modelMenu.style.display === 'none' ? 'block' : 'none';
});
modelMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  setModel(btn.dataset.id);
  modelMenu.style.display = 'none';
});
document.addEventListener('click', (e) => {
  if (!modelMenu.contains(e.target) && e.target !== modelBtn && !modelBtn.contains(e.target)) modelMenu.style.display = 'none';
});
setModel(state.modelId);

// 환경 감지
async function detectApiMode() {
  try {
    const r = await fetch('/api/ai/health', { credentials: 'include' });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      state.apiKeyAvailable = data.backend === 'api';
      console.log('[ai-chat] 백엔드:', data.backend, '/ 모델:', data.model);
    } else { state.apiKeyAvailable = false; }
  } catch (e) { state.apiKeyAvailable = false; }
}

// 사용량
async function loadUsage() {
  try {
    const r = await fetch('/api/ai/usage/today', { credentials: 'include' });
    if (!r.ok) return;
    const data = await r.json();
    state.usage = data;
    if (data && data.limit !== undefined) usageLabel.textContent = '이미지 ' + (data.count || 0) + '/' + data.limit;
  } catch (e) {}
}

// 스레드
async function loadThreads() {
  try {
    const r = await fetch('/api/ai/threads?scope=mine&limit=100', { credentials: 'include' });
    if (r.status === 401) { window.location.href = '/'; return; }
    if (!r.ok) throw new Error('threads ' + r.status);
    const data = await r.json();
    state.threads = data.threads || [];
    renderThreadList();
  } catch (e) {
    console.error('스레드 로드 실패:', e);
    threadListLoading.textContent = '불러오기 실패.';
    threadListLoading.style.color = '#dc2626';
  }
}
function groupByDate(threads) {
  const sod = (d) => { const x = new Date(d); x.setHours(0,0,0,0); return x.getTime(); };
  const today = sod(new Date()), yest = today - 86400000;
  const w = today - 7*86400000, mo = today - 30*86400000;
  const g = { today: [], yest: [], week: [], month: [], older: [] };
  for (const t of threads) {
    const ts = sod(t.updated_at || t.created_at);
    if (ts === today) g.today.push(t);
    else if (ts === yest) g.yest.push(t);
    else if (ts > w) g.week.push(t);
    else if (ts > mo) g.month.push(t);
    else g.older.push(t);
  }
  return g;
}
function renderThreadList() {
  const q = state.searchQuery.toLowerCase().trim();
  state.filteredThreads = q ? state.threads.filter(t => (t.title || '').toLowerCase().includes(q)) : state.threads;
  if (state.filteredThreads.length === 0) {
    threadListEl.innerHTML = '<div style="padding:40px 14px;color:#9ca3af;font-size:12px;text-align:center;white-space:pre-line;">' + (q ? '검색 결과 없음' : '아직 대화가 없어요.\n위 "+ 새 대화" 버튼을 눌러 시작하세요.') + '</div>';
    return;
  }
  const groups = groupByDate(state.filteredThreads);
  const labels = { today: '오늘', yest: '어제', week: '지난 7일', month: '지난 30일', older: '이전' };
  let html = '';
  for (const key of ['today','yest','week','month','older']) {
    if (groups[key].length === 0) continue;
    html += '<div class="thread-group-label">' + labels[key] + '</div>';
    for (const t of groups[key]) {
      const isActive = String(state.activeThreadId) === String(t.id);
      const title = escapeHtml(t.title || '제목 없음');
      const icon = t.project_emoji ? '<span style="font-size:12px;flex-shrink:0;">' + t.project_emoji + '</span>' : '<span class="material-symbols-outlined">chat_bubble</span>';
      html += '<div class="thread-item ' + (isActive ? 'active' : '') + '" data-id="' + t.id + '" title="' + title + '">' + icon + '<span class="thread-item-title">' + title + '</span></div>';
    }
  }
  threadListEl.innerHTML = html;
}
threadListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.thread-item');
  if (item && item.dataset.id) selectThread(item.dataset.id);
});

async function selectThread(threadId) {
  if (state.streaming) return;
  state.activeThreadId = threadId;
  state.attachments = [];
  renderAttachments();
  const t = state.threads.find(x => String(x.id) === String(threadId));
  topbarTitleEl.textContent = t ? (t.title || '제목 없음') : '새 대화';
  renderThreadList();
  state.messages = [];
  messagesEl.innerHTML = '<div style="text-align:center;padding:40px;color:#9ca3af;font-size:13px;">불러오는 중…</div>';
  try {
    const r = await fetch('/api/ai/threads/' + encodeURIComponent(threadId), { credentials: 'include' });
    if (!r.ok) throw new Error('threads/:id ' + r.status);
    const data = await r.json();
    state.messages = (data.messages || []).map(m => ({
      id: m.id, role: m.role, content: m.content || '', createdAt: m.created_at,
      attachments: m.attachments_parsed || [], artifacts: m.artifacts_parsed || [],
      image_url: m.image_url || null,
    }));
    renderMessagesFull();
    scrollToBottom();
  } catch (e) {
    console.error('메시지 로드 실패:', e);
    messagesEl.innerHTML = '<div style="text-align:center;padding:40px;color:#dc2626;font-size:13px;">메시지 불러오기 실패: ' + escapeHtml(e.message) + '</div>';
  }
}
threadSearchEl.addEventListener('input', (e) => { state.searchQuery = e.target.value; renderThreadList(); });

// 메시지 렌더
function renderMessagesFull() {
  if (state.messages.length === 0) {
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = '';
    return;
  }
  emptyStateEl.style.display = 'none';
  const frag = document.createDocumentFragment();
  for (const m of state.messages) frag.appendChild(buildMessageEl(m));
  messagesEl.innerHTML = '';
  messagesEl.appendChild(frag);
}
function appendMessage(m) {
  emptyStateEl.style.display = 'none';
  if (emptyStateEl.parentElement === messagesEl) messagesEl.removeChild(emptyStateEl);
  messagesEl.appendChild(buildMessageEl(m));
}
function buildMessageEl(m) {
  const isUser = m.role === 'user';
  const isAI = m.role === 'ai' || m.role === 'assistant';
  const wrap = document.createElement('div');
  wrap.className = isUser ? 'msg msg-user' : 'msg msg-ai';
  wrap.dataset.id = m.id || '';
  // 액션 버튼 (호버 시 표시): 복사 / 편집(user) / 재생성(ai)
  const actionsHtml =
    '<div class="msg-actions">' +
      '<button class="msg-action-btn" data-act="copy" title="복사"><span class="material-symbols-outlined">content_copy</span></button>' +
      (isUser
        ? '<button class="msg-action-btn" data-act="edit" title="편집"><span class="material-symbols-outlined">edit</span></button>'
        : '<button class="msg-action-btn" data-act="regenerate" title="재생성"><span class="material-symbols-outlined">refresh</span></button>'
      ) +
    '</div>';
  wrap.innerHTML =
    '<div class="msg-avatar"><span class="material-symbols-outlined">' + (isUser ? 'person' : 'smart_toy') + '</span></div>' +
    '<div class="msg-body">' +
      '<div class="msg-name">' + (isUser ? '나' : 'AI') + (m.createdAt ? '<span class="msg-time">' + escapeHtml(formatRelativeTime(m.createdAt)) + '</span>' : '') + '</div>' +
      '<div class="msg-content"></div>' +
      '<div class="msg-attachments-wrap"></div>' +
      '<div class="msg-artifacts-wrap"></div>' +
    '</div>' + actionsHtml;
  const contentEl = wrap.querySelector('.msg-content');
  if (isAI) {
    contentEl.innerHTML = md(m.content) + (m.streaming ? '<span class="typing-cursor"></span>' : '');
    if (m.image_url) {
      const img = document.createElement('img');
      img.className = 'artifact-img';
      img.src = m.image_url;
      img.alt = '생성된 이미지';
      contentEl.appendChild(img);
    }
  } else {
    contentEl.innerHTML = '<p>' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>';
  }
  if (Array.isArray(m.attachments) && m.attachments.length > 0) {
    const aw = wrap.querySelector('.msg-attachments-wrap');
    aw.className += ' msg-attachments';
    for (const a of m.attachments) {
      const chip = document.createElement('span');
      chip.className = 'msg-attachment';
      chip.innerHTML = '<span class="material-symbols-outlined">' + attachKindIcon(a.kind) + '</span>' + escapeHtml(a.originalName || a.original_name || '파일');
      aw.appendChild(chip);
    }
  }
  if (Array.isArray(m.artifacts) && m.artifacts.length > 0) {
    const aw = wrap.querySelector('.msg-artifacts-wrap');
    aw.className += ' artifacts-grid';
    for (const art of m.artifacts) aw.appendChild(buildArtifactEl(art));
  }
  return wrap;
}
function buildArtifactEl(art) {
  const div = document.createElement('div');
  div.className = 'artifact-card';
  const isImg = (art.kind === 'image') || /^image\//.test(art.mime || '');
  const iconName = isImg ? 'image' : (art.kind === 'excel' ? 'table_chart' : (art.kind === 'pdf' ? 'picture_as_pdf' : (art.kind === 'svg' ? 'shapes' : 'description')));
  const dlUrl = art.id ? '/api/ai/artifacts/' + art.id + '/download' : (art.url || '#');
  const filename = escapeHtml(art.filename || art.original_name || '파일');
  // HTML/SVG 는 "새 창 열기" 도 추가 (인터랙티브)
  const canOpenInNewTab = art.id && (art.kind === 'html' || art.kind === 'svg');
  const inlineUrl = art.id ? '/api/ai/artifacts/' + art.id + '/download?inline=1' : null;
  div.innerHTML =
    '<div class="artifact-icon"><span class="material-symbols-outlined">' + iconName + '</span></div>' +
    '<div class="artifact-info">' +
      '<div class="artifact-name">' + filename + '</div>' +
      '<div class="artifact-meta">' + (art.kind || '') + (art.size ? ' · ' + formatBytes(art.size) : '') + '</div>' +
      '<div class="artifact-actions">' +
        '<a href="' + dlUrl + '" class="artifact-btn" download><span class="material-symbols-outlined">download</span>다운로드</a>' +
        (art.id ? '<button class="artifact-btn" data-preview-id="' + art.id + '" data-preview-kind="' + (art.kind || '') + '" data-preview-name="' + filename + '"><span class="material-symbols-outlined">visibility</span>미리보기</button>' : '') +
        (canOpenInNewTab ? '<a href="' + inlineUrl + '" target="_blank" rel="noopener noreferrer" class="artifact-btn" title="새 탭에서 풀화면 실행"><span class="material-symbols-outlined">open_in_new</span>새 창</a>' : '') +
      '</div>' +
    '</div>';
  return div;
}
function attachKindIcon(kind) {
  if (kind === 'image') return 'image';
  if (kind === 'excel') return 'table_chart';
  if (kind === 'pdf') return 'picture_as_pdf';
  if (kind === 'word') return 'description';
  if (kind === 'svg') return 'shapes';
  return 'attach_file';
}
function updateLastAIContent(text, isStreaming) {
  const last = messagesEl.lastElementChild;
  if (!last || !last.classList.contains('msg-ai')) return;
  const c = last.querySelector('.msg-content');
  if (!c) return;
  c.innerHTML = md(text) + (isStreaming ? '<span class="typing-cursor"></span>' : '');
}
// 사용자가 스크롤을 위로 올렸으면 자동 스크롤 안 함
state.atBottom = true;
messagesEl.addEventListener('scroll', () => {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  state.atBottom = nearBottom;
  const btn = document.getElementById('scrolltoBottomBtn');
  if (btn) btn.classList.toggle('visible', !nearBottom && state.messages.length > 0);
});
function scrollToBottom(force) {
  if (!force && !state.atBottom) return;
  requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; state.atBottom = true; });
}
// 맨 아래 버튼
const _scrollBtn = document.getElementById('scrolltoBottomBtn');
if (_scrollBtn) _scrollBtn.addEventListener('click', () => scrollToBottom(true));

// 시각 표시
function formatRelativeTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return '방금';
  if (diff < 3600) return Math.floor(diff/60) + '분 전';
  if (diff < 86400) return Math.floor(diff/3600) + '시간 전';
  if (diff < 86400 * 7) return Math.floor(diff/86400) + '일 전';
  return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
}

// 미리보기 모달
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preview-id]');
  if (!btn) return;
  openPreview(btn.dataset.previewId, btn.dataset.previewKind, btn.dataset.previewName);
});
previewClose.addEventListener('click', () => previewModalBg.classList.remove('visible'));
previewModalBg.addEventListener('click', (e) => {
  if (e.target === previewModalBg) previewModalBg.classList.remove('visible');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') previewModalBg.classList.remove('visible');
});
async function openPreview(id, kind, name) {
  previewTitle.textContent = name || '미리보기';
  previewBody.innerHTML = '<div class="preview-loading">불러오는 중…</div>';
  previewDownload.href = '/api/ai/artifacts/' + id + '/download';
  previewModalBg.classList.add('visible');
  const inlineUrl = '/api/ai/artifacts/' + id + '/download?inline=1';
  if (kind === 'image' || /^image\//.test(kind || '')) {
    previewBody.innerHTML = '<img src="' + inlineUrl + '" alt="">';
    return;
  }
  if (kind === 'pdf') {
    previewBody.innerHTML = '<iframe src="' + inlineUrl + '"></iframe>';
    return;
  }
  try {
    const r = await fetch('/api/ai/artifacts/' + id + '/preview', { credentials: 'include' });
    if (!r.ok) throw new Error('preview ' + r.status);
    const data = await r.json();
    if (data.kind === 'excel' || (Array.isArray(data.sheets) && data.sheets.length)) {
      renderExcelPreview(data.sheets);
    } else if (data.kind === 'svg' && data.content) {
      // SVG: 인터랙티브 가능. sandbox iframe 으로 격리 실행 (script 허용, same-origin 차단)
      renderSandboxedHtml(data.content, true);
    } else if ((data.kind === 'html' || kind === 'html') && data.content !== undefined) {
      // HTML: 진짜 인터랙티브 아티팩트. sandbox iframe.
      renderSandboxedHtml(data.content, false);
    } else if (data.content !== undefined) {
      if (kind === 'markdown') {
        previewBody.innerHTML = '<div style="background:#fff;padding:24px;border-radius:8px;">' + md(data.content) + '</div>';
      } else {
        previewBody.innerHTML = '<pre>' + escapeHtml(data.content) + '</pre>';
      }
    } else if (data.previewUrl) {
      previewBody.innerHTML = '<iframe src="' + data.previewUrl + '"></iframe>';
    } else {
      previewBody.innerHTML = '<div class="preview-loading">미리보기를 지원하지 않는 파일입니다. 다운로드 버튼으로 받아주세요.</div>';
    }
  } catch (e) {
    console.error('preview 실패:', e);
    previewBody.innerHTML = '<div class="preview-loading" style="color:#dc2626;">미리보기 실패: ' + escapeHtml(e.message) + '</div>';
  }
}

// 안전한 sandbox iframe 으로 HTML/SVG 콘텐츠 실행
// sandbox="allow-scripts" 만 — same-origin 없으니 부모 DOM·쿠키·ERP API 접근 불가
function renderSandboxedHtml(content, isSvg) {
  let html = String(content);
  if (isSvg) {
    // SVG 면 통째로 감싸기
    html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:20px;background:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;}svg{max-width:100%;max-height:90vh;}</style></head><body>' + html + '</body></html>';
  } else if (!/<!doctype|<html/i.test(html)) {
    // HTML 조각이면 <html><body> 로 감싸기
    html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>body{margin:0;padding:16px;font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;}</style></head><body>' + html + '</body></html>';
  }
  // srcdoc 으로 iframe 안에 직접 삽입 (URL 안 거침)
  previewBody.innerHTML =
    '<div style="background:#fff;border-radius:8px;overflow:hidden;height:78vh;">' +
    '<iframe sandbox="allow-scripts" srcdoc="' + html.replace(/"/g, '&quot;') + '" style="width:100%;height:100%;border:none;"></iframe>' +
    '</div>' +
    '<div style="font-size:11px;color:#9ca3af;margin-top:6px;text-align:center;">⚠ 격리 실행 — 이 미리보기는 ERP 데이터에 접근할 수 없어요</div>';
}
function renderExcelPreview(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    previewBody.innerHTML = '<div class="preview-loading">시트 없음</div>';
    return;
  }
  let html = '';
  if (sheets.length > 1) {
    html += '<div class="preview-sheets-tabs">' + sheets.map((s, i) => '<button class="preview-sheet-tab' + (i === 0 ? ' active' : '') + '" data-sheet-idx="' + i + '">' + escapeHtml(s.name || ('Sheet ' + (i+1))) + '</button>').join('') + '</div>';
  }
  html += '<div id="previewSheetWrap">' + renderSheetTable(sheets[0]) + '</div>';
  previewBody.innerHTML = html;
  if (sheets.length > 1) {
    previewBody.querySelectorAll('.preview-sheet-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const idx = parseInt(tab.dataset.sheetIdx);
        previewBody.querySelectorAll('.preview-sheet-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('previewSheetWrap').innerHTML = renderSheetTable(sheets[idx]);
      });
    });
  }
}
function renderSheetTable(sheet) {
  const rows = sheet.rows || [];
  if (rows.length === 0) return '<div class="preview-loading">빈 시트</div>';
  let html = '<div style="overflow:auto;max-height:70vh;"><table class="preview-sheet-table">';
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const Tag = r === 0 ? 'th' : 'td';
    html += '<tr>';
    for (const cell of row) html += '<' + Tag + '>' + escapeHtml(cell == null ? '' : String(cell)) + '</' + Tag + '>';
    html += '</tr>';
  }
  html += '</table></div>';
  return html;
}

// 첨부
function renderAttachments() {
  if (state.attachments.length === 0) { attachmentsRowEl.innerHTML = ''; updateSendBtn(); return; }
  let html = '';
  for (let i = 0; i < state.attachments.length; i++) {
    const a = state.attachments[i];
    const name = escapeHtml(a.originalName || a.name || '파일');
    const size = a.size ? '<span class="att-chip-size">' + formatBytes(a.size) + '</span>' : '';
    const thumb = (a.kind === 'image' && a.id)
      ? '<div class="att-chip-thumb"><img src="/api/ai/attachments/' + a.id + '/raw" alt=""></div>'
      : '<div class="att-chip-thumb"><span class="material-symbols-outlined">' + attachKindIcon(a.kind) + '</span></div>';
    const rm = a.uploading ? '' : '<span class="att-chip-remove" data-idx="' + i + '"><span class="material-symbols-outlined">close</span></span>';
    html += '<div class="att-chip ' + (a.uploading ? 'uploading' : '') + '">' + thumb + '<span class="att-chip-name">' + name + '</span>' + size + rm + '</div>';
  }
  attachmentsRowEl.innerHTML = html;
  updateSendBtn();
}
attachmentsRowEl.addEventListener('click', (e) => {
  const rm = e.target.closest('.att-chip-remove');
  if (rm) {
    const idx = parseInt(rm.dataset.idx);
    const a = state.attachments[idx];
    if (a && a.id) fetch('/api/ai/attachments/' + a.id, { method: 'DELETE', credentials: 'include' }).catch(()=>{});
    state.attachments.splice(idx, 1);
    renderAttachments();
  }
});
async function uploadFile(file) {
  const ph = { id: null, originalName: file.name, name: file.name, size: file.size, mime: file.type, kind: guessKindFromFile(file), uploading: true, _tmp: 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) };
  state.attachments.push(ph);
  renderAttachments();
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/ai/attachments', { method: 'POST', credentials: 'include', body: fd });
    if (r.status === 401) { window.location.href = '/'; return; }
    if (!r.ok) throw new Error('업로드 실패 ' + r.status);
    const data = await r.json();
    const idx = state.attachments.findIndex(a => a._tmp === ph._tmp);
    if (idx !== -1 && data.attachment) {
      state.attachments[idx] = {
        id: data.attachment.id,
        originalName: data.attachment.originalName || data.attachment.original_name || file.name,
        name: data.attachment.originalName || file.name,
        size: data.attachment.size || file.size,
        mime: data.attachment.mime || file.type,
        kind: data.attachment.kind || ph.kind,
      };
      renderAttachments();
    }
  } catch (e) {
    console.error('업로드 실패:', e);
    alert('파일 업로드 실패 (' + file.name + '): ' + e.message);
    const idx = state.attachments.findIndex(a => a._tmp === ph._tmp);
    if (idx !== -1) state.attachments.splice(idx, 1);
    renderAttachments();
  }
}
function guessKindFromFile(file) {
  const n = (file.name || '').toLowerCase();
  if ((file.type || '').startsWith('image/')) return 'image';
  if (n.match(/\.(xlsx|xls|csv)$/)) return 'excel';
  if (n.endsWith('.pdf')) return 'pdf';
  if (n.match(/\.(docx|doc)$/)) return 'word';
  return 'text';
}
attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  Array.from(e.target.files || []).forEach(uploadFile);
  fileInput.value = '';
});

// 드래그·드롭
let dragCounter = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault(); dragCounter++; dropOverlay.classList.add('visible');
});
window.addEventListener('dragover', (e) => { if (e.dataTransfer && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dropOverlay.classList.remove('visible'); } });
window.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
  e.preventDefault(); dragCounter = 0; dropOverlay.classList.remove('visible');
  Array.from(e.dataTransfer.files).forEach(uploadFile);
});
input.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  Array.from(e.clipboardData.items || []).forEach(item => {
    if (item.kind === 'file') { const f = item.getAsFile(); if (f) uploadFile(f); }
  });
});

// /chat fallback
async function sendViaChatFallback(text, attachmentIds, aiMsg) {
  try {
    aiMsg.content = '답변 준비 중이에요…';
    updateLastAIContent(aiMsg.content, true);
    const r = await fetch('/api/ai/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ prompt: text || '(첨부파일 분석)', threadId: state.activeThreadId || undefined, attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined, model: state.modelId }),
    });
    if (r.status === 401) { window.location.href = '/'; return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('chat ' + r.status));
    aiMsg.streaming = false;
    aiMsg.content = data.result || (data.message && data.message.content) || '(빈 응답)';
    aiMsg.id = (data.message && data.message.id) || aiMsg.id;
    aiMsg.artifacts = data.artifacts || [];
    messagesEl.removeChild(messagesEl.lastElementChild);
    appendMessage(aiMsg);
    scrollToBottom();
    if (data.threadId && !state.activeThreadId) {
      state.activeThreadId = data.threadId;
      await loadThreads();
      const t = state.threads.find(x => String(x.id) === String(data.threadId));
      if (t) topbarTitleEl.textContent = t.title || '제목 없음';
    } else if (state.activeThreadId) { loadThreads(); }
  } catch (e) {
    console.error('fallback chat 실패:', e);
    aiMsg.streaming = false;
    aiMsg.content = '**오류:** ' + e.message;
    updateLastAIContent(aiMsg.content, false);
  } finally {
    setStreaming(false); input.disabled = false; autoResize(); input.focus();
  }
}

// 전송
async function sendMessage() {
  const text = input.value.trim();
  const readyAtts = state.attachments.filter(a => !a.uploading && a.id);
  if (!text && readyAtts.length === 0 && !state.imageMode) return;
  if (state.imageMode && !text) { alert('이미지 설명을 입력해주세요.'); return; }
  if (state.streaming) return;

  state.abortController = new AbortController(); setStreaming(true);
  updateSendBtn();
  input.disabled = true;

  const userMsg = {
    role: 'user', content: text || (state.imageMode ? '' : '(첨부파일 분석)'),
    id: 'tmp_u_' + Date.now(),
    attachments: readyAtts.map(a => ({ ...a })),
  };
  state.messages.push(userMsg);
  appendMessage(userMsg);

  const aiMsg = { role: 'ai', content: state.imageMode ? '이미지 생성 중… (10~30초 소요)' : '', streaming: true, id: 'tmp_a_' + Date.now() };
  state.messages.push(aiMsg);
  appendMessage(aiMsg);
  scrollToBottom();

  input.value = '';
  autoResize();
  const attachmentIds = readyAtts.map(a => a.id);
  state.attachments = [];
  renderAttachments();

  if (state.imageMode) {
    try {
      const r = await fetch('/api/ai/chat-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        signal: state.abortController.signal,
        body: JSON.stringify({ prompt: text, threadId: state.activeThreadId || undefined }),
      });
      if (r.status === 401) { window.location.href = '/'; return; }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('chat-image ' + r.status));
      aiMsg.streaming = false;
      aiMsg.content = data.text || (data.message && data.message.content) || '이미지가 생성되었습니다.';
      aiMsg.image_url = data.url || data.image_url || data.imageUrl || (data.message && (data.message.image_url || data.message.imageUrl)) || null;
      aiMsg.artifacts = data.artifacts || [];
      console.log('[ai-chat] chat-image:', { url: data.url, image_url: aiMsg.image_url });
      messagesEl.removeChild(messagesEl.lastElementChild);
      appendMessage(aiMsg);
      scrollToBottom();
      if (data.threadId && !state.activeThreadId) {
        state.activeThreadId = data.threadId;
        await loadThreads();
      } else { loadThreads(); }
      loadUsage();
      state.imageMode = false;
      imageModeBtn.classList.remove('active');
      composerEl.classList.remove('image-mode');
      composerHint.textContent = 'Enter 로 전송 · Shift+Enter 줄바꿈 · 파일을 끌어다 놓을 수 있어요';
      usagePill.style.display = 'none';
      input.placeholder = '무엇이든 물어보세요. 파일은 드래그하거나 📎로 첨부.';
    } catch (e) {
      console.error('이미지 생성 실패:', e);
      aiMsg.streaming = false;
      aiMsg.content = '**오류:** ' + e.message;
      messagesEl.removeChild(messagesEl.lastElementChild);
      appendMessage(aiMsg);
    } finally {
      setStreaming(false); input.disabled = false; autoResize(); input.focus();
    }
    return;
  }

  // 환경에 따라 endpoint 선택: API key 있으면 /chat-stream, 없으면 /chat-stream-cli (CLI 스트리밍)
  const streamEndpoint = state.apiKeyAvailable === false ? '/api/ai/chat-stream-cli' : '/api/ai/chat-stream';
  try {
    const r = await fetch(streamEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      signal: state.abortController.signal,
      body: JSON.stringify({ prompt: text || '(첨부파일 분석)', threadId: state.activeThreadId || undefined, attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined, model: state.modelId }),
    });
    if (r.status === 401) { window.location.href = '/'; return; }
    if (r.status === 503) {
      state.apiKeyAvailable = false;
      await sendViaChatFallback(text, attachmentIds, aiMsg);
      return;
    }
    if (!r.ok) throw new Error('chat-stream ' + r.status);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let newThreadId = null;
    let lastRender = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n'); buffer = events.pop();
      for (const evt of events) {
        const lines = evt.split('\n');
        let eventName = '', dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataStr += line.slice(6);
        }
        if (!dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          if (eventName === 'start') newThreadId = data.threadId;
          else if (eventName === 'delta') {
            aiMsg.content += data.text || '';
            const now = Date.now();
            if (now - lastRender > 16) {
              updateLastAIContent(aiMsg.content, true);
              scrollToBottom();
              lastRender = now;
            }
          } else if (eventName === 'done') {
            aiMsg.streaming = false;
            aiMsg.id = data.messageId || aiMsg.id;
            // CLI 스트리밍이 보내준 artifacts 가 있으면 카드 표시
            if (Array.isArray(data.artifacts) && data.artifacts.length > 0) {
              aiMsg.artifacts = data.artifacts;
              messagesEl.removeChild(messagesEl.lastElementChild);
              appendMessage(aiMsg);
              scrollToBottom();
            } else {
              updateLastAIContent(aiMsg.content, false);
            }
          } else if (eventName === 'error') {
            aiMsg.streaming = false;
            aiMsg.content += '\n\n**오류:** ' + (data.error || '알 수 없는 오류');
            updateLastAIContent(aiMsg.content, false);
          }
        } catch (e) { console.warn('SSE parse:', e); }
      }
    }
    updateLastAIContent(aiMsg.content, false);
    if (newThreadId && !state.activeThreadId) {
      state.activeThreadId = newThreadId;
      await loadThreads();
      const t = state.threads.find(x => String(x.id) === String(newThreadId));
      if (t) topbarTitleEl.textContent = t.title || '제목 없음';
    } else if (state.activeThreadId) {
      loadThreads();
    }
  } catch (e) {
    console.error('전송 실패:', e);
    aiMsg.streaming = false;
    aiMsg.content = '**오류:** ' + e.message;
       updateLastAIContent(aiMsg.content, false);
  } finally {
    setStreaming(false); input.disabled = false; autoResize(); input.focus();
  }
}

// ═══ 추가 기능 — Phase 6 마무리 ═══
const sidebarEl = document.querySelector('.sidebar');
const hamburgerBtn = document.getElementById('hamburgerBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => sidebarEl.classList.toggle('open'));
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => sidebarEl.classList.remove('open'));
threadListEl.addEventListener('click', (e) => {
  if (e.target.closest('.thread-item') && window.innerWidth <= 768) sidebarEl.classList.remove('open');
});

// 중단 버튼
const stopBtn = document.getElementById('stopBtn');
state.abortController = null;
stopBtn.addEventListener('click', () => {
  if (state.abortController) { state.abortController.abort(); console.log('[ai-chat] 사용자 중단'); }
});
function setStreaming(on) {
  state.streaming = on;
  if (on) { sendBtn.style.display = 'none'; stopBtn.style.display = 'inline-flex'; }
  else { sendBtn.style.display = ''; stopBtn.style.display = 'none'; state.abortController = null; }
  updateSendBtn();
}

// 스레드 컨텍스트 메뉴
let ctxMenuEl = null;
function closeCtxMenu() { if (ctxMenuEl) { ctxMenuEl.remove(); ctxMenuEl = null; } }
document.addEventListener('click', (e) => { if (ctxMenuEl && !ctxMenuEl.contains(e.target)) closeCtxMenu(); });
function openCtxMenu(x, y, threadId) {
  closeCtxMenu();
  const m = document.createElement('div');
  m.className = 'thread-context-menu';
  m.innerHTML = '<button data-act="rename"><span class="material-symbols-outlined">edit</span>이름 변경</button><button data-act="delete" class="danger"><span class="material-symbols-outlined">delete</span>삭제</button>';
  m.style.left = x + 'px'; m.style.top = y + 'px';
  document.body.appendChild(m); ctxMenuEl = m;
  m.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    closeCtxMenu();
    const t = state.threads.find(x => String(x.id) === String(threadId));
    if (!t) return;
    if (btn.dataset.act === 'rename') openRenameModal(t);
    else if (btn.dataset.act === 'delete') deleteThread(t);
  });
}

// renderThreadList wrap — ⋮ 버튼 + 핸들러 추가
const _origRenderThreadList = renderThreadList;
renderThreadList = function() {
  _origRenderThreadList();
  threadListEl.querySelectorAll('.thread-item').forEach(item => {
    if (item.querySelector('.thread-item-menu-btn')) return;
    const id = item.dataset.id;
    if (!id) return;
    const btn = document.createElement('button');
    btn.className = 'thread-item-menu-btn';
    btn.innerHTML = '<span class="material-symbols-outlined">more_vert</span>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      openCtxMenu(rect.right - 140, rect.bottom + 4, id);
    });
    item.appendChild(btn);
  });
};

// 이름 변경 모달
const renameModalBg = document.getElementById('renameModalBg');
const renameInput = document.getElementById('renameInput');
const renameCancel = document.getElementById('renameCancel');
const renameOk = document.getElementById('renameOk');
let _renamingThread = null;
function openRenameModal(t) {
  _renamingThread = t;
  renameInput.value = t.title || '';
  renameModalBg.classList.add('visible');
  setTimeout(() => { renameInput.focus(); renameInput.select(); }, 50);
}
function closeRenameModal() { renameModalBg.classList.remove('visible'); _renamingThread = null; }
renameCancel.addEventListener('click', closeRenameModal);
renameModalBg.addEventListener('click', (e) => { if (e.target === renameModalBg) closeRenameModal(); });
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') renameOk.click();
  else if (e.key === 'Escape') closeRenameModal();
});
renameOk.addEventListener('click', async () => {
  if (!_renamingThread) return;
  const newTitle = renameInput.value.trim();
  if (!newTitle) { renameInput.focus(); return; }
  try {
    const r = await fetch('/api/ai/threads/' + _renamingThread.id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ title: newTitle }),
    });
    if (!r.ok) throw new Error('rename ' + r.status);
    _renamingThread.title = newTitle;
    if (String(state.activeThreadId) === String(_renamingThread.id)) topbarTitleEl.textContent = newTitle;
    renderThreadList();
    closeRenameModal();
  } catch (e) { alert('이름 변경 실패: ' + e.message); }
});

async function deleteThread(t) {
  if (!confirm((t.title || '제목 없음') + ' — 이 대화를 삭제할까요? 메시지와 파일이 모두 삭제됩니다.')) return;
  try {
    const r = await fetch('/api/ai/threads/' + t.id, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error('delete ' + r.status);
    state.threads = state.threads.filter(x => String(x.id) !== String(t.id));
    if (String(state.activeThreadId) === String(t.id)) {
      state.activeThreadId = null;
      state.messages = [];
      topbarTitleEl.textContent = '새 대화';
      renderMessagesFull();
    }
    renderThreadList();
  } catch (e) { alert('삭제 실패: ' + e.message); }
}

// ═══ 메시지 액션 — 복사 / 편집 / 재생성 ═══
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.msg-action-btn');
  if (!btn) return;
  const msgEl = btn.closest('.msg');
  if (!msgEl) return;
  const msgId = msgEl.dataset.id;
  const msg = state.messages.find(m => String(m.id) === String(msgId));
  if (!msg) return;
  const act = btn.dataset.act;
  if (act === 'copy') copyMessage(msg, btn);
  else if (act === 'edit') editMessage(msg, msgEl);
  else if (act === 'regenerate') regenerateMessage(msg);
});

async function copyMessage(msg, btn) {
  try {
    await navigator.clipboard.writeText(msg.content || '');
    btn.classList.add('copied');
    btn.querySelector('.material-symbols-outlined').textContent = 'check';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('.material-symbols-outlined').textContent = 'content_copy';
    }, 1200);
  } catch (e) { alert('복사 실패: ' + e.message); }
}

function editMessage(msg, msgEl) {
  if (state.streaming) return;
  const contentEl = msgEl.querySelector('.msg-content');
  const oldContent = msg.content || '';
  contentEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'msg-edit-area';
  wrap.innerHTML =
    '<textarea class="msg-edit-input">' + escapeHtml(oldContent) + '</textarea>' +
    '<div class="msg-edit-actions">' +
      '<button class="msg-edit-save">저장하고 다시 보내기</button>' +
      '<button class="msg-edit-cancel">취소</button>' +
    '</div>';
  contentEl.appendChild(wrap);
  const ta = wrap.querySelector('textarea');
  ta.focus();
  ta.style.height = Math.max(80, ta.scrollHeight) + 'px';
  wrap.querySelector('.msg-edit-cancel').addEventListener('click', () => {
    contentEl.innerHTML = '<p>' + escapeHtml(oldContent).replace(/\n/g, '<br>') + '</p>';
  });
  wrap.querySelector('.msg-edit-save').addEventListener('click', () => {
    const newText = ta.value.trim();
    if (!newText) return;
    const idx = state.messages.findIndex(m => String(m.id) === String(msg.id));
    if (idx === -1) return;
    state.messages = state.messages.slice(0, idx);
    renderMessagesFull();
    input.value = newText;
    autoResize();
    sendMessage();
  });
}

function regenerateMessage(aiMsg) {
  if (state.streaming) return;
  const idx = state.messages.findIndex(m => String(m.id) === String(aiMsg.id));
  if (idx < 1) return;
  const prevUser = state.messages[idx - 1];
  if (!prevUser || prevUser.role !== 'user') return;
  const userText = prevUser.content;
  state.messages = state.messages.slice(0, idx - 1);
  renderMessagesFull();
  input.value = userText;
  autoResize();
  sendMessage();
}

// ═══ 음성 입력 ═══
const micBtn = document.getElementById('micBtn');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR && micBtn) {
  micBtn.style.display = '';
  let recognition = null;
  let isRecording = false;
  micBtn.addEventListener('click', () => {
    if (isRecording) { if (recognition) recognition.stop(); return; }
    recognition = new SR();
    recognition.lang = 'ko-KR';
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = '';
    let interimText = '';
    const baseValue = input.value;
    recognition.onstart = () => {
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.title = '음성 입력 중. 다시 누르면 종료';
    };
    recognition.onresult = (e) => {
      interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      input.value = (baseValue ? baseValue + ' ' : '') + (finalText + interimText).trim();
      autoResize();
    };
    recognition.onerror = (e) => { console.warn('mic err:', e.error); };
    recognition.onend = () => {
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.title = '음성 입력';
      input.focus();
    };
    try { recognition.start(); }
    catch (e) { isRecording = false; micBtn.classList.remove('recording'); }
  });
}

// ═══ 즐겨찾기 (핀) ═══
state.pinnedIds = new Set(JSON.parse(localStorage.getItem('ai_chat_pinned') || '[]'));
function isPinned(id) { return state.pinnedIds.has(String(id)); }
function togglePin(id) {
  const sid = String(id);
  if (state.pinnedIds.has(sid)) state.pinnedIds.delete(sid);
  else state.pinnedIds.add(sid);
  localStorage.setItem('ai_chat_pinned', JSON.stringify([...state.pinnedIds]));
  renderThreadList();
}

// renderThreadList 한 번 더 wrap — 핀 그룹 + 핀 버튼 추가
const _origRenderThreadList2 = renderThreadList;
renderThreadList = function() {
  // 핀 분리
  const pinned = state.threads.filter(t => isPinned(t.id));
  const rest = state.threads.filter(t => !isPinned(t.id));
  // 핀이 있으면 사이드바 맨 위에 별도 그룹으로 표시
  if (pinned.length > 0) {
    // 임시로 state.threads 를 rest 만으로 줄여서 호출
    const allBefore = state.threads;
    state.threads = rest;
    _origRenderThreadList2();
    state.threads = allBefore;
    // 핀 그룹을 사이드바 맨 위에 prepend
    const pinHtml = '<div class="thread-group-label">⭐ 즐겨찾기</div>' + pinned.map(t => {
      const isActive = String(state.activeThreadId) === String(t.id);
      const title = escapeHtml(t.title || '제목 없음');
      const icon = t.project_emoji ? '<span style="font-size:12px;flex-shrink:0;">' + t.project_emoji + '</span>' : '<span class="material-symbols-outlined">chat_bubble</span>';
      return '<div class="thread-item ' + (isActive ? 'active' : '') + '" data-id="' + t.id + '" title="' + title + '">' + icon + '<span class="thread-item-title">' + title + '</span></div>';
    }).join('');
    const wrap = document.createElement('div');
    wrap.innerHTML = pinHtml;
    while (wrap.firstChild) threadListEl.insertBefore(wrap.firstChild, threadListEl.firstChild);
  } else {
    _origRenderThreadList2();
  }
  // 각 thread-item 에 핀 버튼 추가
  threadListEl.querySelectorAll('.thread-item').forEach(item => {
    if (item.querySelector('.pin-btn')) return;
    const id = item.dataset.id;
    if (!id) return;
    const pin = document.createElement('button');
    pin.className = 'pin-btn' + (isPinned(id) ? ' active' : '');
    pin.innerHTML = '<span class="material-symbols-outlined">push_pin</span>';
    pin.title = isPinned(id) ? '즐겨찾기 해제' : '즐겨찾기 추가';
    pin.addEventListener('click', (e) => { e.stopPropagation(); togglePin(id); });
    item.appendChild(pin);
  });
};

// ═══ 프로젝트 UI ═══
state.projects = [];
state.activeProjectId = null;
const projectListEl = document.getElementById('projectList');
const projectSectionHeader = document.getElementById('projectSectionHeader');
const projectChevron = document.getElementById('projectChevron');
const newProjectBtn = document.getElementById('newProjectBtn');
state.projectExpanded = localStorage.getItem('ai_chat_proj_open') !== '0';

function applyProjectExpanded() {
  projectListEl.style.display = state.projectExpanded ? '' : 'none';
  newProjectBtn.style.display = state.projectExpanded ? '' : 'none';
  projectChevron.textContent = state.projectExpanded ? 'expand_more' : 'chevron_right';
}
applyProjectExpanded();
projectSectionHeader.addEventListener('click', () => {
  state.projectExpanded = !state.projectExpanded;
  localStorage.setItem('ai_chat_proj_open', state.projectExpanded ? '1' : '0');
  applyProjectExpanded();
});

async function loadProjects() {
  try {
    const r = await fetch('/api/ai/projects', { credentials: 'include' });
    if (!r.ok) return;
    const data = await r.json();
    state.projects = data.projects || [];
    renderProjects();
  } catch (e) { console.warn('projects load:', e.message); }
}

function renderProjects() {
  if (state.projects.length === 0) {
    projectListEl.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:#9ca3af;">아직 없어요</div>';
    return;
  }
  let html = '';
  html += '<div class="project-item' + (state.activeProjectId === null ? ' active' : '') + '" data-pid="">' +
    '<span class="project-item-emoji">💬</span>' +
    '<span class="project-item-name">전체 대화</span>' +
    '</div>';
  for (const p of state.projects) {
    const isActive = String(state.activeProjectId) === String(p.id);
    const emoji = p.emoji || '📁';
    const name = escapeHtml(p.name || '이름 없음');
    const cnt = p.thread_count ? '<span class="project-item-count">' + p.thread_count + '</span>' : '';
    html += '<div class="project-item' + (isActive ? ' active' : '') + '" data-pid="' + p.id + '" title="' + name + '">' +
      '<span class="project-item-emoji">' + emoji + '</span>' +
      '<span class="project-item-name">' + name + '</span>' + cnt + '</div>';
  }
  projectListEl.innerHTML = html;
}
projectListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.project-item');
  if (!item) return;
  const pid = item.dataset.pid;
  state.activeProjectId = pid ? parseInt(pid, 10) : null;
  renderProjects();
  loadThreadsByProject();
});

async function loadThreadsByProject() {
  try {
    const url = state.activeProjectId
      ? '/api/ai/threads?scope=mine&limit=100&project=' + state.activeProjectId
      : '/api/ai/threads?scope=mine&limit=100';
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('threads ' + r.status);
    const data = await r.json();
    state.threads = data.threads || [];
    renderThreadList();
  } catch (e) { console.error('스레드 재로드 실패:', e); }
}

newProjectBtn.addEventListener('click', async () => {
  const name = prompt('새 프로젝트 이름:');
  if (!name || !name.trim()) return;
  const emoji = prompt('이모지 (선택, 빈칸 가능):', '📁') || '📁';
  try {
    const r = await fetch('/api/ai/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ name: name.trim(), emoji: emoji.trim() }),
    });
    if (!r.ok) throw new Error('create ' + r.status);
    await loadProjects();
  } catch (e) { alert('프로젝트 생성 실패: ' + e.message); }
});

// embed 모드 감지 (ERP 메인 탭 안에서 iframe 으로 띄워진 경우)
const _isEmbedded = (window.parent !== window) || new URLSearchParams(location.search).get('embed') === '1';
if (_isEmbedded) {
  // iframe 안에선 "ERP 메인으로" 버튼 + 사이드바 헤더 일부 숨김
  const backBtn = document.querySelector('.back-btn');
  if (backBtn) backBtn.style.display = 'none';
  const sidebarFooter = document.querySelector('.sidebar-footer');
  if (sidebarFooter) sidebarFooter.style.display = 'none';
  document.body.style.background = '#fff';
}

loadThreads();
loadProjects();
detectApiMode();
