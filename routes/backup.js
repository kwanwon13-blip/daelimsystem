/**
 * routes/backup.js — 데이터 백업/복원/수동백업
 * Mounted at: app.use('/api', require('./routes/backup'))
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

// ── 백업 ─────────────────────────────────────────────────
router.get('/export', requireAdmin, (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="price-backup.json"');
  if (db.sql) {
    // SQLite 모드: 모든 데이터를 수집
    const vendors = db.sql.vendors.getAll();
    const vendorPrices = [];
    for (const vendor of vendors) {
      const prices = db.sql.vendorPrices.getByVendor(vendor.id);
      vendorPrices.push(...prices);
    }
    const exportData = {
      categories: db.sql.categories.getAll(),
      options: db.sql.options.getAll(),
      vendors: vendors,
      vendorPrices: vendorPrices,
      quotes: db.sql.quotes.getAll(),
      products: []
    };
    return res.json(exportData);
  }
  res.json(db.load());
});

router.post('/import', requireAdmin, (req, res) => {
  try {
    if (!req.body.categories) throw new Error('형식 오류');
    if (db.sql) {
      // SQLite 모드: 데이터를 각 테이블에 저장
      // Note: 기존 데이터는 유지하고 새 데이터를 추가/갱신하는 로직이 필요할 수 있음
      // 현재는 단순히 경고만 표시
      console.warn('⚠️ SQLite 모드에서 import는 신중하게 구현되어야 합니다');
      return res.status(400).json({ error: 'SQLite 모드에서 현재 import 미지원' });
    }
    db.save(req.body); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── 수동 백업 (관리자 전용) ──────────────────────────────
const BACKUP_ROOT = path.join(__dirname, '..', 'backups');

// 백업 목록
router.get('/backups', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_ROOT)) return res.json({ backups: [] });
    const dirs = fs.readdirSync(BACKUP_ROOT)
      .filter(f => {
        try { return fs.statSync(path.join(BACKUP_ROOT, f)).isDirectory(); } catch(e) { return false; }
      })
      .sort().reverse()  // 최신 순
      .slice(0, 30)
      .map(name => {
        const dirPath = path.join(BACKUP_ROOT, name);
        const files = fs.readdirSync(dirPath);
        let totalSize = 0;
        files.forEach(f => {
          try { totalSize += fs.statSync(path.join(dirPath, f)).size; } catch(e) {}
        });
        return { name, files: files.length, size: Math.round(totalSize / 1024) };
      });
    // 내부 버전 백업(_자동백업) 정보도 포함
    const autoBackupDir = path.join(__dirname, '..', 'data', '_자동백업');
    let versionFiles = 0;
    if (fs.existsSync(autoBackupDir)) {
      versionFiles = fs.readdirSync(autoBackupDir).length;
    }
    res.json({ backups: dirs, versionBackups: versionFiles });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// 수동 백업 실행
router.post('/backup/now', requireAdmin, (req, res) => {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupDir = path.join(BACKUP_ROOT, ts);
    if (!fs.existsSync(BACKUP_ROOT)) fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    const dataDir = path.join(__dirname, '..', 'data');
    let count = 0;
    // JSON 파일 복사
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json') || f.endsWith('.db'));
    for (const f of files) {
      try {
        fs.copyFileSync(path.join(dataDir, f), path.join(backupDir, f));
        count++;
      } catch(e) { /* 개별 실패 무시 */ }
    }
    // SQLite DB 복사
    const dbPath = path.join(dataDir, '업무데이터.db');
    if (fs.existsSync(dbPath)) {
      try { fs.copyFileSync(dbPath, path.join(backupDir, '업무데이터.db')); count++; } catch(e) {}
    }

    // 감사 로그
    const userId = req.user?.userId || 'system';
    auditLog(userId, '수동백업', `backups/${ts}`, `${count}개 파일 백업`);

    // 30개 초과 시 오래된 것 삭제
    const allDirs = fs.readdirSync(BACKUP_ROOT)
      .filter(f => { try { return fs.statSync(path.join(BACKUP_ROOT, f)).isDirectory(); } catch(e) { return false; } })
      .sort();
    while (allDirs.length > 30) {
      const oldest = allDirs.shift();
      try {
        const oldPath = path.join(BACKUP_ROOT, oldest);
        fs.readdirSync(oldPath).forEach(f => fs.unlinkSync(path.join(oldPath, f)));
        fs.rmdirSync(oldPath);
      } catch(e) {}
    }

    res.json({ ok: true, dir: ts, files: count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
