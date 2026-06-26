'use strict';
// lib/vision-caption.js — 실제 그림을 GPT-4o 비전으로 읽어 7축 캡션 생성.
//
// 프롬프트 텍스트(생성 지시·스펙) 기반 분류는 노이즈가 많아(키워드 쓸모없음, 거래처 빈값),
// 여기서는 결과 이미지를 비전으로 직접 보고 깔끔한 캡션을 만든다.
//
// 순수성: 부작용 없음. openaiClient 는 함수 안에서 require.
//   ready()                         → boolean (API 키 있음 여부)
//   captionImageFile(absPath, opts) → Promise<{ ok, type, client, keywords, caption,
//                                               material, usage, text_in, visual }>

const fs = require('fs');

// 비전에 줄 프롬프트 — JSON 한 덩어리만 답하게(설명/코드펜스 최소화 유도).
const VISION_PROMPT =
  '이 이미지를 보고 아래 JSON으로만 답해. 설명 금지. ' +
  '{"type":"종류 한 단어(현수막/포스터/로고/스티커/간판/현황판/캐릭터/배경/제품/일러스트/기타)",' +
  '"client":"보이는 회사·브랜드명(없으면 빈문자열)",' +
  '"material":"자재 보이면(포맥스/타포린/PE/투명스티커/고무자석 등) 없으면 빈문자열",' +
  '"usage":"용도·주제(안전/홍보/행사/MSDS/공사현황 등 없으면 빈문자열)",' +
  '"text":"이미지 속 핵심 문구(없으면 빈문자열)",' +
  '"visual":"색상·구성·분위기 한 줄",' +
  '"keywords":"검색용 한국어 키워드 5개 쉼표"}';

// 비전 전용 모델 — 텍스트 챗 모델(gpt-5.4-nano/mini)은 image_url 입력을 못 받을 수 있어
// 명시적으로 비전 대응 모델을 쓴다. 환경변수로 교체 가능(서버 OPENAI 계정에 맞춰).
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o';

// 응답 텍스트에서 JSON 객체만 안전하게 뽑아 파싱. 실패하면 null.
function extractJson(text) {
  if (!text) return null;
  let s = String(text);
  // 코드펜스(```json ... ```) 제거.
  s = s.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = s.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch (_) {
    return null;
  }
}

// KNOWN_CLIENTS 별칭 매칭으로 표준 거래처명 정규화. 매칭 안 되면 입력값 trim 유지.
function normalizeClient(raw) {
  const val = String(raw || '').trim();
  if (!val) return '';
  let KNOWN_CLIENTS = [];
  try {
    KNOWN_CLIENTS = require('./image-classify').KNOWN_CLIENTS || [];
  } catch (_) {
    return val;
  }
  const lower = val.toLowerCase();
  const latinTokens = new Set(lower.match(/[a-z0-9]+/g) || []);
  for (const c of KNOWN_CLIENTS) {
    for (const a of (c.alias || [])) {
      const shortLatin = /^[a-z0-9]{1,2}$/.test(a);
      const hit = shortLatin ? latinTokens.has(a) : lower.includes(a);
      if (hit) return c.name;
    }
  }
  return val;
}

// keywords 를 항상 "쉼표 연결 문자열" 로 정규화(배열로 와도 처리).
function normalizeKeywords(raw) {
  if (Array.isArray(raw)) {
    return raw.map(k => String(k).trim()).filter(Boolean).join(',');
  }
  return String(raw || '').trim();
}

/**
 * ready — 비전 호출 가능 여부(OPENAI_API_KEY 설정 여부).
 * @returns {boolean}
 */
function ready() {
  try {
    const openaiClient = require('./openai-client');
    return !!openaiClient.apiKeyAvailable();
  } catch (_) {
    return false;
  }
}

/**
 * captionImageFile — 실제 이미지 파일을 비전으로 읽어 7축 캡션 생성.
 * @param {string} absPath 이미지 절대경로
 * @param {{isAdmin?: boolean, maxTokens?: number, model?: string}} [opts]
 * @returns {Promise<{ok, type, client, keywords, caption, material, usage, text_in, visual}>}
 */
async function captionImageFile(absPath, opts = {}) {
  const fail = { ok: false };
  if (!absPath) return fail;
  try {
    if (!fs.existsSync(absPath)) return fail;
  } catch (_) {
    return fail;
  }

  let openaiClient;
  try {
    openaiClient = require('./openai-client');
  } catch (_) {
    return fail;
  }
  if (!openaiClient.apiKeyAvailable || !openaiClient.apiKeyAvailable()) return fail;

  let res;
  try {
    res = await openaiClient.vision({
      prompt: VISION_PROMPT,
      imagePaths: [absPath],
      isAdmin: !!opts.isAdmin,
      maxTokens: opts.maxTokens || 512,
      model: opts.model || VISION_MODEL,
    });
  } catch (_) {
    return fail;
  }

  const parsed = extractJson(res && res.text);
  if (!parsed || typeof parsed !== 'object') return fail;

  const type = String(parsed.type || '').trim();
  const client = normalizeClient(parsed.client);
  const material = String(parsed.material || '').trim();
  const usage = String(parsed.usage || '').trim();
  const text_in = String(parsed.text || '').trim();
  const visual = String(parsed.visual || '').trim();
  const keywords = normalizeKeywords(parsed.keywords);

  // 검색 합본 — 비어있는 축은 제외하고 공백 연결.
  const caption = [type, client, material, usage, text_in, visual, keywords]
    .filter(Boolean)
    .join(' ');

  return {
    ok: true,
    type,
    client,
    keywords,
    caption,
    material,
    usage,
    text_in,
    visual,
  };
}

module.exports = { captionImageFile, ready };
