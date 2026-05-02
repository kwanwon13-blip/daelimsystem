#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const tls = require('tls');

const ROOT = path.resolve(__dirname, '..');
const IMAP_HOST = process.env.MAIL_IMAP_HOST || 'imap.naver.com';
const IMAP_PORT = Number(process.env.MAIL_IMAP_PORT || 993);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseArgs(argv) {
  const args = {
    dryRun: false,
    sync: false,
    deleteOld: false,
    watch: false,
    once: false,
    retentionDays: Number(process.env.MAIL_RETENTION_DAYS || 45),
    recentDays: Number(process.env.MAIL_RECENT_DAYS || 14),
    intervalMinutes: Number(process.env.MAIL_INTERVAL_MINUTES || 5),
    maxFetch: Number(process.env.MAIL_MAX_FETCH || 100),
    maxDelete: Number(process.env.MAIL_MAX_DELETE || 100),
    backupFolders: splitList(process.env.MAIL_BACKUP_FOLDERS || 'INBOX,Sent Messages'),
    cleanFolders: splitList(process.env.MAIL_CLEAN_FOLDERS || 'Sent Messages'),
    backupDir: process.env.MAIL_BACKUP_DIR || path.join(ROOT, 'data', 'mail-archive'),
    existingIdFiles: splitList(process.env.MAIL_EXISTING_ID_FILES || ''),
    scanExisting: process.env.MAIL_SCAN_EXISTING !== '0'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--sync') args.sync = true;
    else if (a === '--delete') args.deleteOld = true;
    else if (a === '--watch') args.watch = true;
    else if (a === '--once') args.once = true;
    else if (a === '--retention-days') args.retentionDays = Number(argv[++i]);
    else if (a === '--recent-days') args.recentDays = Number(argv[++i]);
    else if (a === '--interval-minutes') args.intervalMinutes = Number(argv[++i]);
    else if (a === '--max-fetch') args.maxFetch = Number(argv[++i]);
    else if (a === '--max-delete') args.maxDelete = Number(argv[++i]);
    else if (a === '--backup-folders') args.backupFolders = splitList(argv[++i]);
    else if (a === '--clean-folders') args.cleanFolders = splitList(argv[++i]);
    else if (a === '--backup-dir') args.backupDir = path.resolve(argv[++i]);
    else if (a === '--existing-id-file') args.existingIdFiles.push(path.resolve(argv[++i]));
    else if (a === '--no-scan-existing') args.scanExisting = false;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${a}`);
    }
  }

  if (!args.sync && !args.deleteOld) args.dryRun = true;
  if (args.deleteOld) args.sync = true;
  return args;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`Usage:
  node scripts/naver-mail-maintenance.js --dry-run
  node scripts/naver-mail-maintenance.js --sync
  node scripts/naver-mail-maintenance.js --sync --delete
  node scripts/naver-mail-maintenance.js --watch --sync

Options:
  --retention-days N      Old mail cutoff. Default: 45
  --recent-days N         Recent mail sync window. Default: 14
  --backup-folders CSV    Folders to back up. Default: INBOX,Sent Messages
  --clean-folders CSV     Folders eligible for deletion. Default: Sent Messages
  --max-fetch N           Maximum messages downloaded per run. Default: 100
  --max-delete N          Maximum messages deleted per run. Default: 100
  --interval-minutes N    Watch mode interval. Default: 5
  --backup-dir PATH       Archive directory. Default: data/mail-archive
  --existing-id-file PATH Treat Message-ID values in this text file as archived
  --no-scan-existing      Do not scan existing .eml files for duplicate Message-ID

Environment variables with the same MAIL_* names are also supported.`);
}

function loadSettings() {
  const candidates = [
    path.join(ROOT, 'data', 'settings.json'),
    path.join(ROOT, 'data', '\uC124\uC815.json')
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json.smtp && json.smtp.user && json.smtp.pass) {
      const users = Array.from(new Set([json.smtp.user, json.smtp.from].filter(Boolean)));
      return { file, smtp: json.smtp, users };
    }
  }

  throw new Error('SMTP settings were not found in data/settings.json or data/settings.json equivalent.');
}

function imapDate(date) {
  const d = new Date(date);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function quoteImap(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function decodeModifiedUtf7(value) {
  return String(value).replace(/&([^-]*)-/g, (match, body) => {
    if (!body) return '&';
    const normalized = body.replace(/,/g, '/');
    const padded = normalized + '==='.slice((normalized.length + 3) % 4);
    const bytes = Buffer.from(padded, 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode(bytes.readUInt16BE(i));
    }
    return out;
  });
}

function safeName(value) {
  const ascii = String(value || 'folder')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return ascii || Buffer.from(String(value)).toString('hex').slice(0, 80) || 'folder';
}

function parseListFolder(line) {
  const m = line.match(/"((?:[^"\\]|\\.)*)"\s*$/);
  if (!m) return null;
  return m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseSearchUids(lines) {
  const uids = [];
  for (const line of lines) {
    if (!line.startsWith('* SEARCH')) continue;
    const tail = line.replace(/^\* SEARCH\s*/i, '').trim();
    if (!tail) continue;
    for (const n of tail.split(/\s+/)) {
      const uid = Number(n);
      if (Number.isSafeInteger(uid) && uid > 0) uids.push(uid);
    }
  }
  return uids;
}

function extractLiteral(raw) {
  const headerText = raw.toString('utf8', 0, Math.min(raw.length, 8192));
  const sizeMatch = headerText.match(/\{(\d+)\}\r\n/i);
  if (!sizeMatch) return null;
  const marker = Buffer.from(sizeMatch[0]);
  const literalStart = raw.indexOf(marker) + marker.length;
  const size = Number(sizeMatch[1]);
  const literalEnd = literalStart + size;
  if (literalStart < marker.length || raw.length < literalEnd) return null;
  return raw.slice(literalStart, literalEnd);
}

function unfoldHeaders(text) {
  return String(text || '').replace(/\r?\n[ \t]+/g, ' ');
}

function getHeader(text, name) {
  const unfolded = unfoldHeaders(text);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = unfolded.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match ? match[1].trim() : '';
}

function normalizeMessageId(value) {
  return String(value || '')
    .trim()
    .replace(/^<|>$/g, '')
    .toLowerCase();
}

function messageIdFromBuffer(buffer) {
  if (!buffer) return '';
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  return normalizeMessageId(getHeader(text, 'Message-ID') || getHeader(text, 'Message-Id'));
}

function parseSelectInfo(lines) {
  const info = { exists: 0, uidValidity: 'unknown', readWrite: false, permanentFlags: '' };
  for (const line of lines) {
    const exists = line.match(/^\* (\d+) EXISTS/i);
    if (exists) info.exists = Number(exists[1]);
    const uidv = line.match(/\[UIDVALIDITY\s+([^\]]+)\]/i);
    if (uidv) info.uidValidity = uidv[1].trim();
    const perm = line.match(/\[PERMANENTFLAGS\s+\(([^\)]*)\)\]/i);
    if (perm) info.permanentFlags = perm[1];
    if (/\[READ-WRITE\]/i.test(line)) info.readWrite = true;
  }
  return info;
}

class ImapClient {
  constructor({ user, pass }) {
    this.user = user;
    this.pass = pass;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.tagNo = 1;
    this.queue = [];
    this.current = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = tls.connect(IMAP_PORT, IMAP_HOST, { servername: IMAP_HOST, rejectUnauthorized: true });
      this.socket.on('data', data => this.onData(data));
      this.socket.on('error', err => {
        if (this.current) this.current.reject(err);
        else reject(err);
      });
      this.socket.setTimeout(30000, () => {
        const err = new Error('IMAP timeout');
        if (this.current) this.current.reject(err);
        else reject(err);
      });
      this.waitGreeting().then(resolve, reject);
    });
  }

  waitGreeting() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const text = this.buffer.toString('utf8');
        if (/^\* OK/im.test(text)) {
          clearInterval(timer);
          this.buffer = Buffer.alloc(0);
          resolve();
        } else if (Date.now() - started > 30000) {
          clearInterval(timer);
          reject(new Error('IMAP greeting timeout'));
        }
      }, 25);
    });
  }

  async login() {
    const res = await this.command(`LOGIN ${quoteImap(this.user)} ${quoteImap(this.pass)}`);
    if (!res.ok) throw new Error(`IMAP login failed for ${this.user}: ${res.statusLine}`);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch (_) {
      // ignore
    }
    if (this.socket) this.socket.end();
  }

  command(command) {
    const tag = `A${String(this.tagNo++).padStart(4, '0')}`;
    return new Promise((resolve, reject) => {
      this.queue.push({ tag, command, resolve, reject });
      this.pump();
    });
  }

  pump() {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift();
    this.buffer = Buffer.alloc(0);
    this.socket.write(`${this.current.tag} ${this.current.command}\r\n`);
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    if (!this.current) return;

    const tagPattern = Buffer.from(`\r\n${this.current.tag} `);
    const atStartPattern = Buffer.from(`${this.current.tag} `);
    const atStart = this.buffer.indexOf(atStartPattern) === 0 ? 0 : -1;
    let endAt = this.buffer.indexOf(tagPattern);
    if (endAt >= 0) endAt += 2;
    else if (atStart === 0) endAt = 0;
    if (endAt < 0) return;

    const lineStart = endAt;
    const lineEnd = this.buffer.indexOf(Buffer.from('\r\n'), lineStart);
    if (lineEnd < 0) return;

    const response = this.buffer.slice(0, lineEnd + 2);
    const statusLine = this.buffer.slice(lineStart, lineEnd).toString('utf8');
    const current = this.current;
    this.current = null;
    const text = response.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    current.resolve({
      ok: new RegExp(`^${current.tag}\\s+OK`, 'i').test(statusLine),
      no: new RegExp(`^${current.tag}\\s+NO`, 'i').test(statusLine),
      bad: new RegExp(`^${current.tag}\\s+BAD`, 'i').test(statusLine),
      statusLine,
      lines,
      raw: response
    });
    this.pump();
  }

  async listFolders() {
    const res = await this.command('LIST "" "*"');
    if (!res.ok) throw new Error(`LIST failed: ${res.statusLine}`);
    return res.lines
      .filter(line => /^\* LIST /i.test(line))
      .map(line => {
        const raw = parseListFolder(line);
        return raw ? { raw, decoded: decodeModifiedUtf7(raw), line } : null;
      })
      .filter(Boolean);
  }

  async select(folder) {
    const res = await this.command(`SELECT ${quoteImap(folder)}`);
    if (!res.ok) throw new Error(`SELECT ${folder} failed: ${res.statusLine}`);
    return parseSelectInfo(res.lines);
  }

  async search(query) {
    const res = await this.command(`UID SEARCH ${query}`);
    if (!res.ok) throw new Error(`SEARCH ${query} failed: ${res.statusLine}`);
    return parseSearchUids(res.lines);
  }

  async fetchMessage(uid) {
    const res = await this.command(`UID FETCH ${uid} (RFC822)`);
    if (!res.ok) throw new Error(`FETCH ${uid} failed: ${res.statusLine}`);
    const literal = extractLiteral(res.raw);
    if (!literal) throw new Error(`FETCH ${uid} did not return RFC822 literal`);
    return literal;
  }

  async fetchHeaders(uid) {
    const res = await this.command(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID DATE SUBJECT FROM TO)])`);
    if (!res.ok) throw new Error(`FETCH headers ${uid} failed: ${res.statusLine}`);
    const literal = extractLiteral(res.raw);
    return literal ? literal.toString('utf8') : '';
  }

  async deleteUid(uid) {
    const res = await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    if (!res.ok) throw new Error(`DELETE flag failed for UID ${uid}: ${res.statusLine}`);
  }

  async expunge() {
    const res = await this.command('EXPUNGE');
    if (!res.ok) throw new Error(`EXPUNGE failed: ${res.statusLine}`);
  }
}

function backupPath(args, account, folder, uidValidity, uid) {
  return path.join(
    args.backupDir,
    safeName(account),
    safeName(decodeModifiedUtf7(folder)),
    `uidvalidity-${safeName(uidValidity)}`,
    `uid-${uid}.eml`
  );
}

function hasBackup(args, account, folder, uidValidity, uid) {
  const file = backupPath(args, account, folder, uidValidity, uid);
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

function writeBackup(args, account, folder, uidValidity, uid, message) {
  const file = backupPath(args, account, folder, uidValidity, uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, message);
  fs.renameSync(temp, file);
  return file;
}

function loadExistingIndex(args) {
  const index = { messageIds: new Set(), files: 0, root: args.backupDir };
  for (const idFile of args.existingIdFiles) {
    try {
      const text = fs.readFileSync(idFile, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const id = normalizeMessageId(line);
        if (id) index.messageIds.add(id);
      }
    } catch (err) {
      console.warn(`Could not read existing id file ${idFile}: ${err.message}`);
    }
  }

  if (!args.scanExisting || !fs.existsSync(args.backupDir)) return index;

  const stack = [args.backupDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.eml')) continue;
      index.files += 1;
      try {
        const fd = fs.openSync(full, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        fs.closeSync(fd);
        const messageId = messageIdFromBuffer(buffer.slice(0, bytes));
        if (messageId) index.messageIds.add(messageId);
      } catch (_) {
        // ignore unreadable backups
      }
    }
  }

  return index;
}

async function classifyBackups(client, args, account, folder, uidValidity, uids, existingIndex) {
  const backed = [];
  const missing = [];
  const existingElsewhere = [];
  const headerCache = new Map();
  const canCheckMessageId = existingIndex && existingIndex.messageIds.size > 0;

  for (const uid of uids) {
    if (hasBackup(args, account, folder, uidValidity, uid)) {
      backed.push(uid);
      continue;
    }

    let messageId = '';
    if (canCheckMessageId) {
      if (!headerCache.has(uid)) {
        const headers = await client.fetchHeaders(uid);
        headerCache.set(uid, messageIdFromBuffer(headers));
      }
      messageId = headerCache.get(uid);
    }

    if (messageId && existingIndex.messageIds.has(messageId)) {
      backed.push(uid);
      existingElsewhere.push(uid);
    } else {
      missing.push(uid);
    }
  }

  return { backed, missing, existingElsewhere };
}

function resolveFolders(available, requested) {
  const byRaw = new Map();
  const byDecoded = new Map();
  for (const f of available) {
    byRaw.set(f.raw.toLowerCase(), f.raw);
    byDecoded.set(f.decoded.toLowerCase(), f.raw);
  }
  return requested.map(name => byRaw.get(name.toLowerCase()) || byDecoded.get(name.toLowerCase()) || name);
}

function folderLabel(folder) {
  const decoded = decodeModifiedUtf7(folder);
  return decoded === folder ? folder : `${decoded} (${folder})`;
}

async function processFolder(client, args, account, folder, cleanSet, counters, existingIndex) {
  const selected = await client.select(folder);
  const recentCutoff = imapDate(daysAgo(args.recentDays));
  const oldCutoff = imapDate(daysAgo(args.retentionDays));
  const isCleanFolder = cleanSet.has(folder.toLowerCase()) || cleanSet.has(decodeModifiedUtf7(folder).toLowerCase());

  const recentUids = await client.search(`SINCE ${recentCutoff}`);
  const recentState = await classifyBackups(client, args, account, folder, selected.uidValidity, recentUids, existingIndex);

  let oldUids = [];
  let oldState = { backed: [], missing: [], existingElsewhere: [] };
  if (isCleanFolder) {
    oldUids = await client.search(`BEFORE ${oldCutoff}`);
    oldState = await classifyBackups(client, args, account, folder, selected.uidValidity, oldUids, existingIndex);
  }

  console.log(`[${folderLabel(folder)}] total=${selected.exists} recent=${recentUids.length} recentMissing=${recentState.missing.length} recentExisting=${recentState.existingElsewhere.length} old=${oldUids.length} oldBacked=${oldState.backed.length} oldMissing=${oldState.missing.length} oldExisting=${oldState.existingElsewhere.length}`);

  if (args.dryRun) {
    counters.oldCandidates += oldUids.length;
    counters.missingBackups += recentState.missing.length + oldState.missing.length;
    return;
  }

  const toBackUp = Array.from(new Set([...recentState.missing, ...oldState.missing]));
  for (const uid of toBackUp) {
    if (counters.fetched >= args.maxFetch) break;
    const message = await client.fetchMessage(uid);
    const messageId = messageIdFromBuffer(message);
    if (messageId && existingIndex.messageIds.has(messageId)) {
      counters.skippedExisting += 1;
      console.log(`  skipped existing UID ${uid} (Message-ID already archived)`);
      continue;
    }
    const file = writeBackup(args, account, folder, selected.uidValidity, uid, message);
    if (messageId) existingIndex.messageIds.add(messageId);
    counters.fetched += 1;
    console.log(`  backed up UID ${uid} -> ${path.relative(ROOT, file)}`);
  }

  if (!args.deleteOld || !isCleanFolder) return;
  if (!selected.readWrite || !selected.permanentFlags.includes('\\Deleted')) {
    console.log(`  skip delete: folder is not writable or does not allow Deleted flag`);
    return;
  }

  const deletable = oldUids.filter(uid => hasBackup(args, account, folder, selected.uidValidity, uid) || oldState.backed.includes(uid));
  let deletedInFolder = 0;
  for (const uid of deletable) {
    if (counters.deleted >= args.maxDelete) break;
    await client.deleteUid(uid);
    counters.deleted += 1;
    deletedInFolder += 1;
    console.log(`  marked deleted UID ${uid}`);
  }

  if (deletedInFolder > 0) {
    await client.expunge();
    console.log(`  expunged ${deletedInFolder} deleted message(s)`);
  }
}

async function runOnce(args) {
  const settings = loadSettings();
  let lastError = null;

  for (const user of settings.users) {
    const client = new ImapClient({ user, pass: settings.smtp.pass });
    try {
      await client.connect();
      await client.login();
      console.log(`Connected to ${IMAP_HOST}:${IMAP_PORT} as ${user}`);
      const folders = await client.listFolders();
      const backupFolders = resolveFolders(folders, args.backupFolders);
      const cleanFolders = resolveFolders(folders, args.cleanFolders);
      const cleanSet = new Set(cleanFolders.map(f => f.toLowerCase()));
      const existingIndex = loadExistingIndex(args);
      const counters = { fetched: 0, deleted: 0, oldCandidates: 0, missingBackups: 0, skippedExisting: 0 };

      console.log(`Mode: ${args.dryRun ? 'dry-run' : args.deleteOld ? 'sync+delete' : 'sync'}`);
      console.log(`Backup folders: ${backupFolders.map(folderLabel).join(', ')}`);
      console.log(`Cleanup folders: ${cleanFolders.map(folderLabel).join(', ')}`);
      console.log(`Retention: ${args.retentionDays} day(s), recent sync window: ${args.recentDays} day(s)`);
      console.log(`Archive: ${args.backupDir}`);
      if (args.scanExisting) console.log(`Existing archive scan: ${existingIndex.files} .eml file(s), ${existingIndex.messageIds.size} Message-ID(s)`);

      for (const folder of backupFolders) {
        await processFolder(client, args, user, folder, cleanSet, counters, existingIndex);
      }

      console.log(`Summary: fetched=${counters.fetched} skippedExisting=${counters.skippedExisting} deleted=${counters.deleted} dryRunOldCandidates=${counters.oldCandidates} dryRunMissingBackups=${counters.missingBackups}`);
      await client.logout();
      return;
    } catch (err) {
      lastError = err;
      try {
        await client.logout();
      } catch (_) {
        // ignore
      }
    }
  }

  throw lastError || new Error('No IMAP account candidates were available.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.watch) {
    for (;;) {
      try {
        await runOnce(args);
      } catch (err) {
        console.error(`[mail-maintenance] ${err.stack || err.message}`);
      }
      if (args.once) break;
      const ms = Math.max(1, args.intervalMinutes) * 60 * 1000;
      console.log(`Waiting ${args.intervalMinutes} minute(s)...`);
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  } else {
    await runOnce(args);
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
