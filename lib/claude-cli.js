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
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';

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
    const timeout = opts.timeout || 180000; // 3분 기본 (이미지 분석은 시간 좀 걸림)
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch(_) {}
      cleanup();
      reject(new Error('claude CLI timeout (' + timeout + 'ms)'));
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
 * 스트리밍 버전 — stdout 청크가 들어올 때마다 onChunk 콜백 호출.
 * resolve 는 프로세스 완료 시 (전체 텍스트 + duration 함께).
 * 반환된 promise 에 .abort() 메서드 추가 — 사용자가 중단 누르면 호출.
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
    const addDirs = new Set([APP_ROOT]);
    for (const p of (attachmentPaths || [])) {
      if (p && fs.existsSync(p)) {
        fullPrompt += '@' + p + '\n';
        addDirs.add(path.dirname(p));
      }
    }
    fullPrompt += prompt;

    const args = ['-p', '--model', opts.model || DEFAULT_MODEL, '--permission-mode', 'bypassPermissions'];
    for (const dir of addDirs) args.push('--add-dir', dir);

    child = spawn('claude', args, {
      cwd: tmpDir, shell: true,
      env: Object.assign({}, process.env, { LANG: 'ko_KR.UTF-8', TZ: 'Asia/Seoul' }),
      windowsHide: true,
    });

    // CLI 가 만든 파일을 cleanup 전에 다른 곳으로 옮기기 위한 콜백
    // opts.onArtifactDirs 가 있으면 tmpDir 경로를 알려줌 (close 직전 호출)
    if (typeof opts.onTmpDir === 'function') {
      try { opts.onTmpDir(tmpDir); } catch(_) {}
    }

    let out = '', err = '';
    const timeout = opts.timeout || 180000;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch(_) {}
      // 타임아웃 시에도 결과 파일 보존
      if (typeof opts.harvestFiles === 'function') {
        try { opts.harvestFiles(tmpDir); } catch(_) {}
      }
      cleanup();
      reject(new Error('claude CLI timeout (' + timeout + 'ms)'));
    }, timeout);

    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      out += chunk;
      try { if (typeof onChunk === 'function') onChunk(chunk); } catch(_) {}
    });
    child.stderr.on('data', d => { err += d.toString('utf8'); });
    child.on('error', e => { clearTimeout(timer); cleanup(); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      // ★★ cleanup 하기 전에 tmpDir 안 파일들을 OUTPUT_DIR 로 옮길 기회 제공 ★★
      let harvested = [];
      if (typeof opts.harvestFiles === 'function') {
        try { harvested = opts.harvestFiles(tmpDir) || []; } catch(e) { console.warn('[claude-cli] harvest 실패:', e.message); }
      }
      cleanup();
      if (killed) return reject(new Error('aborted'));
      if (code !== 0) return reject(new Error((err || '').trim() || 'claude exit ' + code));
      resolve({ text: (out || '').trim(), durationMs: Date.now() - started, stderr: err.trim(), harvested });
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
