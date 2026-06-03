/**
 * lib/claude-cli.js — Claude Code CLI 호출 (구독 안에서 무료)
 *
 * 사용:
 *   await callClaudeCli('한 문장 답변해줘')
 *   await callClaudeCli('이 이미지 분석', ['/path/to/image.jpg'])  // 멀티모달
 *
 * Claude Code CLI 는 prompt 안에 @/full/path 형태로 파일 경로 넣으면 자동으로 읽음.
 * --add-dir 로 ERP 루트 인식시킴.
 *
 * ⚠ Claude CLI 는 cwd 기반 프로젝트 잠금 → 같은 cwd 동시 spawn 시 직렬화.
 *   호출마다 고유 임시 폴더로 격리해야 진짜 병렬.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

/**
 * Claude CLI 호출
 * @param {string} prompt - 텍스트 프롬프트 (필요하면 @파일경로 포함)
 * @param {string[]} attachmentPaths - 이미지/PDF 파일 경로 배열 (자동으로 prompt에 @경로 추가)
 * @param {object} opts - { timeout, model }
 */
function callClaudeCli(prompt, attachmentPaths = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tmpDir = path.join(os.tmpdir(), 'claude-cli-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

    // 첨부 파일 경로를 prompt 앞에 @경로 형태로 추가 (Claude Code 의 멀티모달 입력)
    let fullPrompt = '';
    const addDirs = new Set([APP_ROOT]);
    for (const p of (attachmentPaths || [])) {
      if (p && fs.existsSync(p)) {
        fullPrompt += `@${p}\n`;
        addDirs.add(path.dirname(p));
      }
    }
    fullPrompt += prompt;

    const args = [
      '-p',
      '--model', opts.model || DEFAULT_MODEL,
      '--permission-mode', 'bypassPermissions',
    ];
    for (const dir of addDirs) {
      args.push('--add-dir', dir);
    }

    const child = spawn('claude', args, {
      cwd: tmpDir,
      shell: true,
      env: { ...process.env, LANG: 'ko_KR.UTF-8', TZ: 'Asia/Seoul' },
      windowsHide: true,
    });

    let out = '', err = '';
    const timeout = opts.timeout || 900000; // 15분 기본 (엑셀·PDF 처리는 진짜 오래 걸림)
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch(_) {}
      cleanup();
      reject(new Error('claude CLI timeout (' + Math.round(timeout/60000) + '분 초과)'));
    }, timeout);

    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); cleanup(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0) {
        return reject(new Error((err || '').trim() || `claude exit ${code}`));
      }
      resolve({
        text: (out || '').trim(),
        durationMs: Date.now() - started,
        stderr: err.trim(),
      });
    });

    child.stdin.write(fullPrompt, 'utf8');
    child.stdin.end();
  });
}

/**
 * 응답에서 ```json ... ``` 래퍼 제거 후 JSON 파싱
 */
function parseJsonFromResponse(text) {
  let s = (text || '').trim();
  // 첫 ```json ... ``` 블록 추출
  const fenceMatch = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) s = fenceMatch[1].trim();
  // 첫 { ... } 블록 찾기 (응답에 설명문 섞여있을 때)
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s);
}

/**
 * 스트리밍 버전 — Claude 가 토큰을 생성하는 즉시 onChunk 콜백 호출 (진짜 실시간 스트리밍).
 *
 * `--output-format stream-json --include-partial-messages` 로 CLI 가 토큰 단위 JSON 이벤트를
 * 내보내고, 이를 줄 단위로 파싱해서 text_delta 만 onChunk 로 흘려보낸다.
 * (예전 버전은 일반 텍스트 출력이라 응답이 끝에 한꺼번에 도착 = 가짜 스트리밍이었음)
 *
 * resolve 는 프로세스 완료 시 { text, durationMs, harvested, usage, costUsd }.
 * 반환된 promise 에 .abort() 메서드 추가 — 사용자가 중단 누르면 호출.
 *
 * opts:
 *   model            모델 ID
 *   timeout          ms
 *   systemPrompt     커스텀 시스템 프롬프트 (임시파일로 --system-prompt-file 주입)
 *   strictMcp        true (기본) 면 --strict-mcp-config (MCP 서버 미로딩 → 빠름)
 *   chatMode         true 면 클로드챗처럼: 파일시스템(APP_ROOT) 격리 + 변경/쉘 도구 차단
 *   disallowedTools  명시적 차단 도구 배열 (chatMode 기본값 override)
 *   onChunk(text)    답변 텍스트 델타
 *   onThinking(text) (선택) 사고 과정 델타
 *   onMeta({usage,costUsd,isError}) (선택)
 *   harvestFiles(tmpDir) / onTmpDir(tmpDir)  파일 생성 작업용 (chatMode 에선 보통 불필요)
 */
