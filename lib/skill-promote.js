'use strict';
// 승인된(생성형) 작업을 "재사용 스킬"로 저장한다 — Phase 4 "등록"의 핵심.
// 결과: .claude/skills/<slug>/SKILL.md + scripts/make_generated.py,
//       data/ai-skill-templates/<slug>/<양식>, data/ai-skill-registry.json 등록.
// 다음부터 같은 거래처 파일을 올리면 라우터가 이 스킬을 찾아 즉시 실행(결정적).
const fs = require('fs');
const path = require('path');
const { registerSkill } = require('./skill-registry');

const GENERATED_SCRIPT = 'make_generated.py';

function slugify(vendorName = '') {
  const base = String(vendorName || '').trim().toLowerCase()
    .replace(/[^\w가-힣]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'generated') + '-ledger';
}

// opts: { slug?, vendorName, description?, scriptSrcPath? | scriptContent?,
//         templateSrcPath?, skillsRoot, templateRoot?, registryPath?, addedAt? }
function promoteSkill(opts = {}) {
  if (!opts.skillsRoot) throw new Error('promoteSkill: skillsRoot 필요');
  const slug = opts.slug || slugify(opts.vendorName);
  const skillDir = path.join(opts.skillsRoot, slug);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });

  const destScript = path.join(scriptsDir, GENERATED_SCRIPT);
  if (opts.scriptSrcPath && fs.existsSync(opts.scriptSrcPath)) {
    fs.copyFileSync(opts.scriptSrcPath, destScript);
  } else if (typeof opts.scriptContent === 'string') {
    fs.writeFileSync(destScript, opts.scriptContent, 'utf8');
  } else {
    throw new Error('promoteSkill: scriptSrcPath 또는 scriptContent 필요');
  }

  const name = opts.vendorName || slug;
  const desc = opts.description
    || `${name} 거래처 마감(자동 등록). 원본 + 전월 양식으로 거래명세서 생성. "${name} 마감" 요청에 적용.`;
  const skillMd = [
    '---',
    `name: ${slug}`,
    `description: ${desc}`,
    'generated: true',
    '---',
    '',
    `# ${name} 마감 (자동 등록 스킬)`,
    '',
    'AI가 생성하고 사장님이 승인한 재사용 틀입니다.',
    `scripts/${GENERATED_SCRIPT} 가 전월 양식을 복제해 당월 데이터를 채웁니다.`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');

  let templateSaved = null;
  if (opts.templateSrcPath && fs.existsSync(opts.templateSrcPath) && opts.templateRoot) {
    const tdir = path.join(opts.templateRoot, slug);
    fs.mkdirSync(tdir, { recursive: true });
    const tdest = path.join(tdir, path.basename(opts.templateSrcPath));
    fs.copyFileSync(opts.templateSrcPath, tdest);
    templateSaved = tdest;
  }

  if (opts.registryPath) {
    registerSkill(opts.registryPath, slug, { script: GENERATED_SCRIPT, name, addedAt: opts.addedAt || null });
  }

  return { slug, skillDir, scriptName: GENERATED_SCRIPT, scriptPath: destScript, templateSaved };
}

module.exports = { slugify, promoteSkill, GENERATED_SCRIPT };
