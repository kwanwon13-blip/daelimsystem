/**
 * lib/claude-client.js — Claude 호출 공통 헬퍼 (API 모드 ↔ CLI 모드 자동 분기)
 *
 * 여러 라우터 (routes/ai-history.js, routes/workspace.js ...) 에서 공유.
 * AI 모드 제어 하나로 통일 — ANTHROPIC_API_KEY 존재 여부에 따라 자동 선택.
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY       있으면 API 모드, 없으면 CLI 모드
 *   ANTHROPIC_MODEL         모델 이름 (기본 claude-opus-4-8, API 모드 전용)
 *   ANTHROPIC_MAX_TOKENS    기본 응답 최대 토큰 (기본 2048, API 모드 전용)
 *   CLAUDE_CLI_TIMEOUT_MS   CLI 타임아웃 (기본 120000)
 *
 * API 목록:
 *   apiModeAvailable()                     → boolean
 *   currentMode()                          → 'api' | 'cli'
 *   callClaudeApi(messages, options)       → { text, durationMs, usage, stopReason, toolUses, raw }
 *   runClaudeCli(prompt, options)          → { text, durationMs }
 *   callClaude({system, user, maxTokens})  → text (문자열, API/CLI 자동 선택)
 */

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const DEFAULT_MAX_TOKENS = parseInt(process.env.ANTHROPIC_MAX_TOKENS || '2048', 10);
const DEFAULT_CLI_TIMEOUT = parseInt(process.env.CLAUDE_CLI_TIMEOUT_MS || '120000', 10);
// 병렬 처리 — 동시 spawn 슬롯 수. 직원 10명 환경에서 5 면 충분.
const MAX_CONCURRENT = parseInt(process.env.CLAUDE_CLI_MAX_CONCURRENT || '5', 10);
const MAX_QUEUE = parseInt(process.env.CLAUDE_CLI_MAX_QUEUE || '20', 10);

function apiBillingAllowed() {
  return String(process.env.AI_ALLOW_API_BILLING || '').trim() === '1';
}

function apiModeAvailable() {
  return apiBillingAllowed() && !!process.env.ANTHROPIC_API_KEY;
}

function currentMode() {
  return apiModeAvailable() ? 'api' : 'cli';
}

// ── 동시 실행 슬롯 매니저 (세마포어 + 대기열) ──────────
// CLI 호출이 N 개 동시 spawn 가능. 초과 시 대기열에 들어가서 슬롯 비면 자동 진입.
let _activeCount = 0;
const _waiters = [];

function _slotStats() {
  return { active: _activeCount, waiting: _waiters.length, max: MAX_CONCURRENT };
}

function _acquireSlot() {
  if (_activeCount < MAX_CONCURRENT) {
    _activeCount++;
    return Promise.resolve();
  }
  if (_waiters.length >= MAX_QUEUE) {
    return Promise.reject(new Error(`동시 요청 너무 많음 (대기열 ${MAX_QUEUE} 초과). 잠시 후 다시 시도하세요.`));
  }
  return new Promise(resolve => _waiters.push(resolve));
}

function _releaseSlot() {
  const next = _waiters.shift();
  if (next) {
    // 다음 대기자에게 슬롯 양도 (count 유지)
    next();
  } else {
    _activeCount--;
  }
}

/**
 * API 모드: Anthropic Messages API 호출 (Tool Use 지원)
 * @param {Array} messages - [{role:'user'|'assistant', content: string|array}]
 * @param {Object} options - { model, maxTokens, system, tools }
 * @returns {Promise<{text, durationMs, usage, stopReason, toolUses, raw}>}
 */