function callClaudeCliStream(prompt, attachmentPaths, onChunk, opts) {
  attachmentPaths = attachmentPaths || [];
  opts = opts || {};
  let child = null;
  let killed = false;
  const promise = new Promise((resolve, reject) => {
    const started = Date.now();
    const tmpDir = path.join(os.tmpdir(), 'claude-cli-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

    let fullPrompt = '';
    // 채팅 모드는 클로드챗처럼 파일시스템 격리 — APP_ROOT 를 추가하지 않음.
    // (첨부 파일이 있으면 그 폴더만 임시로 허용)
    const addDirs = new Set();
    if (!opts.chatMode) addDirs.add(APP_ROOT);
    for (const p of (attachmentPaths || [])) {
      if (p && fs.existsSync(p)) {
        fullPrompt += '@' + p + '\n';
        addDirs.add(path.dirname(p));
      }
    }
    fullPrompt += prompt;

    const args = [
      '-p',
      '--model', opts.model || DEFAULT_MODEL,
      '--permission-mode', 'bypassPermissions',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
    ];
    // MCP 서버 미로딩 (claude.ai 커넥터들이 pending/needs-auth 라 첫 토큰까지 10초+ 걸리는 주범)
    if (opts.strictMcp !== false) args.push('--strict-mcp-config');
    // 커스텀 시스템 프롬프트 — 길고 한글/따옴표가 많아 인자 직접 전달은 위험 → 파일로
    if (opts.systemPrompt) {
      try {
        const spPath = path.join(tmpDir, '_system.txt');
        fs.writeFileSync(spPath, String(opts.systemPrompt), 'utf8');
        args.push('--system-prompt-file', spPath);
      } catch (_) {}
    }
    // 도구 제한 — 채팅 모드는 변경/쉘/에이전트 도구 차단해서 순수 대화로 (단일 턴, 빠름, 안전)
    const disallowed = opts.disallowedTools
      || (opts.chatMode ? ['Bash', 'Write', 'Edit', 'NotebookEdit', 'Task', 'KillShell', 'WebSearch', 'WebFetch'] : null);
    if (disallowed && disallowed.length) args.push('--disallowedTools', disallowed.join(' '));
    for (const dir of addDirs) args.push('--add-dir', dir);

    child = spawn('claude', args, {
      cwd: tmpDir, shell: true,
      env: Object.assign({}, process.env, { LANG: 'ko_KR.UTF-8', TZ: 'Asia/Seoul' }),
      windowsHide: true,
    });

    if (typeof opts.onTmpDir === 'function') {
      try { opts.onTmpDir(tmpDir); } catch(_) {}
    }

    let stdoutBuf = '';   // 줄 단위 JSON 파싱 버퍼
    let answer = '';      // text_delta 누적
    let resultText = '';  // result 이벤트의 최종 텍스트 (권위)
    let usage = null, costUsd = null, isError = false, errMsg = '';
    let err = '';
    const timeout = opts.timeout || 180000;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch(_) {}
      if (typeof opts.harvestFiles === 'function') {
        try { opts.harvestFiles(tmpDir); } catch(_) {}
      }
      cleanup();
      reject(new Error('claude CLI timeout (' + timeout + 'ms)'));
    }, timeout);

    function handleEvent(obj) {
      if (!obj || typeof obj !== 'object') return;
      const t = obj.type;
      if (t === 'stream_event' && obj.event) {
        const ev = obj.event;
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            answer += ev.delta.text;
            try { if (typeof onChunk === 'function') onChunk(ev.delta.text); } catch(_) {}
          } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
            try { if (typeof opts.onThinking === 'function') opts.onThinking(ev.delta.thinking); } catch(_) {}
          }
        }
      } else if (t === 'result') {
        if (typeof obj.result === 'string') resultText = obj.result;
        if (obj.usage) usage = obj.usage;
        if (typeof obj.total_cost_usd === 'number') costUsd = obj.total_cost_usd;
        isError = !!obj.is_error;
        if (isError && typeof obj.result === 'string') errMsg = obj.result;
        try { if (typeof opts.onMeta === 'function') opts.onMeta({ usage, costUsd, isError }); } catch(_) {}
      }
    }

    child.stdout.on('data', d => {
      stdoutBuf += d.toString('utf8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        try { handleEvent(obj); } catch(_) {}
      }
    });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); cleanup(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      // 남은 버퍼 한 줄 처리
      if (stdoutBuf.trim()) { try { handleEvent(JSON.parse(stdoutBuf.trim())); } catch(_) {} }
      let harvested = [];
      if (typeof opts.harvestFiles === 'function') {
        try { harvested = opts.harvestFiles(tmpDir) || []; } catch(e) { console.warn('[claude-cli] harvest 실패:', e.message); }
      }
      cleanup();
      if (killed) return reject(new Error('aborted'));
      const finalText = (resultText || answer || '').trim();
      if (isError && !finalText) return reject(new Error(errMsg || (err || '').trim() || 'claude error'));
      if (code !== 0 && !finalText) return reject(new Error((err || '').trim() || 'claude exit ' + code));
      resolve({ text: finalText, durationMs: Date.now() - started, stderr: err.trim(), harvested, usage, costUsd });
    });

    child.stdin.write(fullPrompt, 'utf8');
    child.stdin.end();
  });

  promise.abort = () => {
    if (child && !killed) {
      killed = true;
      try { child.kill('SIGTERM'); } catch(_) {}
    }
  };

  return promise;
}

module.exports = {
  callClaudeCli,
  callClaudeCliStream,
  parseJsonFromResponse,
};
