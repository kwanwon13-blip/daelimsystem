// ─── AI 챗 클라이언트 로직 ──────────────────────────────────
const MODELS = [
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', desc: '메인 · 가장 강력 · 복잡한 분석 · 추론' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', desc: '빠르고 똑똑함 · 일반 대화' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', desc: '가장 빠름 · 간단 질문' },
];
const DEFAULT_MODEL_ID = 'claude-opus-4-8';
// 이전 버전 모델 ID 가 저장돼 있으면 (오래된 ID) 무시하고 새 기본값으로
const _saved = localStorage.getItem('ai_chat_model_v2');
const SAVED_MODEL = (_saved && MODELS.find(m => m.id === _saved)) ? _saved : DEFAULT_MODEL_ID;

const state = {
  threads: [], filteredThreads: [], activeThreadId: null, searchQuery: '',
  messages: [], streaming: false, attachments: [],
  streamingByThread: new Set(),
  liveByThread: {},   // threadId(또는 'new') → 생성 중인 ai 메시지 객체 (스레드 전환 후에도 답변 유지)
  attachES: null,     // 진행 중 생성 재연결용 EventSource (새로고침/다른PC 복원)
  userStopped: false, // 사용자가 중단 버튼을 눌렀는지 (abort 오류를 조용히 처리)
  imageMode: false, usage: null,
  modelId: SAVED_MODEL,
  apiKeyAvailable: null,
  // 이미지 picker (이미지 모드 + 핸드오프 공용)
  imageAspect: 'square',   // 'square' | 'wide' | 'tall'
  imageTier: 'normal',     // 'normal' | 'large'
  imageQuality: 'medium',  // 'medium' | 'high'
};

// 비율·크기 → gpt-image-2 size 문자열
function sizeFor() {
  const a = state.imageAspect, t = state.imageTier;
  if (a === 'square') return t === 'large' ? '2048x2048' : '1024x1024';
  if (a === 'wide')   return t === 'large' ? '2048x1152' : '1536x1024';
  /* tall */          return t === 'large' ? '1152x2048' : '1024x1536';
}
// 이미지 의도 감지: 이미지 명사 + 생성 동사 둘다 && 문서/코드/질문 아님.
//   '그림'은 명사 목록에만 둔다(동사 목록에 두면 '그림' 한 단어로 항상 매칭돼 일반 질문까지 가로챔).
//   질문/설명/능력문의("이 그림 설명해줘", "로고 만들 때 주의점 알려줘", "포스터 만들 수 있어?")는 답을 원하는 것이므로 제외.
function isImageIntent(text) {
  const s = String(text || '');
  const imgWords = /(포스터|이미지|그림|일러스트|배너|현수막\s*시안|로고|썸네일|캐릭터)/i;
  const makeWords = /(만들|뽑아|그려|생성|디자인|제작)/i;
  const fileWords = /(svg|html|엑셀|xlsx|csv|pdf|문서|표로|json|마크다운)/i;
  const askWords = /(\?|？|알려|설명|뭐야|뭔지|무엇|어떻게|방법|차이|추천|뜻|의미|왜\s|가능해|수\s*있)/;
  const aboutExisting = /(이|그|저|위|아래|해당|첨부)\s*(그림|이미지|로고|사진|포스터|시안)/;
  if (fileWords.test(s)) return false;
  if (askWords.test(s) || aboutExisting.test(s)) return false;
  return imgWords.test(s) && makeWords.test(s);
}

const $ = (id) => document.getElementById(id);
const input = $('composerInput'), sendBtn = $('sendBtn'), composerEl = $('composer');
const threadListEl = $('threadList'), threadListLoading = $('threadListLoading'), threadSearchEl = $('threadSearch');
const topbarTitleEl = $('topbarTitle'), messagesEl = $('messages'), emptyStateEl = $('emptyState');
const attachmentsRowEl = $('attachmentsRow'), attachBtn = $('attachBtn'), fileInput = $('fileInput');
const dropOverlay = $('dropOverlay'), imageModeBtn = $('imageModeBtn'), composerHint = $('composerHint');
const usagePill = $('usagePill'), usageLabel = $('usageLabel');
const modelBtn = $('modelBtn'), modelMenu = $('modelMenu'), modelLabel = $('modelLabel');
const appEl = $('app');
const previewModalBg = $('previewModalBg'), previewBody = $('previewBody');
const previewTitle = $('previewTitle'), previewClose = $('previewClose'), previewDownload = $('previewDownload');
const previewResizer = $('previewResizer');

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
async function copyTextToClipboard(text) {
  const value = String(text == null ? '' : text);
  const api = typeof navigator !== 'undefined' ? navigator.clipboard : null;
  if (api && typeof api.writeText === 'function') {
    try {
      await api.writeText(value);
      return true;
    } catch (_) {
      // Fall through for HTTP/intranet, iframe, focus, or permission failures.
    }
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
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    return document.execCommand && document.execCommand('copy');
  } finally {
    document.body.removeChild(ta);
  }
}
function shouldUseAgentMode(text, attachmentIds) {
  if (state.imageMode) return false;
  // 이미지 의도면 코드 에이전트로 새지 않게 (핸드오프 경로로 처리)
  if (isImageIntent(text)) return false;
  const s = String(text || '').toLowerCase();
  const hasAttachment = Array.isArray(attachmentIds) && attachmentIds.length > 0;
  // ① 명확한 업무 문서/마감 키워드 — 단독으로도 에이전트 행 (파일 생성이 거의 확실)
  //    퍼시스/하츠/나이스텍 거래명세서·마감·정산 작업이 채팅으로 새서 막히던 문제 방지
  const docWords = /(거래명세서|명세서|마감|정산|원장|견적서|청구서|발주서|세금계산서|매입매출|판매현황|단가표|퍼시스|fursys|하츠|haatz|나이스텍|nicetech|포스코|posco|한신공영|요진건설|홍지이앤씨|삼진비티|선두종합기술|익스테리어앤|한국지오텍|금광스틸)/i;
  if (docWords.test(s)) return true;
  // ② 첨부 파일이 있으면 가공 작업일 확률이 높음 → 에이전트
  if (hasAttachment) return true;
  // ③ 일반 파일 키워드 + 행위 동사 조합
  const fileWords = /(파일|엑셀|xlsx|xls|csv|pdf|ppt|pptx|docx|html|svg|zip|다운로드|저장|생성|만들|작성|정리|분리|나눠|변환|보고서|양식|서식)/i;
  const workWords = /(만들어|만들어줘|생성해|작성해|정리해|분리해|나눠줘|변환해|저장해|다운로드|파일로|엑셀로|pdf로|보고서로|표로)/i;
  return fileWords.test(s) && workWords.test(s);
}
function renderAiMessage(aiMsg) {
  if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains('msg-ai')) {
    messagesEl.removeChild(messagesEl.lastElementChild);
  }
  appendMessage(aiMsg);
  scrollToBottom();
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
  try { localStorage.removeItem('aiTab:lastThreadId'); } catch(_) {}  // 새 대화 → F5 시 빈 화면
  state.messages = []; state.attachments = [];
  renderAttachments();
  topbarTitleEl.textContent = '새 대화';
  renderMessagesFull();
  renderThreadList();
  input.focus();
});

// 등록된 마감 양식(템플릿) 보기/관리
if ($('skillTemplatesBtn')) {
  $('skillTemplatesBtn').addEventListener('click', () => openSkillTemplatesModal());
}
// 회사 기억 보기/관리 (관리자 전용 화면)
if ($('companyMemoryBtn')) {
  $('companyMemoryBtn').addEventListener('click', () => openCompanyMemoryModal());
}

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

// ── 이미지 picker (비율/크기/품질) ──
// 같은 data-* 세그먼트가 composer 와 핸드오프 박스 양쪽에 있을 수 있으므로 모두 동기화한다.
function syncPickerUI() {
  document.querySelectorAll('#segAspect, [data-seg="aspect"]').forEach(seg => {
    seg.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === state.imageAspect));
  });
  document.querySelectorAll('#segTier, [data-seg="tier"]').forEach(seg => {
    seg.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === state.imageTier));
  });
  document.querySelectorAll('#segQuality, [data-seg="quality"]').forEach(seg => {
    seg.querySelectorAll('button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === state.imageQuality));
  });
}
// 세그먼트 클릭 → state 갱신 → 전체 동기화 (이벤트 위임으로 동적 추가된 핸드오프 picker 도 처리)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.img-seg button[data-v]');
  if (!btn) return;
  const seg = btn.closest('.img-seg');
  if (!seg) return;
  const kind = seg.id === 'segAspect' ? 'aspect'
    : seg.id === 'segTier' ? 'tier'
    : seg.id === 'segQuality' ? 'quality'
    : (seg.dataset.seg || '');
  if (kind === 'aspect') state.imageAspect = btn.dataset.v;
  else if (kind === 'tier') state.imageTier = btn.dataset.v;
  else if (kind === 'quality') state.imageQuality = btn.dataset.v;
  else return;
  syncPickerUI();
});
// 핸드오프 박스용 picker 마크업 (composer picker 와 동일한 옵션 — data-seg 로 구분)
function handoffPickerHtml() {
  return '<div class="img-picker-group"><span class="img-picker-label">비율</span>'
    + '<div class="img-seg" data-seg="aspect">'
    + '<button data-v="square">정사각</button><button data-v="wide">가로</button><button data-v="tall">세로</button></div></div>'
    + '<div class="img-picker-group"><span class="img-picker-label">크기</span>'
    + '<div class="img-seg" data-seg="tier"><button data-v="normal">보통</button><button data-v="large">크게</button></div></div>'
    + '<div class="img-picker-group"><span class="img-picker-label">품질</span>'
    + '<div class="img-seg" data-seg="quality"><button data-v="medium">보통</button><button data-v="high">고화질</button></div></div>';
}

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
      state.apiKeyAvailable = data.backend === 'api' || data.backend === 'hermes';
      if (data.backend === 'hermes') {
        const hermesId = data.model || 'hermes-agent';
        if (!MODELS.find(m => m.id === hermesId)) {
          MODELS.unshift({ id: hermesId, label: 'Hermes Agent', desc: 'Hermes API Server · tools + memory' });
        }
        setModel(hermesId);
      }
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
    if (data && data.limit !== undefined) {
      // 기본: 이미지 N/한도. 비용 정보(image)가 오면 오늘/이번달 ₩ 도 함께 표시.
      let label = '이미지 ' + (data.count || 0) + '/' + data.limit;
      const img = data.image;
      if (img && (img.todayCostKrw || img.monthCostKrw)) {
        label += ' · 오늘 ₩' + (img.todayCostKrw || 0).toLocaleString('ko-KR')
               + ' · 이번달 ₩' + (img.monthCostKrw || 0).toLocaleString('ko-KR');
      }
      usageLabel.textContent = label;
    }
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

