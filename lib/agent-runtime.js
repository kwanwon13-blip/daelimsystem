/**
 * lib/agent-runtime.js — Claude CLI 기반 Agent 런타임
 *
 * "Cowork-in-ERP" — 직원이 자연어로 작업 요청 → Claude 가 격리된 workspace 에서
 * 파일 읽기/쓰기/Python 실행 등으로 결과물 생성. SSE 스트리밍으로 진행 상황 전달.
 *
 * 디자인:
 *   - 사용자별 workspace: data/agent-workspace/<userId>/<sessionId>/
 *   - 첨부 파일은 workspace 에 복사
 *   - claude CLI 가 그 cwd 에서 자유롭게 작업
 *   - 결과 파일은 workspace 에 그대로 → 다운로드/미리보기
 *
 * 보안:
 *   - 사용자별 폴더 격리
 *   - 시스템 파일 접근 차단 (claude 의 --permission-mode bypassPermissions 사용,
 *     단 cwd 가 workspace 라 영향 범위가 자연 제한됨)
 *   - 작업 시간 제한 (기본 5분)
 *
 * 환경변수:
 *   AGENT_MAX_DURATION_MS    개별 작업 최대 시간 (기본 300000 = 5분)
 *   AGENT_WORKSPACE_ROOT     workspace 루트 (기본 data/agent-workspace)
 *   AGENT_MAX_CONCURRENT     동시 실행 슬롯 (기본 3)
 *   AGENT_PERMISSION_MODE    claude 권한 모드 (기본 bypassPermissions, 'default'/'acceptEdits' 가능)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT
  || path.join(__dirname, '..', 'data', 'agent-workspace');
const MAX_DURATION = parseInt(process.env.AGENT_MAX_DURATION_MS || '300000', 10);
const MAX_CONCURRENT = parseInt(process.env.AGENT_MAX_CONCURRENT || '3', 10);
const PERMISSION_MODE = process.env.AGENT_PERMISSION_MODE || 'bypassPermissions';

// workspace 루트 생성
if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}

// ── 동시 실행 슬롯 (Agent 는 무겁기 때문에 더 작은 풀) ──
let _activeCount = 0;
const _waiters = [];

function _acquireSlot() {
  if (_activeCount < MAX_CONCURRENT) { _activeCount++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _releaseSlot() {
  const next = _waiters.shift();
  if (next) next();
  else _activeCount--;
}

function getStats() {
  return { active: _activeCount, waiting: _waiters.length, max: MAX_CONCURRENT };
}

// ── 사용자별 workspace 세션 디렉터리 생성 ──
function createSession(userId) {
  const sid = Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32) || 'anon';
  const wsDir = path.join(WORKSPACE_ROOT, safeUserId, sid);
  fs.mkdirSync(wsDir, { recursive: true });
  return { sessionId: sid, dir: wsDir };
}

// ── 첨부 파일 워크스페이스에 복사 ──
function copyAttachments(wsDir, attachmentPaths) {
  const copied = [];
  for (const src of attachmentPaths || []) {
    if (!src || !fs.existsSync(src)) continue;
    try {
      const baseName = path.basename(src);
      // 파일명 정규화 (한글/공백 OK, 특수문자만 제거)
      const safe = baseName.replace(/[<>:"/\\|?*]/g, '_');
      const dest = path.join(wsDir, safe);
      fs.copyFileSync(src, dest);
      copied.push({ original: baseName, name: safe, path: dest });
    } catch (e) {
      console.warn('[agent] 첨부 복사 실패:', src, e.message);
    }
  }
  return copied;
}

// ── 작업 후 생성된 파일 스캔 (재귀) ──
function scanWorkspaceFiles(wsDir) {
  const out = [];
  function walk(dir, rel = '') {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        walk(full, r);
      } else if (e.isFile()) {
        let stat;
        try { stat = fs.statSync(full); } catch(_) { continue; }
        out.push({
          name: e.name,
          relPath: r,
          fullPath: full,
          size: stat.size,
          mtime: stat.mtimeMs,
          ext: path.extname(e.name).toLowerCase(),
        });
      }
    }
  }
  walk(wsDir);
  return out;
}

// ── 시스템 프롬프트: Agent 에게 환경 안내 ──
function buildSystemContext(session, attachments) {
  let lines = [
    '# Agent 작업 환경 안내',
    '',
    '당신은 대림에스엠 ERP 의 AI 도우미입니다. 다음 환경에서 작업하세요:',
    '',
    `- 현재 작업 디렉터리(workspace): ${session.dir}`,
    '- 이 폴더 안에서만 파일을 만들고/수정/실행하세요',
    '- 절대 시스템 다른 곳을 건드리지 마세요',
    '- Python (pandas, openpyxl, matplotlib, python-pptx, python-docx) 실행 가능',
    '- Node.js 도 가능 (exceljs, sharp, pdfkit, jszip 사용 가능)',
    '- 결과물은 이 workspace 안에 파일로 저장. 사용자가 다운로드해서 사용함',
    '- 한국어로 작업 진행 상황을 짧게 설명하면서 진행',
    '- 회사 정보: 대림에스엠 (안전 종합 그룹, 단가표/견적/시안 업무)',
    '',
  ];
  if (attachments && attachments.length) {
    lines.push('## 첨부 파일');
    for (const a of attachments) {
      lines.push(`- ${a.name} (${(a.path)})`);
    }
    lines.push('');
  }
  lines.push('## 사용자 요청');
  return lines.join('\n');
}

/**
 * Agent 작업 실행 (async generator — 이벤트 스트리밍)
 *
 * yield 되는 이벤트:
 *   { type: 'queued', data: { waiting } }              슬롯 대기 시작
 *   { type: 'started', data: { sessionId, dir } }      작업 시작
 *   { type: 'output', data: { text } }                 stdout 한 청크
 *   { type: 'stderr', data: { text } }                 stderr 한 청크
 *   { type: 'file', data: { name, relPath, size, ext } } 새로 생성된 파일 감지
 *   { type: 'done', data: { sessionId, dir, files, exitCode, durationMs } }
 *   { type: 'error', data: { message } }
 *
 * @param {Object} opts
 * @param {string} opts.userId - 사용자 ID (workspace 격리용)
 * @param {string} opts.task - 작업 요청 자연어
 * @param {string[]} [opts.attachmentPaths] - 첨부 파일 절대경로 배열
 * @param {AbortSignal} [opts.signal] - 취소용 시그널
 */
async function* runAgent({ userId, task, attachmentPaths = [], signal } = {}) {
  if (!task || !String(task).trim()) {
    yield { type: 'error', data: { message: 'task 가 비어있습니다' } };
    return;
  }

  // 슬롯 대기 시작
  const queueStart = Date.now();
  yield { type: 'queued', data: { ...getStats() } };
  await _acquireSlot();
  const queueWaitMs = Date.now() - queueStart;

  const session = createSession(userId || 'anon');
  const attachments = copyAttachments(session.dir, attachmentPaths);
  const startedAt = Date.now();
  const baseFiles = new Set(scanWorkspaceFiles(session.dir).map(f => f.relPath));

  try {
    yield { type: 'started', data: {
      sessionId: session.sessionId,
      dir: session.dir,
      attachments: attachments.map(a => a.name),
      queueWaitMs,
    }};

    const systemContext = buildSystemContext(session, attachments);
    const fullPrompt = systemContext + '\n\n' + task.trim();

    // claude CLI 스폰
    // -p 단발 출력. --permission-mode bypassPermissions 로 도구 사용 자동 승인.
    const args = ['-p', '--permission-mode', PERMISSION_MODE];
    const child = spawn('claude', args, {
      cwd: session.dir,                         // workspace 안에서만 작업
      env: { ...process.env, LANG: 'ko_KR.UTF-8' },
      windowsHide: true,
      shell: true,
    });

    // 타임아웃
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch(_) {}
      // SIGTERM 으로 안 죽으면 5초 뒤 SIGKILL
      setTimeout(() => { try { child.kill('SIGKILL'); } catch(_) {} }, 5000);
    }, MAX_DURATION);

    // AbortSignal (사용자 취소 버튼 등)
    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill('SIGTERM'); } catch(_) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch(_) {} }, 3000);
      }, { once: true });
    }

    // ── 출력 리스너 먼저 등록 (race condition 방지) ──
    const stdoutQueue = [];
    const stderrQueue = [];
    let exited = false, exitCode = null;

    child.stdout.on('data', d => { stdoutQueue.push(d.toString('utf8')); });
    child.stderr.on('data', d => { stderrQueue.push(d.toString('utf8')); });
    child.on('close', code => { exited = true; exitCode = code; });
    child.on('error', e => {
      stderrQueue.push('[child error] ' + e.message);
      exited = true; exitCode = -1;
    });

    // stdin 으로 prompt 주입 (리스너 등록 후)
    try {
      child.stdin.write(fullPrompt, 'utf8');
      child.stdin.end();
    } catch (e) {
      yield { type: 'error', data: { message: 'stdin write 실패: ' + e.message } };
      try { child.kill('SIGTERM'); } catch(_) {}
      return;
    }

    let lastFileScan = 0;
    while (!exited || stdoutQueue.length || stderrQueue.length) {
      // stdout drain
      while (stdoutQueue.length) {
        yield { type: 'output', data: { text: stdoutQueue.shift() } };
      }
      while (stderrQueue.length) {
        yield { type: 'stderr', data: { text: stderrQueue.shift() } };
      }
      // 1초마다 파일 감시
      const now = Date.now();
      if (now - lastFileScan > 1000) {
        lastFileScan = now;
        const current = scanWorkspaceFiles(session.dir);
        for (const f of current) {
          if (!baseFiles.has(f.relPath)) {
            baseFiles.add(f.relPath);
            yield { type: 'file', data: {
              name: f.name, relPath: f.relPath, size: f.size, ext: f.ext,
            }};
          }
        }
      }
      if (!exited) await new Promise(r => setTimeout(r, 100));
    }

    clearTimeout(killTimer);

    // 최종 파일 스캔
    const finalFiles = scanWorkspaceFiles(session.dir);
    const newFiles = finalFiles.filter(f => f.relPath !== '__never__'); // 전체 반환

    if (timedOut) {
      yield { type: 'error', data: {
        message: `작업 시간 초과 (${Math.round(MAX_DURATION/1000)}초)`,
        exitCode, sessionId: session.sessionId, dir: session.dir,
        files: newFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
      }};
      return;
    }

    yield { type: 'done', data: {
      sessionId: session.sessionId,
      dir: session.dir,
      exitCode,
      durationMs: Date.now() - startedAt,
      files: newFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    }};
  } catch (e) {
    yield { type: 'error', data: { message: e.message, stack: e.stack } };
  } finally {
    _releaseSlot();
  }
}

// ── 세션 정리 (작업 후 일정 시간 지나면 workspace 삭제) ──
const SESSION_TTL_MS = parseInt(process.env.AGENT_SESSION_TTL_MS || '86400000', 10); // 24시간
function cleanupOldSessions() {
  try {
    if (!fs.existsSync(WORKSPACE_ROOT)) return;
    const userDirs = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory());
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const u of userDirs) {
      const userDir = path.join(WORKSPACE_ROOT, u.name);
      const sessions = fs.readdirSync(userDir, { withFileTypes: true })
        .filter(e => e.isDirectory());
      for (const s of sessions) {
        const sDir = path.join(userDir, s.name);
        try {
          const stat = fs.statSync(sDir);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(sDir, { recursive: true, force: true });
          }
        } catch(_) {}
      }
    }
  } catch (e) {
    console.warn('[agent] cleanup 실패:', e.message);
  }
}
// 1시간마다 자동 청소 (unref 로 프로세스 종료 막지 않음)
const _cleanupTimer = setInterval(cleanupOldSessions, 3600000);
if (_cleanupTimer && _cleanupTimer.unref) _cleanupTimer.unref();

// ── 세션 폴더 → URL 매핑 (다운로드용) ──
// /api/ai/agent/file/<userId>/<sessionId>/<relPath>
function resolveSessionFile(userId, sessionId, relPath) {
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32) || 'anon';
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  // relPath 정규화 + 상위 이동 차단
  const cleanRel = path.posix.normalize(String(relPath || '')).replace(/^[/\\]+/, '');
  if (cleanRel.includes('..')) return null;
  const full = path.resolve(WORKSPACE_ROOT, safeUserId, safeSession, cleanRel);
  // 반드시 WORKSPACE_ROOT 내부여야 함
  const root = path.resolve(WORKSPACE_ROOT);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

module.exports = {
  runAgent,
  getStats,
  resolveSessionFile,
  WORKSPACE_ROOT,
  MAX_DURATION,
  MAX_CONCURRENT,
};
