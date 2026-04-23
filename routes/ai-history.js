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
    // 부서 ID → 이름 매핑
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
          company: u.company || '',
          deptId: deptId,                          // 원본 부서 ID
          dept: deptName,                          // 부서 이름 ("디자인팀")
          department: deptName,                    // 하위 호환
          departments: u.departments || [],
          position: u.position || ''
        };
      });
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
      // 스레드 소유권: 관리자라도 다른 계정의 개인 대화엔 끼어들 수 없음
      // (개인 AI 대화는 사적인 내용 포함 가능)
      if (String(thread.owner_id) !== String(req.user.userId)) {
        return res.status(403).json({
          error: '다른 사람의 대화에는 메시지를 보낼 수 없어요. 새 대화를 시작해주세요.',
          code: 'NOT_OWNER'
        });
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
    const { threadId, projectId, prompt, sourcePageId, attachmentIds } = req.body || {};
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

    // 참고 이미지 경로 확보 (첨부된 이미지만)
    const sourcePaths = [];
    if (Array.isArray(attachmentIds) && attachmentIds.length) {
      const hydrated = ai.attachments.hydrate(attachmentIds);
      for (const a of hydrated) {
        if (!a) continue;
        if (String(a.owner_id) !== String(req.user.userId)) continue; // 본인 첨부만
        if (a.kind !== 'image') continue;                               // 이미지만
        const fp = path.join(ai.UPLOAD_DIR, a.stored_name);
        if (fs.existsSync(fp)) sourcePaths.push(fp);
      }
    }

    // 사용자 메시지
    ai.threads.addMessage(thread.id, {
      role: 'user', kind: 'image', content: prompt,
      attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
      metadata: { sourcePageId: sourcePageId || null, sourceImageCount: sourcePaths.length }
    });

    // Gemini 호출 (참고 이미지 경로 포함)
    const result = await callGeminiImage(prompt, sourcePaths);
    const status = result.ok ? 'ok' : 'error';
    const aiMsg = ai.threads.addMessage(thread.id, {
      role: 'ai', kind: 'image',
      content: result.ok ? '(이미지)' : '',
      imageUrl: result.url || null,
      status, error: result.error || null,
      durationMs: result.durationMs,
      metadata: { sourceImageCount: sourcePaths.length }
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
// sourceImagePaths: 참고/편집할 이미지 경로 배열 (선택). 있으면 nanobanana 가 해당 이미지를 참고해서 편집·변형
async function callGeminiImage(prompt, sourceImagePaths = []) {
  const started = Date.now();
  try {
    const { spawn } = require('child_process');
    const workDir = path.join(__dirname, '..', 'data', 'ai-image-work');
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    // 참고 이미지가 있으면 프롬프트에 경로 명시 (nanobanana 가 파일 읽어서 참고)
    let referenceBlock = '';
    if (Array.isArray(sourceImagePaths) && sourceImagePaths.length) {
      const lines = sourceImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n');
      referenceBlock = `\n\n참고 이미지 (${sourceImagePaths.length}장) — 이 이미지를 기반으로 편집/변형해주세요:\n${lines}\n`;
    }

    const mode = sourceImagePaths.length > 0 ? '편집/변형해줘' : '생성해줘';
    const geminiPrompt = `/mcp nanobanana 을 사용해서 이미지를 ${mode}. 작업 디렉토리: ${workDir}${referenceBlock}\n\n프롬프트: ${prompt}\n\n이미지 파일명을 한 줄로 응답해줘. 다른 설명 없이.`;

    // 프롬프트를 임시 파일로 저장해서 shell redirect 로 stdin 주입
    // (Gemini CLI 의 -p/--prompt 플래그는 값이 필수이므로 placeholder 를 전달하고,
    //  실제 프롬프트는 stdin 으로 appended 되도록 함)
    const promptFile = path.join(workDir, `_prompt_${Date.now()}_${Math.random().toString(36).slice(2,6)}.txt`);
    fs.writeFileSync(promptFile, geminiPrompt, 'utf8');

    const output = await new Promise((resolve, reject) => {
      // Windows cmd.exe / POSIX sh 둘 다 "<" redirect 지원
      const cmd = `gemini -p "generate-image" < "${promptFile}"`;
      const child = spawn(cmd, {
        shell: true,
        env: { ...process.env, LANG: 'ko_KR.UTF-8' },
        windowsHide: true,
        cwd: workDir
      });
      let out = '', err = '';
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch(_) {} reject(new Error('timeout')); }, 180000);
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); try { fs.unlinkSync(promptFile); } catch(_){} reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        try { fs.unlinkSync(promptFile); } catch(_) {}
        if (code !== 0) return reject(new Error(err || `gemini exit ${code}`));
        resolve(out.trim());
      });
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

// multer 가 파일명을 latin1 로 해석해서 한글이 깨짐 → utf8 로 복원
function fixKoreanFilename(name) {
  if (!name) return '';
  try {
    // 이미 깨진 latin1 문자열을 utf8 바이트로 되돌림
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

router.post('/attachments', (req, res, next) => {
  if (!upload) return res.status(503).json({ error: 'multer 미설치 — npm install multer' });
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '파일 필요' });
    try {
      // 한글 파일명 인코딩 복원
      const originalName = fixKoreanFilename(req.file.originalname || '');
      const ext = path.extname(originalName).toLowerCase();
      const kind = detectKind(req.file.mimetype, ext);
      let excerpt = '';
      const storedPath = req.file.path;
      if (kind === 'excel') excerpt = await extractExcel(storedPath);
      else if (kind === 'pdf') excerpt = await extractPdf(storedPath);
      else if (kind === 'text') excerpt = extractText(storedPath);
      // image/word 는 excerpt 없음 (word 는 mammoth 등 필요하면 추가)
      const att = ai.attachments.create({
        ownerId: req.user.userId,
        originalName,
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

// ──────────────────────────────────────────────────────────
// 이미지 업스케일 (Real-ESRGAN NCNN Vulkan)
// ──────────────────────────────────────────────────────────

// 업스케일 도구 루트 — tools/realesrgan/ 아래에 realesrgan-ncnn-vulkan.exe 와 models/ 폴더를 둔다
const UPSCALE_ROOT = path.join(__dirname, '..', 'tools', 'realesrgan');
const UPSCALE_BIN = process.platform === 'win32'
  ? path.join(UPSCALE_ROOT, 'realesrgan-ncnn-vulkan.exe')
  : path.join(UPSCALE_ROOT, 'realesrgan-ncnn-vulkan');
const UPSCALE_MODELS_DIR = path.join(UPSCALE_ROOT, 'models');

// 모델 카탈로그 — 프론트에도 이 정보가 필요하므로 /upscale/models 로 노출
// key: Real-ESRGAN NCNN Vulkan 이 -n 에 받는 모델명 (= models/ 아래 파일명과 일치해야 함)
// Upscayl 번들 모델 파일명을 그대로 사용하여, Upscayl 설치본에서 그대로 복사해서 쓸 수 있도록 함
const UPSCALE_MODELS = [
  {
    key: 'ultrasharp-4x',
    name: 'UltraSharp',
    emoji: '✨',
    tagline: '실사 사진·제품 · 가장 선명함',
    desc: '실사 사진의 디테일을 가장 선명하게 살려줌. 제품 사진·풍경·건물에 추천.',
    bestFor: ['사진', '실사', '제품', '풍경', '건물'],
    scale: 4,
    speed: 'normal',
    recommended: true,
  },
  {
    key: 'remacri-4x',
    name: 'REMACRI',
    emoji: '📷',
    tagline: '인물 사진·피부·자연스러움',
    desc: '인물·피부 톤을 자연스럽게 살려줌. Upscayl 기본값.',
    bestFor: ['인물', '얼굴', '피부', '사람', '포트레이트'],
    scale: 4,
    speed: 'normal',
    recommended: true,
  },
  {
    key: 'ultramix-balanced-4x',
    name: 'Ultramix Balanced',
    emoji: '🎨',
    tagline: 'AI 생성 이미지·혼합',
    desc: '선명함과 자연스러움 균형. AI 이미지·합성 이미지에 추천.',
    bestFor: ['AI', 'AI 생성', '합성', '혼합'],
    scale: 4,
    speed: 'normal',
    recommended: true,
  },
  {
    key: 'high-fidelity-4x',
    name: 'High Fidelity',
    emoji: '🔬',
    tagline: '고해상도 실사 · 디테일 복원',
    desc: '디테일 손실 최소화. 중요한 사진 복원·고품질 업스케일.',
    bestFor: ['고해상도', '복원', '고품질'],
    scale: 4,
    speed: 'slow',
    recommended: false,
  },
  {
    key: 'digital-art-4x',
    name: 'Digital Art',
    emoji: '🖌️',
    tagline: '일러스트·애니·디지털 아트',
    desc: '일러스트·만화·애니·디지털 페인팅에 최적. 선·면이 깨끗함.',
    bestFor: ['애니', '만화', '일러스트', '그림', '캐릭터'],
    scale: 4,
    speed: 'fast',
    recommended: false,
  },
  {
    key: 'upscayl-standard-4x',
    name: 'Upscayl Standard',
    emoji: '⚙️',
    tagline: '범용·무난',
    desc: '모든 타입에 무난하게 동작. 고민 없이 쓸 수 있는 기본 모델.',
    bestFor: ['범용', '기본'],
    scale: 4,
    speed: 'normal',
    recommended: false,
  },
  {
    key: 'upscayl-lite-4x',
    name: 'Upscayl Lite',
    emoji: '🏃',
    tagline: '빠름·저사양 PC',
    desc: '화질 약간 낮지만 매우 빠름. 저사양·CPU 환경에 적합.',
    bestFor: ['빠른', 'CPU', '저사양'],
    scale: 4,
    speed: 'fast',
    recommended: false,
  }
];

// 자동 추천: 프롬프트 키워드로 모델 매칭
function recommendUpscaleModel(hint) {
  const t = String(hint || '').toLowerCase();
  if (/(애니|만화|캐릭터|일러스트|그림|수채화|유화|anime|manga|illust|cartoon|painting|drawing|art)/i.test(t)) return 'digital-art-4x';
  if (/(인물|얼굴|사람|portrait|face|person|피부|아이|어린이|아기)/i.test(t)) return 'remacri-4x';
  if (/(ai|생성|합성|gan|midjourney|stable|diffusion)/i.test(t)) return 'ultramix-balanced-4x';
  if (/(사진|실사|제품|건물|풍경|photo|realistic|product|landscape)/i.test(t)) return 'ultrasharp-4x';
  return 'ultrasharp-4x'; // 기본값
}

// 실제 설치된 모델 목록 (models/ 폴더 스캔)
function scanInstalledModels() {
  if (!fs.existsSync(UPSCALE_MODELS_DIR)) return [];
  const files = fs.readdirSync(UPSCALE_MODELS_DIR);
  // .bin 또는 .param 파일 기준으로 모델키 추출
  const keys = new Set();
  for (const f of files) {
    const m = f.match(/^(.+?)\.(bin|param)$/i);
    if (m) keys.add(m[1]);
  }
  return Array.from(keys);
}

// GET /upscale/health — 설치 여부 + 모델 카탈로그 반환
router.get('/upscale/health', (req, res) => {
  const binExists = fs.existsSync(UPSCALE_BIN);
  const installedKeys = scanInstalledModels();
  const catalog = UPSCALE_MODELS.map(m => ({
    ...m,
    installed: installedKeys.includes(m.key)
  }));
  res.json({
    ok: true,
    ready: binExists && installedKeys.length > 0,
    binExists,
    binPath: UPSCALE_BIN,
    modelsDir: UPSCALE_MODELS_DIR,
    installedCount: installedKeys.length,
    models: catalog,
    setupGuideUrl: '/업스케일_설치가이드.md'
  });
});

// POST /upscale — { imageUrl, model, scale } → 업스케일된 이미지 URL 반환
router.post('/upscale', async (req, res) => {
  try {
    const { imageUrl, model, scale } = req.body || {};
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl 필수' });

    if (!fs.existsSync(UPSCALE_BIN)) {
      return res.status(503).json({
        error: 'Real-ESRGAN 이 서버에 설치되지 않았습니다.',
        setupGuide: '업스케일_설치가이드.md 참고'
      });
    }

    // imageUrl 은 보통 /data/workspace-images/ai_xxxx.png 형태
    let srcPath;
    if (imageUrl.startsWith('/data/workspace-images/')) {
      srcPath = path.join(__dirname, '..', imageUrl.replace(/^\//, '').replace(/\//g, path.sep));
    } else {
      return res.status(400).json({ error: 'imageUrl 형식 불일치 (/data/workspace-images/… 만 허용)' });
    }
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: '원본 이미지 없음' });

    const requestedModel = UPSCALE_MODELS.find(m => m.key === model);
    if (!requestedModel) return res.status(400).json({ error: '알 수 없는 모델: ' + model });

    const installedKeys = scanInstalledModels();
    if (!installedKeys.includes(requestedModel.key)) {
      return res.status(503).json({ error: `모델이 설치되지 않음: ${requestedModel.key}. models/ 폴더에 .bin/.param 파일을 넣어주세요.` });
    }

    const scaleNum = [2, 3, 4].includes(Number(scale)) ? Number(scale) : 4;

    // 출력 경로
    const srcName = path.basename(srcPath, path.extname(srcPath));
    const outName = `${srcName}_${scaleNum}x_${requestedModel.key}.png`;
    const outPath = path.join(path.dirname(srcPath), outName);
    const outUrl = `/data/workspace-images/${outName}`;

    // 이미 있으면 재활용
    if (fs.existsSync(outPath)) {
      return res.json({ ok: true, url: outUrl, cached: true, model: requestedModel });
    }

    const { spawn } = require('child_process');
    const started = Date.now();
    await new Promise((resolve, reject) => {
      // realesrgan-ncnn-vulkan -i in.png -o out.png -n <model> -s <scale>
      const args = ['-i', srcPath, '-o', outPath, '-n', requestedModel.key, '-s', String(scaleNum)];
      const child = spawn(UPSCALE_BIN, args, {
        cwd: UPSCALE_ROOT,
        windowsHide: true
      });
      let err = '';
      const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch(_) {} reject(new Error('업스케일 timeout (90초)')); }, 90000);
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(err || `realesrgan exit ${code}`));
        resolve();
      });
    });

    res.json({
      ok: true,
      url: outUrl,
      cached: false,
      model: requestedModel,
      scale: scaleNum,
      durationMs: Date.now() - started
    });
  } catch (e) {
    console.error('[ai/upscale]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /upscale/recommend — 프롬프트 키워드 → 추천 모델키
router.get('/upscale/recommend', (req, res) => {
  const hint = req.query.hint || '';
  res.json({ ok: true, model: recommendUpscaleModel(hint) });
});

module.exports = router;