// 페이지 로드/새로고침 시 마지막으로 보던 대화를 자동으로 다시 연다.
// = "새로고침하면 대화 내역이 날아간다" 해결. 생성 중이던 답변은 selectThread→attachToGeneration 이 서버에서 이어받음.
async function restoreLastThread() {
  let lastId = null;
  try { lastId = localStorage.getItem('aiTab:lastThreadId'); } catch(_) {}
  if (!lastId) return;
  if (!state.threads.some(t => String(t.id) === String(lastId))) return;  // 삭제된 대화면 무시
  await selectThread(lastId);
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
      const isStreaming = state.streamingByThread && state.streamingByThread.has(String(t.id));
      const icon = isStreaming
        ? '<span class="material-symbols-outlined" style="color:#4f6ef7;animation:spin 1.2s linear infinite;">hourglass_top</span>'
        : (t.project_emoji ? '<span style="font-size:12px;flex-shrink:0;">' + t.project_emoji + '</span>' : '<span class="material-symbols-outlined">chat_bubble</span>');
      html += '<div class="thread-item ' + (isActive ? 'active' : '') + (isStreaming ? ' streaming' : '') + '" data-id="' + t.id + '" title="' + title + (isStreaming ? ' (답변 생성 중…)' : '') + '">' + icon + '<span class="thread-item-title">' + title + '</span></div>';
    }
  }
  threadListEl.innerHTML = html;
}
threadListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.thread-item');
  if (item && item.dataset.id) selectThread(item.dataset.id);
});

