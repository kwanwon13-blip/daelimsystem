/**
 * routes/ai-agent.js — Agent SSE 엔드포인트 + 결과 파일 다운로드
 *
 * Mounted at: app.use('/api/ai/agent', router)
 *
 * 엔드포인트:
 *   POST /run            (SSE) Agent 작업 실행
 *   GET  /file/:userId/:sessionId/*   결과 파일 다운로드/미리보기
 *   GET  /stats          현재 슬롯 상태
 *   POST /image          OpenAI gpt-image-2 단발 이미지 생성 (Agent 사용 안 함)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const agent = require('../lib/agent-runtime');
const ai = require('../db-ai');
const reg = require('../lib/generation-registry');

let openaiClient = null;
try { openaiClient = require('../lib/openai-client'); } catch(_) {}

function requireAuthOrControlSecret(req, res, next) {
  const ctrlSecret = req.headers['x-control-secret'];
  const expected = process.env.CONTROL_DAEMON_SECRET;
  if (ctrlSecret && expected && String(ctrlSecret).trim() === String(expected).trim()) {
    let name = req.headers['x-control-user-name'] || 'CONTROL AI';
    try { name = decodeURIComponent(name); } catch (_) {}
    req.user = {
      userId: String(req.headers['x-control-user-id'] || 'control-ai'),
      name,
      role: String(req.headers['x-control-user-role'] || 'admin'),
      permissions: [],
    };
    req.sessionToken = 'control-secret-ai';
    return next();
  }
  return requireAuth(req, res, next);
}

router.use(requireAuthOrControlSecret);

function mimeFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return {
    '.svg': 'image/svg+xml; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }[ext] || 'application/octet-stream';
}

function artifactKindFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (['.xlsx', '.xls', '.xlsm', '.csv'].includes(ext)) return 'excel';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.svg') return 'svg';
  if (['.html', '.htm'].includes(ext)) return 'html';
  if (ext === '.md') return 'markdown';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (ext === '.docx') return 'word';
  if (ext === '.pptx') return 'presentation';
  if (ext === '.json') return 'json';
  if (ext === '.txt') return 'text';
  return 'file';
}

function artifactPayload(a) {
  return {
    id: a.id,
    name: a.original_name,
    filename: a.original_name,
    size: a.size,
    kind: a.kind,
    url: `/api/ai/artifacts/${a.id}/download`,
    previewUrl: `/api/ai/artifacts/${a.id}/download?inline=1`,
  };
}

// 내부/임시 산출물 가드 — basename 이 '_' 또는 '.' 로 시작하거나
// '_agent_done' / '.tmp' 를 포함하면 사용자 '생성 파일' 목록에서 제외한다.
// (예: _agent_done.json.tmp 가 다운로드 카드에 노출되던 버그 차단)
function isInternalAgentFile(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  if (!base) return true;
  if (base.startsWith('_') || base.startsWith('.')) return true;
  if (base.includes('_agent_done') || base.includes('.tmp')) return true;
  return false;
}

function persistAgentFiles({ userId, threadId, sessionId, files }) {
  const out = [];
  const seen = new Set();
  for (const f of files || []) {
    if (!f || !f.relPath || seen.has(f.relPath)) continue;
    if (isInternalAgentFile(f.name || f.relPath)) continue;
    seen.add(f.relPath);
    const src = agent.resolveSessionFile(userId, sessionId, f.relPath);
    if (!src) continue;
    try {
      const ext = path.extname(f.name || src).toLowerCase() || '.bin';
      const storedName = Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext;
      const dest = path.join(ai.OUTPUT_DIR, storedName);
      fs.copyFileSync(src, dest);
      const stat = fs.statSync(dest);
      const art = ai.artifacts.create({
        ownerId: userId,
        threadId,
        messageId: null,
        originalName: f.name || path.basename(src),
        storedName,
        mime: mimeFromName(f.name || src),
        size: stat.size,
        kind: artifactKindFromName(f.name || src),
      });
      out.push(artifactPayload(art));
    } catch (e) {
      console.warn('[ai-agent] artifact persist failed:', f.relPath, e.message);
      (out.failures || (out.failures = [])).push(f.name || f.relPath);
    }
  }
  return out;
}

// 최종 메시지 본문 빌더 — lib 로 추출(순수 함수, 테스트 공용).
// 정직한 멈춤(unknownTask)·자동점검 🚩(check) 를 헤드라인에 반영한다.
const { FRIENDLY_ERROR, buildAgentFinalContent } = require('../lib/agent-final-content');

// ── 슬롯 상태 ──
router.get('/stats', (req, res) => {
  res.json({ ok: true, ...agent.getStats() });
});

// ── Agent 실행 (SSE) ──
// body: { task, attachmentIds?, threadId?, projectId?, sessionConsent: true }
router.post('/run', async (req, res) => {
  const { task, attachmentIds, threadId, projectId, sessionConsent } = req.body || {};
  if (sessionConsent !== true) {
    return res.status(428).json({
      ok: false,
      code: 'SESSION_CONSENT_REQUIRED',
      error: 'Agent session consent is required before starting this job.',
    });
  }
  if (!task || !String(task).trim()) {
    return res.status(400).json({ error: 'task 필수' });
  }

  // 첨부 파일 경로 확보 (사용자 본인 것만)
  const attachmentPaths = [];
  if (Array.isArray(attachmentIds) && attachmentIds.length && ai && ai.attachments) {
    try {
      const hydrated = ai.attachments.hydrate(attachmentIds);
      for (const a of hydrated) {
        if (!a || String(a.owner_id) !== String(req.user.userId)) continue;
        const fp = path.join(ai.UPLOAD_DIR, a.stored_name);
        if (fs.existsSync(fp)) {
          attachmentPaths.push({
            path: fp,
            originalName: a.original_name || a.originalName || path.basename(fp),
            name: a.original_name || a.originalName || path.basename(fp),
          });
        }
      }
    } catch (e) {
      console.warn('[ai-agent] 첨부 hydrate 실패:', e.message);
    }
  }

  // ── 스레드 확보 + 사용자 메시지 DB 저장 ──
  let thread = null;
  let userMsgId = null;
  let aiMsgRec = null;
  try {
    if (threadId && ai && ai.threads) {
      thread = ai.threads.get(threadId);
      if (thread && String(thread.owner_id) !== String(req.user.userId)) {
        thread = null;
      }
    }
    if (!thread && ai && ai.threads) {
      thread = ai.threads.create({
        ownerId: req.user.userId,
        ownerName: req.user.name,
        projectId: projectId ? parseInt(projectId, 10) : null,
        title: '🤖 ' + String(task).trim().slice(0, 50),
      });
    }
    if (thread && ai.threads.addMessage) {
      const um = ai.threads.addMessage(thread.id, {
        role: 'user', kind: 'agent', content: String(task).trim(),
        attachments: Array.isArray(attachmentIds) ? attachmentIds : [],
      });
      userMsgId = um?.id;
      aiMsgRec = ai.threads.addMessage(thread.id, {
        role: 'ai',
        kind: 'agent',
        content: '작업을 시작했습니다.',
        status: 'generating',
        metadata: { backend: 'agent', stream: true },
      });
    }
  } catch (e) {
    console.warn('[ai-agent] thread 준비 실패 (무시하고 진행):', e.message);
  }

  // SSE 헤더
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 등 프록시에서 버퍼 끄기
  res.flushHeaders && res.flushHeaders();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) { /* connection closed */ }
  };

  // keepalive ping (30초마다)
  const ping = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch (e) {}
  }, 30000);

  // Browser disconnects should not cancel the server-side job.
  const ctrl = new AbortController();
  let userStopped = false;   // 명시적 stop(중단)으로 종료됐는지 — interrupted 표시용
  let lastDone = null;
  let lastError = null;
  let collectedOutput = '';
  let collectedFiles = [];
  let liveSessionId = '';            // started 에서 캡처 — 진행 중 파일을 바로 persist 하려면 필요
  const liveArtifacts = [];          // 진행 중 즉시 등록된 artifact (done 전 F5 복원용)
  const persistedRelPaths = new Set();
  const agentReg = aiMsgRec ? reg.start(aiMsgRec.id, {
    threadId: thread?.id,
    ownerId: req.user.userId,
    abort: () => { userStopped = true; ctrl.abort(); },
    getAccumulated: () => collectedOutput || aiMsgRec.content || '',
  }) : null;
  req.on('close', () => {
    clearInterval(ping);
  });

  try {
    // 텍스트 메시지는 일일 한도 없음 (이미지 생성에만 제한 적용)
    for await (const evt of agent.runAgent({
      userId: req.user.userId,
      task: String(task).trim(),
      attachmentPaths,
      signal: ctrl.signal,
    })) {
      // thread 정보를 첫 'started' 에 끼워서 클라이언트에 알려주기
      if (evt.type === 'started') {
        liveSessionId = (evt.data && evt.data.sessionId) || liveSessionId;
        if (thread) {
          send('started', { ...evt.data, threadId: thread.id, userMsgId, messageId: aiMsgRec?.id });
        } else {
          send(evt.type, evt.data);
        }
      } else {
        send(evt.type, evt.data);
      }
      if (evt.type === 'output') {
        collectedOutput += evt.data?.text || '';
        if (agentReg && aiMsgRec) {
          reg.publish(aiMsgRec.id, 'delta', { text: evt.data?.text || '' });
          try { ai.threads.updateMessageContent(aiMsgRec.id, collectedOutput || '작업 중입니다.', 'generating'); } catch (_) {}
        }
      }
      if (evt.type === 'file') {
        collectedFiles.push(evt.data);
        // ★ 파일이 감지되는 즉시 영구 보존(ai_outputs) + artifact 등록 →
        //   작업이 길어 done 전에 새로고침해도 다운로드 카드가 복원된다.
        if (thread && liveSessionId && evt.data && evt.data.relPath && !persistedRelPaths.has(evt.data.relPath)) {
          persistedRelPaths.add(evt.data.relPath);
          try {
            const made = persistAgentFiles({
              userId: req.user.userId, threadId: thread.id,
              sessionId: liveSessionId, files: [evt.data],
            });
            for (const a of made) {
              liveArtifacts.push(a);
              if (aiMsgRec) { try { ai.artifacts.setMessageId(a.id, aiMsgRec.id); } catch (_) {} }
            }
            // 진행 메시지 metadata 에 누적 artifacts 저장 → selectThread 가 F5 후 카드 복원
            if (aiMsgRec && made.length) {
              try { ai.threads.updateMessageMetadata(aiMsgRec.id, { artifacts: liveArtifacts.slice() }); } catch (_) {}
            }
          } catch (e) { console.warn('[ai-agent] live persist 실패:', e.message); }
        }
        if (agentReg && aiMsgRec) {
          const fileText = `\n\n생성 감지: ${evt.data?.name || 'file'}`;
          reg.publish(aiMsgRec.id, 'delta', { text: fileText });
          try { ai.threads.updateMessageContent(aiMsgRec.id, (collectedOutput || '작업 중입니다.') + fileText, 'generating'); } catch (_) {}
        }
      }
      if (evt.type === 'done') lastDone = evt.data;
      if (evt.type === 'error') lastError = evt.data;
    }

    // ── DB 에 결과 저장 (thread 가 있으면) ──
    if (thread && ai.threads && ai.threads.addMessage) {
      try {
        // 명시적 중단(stop)이면 'interrupted', 그 외 오류면 'error', 정상이면 'ok'
        const status = userStopped ? 'interrupted' : (lastError ? 'error' : 'ok');
        // 실패·중단으로 끝나도 lastError.data.files / lastDone.files 에 부분 생성 파일이 담겨 옴.
        const finalFiles = collectedFiles.length
          ? collectedFiles
          : (lastDone?.files || (lastError && lastError.files) || []);
        // ★ status 무관하게 산출물 보존 — 중단·실패해도 이미 만든 파일은 다운로드 가능해야 함.
        //   진행 중 이미 즉시-등록한 파일(liveArtifacts)은 제외하고 나머지만 등록 후 합침(중복 방지).
        const remainingFiles = finalFiles.filter(f => f && f.relPath && !persistedRelPaths.has(f.relPath));
        const newlyCreated = persistAgentFiles({
          userId: req.user.userId,
          threadId: thread.id,
          sessionId: (lastDone && lastDone.sessionId) || (lastError && lastError.sessionId) || liveSessionId || '',
          files: remainingFiles,
        });
        if (newlyCreated.failures && newlyCreated.failures.length) {
          collectedOutput += `\n\n⚠️ 일부 결과 파일 저장에 실패했어요: ${newlyCreated.failures.join(', ')} — 잠시 후 다시 시도해 주세요.`;
        }
        const createdArtifacts = liveArtifacts.concat(newlyCreated);
        const errorCode = (lastError && lastError.code) || null;
        const summary = buildAgentFinalContent({
          status, lastError, lastDone, finalFiles, createdArtifacts, collectedOutput,
          userStopped, errorCode,
        });
        const fileSessionId = (lastDone && lastDone.sessionId) || (lastError && lastError.sessionId) || '';
        const files = finalFiles.map(f => ({
          name: f.name,
          relPath: f.relPath,
          size: f.size,
          ext: f.ext,
          url: '/api/ai/agent/file/' + encodeURIComponent(req.user.userId)
               + '/' + encodeURIComponent(fileSessionId)
               + '/' + encodeURIComponent(f.relPath || ''),
        }));
        const finalMsg = aiMsgRec
          ? ai.threads.finalizeMessage(aiMsgRec.id, {
          content: summary,
          status,
          error: lastError ? lastError.message : null,
          durationMs: lastDone?.durationMs || 0,
          metadata: {
            sessionId: (lastDone && lastDone.sessionId) || (lastError && lastError.sessionId) || '',
            files,
            artifacts: createdArtifacts,
            templateSaved: lastDone?.templateSaved || [],
            errorCode: errorCode || undefined,   // 실패 코드 — 새로고침 후에도 안내 복원
            interrupted: userStopped || undefined,
            outputTail: (collectedOutput || '').slice(-2000),
          },
        })
          : ai.threads.addMessage(thread.id, {
              role: 'ai', kind: 'agent',
              content: summary,
              status,
              error: lastError ? lastError.message : null,
              durationMs: lastDone?.durationMs || 0,
              metadata: {
                sessionId: lastDone?.sessionId,
                files,
                artifacts: createdArtifacts,
                templateSaved: lastDone?.templateSaved || [],
                outputTail: (collectedOutput || '').slice(-2000),
              },
            });
        for (const a of createdArtifacts) {
          try { ai.artifacts.setMessageId(a.id, finalMsg.id); } catch(e) {}
        }
        try { ai.threads.autoTitleIfEmpty && ai.threads.autoTitleIfEmpty(thread.id); } catch(_) {}
        if (agentReg && finalMsg) reg.finish(finalMsg.id, status, {
          threadId: thread.id,
          messageId: finalMsg.id,
          text: summary,
          artifacts: createdArtifacts,
          error: lastError ? lastError.message : null,
        });
        send('saved', {
          threadId: thread.id, messageId: finalMsg?.id, text: summary,
          artifacts: createdArtifacts,
          templateSaved: (lastDone && lastDone.templateSaved) || [],  // 마감 양식 자동 등록 알림용
        });
      } catch (e) {
        console.warn('[ai-agent] DB 저장 실패:', e.message);
      }
    }

    // 일일 사용량 카운트
    if (ai && ai.apiUsage && ai.apiUsage.log) {
      try {
        ai.apiUsage.log({
          userId: req.user.userId,
          userName: req.user.name,
          threadId: thread?.id,
          model: 'claude-cli-agent',
          usage: null,
          durationMs: lastDone?.durationMs || 0,
          turnCount: 1,
          toolNames: 'agent',
        });
      } catch(_) {}
    }
  } catch (e) {
    send('error', { message: e.message });
  } finally {
    clearInterval(ping);
    try { res.end(); } catch(_) {}
  }
});

