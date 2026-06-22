const fs = require('fs');
const path = require('path');
const { loadRules } = require('./workflow-storage-rules');

const LEADING_MARKS_RE = /^[\u2605\u2606\u25cf\u25cb\u25a0\u25a1\s]+/u;

function cleanHierarchyPart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function cleanCompanyDisplayName(value) {
  return cleanHierarchyPart(value).replace(LEADING_MARKS_RE, '').trim();
}

function cleanProjectDisplayName(value) {
  return cleanHierarchyPart(value).replace(LEADING_MARKS_RE, '').trim();
}

function normalizeKey(value) {
  return cleanCompanyDisplayName(value)
    .toLowerCase()
    .replace(/[\u2605\u2606\u25cf\u25cb\u25a0\u25a1]/gu, '')
    .replace(/[\s._\-()（）\[\]{}]/g, '');
}

// 폴더 재사용용 부분일치 — 정확일치는 별도로 우선 처리. '짧은 쪽이 4자 미만이면 부분일치 금지'로
// "포스코"(3자) 같은 짧은 폴더가 다른 현장(성수장미 등)을 통째로 빨아들이는 collapse 버그 방지.
function looseKeyIncludes(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return a.includes(b) || b.includes(a);
}

// 같은 회사(같은 normalizeKey)에 폴더가 여러 개일 때(★★★포스코이앤씨 vs 포스코이앤씨) 정식본 선택용.
// 점수가 낮을수록 우선: 선두 마크(★☆●○■□) 있는 폴더 우선, 동률이면 더 완전(긴) 이름 우선.
// → 중복이 이미 있어도 readdir 순서와 무관하게 항상 ★폴더가 canonical 로 뽑혀 저장이 ★로 수렴(비결정성 제거).
function companyFolderRank(folderName) {
  const s = String(folderName || '').replace(/^\s+/, '');
  let r = 0;
  if (/^[★☆●○■□]/u.test(s)) r -= 100;
  r -= cleanHierarchyPart(folderName).length * 0.01;
  return r;
}

function safePathPart(value, fallback = 'item') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function safeYear(value) {
  const s = String(value || '').trim();
  return /^20\d{2}$/.test(s) ? s : String(new Date().getFullYear());
}

function isPathInside(rootPath, targetPath) {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function isYearHierarchyPart(value) {
  const s = cleanHierarchyPart(value);
  const compact = s.replace(/\s+/g, '');
  const yearText = '\uB144';
  const designWorkText = '\uC2DC\uC548\uC791\uC5C5';
  if (/^20\d{2}$/.test(compact) || /^\d{2}$/.test(compact)) return true;
  if (/^(20\d{2}|\d{2})/.test(compact) && (compact.includes(yearText) || compact.includes(designWorkText))) return true;
  return /^20\d{2}(\s*년)?(\s*시안\s*작업)?$/i.test(s)
    || /^\d{2}\s*년(\s*시안\s*작업)?$/i.test(s)
    || /^\d{2}\s*시안\s*작업$/i.test(s);
}

const NOISE_KEYS = new Set([
  'backup', 'data', 'temp', 'tmp', 'thumbs', 'images', 'image', 'ai', 'pdf', 'jpg', 'png',
  'pricelistapp', 'priceapplist', 'node_modules', 'sessions', 'claude',
  '견적서', '관리팀', '각종시안자료', '본사제작품', '기타', '새폴더', '설치사진',
  '대구부산시안참고사진', '김다한자료', '대표님', '박과장', '보건실',
].map(normalizeKey));

const PROJECT_NOISE_KEYWORDS = [
  '견적', '기존참고', '기존자료', '참고자료', '설치사진', '비교견적', 'logo', '로고',
  '표준안전디자인가이드라인',
].map(normalizeKey);

function lowerName(value) {
  return cleanHierarchyPart(value).toLowerCase();
}

function isSkipFolderName(value, skipDirs) {
  const s = cleanHierarchyPart(value);
  if (!s) return true;
  const lower = s.toLowerCase();
  if (s.startsWith('.') || s.startsWith('$')) return true;
  if (skipDirs && typeof skipDirs.has === 'function' && skipDirs.has(lower)) return true;
  if (NOISE_KEYS.has(normalizeKey(s))) return true;
  return false;
}

function looksLikeFileName(value) {
  return /\.[a-z0-9]{1,8}$/i.test(cleanHierarchyPart(value));
}

function isWorkflowCompanyName(value, skipDirs) {
  const s = cleanCompanyDisplayName(value);
  if (!s || s.length < 2 || s.length > 100) return false;
  if (isSkipFolderName(s, skipDirs)) return false;
  if (isYearHierarchyPart(s)) return false;
  if (/^\d+$/.test(s)) return false;
  if (looksLikeFileName(s)) return false;
  return true;
}

function isWorkflowProjectName(value) {
  const s = cleanProjectDisplayName(value);
  const key = normalizeKey(s);
  if (!s || s.length < 2 || s.length > 140) return false;
  if (isYearHierarchyPart(s)) return false;
  if (NOISE_KEYS.has(key)) return false;
  if (looksLikeFileName(s)) return false;
  if (PROJECT_NOISE_KEYWORDS.some(noise => key.includes(noise))) return false;
  return true;
}

function readDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (_) {
    return [];
  }
}