async function selectThread(threadId) {
  // streaming 중이어도 다른 스레드 보러 가는 거 허용 (백그라운드는 계속)
  // 이전 스레드의 attach 재연결은 닫기 (새 스레드 화면을 오염시키지 않게)
  if (state.attachES) { try { state.attachES.close(); } catch(_){} state.attachES = null; }
  state.activeThreadId = threadId;
  try { localStorage.setItem('aiTab:lastThreadId', String(threadId)); } catch(_) {}  // F5/탭이동 후 복원용
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
      status: m.status,
      attachments: m.attachments_parsed || [], artifacts: m.artifacts_parsed || [],
      image_url: m.image_url || null,
    }));
    // ★ 생성 중(status='generating') 답변이 있으면 서버에 재연결해서 이어받기
    //   = 새로고침/다른PC/창닫고복귀 복원의 핵심
    const genMsg = state.messages.find(m => (m.role === 'ai' || m.role === 'assistant') && m.status === 'generating');
    if (genMsg) { genMsg.streaming = true; genMsg.serverMsgId = genMsg.id; }
    else {
      // 생성 중 메시지가 없을 때만: 같은 탭 메모리 복원(아직 DB 반영 전 케이스)
      const live = state.liveByThread[String(threadId)];
      if (live && live.streaming && !state.messages.includes(live)) {
        const last = state.messages[state.messages.length - 1];
        const lastIsAssistant = last && (last.role === 'ai' || last.role === 'assistant');
        if (!lastIsAssistant) state.messages.push(live);
      }
    }
    renderMessagesFull();
    scrollToBottom();
    if (genMsg) attachToGeneration(genMsg, String(threadId));
  } catch (e) {
    console.error('메시지 로드 실패:', e);
    messagesEl.innerHTML = '<div style="text-align:center;padding:40px;color:#dc2626;font-size:13px;">메시지 불러오기 실패: ' + escapeHtml(e.message) + '</div>';
  }
}
// 진행 중 생성에 재연결 (EventSource) — 새로고침/다른PC/창닫고복귀 시 답변 이어받기.
// snapshot(여태 전체 대입) → delta(증분 누적) → done/error 로 마무리.
function attachToGeneration(aiMsg, ownerThreadId) {
  if (state.attachES) { try { state.attachES.close(); } catch(_){} state.attachES = null; }
  const mid = aiMsg.serverMsgId || aiMsg.id;
  if (!mid) return;
  let es;
  try { es = new EventSource('/api/ai/chat-stream-cli/attach?messageId=' + encodeURIComponent(mid)); }
  catch (e) { return; }
  state.attachES = es;
  const viewing = () => String(state.activeThreadId) === String(ownerThreadId);
  // 워치독: 연결이 조용히 끊겨(에러도 done도 없이) 이벤트가 멎으면 UI 가 영영 "생성 중"에 갇히는 것 방지.
  // 백엔드는 안 죽인다(명시적 stop 만 죽임). UI만 풀고, 대화를 다시 열면 재attach 로 이어진다.
  let wd;
  const bumpWd = () => {
    clearTimeout(wd);
    wd = setTimeout(() => {
      if (state.attachES !== es) return;
      aiMsg.streaming = false; aiMsg.thinkingActive = false;
      if (viewing()) updateLastAIContent(aiMsg.content, false, ownerThreadId);
      try { es.close(); } catch(_){} state.attachES = null;
      loadThreads();
    }, 180000);
  };
  bumpWd();
  es.addEventListener('snapshot', (ev) => {
    if (state.attachES !== es) return; // 스레드 전환 등으로 교체된 스트림이면 무시
    bumpWd();
    try { const d = JSON.parse(ev.data); aiMsg.content = d.text || ''; if (viewing()) { updateLastAIContent(aiMsg.content, true, ownerThreadId); scrollToBottom(); } } catch(_){}
  });
  es.addEventListener('delta', (ev) => {
    if (state.attachES !== es) return;
    bumpWd();
    try { const d = JSON.parse(ev.data); aiMsg.content += d.text || ''; if (viewing()) updateLastAIContent(aiMsg.content, true, ownerThreadId); } catch(_){}
  });
  es.addEventListener('thinking', (ev) => {
    if (state.attachES !== es) return;
    bumpWd();
    try { const d = JSON.parse(ev.data); if (typeof d.text === 'string') aiMsg.thinking = (aiMsg.thinking || '') + d.text; aiMsg.thinkingActive = true; } catch(_){}
    if (viewing()) updateLastAIContent(aiMsg.content, true, ownerThreadId);
  });
  es.addEventListener('done', (ev) => {
    if (state.attachES !== es) return; // 교체된 스트림의 done 이 새 스트림 참조를 지우지 않게
    clearTimeout(wd);
    try { const d = JSON.parse(ev.data); if (d.text) aiMsg.content = d.text; if (Array.isArray(d.artifacts)) aiMsg.artifacts = d.artifacts; } catch(_){}
    aiMsg.streaming = false; aiMsg.status = 'ok'; aiMsg.thinkingActive = false;
    if (viewing()) { updateLastAIContent(aiMsg.content, false, ownerThreadId); renderMessagesFull(); }
    try { es.close(); } catch(_){} state.attachES = null;
    loadThreads();
  });
  es.addEventListener('error', (ev) => {
    if (state.attachES !== es) return;
    clearTimeout(wd);
    // 서버가 보낸 event:error(데이터 있음) vs 연결 끊김(데이터 없음) 구분
    let serverErr = false;
    try { if (ev && ev.data) { const d = JSON.parse(ev.data); aiMsg.content = (d.text || aiMsg.content || '') + '\n\n**오류:** ' + (d.error || '오류'); aiMsg.streaming = false; aiMsg.status = 'error'; if (viewing()) updateLastAIContent(aiMsg.content, false, ownerThreadId); serverErr = true; } } catch(_){}
    // 어느 경우든 자동 재연결 폭주 방지: 닫는다. (필요하면 사용자가 대화 다시 열어 재attach)
    try { es.close(); } catch(_){} state.attachES = null;
    if (!serverErr) loadThreads();  // 연결 끊김이면 최신 상태 다시 로드
  });
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
      '<div class="msg-thinking-wrap"></div>' +
      '<div class="msg-content"></div>' +
      '<div class="msg-attachments-wrap"></div>' +
      '<div class="msg-artifacts-wrap"></div>' +
    '</div>' + actionsHtml;
  const contentEl = wrap.querySelector('.msg-content');
  if (isAI) {
    renderThinkingBox(wrap.querySelector('.msg-thinking-wrap'), m);
    contentEl.innerHTML = md(m.content) + (m.streaming ? '<span class="typing-cursor"></span>' : '');
    if (!m.streaming) enhanceCodeBlocks(contentEl);
    if (m.image_url) {
      const img = document.createElement('img');
      img.className = 'artifact-img';
      img.src = m.image_url;
      img.alt = '생성된 이미지';
      contentEl.appendChild(img);
    }
    // 핸드오프 버튼: 완료된 텍스트 답변에만 (생성 중·이미지 결과 메시지 제외)
    if (!m.streaming && !m.image_url && (m.content || '').trim()) {
      const hb = document.createElement('button');
      hb.className = 'msg-img-handoff-btn';
      hb.type = 'button';
      hb.dataset.imgHandoff = '1';
      hb.innerHTML = '<span class="material-symbols-outlined">palette</span>🎨 이 내용으로 이미지';
      contentEl.appendChild(hb);
    }
  } else {
    contentEl.innerHTML = '<p>' + escapeHtml(m.content).replace(/\n/g, '<br>') + '</p>';
  }
  if (Array.isArray(m.attachments) && m.attachments.length > 0) {
    const aw = wrap.querySelector('.msg-attachments-wrap');
    aw.className += ' msg-attachments';
    for (const a of m.attachments) {
      const aid = a.id;
      const name = a.originalName || a.original_name || '파일';
      // 이미지는 클로드 웹처럼 말풍선 안 썸네일로 (클릭 시 원본 새 탭)
      if (a.kind === 'image' && aid) {
        const thumb = document.createElement('a');
        thumb.className = 'msg-attachment-img';
        thumb.href = '/api/ai/attachments/' + aid + '/raw';
        thumb.target = '_blank';
        thumb.rel = 'noopener noreferrer';
        thumb.title = name;
        const img = document.createElement('img');
        img.src = '/api/ai/attachments/' + aid + '/raw';
        img.alt = name;
        img.loading = 'lazy';
        thumb.appendChild(img);
        aw.appendChild(thumb);
      } else {
        const chip = document.createElement('span');
        chip.className = 'msg-attachment';
        chip.innerHTML = '<span class="material-symbols-outlined">' + attachKindIcon(a.kind) + '</span>' + escapeHtml(name);
        aw.appendChild(chip);
      }
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
  // art.id 는 URL·HTML 속성에 들어가므로 인코딩 — 따옴표가 살아남아 href 를 탈출하는 XSS 차단
  const aid = (art.id != null && art.id !== '') ? encodeURIComponent(String(art.id)) : null;
  const dlUrl = aid ? '/api/ai/artifacts/' + aid + '/download' : (art.url || '#');
  const filename = escapeHtml(art.filename || art.original_name || '파일');
  // HTML/SVG 는 "새 창 열기" 도 추가 (인터랙티브)
  const canOpenInNewTab = aid && (art.kind === 'html' || art.kind === 'svg');
  const inlineUrl = aid ? '/api/ai/artifacts/' + aid + '/download?inline=1' : null;
  div.innerHTML =
    '<div class="artifact-icon"><span class="material-symbols-outlined">' + iconName + '</span></div>' +
    '<div class="artifact-info">' +
      '<div class="artifact-name">' + filename + '</div>' +
      '<div class="artifact-meta">' + (art.kind || '') + (art.size ? ' · ' + formatBytes(art.size) : '') + '</div>' +
      '<div class="artifact-actions">' +
        '<a href="' + dlUrl + '" class="artifact-btn" download><span class="material-symbols-outlined">download</span>다운로드</a>' +
        (aid ? '<button class="artifact-btn" data-preview-id="' + aid + '" data-preview-kind="' + escapeHtml(art.kind || '') + '" data-preview-name="' + filename + '"><span class="material-symbols-outlined">visibility</span>미리보기</button>' : '') +
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
// 코드블록에 복사 버튼 + 하이라이트 클래스 (클로드챗 스타일). 여러 번 호출돼도 안전.
function ensureChatStyles() {
  if (document.getElementById('aiChatExtraStyles')) return;
  const s = document.createElement('style');
  s.id = 'aiChatExtraStyles';
  s.textContent = '.code-wrap{position:relative;margin:8px 0}.code-wrap pre{margin:0}.code-copy-btn{position:absolute;top:6px;right:6px;display:inline-flex;align-items:center;gap:3px;padding:3px 8px;font-size:11px;font-weight:600;color:#6b7280;background:#fff;border:1px solid #e5e7eb;border-radius:6px;opacity:0;transition:opacity .12s,background .12s;cursor:pointer}.code-wrap:hover .code-copy-btn{opacity:1}.code-copy-btn:hover{background:#f3f4f6;color:#1f2937}.code-copy-btn.copied{color:#10b981;border-color:#a7f3d0}.code-copy-btn .material-symbols-outlined{font-size:13px}';
  document.head.appendChild(s);
}
function enhanceCodeBlocks(container) {
  if (!container) return;
  ensureChatStyles();
  container.querySelectorAll('pre code').forEach(c => c.classList.add('hljs'));
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    const btn = document.createElement('button');
    btn.className = 'code-copy-btn';
    btn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>복사';
    btn.addEventListener('click', async () => {
      try {
        const code = pre.querySelector('code');
        const ok = await copyTextToClipboard(code ? code.innerText : pre.innerText);
        if (!ok) throw new Error('clipboard unavailable');
        btn.classList.add('copied');
        btn.innerHTML = '<span class="material-symbols-outlined">check</span>복사됨';
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = '<span class="material-symbols-outlined">content_copy</span>복사'; }, 1200);
      } catch (e) {}
    });
    wrap.appendChild(btn);

    // HTML/SVG 코드블록이면 "미리보기" 버튼 추가 → 우측 샌드박스 패널에서 실행 (claude.ai 아티팩트처럼)
    const codeEl = pre.querySelector('code');
    const codeText = codeEl ? codeEl.innerText : pre.innerText;
    const lang = codeEl ? (codeEl.className.match(/language-(\w+)/) || [])[1] : '';
    const isSvg = lang === 'svg' || /^\s*<svg[\s>]/i.test(codeText);
    const isHtml = lang === 'html' || lang === 'xml' || /<!doctype html|<html[\s>]|<body[\s>]|<div[\s>][\s\S]*<\/div>/i.test(codeText);
    if ((isSvg || isHtml) && codeText.trim().length > 12) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'code-copy-btn code-preview-btn';
      prevBtn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span>미리보기';
      prevBtn.addEventListener('click', () => openLivePreview(codeText, isSvg, isSvg ? 'SVG 미리보기' : 'HTML 미리보기'));
      wrap.appendChild(prevBtn);
    }
  });
}
// 생각 과정(thinking) 접이식 박스 — claude.ai 스타일. 생성 중엔 펼침, 완료 후 자동 접힘.
function ensureThinkingStyles() {
  if (document.getElementById('aiThinkingStyles')) return;
  const s = document.createElement('style');
  s.id = 'aiThinkingStyles';
  s.textContent = '.msg-thinking{margin:0 0 8px;border:1px solid #e5e7eb;border-radius:10px;background:#fafafa;overflow:hidden}'
    + '.msg-thinking-head{display:flex;align-items:center;gap:6px;padding:7px 11px;cursor:pointer;font-size:12px;font-weight:600;color:#6b7280;user-select:none}'
    + '.msg-thinking-head:hover{background:#f3f4f6}'
    + '.msg-thinking-head .material-symbols-outlined{font-size:15px}'
    + '.msg-thinking-head .chev{margin-left:auto;transition:transform .15s}'
    + '.msg-thinking.collapsed .chev{transform:rotate(-90deg)}'
    + '.msg-thinking-body{padding:2px 12px 11px;font-size:12.5px;line-height:1.6;color:#9ca3af;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto}'
    + '.msg-thinking.collapsed .msg-thinking-body{display:none}'
    + '.msg-thinking-spin{animation:spin 1.2s linear infinite}';
  document.head.appendChild(s);
}
function renderThinkingBox(wrap, m) {
  if (!wrap) return;
  const txt = (m.thinking || '').trim();
  if (!txt) { wrap.innerHTML = ''; return; }
  ensureThinkingStyles();
  const active = !!m.thinkingActive && !!m.streaming;
  // 생성 중엔 펼침, 끝나면 접힘. 사용자가 수동 토글한 상태(m._thinkOpen)가 있으면 우선.
  const open = (m._thinkOpen !== undefined) ? m._thinkOpen : active;
  const icon = active ? 'progress_activity' : 'lightbulb';
  const label = active ? '생각하는 중…' : '생각 과정';
  wrap.innerHTML =
    '<div class="msg-thinking' + (open ? '' : ' collapsed') + '">' +
      '<div class="msg-thinking-head">' +
        '<span class="material-symbols-outlined' + (active ? ' msg-thinking-spin' : '') + '">' + icon + '</span>' +
        '<span>' + label + '</span>' +
        '<span class="material-symbols-outlined chev">expand_more</span>' +
      '</div>' +
      '<div class="msg-thinking-body"></div>' +
    '</div>';
  wrap.querySelector('.msg-thinking-body').textContent = txt;
  const box = wrap.querySelector('.msg-thinking');
  wrap.querySelector('.msg-thinking-head').addEventListener('click', () => {
    box.classList.toggle('collapsed');
    m._thinkOpen = !box.classList.contains('collapsed');
  });
}
function updateLastAIContent(text, isStreaming, ownerThreadId) {
  // ownerThreadId 가 주어졌고 현재 보고 있는 스레드와 다르면 화면 갱신 안 함 (백그라운드)
  const isNewThreadView = ownerThreadId === 'new' && state.activeThreadId == null;
  if (ownerThreadId !== undefined && !isNewThreadView && String(ownerThreadId) !== String(state.activeThreadId)) return;
  if (!messagesEl) return;
  const last = messagesEl.lastElementChild;
  if (!last || !last.classList || !last.classList.contains('msg-ai')) return;
  // 생각 박스 갱신 (마지막 ai 메시지 객체를 state.messages 에서 찾아 thinking 반영)
  const tw = last.querySelector('.msg-thinking-wrap');
  if (tw) { const lm = state.messages[state.messages.length - 1]; if (lm) renderThinkingBox(tw, lm); }
  const c = last.querySelector('.msg-content');
  if (!c) return;
  c.innerHTML = md(text) + (isStreaming ? '<span class="typing-cursor"></span>' : '');
  if (!isStreaming) enhanceCodeBlocks(c);
}
function findMessageElement(message) {
  if (!messagesEl || !message) return null;
  const ids = [message.id, message._clientId, message.serverMsgId]
    .filter(v => v !== undefined && v !== null && String(v) !== '')
    .map(v => String(v));
  if (!ids.length) return null;
  for (const el of messagesEl.querySelectorAll('.msg')) {
    if (ids.includes(String(el.dataset.id || ''))) return el;
  }
  return null;
}
function refreshMessageElement(message, options = {}) {
  if (!messagesEl || !message) return;
  const el = findMessageElement(message);
  const next = buildMessageEl(message);
  if (el) el.replaceWith(next);
  else messagesEl.appendChild(next);
  if (options.scroll !== false) scrollToBottom();
}
function updateAIMessageContent(message, text, isStreaming, ownerThreadId) {
  if (!message) return;
  message.content = text;
  message.streaming = !!isStreaming;
  const isNewThreadView = ownerThreadId === 'new' && state.activeThreadId == null;
  if (ownerThreadId !== undefined && !isNewThreadView && String(ownerThreadId) !== String(state.activeThreadId)) return;
  const el = findMessageElement(message);
  if (!el) return;
  const tw = el.querySelector('.msg-thinking-wrap');
  if (tw) renderThinkingBox(tw, message);
  const c = el.querySelector('.msg-content');
  if (!c) return;
  c.innerHTML = md(text) + (isStreaming ? '<span class="typing-cursor"></span>' : '');
  if (!isStreaming) enhanceCodeBlocks(c);
  scrollToBottom();
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
const savedPreviewWidth = parseInt(localStorage.getItem('ai_preview_width') || '', 10);
if (savedPreviewWidth) document.documentElement.style.setProperty('--preview-width', savedPreviewWidth + 'px');
function ensurePreviewWidth(minWidth) {
  if (!previewModalBg || window.innerWidth <= 768) return;
  const current = previewModalBg.getBoundingClientRect().width || parseInt(localStorage.getItem('ai_preview_width') || '560', 10) || 560;
  const max = Math.max(420, Math.min(window.innerWidth - 360, 1040));
  const next = Math.max(current, Math.min(max, minWidth));
  document.documentElement.style.setProperty('--preview-width', next + 'px');
  localStorage.setItem('ai_preview_width', String(Math.round(next)));
}
function closePreview() {
  previewModalBg.classList.remove('visible');
  if (appEl) appEl.classList.remove('preview-open');
}
previewClose.addEventListener('click', closePreview);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePreview();
});
if (previewResizer) {
  previewResizer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    previewResizer.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = previewModalBg.getBoundingClientRect().width || 560;
    const onMove = (ev) => {
      const max = Math.max(420, Math.min(window.innerWidth - 360, 1040));
      const next = Math.max(360, Math.min(max, startWidth + startX - ev.clientX));
      document.documentElement.style.setProperty('--preview-width', next + 'px');
      localStorage.setItem('ai_preview_width', String(Math.round(next)));
    };
    const onUp = (ev) => {
      previewResizer.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}
async function openPreview(id, kind, name) {
  previewTitle.textContent = name || '미리보기';
  previewBody.classList.remove('excel-render-body');
  previewBody.innerHTML = '<div class="preview-loading">불러오는 중…</div>';
  if (previewDownload) previewDownload.style.display = '';  // 라이브 미리보기가 숨겼을 수 있어 복구
  previewDownload.href = '/api/ai/artifacts/' + id + '/download';
  previewModalBg.classList.add('visible');
  if (appEl) appEl.classList.add('preview-open');
  if (kind === 'excel') ensurePreviewWidth(920);
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
    if (data.render && data.render.url) {
      renderExcelRenderedPreview(data.render);
    } else if (data.kind === 'excel' || (Array.isArray(data.sheets) && data.sheets.length)) {
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

function renderExcelRenderedPreview(render) {
  previewBody.classList.add('excel-render-body');
  previewBody.innerHTML =
    '<div class="excel-render-preview">' +
      '<iframe class="excel-render-frame" src="' + escapeHtml(render.url) + '"></iframe>' +
    '</div>';
}

// 안전한 sandbox iframe 으로 HTML/SVG 콘텐츠 실행
// sandbox="allow-scripts" 만 — same-origin 없으니 부모 DOM·쿠키·ERP API 접근 불가
// 코드블록의 HTML/SVG 를 우측 패널에서 즉시 실행 (서버 아티팩트 없이 인라인 콘텐츠로)
function openLivePreview(content, isSvg, name) {
  previewTitle.textContent = name || '미리보기';
  previewBody.classList.remove('excel-render-body');
  previewBody.innerHTML = '<div class="preview-loading">실행 중…</div>';
  if (previewDownload) previewDownload.style.display = 'none';  // 인라인 미리보기는 다운로드 없음
  previewModalBg.classList.add('visible');
  if (appEl) appEl.classList.add('preview-open');
  try { renderSandboxedHtml(content, isSvg); } catch (e) {
    previewBody.innerHTML = '<div class="preview-loading" style="color:#dc2626;">미리보기 실패: ' + escapeHtml(e.message) + '</div>';
  }
}
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
    '<div style="background:#fff;border-radius:8px;overflow:hidden;height:100%;min-height:520px;">' +
    '<iframe sandbox="allow-scripts" srcdoc="' + html.replace(/"/g, '&quot;') + '" style="width:100%;height:100%;border:none;"></iframe>' +
    '</div>' +
    '<div style="font-size:11px;color:#9ca3af;margin-top:6px;text-align:center;">⚠ 격리 실행 — 이 미리보기는 ERP 데이터에 접근할 수 없어요</div>';
}
function renderExcelPreview(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) {
    previewBody.innerHTML = '<div class="preview-loading">시트 없음</div>';
    return;
  }
  const tabs = sheets.map((s, i) =>
    '<button class="preview-sheet-tab' + (i === 0 ? ' active' : '') + '" data-sheet-idx="' + i + '">' +
    escapeHtml(s.name || ('Sheet ' + (i + 1))) +
    '</button>'
  ).join('');
  previewBody.innerHTML =
    '<div class="excel-preview">' +
      '<div class="excel-toolbar">' +
        '<span class="excel-tool-chip">XLSX</span>' +
        '<div class="excel-namebox" id="excelNameBox">A1</div>' +
        '<div class="excel-fx">fx</div>' +
        '<div class="excel-formula" id="excelFormulaBar"></div>' +
      '</div>' +
      '<div class="excel-grid-wrap" id="previewSheetWrap">' + renderSheetTable(sheets[0]) + '</div>' +
      '<div class="excel-sheet-tabs">' + tabs + '<span class="excel-status" id="excelStatus"></span></div>' +
    '</div>';
  updateExcelStatus(sheets[0]);
  bindExcelGridSelection();
  previewBody.querySelectorAll('.preview-sheet-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = parseInt(tab.dataset.sheetIdx, 10);
      previewBody.querySelectorAll('.preview-sheet-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('previewSheetWrap').innerHTML = renderSheetTable(sheets[idx]);
      updateExcelStatus(sheets[idx]);
      bindExcelGridSelection();
    });
  });
}
function excelColName(index) {
  let name = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name || 'A';
}
function excelColIndex(name) {
  let n = 0;
  const s = String(name || '').toUpperCase();
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}
function parseExcelAddress(addr) {
  const m = String(addr || '').match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  return { col: excelColIndex(m[1]), row: parseInt(m[2], 10) };
}
function buildExcelMergeMaps(merges) {
  const anchors = {};
  const skip = {};
  for (const range of (Array.isArray(merges) ? merges : [])) {
    const parts = String(range || '').split(':');
    if (parts.length !== 2) continue;
    const a = parseExcelAddress(parts[0]);
    const b = parseExcelAddress(parts[1]);
    if (!a || !b) continue;
    const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
    const c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col);
    anchors[r1 + ':' + c1] = { rowspan: r2 - r1 + 1, colspan: c2 - c1 + 1 };
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r !== r1 || c !== c1) skip[r + ':' + c] = true;
      }
    }
  }
  return { anchors, skip };
}
function excelPreviewCellStyle(style) {
  const s = style || {};
  const css = [];
  if (s.bold) css.push('font-weight:700');
  if (s.italic) css.push('font-style:italic');
  if (s.fontSize) css.push('font-size:' + Math.max(8, Math.min(28, parseFloat(s.fontSize) || 12)) + 'px');
  if (s.color) css.push('color:' + s.color);
  if (s.bg) css.push('background:' + s.bg);
  if (s.align) css.push('text-align:' + ({ center:'center', right:'right', left:'left' }[s.align] || s.align));
  if (s.valign) css.push('vertical-align:' + ({ middle:'middle', top:'top', bottom:'bottom' }[s.valign] || s.valign));
  if (s.wrap) css.push('white-space:normal');
  if (s.border) {
    if (typeof s.border === 'object') {
      if (s.border.top) css.push('border-top:1px solid ' + s.border.top);
      if (s.border.right) css.push('border-right:1px solid ' + s.border.right);
      if (s.border.bottom) css.push('border-bottom:1px solid ' + s.border.bottom);
      if (s.border.left) css.push('border-left:1px solid ' + s.border.left);
    } else {
      css.push('border-right-color:#9ca3af;border-bottom-color:#9ca3af');
    }
  }
  return css.join(';');
}
function renderSheetTable(sheet) {
  const rows = sheet.rows || [];
  if (rows.length === 0) return '<div class="preview-loading">빈 시트</div>';
  const styled = rows[0] && rows[0].cells;
  const colCount = Math.max(8, ...rows.map(row => styled ? ((row.cells || []).length) : (Array.isArray(row) ? row.length : 0)));
  const mergeMaps = buildExcelMergeMaps(sheet.merges || []);
  let html = '<table class="excel-sheet-table">';
  if (Array.isArray(sheet.cols) && sheet.cols.length) {
    html += '<colgroup><col style="width:44px">';
    for (let c = 1; c <= colCount; c++) {
      const width = sheet.cols[c - 1] && sheet.cols[c - 1].width;
      html += '<col style="width:' + Math.max(48, Math.min(360, parseInt(width || 118, 10))) + 'px">';
    }
    html += '</colgroup>';
  }
  html += '<thead><tr><th class="excel-corner"></th>';
  for (let c = 1; c <= colCount; c++) {
    html += '<th class="excel-col-head">' + excelColName(c) + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (let r = 0; r < rows.length; r++) {
    const rowObj = rows[r] || [];
    const rowNumber = styled ? (rowObj.number || (r + 1)) : (r + 1);
    const cells = styled ? (rowObj.cells || []) : rowObj;
    const rowStyle = styled && rowObj.height ? ' style="height:' + Math.max(18, Math.min(120, parseFloat(rowObj.height) || 26)) + 'px"' : '';
    html += '<tr' + rowStyle + '><th class="excel-row-head">' + rowNumber + '</th>';
    for (let c = 0; c < colCount; c++) {
      const colNumber = c + 1;
      if (mergeMaps.skip[rowNumber + ':' + colNumber]) continue;
      const cell = cells[c] || {};
      const rawValue = styled ? (cell.v == null ? '' : String(cell.v)) : (cell == null ? '' : String(cell));
      const dispValue = (styled && cell.fv != null && cell.fv !== '') ? String(cell.fv) : rawValue; // 서식 적용값(₩/천단위/%/날짜)
      const formula = styled && cell.f ? String(cell.f) : '';
      const value = formula || rawValue;
      const address = excelColName(colNumber) + rowNumber;
      const merge = mergeMaps.anchors[rowNumber + ':' + colNumber] || {};
      const span = (merge.colspan ? ' colspan="' + merge.colspan + '"' : '') + (merge.rowspan ? ' rowspan="' + merge.rowspan + '"' : '');
      const style = styled ? excelPreviewCellStyle(cell.style) : '';
      html += '<td class="excel-cell" data-address="' + address + '" data-formula="' + escapeHtml(formula) + '" title="' + escapeHtml(value) + '"' + span + (style ? ' style="' + escapeHtml(style) + '"' : '') + '>' + escapeHtml(dispValue || formula) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}
function updateExcelStatus(sheet) {
  const status = document.getElementById('excelStatus');
  if (!status) return;
  const rows = sheet && Array.isArray(sheet.rows) ? sheet.rows : [];
  const colCount = Math.max(0, ...rows.map(row => Array.isArray(row) ? row.length : 0));
  status.textContent = rows.length + 'R x ' + colCount + 'C';
}
function bindExcelGridSelection() {
  const cells = previewBody.querySelectorAll('.excel-cell');
  const nameBox = document.getElementById('excelNameBox');
  const formulaBar = document.getElementById('excelFormulaBar');
  const selectCell = (cell) => {
    if (!cell) return;
    cells.forEach(c => c.classList.remove('selected'));
    cell.classList.add('selected');
    if (nameBox) nameBox.textContent = cell.dataset.address || '';
    if (formulaBar) formulaBar.textContent = cell.dataset.formula || cell.textContent || '';
  };
  cells.forEach(cell => cell.addEventListener('click', () => selectCell(cell)));
  selectCell(Array.from(cells).find(cell => (cell.textContent || '').trim()) || cells[0]);
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
    if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains("msg-ai")) messagesEl.removeChild(messagesEl.lastElementChild);
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

async function sendViaAgent(text, attachmentIds, aiMsg, ownerThreadId, signal) {
  let agentLog = '';
  let seenFiles = [];
  let progressThreadId = ownerThreadId;
  const renderAgentProgress = (phase) => {
    const parts = [phase || '작업 모드로 실행 중입니다.'];
    const log = agentLog.trim();
    if (log) parts.push('```text\n' + log.slice(-5000) + '\n```');
    if (seenFiles.length) {
      parts.push('생성 감지:\n' + seenFiles.slice(-8).map(name => '- ' + name).join('\n'));
    }
    aiMsg.content = parts.join('\n\n');
    updateAIMessageContent(aiMsg, aiMsg.content, true, progressThreadId);
  };
  renderAgentProgress('작업 모드로 실행 중입니다. 이 요청도 현재 대화에 저장됩니다.');
  const r = await fetch('/api/ai/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    signal,
    body: JSON.stringify({
      task: text || '(첨부 파일을 분석해서 결과 파일을 만들어주세요)',
      threadId: state.activeThreadId || undefined,
      attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      sessionConsent: true,
    }),
  });
  if (r.status === 401) { window.location.href = '/'; return true; }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || ('agent ' + r.status));
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let newThreadId = null;
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
      const data = JSON.parse(dataStr);
      if (eventName === 'started') {
        newThreadId = data.threadId || newThreadId;
        if (data.messageId) {
          aiMsg.serverMsgId = data.messageId;
          aiMsg.id = data.messageId;
          const el = findMessageElement(aiMsg);
          if (el) el.dataset.id = String(data.messageId);
        }
        if (newThreadId) {
          const newKey = String(newThreadId);
          progressThreadId = newKey;
          if (!state.activeThreadId) state.activeThreadId = newThreadId;
          state.liveByThread[newKey] = aiMsg;
          if (state.streamingByThread) state.streamingByThread.add(newKey);
          if (ownerThreadId && ownerThreadId !== newKey) {
            delete state.liveByThread[ownerThreadId];
            if (state.streamingByThread) state.streamingByThread.delete(ownerThreadId);
          }
          loadThreads();
        }
        renderAgentProgress('작업을 시작했습니다. 진행 내용은 이 말풍선에 계속 기록됩니다.');
      } else if (eventName === 'output') {
        const chunk = data && data.text ? String(data.text) : '';
        if (chunk) {
          agentLog = (agentLog + chunk).slice(-12000);
          renderAgentProgress('작업 내용을 실시간으로 받아오는 중입니다.');
        }
      } else if (eventName === 'file') {
        if (data && data.name) seenFiles.push(data.name);
        renderAgentProgress('파일을 생성하면서 작업 중입니다.');
      } else if (eventName === 'done') {
        const n = Array.isArray(data.files) ? data.files.length : seenFiles.length;
        renderAgentProgress(`작업 마무리 중입니다. 생성 파일 ${n}개를 등록하고 있습니다.`);
      } else if (eventName === 'saved') {
        aiMsg.streaming = false;
        aiMsg.id = data.messageId || aiMsg.id;
        aiMsg.content = data.text || aiMsg.content || '작업 완료';
        aiMsg.artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
        refreshMessageElement(aiMsg);
        // 마감 양식이 자동 등록됐으면 알림 (다음부터 판매현황만 올려도 됨)
        if (Array.isArray(data.templateSaved) && data.templateSaved.length) {
          showAiToast('마감 양식 ' + data.templateSaved.length + '개를 등록했어요. 다음부터 판매현황 파일만 올리면 됩니다.', 'ok');
        }
      } else if (eventName === 'error') {
        // 서버가 곧 'saved' 로 친절 안내(중단됨/실패 사유)를 보내므로 raw 오류를 덮어쓰지 않게 보관만.
        aiMsg.streaming = false;
        aiMsg._agentError = data || {};
        // saved 가 안 오는 예외 케이스(서버 자체 throw)에 대비해 임시 표시
        if (!aiMsg.content || aiMsg.content === '작업을 시작했습니다.') {
          aiMsg.content = data.code
            ? '작업을 완료하지 못했어요. (' + data.code + ')'
            : ('작업에 실패했어요: ' + (data.error || data.message || '알 수 없는 오류'));
        }
        updateAIMessageContent(aiMsg, aiMsg.content, false, progressThreadId);
      }
    }
  }
  if (newThreadId && state.activeThreadId === null) state.activeThreadId = newThreadId;
  aiMsg.streaming = false;
  if (!Array.isArray(aiMsg.artifacts)) aiMsg.artifacts = [];
  updateAIMessageContent(aiMsg, aiMsg.content, false, progressThreadId);
  await loadThreads();
  return true;
}

