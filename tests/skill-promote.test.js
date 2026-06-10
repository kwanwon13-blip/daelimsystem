const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slugify, promoteSkill } = require('../lib/skill-promote');
const reg = require('../lib/skill-registry');

// --- slugify ---
assert.strictEqual(slugify('엘지하우시스'), '엘지하우시스-ledger');
assert.strictEqual(slugify('  ABC Corp '), 'abc-corp-ledger');
assert.strictEqual(slugify(''), 'generated-ledger');

// --- promoteSkill: 파일 생성 + 레지스트리 등록 ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
try {
  const skillsRoot = path.join(tmp, 'skills');
  const templateRoot = path.join(tmp, 'templates');
  const registryPath = path.join(tmp, 'registry.json');
  const tplSrc = path.join(tmp, '전월양식.xlsx');
  fs.writeFileSync(tplSrc, 'dummy-xlsx');

  const result = promoteSkill({
    vendorName: '엘지하우시스',
    scriptContent: 'print("hello")',
    templateSrcPath: tplSrc,
    skillsRoot, templateRoot, registryPath,
  });

  assert.strictEqual(result.slug, '엘지하우시스-ledger');
  assert.strictEqual(result.scriptName, 'make_generated.py');
  const skillMdPath = path.join(skillsRoot, '엘지하우시스-ledger', 'SKILL.md');
  assert.ok(fs.existsSync(skillMdPath), 'SKILL.md 생성');
  assert.ok(fs.existsSync(result.scriptPath), '스크립트 생성');
  const md = fs.readFileSync(skillMdPath, 'utf8');
  assert.ok(/generated: true/.test(md), 'generated 마커');
  assert.ok(/name: 엘지하우시스-ledger/.test(md));
  assert.ok(result.templateSaved && fs.existsSync(result.templateSaved), '템플릿 저장');

  // 레지스트리 등록 확인
  const r = reg.loadRegistry(registryPath);
  assert.ok(r['엘지하우시스-ledger'], '레지스트리 등록됨');
  assert.strictEqual(reg.resolveScriptName('엘지하우시스-ledger', { bundled: {}, registryPath }), 'make_generated.py');
  // 번들 우선
  assert.strictEqual(reg.resolveScriptName('persys-ledger', { bundled: { 'persys-ledger': 'make_persys.py' }, registryPath }), 'make_persys.py');
  // 목록(번들+동적 합집합)
  const slugs = reg.listReusableSlugs({ bundled: { 'persys-ledger': 'make_persys.py' }, registryPath });
  assert.ok(slugs.includes('persys-ledger') && slugs.includes('엘지하우시스-ledger'));

  // listRegistryVendors — 내용감지용 거래처명 목록 + saveRegistry 후 캐시 무효화
  const vendors1 = reg.listRegistryVendors(registryPath);
  assert.ok(vendors1.some(v => v.slug === '엘지하우시스-ledger' && v.name === '엘지하우시스'));
  reg.registerSkill(registryPath, '하임-ledger', { script: 'make_generated.py', name: '하임' });
  const vendors2 = reg.listRegistryVendors(registryPath);
  assert.ok(vendors2.some(v => v.name === '하임'), 'saveRegistry 후 캐시가 갱신돼야 함');

  // scriptSrcPath 분기
  const srcPy = path.join(tmp, 'src.py');
  fs.writeFileSync(srcPy, 'print(1)');
  const r2 = promoteSkill({ slug: 'aaa-ledger', scriptSrcPath: srcPy, skillsRoot, registryPath });
  assert.ok(fs.existsSync(r2.scriptPath));
  assert.strictEqual(fs.readFileSync(r2.scriptPath, 'utf8'), 'print(1)');

  // 스크립트 소스 없으면 에러
  assert.throws(() => promoteSkill({ slug: 'x-ledger', skillsRoot }), /scriptSrcPath/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('PASS skill-promote');
