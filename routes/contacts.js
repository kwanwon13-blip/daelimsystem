/**
 * routes/contacts.js — 전화번호부 (업체 → 프로젝트 → 연락처)
 * Mounted at: app.use('/api/contacts', require('./routes/contacts'))
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { callClaudeCli } = require('../lib/claude-cli');

// ── 연락처 변경 상세 로그 (복구 가능하도록 변경 전 데이터 통째로 저장) ──
// 기존 감사로그(action+target 짧은 텍스트) 외에, 누가 무엇을 어떻게 바꿨는지
// 원본 객체까지 보존. 직원이 실수로 지운 거 사장님이 복구할 수 있게.
const CONTACT_AUDIT_PATH = path.join(__dirname, '..', 'data', '연락처변경기록.json');
function logContactChange(userId, action, target, before, after) {
  try {
    let logs = [];
    if (fs.existsSync(CONTACT_AUDIT_PATH)) {
      try { logs = JSON.parse(fs.readFileSync(CONTACT_AUDIT_PATH, 'utf8')); } catch(e) { logs = []; }
    }
    logs.push({
      ts: new Date().toISOString(),
      userId: userId || 'unknown',
      action,
      type: target.type,
      id: target.id,
      name: target.name,
      before,
      after,
    });
    const cutoff = Date.now() - 365 * 24 * 60 * 60 * 1000;
    logs = logs.filter(l => new Date(l.ts).getTime() > cutoff);
    const dataDir = path.dirname(CONTACT_AUDIT_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(CONTACT_AUDIT_PATH, JSON.stringify(logs, null, 2), 'utf8');
  } catch (e) {
    console.error('[contact-audit]', e.message);
  }
  try {
    auditLog(userId || 'unknown', `거래처 ${action === 'CREATE' ? '추가' : action === 'UPDATE' ? '수정' : '삭제'}`,
             `${target.type === 'company' ? '회사' : target.type === 'project' ? '현장' : '담당자'}: ${target.name || target.id}`);
  } catch(e) {}
}

// ── 전화번호부 (3단계: 업체 → 프로젝트 → 연락처) ──────
// ══════════════════════════════════════════════════════════

// 마이그레이션: 서버 시작 시 한 번 실행
// flat contact 데이터(company, note 문자열)를 3단 구조(contactCompanies, contactProjects)로 변환
function migrateContactsData() {
  const data = db.load();
  const contacts = data.contacts || [];

  // contactCompanies가 이미 있고 내용이 있으면 skip
  if (data.contactCompanies && data.contactCompanies.length > 0) {
    return;
  }

  // 1) 기존 contactSites -> contactProjects 변환 (레거시)
  if (data.contactSites && Array.isArray(data.contactSites)) {
    const defaultCompany = {
      id: 'comp_' + Date.now(),
      name: '기본 업체',
      note: '',
      createdAt: new Date().toISOString()
    };
    data.contactCompanies = [defaultCompany];
    data.contactProjects = data.contactSites.map(site => ({
      id: site.id,
      companyId: defaultCompany.id,
      name: site.name,
      address: site.address || '',
      note: site.note || '',
      createdAt: site.createdAt || new Date().toISOString(),
      customFields: site.customFields || []
    }));
    contacts.forEach(c => {
      if (c.siteId && !c.projectId) c.projectId = c.siteId;
    });
    db.save(data);
    return;
  }

  // 2) flat contact 데이터에서 company/note 기반 자동 마이그레이션
  console.log('[migrate] flat contacts → 3단 구조 시작');
  const companyMap = {}; // companyName → company obj
  const projectMap = {}; // companyId + projectName → project obj

  if (!data.contactCompanies) data.contactCompanies = [];
  if (!data.contactProjects) data.contactProjects = [];

  contacts.forEach(c => {
    const compName = (c.company || '').trim();
    if (!compName) return;

    // 업체 생성
    if (!companyMap[compName]) {
      const comp = {
        id: 'comp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: compName,
        note: '',
        createdAt: new Date().toISOString()
      };
      companyMap[compName] = comp;
      data.contactCompanies.push(comp);
    }
    const comp = companyMap[compName];
    c.companyId = comp.id;

    // 현장(note) 생성
    const siteName = (c.note || '').trim();
    if (siteName) {
      const pKey = comp.id + '::' + siteName;
      if (!projectMap[pKey]) {
        const proj = {
          id: 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          companyId: comp.id,
          name: siteName,
          address: '',
          note: '',
          createdAt: new Date().toISOString(),
          customFields: []
        };
        projectMap[pKey] = proj;
        data.contactProjects.push(proj);
      }
      c.projectId = projectMap[comp.id + '::' + siteName].id;
    }
  });

  db.save(data);
  console.log('[migrate] 완료: 업체 ' + data.contactCompanies.length + '개, 현장 ' + data.contactProjects.length + '개');
}

// 업체 API
router.get('/companies', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const companies = data.contactCompanies || [];
  const projects = data.contactProjects || [];

  // 각 업체의 프로젝트 수 포함
  const result = companies.map(comp => ({
    ...comp,
    projectCount: projects.filter(p => p.companyId === comp.id).length
  }));

  res.json(result);
});

router.post('/companies', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contactCompanies) data.contactCompanies = [];

  const company = {
    id: 'comp_' + Date.now(),
    name: req.body.name || '',
    note: req.body.note || '',
    kind: req.body.kind === 'internal' ? 'internal' : 'vendor',  // 'vendor'(매입처) | 'internal'(사내) — 기본 매입처
    address: (req.body.address || '').trim(),                     // 업체 주 주소(사무실/창고)
    createdAt: new Date().toISOString()
  };

  data.contactCompanies.push(company);
  db.saveContacts(data);
  logContactChange(req.user?.userId, 'CREATE', { type:'company', id:company.id, name:company.name }, null, company);
  res.json(company);
});

router.put('/companies/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const company = (data.contactCompanies || []).find(c => c.id === req.params.id);
  if (!company) return res.status(404).json({ error: '업체 없음' });

  const before = { ...company };
  if (req.body.name !== undefined) company.name = req.body.name;
  if (req.body.note !== undefined) company.note = req.body.note;
  if (req.body.order !== undefined) company.order = req.body.order;
  if (req.body.kind !== undefined) company.kind = (req.body.kind === 'internal' ? 'internal' : 'vendor');
  if (req.body.address !== undefined) company.address = String(req.body.address).trim();

  db.saveContacts(data);
  logContactChange(req.user?.userId, 'UPDATE', { type:'company', id:company.id, name:company.name }, before, { ...company });
  res.json(company);
});

router.delete('/companies/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  // 삭제 전 데이터 보존 (복구용)
  const beforeCompany = (data.contactCompanies || []).find(c => c.id === req.params.id);
  if (!beforeCompany) return res.status(404).json({ error: '업체 없음' });
  const beforeProjects = (data.contactProjects || []).filter(p => p.companyId === req.params.id);
  const projectIds = beforeProjects.map(p => p.id);
  const beforeContacts = (data.contacts || []).filter(c => projectIds.includes(c.projectId));

  data.contactProjects = (data.contactProjects || []).filter(p => p.companyId !== req.params.id);
  data.contacts = (data.contacts || []).filter(c => !projectIds.includes(c.projectId));
  data.contactCompanies = (data.contactCompanies || []).filter(c => c.id !== req.params.id);

  db.saveContacts(data);
  logContactChange(req.user?.userId, 'DELETE', { type:'company', id:beforeCompany.id, name:beforeCompany.name },
                   { company: beforeCompany, projects: beforeProjects, contacts: beforeContacts }, null);
  res.json({ ok: true });
});

// 프로젝트 API
router.get('/projects', requireAuth, (req, res) => {
  const data = db.loadContacts();
  let projects = data.contactProjects || [];

  if (req.query.companyId) {
    projects = projects.filter(p => p.companyId === req.query.companyId);
  }

  // 각 프로젝트의 연락처 수 포함
  const contacts = data.contacts || [];
  const result = projects.map(proj => ({
    ...proj,
    contactCount: contacts.filter(c => c.projectId === proj.id).length
  }));

  res.json(result);
});

router.post('/projects', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contactProjects) data.contactProjects = [];

  const project = {
    id: 'proj_' + Date.now(),
    companyId: req.body.companyId || '',
    name: req.body.name || '',
    address: req.body.address || '',
    note: req.body.note || '',
    createdAt: new Date().toISOString(),
    customFields: []
  };

  data.contactProjects.push(project);
  db.saveContacts(data);
  logContactChange(req.user?.userId, 'CREATE', { type:'project', id:project.id, name:project.name }, null, project);
  res.json(project);
});

router.put('/projects/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  const before = { ...project };
  if (req.body.name !== undefined) project.name = req.body.name;
  if (req.body.address !== undefined) project.address = req.body.address;
  if (req.body.note !== undefined) project.note = req.body.note;
  if (req.body.order !== undefined) project.order = req.body.order;
  if (req.body.companyId !== undefined) project.companyId = req.body.companyId;
  if (req.body.active !== undefined) project.active = !!req.body.active;  // false = 끝남(준공) — 모바일 길찾기 후보에서 제외

  db.saveContacts(data);
  logContactChange(req.user?.userId, 'UPDATE', { type:'project', id:project.id, name:project.name }, before, { ...project });
  res.json(project);
});

router.delete('/projects/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  // 삭제 전 데이터 보존 (복구용)
  const beforeProject = (data.contactProjects || []).find(p => p.id === req.params.id);
  if (!beforeProject) return res.status(404).json({ error: '프로젝트 없음' });
  const beforeContacts = (data.contacts || []).filter(c => c.projectId === req.params.id);

  data.contacts = (data.contacts || []).filter(c => c.projectId !== req.params.id);
  data.contactProjects = (data.contactProjects || []).filter(p => p.id !== req.params.id);

  db.saveContacts(data);
  logContactChange(req.user?.userId, 'DELETE', { type:'project', id:beforeProject.id, name:beforeProject.name },
                   { project: beforeProject, contacts: beforeContacts }, null);
  res.json({ ok: true });
});

// 전체 연락처 조회 (플랫 구조, 검색+업체필터)
router.get('/all', requireAuth, (req, res) => {
  const data = db.loadContacts();
  let contacts = data.contacts || [];

  // 업체 필터
  if (req.query.company) {
    const comp = req.query.company;
    contacts = contacts.filter(c => (c.company || '') === comp);
  }

  // 검색 (현장명 note 포함)
  if (req.query.q) {
    const kw = req.query.q.toLowerCase();
    contacts = contacts.filter(c =>
      (c.name || '').toLowerCase().includes(kw) ||
      (c.company || '').toLowerCase().includes(kw) ||
      (c.position || '').toLowerCase().includes(kw) ||
      (c.phone || '').includes(kw) ||
      (c.mobile || '').includes(kw) ||
      (c.email || '').toLowerCase().includes(kw) ||
      (c.note || '').toLowerCase().includes(kw)
    );
  }

  // 최신순 정렬
  contacts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json(contacts);
});

// 3단 구조 전체 조회 (업체 > 현장 > 연락처) - 트리형태
router.get('/tree', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const companies = data.contactCompanies || [];
  const projects = data.contactProjects || [];
  let contacts = data.contacts || [];

  // 검색 필터
  const q = (req.query.q || '').trim().toLowerCase();

  // 업체별 프로젝트 맵
  const projByCompany = {};
  projects.forEach(p => {
    if (!projByCompany[p.companyId]) projByCompany[p.companyId] = [];
    projByCompany[p.companyId].push(p);
  });

  // 프로젝트별 연락처 맵
  const contactByProject = {};
  const contactNoProject = {}; // companyId 있지만 projectId 없는 연락처
  const contactOrphan = []; // companyId도 없는 연락처

  contacts.forEach(c => {
    if (q) {
      const match =
        (c.name || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q) ||
        (c.position || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.mobile || '').includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.note || '').toLowerCase().includes(q);
      if (!match) return;
    }

    if (c.projectId) {
      if (!contactByProject[c.projectId]) contactByProject[c.projectId] = [];
      contactByProject[c.projectId].push(c);
    } else if (c.companyId) {
      if (!contactNoProject[c.companyId]) contactNoProject[c.companyId] = [];
      contactNoProject[c.companyId].push(c);
    } else if (c.company) {
      // companyId 없지만 company 문자열 있는 경우 — 매칭 시도
      const matched = companies.find(comp => comp.name === c.company);
      if (matched) {
        if (!contactNoProject[matched.id]) contactNoProject[matched.id] = [];
        contactNoProject[matched.id].push(c);
      } else {
        contactOrphan.push(c);
      }
    } else {
      contactOrphan.push(c);
    }
  });

  // 검색 시 현장명도 매치
  if (q) {
    projects.forEach(p => {
      if ((p.name || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)) {
        // 이 현장에 속한 모든 연락처 포함
        const allInProj = contacts.filter(c => c.projectId === p.id);
        allInProj.forEach(c => {
          if (!contactByProject[p.id]) contactByProject[p.id] = [];
          if (!contactByProject[p.id].find(x => x.id === c.id)) {
            contactByProject[p.id].push(c);
          }
        });
      }
    });
  }

  // 트리 구성
  const tree = companies.map(comp => {
    const compProjects = (projByCompany[comp.id] || []).map(proj => ({
      ...proj,
      contacts: contactByProject[proj.id] || []
    }));
    // 검색 시 연락처/현장 없는 업체 제외
    const noProjectContacts = contactNoProject[comp.id] || [];
    const hasContent = compProjects.some(p => p.contacts.length > 0) || noProjectContacts.length > 0;
    if (q && !hasContent && !(comp.name || '').toLowerCase().includes(q)) return null;

    return {
      ...comp,
      projects: compProjects,
      directContacts: noProjectContacts // 현장 미배정 연락처
    };
  }).filter(Boolean);

  // 미분류 연락처
  if (contactOrphan.length > 0) {
    tree.push({
      id: '_orphan',
      name: '미분류',
      note: '',
      projects: [],
      directContacts: contactOrphan
    });
  }

  res.json(tree);
});

// 연락처 CRUD (projectId 기반, 하위 호환성: siteId도 지원)
router.get('/', requireAuth, (req, res) => {
  const data = db.loadContacts();
  let contacts = data.contacts || [];

  // projectId 또는 siteId로 필터링 (하위 호환성)
  if (req.query.projectId) {
    contacts = contacts.filter(c => c.projectId === req.query.projectId);
  } else if (req.query.siteId) {
    contacts = contacts.filter(c => c.projectId === req.query.siteId);
  }

  // 검색
  if (req.query.q) {
    const kw = req.query.q.toLowerCase();
    contacts = contacts.filter(c =>
      (c.name || '').toLowerCase().includes(kw) ||
      (c.company || '').toLowerCase().includes(kw) ||
      (c.position || '').toLowerCase().includes(kw) ||
      (c.phone || '').includes(kw) ||
      (c.mobile || '').includes(kw)
    );
  }

  res.json(contacts);
});

router.post('/', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contacts) data.contacts = [];

  // projectId 또는 siteId 받음 (하위 호환성)
  const projectId = req.body.projectId || req.body.siteId || '';

  const contact = {
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    projectId: projectId,
    siteId: projectId,  // 하위 호환성
    name: req.body.name || '',
    company: req.body.company || '',
    position: req.body.position || '',
    dept: req.body.dept || '',
    phone: req.body.phone || '',
    mobile: req.body.mobile || '',
    email: req.body.email || '',
    note: req.body.note || '',
    customFields: req.body.customFields || {},
    createdAt: new Date().toISOString(),
    createdBy: req.authUser?.userId || ''
  };

  data.contacts.push(contact);
  db.saveContacts(data);
  logContactChange(req.user?.userId, 'CREATE', { type:'contact', id:contact.id, name:contact.name }, null, contact);
  res.json(contact);
});

router.put('/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const c = (data.contacts || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '연락처 없음' });

  const before = { ...c };
  const updateFields = ['name','company','companyId','position','dept','phone','mobile','email','note','projectId','siteId','order'];
  for (const key of updateFields) {
    if (req.body[key] !== undefined) {
      c[key] = req.body[key];
      // projectId 변경 시 siteId도 동기화
      if (key === 'projectId') c.siteId = req.body[key];
      if (key === 'siteId') c.projectId = req.body[key];
    }
  }

  // 커스텀 필드
  if (req.body.customFields !== undefined) {
    c.customFields = req.body.customFields;
  }

  db.saveContacts(data);
  logContactChange(req.user?.userId, 'UPDATE', { type:'contact', id:c.id, name:c.name }, before, { ...c });
  res.json(c);
});

router.delete('/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const before = (data.contacts || []).find(c => c.id === req.params.id);
  if (!before) return res.status(404).json({ error: '연락처 없음' });
  data.contacts = (data.contacts || []).filter(c => c.id !== req.params.id);
  db.saveContacts(data);
  logContactChange(req.user?.userId, 'DELETE', { type:'contact', id:before.id, name:before.name }, before, null);
  res.json({ ok: true });
});

// 연락처 복사 (다른 프로젝트로)
router.post('/copy', requireAuth, (req, res) => {
  const { contactIds, targetProjectId, targetSiteId } = req.body;
  const projId = targetProjectId || targetSiteId;

  if (!contactIds || !projId) return res.status(400).json({ error: '필수 값 누락' });

  const data = db.loadContacts();
  if (!data.contacts) data.contacts = [];

  const copied = [];
  for (const cid of contactIds) {
    const orig = data.contacts.find(c => c.id === cid);
    if (!orig) continue;

    const newC = {
      ...orig,
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      projectId: projId,
      siteId: projId,
      createdAt: new Date().toISOString(),
      createdBy: req.authUser?.userId || ''
    };

    data.contacts.push(newC);
    copied.push(newC);
  }

  db.saveContacts(data);
  res.json({ ok: true, copied: copied.length });
});

// 통합 검색 API (전체 연락처 검색 + 업체/프로젝트 정보 포함)
router.get('/search', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const q = (req.query.q || '').toLowerCase();

  if (!q) return res.json([]);

  const contacts = data.contacts || [];
  const projects = data.contactProjects || [];
  const companies = data.contactCompanies || [];

  // 프로젝트/회사 맵 만들기
  const projectMap = {};
  projects.forEach(p => { projectMap[p.id] = p; });

  const companyMap = {};
  companies.forEach(c => { companyMap[c.id] = c; });

  // 검색
  const results = contacts.filter(c =>
    (c.name || '').toLowerCase().includes(q) ||
    (c.company || '').toLowerCase().includes(q) ||
    (c.position || '').toLowerCase().includes(q) ||
    (c.phone || '').includes(q) ||
    (c.mobile || '').includes(q) ||
    (c.email || '').toLowerCase().includes(q)
  ).map(c => {
    const proj = projectMap[c.projectId];
    const comp = proj ? companyMap[proj.companyId] : null;

    return {
      ...c,
      projectName: proj ? proj.name : '',
      companyName: comp ? comp.name : ''
    };
  });

  res.json(results);
});

// 커스텀 필드 관리 (프로젝트별)
router.get('/projects/:projectId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  const fields = project.customFields || [];
  res.json(fields);
});

router.post('/projects/:projectId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  if (!project.customFields) project.customFields = [];

  const field = {
    id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    name: req.body.name || '',
    type: req.body.type || 'text',
    options: req.body.options || []
  };

  project.customFields.push(field);
  db.saveContacts(data);
  res.json(field);
});

router.delete('/projects/:projectId/fields/:fieldId', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  project.customFields = (project.customFields || []).filter(f => f.id !== req.params.fieldId);

  // 연락처에서 해당 필드 데이터 제거
  (data.contacts || []).forEach(c => {
    if (c.projectId === req.params.projectId && c.customFields) {
      delete c.customFields[req.params.fieldId];
    }
  });

  db.saveContacts(data);
  res.json({ ok: true });
});

// 하위 호환성: 이전 sites API도 유지 (실제로는 projects 사용)
router.get('/sites', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const sites = data.contactProjects || [];
  res.json(sites);
});

router.post('/sites', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contactProjects) data.contactProjects = [];
  if (!data.contactCompanies || data.contactCompanies.length === 0) {
    data.contactCompanies = [{
      id: 'comp_default',
      name: '기본 업체',
      note: '',
      createdAt: new Date().toISOString()
    }];
  }

  const site = {
    id: 'proj_' + Date.now(),
    companyId: data.contactCompanies[0].id,
    name: req.body.name || '',
    address: req.body.address || '',
    note: req.body.note || '',
    createdAt: new Date().toISOString(),
    customFields: []
  };

  data.contactProjects.push(site);
  db.saveContacts(data);
  res.json(site);
});

router.put('/sites/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  if (req.body.name !== undefined) site.name = req.body.name;
  if (req.body.address !== undefined) site.address = req.body.address;
  if (req.body.note !== undefined) site.note = req.body.note;

  db.saveContacts(data);
  res.json(site);
});

router.delete('/sites/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  data.contactProjects = (data.contactProjects || []).filter(s => s.id !== req.params.id);
  data.contacts = (data.contacts || []).filter(c => c.projectId !== req.params.id);

  db.saveContacts(data);
  res.json({ ok: true });
});

router.get('/sites/:siteId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.siteId);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  const fields = site.customFields || [];
  res.json(fields);
});

router.post('/sites/:siteId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.siteId);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  if (!site.customFields) site.customFields = [];

  const field = {
    id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    name: req.body.name || '',
    type: req.body.type || 'text',
    options: req.body.options || []
  };

  site.customFields.push(field);
  db.saveContacts(data);
  res.json(field);
});

router.delete('/sites/:siteId/fields/:fieldId', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.siteId);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  site.customFields = (site.customFields || []).filter(f => f.id !== req.params.fieldId);

  (data.contacts || []).forEach(c => {
    if (c.projectId === req.params.siteId && c.customFields) {
      delete c.customFields[req.params.fieldId];
    }
  });

  db.saveContacts(data);
  res.json({ ok: true });
});

// ── 즐겨찾기 (사용자별) ─────────────────────────────────
// data.favoritesByUser = { userId: [contactId, ...] }
// 회사 전체 공유 연락처 위에서 사용자별로 즐겨찾기를 따로 관리

router.get('/favorites', requireAuth, (req, res) => {
  try {
    const userId = req.user?.userId || '';
    if (!userId) return res.status(401).json({ error: '인증 필요' });

    const data = db.loadContacts() || {};
    const favIds = (data.favoritesByUser && data.favoritesByUser[userId]) || [];
    const allContacts = data.contacts || [];
    const projects = data.contactProjects || [];
    const companies = data.contactCompanies || [];

    const projMap = {}; projects.forEach(p => { projMap[p.id] = p; });
    const compMap = {}; companies.forEach(c => { compMap[c.id] = c; });

    // 즐겨찾기 ID에 해당하는 연락처만 + 회사/현장 정보 첨부
    const favs = favIds
      .map(id => allContacts.find(c => c.id === id))
      .filter(Boolean)
      .map(c => {
        const proj = projMap[c.projectId];
        const comp = proj ? compMap[proj.companyId] : null;
        return {
          ...c,
          projectName: proj ? proj.name : '',
          companyName: comp ? comp.name : (c.company || '')
        };
      });

    res.json({ ok: true, favoriteIds: favIds, favorites: favs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/favorites/toggle', requireAuth, (req, res) => {
  try {
    const userId = req.user?.userId || '';
    if (!userId) return res.status(401).json({ error: '인증 필요' });

    const { contactId } = req.body || {};
    if (!contactId) return res.status(400).json({ error: 'contactId 필수' });

    const data = db.loadContacts() || {};
    if (!data.favoritesByUser) data.favoritesByUser = {};
    if (!data.favoritesByUser[userId]) data.favoritesByUser[userId] = [];

    const list = data.favoritesByUser[userId];
    const idx = list.indexOf(contactId);
    let isFavorite;
    if (idx >= 0) { list.splice(idx, 1); isFavorite = false; }
    else { list.push(contactId); isFavorite = true; }

    db.saveContacts(data);
    res.json({ ok: true, isFavorite, favoriteIds: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 연락처 변경 기록 조회 + 삭제 복구 (관리자 전용)
// — 직원 실수 추적 + 데이터 복구
// ═══════════════════════════════════════════════════════════

// GET /api/contacts/audit — 변경 기록 최근순 (admin only)
router.get('/audit', requireAdmin, (req, res) => {
  try {
    if (!fs.existsSync(CONTACT_AUDIT_PATH)) return res.json([]);
    const logs = JSON.parse(fs.readFileSync(CONTACT_AUDIT_PATH, 'utf8'));
    logs.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json(logs.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/contacts/audit/restore — 삭제된 항목 복구 (admin only)
router.post('/audit/restore', requireAdmin, (req, res) => {
  try {
    const logTs = req.body.ts;
    if (!logTs) return res.status(400).json({ error: 'ts 필요' });
    if (!fs.existsSync(CONTACT_AUDIT_PATH)) return res.status(404).json({ error: '로그 없음' });
    const logs = JSON.parse(fs.readFileSync(CONTACT_AUDIT_PATH, 'utf8'));
    const log = logs.find(l => l.ts === logTs);
    if (!log) return res.status(404).json({ error: '해당 로그 없음' });
    if (log.action !== 'DELETE') return res.status(400).json({ error: 'DELETE 로그만 복구 가능' });
    if (!log.before) return res.status(400).json({ error: '복구할 데이터 없음' });

    const data = db.loadContacts();
    let restored = 0;
    if (log.type === 'contact') {
      data.contacts = data.contacts || [];
      if (!data.contacts.find(c => c.id === log.before.id)) {
        data.contacts.push(log.before); restored = 1;
      }
    } else if (log.type === 'project') {
      data.contactProjects = data.contactProjects || [];
      if (log.before.project && !data.contactProjects.find(p => p.id === log.before.project.id)) {
        data.contactProjects.push(log.before.project); restored++;
      }
      data.contacts = data.contacts || [];
      for (const c of (log.before.contacts || [])) {
        if (!data.contacts.find(x => x.id === c.id)) { data.contacts.push(c); restored++; }
      }
    } else if (log.type === 'company') {
      data.contactCompanies = data.contactCompanies || [];
      if (log.before.company && !data.contactCompanies.find(c => c.id === log.before.company.id)) {
        data.contactCompanies.push(log.before.company); restored++;
      }
      data.contactProjects = data.contactProjects || [];
      for (const p of (log.before.projects || [])) {
        if (!data.contactProjects.find(x => x.id === p.id)) { data.contactProjects.push(p); restored++; }
      }
      data.contacts = data.contacts || [];
      for (const c of (log.before.contacts || [])) {
        if (!data.contacts.find(x => x.id === c.id)) { data.contacts.push(c); restored++; }
      }
    }

    db.saveContacts(data);
    logContactChange(req.user?.userId, 'CREATE', { type:log.type, id:log.before.id || log.before.company?.id, name:`[복구] ${log.name}` }, null, log.before);
    res.json({ ok: true, restored, message: `${restored}건 복구됨` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 모바일 비공개 검색 (토큰 인증)
// — 외근직/사무실 직원이 핸드폰에서 거래처 검색용
// — 토큰을 모르면 접근 불가. URL: /contacts-mobile.html?t=토큰
// — 토큰 변경: 환경변수 CONTACTS_MOBILE_TOKEN 설정 (또는 아래 default 변경)
// ═══════════════════════════════════════════════════════════
const crypto = require('crypto');

// 모바일 접속 암호: 환경변수(CONTACTS_MOBILE_TOKEN) 우선, 없으면 설정(설정.json)에 저장된 값.
// 둘 다 비어 있으면 FAIL CLOSED — 하드코딩 기본값 금지.
function getMobileToken() {
  const envTok = (process.env.CONTACTS_MOBILE_TOKEN || '').trim();
  if (envTok) return envTok;
  try {
    const s = db.설정.load();
    const t = s && s.contactsMobileToken;
    return (typeof t === 'string') ? t.trim() : '';
  } catch (e) { return ''; }
}

function checkMobileToken(req, res, next) {
  // FAIL CLOSED: 환경변수/설정 둘 다 비면 모든 /m/* 요청 거부 (하드코딩 기본값 금지)
  const expected = getMobileToken();
  if (!expected) {
    return res.status(403).json({ error: 'INVALID_TOKEN', msg: '잘못된 접근입니다' });
  }
  const token = req.query.t || req.headers['x-contacts-token'] || '';
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(expected));
  // 길이가 다르면 timingSafeEqual이 던지므로 먼저 차단 (상수시간 비교 위해 동일 길이 버퍼만 비교)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'INVALID_TOKEN', msg: '잘못된 접근입니다' });
  }
  next();
}

// 모바일 응답 1행 합성 — /m/all·/m/search 공용. destinations = 길찾기 후보(현장+사무실 주소).
// 내부(사내)면 destinations 비움. 끝난 현장(active=false)·주소 없는 곳 제외. 현장=사무실 주소 같으면 1개로 합침.
// companyId 없는 연락처는 회사명으로 업체를 찾아 사무실 주소라도 후보에 넣음(미배정·준공 구제).
function buildMobileRow(c, projectMap, companyMap, companyByName) {
  const proj = projectMap[c.projectId];
  const comp = proj ? companyMap[proj.companyId]
            : (c.companyId ? companyMap[c.companyId] : companyByName[((c.company || '').trim())]);
  const isInternal = comp
    ? (comp.kind === 'internal' || (comp.kind === undefined && /대림에스엠|대림컴퍼니|대림SM|내부/.test(comp.name || '')))
    : false;
  const dests = [];
  if (!isInternal) {
    const siteAddr = (proj && (proj.address || '').trim() && proj.active !== false) ? proj.address.trim() : '';
    const offAddr = (comp && (comp.address || '').trim()) ? comp.address.trim() : '';
    if (siteAddr) dests.push({ label: (proj && proj.name) || '현장', addr: siteAddr, kind: 'site' });
    if (offAddr && offAddr !== siteAddr) dests.push({ label: '사무실', addr: offAddr, kind: 'office' });
  }
  return Object.assign({}, c, {
    projectName: proj ? (proj.name || '') : '',
    projectAddress: proj ? (proj.address || '') : '',
    companyName: comp ? comp.name : (c.company || ''),
    companyKind: isInternal ? 'internal' : 'vendor',
    destinations: dests
  });
}

// GET /api/contacts/m/companies?t=토큰
router.get('/m/companies', checkMobileToken, (req, res) => {
  const data = db.loadContacts();
  res.json(data.contactCompanies || []);
});

// GET /api/contacts/m/projects?t=토큰
router.get('/m/projects', checkMobileToken, (req, res) => {
  const data = db.loadContacts();
  res.json(data.contactProjects || []);
});

// GET /api/contacts/m/all?t=토큰 (회사명/현장명 join 된 전체)
router.get('/m/all', checkMobileToken, (req, res) => {
  const data = db.loadContacts();
  const contacts = data.contacts || [];
  const projects = data.contactProjects || [];
  const companies = data.contactCompanies || [];

  const projectMap = {};
  projects.forEach(p => { projectMap[p.id] = p; });
  const companyMap = {};
  companies.forEach(c => { companyMap[c.id] = c; });
  const companyByName = {};
  companies.forEach(c => { if (c.name) companyByName[c.name.trim()] = c; });

  const results = contacts.map(c => buildMobileRow(c, projectMap, companyMap, companyByName));

  res.json(results);
});

// GET /api/contacts/m/search?t=토큰&q=검색어
router.get('/m/search', checkMobileToken, (req, res) => {
  const data = db.loadContacts();
  const q = (req.query.q || '').toLowerCase().trim();
  const qDigits = q.replace(/[^0-9]/g, '');  // 전화번호 검색용 (하이픈 무시)

  if (!q) return res.json([]);

  const contacts = data.contacts || [];
  const projects = data.contactProjects || [];
  const companies = data.contactCompanies || [];

  const projectMap = {};
  projects.forEach(p => { projectMap[p.id] = p; });
  const companyMap = {};
  companies.forEach(c => { companyMap[c.id] = c; });
  const companyByName = {};
  companies.forEach(c => { if (c.name) companyByName[c.name.trim()] = c; });

  const results = contacts.filter(c => {
    const phoneNum = (c.phone || '').replace(/[^0-9]/g, '');
    const mobileNum = (c.mobile || '').replace(/[^0-9]/g, '');
    return (
      (c.name || '').toLowerCase().includes(q) ||
      (c.company || '').toLowerCase().includes(q) ||
      (c.position || '').toLowerCase().includes(q) ||
      (c.note || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (qDigits && (phoneNum.includes(qDigits) || mobileNum.includes(qDigits)))
    );
  }).map(c => buildMobileRow(c, projectMap, companyMap, companyByName));

  res.json(results);
});

// GET /api/contacts/m/geocode?t=토큰&q=주소
// 모바일 길찾기용 — 주소(또는 회사명+현장명) → 위경도 변환
// Kakao Local API (KAKAO_REST_KEY 환경변수 있으면) → Nominatim fallback
router.get('/m/geocode', checkMobileToken, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ ok:false, error: 'q 필요' });

    const kakaoKey = process.env.KAKAO_REST_KEY;
    if (kakaoKey) {
      try {
        const url1 = 'https://dapi.kakao.com/v2/local/search/keyword.json?query=' + encodeURIComponent(q);
        const r1 = await fetch(url1, { headers: { Authorization: 'KakaoAK ' + kakaoKey } });
        if (r1.ok) {
          const data1 = await r1.json();
          const doc1 = (data1.documents || [])[0];
          if (doc1 && doc1.x && doc1.y) {
            return res.json({ ok:true, lat: parseFloat(doc1.y), lng: parseFloat(doc1.x), name: doc1.place_name || doc1.address_name || q, source: 'kakao-keyword' });
          }
        }
        const url2 = 'https://dapi.kakao.com/v2/local/search/address.json?query=' + encodeURIComponent(q);
        const r2 = await fetch(url2, { headers: { Authorization: 'KakaoAK ' + kakaoKey } });
        if (r2.ok) {
          const data2 = await r2.json();
          const doc2 = (data2.documents || [])[0];
          if (doc2 && doc2.x && doc2.y) {
            return res.json({ ok:true, lat: parseFloat(doc2.y), lng: parseFloat(doc2.x), name: doc2.address_name || q, source: 'kakao-address' });
          }
        }
      } catch (e) {
        console.warn('[m/geocode] Kakao 실패:', e.message);
      }
    }

    try {
      const url3 = 'https://nominatim.openstreetmap.org/search?format=json&countrycodes=kr&limit=1&q=' + encodeURIComponent(q);
      const r3 = await fetch(url3, { headers: { 'User-Agent': 'daelim-sm-erp/1.0 (kwanwon13@gmail.com)' } });
      if (r3.ok) {
        const data3 = await r3.json();
        const hit = (data3 || [])[0];
        if (hit) return res.json({ ok:true, lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), name: hit.display_name, source: 'nominatim' });
      }
    } catch (e) {
      console.warn('[m/geocode] Nominatim 실패:', e.message);
    }

    res.json({ ok:false, error: '좌표를 찾을 수 없음' });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 모바일 명함 스캔 + 등록 (토큰 인증)
// — 핸드폰으로 명함 찍으면 Claude(구독 내 무료)가 글자를 읽어 칸을 채워줌.
// — 토큰 보유자에게 허용되는 '생성 전용' 쓰기. 수정/삭제 없음.
// ═══════════════════════════════════════════════════════════

// 명함 등록 필드별 길이 상한 (제어문자 제거 후 자른다)
const CARD_FIELD_MAX = { name: 50, company: 100, position: 50, mobile: 50, phone: 50, email: 50, address: 200 };

// 제어문자 제거 + trim + 길이 상한. 문자열 아니면 빈 문자열.
function cleanCardField(v, max) {
  if (typeof v !== 'string') v = (v == null ? '' : String(v));
  // 줄바꿈·탭·기타 제어문자 제거 (가독성/저장 안전)
  v = v.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (v.length > max) v = v.slice(0, max);
  return v;
}

// 모델 출력(코드펜스/잡설 섞임)에서 첫 { ... } JSON 블록만 안전 파싱. 실패 시 null.
function extractCardJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  s = s.slice(first, last + 1);
  try { return JSON.parse(s); } catch (e) { return null; }
}

// POST /api/contacts/m/card-scan?t=토큰  body {image:"<base64 또는 dataURL>"}
// → {ok:true, fields:{name,company,position,mobile,phone,email,address}} | {ok:false, error}
router.post('/m/card-scan', checkMobileToken, async (req, res) => {
  let tmpPath = '';
  try {
    let image = (req.body && req.body.image) || '';
    if (typeof image !== 'string' || !image.trim()) {
      return res.status(400).json({ ok: false, error: '이미지가 없어요' });
    }
    // dataURL 접두( data:image/...;base64, ) 제거 → 순수 base64만 남김
    let ext = 'jpg';
    const m = image.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
    if (m) {
      ext = (m[1] || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      if (ext === 'jpeg') ext = 'jpg';
      image = image.slice(image.indexOf(',') + 1);
    }
    image = image.replace(/\s+/g, '');
    let buf;
    try { buf = Buffer.from(image, 'base64'); } catch (e) { buf = null; }
    if (!buf || buf.length === 0) {
      return res.status(400).json({ ok: false, error: '이미지를 읽지 못했어요' });
    }
    if (buf.length > 8 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: '사진이 너무 커요 (8MB 이하로 찍어주세요)' });
    }
    // 이미지 매직넘버 간단 검증 (JPEG/PNG/GIF/WebP/BMP만 허용)
    const isImage =
      (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) ||                       // JPEG
      (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) ||    // PNG
      (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) ||                       // GIF
      (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) ||                   // WEBP
      (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4D);                                            // BMP
    if (!isImage) {
      return res.status(400).json({ ok: false, error: '이미지 파일이 아니에요' });
    }
    if (ext === 'bmp' || ext === 'webp' || ext === 'gif' || ext === 'png') { /* keep */ }
    else ext = 'jpg';

    tmpPath = path.join(os.tmpdir(), 'card-' + Date.now() + '-' + crypto.randomBytes(6).toString('hex') + '.' + ext);
    fs.writeFileSync(tmpPath, buf);

    const prompt = '이 명함 이미지에서 정보를 추출해 아래 JSON만 출력. 모르면 빈문자열. {"name":"","company":"","position":"","mobile":"","phone":"","email":"","address":""}';

    let result;
    try {
      result = await callClaudeCli(prompt, [tmpPath], { timeout: 120000 });
    } catch (e) {
      console.warn('[m/card-scan] AI 호출 실패:', e.message);
      return res.json({ ok: false, error: '명함을 읽지 못했어요' });
    }

    const parsed = extractCardJson(result && result.text);
    if (!parsed || typeof parsed !== 'object') {
      return res.json({ ok: false, error: '명함을 읽지 못했어요' });
    }

    const fields = {
      name: cleanCardField(parsed.name, CARD_FIELD_MAX.name),
      company: cleanCardField(parsed.company, CARD_FIELD_MAX.company),
      position: cleanCardField(parsed.position, CARD_FIELD_MAX.position),
      mobile: cleanCardField(parsed.mobile, CARD_FIELD_MAX.mobile),
      phone: cleanCardField(parsed.phone, CARD_FIELD_MAX.phone),
      email: cleanCardField(parsed.email, CARD_FIELD_MAX.email),
      address: cleanCardField(parsed.address, CARD_FIELD_MAX.address)
    };
    return res.json({ ok: true, fields });
  } catch (e) {
    console.error('[m/card-scan]', e.message);
    return res.json({ ok: false, error: '명함을 읽지 못했어요' });
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }
});

