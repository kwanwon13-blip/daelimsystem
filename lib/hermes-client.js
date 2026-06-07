/**
 * Hermes Agent API client.
 *
 * Environment:
 *   HERMES_BASE_URL=http://127.0.0.1:8642/v1
 *   HERMES_API_KEY=...
 *   HERMES_MODEL=hermes-agent
 *   HERMES_TIMEOUT_MS=600000
 *   HERMES_ALLOW_CLIENT_MODEL=0
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8642/v1';
const DEFAULT_MODEL = 'hermes-agent';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function cleanBaseUrl() {
  return String(process.env.HERMES_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function apiKey() {
  return String(process.env.HERMES_API_KEY || '').trim();
}

function apiKeyAvailable() {
  return !!apiKey();
}

function apiAvailable() {
  return !!cleanBaseUrl() && apiKeyAvailable();
}

function modelName(requestedModel) {
  if (String(process.env.HERMES_ALLOW_CLIENT_MODEL || '').trim() === '1' && requestedModel) {
    return String(requestedModel);
  }
  return String(process.env.HERMES_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function timeoutMs() {
  const n = parseInt(process.env.HERMES_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function endpoint(path) {
  const suffix = String(path || '').startsWith('/') ? path : '/' + path;
  return cleanBaseUrl() + suffix;
}

function headers(extra = {}) {
  return {
    Authorization: 'Bearer ' + apiKey(),
    'Content-Type': 'application/json',
    ...extra,
  };
}

function withTimeout(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
    },
  };
}

function toHermesContent(content) {
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (!part || typeof part !== 'object') return { type: 'text', text: String(part || '') };
    if (part.type === 'text') return { type: 'text', text: String(part.text || '') };
    if (part.type === 'image' && part.source && part.source.type === 'base64') {
      const mime = part.source.media_type || 'image/png';
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mime};base64,${part.source.data || ''}`,
          detail: 'high',
        },
      };
    }
    if (part.type === 'image_url') return part;
    return { type: 'text', text: JSON.stringify(part) };
  });
}

function toHermesMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: String(system) });
  for (const m of Array.isArray(messages) ? messages : []) {
    const role = m && m.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: toHermesContent(m && m.content) });
  }
  return out;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
  };
}

function extraHermesHeaders(options = {}) {
  const h = {};
  if (options.sessionId) h['X-Hermes-Session-Id'] = String(options.sessionId).slice(0, 256);
  if (options.sessionKey) h['X-Hermes-Session-Key'] = String(options.sessionKey).slice(0, 256);
  return h;
}

async function chat({ system, messages, model, maxTokens, signal, sessionId, sessionKey } = {}) {
  if (!apiAvailable()) throw new Error('HERMES_BASE_URL/HERMES_API_KEY 미설정');
  const started = Date.now();
  const req = withTimeout(signal);
  try {
    const body = {
      model: modelName(model),
      messages: toHermesMessages(messages, system),
      stream: false,
    };
    if (maxTokens) body.max_tokens = maxTokens;
    const resp = await fetch(endpoint('/chat/completions'), {
      method: 'POST',
      headers: headers(extraHermesHeaders({ sessionId, sessionKey })),
      signal: req.signal,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Hermes API ${resp.status}: ${errText.slice(0, 500)}`);
    }
    const data = await resp.json();
    return {
      text: String(data?.choices?.[0]?.message?.content || '').trim(),
      durationMs: Date.now() - started,
      usage: normalizeUsage(data.usage),
      model: data.model || body.model,
      raw: data,
    };
  } finally {
    req.cleanup();
  }
}

async function chatStream({ system, messages, model, maxTokens, signal, sessionId, sessionKey } = {}, onDelta, opts = {}) {
  if (!apiAvailable()) throw new Error('HERMES_BASE_URL/HERMES_API_KEY 미설정');
  const started = Date.now();
  const req = withTimeout(signal);
  let fullText = '';
  let usage = null;
  const body = {
    model: modelName(model),
    messages: toHermesMessages(messages, system),
    stream: true,
  };
  if (maxTokens) body.max_tokens = maxTokens;

  try {
    const resp = await fetch(endpoint('/chat/completions'), {
      method: 'POST',
      headers: headers(extraHermesHeaders({ sessionId, sessionKey })),
      signal: req.signal,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Hermes API ${resp.status}: ${errText.slice(0, 500)}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const rawEvent of events) {
        const lines = rawEvent.split(/\r?\n/);
        let eventType = 'message';
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim() || 'message';
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        const dataStr = dataLines.join('\n').trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        let data;
        try { data = JSON.parse(dataStr); } catch (_) { continue; }
        if (eventType === 'hermes.tool.progress' && opts.onToolProgress) {
          opts.onToolProgress(data);
          continue;
        }
        const delta = data?.choices?.[0]?.delta?.content || data?.choices?.[0]?.text || '';
        if (delta) {
          fullText += delta;
          if (onDelta) onDelta(delta);
        }
        if (data.usage) usage = normalizeUsage(data.usage);
      }
    }
    return {
      text: fullText.trim(),
      durationMs: Date.now() - started,
      usage,
      model: body.model,
    };
  } finally {
    req.cleanup();
  }
}

async function health(signal) {
  const req = withTimeout(signal);
  try {
    const resp = await fetch(endpoint('/health'), {
      method: 'GET',
      headers: headers(),
      signal: req.signal,
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    return await resp.json();
  } finally {
    req.cleanup();
  }
}

module.exports = {
  apiAvailable,
  apiKeyAvailable,
  modelName,
  chat,
  chatStream,
  health,
};