// ── 에이전트 작업 중단 (명시적 stop 버튼 전용) ──
// POST /api/ai/agent/stop { messageId }
//   브라우저 연결 끊김(새로고침)은 작업을 안 죽임 — 오직 이 API 만 자식 프로세스를 종료.
//   reg.start 에 등록된 abort(()=>ctrl.abort()) 를 호출 → runAgent 의 signal.abort →
//   자식 claude 프로세스 SIGTERM/SIGKILL. 이후 finalize 가 status='error'(중단) 로 마무리.
router.post('/stop', (req, res) => {
  const messageId = parseInt(req.body && req.body.messageId, 10);
  if (!messageId) return res.status(400).json({ error: 'messageId 필수' });
  let row = null;
  try { row = ai.db.prepare('SELECT thread_id FROM ai_messages WHERE id=?').get(messageId); } catch (_) {}
  if (!row) return res.status(404).json({ error: '메시지 없음' });
  const t = ai.threads.get(row.thread_id);
  const isAdmin = req.user && req.user.role === 'admin';
  if (!t || (String(t.owner_id) !== String(req.user.userId) && !isAdmin)) {
    return res.status(403).json({ error: '권한 없음' });
  }
  const ok = reg.abort(messageId);   // 등록된 abort 가 있으면 자식 프로세스 종료
  res.json({ ok });
});