// POST /api/contacts/m/card-register?t=토큰
//   body {name,company,position,mobile,phone,email,address}
//   → {ok:true, contact} | {ok:false, error}
// 같은 이름의 업체가 있으면 그 업체에 직접 소속(directContact, projectId=''), 없으면 새 업체(kind:'vendor') 생성.
router.post('/m/card-register', checkMobileToken, (req, res) => {
  try {
    const body = req.body || {};
    const card = {
      name: cleanCardField(body.name, CARD_FIELD_MAX.name),
      company: cleanCardField(body.company, CARD_FIELD_MAX.company),
      position: cleanCardField(body.position, CARD_FIELD_MAX.position),
      mobile: cleanCardField(body.mobile, CARD_FIELD_MAX.mobile),
      phone: cleanCardField(body.phone, CARD_FIELD_MAX.phone),
      email: cleanCardField(body.email, CARD_FIELD_MAX.email),
      address: cleanCardField(body.address, CARD_FIELD_MAX.address)
    };

    if (!card.name || card.name.length < 1 || card.name.length > 50) {
      return res.status(400).json({ ok: false, error: '이름을 적어주세요' });
    }

    const data = db.loadContacts();
    if (!data.contactCompanies) data.contactCompanies = [];
    if (!data.contacts) data.contacts = [];

    // 같은 이름의 업체 찾기(trim 비교) — 있으면 재사용, 없으면 새로 만든다(kind:'vendor').
    let company = null;
    let companyCreated = false;
    if (card.company) {
      company = data.contactCompanies.find(c => (c.name || '').trim() === card.company);
    }
    if (!company) {
      company = {
        id: 'comp_' + Date.now(),
        name: card.company || (card.name + ' (개인)'),
        note: '',
        kind: 'vendor',
        address: card.address,
        createdAt: new Date().toISOString()
      };
      data.contactCompanies.push(company);
      companyCreated = true;
    }

    // 연락처는 그 업체의 directContact(projectId='')로 생성 — 기존 연락처 필드 형식 그대로.
    const contact = {
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      projectId: '',
      siteId: '',
      companyId: company.id,
      name: card.name,
      company: company.name,
      position: card.position,
      dept: '',
      phone: card.phone,
      mobile: card.mobile,
      email: card.email,
      note: '',
      customFields: {},
      createdAt: new Date().toISOString(),
      createdBy: 'mobile-card'
    };

    data.contacts.push(contact);
    db.saveContacts(data);

    // 감사 로그 (생성). 모바일 토큰 접속이라 ERP 사용자 없음 → 'mobile-card'.
    const actor = (req.user && req.user.userId) || 'mobile-card';
    if (companyCreated) {
      logContactChange(actor, 'CREATE', { type: 'company', id: company.id, name: company.name }, null, company);
    }
    logContactChange(actor, 'CREATE', { type: 'contact', id: contact.id, name: contact.name }, null, contact);

    return res.json({ ok: true, contact });
  } catch (e) {
    console.error('[m/card-register]', e.message);
    return res.status(500).json({ ok: false, error: '저장하지 못했어요' });
  }
});

