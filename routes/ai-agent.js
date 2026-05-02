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
const { requireAuth } = require('../middleware/auth');
const agent = require('../lib/agent-runtime');
const ai = require('../db-ai');

let openaiClient = null;
try { openaiClient = require('../lib/openai-client'); } catch(_) {}

router.use(requireAuth);

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
        if (fs.existsSync(fp)) attachmentPaths.push(fp);
      }
    } catch (e) {
      console.warn('[ai-agent] 첨부 hydrate 실패:', e.message);
    }
  }

  // ── 스레드 확보 + 사용자 메시지 DB 저장 ──
  let thread = null;
  let userMsgId = null;
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
        attachmentIds: Array.isArray(attachmentIds) ? attachmentIds : [],
      });
      userMsgId = um?.id;
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

  // 클라이언트 연결 끊김 감지 → 작업 취소
  const ctrl = new AbortController();
  req.on('close', () => {
    ctrl.abort();
    clearInterval(ping);
  });

  try {
    // 텍스트 메시지는 일일 한도 없음 (이미지 생성에만 제한 적용)

    let lastDone = null;
    let lastError = null;
    let collectedOutput = '';
    let collectedFiles = [];
    for await (const evt of agent.runAgent({
      userId: req.user.userId,
      task: String(task).trim(),
      attachmentPaths,
      signal: ctrl.signal,
    })) {
      // thread 정보를 첫 'started' 에 끼워서 클라이언트에 알려주기
      if (evt.type === 'started' && thread) {
        send('started', { ...evt.data, threadId: thread.id, userMsgId });
      } else {
        send(evt.type, evt.data);
      }
      if (evt.type === 'output') collectedOutput += evt.data?.text || '';
      if (evt.type === 'file') collectedFiles.push(evt.data);
      if (evt.type === 'done') lastDone = evt.data;
      if (evt.type === 'error') lastError = evt.data;
    }

    // ── DB 에 결과 저장 (thread 가 있으면) ──
    if (thread && ai.threads && ai.threads.addMessage) {
      try {
        const status = lastError ? 'error' : 'ok';
        const summary = lastError
          ? ('❌ ' + (lastError.message || '에러'))
          : `✓ Agent 완료 (${(lastDone?.files || collectedFiles).length}개 파일, ${Math.round((lastDone?.durationMs||0)/1000)}초)`;
        const files = (lastDone?.files || collectedFiles || []).map(f => ({
          name: f.name,
          relPath: f.relPath,
          size: f.size,
          ext: f.ext,
          url: '/api/ai/agent/file/' + encodeURIComponent(req.user.userId)
               + '/' + encodeURIComponent(lastDone?.sessionId || '')
               + '/' + encodeURIComponent(f.relPath || ''),
        }));
        const aiMsg = ai.threads.addMessage(thread.id, {
          role: 'ai', kind: 'agent',
          content: summary,
          status,
          error: lastError ? lastError.message : null,
          durationMs: lastDone?.durationMs || 0,
          metadata: {
            sessionId: lastDone?.sessionId,
            files,
            outputTail: (collectedOutput || '').slice(-2000),  // 마지막 2KB 만 저장
          },
        });
        try { ai.threads.autoTitleIfEmpty && ai.threads.autoTitleIfEmpty(thread.id); } catch(_) {}
        send('saved', { threadId: thread.id, messageId: aiMsg?.id });
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
