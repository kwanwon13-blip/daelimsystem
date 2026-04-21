/**
 * routes/gps-attendance.js — GPS 기반 모바일 출퇴근 체크
 *
 * 공장(대림컴퍼니) 등 CAPS 장비 없는 사업장용
 * 직원이 핸드폰에서 출근/퇴근 버튼 → GPS 좌표 전송 → 서버가 반경 내 확인 → 기록
 */
const express = require('express');
const router = express.Router();
const Database = require('better-sqlite3');
const path = require('path');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const db = require('../db');

// ── SQLite 테이블 (업무데이터.db) ──
const DB_PATH = path.join(__dirname, '..', 'data', '업무데이터.db');
let sqlDb;
try {
  sqlDb = new Database(DB_PATH);
  sqlDb.pragma('journal_mode = WAL');
} catch (e) {
  console.error('[GPS출퇴근] SQLite 연결 실패:', e.message);
}

if (sqlDb) {
  // GPS 출퇴근 기록
  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS gps_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      userName TEXT NOT NULL DEFAULT '',
      companyId TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,            -- 'check_in' | 'check_out'
      date TEXT NOT NULL,            -- 'YYYY-MM-DD'
      time TEXT NOT NULL,            -- 'HH:MM:SS'
      latitude REAL,
      longitude REAL,
      accuracy REAL,                 -- GPS 정확도 (미터)
      withinRange INTEGER DEFAULT 0, -- 반경 내 여부 (1/0)
      distance REAL,                 -- 사업장까지 거리 (미터)
      locationName TEXT DEFAULT '',  -- 매칭된 사업장명
      deviceInfo TEXT DEFAULT '',    -- 디바이스 정보
      ip TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
  // 인덱스
  try { sqlDb.exec(`CREATE INDEX IF NOT EXISTS idx_gps_att_user_date ON gps_attendance(userId, date)`); } catch(e) {}
  try { sqlDb.exec(`CREATE INDEX IF NOT EXISTS idx_gps_att_company ON gps_attendance(companyId, date)`); } catch(e) {}

  // 사업장 위치 설정
  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS gps_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      companyId TEXT NOT NULL,
      name TEXT NOT NULL,             -- '대림컴퍼니 공장', '대림에스엠 본사'
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius INTEGER DEFAULT 200,     -- 허용 반경 (미터)
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

// ── Haversine 공식 (두 GPS 좌표 간 거리 계산, 미터) ──
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; // 지구 반지름 (미터)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── 주소 → 좌표 변환 (Geocoding) ──
// 1순위: Kakao 로컬 API (process.env.KAKAO_REST_KEY 설정 시)
// 2순위: OpenStreetMap Nominatim (키 불필요, 한국 정확도 다소 낮음)
async function geocodeAddress(address) {
  const kakaoKey = process.env.KAKAO_REST_KEY;
  if (kakaoKey) {
    try {
      const url = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(address);
      const r = await fetch(url, { headers: { Authorization: 'KakaoAK ' + kakaoKey } });
      if (r.ok) {
        const data = await r.json();
        const results = (data.documents || []).map(d => ({
          latitude: parseFloat(d.y),
          longitude: parseFloat(d.x),
          displayName: d.address_name || d.road_address_name || address,
          source: 'kakao'
        })).filter(r => !isNaN(r.latitude) && !isNaN(r.longitude));
        if (results.length > 0) return results;
      }
    } catch (e) {
      console.warn('[GPS geocode] Kakao 실패, Nominatim fallback:', e.message);
    }
  }
  // Nominatim (키리스)
  const url = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=kr&addressdetails=1&limit=5&q=' + encodeURIComponent(address);
  const r = await fetch(url, { headers: { 'User-Agent': 'daelim-sm-erp/1.0 (kwanwon13@gmail.com)' } });
  if (!r.ok) throw new Error('Nominatim ' + r.status);
  const data = await r.json();
  return (data || []).map(d => ({
    latitude: parseFloat(d.lat),
    longitude: parseFloat(d.lon),
    displayName: d.display_name,
    source: 'nominatim',
    importance: d.importance
  })).filter(r => !isNaN(r.latitude) && !isNaN(r.longitude));
}

router.get('/geocode', requireAuth, async (req, res) => {
  try {
    const address = (req.query.address || '').trim();
    if (!address) return res.status(400).json({ error: '주소를 입력하세요' });
    const results = await geocodeAddress(address);
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[GPS geocode]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 사업장 위치 관리 (관리자) ──

// 사업장 위치 목록
router.get('/locations', requireAuth, (req, res) => {
  try {
    const locations = sqlDb.prepare('SELECT * FROM gps_locations ORDER BY companyId, name').all();
    res.json({ ok: true, locations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 사업장 위치 추가
router.post('/locations', requireAdmin, (req, res) => {
  try {
    const { companyId, name, latitude, longitude, radius } = req.body;
    if (!companyId || !name || latitude == null || longitude == null) {
      return res.status(400).json({ error: '회사, 이름, 위도, 경도를 입력해주세요' });
    }
    sqlDb.prepare(`
      INSERT INTO gps_locations (companyId, name, latitude, longitude, radius)
      VALUES (?, ?, ?, ?, ?)
    `).run(companyId, name, latitude, longitude, radius || 200);
    const locations = sqlDb.prepare('SELECT * FROM gps_locations ORDER BY companyId, name').all();
    res.json({ ok: true, locations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 사업장 위치 수정
router.put('/locations/:id', requireAdmin, (req, res) => {
  try {
    const { name, latitude, longitude, radius, active } = req.body;
    const loc = sqlDb.prepare('SELECT * FROM gps_locations WHERE id = ?').get(req.params.id);
    if (!loc) return res.status(404).json({ error: '위치 없음' });

    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (latitude !== undefined) { updates.push('latitude = ?'); params.push(latitude); }
    if (longitude !== undefined) { updates.push('longitude = ?'); params.push(longitude); }
    if (radius !== undefined) { updates.push('radius = ?'); params.push(radius); }
    if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
    params.push(req.params.id);

    if (updates.length > 0) {
      sqlDb.prepare(`UPDATE gps_locations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    const locations = sqlDb.prepare('SELECT * FROM gps_locations ORDER BY companyId, name').all();
    res.json({ ok: true, locations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 사업장 위치 삭제
router.delete('/locations/:id', requireAdmin, (req, res) => {
  try {
    sqlDb.prepare('DELETE FROM gps_locations WHERE id = ?').run(req.params.id);
    const locations = sqlDb.prepare('SELECT * FROM gps_locations ORDER BY companyId, name').all();
    res.json({ ok: true, locations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 출퇴근 체크 (핵심 API) ──

router.post('/check', requireAuth, (req, res) => {
  try {
    const { type, latitude, longitude, accuracy, deviceInfo } = req.body;
    if (!type || !['check_in', 'check_out'].includes(type)) {
      return res.status(400).json({ error: 'type은 check_in 또는 check_out이어야 합니다' });
    }
    if (latitude == null || longitude == null) {
      return res.status(400).json({ error: 'GPS 좌표가 필요합니다. 위치 권한을 허용해주세요.' });
    }

    // GPS 정확도 체크 (300m 이상이면 정확도 너무 낮음)
    if (accuracy && accuracy > 300) {
      return res.status(400).json({
        error: 'GPS 정확도가 너무 낮습니다 (' + Math.round(accuracy) + 'm). 실외에서 다시 시도해주세요.'
      });
    }

    const userId = req.user.userId;
    const companyId = req.user.companyId || 'dalim-sm';
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toTimeString().slice(0, 8);

    // 중복 체크 (같은 날 같은 타입 5분 이내 재체크 방지)
    const recent = sqlDb.prepare(`
      SELECT * FROM gps_attendance
      WHERE userId = ? AND date = ? AND type = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(userId, date, type);

    if (recent) {
      const recentTime = new Date(date + 'T' + recent.time);
      const diff = (now - recentTime) / 1000 / 60; // 분
      if (diff < 5) {
        return res.status(400).json({
          error: `${type === 'check_in' ? '출근' : '퇴근'} 기록이 이미 있습니다 (${recent.time}). 5분 후 다시 시도해주세요.`
        });
      }
    }

    // 사업장 위치와 거리 계산
    const locations = sqlDb.prepare(
      'SELECT * FROM gps_locations WHERE (companyId = ? OR companyId = ?) AND active = 1'
    ).all(companyId, '__all__');

    let withinRange = 0;
    let closestDistance = Infinity;
    let matchedLocation = '';

    for (const loc of locations) {
      const dist = haversineDistance(latitude, longitude, loc.latitude, loc.longitude);
      if (dist < closestDistance) {
        closestDistance = dist;
        matchedLocation = loc.name;
      }
      if (dist <= loc.radius) {
        withinRange = 1;
      }
    }

    // 사업장이 설정되지 않은 경우 → 경고만 하고 기록은 함
    if (locations.length === 0) {
      withinRange = -1; // 사업장 미설정
      closestDistance = 0;
      matchedLocation = '(사업장 미설정)';
    }

    // 사용자 이름 조회
    let userName = req.user.name || userId;

    // IP 기록
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';

    // 기록 저장
    sqlDb.prepare(`
      INSERT INTO gps_attendance (userId, userName, companyId, type, date, time,
        latitude, longitude, accuracy, withinRange, distance, locationName, deviceInfo, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, userName, companyId, type, date, time,
      latitude, longitude, accuracy || 0, withinRange,
      Math.round(closestDistance), matchedLocation, deviceInfo || '', ip);

    const typeLabel = type === 'check_in' ? '출근' : '퇴근';

    res.json({
      ok: true,
      message: withinRange === 1
        ? `${typeLabel} 완료! (${matchedLocation}, ${Math.round(closestDistance)}m)`
        : withinRange === -1
          ? `${typeLabel} 기록됨 (사업장 위치가 아직 설정되지 않았습니다)`
          : `${typeLabel} 기록됨 (⚠️ 사업장 반경 밖 — ${matchedLocation}에서 ${Math.round(closestDistance)}m)`,
      withinRange,
      distance: Math.round(closestDistance),
      locationName: matchedLocation,
      time
    });
  } catch (e) {
    console.error('[GPS출퇴근] 체크 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 오늘 내 출퇴근 상태 ──
router.get('/my-today', requireAuth, (req, res) => {
  try {
    const userId = req.user.userId;
    const today = new Date().toISOString().slice(0, 10);

    const records = sqlDb.prepare(`
      SELECT * FROM gps_attendance WHERE userId = ? AND date = ? ORDER BY created_at ASC
    `).all(userId, today);

    const checkIn = records.find(r => r.type === 'check_in');
    const checkOut = records.filter(r => r.type === 'check_out').pop(); // 마지막 퇴근

    res.json({
      ok: true,
      today,
      checkIn: checkIn ? { time: checkIn.time, withinRange: checkIn.withinRange, locationName: checkIn.locationName } : null,
      checkOut: checkOut ? { time: checkOut.time, withinRange: checkOut.withinRange, locationName: checkOut.locationName } : null,
      records
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 출퇴근 기록 조회 (관리자 or 본인) ──
router.get('/records', requireAuth, (req, res) => {
  try {
    const { date, startDate, endDate, companyId, userId: queryUserId } = req.query;

    let sql = 'SELECT * FROM gps_attendance WHERE 1=1';
    const params = [];

    // 관리자가 아니면 본인만
    if (req.user.role !== 'admin') {
      sql += ' AND userId = ?';
      params.push(req.user.userId);
    } else {
      // 관리자: 회사별 필터
      if (companyId) {
        sql += ' AND companyId = ?';
        params.push(companyId);
      }
      if (queryUserId) {
        sql += ' AND userId = ?';
        params.push(queryUserId);
      }
    }

    // 날짜 필터
    if (date) {
      sql += ' AND date = ?';
      params.push(date);
    } else if (startDate && endDate) {
      sql += ' AND date BETWEEN ? AND ?';
      params.push(startDate, endDate);
    } else {
      // 기본: 최근 30일
      const d = new Date();
      d.setDate(d.getDate() - 30);
      sql += ' AND date >= ?';
      params.push(d.toISOString().slice(0, 10));
    }

    sql += ' ORDER BY date DESC, time DESC';

    const records = sqlDb.prepare(sql).all(...params);
    res.json({ ok: true, records });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 일별 출퇴근 요약 (관리자용 대시보드) ──
router.get('/daily-summary', requireAuth, (req, res) => {
  try {
    const { date, companyId } = req.query;
    const targetDate = date || new Date().toISOString().slice(0, 10);

    let sql = `
      SELECT userId, userName, companyId,
        MIN(CASE WHEN type='check_in' THEN time END) as firstCheckIn,
        MAX(CASE WHEN type='check_out' THEN time END) as lastCheckOut,
        MIN(CASE WHEN type='check_in' THEN withinRange END) as checkInRange,
        MAX(CASE WHEN type='check_out' THEN withinRange END) as checkOutRange,
        COUNT(*) as totalRecords
      FROM gps_attendance
      WHERE date = ?
    `;
    const params = [targetDate];

    if (req.user.role !== 'admin') {
      // 팀장이면 같은 부서만, 일반이면 본인만
      sql += ' AND userId = ?';
      params.push(req.user.userId);
    } else if (companyId) {
      sql += ' AND companyId = ?';
      params.push(companyId);
    }

    sql += ' GROUP BY userId ORDER BY firstCheckIn ASC';

    const summary = sqlDb.prepare(sql).all(...params);

    // 총 직원 수 대비 출근율 계산
    const uData = db.loadUsers();
    const activeUsers = (uData.users || []).filter(u =>
      u.status === 'approved' &&
      (!companyId || u.companyId === companyId)
    );

    res.json({
      ok: true,
      date: targetDate,
      summary,
      totalEmployees: activeUsers.length,
      checkedIn: summary.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 관리자: 수동 기록 추가/수정 ──
router.post('/manual', requireAdmin, (req, res) => {
  try {
    const { userId, type, date, time, note } = req.body;
    if (!userId || !type || !date || !time) {
      return res.status(400).json({ error: '필수 항목 누락' });
    }

    const uData = db.loadUsers();
    const user = (uData.users || []).find(u => u.userId === userId);
    if (!user) return res.status(404).json({ error: '사용자 없음' });

    sqlDb.prepare(`
      INSERT INTO gps_attendance (userId, userName, companyId, type, date, time,
        latitude, longitude, accuracy, withinRange, distance, locationName, note)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 1, 0, '수동입력', ?)
    `).run(userId, user.name, user.companyId || 'dalim-sm', type, date, time, note || '관리자 수동 입력');

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
