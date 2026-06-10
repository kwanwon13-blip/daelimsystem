/**
 * claude-bridge.js — claude -p(구독) → OpenAI 호환 API 통역 서버
 *
 * Odysseus / ERP / 그 외 OpenAI 호환 클라이언트가 이 서버를 "모델 주소"로 쓰면,
 * 내부적으로 claude CLI(구독)를 호출해 답을 OpenAI 형식으로 돌려준다. → API 토큰요금 0.
 *
 * 실행:  node claude-bridge.js
 * 환경변수:
 *   CLAUDE_BRIDGE_PORT   포트 (기본 8765)
 *   CLAUDE_BRIDGE_KEY    설정 시 Authorization: Bearer <키> 요구 (미설정이면 인증 없음 — 사내망 전용)
 *   CLAUDE_BRIDGE_MODEL  기본 모델 (기본 claude-opus-4-8)
 *
 * 엔드포인트:
 *   POST /v1/chat/completions   (stream / non-stream)
 *   GET  /v1/models
 *   GET  /health
 */
const express = require('express');
const crypto = require('crypto');
const { callClaudeCli, callClaudeCliStream } = require('./lib/claude-cli');

const PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || '8765', 10);
// 기본 127.0.0.1(로컬 전용). LAN/도커 노출은 의도적으로 CLAUDE_BRIDGE_HOST=0.0.0.0 설정 시에만.
const HOST = (process.env.CLAUDE_BRIDGE_HOST || '127.0.0.1').trim();
const AUTH_KEY = (process.env.CLAUDE_BRIDGE_KEY || '').trim();
const DEFAULT_MODEL = (process.env.CLAUDE_BRIDGE_MODEL || 'claude-opus-4-8').trim();

const app = express();
app.use(express.json({ limit: '25mb' }));
// CORS (Odysseus 가 도커/다른 오리진일 수 있음)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// 선택적 인증
app.use((req, res, next) => {
  if (!AUTH_KEY) return next();
  if (req.path === '/health') return next();
  const h = String(req.headers.authorization || '');
  const tok = h.replace(/^Bearer\s+/i, '').trim();
  if (tok !== AUTH_KEY) return res.status(401).json({ error: { message: 'invalid api key', type: 'auth' } });
  next();
});

// OpenAI content(string | [{type:'text',text}|{type:'image_url',...}]) → 텍스트
function contentToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => {
      if (!p || typeof p !== 'object') return String(p || '');
      if (p.type === 'text') return String(p.text || '');
      if (p.type === 'image_url') return '[이미지 첨부 — 현재 브릿지는 텍스트만 지원]';
      return '';
    }).join('');
  }
  return String(c);
}

// OpenAI messages → { systemPrompt, prompt }
function buildPrompt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sys = list.filter(m => m && m.role === 'system').map(m => contentToText(m.content)).join('\n\n').trim();
  const convo = list.filter(m => m && m.role !== 'system');
  // 대화 전체를 전사로 넘겨 claude 가 마지막 사용자 발화에 답하게 한다.
  const prompt = convo.map(m =>
    (m.role === 'assistant' ? 'Assistant: ' : 'User: ') + contentToText(m.content)
  ).join('\n\n');
  return { systemPrompt: sys || undefined, prompt: prompt || ' ' };
}

function pickModel(reqModel) {
  const m = String(reqModel || '').trim();
  return /^claude/i.test(m) ? m : DEFAULT_MODEL;
}

function chunkObj(id, model, delta, finish) {
  return {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  };
}

app.get('/health', (req, res) => res.json({ ok: true, backend: 'claude-cli', model: DEFAULT_MODEL }));

app.get('/v1/models', (req, res) => {
  res.json({ object: 'list', data: [{ id: DEFAULT_MODEL, object: 'model', created: 0, owned_by: 'anthropic-cli' }] });
});

app.post('/v1/chat/completions', async (req, res) => {
  const body = req.body || {};
  const model = pickModel(body.model);
  const { systemPrompt, prompt } = buildPrompt(body.messages);
  const stream = body.stream === true;
  const id = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const opts = {
    model,
    systemPrompt,
    chatMode: true,       // 순수 대화(파일시스템 격리 + 쉘/쓰기 도구 차단)
    strictMcp: true,      // MCP 미로딩 → 첫 토큰 빠름
    timeout: parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS || '600000', 10),
  };

  try {
    if (!stream) {
      const r = await callClaudeCli(prompt, [], opts);
      const text = (r && (r.text || r)) || '';
      return res.json({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: 'assistant', content: String(text) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    // 스트리밍 (OpenAI SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders && res.flushHeaders();
    const send = (o) => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch (_) {} };
    send(chunkObj(id, model, { role: 'assistant' }, null));   // 첫 청크: role
    let streamP;
    res.on('close', () => { try { streamP && streamP.abort && streamP.abort(); } catch (_) {} });
    streamP = callClaudeCliStream(prompt, [], (delta) => {
      if (delta) send(chunkObj(id, model, { content: String(delta) }, null));
    }, opts);
    await streamP;
    send(chunkObj(id, model, {}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    if (stream) {
      try { res.write('data: ' + JSON.stringify(chunkObj(id, model, { content: '\n[오류] ' + e.message }, 'stop')) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
    } else {
      res.status(500).json({ error: { message: e.message, type: 'bridge_error' } });
    }
  }
});

// 직접 실행(node claude-bridge.js)할 때만 listen. require 시(테스트)엔 app 만 노출.
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log('[claude-bridge] OpenAI 호환 → claude -p 통역 서버');
    console.log('[claude-bridge] http://' + HOST + ':' + PORT + '/v1   (model: ' + DEFAULT_MODEL + ', auth: ' + (AUTH_KEY ? 'on' : 'off') + ', bind: ' + HOST + ')');
  });
}

module.exports = { app, buildPrompt, contentToText, pickModel };
