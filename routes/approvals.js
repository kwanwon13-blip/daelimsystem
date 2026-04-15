/**
 * routes/approvals.js — 결재 시스템 + 결재 위임
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { notify } = require('../utils/notify');

// 결재 위임 여부 확인 — userId가 위임받은 사람이 있으면 대리인 반환, 없으면 원래 userId 반환
function getEffectiveApprover(userId) {
  try {
    const delegateData = db['결재위임'].load();
    if (!delegateData.delegates || !Array.isArray(delegateData.delegates)) return userId;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const activeDelegate = delegateData.delegates.find(d =>
      d.위임자 === userId && d.시작일 <= today && d.종료일 >= today
    );

    return activeDelegate ? activeDelegate.대리인 : userId;
  } catch (e) {
    console.error('[결재위임] 확인 실패:', e.message);
    return userId;
  }
}

// 결재 문서 접근 가능 여부 판단 헬퍼
function canViewApproval(doc, user, uData) {
  if (user.role === 'admin') return true;
  if (doc.authorId === user.userId) return true;        // 본인 기안
  if (doc.approverId === user.userId) return true;      // 본인 결재 대상

  // 팀장이면 같은 부서원 문서 조회 가능
  const me = (uData.users || []).find(u => u.userId === user.userId);
  if (me && me.department) {
    const myDept = (uData.departments || []).find(d => d.id === me.department);
    if (myDept && myDept.leaderId === me.id) {
      // 같은 부서에 속한 직원이 작성한 문서인지 확인
      const author = (uData.users || []).find(u => u.userId === doc.authorId);
      if (author && author.department === me.department) return true;
    }
  }
  return false;
}

// ── 결재 대리/위임 API (/:id 보다 먼저 등록해야 충돌 방지) ──

// 위임 설정 추가
router.post('/delegate', requireAuth, (req, res) => {
  const { 대리인, 시작일, 종료일, 사유 } = req.body;
  if (!대리인 || !시작일 || !종료일) {
    return res.status(400).json({ error: '필수 항목 누락' });
  }

  try {
    const delegateData = db['결재위임'].load();
    const newDelegate = {
      id: `del_${Date.now()}`,
      위임자: req.user.userId,
      대리인,
      시작일,
      종료일,
      사유: 사유 || '',
      생성일: new Date().toISOString()
    };

    delegateData.delegates.push(newDelegate);
    db['결재위임'].save(delegateData);

    auditLog(req.user.userId, '결재 위임 설정', `${대리인}에게 위임 (${시작일}~${종료일})`);
    res.json({ ok: true, delegate: newDelegate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 내 위임 목록 조회
router.get('/delegates', requireAuth, (req, res) => {
  try {
    const delegateData = db['결재위임'].load();
    const myDelegates = (delegateData.delegates || []).filter(d => d.위임자 === req.user.userId);
    res.json({ delegates: myDelegates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 위임 취소
router.delete('/delegate/:id', requireAuth, (req, res) => {
  try {
    const delegateData = db['결재위임'].load();
    const delegate = delegateData.delegates.find(d => d.id === req.params.id);

    if (!delegate) return res.status(404).json({ error: '위임 기록 없음' });
    if (delegate.위임자 !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인의 위임만 취소할 수 있습니다' });
    }

    delegateData.delegates = delegateData.delegates.filter(d => d.id !== req.params.id);
    db['결재위임'].save(delegateData);

    auditLog(req.user.userId, '결재 위임 취소', delegate.대리인);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 결재 문서 목록 조회 ──────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  let docs = uData.approvals || [];
  const { filter, status, dept } = req.query;
  const myId = req.user.userId;

  // 먼저 접근 권한 필터 적용 (관리자가 아닌 경우)
  if (req.user.role !== 'admin') {
    docs = docs.filter(d => canViewApproval(d, req.user, uData));
  }

  // 휴지통 필터 (admin 전용)
  if (filter === 'deleted') {
    docs = docs.filter(d => d.status === 'deleted');
  } else {
    // 기본: deleted 상태는 숨김
    docs = docs.filter(d => d.status !== 'deleted');
    if (filter === 'mine') {
      docs = docs.filter(d => d.authorId === myId);
    } else if (filter === 'pending') {
      docs = docs.filter(d => d.status === 'pending' && d.approverId === myId);
    }
  }

  // 부서별 폴더 필터 (조직도 연동)
  if (dept) {
    if (dept === '__none__') {
      docs = docs.filter(d => !d.authorDept || d.authorDept === '');
    } else {
      docs = docs.filter(d => d.authorDept === dept);
    }
  }

  if (status) {
    docs = docs.filter(d => d.status === status);
  }

  // 최신순 정렬
  docs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json(docs);
});

// 결재 문서 상세 조회
router.get('/:id', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (!canViewApproval(doc, req.user, uData)) {
    return res.status(403).json({ error: '열람 권한이 없습니다' });
  }
  res.json(doc);
});

// 결재 문서 작성 (기안)
router.post('/', requireAuth, (req, res) => {
  const { type, title, approverId, formData } = req.body;
  if (!type || !title || !approverId) {
    return res.status(400).json({ error: '문서 종류, 제목, 승인자를 입력해주세요' });
  }
  const uData = db.loadUsers();
  if (!uData.approvals) uData.approvals = [];

  // 승인자 존재 확인
  const approver = (uData.users || []).find(u => u.userId === approverId);
  if (!approver) return res.status(400).json({ error: '승인자를 찾을 수 없습니다' });

  // ── 위임 여부 확인 ──
  const effectiveApproverId = getEffectiveApprover(approverId);
  const effectiveApprover = (uData.users || []).find(u => u.userId === effectiveApproverId);
  const isDelegated = effectiveApproverId !== approverId;

  const doc = {
    id: db.generateId('appr'),
    type,
    title,
    authorId: req.user.userId,
    authorName: req.user.name,
    authorDept: (() => {
      const u = (uData.users || []).find(u2 => u2.userId === req.user.userId);
      const deptId = u ? u.department : '';
      const dept = (uData.departments || []).find(d => d.id === deptId);
      return dept ? dept.name : '';
    })(),
    approverId,
    approverName: approver.name,
    effectiveApproverId,
    approverDelegatedTo: isDelegated ? effectiveApprover.name : null,
    isDelegated,
    status: 'pending',
    formData: formData || {},
    comment: '',
    createdAt: new Date().toISOString(),
    processedAt: null
  };

  uData.approvals.push(doc);
  db.saveUsers(uData);

  const logMsg = isDelegated
    ? `${doc.title} → ${approver.name} (대리: ${effectiveApprover.name})`
    : `${doc.title} → ${approver.name}`;
  auditLog(req.user.userId, '결재 기안', logMsg);

  notify(effectiveApproverId, 'approval',
    isDelegated
      ? `[대리] ${req.user.name}님이 결재를 요청했습니다: ${doc.title}`
      : `${req.user.name}님이 결재를 요청했습니다: ${doc.title}`,
    'approvals');

  res.json({ ok: true, id: doc.id });
});

// 결재 승인/반려
router.post('/:id/process', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });

  const actualApproverId = doc.effectiveApproverId || doc.approverId;
  if (actualApproverId !== req.user.userId) {
    return res.status(403).json({ error: '승인 권한이 없습니다' });
  }
  if (doc.status !== 'pending') {
    return res.status(400).json({ error: '이미 처리된 문서입니다' });
  }

  const { action, comment } = req.body;
  if (action !== 'approved' && action !== 'rejected') {
    return res.status(400).json({ error: 'action은 approved 또는 rejected여야 합니다' });
  }

  doc.status = action;
  doc.comment = comment || '';
  doc.processedAt = new Date().toISOString();
  doc.approvedBy = req.user.userId;
  db.saveUsers(uData);

  const logMsg = doc.isDelegated
    ? `${action === 'approved' ? '승인' : '반려'} (대리인: ${req.user.name})`
    : `${action === 'approved' ? '승인' : '반려'}`;
  auditLog(req.user.userId, `결재 ${logMsg}`, doc.title);

  notify(doc.authorId, 'approval',
    `${req.user.name}님이 "${doc.title}"을 ${action === 'approved' ? '승인' : '반려'}했습니다${doc.isDelegated ? ' (대리)' : ''}`,
    'approvals');

  // 휴가계획서 승인 시 → 연차관리에 사용 기록 자동 반영
  if (action === 'approved' && doc.type === 'leave' && doc.formData) {
    try {
      const leaveData = db['연차관리'].load();
      const fd = doc.formData;

      const legacyMap = { annual: '연차', half: '반차', sick: '병가', special: '특별휴가' };
      const leaveTypeName = legacyMap[fd.leaveType] || fd.leaveType || '연차';
      const leaveSetting = (leaveData.settings?.leaveTypes || []).find(t => t.name === leaveTypeName);
      const deductsAnnual = leaveSetting ? leaveSetting.deductsAnnual : (leaveTypeName === '연차' || leaveTypeName === '반차');
      const isHalfDay = leaveSetting ? (leaveSetting.days === 0.5) : (leaveTypeName === '반차');

      const fixedDays = leaveSetting?.days || null;
      const start = new Date(fd.startDate);
      let end;
      if (fd.endDate) {
        end = new Date(fd.endDate);
      } else if (fixedDays && fixedDays >= 1) {
        end = new Date(start);
        let remaining = fixedDays - 1;
        while (remaining > 0) {
          end.setDate(end.getDate() + 1);
          const dow = end.getDay();
          if (dow !== 0 && dow !== 6) remaining--;
        }
      } else {
        end = new Date(start);
      }

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        const dateStr = d.toISOString().slice(0, 10);
        leaveData.leaveRecords = (leaveData.leaveRecords || []).filter(r =>
          !(r.employeeName === doc.authorName && r.date === dateStr && r.source === 'attendance')
        );
        const dup = (leaveData.leaveRecords || []).find(r =>
          r.employeeName === doc.authorName && r.date === dateStr && r.approvalId === doc.id
        );
        if (dup) continue;
        const daysPerDay = isHalfDay ? 0.5 : 1;
        if (!leaveData.leaveRecords) leaveData.leaveRecords = [];
        leaveData.leaveRecords.push({
          id: 'lr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          employeeName: doc.authorName,
          date: dateStr,
          leaveType: leaveTypeName,
          annualDays: deductsAnnual ? daysPerDay : 0,
          nonAnnualDays: deductsAnnual ? 0 : daysPerDay,
          reason: fd.reason || doc.title || '',
          approvalId: doc.id,
          createdAt: new Date().toISOString()
        });
      }
      db['연차관리'].save(leaveData);
      console.log(`✅ 휴가 승인 → 연차관리 자동 반영: ${doc.authorName} ${leaveTypeName} ${fd.startDate}~${fd.endDate || fd.startDate}`);

      // ── 출퇴근 기록부(attendanceNotes)에도 동시 반영 ──
      try {
        const attData = db.출퇴근관리.load();
        if (!attData.attendanceNotes) attData.attendanceNotes = {};
        const attEmpId = doc.authorName;
        const leaveCodeMap = { '연차': 'annual', '반차': 'halfAM', '병가': 'sick', '특별휴가': 'special' };
        const attLeaveType = leaveCodeMap[leaveTypeName] || 'annual';
        const attLeaveLabel = leaveTypeName;

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dayOfWeek = d.getDay();
          if (dayOfWeek === 0 || dayOfWeek === 6) continue;
          const dateStr = d.toISOString().slice(0, 10);
          const noteKey = `${attEmpId}_${dateStr}`;
          if (!attData.attendanceNotes[noteKey]) {
            attData.attendanceNotes[noteKey] = {
              leaveType: attLeaveType,
              leaveLabel: attLeaveLabel,
              note: `결재승인: ${doc.title}`,
              approvalId: doc.id,
              setAt: new Date().toISOString()
            };
          }
        }
        db.출퇴근관리.save(attData);
        console.log(`✅ 휴가 승인 → 출퇴근 기록부 자동 반영: ${doc.authorName} ${leaveTypeName} ${fd.startDate}~${fd.endDate || fd.startDate}`);
      } catch(e2) {
        console.error('휴가 승인 → 출퇴근 기록부 반영 실패:', e2.message);
      }
    } catch(e) {
      console.error('휴가 승인 → 연차관리 반영 실패:', e.message);
    }
  }

  // 반려 시 → 출퇴근 기록부에서 해당 결재 기록 제거
  if (action === 'rejected' && doc.type === 'leave' && doc.formData) {
    try {
      const attData = db.출퇴근관리.load();
      if (attData.attendanceNotes) {
        for (const key of Object.keys(attData.attendanceNotes)) {
          if (attData.attendanceNotes[key].approvalId === doc.id) {
            delete attData.attendanceNotes[key];
          }
        }
        db.출퇴근관리.save(attData);
        console.log(`✅ 휴가 반려 → 출퇴근 기록부 노트 제거: ${doc.authorName} (결재 ${doc.id})`);
      }
    } catch(e3) {
      console.error('휴가 반려 → 출퇴근 기록부 제거 실패:', e3.message);
    }
  }

  res.json({ ok: true, status: doc.status });
});

// 결재 문서 삭제 (소프트 삭제)
router.delete('/:id', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (doc.authorId !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: '삭제 권한이 없습니다' });
  }
  if (doc.status !== 'pending' && req.user.role !== 'admin') {
    return res.status(400).json({ error: '대기 중인 문서만 삭제할 수 있습니다' });
  }

  const prevStatus = doc.status;
  doc._prevStatus = doc.status;
  doc.status = 'deleted';
  doc.deletedAt = new Date().toISOString();
  doc.deletedBy = req.user.name;
  db.saveUsers(uData);

  // 결재가 승인 상태였다면 연차 기록도 함께 삭제
  if (prevStatus === 'approved' && doc.type === 'leave') {
    try {
      const leaveData = db['연차관리'].load();
      if (leaveData.leaveRecords) {
        const before = leaveData.leaveRecords.length;
        leaveData.leaveRecords = leaveData.leaveRecords.filter(r => r.approvalId !== doc.id);
        const removed = before - leaveData.leaveRecords.length;
        if (removed > 0) db['연차관리'].save(leaveData);
      }
    } catch (e) {
      console.error('연차 기록 연동 삭제 실패:', e);
    }
  }

  auditLog(req.user.userId, '결재 삭제', doc.title);
  res.json({ ok: true });
});

// 결재 문서 복구 (admin 전용)
router.post('/:id/restore', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 복구할 수 있습니다' });
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (doc.status !== 'deleted') return res.status(400).json({ error: '삭제된 문서가 아닙니다' });
  doc.status = doc._prevStatus || 'pending';
  delete doc._prevStatus;
  delete doc.deletedAt;
  delete doc.deletedBy;
  db.saveUsers(uData);
  auditLog(req.user.userId, '결재 복구', doc.title);
  res.json({ ok: true });
});

module.exports = router;