// ═══════════════════════════════════════════════════════════
// 관리자: 모바일 접속 암호 관리 (ERP 로그인 + admin 필요)
// — 베어러 토큰(/m/*)과 별개. 로그인한 관리자만 조회/변경.
// — 환경변수 CONTACTS_MOBILE_TOKEN 이 있으면 그게 우선(envLocked, 화면 변경 불가).
// ═══════════════════════════════════════════════════════════
router.get('/mobile-token', requireAuth, requireAdmin, (req, res) => {
  const envLocked = !!(process.env.CONTACTS_MOBILE_TOKEN || '').trim();
  let stored = '';
  try { const s = db.설정.load(); stored = (s && typeof s.contactsMobileToken === 'string') ? s.contactsMobileToken : ''; } catch (e) {}
  res.json({ token: envLocked ? '' : stored, hasToken: !!getMobileToken(), envLocked });
});

router.post('/mobile-token', requireAuth, requireAdmin, (req, res) => {
  if ((process.env.CONTACTS_MOBILE_TOKEN || '').trim()) {
    return res.status(409).json({ error: 'ENV_LOCKED', msg: '서버 환경변수(.env)에 암호가 지정돼 있어 화면에서 바꿀 수 없습니다.' });
  }
  const token = (req.body && typeof req.body.token === 'string') ? req.body.token.trim() : '';
  if (token && !/^[A-Za-z0-9._~-]{6,64}$/.test(token)) {
    return res.status(400).json({ error: 'INVALID', msg: '암호는 영문·숫자·._~- 6~64자로 정해주세요.' });
  }
  try {
    const s = db.설정.load();
    s.contactsMobileToken = token; // 빈 문자열이면 모바일 검색 비활성(차단)
    db.설정.save(s);
  } catch (e) {
    return res.status(500).json({ error: 'SAVE_FAIL', msg: e.message });
  }
  try { auditLog((req.user && req.user.userId) || 'unknown', '모바일 접속암호 변경', 'contacts-mobile-token', { set: !!token }); } catch (e) {}
  res.json({ ok: true, hasToken: !!token });
});

module.exports = router;