// 전송
async function sendMessage() {
  const text = input.value.trim();
  const readyAtts = state.attachments.filter(a => !a.uploading && a.id);
  if (!text && readyAtts.length === 0 && !state.imageMode) return;
  if (state.imageMode && !text) { alert('이미지 설명을 입력해주세요.'); return; }
  if (state.streaming) return;

  const ownerThreadId = state.activeThreadId ? String(state.activeThreadId) : 'new';
  // 중복 실행 가드: 같은 대화가 이미 생성 중이면 무시 (state.streaming 과 병행)
  if (state.streamingByThread && state.streamingByThread.has(ownerThreadId)) return;

  // 의도 라우팅: 이미지 의도면 (이미지 모드 OFF여도) 핸드오프 경로로 보낸다.
  //   → /image-prompt 로 프롬프트 정리 후 picker 와 함께 편집 박스를 띄움. 메시지/스트리밍은 시작하지 않음.
  if (!state.imageMode && isImageIntent(text)) {
    input.value = '';
    autoResize();
    openHandoff(text, { messageId: null });
    return;
  }

  state.abortController = new AbortController(); setStreaming(true);
  state.streamingByThread.add(ownerThreadId);
  renderThreadList();
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
  aiMsg._clientId = aiMsg.id;
  state.messages.push(aiMsg);
  state.liveByThread[ownerThreadId] = aiMsg;   // 생성 중 답변 등록 (다른 대화 갔다 와도 복원)
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
        body: JSON.stringify({ prompt: text, threadId: state.activeThreadId || undefined, size: sizeFor(), quality: state.imageQuality, userInput: text }),
      });
      if (r.status === 401) { window.location.href = '/'; return; }
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('chat-image ' + r.status));
      aiMsg.streaming = false;
      aiMsg.content = data.text || (data.message && data.message.content) || '이미지가 생성되었습니다.';
      aiMsg.image_url = data.url || data.image_url || data.imageUrl || (data.message && (data.message.image_url || data.message.imageUrl)) || null;
      aiMsg.artifacts = data.artifacts || [];
      console.log('[ai-chat] chat-image:', { url: data.url, image_url: aiMsg.image_url });
      if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains("msg-ai")) messagesEl.removeChild(messagesEl.lastElementChild);
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
      if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains("msg-ai")) messagesEl.removeChild(messagesEl.lastElementChild);
      appendMessage(aiMsg);
    } finally {
      state.streamingByThread.delete(ownerThreadId);
      state.streamingByThread.delete('new');
      delete state.liveByThread[ownerThreadId];
      if (state.activeThreadId) delete state.liveByThread[String(state.activeThreadId)];
      setStreaming(false); input.disabled = false; autoResize(); input.focus();
      renderThreadList();
    }
    return;
  }

  if (shouldUseAgentMode(text, attachmentIds)) {
    const agentAbortController = state.abortController || new AbortController();
    setStreaming(false);
    input.disabled = false;
    autoResize();
    input.focus();
    renderThreadList();
    sendViaAgent(text, attachmentIds, aiMsg, ownerThreadId, agentAbortController.signal)
      .catch((e) => {
        console.error('agent 작업 실패:', e);
        aiMsg.streaming = false;
        aiMsg.content = '**오류:** ' + e.message;
        updateAIMessageContent(aiMsg, aiMsg.content, false, ownerThreadId);
      })
      .finally(() => {
        if (state.streamingByThread) {
          state.streamingByThread.delete(ownerThreadId);
          state.streamingByThread.delete('new');
        }
        if (state.liveByThread[ownerThreadId] === aiMsg) delete state.liveByThread[ownerThreadId];
        if (state.activeThreadId && state.liveByThread[String(state.activeThreadId)] === aiMsg) {
          delete state.liveByThread[String(state.activeThreadId)];
        }
        renderThreadList();
        loadThreads();
      });
    return;
  }

  // 환경에 따라 endpoint 선택: API key 있으면 /chat-stream, 없으면 /chat-stream-cli (CLI 스트리밍)
  const streamEndpoint = state.apiKeyAvailable === false ? '/api/ai/chat-stream-cli' : '/api/ai/chat-stream';
  // ★ newThreadId 는 try/catch/finally 전부에서 참조되므로 try 밖에서 선언 (블록 스코프 ReferenceError 방지)
  let newThreadId = null;
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
    let buffer = '';
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
          if (eventName === 'start') {
            newThreadId = data.threadId;
            // 서버 메시지 ID 저장 (중단 버튼·재연결 키). 새 대화면 실제 threadId 로도 복원 등록.
            if (data.messageId) aiMsg.serverMsgId = data.messageId;
            if (newThreadId && ownerThreadId === 'new') state.liveByThread[String(newThreadId)] = aiMsg;
            // ★ threadId 가 생기는 즉시 저장 → 생성 중 F5 해도 이 대화로 복원 (새 대화의 핵심)
            if (newThreadId) { try { localStorage.setItem('aiTab:lastThreadId', String(newThreadId)); } catch(_) {} }
          }
          else if (eventName === 'snapshot') {
            // attach 재연결 첫 프레임(전체 대입). 직접 스트림 경로에선 보통 안 오지만 방어적으로.
            aiMsg.content = data.text || '';
            updateLastAIContent(aiMsg.content, true, ownerThreadId);
            scrollToBottom();
          }
          else if (eventName === 'thinking') {
            // 생각 과정 누적 → 접이식 박스 (claude.ai 스타일). 텍스트가 오면 모으고, active만 오면 표시 시작.
            if (typeof data.text === 'string') aiMsg.thinking = (aiMsg.thinking || '') + data.text;
            aiMsg.thinkingActive = true;
            const now = Date.now();
            if (now - lastRender > 50) { updateLastAIContent(aiMsg.content, true, ownerThreadId); lastRender = now; }
          }
          else if (eventName === 'delta') {
            aiMsg.thinkingActive = false;  // 본문 시작 = 생각 끝
            aiMsg.content += data.text || '';
            const now = Date.now();
            if (now - lastRender > 16) {
              updateLastAIContent(aiMsg.content, true, ownerThreadId);
              scrollToBottom();
              lastRender = now;
            }
          } else if (eventName === 'done') {
            aiMsg.streaming = false;
            aiMsg.id = data.messageId || aiMsg.id;
            // CLI 스트리밍이 보내준 artifacts 가 있으면 카드 표시
            if (Array.isArray(data.artifacts) && data.artifacts.length > 0) {
              aiMsg.artifacts = data.artifacts;
              if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains("msg-ai")) messagesEl.removeChild(messagesEl.lastElementChild);
              appendMessage(aiMsg);
              scrollToBottom();
            } else {
              updateLastAIContent(aiMsg.content, false);
            }
          } else if (eventName === 'error') {
            aiMsg.streaming = false;
            // 사용자 중단(interrupted)은 오류가 아니라 조용한 정지로 표시
            if (data.interrupted || state.userStopped) {
              if (!/중단됨/.test(aiMsg.content)) aiMsg.content += '\n\n_⏹ 중단됨_';
            } else {
              aiMsg.content += '\n\n**오류:** ' + (data.error || '알 수 없는 오류');
            }
            updateLastAIContent(aiMsg.content, false);
          }
        } catch (e) { console.warn('SSE parse:', e); }
      }
    }
    updateLastAIContent(aiMsg.content, false, ownerThreadId);
    if (newThreadId && state.activeThreadId === null) {
      state.activeThreadId = newThreadId;
      await loadThreads();
      const t = state.threads.find(x => String(x.id) === String(newThreadId));
      if (t) topbarTitleEl.textContent = t.title || '제목 없음';
    } else {
      loadThreads();
    }
  } catch (e) {
    aiMsg.streaming = false;
    // 사용자 중단(AbortError)이면 오류 아닌 '중단됨' 으로 표시
    if (state.userStopped || (e && e.name === 'AbortError') || /aborted/i.test(e && e.message || '')) {
      if (!/중단됨/.test(aiMsg.content)) aiMsg.content = (aiMsg.content || '') + '\n\n_⏹ 중단됨_';
      updateLastAIContent(aiMsg.content, false, ownerThreadId);
    } else {
      console.error('전송 실패:', e);
      aiMsg.content = (aiMsg.content || '') + '\n\n**오류:** ' + e.message;
      updateLastAIContent(aiMsg.content, false, ownerThreadId);
    }
  } finally {
    state.userStopped = false;
    if (state.streamingByThread) {
      state.streamingByThread.delete(ownerThreadId);
      state.streamingByThread.delete('new');
    }
    // 생성 끝 → 라이브 버퍼 정리 (이후엔 서버 저장본으로 복원됨)
    delete state.liveByThread[ownerThreadId];
    if (newThreadId) delete state.liveByThread[String(newThreadId)];
    setStreaming(false);
    input.disabled = false;
    autoResize();
    if (String(ownerThreadId) === String(state.activeThreadId)) input.focus();
    renderThreadList();
  }
}