// ── 엑셀 스킬 템플릿 관리 (등록된 양식 조회/삭제) ──
// 등록(저장)은 "전월 마감파일을 첨부해서 작업"하면 자동으로 됨(agent-runtime storeSkillTemplates).
// 여기서는 등록된 것을 보고/지우는 관리 기능만 노출.
const TEMPLATE_SLUG_RE = /^[a-z0-9_-]+$/i;

// GET /api/ai/agent/skill-templates           → 전체 스킬별 등록 현황 요약
// GET /api/ai/agent/skill-templates/:slug      → 특정 스킬 등록 템플릿 목록
router.get('/skill-templates/:slug?', (req, res) => {
  try {
    const slug = req.params.slug;
    if (slug) {
      if (!TEMPLATE_SLUG_RE.test(slug)) return res.status(400).json({ error: '잘못된 스킬명' });
      const list = (agent.listStoredTemplates(slug) || []).map(t => ({
        name: t.name, mtimeMs: t.mtimeMs,
        sizeKB: (() => { try { return Math.round(require('fs').statSync(t.path).size / 1024); } catch { return null; } })(),
      }));
      return res.json({ ok: true, slug, templates: list });
    }
    // 전체 요약: 알려진 마감 스킬들의 등록 개수
    const slugs = ['persys-ledger', 'nicetech-ledger', 'haatz-ledger', 'partner-ledger', 'posco-statement'];
    const summary = slugs.map(s => ({ slug: s, count: (agent.listStoredTemplates(s) || []).length }));
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/ai/agent/skill-templates/:slug/:name   → 잘못 등록된 템플릿 삭제
router.delete('/skill-templates/:slug/:name', (req, res) => {
  try {
    const { slug, name } = req.params;
    if (!TEMPLATE_SLUG_RE.test(slug)) return res.status(400).json({ error: '잘못된 스킬명' });
    // 파일명에 경로구분자/상위이동 차단
    const safeName = require('path').basename(String(name || ''));
    if (!safeName || safeName !== name || safeName.includes('..')) {
      return res.status(400).json({ error: '잘못된 파일명' });
    }
    const dir = agent.getSkillTemplateDir(slug);
    if (!dir) return res.status(400).json({ error: '스킬 폴더 없음' });
    const target = require('path').join(dir, safeName);
    // dir 밖으로 못 나가게 한 번 더 확인
    if (!require('path').resolve(target).startsWith(require('path').resolve(dir))) {
      return res.status(400).json({ error: '경로 위반' });
    }
    if (!require('fs').existsSync(target)) return res.status(404).json({ error: '파일 없음' });
    require('fs').unlinkSync(target);
    res.json({ ok: true, deleted: safeName });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 결과 파일 다운로드/미리보기 ──
// /file/:userId/:sessionId/<relPath...>
router.get(/^\/file\/([^/]+)\/([^/]+)\/(.+)$/, (req, res) => {
  const userId = req.params[0];
  const sessionId = req.params[1];
  const relPath = req.params[2];

  // 본인 또는 admin 만
  if (String(userId) !== String(req.user.userId) && req.user.role !== 'admin') {
    return res.status(403).send('forbidden');
  }

  const full = agent.resolveSessionFile(userId, sessionId, relPath);
  if (!full) return res.status(404).send('not found');

  // inline 으로 보낼 것인가 download 인가?
  const inline = req.query.inline === '1';
  const ext = path.extname(full).toLowerCase();
  const inlineExts = new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp','.pdf','.txt','.md','.html','.json','.csv','.svg']);

  const filename = path.basename(full);
  if (inline && inlineExts.has(ext)) {
    const mime = {
      '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif',
      '.webp':'image/webp','.bmp':'image/bmp','.pdf':'application/pdf',
      '.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8',
      '.html':'text/html; charset=utf-8','.json':'application/json; charset=utf-8',
      '.csv':'text/csv; charset=utf-8','.svg':'image/svg+xml',
    }[ext];
    if (mime) res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  }
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(full);
});

// ── OpenAI 이미지 생성 (Agent 안 거치고 직접 호출 — 빠른 응답) ──
// body: { prompt, quality?, size?, attachmentIds? }
router.post('/image', async (req, res) => {
  if (!openaiClient || !openaiClient.apiKeyAvailable()) {
    return res.status(503).json({ error: 'OPENAI_API_KEY 미설정 — 이미지 생성 불가' });
  }
  const { prompt, quality, size, attachmentIds } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ error: 'prompt 필수' });
  }

  // 이미지 생성 일일 한도 (이미지만 카운트)
  try {
    const isAdmin = req.user.role === 'admin';
    const imageLimit = isAdmin
      ? parseInt(process.env.AI_IMAGE_DAILY_LIMIT_ADMIN || '100', 10)
      : parseInt(process.env.AI_IMAGE_DAILY_LIMIT_EMPLOYEE || '30', 10);
    const imageCount = (ai && ai.apiUsage && ai.apiUsage.countImagesToday)
      ? ai.apiUsage.countImagesToday(req.user.userId)
      : 0;
    if (imageCount >= imageLimit) {
      return res.status(429).json({ error: `오늘 이미지 생성 한도(${imageCount}/${imageLimit})를 초과했습니다.` });
    }
  } catch (_) {}

  // 참고 이미지 경로 (편집 모드)
  const refPaths = [];
  if (Array.isArray(attachmentIds) && attachmentIds.length && ai && ai.attachments) {
    try {
      const hydrated = ai.attachments.hydrate(attachmentIds);
      for (const a of hydrated) {
        if (!a || String(a.owner_id) !== String(req.user.userId)) continue;
        if (a.kind !== 'image') continue;
        const fp = path.join(ai.UPLOAD_DIR, a.stored_name);
        if (fs.existsSync(fp)) refPaths.push(fp);
      }
    } catch (_) {}
  }

  try {
    const result = await openaiClient.generateImage({
      prompt: String(prompt).trim(),
      quality, size,
      refImagePaths: refPaths.length ? refPaths : undefined,
    });
    if (!result.ok) return res.status(500).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
