'use strict';
// 동적(승인되어 등록된) 재사용 스킬 레지스트리.
// data/ai-skill-registry.json 형태: { "<slug>": { script, name, addedAt } }
// 기존 BUNDLED_SCRIPT_SKILLS(하드코딩)와 함께 쓰며, 번들이 우선한다.
const fs = require('fs');
const path = require('path');

function loadRegistry(registryPath) {
  try {
    if (!registryPath || !fs.existsSync(registryPath)) return {};
    const j = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch (_) { return {}; }
}

function saveRegistry(registryPath, reg) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(reg || {}, null, 2), 'utf8');
}

function registerSkill(registryPath, slug, info = {}) {
  const reg = loadRegistry(registryPath);
  reg[slug] = {
    script: info.script || 'make_generated.py',
    name: info.name || slug,
    addedAt: info.addedAt || null,
  };
  saveRegistry(registryPath, reg);
  return reg[slug];
}

// 번들(고정) + 동적(레지스트리)에서 스크립트명 해석. 번들 우선.
function resolveScriptName(slug, { bundled = {}, registryPath } = {}) {
  if (bundled && bundled[slug]) return bundled[slug];
  const reg = loadRegistry(registryPath);
  return (reg[slug] && reg[slug].script) || null;
}

// 번들 + 동적 슬러그 전체 목록(중복 제거).
function listReusableSlugs({ bundled = {}, registryPath } = {}) {
  const reg = loadRegistry(registryPath);
  return Array.from(new Set([...Object.keys(bundled || {}), ...Object.keys(reg)]));
}

module.exports = { loadRegistry, saveRegistry, registerSkill, resolveScriptName, listReusableSlugs };
