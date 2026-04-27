#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const JSZip = require('jszip');
const path = require('path');
const sharp = require('sharp');

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
  '.heic',
  '.heif',
]);
const ZIP_EXTS = new Set(['.zip']);

const DEFAULT_INBOX =
  process.platform === 'win32'
    ? 'C:\\CompanyAssets\\KakaoInbox'
    : path.join(process.cwd(), 'kakao-inbox');
const DEFAULT_LIBRARY =
  process.platform === 'win32'
    ? 'C:\\CompanyAssets\\KakaoLibrary'
    : path.join(process.cwd(), 'kakao-library');

function parseArgs(argv) {
  const args = {
    inbox: DEFAULT_INBOX,
    library: DEFAULT_LIBRARY,
    watch: false,
    dryRun: false,
    stableMs: 5000,
    intervalMs: 10000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--watch') args.watch = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--inbox') args.inbox = path.resolve(argv[++i]);
    else if (arg === '--library') args.library = path.resolve(argv[++i]);
    else if (arg === '--stable-ms') args.stableMs = Number(argv[++i]);
    else if (arg === '--interval-ms') args.intervalMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Kakao image asset watcher

Usage:
  node scripts\\kakao-asset-watcher.js [options]

Options:
  --watch                  Keep scanning the inbox folder
  --inbox <path>           Folder where Kakao images are saved
  --library <path>         Asset library output folder
  --stable-ms <number>     File-size stable wait time, default 5000
  --interval-ms <number>   Watch scan interval, default 10000
  --dry-run                Print work without copying or writing
  --help                   Show this help

Defaults on Windows:
  inbox:   C:\\CompanyAssets\\KakaoInbox
  library: C:\\CompanyAssets\\KakaoLibrary
`);
}

function ensureDir(dir, dryRun) {
  if (dryRun) return;
  fs.mkdirSync(dir, { recursive: true });
}

function loadIndex(indexPath) {
  if (!fs.existsSync(indexPath)) {
    return {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      assets: [],
    };
  }

  const raw = fs.readFileSync(indexPath, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.assets = Array.isArray(parsed.assets) ? parsed.assets : [];
  return parsed;
}

function saveIndex(indexPath, index, dryRun) {
  index.updatedAt = new Date().toISOString();
  if (dryRun) return;

  const tmpPath = `${indexPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, indexPath);
}

function csvValue(value) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function appendLog(library, event, details, dryRun) {
  if (dryRun) return;

  const logPath = path.join(library, 'import-log.csv');
  const exists = fs.existsSync(logPath);
  const row = [
    new Date().toISOString(),
    event,
    details.path || '',
    details.hash || '',
    details.size || '',
    details.note || '',
  ]
    .map(csvValue)
    .join(',');

  if (!exists) {
    fs.writeFileSync(logPath, 'time,event,path,hash,size,note\r\n', 'utf8');
  }
  fs.appendFileSync(logPath, `${row}\r\n`, 'utf8');
}

function walkInputs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isSupportedInput(entry.name)) {
        out.push(fullPath);
      }
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function isSupportedInput(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTS.has(ext) || ZIP_EXTS.has(ext);
}

function isSupportedImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStableFile(filePath, stableMs) {
  const first = await safeStat(filePath);
  if (!first) return null;

  await sleep(stableMs);

  const second = await safeStat(filePath);
  if (!second) return null;

  if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
    await sleep(stableMs);
    const third = await safeStat(filePath);
    if (!third) return null;
    if (second.size !== third.size || second.mtimeMs !== third.mtimeMs) return null;
    return third;
  }

  return second;
}

async function safeStat(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch {
    return null;
  }
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'image';
}

function parseExifDate(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) return null;
  const start = buffer.slice(0, 6).toString('ascii') === 'Exif\0\0' ? 6 : 0;
  if (buffer.length < start + 8) return null;

  const endianMark = buffer.slice(start, start + 2).toString('ascii');
  const little = endianMark === 'II';
  if (!little && endianMark !== 'MM') return null;

  const readUInt16 = (offset) => (little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  const readUInt32 = (offset) => (little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));

  const magic = readUInt16(start + 2);
  if (magic !== 42) return null;

  const readAsciiTag = (ifdOffset, tagId) => {
    if (!ifdOffset || ifdOffset < 0 || start + ifdOffset + 2 > buffer.length) return null;
    const entries = readUInt16(start + ifdOffset);
    for (let i = 0; i < entries; i += 1) {
      const entryOffset = start + ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > buffer.length) return null;
      const tag = readUInt16(entryOffset);
      const type = readUInt16(entryOffset + 2);
      const count = readUInt32(entryOffset + 4);
      const valueOrOffset = readUInt32(entryOffset + 8);
      if (tag !== tagId || type !== 2 || count <= 0) continue;

      const valueOffset = count <= 4 ? entryOffset + 8 : start + valueOrOffset;
      if (valueOffset < 0 || valueOffset + count > buffer.length) return null;
      return buffer
        .slice(valueOffset, valueOffset + count)
        .toString('ascii')
        .replace(/\0/g, '')
        .trim();
    }
    return null;
  };

  const readPointerTag = (ifdOffset, tagId) => {
    if (!ifdOffset || start + ifdOffset + 2 > buffer.length) return null;
    const entries = readUInt16(start + ifdOffset);
    for (let i = 0; i < entries; i += 1) {
      const entryOffset = start + ifdOffset + 2 + i * 12;
      if (entryOffset + 12 > buffer.length) return null;
      if (readUInt16(entryOffset) === tagId) return readUInt32(entryOffset + 8);
    }
    return null;
  };

  const ifd0 = readUInt32(start + 4);
  const exifIfd = readPointerTag(ifd0, 0x8769);
  const date =
    readAsciiTag(exifIfd, 0x9003) ||
    readAsciiTag(exifIfd, 0x9004) ||
    readAsciiTag(ifd0, 0x0132);

  if (!date) return null;
  const match = date.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;

  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

function pickAssetDate(metadata, stat) {
  const exifDate = parseExifDate(metadata.exif);
  if (exifDate) return { date: exifDate, source: 'exif' };

  return {
    date: stat.mtime.toISOString().slice(0, 19),
    source: 'file-mtime',
  };
}

function makeStatLike(size, date) {
  const mtime = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return {
    size,
    mtime,
    mtimeMs: mtime.getTime(),
  };
}

function dateParts(dateText) {
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return ['unknown-year', 'unknown-month', 'unknown-day'];
  return [match[1], match[2], match[3]];
}

async function importImageFile(filePath, context) {
  const { index, byHash, dryRun, library, stableMs } = context;
  const stat = await waitForStableFile(filePath, stableMs);
  if (!stat) {
    appendLog(library, 'skip_unstable', { path: filePath, note: 'file changed while scanning' }, dryRun);
    return { imported: 0, duplicate: 0, skipped: 1, failed: 0 };
  }

  const bytes = await fs.promises.readFile(filePath);
  return importImageBytes({
    bytes,
    originalName: path.basename(filePath),
    sourcePath: filePath,
    stat,
    context,
  });
}

async function importZipFile(zipPath, context) {
  const { dryRun, library, stableMs } = context;
  const stat = await waitForStableFile(zipPath, stableMs);
  if (!stat) {
    appendLog(library, 'skip_unstable', { path: zipPath, note: 'zip changed while scanning' }, dryRun);
    return { imported: 0, duplicate: 0, skipped: 1, failed: 0 };
  }

  let zip;
  try {
    const bytes = await fs.promises.readFile(zipPath);
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    appendLog(library, 'fail_zip_open', { path: zipPath, size: stat.size, note: error.message }, dryRun);
    return { imported: 0, duplicate: 0, skipped: 0, failed: 1 };
  }

  const counts = { imported: 0, duplicate: 0, skipped: 0, failed: 0 };
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && isSupportedImage(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!entries.length) {
    appendLog(library, 'skip_zip_empty', { path: zipPath, size: stat.size, note: 'no supported images in zip' }, dryRun);
    return { imported: 0, duplicate: 0, skipped: 1, failed: 0 };
  }

  for (const entry of entries) {
    try {
      const bytes = await entry.async('nodebuffer');
      const entryStat = makeStatLike(bytes.length, entry.date || stat.mtime);
      const result = await importImageBytes({
        bytes,
        originalName: path.basename(entry.name),
        sourcePath: `${zipPath}#${entry.name}`,
        stat: entryStat,
        context,
      });
      addCounts(counts, result);
    } catch (error) {
      counts.failed += 1;
      appendLog(library, 'fail_zip_entry', { path: `${zipPath}#${entry.name}`, note: error.message }, dryRun);
    }
  }

  return counts;
}

async function importImageBytes({ bytes, originalName, sourcePath, stat, context }) {
  const { index, byHash, dryRun, library } = context;
  const hash = hashBytes(bytes);
  if (byHash.has(hash)) {
    const asset = byHash.get(hash);
    asset.duplicateCount = (asset.duplicateCount || 0) + 1;
    asset.lastDuplicatePath = sourcePath;
    appendLog(library, 'duplicate', { path: sourcePath, hash, size: stat.size }, dryRun);
    return { imported: 0, duplicate: 1, skipped: 0, failed: 0 };
  }

  let metadata;
  try {
    metadata = await sharp(bytes, { animated: false }).metadata();
  } catch (error) {
    appendLog(library, 'fail_metadata', { path: sourcePath, hash, size: stat.size, note: error.message }, dryRun);
    return { imported: 0, duplicate: 0, skipped: 0, failed: 1 };
  }

  const assetDate = pickAssetDate(metadata, stat);
  const [yyyy, mm, dd] = dateParts(assetDate.date);
  const cleanOriginalName = sanitizeFileName(path.basename(originalName));
  const ext = path.extname(cleanOriginalName) || `.${metadata.format || 'jpg'}`;
  const baseName = sanitizeFileName(path.basename(cleanOriginalName, ext));
  const shortHash = hash.slice(0, 12);
  const originalRel = path.join('originals', yyyy, mm, dd, `${shortHash}_${baseName}${ext}`);
  const thumbRel = path.join('thumbs', yyyy, mm, dd, `${shortHash}.jpg`);
  const originalAbs = path.join(library, originalRel);
  const thumbAbs = path.join(library, thumbRel);

  if (!dryRun) {
    ensureDir(path.dirname(originalAbs), false);
    ensureDir(path.dirname(thumbAbs), false);
    fs.writeFileSync(originalAbs, bytes);
    await sharp(bytes, { animated: false })
      .rotate()
      .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toFile(thumbAbs);
  }

  const asset = {
    id: hash,
    hash,
    shortHash,
    originalName,
    sourcePath,
    originalPath: originalRel,
    thumbnailPath: thumbRel,
    size: stat.size,
    width: metadata.width || null,
    height: metadata.height || null,
    format: metadata.format || null,
    date: assetDate.date,
    dateSource: assetDate.source,
    importedAt: new Date().toISOString(),
    duplicateCount: 0,
    tags: [],
    note: '',
  };

  index.assets.push(asset);
  byHash.set(hash, asset);
  appendLog(library, 'import', { path: sourcePath, hash, size: stat.size }, dryRun);
  return { imported: 1, duplicate: 0, skipped: 0, failed: 0 };
}

async function importInput(filePath, context) {
  const ext = path.extname(filePath).toLowerCase();
  if (ZIP_EXTS.has(ext)) return importZipFile(filePath, context);
  return importImageFile(filePath, context);
}

function addCounts(total, next) {
  total.imported += next.imported;
  total.duplicate += next.duplicate;
  total.skipped += next.skipped;
  total.failed += next.failed;
}

async function scanOnce(args) {
  ensureDir(args.inbox, args.dryRun);
  ensureDir(args.library, args.dryRun);

  const indexPath = path.join(args.library, 'asset-index.json');
  const index = loadIndex(indexPath);
  const byHash = new Map(index.assets.map((asset) => [asset.hash, asset]));
  const files = walkInputs(args.inbox);
  const counts = { imported: 0, duplicate: 0, skipped: 0, failed: 0 };

  for (const filePath of files) {
    try {
      const result = await importInput(filePath, {
        index,
        byHash,
        dryRun: args.dryRun,
        library: args.library,
        stableMs: args.stableMs,
      });
      addCounts(counts, result);
    } catch (error) {
      counts.failed += 1;
      appendLog(args.library, 'fail_unhandled', { path: filePath, note: error.stack || error.message }, args.dryRun);
    }
  }

  saveIndex(indexPath, index, args.dryRun);
  return { ...counts, seen: files.length, totalAssets: index.assets.length };
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Inbox:   ${args.inbox}`);
  console.log(`Library: ${args.library}`);
  console.log(`Mode:    ${args.watch ? 'watch' : 'scan once'}${args.dryRun ? ' (dry-run)' : ''}`);

  do {
    const started = Date.now();
    const result = await scanOnce(args);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(
      `[${new Date().toLocaleString()}] seen=${result.seen} imported=${result.imported} duplicate=${result.duplicate} skipped=${result.skipped} failed=${result.failed} total=${result.totalAssets} ${seconds}s`
    );

    if (!args.watch) break;
    await sleep(args.intervalMs);
  } while (true);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
