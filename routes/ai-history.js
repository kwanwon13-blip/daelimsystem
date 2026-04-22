/**
 * routes/ai-history.js — AI 프로젝트/스레드/메시지/템플릿/첨부 REST API
 *
 * 마운트: /api/ai
 * 인증: requireAuth 적용
 * 4단계 공유: private | team | company | invited
 *
 * 엔드포인트
 *   GET    /projects                     프로젝트 목록 (내것 + 공유)
 *   POST   /projects                     프로젝트 생성
 *   GET    /projects/:id                 프로젝트 상세
 *   PUT    /projects/:id                 프로젝트 수정
 *   DELETE /projects/:id                 프로젝트 삭제 (스레드는 미분류로)
 *   GET    /projects/:id/members         초대된 멤버 목록
 *
 *   GET    /threads                      스레드 목록 (?projectId=&q=&limit=&offset=&scope=mine|shared|project)
 *   POST   /threads                      스레드 생성
 *   GET    /threads/:id                  스레드 + 메시지 전체
 *   PUT    /threads/:id                  제목/프로젝트 변경
 *   DELETE /threads/:id                  삭제
 *
 *   POST   /chat                         대화 한 턴 (새 스레드 or 기존에 이어서)
 *                                        { threadId?, projectId?, prompt, pageContent?,
 *                                          attachmentIds?, templateId?, sourcePageId?, mode? }
 *   POST   /chat-image                   이미지 생성 + 스레드 저장
 *                                        { threadId?, projectId?, prompt, sourcePageId? }
 *
 *   GET    /templates                    템플릿 목록 (?scope=mine|visible)
 *   POST   /templates                    생성
 *   PUT    /templates/:id                수정
 *   DELETE /templates/:id                삭제
 *
 *   POST   /attachments                  파일 업로드 (multipart/form-data: file)
 *   GET    /attachments/:id              메타 조회
 *   DELETE /attachments/:id              삭제
 *
 *   GET    /users                        공유 대상 선택용 직원 목록
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const ai = require('../db-ai');

let multer;
try { multer = require('multer'); } catch(e) { multer = null; }

// ──────────────────────────────────────────────────────────
// 모든 라우트 인증 필수
// ──────────────────────────────────────────────────────────
router.use(requireAuth);

// 헬스체크 — DB 초기화 여부 (ready:false 라도 200 으로 내려줌)
router.get('/health', (req, res) => {
  res.json({ ok: true, ready: !!ai.ready });
});

// DB 비사용 시 나머지 전체 503
router.use((req, res, next) => {
  if (!ai.ready) {
    return res.status(503).json({
      error: 'AI 히스토리 DB 가 준비되지 않았습니다. better-sqlite3 설치가 필요합니다.',
      code: 'AI_DB_NOT_READY'
    });
  }
  next();
});

function isAdmin(req) { return req.user && req.user.role === 'admin'; }

// ──────────────────────────────────────────────────────────
// 직원 목록 (공유 대상용)
// ──────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  try {
    const dbMain = require('../db');
    const uData = dbMain.loadUsers();
    const users = (uData.users || [])
      .filter(u => u.status === 'approved')
      .map(u => ({
        userId: u.userId,
        name: u.name,
        company: u.company || '',
        department: u.department || '',
        departments: u.departments || [],
        dept: u.department || ''
      }));
    // 내 팀원 정보도 같이
    const my = ai.getUserDept(req.user.userId);
    res.json({ ok: true, users, myDept: my });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// 프로젝트
// ──────────────────────────────────────────────────────────
router.get('/projects', (req, res) => {
  try {
    const list = ai.projects.list(req.user.userId, { isAdmin: isAdmin(req) });
    // 각 프로젝트의 스레드 개수, 초대된 멤버 수 붙여주기
    const enriched = list.map(p => {
      const isMine = String(p.owner_id) === String(req.user.userId);
      const threadCount = ai.db.prepare('SELECT COUNT(*) AS c FROM ai_threads WHERE project_id=?')
        .get(p.id).c;
      let memberCount = 0;
      if (p.share_mode === 'invited') {
        memberCount = ai.db.prepare('SELECT COUNT(*) AS c FROM ai_project_members WHERE project_id=?')
          .get(p.id).c;
      }
      // 초대된 멤버 ID 배열 (편집 UI 용)
      let memberIds = [];
      if (p.share_mode === 'invited') {
        memberIds = ai.projects.members(p.id).map(m => m.user_id);
      }
      return { ...p, is_mine: isMine, thread_count: threadCount, member_count: memberCount, member_ids: memberIds };
    });
    res.json({ ok: true, projects: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/projects', (req, res) => {
  try {
    const b = req.body || {};
    const name = b.name;
    const emoji = b.emoji;
    const description = b.description;
    // 프론트는 share_mode / member_ids, 내부는 shareMode / members — 둘 다 수용
    const shareMode = b.shareMode || b.share_mode;
    const members = b.members || b.member_ids;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name 필수' });
    const valid = ['private', 'team', 'company', 'invited'];
    const mode = valid.includes(shareMode) ? shareMode : 'private';
    const p = ai.projects.create({
      ownerId: req.user.userId,
      ownerName: req.user.name,
      name: String(name).trim().slice(0, 60),
      emoji: emoji || '📁',
      description: description || '',
      shareMode: mode,
      members
    });
    res.json({ ok: true, project: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/projects/:id', (req, res) => {
  try {
    const p = ai.projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '프로젝트 없음' });
    if (!ai.canViewProject(p, req.user.userId, isAdmin(req))) {
      return res.status(403).json({ error: '권한 없음' });
    }
    p.members = p.share_mode === 'invited' ? ai.projects.members(p.id) : [];
    res.json({ ok: true, project: p });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/projects/:id', (req, res) => {
  try {
    const p = ai.projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '프로젝트 없음' });
    if (!ai.canEditProject(p, req.user.userId)) return res.status(403).json({ error: '소유자만 수정 가능' });
    const b = req.body || {};
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).trim().slice(0, 60);
    if (b.emoji !== undefined) patch.emoji = b.emoji;
    if (b.description !== undefined) patch.description = b.description;
    const shareMode = b.share_mode || b.shareMode;
    const memberIds = b.member_ids || b.members;
    const valid = ['private', 'team', 'company', 'invited'];
    if (shareMode && valid.includes(shareMode)) patch.share_mode = shareMode;
    if (Array.isArray(memberIds)) patch.members = memberIds;
    const updated = ai.projects.update(p.id, patch);
    res.json({ ok: true, project: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/projects/:id', (req, res) => {
  try {
    const p = ai.projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '프로젝트 없음' });
    if (!ai.canEditProject(p, req.user.userId)) return res.status(403).json({ error: '소유자만 삭제 가능' });
    ai.projects.delete(p.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/projects/:id/members', (req, res) => {
  try {
    const p = ai.projects.get(req.params.id);
    if (!p) return res.status(404).json({ error: '프로젝트 없음' });
    if (!ai.canViewProject(p, req.user.userId, isAdmin(req))) return res.status(403).json({ error: '권한 없음' });
    res.json({ ok: true, members: ai.projects.members(p.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// 스레드
// ──────────────────────────────────────────────────────────
router.get('/threads', (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    // 프론트 scope: mine / team / company / invited / projects
    const uiScope = req.query.scope || 'mine';
    // 'projects' 는 프로젝트 목록 자체를 로드하는 모드이므로 스레드 목록에서는 빈 결과
    if (uiScope === 'projects') {
      return res.json({ ok: true, threads: [], total: 0, limit, offset, hasMore: false });
    }
    let scope = uiScope;
    if (scope === 'team' || scope === 'company' || scope === 'invited') scope = 'shared';
    // project 또는 projectId 둘 다 허용 (AI 탭은 project, 워크스페이스는 projectId 를 보냄)
    let projectId = req.query.project !== undefined ? req.query.project : req.query.projectId;
    if (projectId === 'null' || projectId === '') projectId = null;
    else if (projectId !== undefined) projectId = parseInt(projectId, 10);
    // 프로젝트 지정 시에는 scope 무관하게 본인이 볼 수 있는 모든 스레드를 가져온다
    if (projectId) scope = isAdmin(req) ? 'all' : 'shared';

    const result = ai.threads.list(req.user.userId, {
      projectId, q: req.query.q || '', limit, offset, scope,
      isAdmin: isAdmin(req)
    });

    // shared 모드일 때 프론트가 넘겨준 구체 scope(team/company/invited) 로 share_mode 매칭
    const projCache = {};
    let items = result.items;
    if (['team','company','invited'].includes(uiScope) && !projectId) {
      items = items.filter(t => {
        if (!t.project_id) return false;
        if (!projCache[t.project_id]) projCache[t.project_id] = ai.projects.get(t.project_id);
        const pr = projCache[t.project_id];
        return pr && pr.share_mode === uiScope;
      });
    }

    // 각 스레드에 프로젝트 이모지 + share_mode 붙여서 프론트 표시에 사용
    for (const t of items) {
      if (t.project_id && !projCache[t.project_id]) {
        projCache[t.project_id] = ai.projects.get(t.project_id);
      }
      const pr = projCache[t.project_id];
      if (pr) {
        t.project_emoji = pr.emoji || '📁';
        t.project_name = pr.name;
        t.share_mode = pr.share_mode;
      } else {
        t.share_mode = 'private';
      }
    }
    res.json({
      ok: true,
      threads: items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: (result.offset + result.items.length) < result.total
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/threads', (req, res) => {
  try {
    const { projectId, title, sourcePageId } = req.body || {};
    const t = ai.threads.create({
      ownerId: req.user.userId,
      ownerName: req.user.name,
      projectId: projectId === undefined || projectId === null || projectId === '' ? null : parseInt(projectId, 10),
      title: (title || '새 대화').slice(0, 120),
      sourcePageId
    });
    res.json({ ok: true, thread: t });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/threads/:id', (req, res) => {
  try {
    const t = ai.threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: '스레드 없음' });
    // 권한: 내 것이거나, 소속 프로젝트를 볼 수 있거나, admin
    const mine = String(t.owner_id) === String(req.user.userId);
    if (!mine && !isAdmin(req)) {
      if (!t.project_id) return res.status(403).json({ error: '권한 없음' });
      const p = ai.projects.get(t.project_id);
      if (!ai.canViewProject(p, req.user.userId, isAdmin(req))) {
        return res.status(403).json({ error: '권한 없음' });
      }
    }
    const messages = ai.threads.messages(t.id);
    // 각 메시지의 첨부파일 풀어주기 (attachments_parsed 로 추가 — 원본 JSON 은 유지)
    for (const m of messages) {
      try {
        const attIds = JSON.parse(m.attachments || '[]');
        m.attachments_parsed = ai.attachments.hydrate(attIds);
      } catch(e) { m.attachments_parsed = []; }
    }
    // 스레드에 프로젝트 이모지 붙이기
    if (t.project_id) {
      const pr = ai.projects.get(t.project_id);
      if (pr) { t.project_emoji = pr.emoji || '📁'; t.project_name = pr.name; }
    }
    res.json({ ok: true, thread: t, messages });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/threads/:id', (req, res) => {
  try {
    const t = ai.threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: '스레드 없음' });
    if (String(t.owner_id) !== String(req.user.userId)) {
      return res.status(403).json({ error: '소유자만 수정 가능' });
    }
    const patch = {};
    if (req.body.title !== undefined) patch.title = String(req.body.title).slice(0, 120);
    if (req.body.projectId !== undefined) {
      patch.project_id = req.body.projectId === null || req.body.projectId === '' ? null : parseInt(req.body.projectId, 10);
    }
    const updated = ai.threads.update(t.id, patch);
    res.json({ ok: true, thread: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/threads/:id', (req, res) => {
  try {
    const t = ai.threads.get(req.params.id);
    if (!t) return res.status(404).json({ error: '스레드 없음' });
    if (String(t.owner_id) !== String(req.user.userId)) {
      return res.status(403).json({ error: '소유자만 삭제 가능' });
    }
    ai.threads.delete(t.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// 대화 (Claude CLI 호출 + 자동 저장)
// ──────────────────────────────────────────────────────────
function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const started = Date.now();
    const child = spawn('claude', ['-p'], {
      shell: true,
      env: { ...process.env, LANG: 'ko_KR.UTF-8' },
      windowsHide: true
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch(_) {}
      reject(new Error('timeout'));
    }, 120000);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error((err || '').trim() || `claude exit ${code}`));
      }
      resolve({ text: (out || '').trim(), durationMs: Date.now() - started });
    });
    child.stdin.write(prompt, 'utf8');
    child.stdin.end();
  });
}

router.post('/chat', async (req, res) => {
  try {
    const { threadId, projectId, prompt, pageContent, attachmentIds, templateId,
            sourcePageId, mode } = req.body || {};
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt 필수' });

    // 1. 스레드 확보 (없으면 생성)
    let thread;
    if (threadId) {
      thread = ai.threads.get(threadId);
      if (!thread) return res.status(404).json({ error: '스레드 없음' });
      if (String(thread.owner_id) !== String(req.user.userId)) {
        return res.status(403).json({ error: '본인 스레드만 사용 가능' });
      }
    } else {
      thread = ai.threads.create({
        ownerId: req.user.userId,
        ownerName: req.user.name,
        projectId: projectId ? parseInt(projectId, 10) : null,
        title: String(prompt).trim().slice(0, 60),
        sourcePageId
      });
    }

    // 2. 첨부파일 텍스트 추출 내용 수집
    let attachments = [];
    if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
      attachments = ai.attachments.hydrate(attachmentIds.map(Number));
    }

    // 3. 프롬프트 구성 — 이전 대화 컨텍스트 포함 (L0.5)
    const prior = ai.threads.recentMessages(thread.id, 8);
    const contextLines = [];
    for (const m of prior) {
      if (m.role === 'user') contextLines.push(`[사용자] ${m.content}`);
      else if (m.role === 'ai' && m.status === 'ok') contextLines.push(`[Claude] ${m.content}`);
    }

    // 템플릿
    let templatePrefix = '';
    if (templateId) {
      const tmpl = ai.templates.get(templateId);
      if (tmpl) {
        templatePrefix = tmpl.prompt + '\n\n';
        ai.templates.bumpUsage(tmpl.id);
      }
    }

    // 첨부 텍스트
    let attachmentBlock = '';
    if (attachments.length > 0) {
      const parts = attachments.map(a => {
        if (a.text_excerpt) {
          return `[첨부: ${a.original_name} (${a.kind})]\n${a.text_excerpt.slice(0, 8000)}`;
        }
        return `[첨부: ${a.original_name} (${a.kind}, 텍스트 미추출)]`;
      });
      attachmentBlock = parts.join('\n\n') + '\n\n';
    }

    const systemPrefix = '당신은 ERP 시스템 내 워크스페이스 AI 도우미입니다. 한국어로 간결하고 실용적으로 답변해주세요.\n\n';
    const pageContext = pageContent ? `【참고: 현재 페이지 내용】\n${String(pageContent).slice(0, 10000)}\n\n` : '';
    const history = contextLines.length > 0 ? `【이전 대화】\n${contextLines.join('\n')}\n\n` : '';
    const fullPrompt = systemPrefix + templatePrefix + pageContext + attachmentBlock + history + `【질문】\n${prompt}`;

    // 4. 사용자 메시지 저장 (Claude 호출 실패해도 남아있게)
    ai.threads.addMessage(thread.id, {
      role: 'user',
      kind: mode || 'chat',
      content: prompt,
      attachments: Array.isArray(attachmentIds) ? attachmentIds : [],
      metadata: { templateId: templateId || null, sourcePageId: sourcePageId || null }
    });

    // 5. Claude CLI
    let aiText = '', durationMs = 0, status = 'ok', errMsg = null;
    try {
      const r = await runClaudeCli(fullPrompt);
      aiText = r.text;
      durationMs = r.durationMs;
      if (!aiText) { status = 'error'; errMsg = 'Claude 응답이 비어있습니다'; }
    } catch (e) {
      status = 'error';
      errMsg = e.message;
    }

    // 6. AI 메시지 저장
    const aiMsg = ai.threads.addMessage(thread.id, {
      role: 'ai',
      kind: mode || 'chat',
      content: aiText || '',
      status, error: errMsg, durationMs
    });

    // 제목 자동 설정 (첫 대화였을 때)
    ai.threads.autoTitleIfEmpty(thread.id);

    // 7. 응답
    if (status !== 'ok') {
      return res.status(500).json({ ok: false, threadId: thread.id, error: errMsg, message: aiMsg });
    }
    res.json({ ok: true, threadId: thread.id, message: aiMsg, result: aiText });
  } catch (e) {
    console.error('[ai/chat]', e);
    res.status(500).json({ error: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// 이미지 생성 (Gemini CLI 위임 — 기존 /api/workspace/ai-image 로직을 재활용하되
// 스레드에 저장까지 책임진다. 핵심 차이: 결과 URL 을 DB 에 남긴다)
// ──────────────────────────────────────────────────────────
router.post('/chat-image', async (req, res) => {
  try {
    const { threadId, projectId, prompt, sourcePageId } = req.body || {};
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt 필수' });

    let thread;
    if (threadId) {
      thread = ai.threads.get(threadId);
      if (!thread || String(thread.owner_id) !== String(req.user.userId)) {
        return res.status(404).json({ error: '스레드 없음' });
      }
    } else {
      thread = ai.threads.create({
        ownerId: req.user.userId,
        ownerName: req.user.name,
        projectId: projectId ? parseInt(projectId, 10) : null,
        title: `🎨 ${String(prompt).trim().slice(0, 50)}`,
        sourcePageId
      });
    }

    // 사용자 메시지
    ai.threads.addMessage(thread.id, {
      role: 'user', kind: 'image', content: prompt,
      metadata: { sourcePageId: sourcePageId || null }
    });

    // Gemini 호출 — 기존 /api/workspace/ai-image 와 동일한 방식으로 직접 돌린다
    // (모듈 간 의존성을 피하기 위해 로직 복제)
    const result = await callGeminiImage(prompt);
    const status = result.ok ? 'ok' : 'error';
    const aiMsg = ai.threads.addMessage(thread.id, {
      role: 'ai', kind: 'image',
      content: result.ok ? '(이미지)' : '',
      imageUrl: result.url || null,
      status, error: result.error || null,
      durationMs: result.durationMs
    });

    ai.threads.autoTitleIfEmpty(thread.id);

    if (!result.ok) return res.status(500).json({ ok: false, threadId: thread.id, error: result.error, message: aiMsg });
    res.json({ ok: true, threadId: thread.id, message: aiMsg, url: result.url });
  } catch (e) {
    console.error('[ai/chat-image]', e);
    res.status(500).json({ error: e.message });
  }
});

// 재사용: Gemini CLI + nanobanana 로 이미지 생성
async function callGeminiImage(prompt) {
  const started = Date.now();
  try {
    const { spawn } = require('child_process');
    const workDir = path.join(__dirname, '..', 'data', 'ai-image-work');
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    const geminiPrompt = `/mcp nanobanana 을 사용해서 이미지를 생성해줘. 작업 디렉토리: ${workDir}\n\n프롬프트: ${prompt}\n\n이미지 파일명을 한 줄로 응답해줘. 다른 설명 없이.`;

    const output = await new Promise((resolve, reject) => {
      const child = spawn('gemini', ['-p'], {
        shell: true,
        env: { ...process.env, LANG: 'ko_KR.UTF-8' },
        windowsHide: true,
        cwd: workDir
      });
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch(_) {} reject(new Error('timeout')); }, 180000);
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(err || `gemini exit ${code}`));
        resolve(out.trim());
      });
      child.stdin.write(geminiPrompt, 'utf8');
      child.stdin.end();
    });

    // 생성된 이미지 파일 찾기 (workDir 에서 mtime 최신)
    const files = fs.readdirSync(workDir)
      .map(n => ({ n, stat: fs.statSync(path.join(workDir, n)) }))
      .filter(f => /\.(png|jpe?g|webp)$/i.test(f.n))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    if (files.length === 0) return { ok: false, error: '이미지 미생성', durationMs: Date.now() - started };

    const latest = files[0];
    // public/data/workspace-images 로 이동
    const imgDir = path.join(__dirname, '..', 'data', 'workspace-images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    const ext = path.extname(latest.n);
    const finalName = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.renameSync(path.join(workDir, latest.n), path.join(imgDir, finalName));
    return { ok: true, url: `/data/workspace-images/${finalName}`, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message, durationMs: Date.now() - started };
  }
}

// ──────────────────────────────────────────────────────────
// 템플릿
// ──────────────────────────────────────────────────────────
router.get('/templates', (req, res) => {
  try {
    const scope = req.query.scope || 'visible';
    const list = ai.templates.list(req.user.userId, { scope, isAdmin: isAdmin(req) });
    const enriched = list.map(t => ({ ...t, is_mine: String(t.owner_id) === String(req.user.userId) }));
    res.json({ ok: true, templates: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/templates', (req, res) => {
  try {
    const { name, emoji, prompt, shareMode, share_mode } = req.body || {};
    if (!name || !prompt) return res.status(400).json({ error: 'name, prompt 필수' });
    const valid = ['private', 'team', 'company', 'invited'];
    const mode = shareMode || share_mode;
    const t = ai.templates.create({
      ownerId: req.user.userId, ownerName: req.user.name,
      name: String(name).slice(0, 60), emoji: emoji || '✦',
      prompt: String(prompt), shareMode: valid.includes(mode) ? mode : 'private'
    });
    res.json({ ok: true, template: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/templates/:id', (req, res) => {
  try {
    const t = ai.templates.get(req.params.id);
    if (!t) return res.status(404).json({ error: '없음' });
    if (String(t.owner_id) !== String(req.user.userId)) return res.status(403).json({ error: '소유자만' });
    const updated = ai.templates.update(t.id, req.body || {});
    res.json({ ok: true, template: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/templates/:id', (req, res) => {
  try {
    const t = ai.templates.get(req.params.id);
    if (!t) return res.status(404).json({ error: '없음' });
    if (String(t.owner_id) !== String(req.user.userId)) return res.status(403).json({ error: '소유자만' });
    ai.templates.delete(t.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────────────────────
// 첨부파일 (이미지/엑셀/PDF/워드/텍스트)
// ──────────────────────────────────────────────────────────
const uploadDir = ai.UPLOAD_DIR;
const storage = multer ? multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    const base = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
}) : null;
const upload = multer && storage ? multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }) : null;

function detectKind(mime, ext) {
  ext = (ext || '').toLowerCase();
  if (/^image\//.test(mime) || /\.(jpe?g|png|gif|webp|bmp)$/.test(ext)) return 'image';
  if (/pdf/.test(mime) || /\.pdf$/.test(ext)) return 'pdf';
  if (/spreadsheet|excel/.test(mime) || /\.(xlsx?|xlsm|xlsb|csv)$/.test(ext)) return 'excel';
  if (/word|msword/.test(mime) || /\.docx?$/.test(ext)) return 'word';
  if (/^text\//.test(mime) || /\.(txt|md|json|log)$/.test(ext)) return 'text';
  return 'file';
}

// 엑셀 텍스트 추출 (exceljs 사용)
async function extractExcel(filePath) {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const parts = [];
    wb.eachSheet((sheet) => {
      const rows = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const vals = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          let v = cell.value;
          if (v && typeof v === 'object') {
            if ('result' in v) v = v.result;
            else if ('text' in v) v = v.text;
            else if ('richText' in v) v = v.richText.map(r => r.text).join('');
            else v = JSON.stringify(v);
          }
          vals.push(v == null ? '' : String(v));
        });
        rows.push(vals.join('\t'));
      });
      if (rows.length > 0) parts.push(`# ${sheet.name}\n${rows.join('\n')}`);
    });
    return parts.join('\n\n').slice(0, 50000);
  } catch (e) {
    return '[엑셀 읽기 실패: ' + e.message + ']';
  }
}

// PDF 텍스트 추출 — pdf-parse 있으면 사용, 없으면 미추출
async function extractPdf(filePath) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fs.readFileSync(filePath));
    return (data.text || '').slice(0, 50000);
  } catch (e) {
    if (/Cannot find module/.test(e.message)) {
      return '[PDF 텍스트 추출 미설치 — npm install pdf-parse 하면 추출 가능]';
    }
    return '[PDF 읽기 실패: ' + e.message + ']';
  }
}

// 텍스트 파일
function extractText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, 50000);
  } catch (e) { return ''; }
}

router.post('/attachments', (req, res, next) => {
  if (!upload) return res.status(503).json({ error: 'multer 미설치 — npm install multer' });
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '파일 필요' });
    try {
      const ext = path.extname(req.file.originalname || '').toLowerCase();
      const kind = detectKind(req.file.mimetype, ext);
      let excerpt = '';
      const storedPath = req.file.path;
      if (kind === 'excel') excerpt = await extractExcel(storedPath);
      else if (kind === 'pdf') excerpt = await extractPdf(storedPath);
      else if (kind === 'text') excerpt = extractText(storedPath);
      // image/word 는 excerpt 없음 (word 는 mammoth 등 필요하면 추가)
      const att = ai.attachments.create({
        ownerId: req.user.userId,
        originalName: req.file.originalname,
        storedName: path.basename(storedPath),
        mime: req.file.mimetype || '',
        size: req.file.size || 0,
        kind,
        textExcerpt: excerpt
      });
      res.json({ ok: true, attachment: att });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

router.get('/attachments/:id', (req, res) => {
  try {
    const a = ai.attachments.get(req.params.id);
    if (!a) return res.status(404).json({ error: '없음' });
    if (String(a.owner_id) !== String(req.user.userId) && !isAdmin(req)) {
      return res.status(403).json({ error: '권한 없음' });
    }
    res.json({ ok: true, attachment: a });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/attachments/:id', (req, res) => {
  try {
    const a = ai.attachments.get(req.params.id);
    if (!a) return res.status(404).json({ error: '없음' });
    if (String(a.owner_id) !== String(req.user.userId)) return res.status(403).json({ error: '소유자만' });
    ai.attachments.delete(a.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 이미지 첨부 직접 서빙 (토큰 없이 owner 만)
router.get('/attachments/:id/raw', (req, res) => {
  try {
    const a = ai.attachments.get(req.params.id);
    if (!a) return res.status(404).end();
    if (String(a.owner_id) !== String(req.user.userId) && !isAdmin(req)) return res.status(403).end();
    const fp = path.join(ai.UPLOAD_DIR, a.stored_name);
    if (!fs.existsSync(fp)) return res.status(404).end();
    if (a.mime) res.setHeader('Content-Type', a.mime);
    res.sendFile(fp);
  } catch (e) { res.status(500).end(); }
});

module.exports = router;
