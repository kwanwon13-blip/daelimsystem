/**
 * routes/contacts.js — 전화번호부 (업체 → 프로젝트 → 연락처)
 * Mounted at: app.use('/api/contacts', require('./routes/contacts'))
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

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
    createdAt: new Date().toISOString()
  };

  data.contactCompanies.push(company);
  db.saveContacts(data);
  res.json(company);
});

router.put('/companies/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const company = (data.contactCompanies || []).find(c => c.id === req.params.id);
  if (!company) return res.status(404).json({ error: '업체 없음' });

  if (req.body.name !== undefined) company.name = req.body.name;
  if (req.body.note !== undefined) company.note = req.body.note;
  if (req.body.order !== undefined) company.order = req.body.order;

  db.saveContacts(data);
  res.json(company);
});

router.delete('/companies/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  // 해당 업체의 모든 프로젝트 삭제
  const projectIds = (data.contactProjects || [])
    .filter(p => p.companyId === req.params.id)
    .map(p => p.id);

  data.contactProjects = (data.contactProjects || []).filter(p => p.companyId !== req.params.id);

  // 해당 프로젝트의 모든 연락처 삭제
  data.contacts = (data.contacts || []).filter(c => !projectIds.includes(c.projectId));

  // 업체 삭제
  data.contactCompanies = (data.contactCompanies || []).filter(c => c.id !== req.params.id);

  db.saveContacts(data);
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
  res.json(project);
});

router.put('/projects/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  if (req.body.name !== undefined) project.name = req.body.name;
  if (req.body.address !== undefined) project.address = req.body.address;
  if (req.body.note !== undefined) project.note = req.body.note;
  if (req.body.order !== undefined) project.order = req.body.order;
  if (req.body.companyId !== undefined) project.companyId = req.body.companyId;

  db.saveContacts(data);
  res.json(project);
});

router.delete('/projects/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  // 해당 프로젝트의 모든 연락처 삭제
  data.contacts = (data.contacts || []).filter(c => c.projectId !== req.params.id);

  // 프로젝트 삭제
  data.contactProjects = (data.contactProjects || []).filter(p => p.id !== req.params.id);

  db.saveContacts(data);
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
  res.json(contact);
});

router.put('/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const c = (data.contacts || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '연락처 없음' });

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
  res.json(c);
});

router.delete('/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  data.contacts = (data.contacts || []).filter(c => c.id !== req.params.id);
  db.saveContacts(data);
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

// ═══════