// ═══ 이미지 핸드오프 (대화/버튼 → 프롬프트 편집 → 생성) ═══
const handoffBox = document.getElementById('handoffBox');
const handoffInput = document.getElementById('handoffInput');
const handoffPicker = document.getElementById('handoffPicker');
const handoffGen = document.getElementById('handoffGen');
const handoffCancel = document.getElementById('handoffCancel');

function closeHandoff() {
  if (!handoffBox) return;
  handoffBox.style.display = 'none';
  handoffBox.classList.remove('visible');
  if (handoffInput) handoffInput.value = '';
}
// userInput: 사용자가 원한 내용(또는 AI 메시지 텍스트). messageId: 출처 AI 메시지(있으면 전달).
async function openHandoff(userInput, opts) {
  if (!handoffBox || !handoffInput) return;
  opts = opts || {};
  // picker 마크업 주입 후 현재 state 로 동기화
  if (handoffPicker) { handoffPicker.innerHTML = handoffPickerHtml(); }
  syncPickerUI();
  handoffBox.style.display = 'block';
  handoffBox.classList.add('visible');
  handoffInput.value = '정리 중…';
  handoffInput.disabled = true;
  if (handoffGen) handoffGen.disabled = true;
  handoffInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // /image-prompt 로 영어 프롬프트 한 문장으로 정리 (실패해도 입력 그대로 폴백)
  let prompt = String(userInput || '').trim();
  try {
    const r = await fetch('/api/ai/image-prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ userInput: prompt, messageId: opts.messageId || undefined, threadId: state.activeThreadId || undefined }),
    });
    if (r.status === 401) { window.location.href = '/'; return; }
    if (r.ok) { const d = await r.json(); if (d && d.prompt) prompt = d.prompt; }
  } catch (_) {}
  handoffInput.value = prompt;
  handoffInput.disabled = false;
  if (handoffGen) handoffGen.disabled = false;
  setTimeout(() => { try { handoffInput.focus(); handoffInput.setSelectionRange(prompt.length, prompt.length); } catch(_){} }, 30);
}
if (handoffCancel) handoffCancel.addEventListener('click', closeHandoff);
if (handoffGen) handoffGen.addEventListener('click', () => {
  const prompt = (handoffInput.value || '').trim();
  if (!prompt) { handoffInput.focus(); return; }
  closeHandoff();
  runImageGeneration(prompt);
});