function companyFromParts(parts, skipDirs) {
  const clean = (parts || []).map(cleanHierarchyPart).filter(Boolean);
  if (!clean.length) return null;
  const companyIdx = isYearHierarchyPart(clean[0]) && clean[1] ? 1 : 0;
  const folderName = clean[companyIdx];
  const name = cleanCompanyDisplayName(folderName);
  if (!isWorkflowCompanyName(name, skipDirs)) return null;
  return { name, folderName };
}

function projectFromParts(parts, skipDirs) {
  const clean = (parts || []).map(cleanHierarchyPart).filter(Boolean);
  if (clean.length < 3) return null;
  const company = companyFromParts(clean, skipDirs);
  if (!company) return null;
  const companyIdx = isYearHierarchyPart(clean[0]) && clean[1] ? 1 : 0;
  const lastDirIdx = clean.length - 2;
  if (lastDirIdx <= companyIdx) return null;

  const dirs = clean.slice(companyIdx + 1, lastDirIdx + 1);
  let yearFolder = '';
  let startIdx = 0;
  const yearIdx = dirs.findIndex(isYearHierarchyPart);
  if (yearIdx >= 0) {
    yearFolder = dirs[yearIdx];
    startIdx = yearIdx + 1;
  }

  const afterYear = dirs.slice(startIdx).map(cleanProjectDisplayName).filter(isWorkflowProjectName);
  const beforeYear = dirs.slice(0, startIdx).map(cleanProjectDisplayName).filter(isWorkflowProjectName);
  const project = afterYear[0] || beforeYear[0] || '';
  if (!project) return null;
  return { ...company, project, projectFolderName: project, yearFolder };
}

function ensureCompany(stats, company, count = 0) {
  const key = normalizeKey(company.name);
  if (!key) return null;
  const aliases = Array.isArray(company.companyAliases)
    ? company.companyAliases.map(cleanCompanyDisplayName).filter(Boolean)
    : [];
  if (!stats.has(key)) {
    stats.set(key, {
      name: cleanCompanyDisplayName(company.name),
      folderName: cleanHierarchyPart(company.folderName || company.name),
      companyAliases: aliases,
      count: 0,
      folderCount: 0,
    });
  }
  const stat = stats.get(key);
  stat.count += Number(count || 0);
  // 정식본(★) 우선: 더 좋은 표기의 폴더가 들어오면 교체(first-wins 비결정성 제거 → ★폴더로 수렴)
  if (company.folderName) {
    const cand = cleanHierarchyPart(company.folderName);
    if (cand && (!stat.folderName || companyFolderRank(cand) < companyFolderRank(stat.folderName))) stat.folderName = cand;
  }
  if (aliases.length) {
    const seen = new Set((stat.companyAliases || []).map(normalizeKey).filter(Boolean));
    for (const alias of aliases) {
      const aliasKey = normalizeKey(alias);
      if (aliasKey && !seen.has(aliasKey)) {
        seen.add(aliasKey);
        stat.companyAliases.push(alias);
      }
    }
  }
  return stat;
}

