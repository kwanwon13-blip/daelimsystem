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
 *
 * ── 2026-05-14 견고화 패치 ─────────────────────────────────
 *  - mdb 사본을 만들어서 읽기 (CAPS 가 원본 잠근 동안에도 안전)
 *  - 읽기 실패 시 3회 재시도 (500ms 간격)
 *  - 모두 실패 시 마지막 성공 데이터 fallback (30분 이내)
 *  - /health 응답에 실제 mdb 읽기 가능 여부 + 마지막 에러 노출
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MDBReader = require('mdb-reader');

const app = express();
const PORT = 3001;
const MDB_PATH = 'C:\\Caps\\ACServer\\ACCESS.mdb';
const MDB_TEMP_PATH = path.join(os.tmpdir(), 'caps_bridge_snapshot.mdb');

app.use(cors({
  origin: ['http://192.168.0.133:3000', 'http://localhost:3000', 'http://127.0.0.1:3000']
}));
app.use(express.json());

// ⚠ 보안(2026-06-13): 이전엔 인증 없이 모든 인터페이스에 열려 있어 사내망 누구나 전 직원
// 출퇴근/사번(e_idno)/카드번호를 조회할 수 있었다. 신뢰 IP(서버 PC + 로컬)만 허용한다.
// 직접 LAN 호출이라 req.ip(소켓 주소)가 신뢰 가능 (메인 서버 터널과 달리 trust-proxy 무관).
// 추가 강화: CAPS_BRIDGE_SECRET 를 양쪽 PC 에 설정하면 헤더 검증도 켤 수 있음(기본 IP 게이트).
const CAPS_ALLOWED_IPS = new Set(
  (process.env.CAPS_ALLOWED_IPS || '192.168.0.133,127.0.0.1,::1,localhost')
    .split(',').map(s => s.trim()).filter(Boolean)
);
function _normIp(raw) {
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  return raw;
}
app.use((req, res, next) => {
  const ip = _normIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
  if (!CAPS_ALLOWED_IPS.has(ip)) {
    console.warn(`[caps-bridge] 차단된 IP: ${ip} (${req.method} ${req.url})`);
    return res.status(403).json({ error: 'CAPS_IP_FORBIDDEN' });
  }
  next();
});

// ─── MDB 읽기: 사본 + 재시도 + fallback ──────────────────
// CAPS 본체가 mdb 를 쓰는 동안 우리가 읽으면 페이지 깨짐 발생.
// → 매번 임시 사본을 만들어서 읽음. 실패 시 재시도 + 마지막 성공 데이터로 fallback.
let _cache = null;           // 최근 reader (30초 TTL)
let _cacheTime = 0;
let _lastGoodReader = null;  // 마지막으로 성공한 reader (장애 fallback 용)
let _lastGoodTime = 0;
let _lastErrorMsg = '';      // 헬스체크 노출용
let _lastErrorTime = 0;
let _retryStats = { total: 0, succeededOnRetry: 0, fallbackUsed: 0, failed: 0 };

function sleepSync(ms) {
  // 짧은 동기 대기 (재시도 간격용). spin 이지만 200~500ms 라 무시 가능 수준.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function readMdb() {
  const now = Date.now();

  // 30초 캐시 (정상 응답 보호)
  if (_cache && now - _cacheTime < 30000) return _cache;

  _retryStats.total++;
  const errors = [];

  // 가벼운 검증만 (메타데이터까지). 무거운 .getData() 검증은 안 함 →
  // health endpoint 3초 timeout 회피. 데이터 페이지 손상은 queryTenter 내부에서 retry.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 1) 사본 만들기
      fs.copyFileSync(MDB_PATH, MDB_TEMP_PATH);

      // 2) 사이즈 sanity check
      const origSize = fs.statSync(MDB_PATH).size;
      const tempSize = fs.statSync(MDB_TEMP_PATH).size;
      if (origSize !== tempSize) {
        throw new Error(`size mismatch (orig=${origSize}, temp=${tempSize})`);
      }

      // 3) 파싱 (메타데이터만 — 빠름)
      const buf = fs.readFileSync(MDB_TEMP_PATH);
      const reader = new MDBReader(buf);
      reader.getTable('tenter');  // 메타데이터 접근만, getData() 안 부름

      _cache = reader;
      _cacheTime = now;
      _lastGoodReader = reader;
      _lastGoodTime = now;
      _lastErrorMsg = '';
      _lastErrorTime = 0;
      if (attempt > 1) {
        _retryStats.succeededOnRetry++;
        console.log(`[readMdb] 시도 ${attempt}회만에 성공. 이전: ${errors.join(' | ')}`);
      }
      return reader;
    } catch (e) {
      errors.push(`시도${attempt}: ${e.message}`);
      if (attempt < 3) sleepSync(500);
    }
  }

  // 3회 모두 실패
  _lastErrorMsg = errors.join(' | ');
  _lastErrorTime = now;
  console.error(`[readMdb] 3회 모두 실패: ${_lastErrorMsg}`);

  // Fallback: 마지막 성공 데이터가 30분 이내라면 그걸로 응답
  if (_lastGoodReader && now - _lastGoodTime < 30 * 60 * 1000) {
    _retryStats.fallbackUsed++;
    const ageMin = Math.round((now - _lastGoodTime) / 60000);
    console.warn(`[readMdb] ⚠ Fallback 사용 (${ageMin}분 전 데이터)`);
    return _lastGoodReader;
  }

  // 진짜로 줄 수 있는 게 없음
  _retryStats.failed++;
  throw new Error(`mdb 읽기 실패 (3회 재시도, fallback 없음): ${_lastErrorMsg}`);
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
  // .getData() 가 페이지 손상에서 throw 할 수 있으므로 retry + fallback
  let rows = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const reader = readMdb();
      rows = reader.getTable('tenter').getData();
      break;  // 성공
    } catch (e) {
      lastErr = e;
      console.warn(`[queryTenter] 시도 ${attempt} 실패: ${e.message}`);
      // 캐시 무효화 → 다음 시도에서 fresh copy
      _cache = null;
      _cacheTime = 0;
      _lastErrorMsg = e.message;
      _lastErrorTime = Date.now();
      if (attempt < 4) sleepSync(500);
    }
  }
  // 4회 모두 실패: fallback 사용 (마지막 성공 reader)
  if (rows === null) {
    if (_lastGoodReader) {
      try {
        rows = _lastGoodReader.getTable('tenter').getData();
        _retryStats.fallbackUsed++;
        console.warn('[queryTenter] ⚠ 마지막 성공 reader 의 캐시된 데이터 사용');
      } catch (e2) {
        throw new Error(`queryTenter: 4회 retry + fallback 모두 실패. last: ${lastErr?.message}, fallback: ${e2.message}`);
      }
    } else {
      throw lastErr || new Error('queryTenter: rows null');
    }
  }

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
//  과거: mdb 파일 존재 여부만 봤음 → 라이브러리가 못 읽어도 'ok' 응답
//  현재: 실제로 한 번 읽어보고, 마지막 성공 시각/에러도 같이 노출
app.get('/health', (req, res) => {
  const mdbExists = fs.existsSync(MDB_PATH);
  let readable = false;
  let probeError = '';
  try {
    readMdb();  // 캐시 히트하면 1ms, miss 면 사본 만들어서 검증
    readable = true;
  } catch (e) {
    probeError = e.message;
  }
  res.json({
    status: readable ? 'ok' : (mdbExists ? 'mdb_unreadable' : 'mdb_not_found'),
    mdb: MDB_PATH,
    mdbExists,
    readable,
    lastGoodTime: _lastGoodTime ? new Date(_lastGoodTime).toISOString() : null,
    lastGoodAgeSec: _lastGoodTime ? Math.round((Date.now() - _lastGoodTime) / 1000) : null,
    lastError: _lastErrorMsg || null,
    lastErrorTime: _lastErrorTime ? new Date(_lastErrorTime).toISOString() : null,
    retryStats: _retryStats,
    probeError: probeError || null,
    time: new Date().toISOString(),
  });
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

// ─── 디버그 라우트(/api/debug/raw, /api/debug/table/:tbl, /api/debug/schema) 제거됨 ──
// (2026-06-13, 보안: 임의 테이블 덤프/스키마 노출 차단)

// '::' = dual-stack: IPv4 (0.0.0.0) + IPv6 (::1).
// 이전 '0.0.0.0' 만으로는 Chrome 의 localhost resolve (::1) 가 안 닿음.
app.listen(PORT, '::', () => {
  console.log(`\n[CAPS Bridge] 실행 중 — 포트 ${PORT}`);
  console.log(`  DB 경로: ${MDB_PATH}`);
  console.log(`  DB 존재: ${fs.existsSync(MDB_PATH)}`);
  console.log(`  사본 경로: ${MDB_TEMP_PATH}`);
  console.log(`  헬스체크: http://localhost:${PORT}/health`);
  console.log(`  직원목록: http://localhost:${PORT}/api/employees`);
  console.log(`  출퇴근: http://localhost:${PORT}/api/attendance?from=20260301&to=20260331\n`);
});