// 명시적 프롬프트로 이미지 생성 (핸드오프 전용). 메시지 말풍선 생성 + 렌더는 imageMode 분기와 동일.
async function runImageGeneration(prompt) {
  if (state.streaming) return;
  const ownerThreadId = state.activeThreadId ? String(state.activeThreadId) : 'new';
  if (state.streamingByThread && state.streamingByThread.has(ownerThreadId)) return;
  state.abortController = new AbortController(); setStreaming(true);
  state.streamingByThread.add(ownerThreadId);
  renderThreadList();
  input.disabled = true;

  const userMsg = { role: 'user', content: prompt, id: 'tmp_u_' + Date.now() };
  state.messages.push(userMsg);
  appendMessage(userMsg);
  const aiMsg = { role: 'ai', content: '이미지 생성 중… (10~30초 소요)', streaming: true, id: 'tmp_a_' + Date.now() };
  aiMsg._clientId = aiMsg.id;
  state.messages.push(aiMsg);
  state.liveByThread[ownerThreadId] = aiMsg;
  appendMessage(aiMsg);
  scrollToBottom();

  try {
    const r = await fetch('/api/ai/chat-image', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      signal: state.abortController.signal,
      body: JSON.stringify({ prompt, threadId: state.activeThreadId || undefined, size: sizeFor(), quality: state.imageQuality, userInput: prompt }),
    });
    if (r.status === 401) { window.location.href = '/'; return; }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('chat-image ' + r.status));
    aiMsg.streaming = false;
    aiMsg.content = data.text || (data.message && data.message.content) || '이미지가 생성되었습니다.';
    aiMsg.image_url = data.url || data.image_url || data.imageUrl || (data.message && (data.message.image_url || data.message.imageUrl)) || null;
    aiMsg.artifacts = data.artifacts || [];
    if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains('msg-ai')) messagesEl.removeChild(messagesEl.lastElementChild);
    appendMessage(aiMsg);
    scrollToBottom();
    if (data.threadId && !state.activeThreadId) { state.activeThreadId = data.threadId; await loadThreads(); }
    else { loadThreads(); }
    loadUsage();
  } catch (e) {
    console.error('이미지 생성 실패:', e);
    aiMsg.streaming = false;
    aiMsg.content = '**오류:** ' + e.message;
    if (messagesEl.lastElementChild && messagesEl.lastElementChild.classList && messagesEl.lastElementChild.classList.contains('msg-ai')) messagesEl.removeChild(messagesEl.lastElementChild);
    appendMessage(aiMsg);
  } finally {
    state.streamingByThread.delete(ownerThreadId);
    state.streamingByThread.delete('new');
    delete state.liveByThread[ownerThreadId];
    if (state.activeThreadId) delete state.liveByThread[String(state.activeThreadId)];
    setStreaming(false); input.disabled = false; autoResize(); input.focus();
    renderThreadList();
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
stopBtn.addEventListener('click', async () => {
  // 서버에서 끝까지 생성 중이므로(연결 끊김≠취소), 반드시 서버 stop API 로 중단해야 함.
  state.userStopped = true;   // 이후 abort 로 인한 catch 를 '오류' 아닌 '중단'으로 처리
  let sid = null;
  const live = (state.activeThreadId && state.liveByThread[String(state.activeThreadId)]) || state.liveByThread['new'];
  if (live && live.serverMsgId) sid = live.serverMsgId;
  if (!sid) { const m = state.messages.find(x => x.streaming && (x.serverMsgId || x.id)); if (m) sid = m.serverMsgId || m.id; }
  if (sid) {
    // 채팅/에이전트 중 어느 경로인지 클라이언트가 항상 알 수 없으므로 둘 다 시도 (없는 쪽은 서버가 no-op).
    const body = JSON.stringify({ messageId: sid });
    const opt = { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body };
    try { await Promise.allSettled([
      fetch('/api/ai/chat-stream-cli/stop', opt),
      fetch('/api/ai/agent/stop', opt),
    ]); } catch (_) {}
  }
  if (state.abortController) { state.abortController.abort(); console.log('[ai-chat] 사용자 중단'); }
  if (state.attachES) { try { state.attachES.close(); } catch(_){} state.attachES = null; }
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

// 🎨 이 내용으로 이미지 — AI 메시지 텍스트를 핸드오프(프롬프트 정리 → picker → 생성)로
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-img-handoff]');
  if (!btn) return;
  if (state.streaming) return;
  const msgEl = btn.closest('.msg');
  if (!msgEl) return;
  const msg = state.messages.find(m => String(m.id) === String(msgEl.dataset.id));
  const text = (msg && msg.content) || '';
  if (!text.trim()) return;
  openHandoff(text, { messageId: (msg && msg.serverMsgId) || (msg && msg.id) || null });
});

async function copyMessage(msg, btn) {
  try {
    const ok = await copyTextToClipboard(msg.content || '');
    if (!ok) throw new Error('clipboard unavailable');
    btn.classList.add('copied');
    btn.querySelector('.material-symbols-outlined').textContent = 'check';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('.material-symbols-outlined').textContent = 'content_copy';
    }, 1200);
  } catch (e) { alert('복사 실패: 브라우저가 클립보드 접근을 허용하지 않았습니다.'); }
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
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch(_) {}
  ta.style.height = Math.max(80, ta.scrollHeight) + 'px';
  const restore = () => { contentEl.innerHTML = '<p>' + escapeHtml(oldContent).replace(/\n/g, '<br>') + '</p>'; };
  const doSave = () => {
    const newText = ta.value.trim();
    if (!newText) return;
    const idx = state.messages.findIndex(m => String(m.id) === String(msg.id));
    if (idx === -1) return;
    state.messages = state.messages.slice(0, idx);
    renderMessagesFull();
    input.value = newText;
    autoResize();
    sendMessage();
  };
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.max(80, ta.scrollHeight) + 'px'; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSave(); }   // Enter 저장 (claude.ai 동일)
    else if (e.key === 'Escape') { e.preventDefault(); restore(); }            // Esc 취소
  });
  wrap.querySelector('.msg-edit-cancel').addEventListener('click', restore);
  wrap.querySelector('.msg-edit-save').addEventListener('click', doSave);
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
    const hasKb = (p.knowledge && p.knowledge.trim()) ? ' has-kb' : '';
    // 📋 지식 편집 버튼 (claude.ai Projects 처럼 — 여기 적은 내용이 그 프로젝트 모든 대화에 주입)
    const kbBtn = '<button class="proj-kb-btn' + hasKb + '" data-kb="' + p.id + '" title="프로젝트 지식 편집">' +
      '<span class="material-symbols-outlined">menu_book</span></button>';
    html += '<div class="project-item' + (isActive ? ' active' : '') + '" data-pid="' + p.id + '" title="' + name + '">' +
      '<span class="project-item-emoji">' + emoji + '</span>' +
      '<span class="project-item-name">' + name + '</span>' + cnt + kbBtn + '</div>';
  }
  projectListEl.innerHTML = html;
}
projectListEl.addEventListener('click', (e) => {
  // 지식 편집 버튼이면 모달 열고 끝 (대화 필터링으로 안 넘어감)
  const kbBtn = e.target.closest('.proj-kb-btn');
  if (kbBtn) {
    e.stopPropagation();
    const p = state.projects.find(x => String(x.id) === String(kbBtn.dataset.kb));
    if (p) openKnowledgeModal(p);
    return;
  }
  const item = e.target.closest('.project-item');
  if (!item) return;
  const pid = item.dataset.pid;
  state.activeProjectId = pid ? parseInt(pid, 10) : null;
  renderProjects();
  loadThreadsByProject();
});

// 프로젝트 지식 편집 모달 — 여기 적은 내용이 그 프로젝트의 모든 대화에 자동 참고됨
function openKnowledgeModal(project) {
  if (!document.getElementById('kbModalStyles')) {
    const s = document.createElement('style'); s.id = 'kbModalStyles';
    s.textContent = '.kb-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2000}'
      + '.kb-modal{background:#fff;border-radius:14px;padding:20px;width:560px;max-width:92vw;box-shadow:0 12px 40px rgba(0,0,0,.25)}'
      + '.kb-modal h3{font-size:15px;font-weight:700;margin:0 0 4px;color:#1f2937}'
      + '.kb-modal .kb-sub{font-size:12px;color:#9ca3af;margin:0 0 12px;line-height:1.5}'
      + '.kb-modal textarea{width:100%;height:240px;padding:11px 13px;border:1px solid #d1d5db;border-radius:9px;font-size:13px;line-height:1.6;font-family:inherit;color:#1f2937;outline:none;resize:vertical;box-sizing:border-box}'
      + '.kb-modal textarea:focus{border-color:#4f6ef7}'
      + '.kb-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}'
      + '.kb-modal-actions button{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none}'
      + '.kb-cancel{background:#f3f4f6;color:#4b5563}.kb-save{background:linear-gradient(135deg,#4f6ef7,#7c5cff);color:#fff}';
    document.head.appendChild(s);
  }
  const bg = document.createElement('div');
  bg.className = 'kb-modal-bg';
  bg.innerHTML =
    '<div class="kb-modal">' +
      '<h3>' + (project.emoji || '📁') + ' ' + escapeHtml(project.name || '프로젝트') + ' — 지식</h3>' +
      '<p class="kb-sub">여기 적은 내용은 이 프로젝트의 <b>모든 대화</b>에 자동으로 참고됩니다.<br>(회사 규칙·용어·단가 기준·자주 쓰는 정보 등)</p>' +
      '<textarea class="kb-input" placeholder="예) 우리 거래처는 퍼시스/하츠/나이스텍. 견적 단가는 항상 부가세 별도로 표기한다. ..."></textarea>' +
      '<div class="kb-modal-actions"><button class="kb-cancel">취소</button><button class="kb-save">저장</button></div>' +
    '</div>';
  document.body.appendChild(bg);
  const ta = bg.querySelector('.kb-input');
  ta.value = project.knowledge || '';
  setTimeout(() => ta.focus(), 50);
  const close = () => { try { document.body.removeChild(bg); } catch(_){} };
  bg.addEventListener('click', (ev) => { if (ev.target === bg) close(); });
  bg.querySelector('.kb-cancel').addEventListener('click', close);
  bg.querySelector('.kb-save').addEventListener('click', async () => {
    const knowledge = ta.value;
    try {
      const r = await fetch('/api/ai/projects/' + project.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ knowledge }),
      });
      if (!r.ok) throw new Error('저장 실패 ' + r.status);
      project.knowledge = knowledge;   // 로컬 캐시 갱신 → 아이콘 강조 반영
      renderProjects();
      close();
    } catch (e) { alert('지식 저장 실패: ' + e.message); }
  });
}

// 마감 스킬 slug → 사람이 읽는 이름
const SKILL_LABELS = {
  'persys-ledger': '퍼시스',
  'nicetech-ledger': '나이스텍',
  'haatz-ledger': '하츠',
  'partner-ledger': '파트너(8개사)',
  'posco-statement': '포스코',
};

// 가벼운 토스트 알림 (양식 자동 등록 등)
function showAiToast(msg, kind) {
  if (!document.getElementById('aiToastStyles')) {
    const s = document.createElement('style'); s.id = 'aiToastStyles';
    s.textContent = '.ai-toast{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:3000;'
      + 'background:#1f2937;color:#fff;padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;'
      + 'box-shadow:0 8px 28px rgba(0,0,0,.28);opacity:0;transition:opacity .25s,transform .25s;max-width:80vw}'
      + '.ai-toast.show{opacity:1;transform:translateX(-50%) translateY(-4px)}'
      + '.ai-toast.ok{background:linear-gradient(135deg,#16a34a,#059669)}';
    document.head.appendChild(s);
  }
  const el = document.createElement('div');
  el.className = 'ai-toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { try { document.body.removeChild(el); } catch(_){} }, 300);
  }, 3200);
}

// 등록된 마감 양식(템플릿) 보기/삭제 모달
//  GET  /api/ai/agent/skill-templates          → {summary:[{slug,count}]}
//  GET  /api/ai/agent/skill-templates/:slug     → {templates:[{name,mtimeMs,sizeKB}]}
//  DELETE /api/ai/agent/skill-templates/:slug/:name
function openSkillTemplatesModal() {
  if (!document.getElementById('tplModalStyles')) {
    const s = document.createElement('style'); s.id = 'tplModalStyles';
    s.textContent = '.tpl-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2000}'
      + '.tpl-modal{background:#fff;border-radius:14px;padding:20px;width:540px;max-width:92vw;max-height:84vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.25)}'
      + '.tpl-modal h3{font-size:15px;font-weight:700;margin:0 0 4px;color:#1f2937}'
      + '.tpl-modal .tpl-sub{font-size:12px;color:#9ca3af;margin:0 0 14px;line-height:1.5}'
      + '.tpl-skill{border:1px solid #e5e7eb;border-radius:10px;margin-bottom:8px;overflow:hidden}'
      + '.tpl-skill-head{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;cursor:pointer;background:#fafbfc}'
      + '.tpl-skill-head:hover{background:#f3f4f6}'
      + '.tpl-skill-name{font-size:13px;font-weight:700;color:#1f2937}'
      + '.tpl-skill-cnt{font-size:12px;color:#6b7280;background:#eef2ff;border-radius:20px;padding:2px 10px;font-weight:600}'
      + '.tpl-skill-cnt.zero{background:#f3f4f6;color:#9ca3af}'
      + '.tpl-list{padding:6px 14px 12px}'
      + '.tpl-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-top:1px solid #f1f3f5}'
      + '.tpl-row:first-child{border-top:none}'
      + '.tpl-fname{font-size:12px;color:#374151;word-break:break-all;line-height:1.4}'
      + '.tpl-meta{font-size:11px;color:#9ca3af;margin-top:1px}'
      + '.tpl-del{flex:none;border:none;background:#fef2f2;color:#dc2626;border-radius:7px;padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer}'
      + '.tpl-del:hover{background:#fee2e2}'
      + '.tpl-empty{font-size:12px;color:#9ca3af;padding:8px 0}'
      + '.tpl-modal-actions{display:flex;justify-content:flex-end;margin-top:14px}'
      + '.tpl-close{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;background:#f3f4f6;color:#4b5563}';
    document.head.appendChild(s);
  }
  const bg = document.createElement('div');
  bg.className = 'tpl-modal-bg';
  bg.innerHTML =
    '<div class="tpl-modal">' +
      '<h3>📑 등록된 마감 양식</h3>' +
      '<p class="tpl-sub">전월 마감내역서를 한 번 첨부하면 이 양식으로 저장됩니다.<br>다음부터는 <b>판매현황 파일만</b> 올려도 같은 양식으로 자동 마감됩니다. 잘못 등록된 양식은 삭제하세요.</p>' +
      '<div class="tpl-body"><div class="tpl-empty">불러오는 중…</div></div>' +
      '<div class="tpl-modal-actions"><button class="tpl-close">닫기</button></div>' +
    '</div>';
  document.body.appendChild(bg);
  const bodyEl = bg.querySelector('.tpl-body');
  const close = () => { try { document.body.removeChild(bg); } catch(_){} };
  bg.addEventListener('click', (ev) => { if (ev.target === bg) close(); });
  bg.querySelector('.tpl-close').addEventListener('click', close);

  async function renderTemplates(slug, listEl) {
    listEl.innerHTML = '<div class="tpl-empty">불러오는 중…</div>';
    try {
      const r = await fetch('/api/ai/agent/skill-templates/' + encodeURIComponent(slug), { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const list = Array.isArray(d.templates) ? d.templates : [];
      if (!list.length) { listEl.innerHTML = '<div class="tpl-empty">등록된 양식이 없습니다.</div>'; return; }
      listEl.innerHTML = list.map(t => {
        const dt = t.mtimeMs ? new Date(t.mtimeMs) : null;
        const meta = [t.sizeKB != null ? t.sizeKB + 'KB' : null,
                      dt ? (dt.getFullYear() + '.' + String(dt.getMonth()+1).padStart(2,'0') + '.' + String(dt.getDate()).padStart(2,'0')) : null]
                     .filter(Boolean).join(' · ');
        return '<div class="tpl-row" data-name="' + escapeHtml(t.name) + '">' +
          '<div><div class="tpl-fname">' + escapeHtml(t.name) + '</div>' +
          (meta ? '<div class="tpl-meta">' + escapeHtml(meta) + '</div>' : '') + '</div>' +
          '<button class="tpl-del">삭제</button></div>';
      }).join('');
      listEl.querySelectorAll('.tpl-row').forEach(row => {
        row.querySelector('.tpl-del').addEventListener('click', async () => {
          const name = row.dataset.name;
          if (!confirm('이 양식을 삭제할까요?\n' + name)) return;
          try {
            const dr = await fetch('/api/ai/agent/skill-templates/' + encodeURIComponent(slug) + '/' + encodeURIComponent(name),
              { method: 'DELETE', credentials: 'include' });
            if (!dr.ok) { const e = await dr.json().catch(()=>({})); throw new Error(e.error || ('HTTP ' + dr.status)); }
            showAiToast('양식을 삭제했습니다.', 'ok');
            loadSummary();   // 카운트·목록 갱신
          } catch (e) { alert('삭제 실패: ' + e.message); }
        });
      });
    } catch (e) {
      listEl.innerHTML = '<div class="tpl-empty">불러오기 실패: ' + escapeHtml(e.message) + '</div>';
    }
  }

  async function loadSummary() {
    try {
      const r = await fetch('/api/ai/agent/skill-templates', { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const summary = Array.isArray(d.summary) ? d.summary : [];
      bodyEl.innerHTML = summary.map(s => {
        const label = SKILL_LABELS[s.slug] || s.slug;
        const zero = s.count ? '' : ' zero';
        return '<div class="tpl-skill" data-slug="' + escapeHtml(s.slug) + '">' +
          '<div class="tpl-skill-head">' +
            '<span class="tpl-skill-name">' + escapeHtml(label) + '</span>' +
            '<span class="tpl-skill-cnt' + zero + '">' + s.count + '개</span>' +
          '</div>' +
          '<div class="tpl-list" style="display:none"></div>' +
        '</div>';
      }).join('') || '<div class="tpl-empty">표시할 스킬이 없습니다.</div>';
      bodyEl.querySelectorAll('.tpl-skill').forEach(sk => {
        const slug = sk.dataset.slug;
        const head = sk.querySelector('.tpl-skill-head');
        const listEl = sk.querySelector('.tpl-list');
        head.addEventListener('click', () => {
          const open = listEl.style.display !== 'none';
          if (open) { listEl.style.display = 'none'; return; }
          listEl.style.display = 'block';
          renderTemplates(slug, listEl);
        });
      });
    } catch (e) {
      bodyEl.innerHTML = '<div class="tpl-empty">불러오기 실패: ' + escapeHtml(e.message) + '</div>';
    }
  }
  loadSummary();
}

// 회사 기억 관리 모달 (관리자 전용) — 사용중/검토대기/삭제 탭 + 수동추가
function openCompanyMemoryModal() {
  if (!document.getElementById('cmModalStyles')) {
    const s = document.createElement('style'); s.id = 'cmModalStyles';
    s.textContent = '.cm-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:2000}'
      + '.cm-modal{background:#fff;border-radius:14px;padding:20px;width:600px;max-width:94vw;max-height:86vh;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.25)}'
      + '.cm-modal h3{font-size:15px;font-weight:700;margin:0 0 4px;color:#1f2937}.cm-sub{font-size:12px;color:#9ca3af;margin:0 0 12px}'
      + '.cm-tabs{display:flex;gap:6px;margin-bottom:10px}.cm-tab{padding:6px 12px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;background:#f3f4f6;color:#4b5563;border:none}.cm-tab.on{background:#4f6ef7;color:#fff}'
      + '.cm-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid #f1f3f5}'
      + '.cm-c{font-size:13px;color:#374151;word-break:break-all}.cm-meta{font-size:11px;color:#9ca3af;margin-top:2px}'
      + '.cm-btns{flex:none;display:flex;gap:4px}.cm-btns button{border:none;border-radius:6px;padding:4px 8px;font-size:11px;font-weight:600;cursor:pointer}'
      + '.cm-approve{background:#dcfce7;color:#15803d}.cm-pin{background:#eef2ff;color:#4f46e5}.cm-del{background:#fef2f2;color:#dc2626}'
      + '.cm-add{display:flex;gap:6px;margin:10px 0}.cm-add input,.cm-add select{padding:6px 8px;border:1px solid #d1d5db;border-radius:7px;font-size:12px}.cm-add input{flex:1}'
      + '.cm-add button{background:linear-gradient(135deg,#4f6ef7,#7c5cff);color:#fff;border:none;border-radius:7px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer}'
      + '.cm-empty{font-size:12px;color:#9ca3af;padding:10px 0}.cm-close{margin-top:12px;padding:8px 16px;border-radius:8px;border:none;background:#f3f4f6;color:#4b5563;font-weight:600;cursor:pointer}';
    document.head.appendChild(s);
  }
  const bg = document.createElement('div'); bg.className = 'cm-bg';
  bg.innerHTML = '<div class="cm-modal">'
    + '<h3>🧠 회사 기억</h3><p class="cm-sub">AI가 우리 회사 업무에 대해 기억하는 내용입니다. 위험 항목은 "검토 대기"에 모입니다. (관리자 전용)</p>'
    + '<div class="cm-tabs"><button class="cm-tab on" data-st="active">사용 중</button><button class="cm-tab" data-st="pending">검토 대기</button><button class="cm-tab" data-st="archived">삭제됨</button></div>'
    + '<div class="cm-add"><select class="cm-cat"><option>거래처</option><option>품목</option><option>규칙</option><option>용어</option></select>'
    + '<input class="cm-input" placeholder="회사 기억 직접 추가 (예: 한신공영은 부가세 별도)"><button class="cm-addbtn">추가</button></div>'
    + '<div class="cm-body"><div class="cm-empty">불러오는 중…</div></div>'
    + '<button class="cm-close">닫기</button></div>';
  document.body.appendChild(bg);
  const body = bg.querySelector('.cm-body');
  let curStatus = 'active';
  const close = () => { try { document.body.removeChild(bg); } catch (_) {} };
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.querySelector('.cm-close').addEventListener('click', close);
  bg.querySelectorAll('.cm-tab').forEach(t => t.addEventListener('click', () => {
    bg.querySelectorAll('.cm-tab').forEach(x => x.classList.remove('on')); t.classList.add('on');
    curStatus = t.dataset.st; load();
  }));
  bg.querySelector('.cm-addbtn').addEventListener('click', async () => {
    const content = bg.querySelector('.cm-input').value.trim(); if (!content) return;
    const category = bg.querySelector('.cm-cat').value;
    try { const r = await fetch('/api/ai/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ content, category }) });
      if (!r.ok) throw new Error('추가 실패'); bg.querySelector('.cm-input').value = ''; load();
    } catch (e) { alert(e.message); }
  });
  async function act(id, p, opt) { try { const r = await fetch('/api/ai/memory/' + id + p, Object.assign({ credentials: 'include' }, opt || {})); if (!r.ok) throw new Error('실패'); load(); } catch (e) { alert(e.message); } }
  async function load() {
    body.innerHTML = '<div class="cm-empty">불러오는 중…</div>';
    try {
      const r = await fetch('/api/ai/memory?status=' + curStatus, { credentials: 'include' });
      if (!r.ok) throw new Error('권한 없음 또는 오류 (' + r.status + ')');
      const d = await r.json(); const items = d.items || [];
      if (!items.length) { body.innerHTML = '<div class="cm-empty">항목이 없습니다.</div>'; return; }
      body.innerHTML = items.map(m => {
        const btns = curStatus === 'pending'
          ? '<button class="cm-approve" data-act="approve">승인</button><button class="cm-del" data-act="del">버림</button>'
          : curStatus === 'active'
            ? ('<button class="cm-pin" data-act="pin">' + (m.pinned ? '고정해제' : '📌고정') + '</button><button class="cm-del" data-act="del">삭제</button>')
            : '';
        return '<div class="cm-row" data-id="' + m.id + '" data-pinned="' + (m.pinned ? 1 : 0) + '"><div><div class="cm-c">' + escapeHtml(m.content) + '</div>'
          + '<div class="cm-meta">' + escapeHtml(m.category || '기타') + ' · ' + (m.source_kind || 'auto') + ' · ' + (m.hit_count || 1) + '회</div></div>'
          + '<div class="cm-btns">' + btns + '</div></div>';
      }).join('');
      body.querySelectorAll('.cm-row').forEach(row => {
        const id = row.dataset.id;
        row.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
          const a = b.dataset.act;
          if (a === 'approve') act(id, '/approve', { method: 'POST' });
          else if (a === 'del') act(id, '', { method: 'DELETE' });
          else if (a === 'pin') act(id, '/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: row.dataset.pinned !== '1' }) });
        }));
      });
    } catch (e) { body.innerHTML = '<div class="cm-empty">' + escapeHtml(e.message) + '</div>'; }
  }
  load();
}

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
  const backBtn = document.querySelector('.back-btn');
  if (backBtn) backBtn.style.display = 'none';
  const sidebarFooter = document.querySelector('.sidebar-footer');
  if (sidebarFooter) sidebarFooter.style.display = 'none';
  document.body.style.background = '#fff';
}

// 프리필: 저장소(ai-images)에서 "이걸로 다시" 로 넘어온 프롬프트를 이미지 모드 입력에 채움
(function applyPrefill() {
  let pre = '';
  try { pre = new URLSearchParams(location.search).get('prefill') || ''; } catch (_) {}
  if (!pre) return;
  // 이미지 모드 ON (picker 노출) + 입력 채우기
  if (!state.imageMode) imageModeBtn.click();
  input.value = pre;
  autoResize();
  setTimeout(() => { try { input.focus(); input.setSelectionRange(pre.length, pre.length); } catch(_){} }, 60);
})();

// 초기화: 스레드 목록 로드 후 → 마지막 보던 대화 자동 복원 (F5/탭이동 복원)
loadThreads().then(restoreLastThread);
loadProjects();
detectApiMode();