function ensureProject(projectStats, company, project, count = 0, yearFolder = '') {
  if (!company || !isWorkflowProjectName(project.name || project)) return;
  const companyKey = normalizeKey(company.name);
  const projectName = cleanProjectDisplayName(project.name || project);
  const projectKey = normalizeKey(projectName);
  if (!companyKey || !projectKey) return;
  if (!projectStats.has(companyKey)) projectStats.set(companyKey, new Map());
  const projects = projectStats.get(companyKey);
  if (!projects.has(projectKey)) {
    projects.set(projectKey, {
      name: projectName,
      folderName: cleanHierarchyPart(project.folderName || projectName),
      yearFolder: cleanHierarchyPart(project.yearFolder || yearFolder || ''),
      count: 0,
      folderCount: 0,
    });
  }
  const stat = projects.get(projectKey);
  stat.count += Number(count || 0);
  const nextYearFolder = cleanHierarchyPart(project.yearFolder || yearFolder);
  if (nextYearFolder && yearFolderRank(nextYearFolder) < yearFolderRank(stat.yearFolder)) {
    stat.yearFolder = nextYearFolder;
  }
}

function yearFolderRank(value) {
  const s = cleanHierarchyPart(value);
  if (!s) return 3;
  const currentYear = String(new Date().getFullYear());
  if (s.startsWith(currentYear)) return 0;
  if (/^20\d{2}/.test(s)) return 1;
  return 2;
}

function renderStorageTemplate(template, vars = {}) {
  return cleanHierarchyPart(String(template || '')
    .replace(/\{year\}/g, vars.year || '')
    .replace(/\{company\}/g, vars.company || '')
    .replace(/\{project\}/g, vars.project || ''));
}

function findStorageRule(companyName) {
  const key = normalizeKey(companyName);
  if (!key) return null;
  return loadRules().find(rule => {
    const values = [
      rule.companyName,
      rule.companyFolder,
      ...(Array.isArray(rule.companyAliases) ? rule.companyAliases : []),
    ];
    return values.some(value => {
      const ruleKey = normalizeKey(value);
      return ruleKey && (ruleKey === key || ruleKey.includes(key) || key.includes(ruleKey));
    });
  }) || null;
}

function addFolderOptions(companyStats, projectStats, designRoot, skipDirs) {
  if (!designRoot || !fs.existsSync(designRoot)) return;
  for (const folderName of readDirs(designRoot)) {
    if (isSkipFolderName(folderName, skipDirs)) continue;
    const company = {
      name: cleanCompanyDisplayName(folderName),
      folderName,
    };
    if (!isWorkflowCompanyName(company.name, skipDirs)) continue;
    const companyStat = ensureCompany(companyStats, company, 0);
    if (!companyStat) continue;
    companyStat.folderCount += 1;

    const companyDir = path.join(designRoot, folderName);
    for (const child of readDirs(companyDir)) {
      if (isSkipFolderName(child, skipDirs)) continue;
      const childDir = path.join(companyDir, child);
      if (isYearHierarchyPart(child)) {
        for (const grand of readDirs(childDir)) {
          if (isWorkflowProjectName(grand)) {
            ensureProject(projectStats, companyStat, { name: grand, folderName: grand, yearFolder: child }, 0, child);
          }
        }
      } else if (isWorkflowProjectName(child)) {
        ensureProject(projectStats, companyStat, { name: child, folderName: child }, 0, '');
      }
    }
  }
}

function addIndexOptions(companyStats, projectStats, designIndex, skipDirs) {
  for (const item of designIndex || []) {
    const company = companyFromParts(item.parts || [], skipDirs);
    if (!company) continue;
    const companyStat = ensureCompany(companyStats, company, 1);
    const project = projectFromParts(item.parts || [], skipDirs);
    if (companyStat && project) {
      ensureProject(projectStats, companyStat, {
        name: project.project,
        folderName: project.projectFolderName || project.project,
        yearFolder: project.yearFolder || '',
      }, 1, project.yearFolder || '');
    }
  }
}

function addStorageRuleOptions(companyStats) {
  let rules = [];
  try {
    rules = loadRules();
  } catch (_) {
    rules = [];
  }
  for (const rule of rules || []) {
    const company = {
      name: rule.companyName,
      folderName: rule.companyFolder || rule.companyName,
      companyAliases: rule.companyAliases || [],
    };
    const stat = ensureCompany(companyStats, company, 0);
    if (stat) stat.storageRule = true;
  }
}

function buildWorkflowOptions({ designIndex = [], designRoot = '', skipDirs = null, companyLimit = 5000, projectLimit = 1000, includeIndex = true } = {}) {
  const companyStats = new Map();
  const projectStats = new Map();
  const currentYear = String(new Date().getFullYear());
  addFolderOptions(companyStats, projectStats, designRoot, skipDirs);
  if (includeIndex) addIndexOptions(companyStats, projectStats, designIndex, skipDirs);
  addStorageRuleOptions(companyStats);

  // noProject 회사(디자인포트 등)는 디스크 폴더가 '프로젝트'로 인식되지 않게 — projectCount 0 + 아래 루프에서 projects 비움.
  const noProjectKeys = new Set();
  try {
    for (const rule of (loadRules() || [])) {
      if (!rule || !rule.noProject) continue;
      for (const n of [rule.companyName, rule.companyFolder, ...(rule.companyAliases || [])]) {
        const k = normalizeKey(n);
        if (k) noProjectKeys.add(k);
      }
    }
  } catch (_) {}

  const companies = Array.from(companyStats.values())
    .map(company => {
      const k = normalizeKey(company.name);
      const isNoProject = noProjectKeys.has(k) || (!!company.folderName && noProjectKeys.has(normalizeKey(company.folderName)));
      const projects = projectStats.get(k) || new Map();
      return { ...company, projectCount: isNoProject ? 0 : projects.size, noProject: isNoProject };
    })
    .sort((a, b) => b.count - a.count || b.projectCount - a.projectCount || a.name.localeCompare(b.name, 'ko'))
    .slice(0, companyLimit);

  const projectsByCompany = {};
  const projectLookup = {};
  for (const company of companies) {
    const key = normalizeKey(company.name);
    const projects = company.noProject ? [] : Array.from((projectStats.get(key) || new Map()).values())
      .sort((a, b) => {
        const ay = String(a.yearFolder || '').startsWith(currentYear) ? 0 : (a.yearFolder ? 1 : 2);
        const by = String(b.yearFolder || '').startsWith(currentYear) ? 0 : (b.yearFolder ? 1 : 2);
        if (ay !== by) return ay - by;
        return b.count - a.count || a.name.localeCompare(b.name, 'ko');
      })
      .slice(0, projectLimit);
    projectsByCompany[company.name] = projects;
    if (company.folderName && company.folderName !== company.name) projectsByCompany[company.folderName] = projects;
    projectLookup[key] = projects;
    if (company.folderName) projectLookup[normalizeKey(company.folderName)] = projects;
    for (const alias of company.companyAliases || []) {
      const aliasKey = normalizeKey(alias);
      if (aliasKey) projectLookup[aliasKey] = projects;
    }
  }

  return {
    companies,
    projectsByCompany,
    projectLookup,
    totals: {
      indexed: Array.isArray(designIndex) ? designIndex.length : 0,
      companies: companies.length,
      projects: Array.from(projectStats.values()).reduce((sum, projects) => sum + projects.size, 0),
    },
  };
}

function findCompanyForStorage(options, companyName) {
  const key = normalizeKey(companyName);
  if (!key) return null;
  return (options.companies || []).find(c => normalizeKey(c.name) === key || normalizeKey(c.folderName) === key)
    || (options.companies || []).find(c => {
      const nameKey = normalizeKey(c.name);
      const folderKey = normalizeKey(c.folderName);
      return (nameKey && (nameKey.includes(key) || key.includes(nameKey)))
        || (folderKey && (folderKey.includes(key) || key.includes(folderKey)));
    })
    || null;
}

function yearFolderForCompany(companyDir, year, preferredFolderName = '') {
  const entries = readDirs(companyDir);
  const preferredCandidates = [
    preferredFolderName,
    `${year} \uC2DC\uC548\uC791\uC5C5`,
    `${year}\uC2DC\uC548\uC791\uC5C5`,
    `${year}\uB144 \uC2DC\uC548\uC791\uC5C5`,
    `${year}\uB144\uC2DC\uC548\uC791\uC5C5`,
    `${year}`,
  ].filter(Boolean);
  for (const candidate of preferredCandidates) {
    const found = entries.find(name => normalizeKey(name) === normalizeKey(candidate));
    if (found) return found;
  }
  const existingYearFolder = entries.find(name => isYearHierarchyPart(name) && String(cleanHierarchyPart(name)).startsWith(year));
  if (existingYearFolder) {
    return existingYearFolder;
  }
  return preferredFolderName || `${year} \uC2DC\uC548\uC791\uC5C5`;
}

function findProjectForStorage(options, company, projectName) {
  const key = normalizeKey(projectName);
  if (!key) return null;
  const companyKeys = [company?.name, company?.folderName]
    .map(normalizeKey)
    .filter(Boolean);
  const projects = [];
  const seen = new Set();
  for (const companyKey of companyKeys) {
    for (const project of options.projectLookup?.[companyKey] || []) {
      const projectKey = normalizeKey(project.name || project.folderName);
      if (!projectKey || seen.has(projectKey)) continue;
      seen.add(projectKey);
      projects.push(project);
    }
  }
  return projects.find(project => normalizeKey(project.name) === key || normalizeKey(project.folderName) === key)
    || projects.find(project => looseKeyIncludes(normalizeKey(project.name), key) || looseKeyIncludes(normalizeKey(project.folderName), key))
    || null;
}

function projectFolderForYear(yearDir, projectName, preferredFolderName) {
  const key = normalizeKey(projectName);
  const preferredKey = normalizeKey(preferredFolderName);
  const entries = readDirs(yearDir);
  const found = entries.find(name => normalizeKey(name) === key)
    || entries.find(name => preferredKey && normalizeKey(name) === preferredKey)
    || entries.find(name => {
      const folderKey = normalizeKey(name);
      return looseKeyIncludes(folderKey, key) || looseKeyIncludes(folderKey, preferredKey);
    });
  return found || preferredFolderName;
}

function resolveWorkflowStorage({ designRoot = '', designIndex = [], skipDirs = null, companyName = '', projectName = '', year = '', create = true, dryRun = false, storageHint = null } = {}) {
  const root = path.resolve(designRoot || 'D:\\');
  const companyRaw = cleanCompanyDisplayName(companyName);
  const projectRaw = cleanProjectDisplayName(projectName);
  if (!companyRaw) throw new Error('companyName required');
  // 현장명(프로젝트)이 없는 업체(예: 삼성라코스)는 회사\연도 까지만 정리 — 현장명 하위폴더 없이 연도 폴더에 바로 저장.
  const hasProject = !!projectRaw;

  // 추천(저장힌트)이 가리킨 '기존' 폴더(★포함)를 그대로 사용 — 단, 회사/현장이 힌트와 같을 때만(사용자가 바꿨으면 무시).
  // 글자 기반 재해석(퍼지매칭·마크없는 새폴더 생성)을 우회해 '추천=저장'을 일치시킨다. (★ 보존: cleanHierarchyPart는 마크 안 지움)
  const hintCompanyFolder = storageHint && storageHint.companyFolder ? cleanHierarchyPart(storageHint.companyFolder) : '';
  const hintProjectFolder = storageHint && storageHint.projectFolder ? cleanHierarchyPart(storageHint.projectFolder) : '';
  const useHintCompany = !!hintCompanyFolder && normalizeKey(hintCompanyFolder) === normalizeKey(companyRaw);
  const useHintProject = hasProject && !!hintProjectFolder && normalizeKey(hintProjectFolder) === normalizeKey(projectRaw);

  const options = buildWorkflowOptions({ designIndex, designRoot: root, skipDirs, includeIndex: false });
  const existingCompany = findCompanyForStorage(options, companyRaw);
  const storageRule = findStorageRule(companyRaw);
  const noProject = !!(storageRule && storageRule.noProject); // 이 회사는 현장(프로젝트) 안 씀 → 회사\연도 까지만 저장(디자인포트 등)
  const companyFolderName = storageRule?.companyFolder || (useHintCompany ? hintCompanyFolder : '') || existingCompany?.folderName || safePathPart(companyRaw, 'company');
  const companyDir = path.resolve(root, companyFolderName);
  if (!create && !dryRun && !fs.existsSync(companyDir)) return null;
  const storageYear = safeYear(year);
  const existingProject = hasProject
    ? findProjectForStorage(options, existingCompany || { name: companyRaw, folderName: companyFolderName }, projectRaw)
    : null;
  const ruleYearFolderName = storageRule
    ? renderStorageTemplate(storageRule.yearFolderTemplate, { year: storageYear, company: companyRaw, project: projectRaw })
    : '';
  const existingYearFolderName = existingProject?.yearFolder && String(cleanHierarchyPart(existingProject.yearFolder)).startsWith(storageYear)
    ? cleanHierarchyPart(existingProject.yearFolder)
    : '';
  const existingYearDir = existingYearFolderName ? path.resolve(companyDir, existingYearFolderName) : '';
  const yearFolderName = storageRule || !existingYearDir || !fs.existsSync(existingYearDir)
    ? yearFolderForCompany(companyDir, storageYear, ruleYearFolderName)
    : existingYearFolderName;
  let projectFolderName = '';
  let dir;
  if (hasProject && !noProject) {
    const ruleProjectFolderName = storageRule
      ? renderStorageTemplate(storageRule.projectFolderTemplate || '{project}', { year: storageYear, company: companyRaw, project: projectRaw })
      : '';
    projectFolderName = (useHintProject ? hintProjectFolder : '') || projectFolderForYear(
      path.resolve(companyDir, yearFolderName),
      projectRaw,
      ruleProjectFolderName || existingProject?.folderName || safePathPart(projectRaw, 'project'),
    );
    dir = path.resolve(companyDir, yearFolderName, projectFolderName);
  } else {
    // 현장명 없음 → 회사\연도 폴더에 바로 저장(현장 하위폴더 생성 안 함)
    dir = path.resolve(companyDir, yearFolderName);
  }

  if (!isPathInside(root, dir)) {
    throw new Error('invalid workflow storage path');
  }
  const existedBefore = fs.existsSync(dir);
  if (!create && !dryRun && !existedBefore) return null;
  if (create && !dryRun) fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    rel: path.relative(root, dir),
    root,
    companyName: companyRaw,
    projectName: projectRaw,
    companyFolderName,
    yearFolderName,
    projectFolderName,
    year: storageYear,
    existedBefore,
    created: create && !existedBefore,
    dryRun: !!dryRun,
  };
}

module.exports = {
  buildWorkflowOptions,
  cleanCompanyDisplayName,
  cleanHierarchyPart,
  cleanProjectDisplayName,
  isYearHierarchyPart,
  normalizeKey,
  resolveWorkflowStorage,
  safePathPart,
  safeYear,
  isPathInside,
};