async function callClaudeApi(messages, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY 미설정 — API 모드 사용 불가');
  if (!apiBillingAllowed()) {
    throw new Error('Claude API billing disabled. Set AI_ALLOW_API_BILLING=1 only when paid API usage is intended.');
  }

  const model = options.model || DEFAULT_MODEL;
  const maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
  const system = options.system;
  const tools = options.tools;

  const started = Date.now();
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

  let response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Claude API 연결 실패: ${e.message}`);
  }

  if (!response.ok) {
    let errMsg = `Claude API ${response.status}`;
    try {
      const errBody = await response.json();
      errMsg += `: ${errBody.error?.message || JSON.stringify(errBody)}`;
    } catch (_) {
      errMsg += `: ${await response.text()}`;
    }
    throw new Error(errMsg);
  }

  const data = await response.json();
  const contents = Array.isArray(data.content) ? data.content : [];
  const text = contents.filter(c => c.type === 'text').map(c => c.text).join('');
  const toolUses = contents.filter(c => c.type === 'tool_use');

  return {
    text,
    durationMs: Date.now() - started,
    usage: data.usage || null,
    stopReason: data.stop_reason,
    toolUses,
    raw: data,
  };
}

/**
 * CLI 모드 — 내부 spawn 함수 (슬롯 매니저 없는 raw 버전)
 *
 * ⚠ 중요: Claude CLI 는 cwd 기반으로 프로젝트 상태(~/.claude/projects/<cwd-hash>/) 를 잠금.
 * 같은 cwd 에서 동시 spawn 시 직렬화됨 → 각 호출마다 고유 임시 폴더 사용해서 격리.
 */
function _spawnClaudeCli(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const crypto = require('crypto');
    const started = Date.now();
    const timeoutMs = options.timeoutMs || DEFAULT_CLI_TIMEOUT;

    // 호출별 고유 임시 cwd — Claude CLI 의 프로젝트 잠금 회피
    const tmpDir = path.join(os.tmpdir(), 'claude-chat-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) {}

    // 동작 검증된 ai-history.js runClaudeCli 와 동일 인자로 맞춤 —
    //   서버 claude CLI 의 '기본 모델/권한 설정'에 의존하면 빈 응답이 나옴(라이브 버그).
    //   --model: 모델 명시(서버 기본값 무시), --permission-mode bypassPermissions: 헤드리스 권한 UI 회피.
    const appRoot = path.join(__dirname, '..');
    const cliArgs = ['-p', '--model', DEFAULT_MODEL, '--permission-mode', 'bypassPermissions', '--add-dir', appRoot];
    // 파일 읽기가 필요한 호출(OCR 등)은 options.allowedTools='Read' 전달 → 헤드리스에서 Read 권한 자동 허용.
    if (options.allowedTools) cliArgs.push('--allowedTools', String(options.allowedTools));
    const child = spawn('claude', cliArgs, {
      cwd: tmpDir,                                // ← 핵심: 격리된 cwd 로 병렬 가능
      shell: true,
      env: { ...process.env, LANG: 'ko_KR.UTF-8' },
      windowsHide: true,
    });
    let out = '', err = '';
    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch(_) {}
      cleanup();
      reject(new Error(`claude CLI 응답 시간 초과 (${Math.round(timeoutMs/1000)}초)`));
    }, timeoutMs);
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('claude CLI 실행 실패: ' + e.message));
    });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        return reject(new Error((err || '').trim() || `claude CLI exit ${code}`));
      }
      resolve({ text: (out || '').trim(), durationMs: Date.now() - started });
    });
    try {
      child.stdin.write(prompt, 'utf8');
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      cleanup();
      reject(new Error('claude CLI stdin write 실패: ' + e.message));
    }
  });
}

/**
 * CLI 모드: `claude -p` 스폰 + 동시 실행 슬롯 관리
 * 슬롯 풀이 가득 차면 큐에서 대기 (직원 N명 동시 사용 시 안전).
 * @param {string} prompt - 전체 프롬프트
 * @param {Object} options - { timeoutMs }
 * @returns {Promise<{text, durationMs, waitedMs}>}
 */
async function runClaudeCli(prompt, options = {}) {
  const queueStart = Date.now();
  await _acquireSlot();
  const waitedMs = Date.now() - queueStart;
  try {
    const result = await _spawnClaudeCli(prompt, options);
    return { ...result, waitedMs };
  } finally {
    _releaseSlot();
  }
}

/**
 * 현재 슬롯 상태 조회 (모니터링/디버그용)
 * @returns {{active: number, waiting: number, max: number}}
 */
function getSlotStats() {
  return _slotStats();
}

/**
 * 단순 호출: {system, user} 받아서 텍스트 응답 반환 (API/CLI 자동 선택)
 * - API 모드: system/user 분리해서 Messages API 호출
 * - CLI 모드: system + user 를 하나로 합쳐서 stdin 주입
 * @param {Object} opts - { system: string, user: string, maxTokens?: number }
 * @returns {Promise<string>}
 */
async function callClaude({ system, user, maxTokens } = {}) {
  if (!user) throw new Error('user 프롬프트 필수');

  if (apiModeAvailable()) {
    const result = await callClaudeApi(
      [{ role: 'user', content: user }],
      { system, maxTokens }
    );
    return result.text;
  }

  // CLI 모드
  const fullPrompt = (system ? system + '\n\n== 사용자 요청 ==\n' : '') + user;
  const result = await runClaudeCli(fullPrompt);
  return result.text;
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CLI_TIMEOUT,
  MAX_CONCURRENT,
  MAX_QUEUE,
  apiBillingAllowed,
  apiModeAvailable,
  currentMode,
  callClaudeApi,
  runClaudeCli,
  callClaude,
  getSlotStats,
};
