// auto-compact.js — extract MDB password and compact via JRO automatically
// v2: write .ps1 to disk + capture stderr for diagnostics
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const MDBReader = require('mdb-reader');

const MDB    = 'C:\\Caps\\ACServer\\ACCESS.mdb';
const BAK    = 'C:\\Caps\\ACServer\\ACCESS_bak_before_compact.mdb';
const FIXED  = 'C:\\Caps\\ACServer\\ACCESS_fixed.mdb';

function step(n, msg) { console.log(`[${n}] ${msg}`); }

try {
  step('1/6', 'reading MDB and extracting embedded password...');
  const buf = fs.readFileSync(MDB);
  const reader = new MDBReader(buf);
  const pw = reader.getPassword() || '';
  console.log(`   password length=${pw.length}, hex_first_4_bytes=${Buffer.from(pw, 'utf8').slice(0,4).toString('hex')}`);

  step('2/6', 'backing up original...');
  if (!fs.existsSync(BAK)) {
    fs.copyFileSync(MDB, BAK);
    console.log(`   Backup -> ${BAK}`);
  } else {
    console.log(`   Backup already exists at ${BAK} (kept).`);
  }

  if (fs.existsSync(FIXED)) {
    try { fs.unlinkSync(FIXED); } catch(_) {}
  }

  step('3/6', 'writing PowerShell script to disk...');

  // Pass password via base64 (avoid quoting/encoding issues)
  const pwB64 = Buffer.from(pw, 'utf8').toString('base64');
  const mdbPS   = MDB;
  const fixedPS = FIXED;

  // Use UTF-8 BOM for safe Korean handling; PowerShell needs BOM for UTF-8 .ps1
  const psScript = '﻿' + `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'

$pwB64 = '${pwB64}'
$pw    = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($pwB64))
$src   = '${mdbPS}'
$dst   = '${fixedPS}'

Write-Host "DIAG: PSVersion=$($PSVersionTable.PSVersion)"
Write-Host "DIAG: Process bitness=$([Environment]::Is64BitProcess)"
Write-Host "DIAG: Password length=$($pw.Length)"
Write-Host "DIAG: Source=$src"
Write-Host "DIAG: Dest=$dst"
Write-Host ""

function CompactWith([string]$provider) {
  $srcConn = "Provider=$provider;Data Source=$src;Jet OLEDB:Database Password=$pw"
  $dstConn = "Provider=$provider;Data Source=$dst;Jet OLEDB:Database Password=$pw"
  Write-Host "==> Trying provider: $provider"
  $j = New-Object -ComObject JRO.JetEngine
  $j.CompactDatabase($srcConn, $dstConn)
  if (Test-Path $dst) {
    $sz = (Get-Item $dst).Length
    Write-Host "==> OK with $provider. Compacted size: $sz bytes"
    return $true
  } else {
    Write-Host "==> $provider returned without error but file was not created"
    return $false
  }
}

$ok = $false
try {
  $ok = CompactWith 'Microsoft.Jet.OLEDB.4.0'
} catch {
  Write-Host "Jet 4.0 EXCEPTION: $($_.Exception.GetType().FullName)"
  Write-Host "Jet 4.0 MESSAGE  : $($_.Exception.Message)"
  if ($_.Exception.InnerException) {
    Write-Host "Jet 4.0 INNER    : $($_.Exception.InnerException.Message)"
  }
  if (Test-Path $dst) { Remove-Item $dst -Force }
}

if (-not $ok) {
  try {
    $ok = CompactWith 'Microsoft.ACE.OLEDB.12.0'
  } catch {
    Write-Host "ACE 12 EXCEPTION: $($_.Exception.GetType().FullName)"
    Write-Host "ACE 12 MESSAGE  : $($_.Exception.Message)"
    if ($_.Exception.InnerException) {
      Write-Host "ACE 12 INNER    : $($_.Exception.InnerException.Message)"
    }
    if (Test-Path $dst) { Remove-Item $dst -Force }
  }
}

if (-not $ok) {
  try {
    $ok = CompactWith 'Microsoft.ACE.OLEDB.16.0'
  } catch {
    Write-Host "ACE 16 EXCEPTION: $($_.Exception.GetType().FullName)"
    Write-Host "ACE 16 MESSAGE  : $($_.Exception.Message)"
    if ($_.Exception.InnerException) {
      Write-Host "ACE 16 INNER    : $($_.Exception.InnerException.Message)"
    }
  }
}

if ($ok) { exit 0 } else { exit 1 }
`;

  const ps1Path = path.join(__dirname, 'compact-temp.ps1');
  fs.writeFileSync(ps1Path, psScript, { encoding: 'utf8' });
  console.log(`   ps1 -> ${ps1Path}`);

  step('4/6', 'running 32-bit PowerShell with .ps1 ...');
  const ps32 = `${process.env.SystemRoot}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const psExe = fs.existsSync(ps32) ? ps32 : 'powershell.exe';
  console.log(`   psExe -> ${psExe}`);

  let psOut = '', psErr = '', psStatus = 0;
  try {
    psOut = execSync(
      `"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (e) {
    psStatus = e.status || -1;
    psOut = (e.stdout || '').toString();
    psErr = (e.stderr || '').toString();
  }

  console.log('--- PowerShell stdout ---');
  console.log(psOut || '(empty)');
  if (psErr) {
    console.log('--- PowerShell stderr ---');
    console.log(psErr);
  }
  console.log(`--- PowerShell exit code: ${psStatus} ---`);

  // Try 64-bit PowerShell as fallback (some ACE installs are 64-bit only)
  if (!fs.existsSync(FIXED)) {
    console.log('');
    step('4b', 'retrying with 64-bit PowerShell (in case ACE installed is 64-bit only)...');
    psStatus = 0; psOut = ''; psErr = '';
    try {
      psOut = execSync(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${ps1Path}"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch (e) {
      psStatus = e.status || -1;
      psOut = (e.stdout || '').toString();
      psErr = (e.stderr || '').toString();
    }
    console.log('--- 64-bit stdout ---');
    console.log(psOut || '(empty)');
    if (psErr) {
      console.log('--- 64-bit stderr ---');
      console.log(psErr);
    }
    console.log(`--- 64-bit exit code: ${psStatus} ---`);
  }

  if (!fs.existsSync(FIXED)) {
    step('FAIL', 'JRO compact did not produce output file. See PowerShell messages above.');
    console.log('');
    console.log('Original MDB is intact. Backup at:', BAK);
    console.log('');
    console.log('Likely causes:');
    console.log('  - JRO.JetEngine COM not installed (no MS Office / Access Database Engine)');
    console.log('  - Password not actually the one stored (rare)');
    console.log('  - mdb too corrupt for JRO to repair (it can fix some, not all)');
    // do not delete ps1 so user can inspect
    process.exit(1);
  }

  const oldSize = fs.statSync(MDB).size;
  const newSize = fs.statSync(FIXED).size;
  console.log('');
  console.log(`   Original size: ${oldSize.toLocaleString()} bytes`);
  console.log(`   Fixed    size: ${newSize.toLocaleString()} bytes`);

  step('5/6', 'replacing original with compacted file...');
  fs.renameSync(FIXED, MDB);

  step('6/6', 'DONE.');
  console.log('');
  console.log('Next steps:');
  console.log('  1) Start CAPS ACServer again');
  console.log('  2) Open in browser:');
  console.log('     http://localhost:3001/api/attendance?from=20260501&to=20260514');
  console.log('     Should return an array (not error).');
  console.log('  3) In ERP, click "CAPS 동기화" — May data should appear.');

  // cleanup
  try { fs.unlinkSync(ps1Path); } catch(_) {}
} catch (err) {
  console.error('');
  console.error('UNCAUGHT ERROR:', err.message);
  console.error(err.stack);
  process.exit(1);
}
