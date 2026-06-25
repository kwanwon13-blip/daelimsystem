'use strict';
/**
 * lib/design-captions-db.js — 시안(★폴더) 이미지 "내용 캡션" 저장소 (전용 SQLite, 격리)
 * 로컬 클로드가 그림을 읽고 7축 구조(종류/자재/용도/문구/색특징/거래처/크기)로 캡션 → 여기 저장.
 * 시안 검색의 "내용 검색" 모드가 이 테이블을 읽음. (파일명 검색과 분리)
 * better-sqlite3 미설치 시 graceful no-op (ready()=false).
 */
const path = require('path');

let Database;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }

let db = null;
let ready = false;
if (Database) {
  try {
    db = new Database(path.join(__dirname, '..', 'data', 'design-captions.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS design_captions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        path       TEXT NOT NULL UNIQUE,   -- 서버 로컬 경로(D:\\★…\\..) — upsert 키
        folder     TEXT DEFAULT '',        -- ★폴더명
        client     TEXT DEFAULT '',        -- 거래처
        type       TEXT DEFAULT '',        -- 종류(현수막/스티커/간판/현황판/로고/캐릭터/표지…)
        material   TEXT DEFAULT '',        -- 자재(포맥스/타포린/PE/투명스티커/고무자석…)
        usage      TEXT DEFAULT '',        -- 용도(안전/MSDS/공사현황/접근금지…)
        text_in    TEXT DEFAULT '',        -- 이미지 속 문구
        visual     TEXT DEFAULT '',        -- 색·특징(색상/캐릭터/레이아웃)
        size       TEXT DEFAULT '',        -- 크기
        caption    TEXT DEFAULT '',        -- 검색용 합본(위 항목 + 파일명)
        created_at TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dc_folder ON design_captions(folder)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_dc_client ON design_captions(client)`);
    ready = true;
  } catch (e) {
    console.warn('[design-captions] DB init 실패:', e.message);
  }
}

function nowIso() { return new Date().toISOString(); }

// 합본 캡션(검색 대상) — 모든 축 + 파일명을 한 덩어리로
function buildCaption(c) {
  const base = path.basename(String(c.path || ''));
  return [c.client, c.type, c.material, c.usage, c.text_in, c.visual, c.size, base]
    .map(x => String(x || '').trim()).filter(Boolean).join(' ');
}

function upsert(c) {
  if (!ready || !c || !c.path) return null;
  const caption = c.caption && String(c.caption).trim() ? String(c.caption) : buildCaption(c);
  db.prepare(`
    INSERT INTO design_captions (path,folder,client,type,material,usage,text_in,visual,size,caption,created_at)
    VALUES (@path,@folder,@client,@type,@material,@usage,@text_in,@visual,@size,@caption,@created_at)
    ON CONFLICT(path) DO UPDATE SET
      folder=@folder, client=@client, type=@type, material=@material, usage=@usage,
      text_in=@text_in, visual=@visual, size=@size, caption=@caption
  `).run({
    path: String(c.path), folder: c.folder || '', client: c.client || '', type: c.type || '',
    material: c.material || '', usage: c.usage || '', text_in: c.text_in || '', visual: c.visual || '',
    size: c.size || '', caption, created_at: nowIso(),
  });
  return get(c.path);
}

function get(p) { if (!ready) return null; return db.prepare('SELECT * FROM design_captions WHERE path=?').get(String(p)); }

function count(folder) {
  if (!ready) return 0;
  if (folder) return db.prepare('SELECT COUNT(*) n FROM design_captions WHERE folder=?').get(folder).n;
  return db.prepare('SELECT COUNT(*) n FROM design_captions').get().n;
}

// 내용 검색: q(공백분리 AND, caption LIKE) + 패싯 필터(client/type/material/usage/folder)
function search({ q = '', client = '', type = '', material = '', usage = '', folder = '', limit = 60 } = {}) {
  if (!ready) return [];
  const where = [];
  const params = [];
  for (const t of String(q || '').trim().split(/\s+/).filter(Boolean)) {
    where.push('caption LIKE ?'); params.push('%' + t + '%');
  }
  const facet = (col, val) => { if (val) { where.push(`${col} LIKE ?`); params.push('%' + val + '%'); } };
  facet('client', client); facet('type', type); facet('material', material); facet('usage', usage); facet('folder', folder);
  const sql = `SELECT * FROM design_captions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(300, Math.max(1, parseInt(limit, 10) || 60)));
  return db.prepare(sql).all(...params);
}

// 패싯 후보(필터칩용): 자주 나오는 거래처/종류/자재/용도
function facets() {
  if (!ready) return { client: [], type: [], material: [], usage: [] };
  const top = (col) => db.prepare(`SELECT ${col} v, COUNT(*) n FROM design_captions WHERE ${col}<>'' GROUP BY ${col} ORDER BY n DESC LIMIT 30`).all();
  return { client: top('client'), type: top('type'), material: top('material'), usage: top('usage') };
}

module.exports = { ready: () => ready, upsert, get, count, search, facets };
