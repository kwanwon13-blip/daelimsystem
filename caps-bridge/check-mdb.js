// check-mdb.js — probe candidate mdb files to find which has May 2026 data
const fs = require('fs');
const path = require('path');
const MDBReader = require('mdb-reader');

const dir = 'C:\\Caps\\ACServer';
const candidates = [
  'ACCESS.mdb',
  'AccessTemp.mdb',
  'ACCESS_bak_before_compact.mdb',
  '20260511-AccessTemp.mdb',
  '20260511-Access.mdb',
  '20260504-Access.mdb',
  '20260427-Access.mdb',
];

console.log('Probing mdb candidates for May 2026 data...');
console.log('='.repeat(80));

for (const name of candidates) {
  const fp = path.join(dir, name);
  if (!fs.existsSync(fp)) {
    console.log(`${name.padEnd(40)} (file not found)`);
    continue;
  }

  const stat = fs.statSync(fp);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
  const mtime = stat.mtime.toISOString().slice(0,19).replace('T', ' ');

  try {
    // Copy to temp first to avoid lock issues
    const tempPath = path.join(require('os').tmpdir(), `probe_${name.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
    fs.copyFileSync(fp, tempPath);
    const buf = fs.readFileSync(tempPath);
    const reader = new MDBReader(buf);

    let total = 0, mayCount = 0, latestDate = '';
    try {
      const rows = reader.getTable('tenter').getData();
      total = rows.length;
      for (const r of rows) {
        const d = String(r.e_date || '').replace(/-/g, '');
        if (d.startsWith('202605')) mayCount++;
        if (d > latestDate) latestDate = d;
      }
    } catch (e) {
      console.log(`${name.padEnd(40)} ${sizeMb}MB ${mtime}  READ-FAIL: ${e.message}`);
      try { fs.unlinkSync(tempPath); } catch(_) {}
      continue;
    }

    console.log(`${name.padEnd(40)} ${sizeMb.padStart(6)}MB ${mtime}  total=${total} may=${mayCount} latest=${latestDate}`);
    try { fs.unlinkSync(tempPath); } catch(_) {}
  } catch (e) {
    console.log(`${name.padEnd(40)} ${sizeMb}MB ${mtime}  ERROR: ${e.message}`);
  }
}

console.log('='.repeat(80));
console.log('The file with the highest "may" count is the one caps-bridge should be reading.');
