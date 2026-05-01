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

module.exports = {
  callClaudeCli,
  parseJsonFromResponse,
};
