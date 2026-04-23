/**
 * routes/workspace.js — 워크스페이스 (노션 스타일 문서 편집)
 */
const express = require('express');
const router = express.Router();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');

// ── 인증: /public/:token 외부 공유 뷰어만 로그인 없이 허용, 나머지는 전부 로그인 필수 ──
router.use((req, res, next) => {
  if (req.path.startsWith('/public/')) return next();
  return requireAuth(req, res, next);
});

const DB_PATH = path.join(__dirname, '..', 'data', '업무데이터.db');
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (e) {
  console.error('[workspace] SQLite 연결 실패:', e.message);
}

// ── 테이블 생성 ──
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '새 페이지',
      emoji TEXT DEFAULT '📄',
      content TEXT DEFAULT '{}',
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL DEFAULT '',
      shared INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // shared_with 컬럼이 아직 없으면 추가 (나중에 공유 대상 지정용)
  try { db.exec(`ALTER TABLE workspace_pages ADD COLUMN shared_with TEXT DEFAULT '[]'`); } catch(e) {}
}

// share_token 컬럼 추가 (외부 링크 공유용)
try { db.exec(`ALTER TABLE workspace_pages ADD COLUMN share_token TEXT DEFAULT NULL`); } catch(e) {}

function genId() { return crypto.randomBytes(8).toString('hex'); }
function genShareToken() { return crypto.randomBytes(16).toString('hex'); }

// ── 직원 목록 (공유 대상 선택용) ──
// 반환: [{ userId, name, dept (=부서 이름), deptId, position }]
router.get('/users', (req, res) => {
  try {
    const dbMain = require('../db');
    const uData = dbMain.loadUsers();
    // 부서 ID → 이름 매핑 테이블 (departments 는 {id, name} 을 가짐)
    const deptMap = {};
    (uData.departments || []).forEach(d => {
      if (d && d.id) deptMap[d.id] = d.name || '';
    });
    const users = (uData.users || [])
      .filter(u => u.status === 'approved')
      .map(u => {
        const deptId = u.department || '';
        const deptName = deptMap[deptId] || '';
        return {
          userId: u.userId,
          name: u.name,
          dept: deptName,         // 이름 (예: "디자인팀") · 없으면 빈 문자열
          deptId: deptId,
          position: u.position || '' // 직책/직급 (선택)
        };
      });
    res.json({ ok: true, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 페이지 목록 조회 ──
router.get('/pages', (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId 필수' });

    // 내 페이지 + 전체 공유 + 나에게 공유된 페이지
    const pages = db.prepare(`
      SELECT id, title, emoji, author_id, author_name, shared, shared_with, pinned, share_token, created_at, updated_at
      FROM workspace_pages
      ORDER BY pinned DESC, updated_at DESC
    `).all();

    // 필터: 내 페이지 OR 전체공유 OR shared_with에 내가 포함
    const filtered = pages.filter(p => {
      if (p.author_id === userId) return true;
      if (p.shared === 1) return true;  // 전체 공유
      try {
        const sharedWith = JSON.parse(p.shared_with || '[]');
        if (sharedWith.includes(userId)) return true;
      } catch(e) {}
      return false;
    }).map(p => {
      try { p.shared_with = JSON.parse(p.shared_with || '[]'); } catch(e) { p.shared_with = []; }
      return p;
    });

    res.json({ ok: true, pages: filtered });
  } catch (e) {
    console.error('[workspace] 목록 조회 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 페이지 상세 조회 ──
router.get('/pages/:id', (req, res) => {
  try {
    const page = db.prepare('SELECT * FROM workspace_pages WHERE id = ?').get(req.params.id);
    if (!page) return res.status(404).json({ error: '페이지 없음' });

    // content JSON 파싱
    try { page.content = JSON.parse(page.content); } catch(e) { page.content = {}; }
    try { page.shared_with = JSON.parse(page.shared_with || '[]'); } catch(e) { page.shared_with = []; }

    res.json({ ok: true, page });
  } catch (e) {
    console.error('[workspace] 상세 조회 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 페이지 생성 ──
router.post('/pages', (req, res) => {
  try {
    const { title, emoji, content, userId, userName } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId 필수' });

    const id = genId();
    db.prepare(`
      INSERT INTO workspace_pages (id, title, emoji, content, author_id, author_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, title || '새 페이지', emoji || '📄', JSON.stringify(content || {}), userId, userName || '');

    res.json({ ok: true, id });
  } catch (e) {
    console.error('[workspace] 생성 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 페이지 수정 ──
router.put('/pages/:id', (req, res) => {
  try {
    const { title, emoji, content, shared, pinned } = req.body;
    const page = db.prepare('SELECT * FROM workspace_pages WHERE id = ?').get(req.params.id);
    if (!page) return res.status(404).json({ error: '페이지 없음' });

    const updates = [];
    const params = [];

    if (title !== undefined) { updates.push('title = ?'); params.push(title); }
    if (emoji !== undefined) { updates.push('emoji = ?'); params.push(emoji); }
    if (content !== undefined) { updates.push('content = ?'); params.push(JSON.stringify(content)); }
    if (shared !== undefined) { updates.push('shared = ?'); params.push(shared ? 1 : 0); }
    if (pinned !== undefined) { updates.push('pinned = ?'); params.push(pinned ? 1 : 0); }
    if (req.body.shared_with !== undefined) { updates.push('shared_with = ?'); params.push(JSON.stringify(req.body.shared_with)); }

    updates.push("updated_at = datetime('now','localtime')");
    params.push(req.params.id);

    db.prepare(`UPDATE workspace_pages SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    res.json({ ok: true });
  } catch (e) {
    console.error('[workspace] 수정 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 페이지 삭제 ──
router.delete('/pages/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM workspace_pages WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[workspace] 삭제 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 외부 공유 링크 생성/해제 ──
router.post('/pages/:id/share-link', (req, res) => {
  try {
    const page = db.prepare('SELECT * FROM workspace_pages WHERE id = ?').get(req.params.id);
    if (!page) return res.status(404).json({ error: '페이지 없음' });

    const token = genShareToken();
    db.prepare('UPDATE workspace_pages SET share_token = ? WHERE id = ?').run(token, req.params.id);
    res.json({ ok: true, share_token: token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/pages/:id/share-link', (req, res) => {
  try {
    db.prepare('UPDATE workspace_pages SET share_token = NULL WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 외부 공개 페이지 조회 (로그인 불필요) ──
// 공격 표면: share_token 만 알면 누구나 호출 가능 → 반환 데이터를 엄격히 정제한다.
// - block type 화이트리스트 (Editor.js 스펙에 있는 타입만)
// - 이미지 URL 스킴 화이트리스트 (http/https/상대경로/data:image/)
// - 블록 개수 상한 / 텍스트 길이 상한
// - 텍스트 안 inline HTML 의 제어는 클라이언트 DOMPurify 가 담당 (여기선 구조만 검증)
const PUBLIC_VIEW_LIMITS = {
  MAX_BLOCKS: 500,
  MAX_TEXT_LEN: 20000,
  MAX_LIST_ITEMS: 500
};
const PUBLIC_ALLOWED_BLOCK_TYPES = new Set(['header','paragraph','checklist','list','quote','delimiter','image']);

function publicSafeImgUrl(u) {
  if (!u || typeof u !== 'string') return '';
  const t = u.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^\/[^\/]/.test(t)) return t;                      // 내부 상대경로
  if (/^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/i.test(t)) return t;
  return '';
}
function publicSafeText(v) {
  if (v == null) return '';
  const s = String(v);
  return s.length > PUBLIC_VIEW_LIMITS.MAX_TEXT_LEN ? s.slice(0, PUBLIC_VIEW_LIMITS.MAX_TEXT_LEN) : s;
}
function sanitizePublicContent(raw) {
  if (!raw || typeof raw !== 'object') return { blocks: [] };
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  const out = [];
  for (const b of blocks) {
    if (out.length >= PUBLIC_VIEW_LIMITS.MAX_BLOCKS) break;
    if (!b || typeof b !== 'object' || !PUBLIC_ALLOWED_BLOCK_TYPES.has(b.type)) continue;
    const data = (b.data && typeof b.data === 'object') ? b.data : {};
    if (b.type === 'header') {
      const lvl = (data.level === 3) ? 3 : 2;
      out.push({ type: 'header', data: { text: publicSafeText(data.text), level: lvl } });
    } else if (b.type === 'paragraph') {
      out.push({ type: 'paragraph', data: { text: publicSafeText(data.text) } });
    } else if (b.type === 'checklist') {
      const items = (Array.isArray(data.items) ? data.items : [])
        .slice(0, PUBLIC_VIEW_LIMITS.MAX_LIST_ITEMS)
        .map(it => ({
          text: publicSafeText(it && it.text),
          checked: !!(it && it.checked)
        }));
      out.push({ type: 'checklist', data: { items } });
    } else if (b.type === 'list') {
      const style = (data.style === 'ordered') ? 'ordered' : 'unordered';
      const items = (Array.isArray(data.items) ? data.items : [])
        .slice(0, PUBLIC_VIEW_LIMITS.MAX_LIST_ITEMS)
        .map(publicSafeText);
      out.push({ type: 'list', data: { style, items } });
    } else if (b.type === 'quote') {
      out.push({ type: 'quote', data: {
        text: publicSafeText(data.text),
        caption: publicSafeText(data.caption)
      } });
    } else if (b.type === 'delimiter') {
      out.push({ type: 'delimiter', data: {} });
    } else if (b.type === 'image') {
      const rawUrl = (data && data.file && data.file.url) || '';
      const url = publicSafeImgUrl(rawUrl);
      if (!url) continue;  // 위험한 URL 은 블록 자체를 드롭
      out.push({
        type: 'image',
        data: {
          file: { url },
          caption: publicSafeText(data.caption),
          withBorder: !!data.withBorder,
          withBackground: !!data.withBackground,
          stretched: !!data.stretched
        }
      });
    }
  }
  return { blocks: out };
}

router.get('/public/:token', (req, res) => {
  try {
    // 토큰 형태 검증 (crypto.randomBytes(16).toString('hex') → 32자 hex)
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{16,64}$/.test(token)) {
      return res.status(404).json({ error: '페이지를 찾을 수 없거나 공유가 중지되었습니다.' });
    }
    const page = db.prepare('SELECT id, title, emoji, content, author_name, updated_at FROM workspace_pages WHERE share_token = ?').get(token);
    if (!page) return res.status(404).json({ error: '페이지를 찾을 수 없거나 공유가 중지되었습니다.' });

    let parsed = {};
    try { parsed = JSON.parse(page.content); } catch(e) { parsed = {}; }

    // 출력 정제 — 제목/이모지/작성자도 길이 상한만 적용 (클라이언트에서 textContent 로 넣음)
    const safePage = {
      id: page.id,
      title: publicSafeText(page.title).slice(0, 200),
      emoji: publicSafeText(page.emoji).slice(0, 8),
      author_name: publicSafeText(page.author_name).slice(0, 60),
      updated_at: page.updated_at,
      content: sanitizePublicContent(parsed)
    };
    res.json({ ok: true, page: safePage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Claude AI 도우미 (Claude CLI 사용 — Pro Max 구독) ──
//
// 두 가지 동작 모드:
//   1) 일반 모드 (mode 없음): prompt/content 기반 텍스트 응답. 기존 사이드바 "빠른 도움" 버튼용.
//   2) 템플릿 모드 (mode = daily_log | project_checklist | customer_report):
//      직원이 던져준 거친 메모를 받아서 Editor.js 블록 배열(JSON)로 반환.
//      프론트는 이 blocks를 현재 페이지 에디터에 직접 삽입.
//
const JSON_FORMAT_RULE = [
  '응답은 순수 JSON 객체 하나로만 출력하세요.',
  '코드 펜스(```), 주석, 설명 문장은 절대 붙이지 마세요.',
  '',
  '스키마:',
  '{',
  '  "blocks": [',
  '    { "type": "header", "data": { "text": "...", "level": 2 } },',
  '    { "type": "paragraph", "data": { "text": "..." } },',
  '    { "type": "checklist", "data": { "items": [{"text":"...", "checked": false}] } },',
  '    { "type": "list", "data": { "style": "unordered", "items": ["...", "..."] } },',
  '    { "type": "quote", "data": { "text": "...", "caption": "" } },',
  '    { "type": "delimiter", "data": {} }',
  '  ]',
  '}',
  '',
  '사용 가능한 block type: header(level은 2 또는 3), paragraph, checklist, list(style은 "ordered" 또는 "unordered"), quote, delimiter.',
  '그 외 type은 쓰지 마세요.'
].join('\n');

const AI_TEMPLATES = {
  daily_log: [
    '당신은 대림컴퍼니(간판/현수막 제작업체) 직원의 일일 업무일지 작성을 돕는 AI입니다.',
    '사용자가 던져준 거친 메모를 받아서 깔끔한 업무일지 블록 구조로 만들어 주세요.',
    '',
    '권장 구성:',
    '- header(level 2): 오늘 날짜 + " 업무일지" (예: "2026-04-17 업무일지")',
    '- header(level 3): "오늘 완료한 일"',
    '- checklist: 완료한 일 (checked: true)',
    '- header(level 3): "이어서 할 일"',
    '- checklist: 남은 할 일 (checked: false)',
    '- header(level 3): "특이사항 / 메모"',
    '- paragraph: 기타 메모, 이슈, 참고사항 (없으면 생략)',
    '',
    '빈 항목은 생략하고, 메모에 없는 내용을 창작하지 마세요.',
    JSON_FORMAT_RULE
  ].join('\n'),

  project_checklist: [
    '당신은 대림컴퍼니(간판/현수막 제작업체) 프로젝트 체크리스트를 만드는 AI입니다.',
    '사용자가 프로젝트명과 간단한 설명을 주면, 제작 흐름에 맞게 단계별 To-do를 만들어 주세요.',
    '',
    '권장 구성:',
    '- header(level 2): 프로젝트명',
    '- paragraph: 한두 줄 요약',
    '- header(level 3): "1. 기획 / 시안"',
    '- checklist: 시안 디자인, 고객 승인 등',
    '- header(level 3): "2. 제작"',
    '- checklist: 재료 발주, 공장 작업, 검수',
    '- header(level 3): "3. 배송 / 설치"',
    '- checklist: 납품, 현장 시공',
    '- header(level 3): "4. 마무리"',
    '- checklist: 정산, 세금계산서, 사후 점검',
    '',
    '모든 checklist 항목은 checked: false로 두세요. 항목에 없는 단계는 생략 가능합니다.',
    JSON_FORMAT_RULE
  ].join('\n'),

  customer_report: [
    '당신은 대림컴퍼니 고객 대응 글(보고서 / 이메일 / 카톡 회신)을 정리하는 AI입니다.',
    '직원의 거친 메모를 받아서 고객에게 그대로 보내도 될 정도로 정중하게 다듬어 주세요.',
    '',
    '권장 구성:',
    '- header(level 2): 제목 (예: "○○고객사 납품 진행 보고")',
    '- paragraph: 정중한 인사말 + 한두 줄 요약',
    '- header(level 3): "주요 내용"',
    '- list(unordered): 핵심 항목 3~5개',
    '- header(level 3): "다음 단계"',
    '- checklist: 이후 진행사항 (checked: false)',
    '- delimiter',
    '- quote: 고객에게 복사-붙여넣기로 바로 보낼 수 있는 경어체 회신 문구 (caption은 빈 문자열)',
    '',
    '메모에 없는 사실을 만들어내지 말고, 모호한 부분은 회신 문구에서 "추후 확인 후 안내드리겠습니다" 식으로 처리하세요.',
    JSON_FORMAT_RULE
  ].join('\n'),
};

// Claude 응답 텍스트에서 JSON 덩어리 추출 + blocks 배열 파싱
function extractBlocks(text) {
  if (!text) return null;
  let json = text.trim();

  // ```json ... ``` 또는 ``` ... ``` 코드 펜스 제거
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) json = fence[1].trim();

  // 최초 '{' 부터 마지막 '}' 까지
  const s = json.indexOf('{');
  const e = json.lastIndexOf('}');
  if (s >= 0 && e > s) json = json.slice(s, e + 1);

  let obj;
  try { obj = JSON.parse(json); }
  catch (_) { return null; }

  const blocks = Array.isArray(obj) ? obj : (Array.isArray(obj && obj.blocks) ? obj.blocks : null);
  if (!blocks) return null;

  // Editor.js가 받을 수 있는 블록만 필터링 + 최소한의 구조 보정
  const VALID = new Set(['header', 'paragraph', 'checklist', 'list', 'quote', 'delimiter']);
  const safe = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object' || !VALID.has(b.type)) continue;
    const data = b.data || {};
    if (b.type === 'header') {
      const lvl = (data.level === 3) ? 3 : 2;
      safe.push({ type: 'header', data: { text: String(data.text || ''), level: lvl } });
    } else if (b.type === 'paragraph') {
      safe.push({ type: 'paragraph', data: { text: String(data.text || '') } });
    } else if (b.type === 'checklist') {
      const items = Array.isArray(data.items) ? data.items.map(it => ({
        text: String((it && it.text) || ''),
        checked: !!(it && it.checked)
      })) : [];
      safe.push({ type: 'checklist', data: { items } });
    } else if (b.type === 'list') {
      const style = (data.style === 'ordered') ? 'ordered' : 'unordered';
      const items = Array.isArray(data.items) ? data.items.map(String) : [];
      safe.push({ type: 'list', data: { style, items } });
    } else if (b.type === 'quote') {
      safe.push({ type: 'quote', data: { text: String(data.text || ''), caption: String(data.caption || ''), alignment: 'left' } });
    } else if (b.type === 'delimiter') {
      safe.push({ type: 'delimiter', data: {} });
    }
  }
  return safe;
}

router.post('/ai', async (req, res) => {
  try {
    const { prompt, content, mode } = req.body || {};
    const tmpl = mode && AI_TEMPLATES[mode];

    if (!tmpl && !prompt) {
      return res.status(400).json({ error: 'prompt 또는 mode 필수' });
    }

    const { execFile, spawn } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    // 프롬프트 구성
    let fullPrompt;
    if (tmpl) {
      const userMemo = (prompt || '').trim();
      const existing = (content || '').trim();
      fullPrompt = [
        tmpl,
        '',
        existing ? '【참고: 현재 페이지 기존 내용】\n' + existing + '\n' : '',
        '【사용자 메모】',
        userMemo || '(메모 없음)'
      ].filter(Boolean).join('\n');
    } else {
      fullPrompt = content
        ? `당신은 ERP 시스템 내 워크스페이스 AI 도우미입니다. 한국어로 간결하고 실용적으로 답변해주세요.\n\n다음은 사용자의 문서 내용입니다:\n\n${content}\n\n사용자 요청: ${prompt}`
        : `당신은 ERP 시스템 내 워크스페이스 AI 도우미입니다. 한국어로 간결하고 실용적으로 답변해주세요.\n\n${prompt}`;
    }

    // Claude CLI --print 모드 사용 (Pro Max 구독으로 동작)
    // ──────────────────────────────────────────────────
    // - Windows 에서 claude.cmd 도 찾을 수 있도록 shell: true
    // - 프롬프트는 argv 가 아닌 stdin 으로 전달해서 cmd 이스케이프 문제 원천 차단
    //   (한국어/줄바꿈/특수문자 안전)
    const aiText = await new Promise((resolve, reject) => {
      const child = spawn('claude', ['-p'], {
        shell: true,  // Windows claude.cmd 호환
        env: { ...process.env, LANG: 'ko_KR.UTF-8' },
        windowsHide: true
      });
      let out = '', err = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch(_) {}
        reject(new Error('timeout'));
      }, 90000);
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          const msg = (err || '').trim() || `claude CLI exited with code ${code}`;
          return reject(new Error(msg));
        }
        resolve((out || '').trim());
      });
      // 프롬프트를 stdin 으로 전달 (argv 회피)
      child.stdin.write(fullPrompt, 'utf8');
      child.stdin.end();
    });
    if (!aiText) return res.status(500).json({ error: 'Claude 응답이 비어있습니다.' });

    // 템플릿 모드: blocks JSON 파싱 후 반환
    if (tmpl) {
      const blocks = extractBlocks(aiText);
      if (!blocks || blocks.length === 0) {
        console.error('[workspace] AI 블록 파싱 실패. 원본(앞 500자):', aiText.slice(0, 500));
        return res.status(500).json({
          error: 'Claude 응답을 블록 구조로 변환하지 못했습니다. 다시 시도해주세요.',
          raw: aiText.slice(0, 2000)
        });
      }
      return res.json({ ok: true, mode, blocks, count: blocks.length });
    }

    // 일반 모드: 텍스트 그대로 반환
    res.json({ ok: true, result: aiText });
  } catch (e) {
    console.error('[workspace] AI 오류:', e.message);

    // Claude CLI가 없거나 인증 안 된 경우 안내
    if (e.message.includes('ENOENT') || e.message.includes('not found')) {
      return res.status(500).json({ error: 'Claude CLI가 설치되지 않았습니다. 서버에 Claude Code를 설치해주세요.' });
    }
    if (e.message.includes('timeout')) {
      return res.status(500).json({ error: 'Claude 응답 시간 초과. 잠시 후 다시 시도해주세요.' });
    }

    res.status(500).json({ error: e.message });
  }
});

// AI 진단 엔드포인트 — 서버에 claude CLI 가 제대로 있는지, 인증 돼있는지 확인
// GET /api/workspace/ai-health
// 응답: { ok, cliAvailable, authenticated, version, sample, error? }
router.get('/ai-health', async (req, res) => {
  const { spawn } = require('child_process');

  function run(args, input) {
    return new Promise((resolve) => {
      try {
        const child = spawn('claude', args, {
          shell: true,
          env: { ...process.env, LANG: 'ko_KR.UTF-8' },
          windowsHide: true
        });
        let out = '', err = '';
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch(_) {}
          resolve({ code: -1, out, err: err + '\n[timeout]' });
        }, 30000);
        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { err += d.toString('utf8'); });
        child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
        if (input) { child.stdin.write(input, 'utf8'); }
        child.stdin.end();
      } catch(e) {
        resolve({ code: -1, out: '', err: e.message });
      }
    });
  }

  // 1단계: claude --version
  const v = await run(['--version'], null);
  const cliAvailable = v.code === 0 && /\d/.test(v.out);
  if (!cliAvailable) {
    return res.json({
      ok: false,
      cliAvailable: false,
      authenticated: false,
      error: 'Claude CLI 미설치 또는 PATH 에 없음',
      detail: v.err || v.out || ''
    });
  }

  // 2단계: 실제 프롬프트로 인증 확인
  const p = await run(['-p'], 'ping');
  const authenticated = p.code === 0 && p.out.length > 0;

  res.json({
    ok: authenticated,
    cliAvailable: true,
    authenticated,
    version: v.out,
    sample: p.out.slice(0, 200),
    error: authenticated ? null : '인증 실패 또는 응답 없음',
    detail: authenticated ? null : (p.err || p.out).slice(0, 500)
  });
});

// 내부 테스트용 — blocks 파서 단독 검증
router.post('/ai-parse-test', (req, res) => {
  try {
    const { text } = req.body || {};
    const blocks = extractBlocks(text || '');
    res.json({ ok: true, blocks, count: blocks ? blocks.length : 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 이미지 업로드 (Editor.js ImageTool 용) ─────────────────
// 요청: { imageData: 'data:image/...;base64,...' , fileName?: string }
//       또는 { url: 'http...' } (URL 임베드 그대로 반환)
// 응답: { success: 1, file: { url } }  ← Editor.js ImageTool 스펙
const IMG_DIR = path.join(__dirname, '..', 'data', 'workspace-images');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

router.post('/upload-image', (req, res) => {
  try {
    const { imageData, fileName, url } = req.body || {};

    // URL 임베드 모드 — 외부 URL 그대로
    if (url && typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return res.json({ success: 1, file: { url } });
    }

    if (!imageData || typeof imageData !== 'string') {
      return res.status(400).json({ success: 0, error: 'imageData required' });
    }

    const m = imageData.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) {
      return res.status(400).json({ success: 0, error: 'invalid base64 image' });
    }

    const mime = m[1];
    const ext = (mime.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const buffer = Buffer.from(m[2], 'base64');

    // 10MB 제한
    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ success: 0, error: '10MB 이하만 업로드 가능합니다' });
    }

    const safeBase = (fileName || 'img').toString().replace(/[^a-zA-Z0-9가-힣_-]/g, '_').slice(0, 40);
    const finalName = `${safeBase}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    fs.writeFileSync(path.join(IMG_DIR, finalName), buffer);

    // 서버에 이미 app.use('/data', express.static(...)) 있으므로 /data/... 경로로 바로 서빙됨
    const publicUrl = `/data/workspace-images/${finalName}`;
    res.json({ success: 1, file: { url: publicUrl } });
  } catch (e) {
    console.error('[workspace] upload-image 오류:', e.message);
    res.status(500).json({ success: 0, error: e.message });
  }
});

// ── AI 이미지 생성 (Gemini CLI + nanobanana MCP) ──────────
// 요청: { prompt: '이미지 설명' }
// 응답: { success: 1, file: { url, caption } }  ← Editor.js ImageTool 호환
router.post('/ai-image', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ success: 0, error: 'prompt 필수' });
    }

    const { spawn } = require('child_process');
    const crypto = require('crypto');

    // 임시 작업 폴더 (gemini 의 cwd 로 지정해서 파일 저장 위치 강제)
    const workId = Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const workDir = path.join(IMG_DIR, 'ai-temp-' + workId);
    fs.mkdirSync(workDir, { recursive: true });

    // Gemini 에게 전달할 프롬프트
    // - nanobanana MCP 로 이미지 생성 요청
    // - 현재 폴더(workDir) 에 output.png 로 저장하도록 명시
    // - 다른 설명 없이 이미지만 생성
    const fullPrompt = [
      '다음 이미지를 생성해서 반드시 현재 폴더에 "output.png" 파일로 저장해주세요.',
      '다른 파일은 만들지 말고 이미지 하나만 생성하세요.',
      '',
      '이미지 설명:',
      prompt.trim()
    ].join('\n');

    // Gemini CLI 실행 (-y = yolo, MCP 툴 자동 승인)
    // 프롬프트를 임시파일로 저장 → shell redirect 로 stdin 주입
    // Gemini CLI 는 -p/--prompt 값이 필수이므로 placeholder 를 넘기고 실제 프롬프트는 stdin 으로 보낸다
    const promptFile = path.join(workDir, `_prompt_${Date.now()}_${Math.random().toString(36).slice(2,6)}.txt`);
    fs.writeFileSync(promptFile, fullPrompt, 'utf8');

    const aiOutput = await new Promise((resolve, reject) => {
      const cmd = `gemini -y -p "generate-image" < "${promptFile}"`;
      const child = spawn(cmd, {
        shell: true,                  // Windows gemini.cmd 호환
        cwd: workDir,                 // 이미지 저장 기준 폴더
        env: { ...process.env, LANG: 'ko_KR.UTF-8' },
        windowsHide: true
      });
      let out = '', err = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch(_) {}
        reject(new Error('timeout'));
      }, 180000);  // 이미지 생성은 최대 3분까지 기다림
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); try { fs.unlinkSync(promptFile); } catch(_){} reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        try { fs.unlinkSync(promptFile); } catch(_) {}
        if (code !== 0) {
          const msg = (err || '').trim() || `gemini CLI exited with code ${code}`;
          return reject(new Error(msg));
        }
        resolve({ out, err });
      });
    });

    // 생성된 이미지 파일 탐색
    let generatedFiles = [];
    try {
      generatedFiles = fs.readdirSync(workDir).filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f));
    } catch (e) {
      console.error('[workspace/ai-image] workDir 읽기 실패:', e.message);
    }

    if (generatedFiles.length === 0) {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(_) {}
      console.error('[workspace/ai-image] 이미지 미생성. stdout(앞 500자):', aiOutput.out.slice(0, 500));
      return res.status(500).json({
        success: 0,
        error: 'Gemini가 이미지를 생성하지 않았습니다. 프롬프트를 다시 작성하거나 잠시 후 다시 시도해주세요.',
        hint: aiOutput.out.slice(0, 500)
      });
    }

    // 첫 이미지를 영구 폴더로 이동
    const srcName = generatedFiles[0];
    const srcFile = path.join(workDir, srcName);
    const ext = (path.extname(srcName) || '.png').toLowerCase();
    const finalName = `ai_${workId}${ext}`;
    const destFile = path.join(IMG_DIR, finalName);

    try {
      fs.renameSync(srcFile, destFile);
    } catch (e) {
      // rename 실패 시 복사+삭제 폴백 (드라이브 경계 차이 등)
      try {
        fs.copyFileSync(srcFile, destFile);
        fs.unlinkSync(srcFile);
      } catch (e2) {
        console.error('[workspace/ai-image] 파일 이동 실패:', e2.message);
      }
    }

    // 임시 폴더 정리 (생성된 다른 파일까지 함께 삭제)
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(_) {}

    const publicUrl = `/data/workspace-images/${finalName}`;
    return res.json({
      success: 1,
      file: { url: publicUrl },
      caption: prompt.trim().slice(0, 100)
    });

  } catch (e) {
    console.error('[workspace/ai-image] 오류:', e.message);

    if (e.message.includes('ENOENT') || e.message.includes('not found') || e.message.includes('is not recognized')) {
      return res.status(500).json({ success: 0, error: 'Gemini CLI가 서버에 설치되지 않았거나 PATH 에 없습니다.' });
    }
    if (e.message.includes('timeout')) {
      return res.status(500).json({ success: 0, error: '이미지 생성 시간 초과 (3분). 더 단순한 프롬프트로 다시 시도해주세요.' });
    }

    return res.status(500).json({ success: 0, error: e.message });
  }
});

// ── AI 이미지 기능 진단 (Gemini CLI 설치 + nanobanana 확장 체크) ──
// GET /api/workspace/ai-image-health
router.get('/ai-image-health', async (req, res) => {
  const { spawn } = require('child_process');

  function run(args, timeoutMs) {
    return new Promise((resolve) => {
      try {
        const child = spawn('gemini', args, {
          shell: true,
          env: { ...process.env, LANG: 'ko_KR.UTF-8' },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        let out = '', err = '';
        const timer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch(_) {}
          resolve({ code: -1, out, err: err + '\n[timeout]' });
        }, timeoutMs || 10000);
        child.stdout.on('data', d => { out += d.toString('utf8'); });
        child.stderr.on('data', d => { err += d.toString('utf8'); });
        child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
        // stdin 바로 닫기 — gemini 가 stdin 을 대화형 입력으로 대기하지 않도록
        try { child.stdin.end(); } catch(_) {}
      } catch (e) {
        resolve({ code: -1, out: '', err: e.message });
      }
    });
  }

  // 파일시스템 직접 체크: %USERPROFILE%\.gemini\extensions\nanobanana 폴더 존재 여부
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const nanobananaPath = userProfile ? path.join(userProfile, '.gemini', 'extensions', 'nanobanana') : '';
  const nanobananaDirExists = nanobananaPath ? fs.existsSync(nanobananaPath) : false;

  // 1. gemini --version
  const v = await run(['--version'], 8000);
  const cliAvailable = v.code === 0 && /\d/.test(v.out);
  if (!cliAvailable) {
    return res.json({
      ok: false,
      cliAvailable: false,
      nanobananaInstalled: false,
      nanobananaDirExists,
      nanobananaPath,
      userProfile,
      error: 'Gemini CLI 미설치 또는 PATH 에 없음',
      versionStdout: v.out,
      versionStderr: v.err,
      detail: (v.err || v.out || '').slice(0, 300)
    });
  }

  // 2. gemini extensions list → nanobanana 포함 여부
  const ext = await run(['extensions', 'list'], 20000);
  const nanobananaViaCli = /nanobanana/i.test(ext.out) || /nanobanana/i.test(ext.err);

  // 둘 중 하나라도 감지되면 설치된 것으로 간주 (파일시스템이 더 신뢰할 수 있음)
  const nanobananaInstalled = nanobananaDirExists || nanobananaViaCli;

  res.json({
    ok: cliAvailable && nanobananaInstalled,
    cliAvailable: true,
    nanobananaInstalled,
    nanobananaDirExists,      // fs.existsSync 결과
    nanobananaViaCli,          // gemini extensions list 결과
    nanobananaPath,            // 체크한 폴더 경로
    userProfile,               // 서버 프로세스의 USERPROFILE
    version: v.out,
    extensionsStdout: ext.out.slice(0, 500),
    extensionsStderr: ext.err.slice(0, 500),
    extensionsExitCode: ext.code,
    error: nanobananaInstalled ? null : 'nanobanana 확장이 설치되지 않았습니다.'
  });
});

module.exports = router;
