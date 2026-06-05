const fs = require('fs');
const path = require('path');

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
  if (!stats.has(key)) {
    stats.set(key, {
      name: cleanCompanyDisplayName(company.name),
      folderName: cleanHierarchyPart(company.folderName || company.name),
      count: 0,
      folderCount: 0,
    });
  }
  const stat = stats.get(key);
  stat.count += Number(count || 0);
  if (!stat.folderName && company.folderName) stat.folderName = cleanHierarchyPart(company.folderName);
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

function buildWorkflowOptions({ designIndex = [], designRoot = '', skipDirs = null, companyLimit = 1000, projectLimit = 500 } = {}) {
  const companyStats = new Map();
  const projectStats = new Map();
  const currentYear = String(new Date().getFullYear());
  addFolderOptions(companyStats, projectStats, designRoot, skipDirs);
  addIndexOptions(companyStats, projectStats, designIndex, skipDirs);

  const companies = Array.from(companyStats.values())
    .map(company => {
      const projects = projectStats.get(normalizeKey(company.name)) || new Map();
      return { ...company, projectCount: projects.size };
    })
    .sort((a, b) => b.count - a.count || b.projectCount - a.projectCount || a.name.localeCompare(b.name, 'ko'))
    .slice(0, companyLimit);

  const projectsByCompany = {};
  const projectLookup = {};
  for (const company of companies) {
    const key = normalizeKey(company.name);
    const projects = Array.from((projectStats.get(key) || new Map()).values())
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

function yearFolderForCompany(companyDir, year) {
  const entries = readDirs(companyDir);
  const candidates = [`${year} 시안작업`, `${year}년 시안작업`, `${year}`];
  for (const candidate of candidates) {
    const found = entries.find(name => normalizeKey(name) === normalizeKey(candidate));
    if (found) return found;
  }
  if (entries.some(name => /^20\d{2}년\s*시안\s*작업$/i.test(cleanHierarchyPart(name)))) {
    return `${year}년 시안작업`;
  }
  return `${year} 시안작업`;
}

function resolveWorkflowStorage({ designRoot = '', designIndex = [], skipDirs = null, companyName = '', projectName = '', year = '', create = true } = {}) {
  const root = path.resolve(designRoot || 'D:\\');
  const companyRaw = cleanCompanyDisplayName(companyName);
  const projectRaw = cleanProjectDisplayName(projectName);
  if (!companyRaw) throw new Error('companyName required');
  if (!projectRaw) throw new Error('projectName required');

  const options = buildWorkflowOptions({ designIndex, designRoot: root, skipDirs });
  const existingCompany = findCompanyForStorage(options, companyRaw);
  const companyFolderName = existingCompany?.folderName || safePathPart(companyRaw, 'company');
  const companyDir = path.resolve(root, companyFolderName);
  const storageYear = safeYear(year);
  const yearFolderName = yearFolderForCompany(companyDir, storageYear);
  const projectFolderName = safePathPart(projectRaw, 'project');
  const dir = path.resolve(companyDir, yearFolderName, projectFolderName);

  if (!isPathInside(root, dir)) {
    throw new Error('invalid workflow storage path');
  }
  const existedBefore = fs.existsSync(dir);
  if (create) fs.mkdirSync(dir, { recursive: true });
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
