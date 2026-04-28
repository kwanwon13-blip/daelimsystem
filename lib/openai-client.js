/**
 * lib/openai-client.js — OpenAI API 통합 클라이언트
 *
 * 직원 도입용 — 가벼움 + 안정성 우선.
 *
 * 환경변수:
 *   OPENAI_API_KEY              필수 — sk-proj-... 또는 sk-...
 *   OPENAI_TEXT_MODEL           기본 챗 모델 (기본: gpt-5.4-nano)
 *   OPENAI_TEXT_MODEL_ADMIN     관리자 챗 모델 (기본: gpt-5.4-mini)
 *   OPENAI_IMAGE_MODEL          이미지 생성 모델 (기본: gpt-image-2)
 *   OPENAI_IMAGE_QUALITY_DEFAULT  기본 이미지 품질 (low/medium/high, 기본 medium)
 *   OPENAI_TIMEOUT_MS           요청 타임아웃 (기본 90000)
 *
 * 사용 가능한 함수:
 *   apiKeyAvailable()                     boolean
 *   chat({system, messages, model, maxTokens, isAdmin})           → text
 *   chatStream({system, messages, model, maxTokens, isAdmin}, onDelta)  → text (SSE)
 *   generateImage({prompt, quality, size, refImagePaths, saveDir})       → {ok, url, durationMs}
 *   vision({prompt, imagePaths, model})                                  → text
 *
 * gpt-image-2 1024×1024 가격:
 *   low    $0.006/장
 *   medium $0.053/장   ← 기본
 *   high   $0.211/장
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-5.4-nano';
const DEFAULT_TEXT_MODEL_ADMIN = process.env.OPENAI_TEXT_MODEL_ADMIN || 'gpt-5.4-mini';
const DEFAULT_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const DEFAULT_IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY_DEFAULT || 'medium';
const DEFAULT_TIMEOUT = parseInt(process.env.OPENAI_TIMEOUT_MS || '90000', 10);

function apiKeyAvailable() {
  return !!process.env.OPENAI_API_KEY;
}

function pickTextModel(isAdmin) {
  return isAdmin ? DEFAULT_TEXT_MODEL_ADMIN : DEFAULT_TEXT_MODEL;
}

// ── 공통 fetch with timeout ─────────────────────────────
async function fetchWithTimeout(url, opts, timeoutMs = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ──────────────────────────────────────────────────────────
// Chat — 단발 응답 (non-streaming). 단순하고 가볍다.
// ──────────────────────────────────────────────────────────
/**
 * @param {Object} opts
 * @param {string} opts.system - 시스템 프롬프트 (캐싱 자동 적용)
 * @param {Array} opts.messages - [{role:'user'|'assistant', content: string|array}]
 * @param {string} [opts.model] - 명시적 모델 (생략 시 isAdmin 기반 자동)
 * @param {boolean} [opts.isAdmin] - 관리자 여부 (모델 자동 선택용)
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{text, durationMs, usage, model}>}
 */
async function chat({ system, messages, model, isAdmin = false, maxTokens = 2048 } = {}) {
  if (!apiKeyAvailable()) throw new Error('OPENAI_API_KEY 미설정');
  const useModel = model || pickTextModel(isAdmin);
  const started = Date.now();

  const fullMessages = [];
  if (system) fullMessages.push({ role: 'system', content: system });
  if (Array.isArray(messages)) fullMessages.push(...messages);

  const body = {
    model: useModel,
    messages: fullMessages,
    max_tokens: maxTokens,
  };

  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return {
    text: String(text).trim(),
    durationMs: Date.now() - started,
    usage: data.usage || null,
    model: data.model || useModel,
  };
}

// ──────────────────────────────────────────────────────────
// Chat Stream — SSE 스트리밍. 직원 챗 UX 가 훨씬 빨라보임.
// onDelta(textChunk) 콜백으로 부분 응답 전달.
// ──────────────────────────────────────────────────────────
async function chatStream({ system, messages, model, isAdmin = false, maxTokens = 2048 } = {}, onDelta) {
  if (!apiKeyAvailable()) throw new Error('OPENAI_API_KEY 미설정');
  const useModel = model || pickTextModel(isAdmin);
  const started = Date.now();

  const fullMessages = [];
  if (system) fullMessages.push({ role: 'system', content: system });
  if (Array.isArray(messages)) fullMessages.push(...messages);

  const body = {
    model: useModel,
    messages: fullMessages,
    max_tokens: maxTokens,
    stream: true,
  };

  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, DEFAULT_TIMEOUT * 2);  // 스트리밍은 좀 더 길게

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${errText.slice(0, 400)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullText = '';
  let buffer = '';
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 마지막 줄은 미완일 수 있어 다시 buffer 로
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const evt = JSON.parse(data);
        const delta = evt?.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          if (typeof onDelta === 'function') onDelta(delta);
        }
        if (evt.usage) usage = evt.usage;
      } catch (e) { /* 파싱 실패는 무시 (keepalive 등) */ }
    }
  }

  return {
    text: fullText.trim(),
    durationMs: Date.now() - started,
    usage,
    model: useModel,
  };
}

// ──────────────────────────────────────────────────────────
// Image Generation — gpt-image-2 (or set via env)
// 참고 이미지 있으면 /v1/images/edits, 없으면 /v1/images/generations
// ──────────────────────────────────────────────────────────
const IMAGE_QUALITY_VALID = new Set(['low', 'medium', 'high']);
const IMAGE_SIZE_VALID = new Set(['1024x1024', '1024x1536', '1536x1024', '2048x2048']);

/**
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.quality]   low/medium/high (기본 medium)
 * @param {string} [opts.size]      1024x1024 (기본)
 * @param {string} [opts.model]     gpt-image-2 (기본 env)
 * @param {string[]} [opts.refImagePaths]  참고 이미지 경로 (있으면 edit 모드)
 * @param {string} [opts.saveDir]   저장 디렉토리 (기본 data/workspace-images)
 * @returns {Promise<{ok, url, durationMs, error?, sizeBytes?}>}
 */
// 단일 모델로 호출 시도 — 폴백 로직은 generateImage 가 처리
async function tryGenerateOnce({ prompt, useQuality, useSize, useModel, refImagePaths, dir }) {
  const started = Date.now();
  const hasRef = Array.isArray(refImagePaths) && refImagePaths.length > 0;
  try {
    let resp;
    if (hasRef) {
      // edits API — multipart/form-data
      const FormData = globalThis.FormData;
      const form = new FormData();
      form.append('model', useModel);
      form.append('prompt', prompt);
      form.append('size', useSize);
      form.append('quality', useQuality);
      form.append('n', '1');
      for (let i = 0; i < refImagePaths.length; i++) {
        const p = refImagePaths[i];
        if (!fs.existsSync(p)) continue;
        const buf = fs.readFileSync(p);
        const fname = path.basename(p);
        const blob = new Blob([buf], { type: detectMime(fname) });
        form.append(refImagePaths.length > 1 ? 'image[]' : 'image', blob, fname);
      }
      resp = await fetchWithTimeout('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
        body: form,
      }, DEFAULT_TIMEOUT * 2);
    } else {
      resp = await fetchWithTimeout('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: useModel,
          prompt,
          size: useSize,
          quality: useQuality,
          n: 1,
        }),
      }, DEFAULT_TIMEOUT * 2);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      return { ok: false, status: resp.status, error: `OpenAI ${resp.status}: ${errText.slice(0, 300)}`, durationMs: Date.now() - started };
    }
    const data = await resp.json();
    const item = data?.data?.[0];
    if (!item) return { ok: false, error: '응답에 이미지 없음', durationMs: Date.now() - started };

    let buf;
    if (item.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const r2 = await fetchWithTimeout(item.url, {}, DEFAULT_TIMEOUT);
      if (!r2.ok) return { ok: false, error: '이미지 URL 다운로드 실패: HTTP ' + r2.status };
      buf = Buffer.from(await r2.arrayBuffer());
    } else {
      return { ok: false, error: '이미지 데이터 형식 알 수 없음' };
    }

    const fileName = `ai_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.png`;
    const fullPath = path.join(dir, fileName);
    fs.writeFileSync(fullPath, buf);
    const url = `/data/workspace-images/${fileName}`;

    return {
      ok: true,
      url,
      durationMs: Date.now() - started,
      sizeBytes: buf.length,
      model: useModel,
      quality: useQuality,
      size: useSize,
    };
  } catch (e) {
    return { ok: false, error: e.message, durationMs: Date.now() - started };
  }
}

async function generateImage({ prompt, quality, size, model, refImagePaths, saveDir } = {}) {
  if (!apiKeyAvailable()) return { ok: false, error: 'OPENAI_API_KEY 미설정' };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'prompt 필수' };

  const useModel = model || DEFAULT_IMAGE_MODEL;
  const useQuality = IMAGE_QUALITY_VALID.has(quality) ? quality : DEFAULT_IMAGE_QUALITY;
  const useSize = IMAGE_SIZE_VALID.has(size) ? size : '1024x1024';
  const dir = saveDir || path.join(__dirname, '..', 'data', 'workspace-images');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // 1차 — 사용자가 지정한(또는 default) 모델
  const result = await tryGenerateOnce({ prompt, useQuality, useSize, useModel, refImagePaths, dir });
  if (result.ok) return result;

  // 403 + "must be verified" → 조직 인증 안 됨 → gpt-image-1 로 자동 폴백
  // (gpt-image-1 은 Tier1 부터 인증 없이 사용 가능)
  const isVerifyError = result.status === 403 && /must be verified|verified to use the model/i.test(result.error || '');
  if (isVerifyError && useModel !== 'gpt-image-1') {
    console.warn('[openai-client] ' + useModel + ' 조직 인증 필요 → gpt-image-1 로 자동 폴백');
    const fallback = await tryGenerateOnce({ prompt, useQuality, useSize, useModel: 'gpt-image-1', refImagePaths, dir });
    if (fallback.ok) {
      return {
        ...fallback,
        _fallback: true,
        _fallbackFrom: useModel,
        _fallbackReason: 'org_not_verified',
        _fallbackHint: 'OpenAI 조직 인증 시 ' + useModel + ' 사용 가능: https://platform.openai.com/settings/organization/general',
      };
    }
    // 폴백도 실패하면 원래 에러를 더 친절하게
    if (fallback.status === 403 && /must be verified|verified to use the model/i.test(fallback.error || '')) {
      return {
        ok: false,
        error: 'OpenAI 조직 인증 필요 — https://platform.openai.com/settings/organization/general 에서 Verify Organization 클릭 (15분 내 적용)',
        status: 403,
        durationMs: result.durationMs,
        _verificationRequired: true,
      };
    }
    return fallback;
  }

  return result;
}

function detectMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return {
    '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
    '.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp'
  }[ext] || 'application/octet-stream';
}

// ──────────────────────────────────────────────────────────
// Vision — 이미지 첨부해서 분석 요청 (GPT-4o vision 호환 메시지 형식)
// ──────────────────────────────────────────────────────────
/**
 * @param {Object} opts
 * @param {string} opts.prompt
 * @param {string[]} opts.imagePaths
 * @param {string} [opts.model]
 * @param {boolean} [opts.isAdmin]
 * @returns {Promise<{text, durationMs, usage, model}>}
 */
async function vision({ prompt, imagePaths = [], model, isAdmin = false, maxTokens = 1024 } = {}) {
  if (!apiKeyAvailable()) throw new Error('OPENAI_API_KEY 미설정');
  if (!prompt) throw new Error('prompt 필수');
  const useModel = model || pickTextModel(isAdmin);

  const content = [{ type: 'text', text: prompt }];
  for (const p of imagePaths) {
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    const mime = detectMime(p);
    content.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
    });
  }

  return await chat({
    system: undefined,
    messages: [{ role: 'user', content }],
    model: useModel,
    maxTokens,
    isAdmin,
  });
}

module.exports = {
  apiKeyAvailable,
  pickTextModel,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TEXT_MODEL_ADMIN,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  chat,
  chatStream,
  generateImage,
  vision,
};
