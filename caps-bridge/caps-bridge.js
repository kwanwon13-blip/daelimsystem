/**
 * CAPS Bridge Server (NamPC 전용)
 * ACCESS.mdb → REST API (순수 JS, ADODB 불필요)
 *
 * 실행: node caps-bridge.js
 * 포트: 3001
 *
 * 데이터 소스: tenter 테이블 (실제 카드 스와이프 기록)
 *   e_date: YYYYMMDD, e_time: HHMMSS, e_name: 직원명
 *   e_mode: 1=출근(입실), 2=퇴근(퇴실), 7=기타출입
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const MDBReader = require('mdb-reader');

const app = express();
const PORT = 3001;
const MDB_PATH = 'C:\\Caps\\ACServer\\ACCESS.mdb';

app.use(cors({
  origin: ['http://192.168.0.133:3000', 'http://localhost:3000', 'http://127.0.0.1:3000']
}));
app.use(express.json());

// ─── MDB 읽기 (캐시 30초) ───────────────────────────────
let _cache = null;
let _cacheTime = 0;

function readMdb() {
  const now = Date.now();
  if (_cache && now - _cacheTime < 30000) return _cache;
  const buf = fs.readFileSync(MDB_PATH);
  _cache = new MDBReader(buf);
  _cacheTime = now;
  return _cache;
}

// ─── 유틸: tenter e_time "HHMMSS" → "HH:MM" 변환 ─────────
function tenterTimeToHHMM(e_time) {
  const t = String(e_time || '').padStart(6, '0');
  return `${t.slice(0,2)}:${t.slice(2,4)}`;
}

// ─── 유틸: "HH:MM" → 분 ────────────────────────────────
function timeToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// ─── 날짜 파싱 → "YYYY-MM-DD" ──────────────────────────
function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim().replace(/\D/g,'');
  if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return String(val);
}

// ─── tenter 조회 + 직원별/날짜별 집계 ─────────────────────
// 반환: [{ name, date, inTime, outTime, swipes: [...] }, ...]
function queryTenter(fromStr, toStr, name) {
  const reader = readMdb();
  const rows = reader.getTable('tenter').getData();

  // 날짜 정규화 (YYYY-MM-DD 또는 YYYYMMDD 모두 허용)
  const fromClean = fromStr.replace(/-/g, '');
  const toClean   = toStr.replace(/-/g, '');

  // 날짜 필터 + 이름 필터
  const filtered = rows.filter(r => {
    const d = String(r.e_date || '').replace(/-/g, '');
    if (!d || d < fromClean || d > toClean) return false;
    if (name && !String(r.e_name || '').includes(name)) return false;
    // 이름 없는 레코드 제외
    if (!String(r.e_name || '').trim()) return false;
    return true;
  });

  // (직원명, 날짜) 기준 그룹화
  const grouped = {};
  for (const r of filtered) {
    const empName = String(r.e_name || '').trim();
    const date = String(r.e_date || '').trim();
    const key = `${empName}||${date}`;
    if (!grouped[key]) {
      grouped[key] = { name: empName, date, swipes: [] };
    }
    grouped[key].swipes.push({
      time: tenterTimeToHHMM(r.e_time),
      timeRaw: String(r.e_time || ''),
      mode: String(r.e_mode || ''),
      gate: r.g_id,
    });
  }

  // 각 그룹에서 출근/퇴근 추출
  const result = Object.values(grouped).map(g => {
    // mode=1: 출근, mode=2: 퇴근, mode=7: 기타(야근퇴근 포함)
    const checkIns  = g.swipes.filter(s => s.mode === '1').sort((a,b) => a.timeRaw.localeCompare(b.timeRaw));
    const checkOuts = g.swipes.filter(s => s.mode === '2').sort((a,b) => a.timeRaw.localeCompare(b.timeRaw));
    const mode7s    = g.swipes.filter(s => s.mode === '7').sort((a,b) => a.timeRaw.localeCompare(b.timeRaw));

    const inTime  = checkIns.length  ? checkIns[0].time  : null;  // 첫 출근
    // 퇴근: mode=2 없으면 mode=7 중 가장 늦은 것
    let outTime = checkOuts.length ? checkOuts[checkOuts.length - 1].time : null;
    if (!outTime && mode7s.length) outTime = mode7s[mode7s.length - 1].time;

    return {
      name: g.name,
      date: parseDate(g.date),
      inTime,
      outTime,
      swipeCount: g.swipes.length,
    };
  }).sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name, 'ko');
    return a.date > b.date ? 1 : -1;
  });

  return result;
}

// ─── 헬스체크 ────────────────────────────────────────────
app.get('/health', (req, res) => {
  const exists = fs.existsSync(MDB_PATH);
  res.json({ status: exists ? 'ok' : 'mdb_not_found', mdb: MDB_PATH, time: new Date().toISOString() });
});

// ─── 직원 목록 (tenter 기반 - 최근 6개월 활성 직원) ─────────
app.get('/api/employees', (req, res) => {
  try {
    const reader = readMdb();
    const rows = reader.getTable('tenter').getData();

    // 최근 45일 기준 (퇴사자 자동 제외)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 45);
    const cutoffStr = cutoff.toISOString().slice(0,10).replace(/-/g,'');

    const names = new Set();
    for (const r of rows) {
      const d = String(r.e_date || '').replace(/-/g,'');
      const n = String(r.e_name || '').trim();
      if (d >= cutoffStr && n) names.add(n);
    }

    const list = Array.from(names).sort((a, b) => a.localeCompare(b, 'ko'))
                       .map(name => ({ id: name, name }));
    res.json(list);
  } catch (err) {
    console.error('[직원목록 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 출퇴근 기록 (tenter 기반) ───────────────────────────
// GET /api/attendance?from=YYYYMMDD&to=YYYYMMDD[&employeeId=이름]
app.get('/api/attendance', (req, res) => {
  try {
    const { from, to, employeeId } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from, to 파라미터 필요 (YYYYMMDD)' });

    const fromStr = from.replace(/-/g,'');
    const toStr   = to.replace(/-/g,'');

    const result = queryTenter(fromStr, toStr, employeeId || null);
    res.json(result);
  } catch (err) {
    console.error('[출퇴근조회 오류]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── tenter 원본 조회 (디버그) ────────────────────────────
// GET /api/tenter?from=YYYYMMDD&to=YYYYMMDD[&name=이름]
app.get('/api/tenter', (req, res) => {
  try {
    const { from, to, name, card } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from, to 파라미터 필요 (YYYYMMDD)' });

    const fromStr = from.replace(/-/g, '');
    const toStr   = to.replace(/-/g, '');

    const reader = readMdb();
    const rows = reader.getTable('tenter').getData();

    const filtered = rows.filter(r => {
      const d = String(r.e_date || '').replace(/-/g, '');
      if (!d || d < fromStr || d > toStr) return false;
      if (name && !String(r.e_name || '').includes(name)) return false;
      if (card && !String(r.e_card || '').includes(card)) return false;
      return true;
    });

    const result = filtered.slice(0, 500).map(r => {
      const t = String(r.e_time || '').padStart(6, '0');
      const timeStr = `${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`;
      return {
        date: r.e_date,
        time: timeStr,
        datetime: `${r.e_date} ${timeStr}`,
        name: r.e_name,
        idno: r.e_idno,
        card: r.e_card,
        mode: r.e_mode,
        gate: r.g_id,
      };
    });

    res.json({ count: result.length, rows: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RAW nOutput 데이터 (디버그) ──────────────────────────
app.get('/api/debug/raw', (req, res) => {
  try {
    const { from, to, name } = req.query;
    const reader = readMdb();
    const rows = reader.getTable('nOutput').getData();
    const filtered = rows.filter(r => {
      const d = String(r.d_date || '').trim().replace(/\D/g,'');
      if (from && d < from) return false;
      if (to   && d > to)   return false;
      if (name && !String(r.e_name || '').includes(name)) return false;
      return true;
    }).slice(0, 50);
    res.json(filtered);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 테이블 샘플 (디버그) ─────────────────────────────────
app.get('/api/debug/table/:tbl', (req, res) => {
  try {
    const reader = readMdb();
    const rows = reader.getTable(req.params.tbl).getData().slice(0, 20);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 테이블 목록 + 샘플 (디버그) ─────────────────────────
app.get('/api/debug/schema', (req, res) => {
  try {
    const reader = readMdb();
    const tables = reader.getTableNames();
    let sample = [];
    if (tables.includes('nOutput')) {
      sample = reader.getTable('nOutput').getData().slice(0, 3);
    }
    res.json({ tables, sample });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n[CAPS Bridge] 실행 중 — 포트 ${PORT}`);
  console.log(`  DB 경로: ${MDB_PATH}`);
  console.log(`  DB 존재: ${fs.existsSync(MDB_PATH)}`);
  console.log(`  헬스체크: http://localhost:${PORT}/health`);
  console.log(`  직원목록: http://localhost:${PORT}/api/employees`);
  console.log(`  출퇴근: http://localhost:${PORT}/api/attendance?from=20260301&to=20260331\n`);
});
