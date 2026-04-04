# Paperclip 패턴 → 우리 프로젝트 적용 코드 상세

---

## 1. 감사 로그 (Audit Trail)

### Paperclip 방식
Paperclip은 **append-only** 방식으로 모든 변경을 기록합니다.
수정/삭제가 불가능한 로그 → 누가 언제 뭘 했는지 완전한 이력.

### 우리 프로젝트에 적용하면

**db.js에 추가할 코드:**
```javascript
// db.js에 감사로그 JSON 스토어 추가
const jsonStores = {
  '조직관리': { users: [], departments: [] },
  '결재관리': { approvals: [] },
  '감사로그': { logs: [] },  // ← 이것만 추가
  // ...
};
```

**server.js에 추가할 미들웨어:**
```javascript
// 감사 로그 기록 함수
function auditLog(userId, action, target, detail = {}) {
  const logs = db.감사로그.load();
  logs.logs.push({
    id: `log_${Date.now()}`,
    시간: new Date().toISOString(),
    사용자: userId,        // 예: "admin"
    행동: action,          // 예: "품목 수정", "견적 삭제", "로그인"
    대상: target,          // 예: "현수막 (BN)"
    상세: detail,          // 예: { 변경전: "1000", 변경후: "1500" }
    IP: ''                 // req.ip 등
  });
  
  // 최근 10,000건만 유지 (용량 관리)
  if (logs.logs.length > 10000) {
    logs.logs = logs.logs.slice(-10000);
  }
  db.감사로그.save(logs);
}
```

**실제 API에서 사용 예시:**
```javascript
// 기존 품목 수정 API
app.put('/api/categories/:id', requireAuth, (req, res) => {
  const before = db.sql.categories.getById(req.params.id);  // 변경 전 데이터
  const result = db.sql.categories.update(req.params.id, req.body);
  
  // ★ 감사 로그 추가 (이 한 줄만 넣으면 됨)
  auditLog(req.session.userId, '품목 수정', before.name, {
    변경전: { name: before.name, code: before.code },
    변경후: { name: result.name, code: result.code }
  });
  
  res.json(result);
});

// 기존 견적 삭제 API
app.delete('/api/quotes/:id', requireAuth, (req, res) => {
  const quote = db.sql.quotes.getById(req.params.id);
  db.sql.quotes.delete(req.params.id);
  
  // ★ 감사 로그
  auditLog(req.session.userId, '견적 삭제', quote.quoteName || quote.id);
  
  res.json({ ok: true });
});

// 로그인 시
app.post('/api/auth/login', (req, res) => {
  // ... 로그인 로직 ...
  auditLog(user.username, '로그인', '시스템');
  res.json({ ok: true });
});
```

**감사 로그 조회 API:**
```javascript
// 관리자만 조회 가능
app.get('/api/audit-logs', requireAuth, requireAdmin, (req, res) => {
  const logs = db.감사로그.load();
  const { page = 1, limit = 50, user, action } = req.query;
  
  let filtered = logs.logs;
  if (user) filtered = filtered.filter(l => l.사용자 === user);
  if (action) filtered = filtered.filter(l => l.행동.includes(action));
  
  // 최신순 정렬, 페이징
  filtered.reverse();
  const start = (page - 1) * limit;
  res.json({
    total: filtered.length,
    logs: filtered.slice(start, start + parseInt(limit))
  });
});
```

**프론트엔드 (관리자 화면에 감사로그 탭 추가):**
```html
<!-- 감사로그 테이블 -->
<table>
  <tr><th>시간</th><th>사용자</th><th>행동</th><th>대상</th></tr>
  <template x-for="log in auditLogs">
    <tr>
      <td x-text="new Date(log.시간).toLocaleString('ko')"></td>
      <td x-text="log.사용자"></td>
      <td x-text="log.행동"></td>
      <td x-text="log.대상"></td>
    </tr>
  </template>
</table>
```

**결과물 예시:**
```
시간                  | 사용자 | 행동      | 대상
2026-04-02 14:30:22  | admin  | 품목 수정  | 현수막 (BN)
2026-04-02 14:28:15  | admin  | 견적 생성  | 김포공항 견적서
2026-04-02 14:20:01  | 한윤호 | 로그인     | 시스템
2026-04-02 13:55:30  | admin  | 업체 추가  | (주)새로운업체
```

---

## 2. 자동 백업 시스템

### Paperclip 방식
config 변경마다 자동 버전 관리. 문제 생기면 즉시 롤백.

### 우리 프로젝트에 적용하면

**자동백업.bat (Windows 작업 스케줄러에 등록):**
```batch
@echo off
set BACKUP_ROOT=D:\price-list-app\backups
set DATA_DIR=D:\price-list-app\data
set TODAY=%date:~0,4%%date:~5,2%%date:~8,2%

rem 오늘 날짜 폴더 생성
mkdir "%BACKUP_ROOT%\%TODAY%" 2>/dev/null

rem data 폴더 전체 복사
xcopy "%DATA_DIR%\*.*" "%BACKUP_ROOT%\%TODAY%\" /Y /Q

rem 7일 이전 백업 삭제
forfiles /p "%BACKUP_ROOT%" /d -7 /c "cmd /c if @isdir==TRUE rmdir /s /q @path" 2>/dev/null

echo Backup complete: %BACKUP_ROOT%\%TODAY%
```

**server.js에 저장 전 자동 백업:**
```javascript
// JSON 저장할 때마다 이전 버전 백업
function safeJsonSave(filePath, data) {
  const backupDir = path.join(__dirname, 'data', '_자동백업');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  
  // 기존 파일이 있으면 백업
  if (fs.existsSync(filePath)) {
    const fileName = path.basename(filePath, '.json');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupDir, `${fileName}_${timestamp}.json`);
    fs.copyFileSync(filePath, backupPath);
    
    // 파일별 최근 20개만 유지
    const backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(fileName + '_'))
      .sort();
    while (backups.length > 20) {
      fs.unlinkSync(path.join(backupDir, backups.shift()));
    }
  }
  
  // 안전한 쓰기 (tmp → rename)
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}
```

**결과: data/_자동백업/ 폴더 내용:**
```
조직관리_2026-04-02T14-30-22.json
조직관리_2026-04-02T10-15-03.json
품목관리_2026-04-02T14-28-15.json
견적관리_2026-04-02T13-55-30.json
...
```

---

## 3. 승인 워크플로우 (Governance)

### Paperclip 방식
중요 변경은 **approval gate** 통과 필수.
에이전트가 새 직원 채용 → 이사회(Board) 승인 필요.

### 우리 프로젝트에 적용하면

**견적서 워크플로우 상태 흐름:**
```
작성(draft) → 검토요청(review) → 승인(approved) → 발송(sent) → 완료(done)
                    ↓
               반려(rejected) → 작성(draft)  ← 재작성
```

**server.js 견적 상태 변경 API:**
```javascript
// 견적 상태 변경 (워크플로우 강제)
const VALID_TRANSITIONS = {
  'draft':    ['review'],           // 작성 → 검토요청만 가능
  'review':   ['approved', 'rejected'], // 검토 → 승인 또는 반려
  'rejected': ['draft'],            // 반려 → 다시 작성
  'approved': ['sent'],             // 승인 → 발송
  'sent':     ['done'],             // 발송 → 완료
};

app.put('/api/quotes/:id/status', requireAuth, (req, res) => {
  const quote = db.sql.quotes.getById(req.params.id);
  const { status: newStatus } = req.body;
  const currentStatus = quote.status || 'draft';
  
  // 허용된 상태 전환인지 확인
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(newStatus)) {
    return res.status(400).json({ 
      error: `'${currentStatus}' 상태에서 '${newStatus}'로 변경할 수 없습니다.`,
      허용: allowed 
    });
  }
  
  // 승인은 admin/팀장만 가능
  if (newStatus === 'approved' && req.session.role !== 'admin') {
    return res.status(403).json({ error: '승인 권한이 없습니다' });
  }
  
  db.sql.quotes.update(req.params.id, { status: newStatus });
  auditLog(req.session.userId, `견적 ${newStatus}`, quote.quoteName);
  
  res.json({ ok: true, status: newStatus });
});
```

**단가 변경 시 승인 게이트:**
```javascript
// 단가 변경은 기록 + 알림
app.put('/api/categories/:id', requireAuth, (req, res) => {
  const before = db.sql.categories.getById(req.params.id);
  
  // 가격 관련 필드가 변경되면 승인 필요 체크
  const priceFields = ['tiers', 'widthTiers', 'qtyPrice', 'fixedPrice'];
  const priceChanged = priceFields.some(f => 
    JSON.stringify(req.body[f]) !== JSON.stringify(before[f])
  );
  
  if (priceChanged && req.session.role !== 'admin') {
    // 일반 직원이 단가 변경 시 → 결재 요청으로 전환
    const approval = {
      id: `appr_${Date.now()}`,
      type: 'price_change',
      requesterId: req.session.userId,
      targetId: req.params.id,
      targetName: before.name,
      변경전: priceFields.reduce((o, f) => ({ ...o, [f]: before[f] }), {}),
      변경후: priceFields.reduce((o, f) => ({ ...o, [f]: req.body[f] }), {}),
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    
    const approvals = db.결재관리.load();
    approvals.approvals.push(approval);
    db.결재관리.save(approvals);
    
    return res.json({ needApproval: true, message: '단가 변경은 관리자 승인이 필요합니다' });
  }
  
  // admin이면 바로 수정
  const result = db.sql.categories.update(req.params.id, req.body);
  auditLog(req.session.userId, '품목 수정', before.name);
  res.json(result);
});
```

---

## 4. 대시보드 홈 화면 개선

### Paperclip 방식
한눈에: 에이전트 상태, 비용, 작업 현황, 최근 활동을 대시보드에 표시.

### 우리 프로젝트에 적용하면

**server.js 대시보드 API:**
```javascript
app.get('/api/dashboard', requireAuth, (req, res) => {
  // 요약 통계
  const categories = db.sql ? db.sql.categories.getAll() : [];
  const vendors = db.sql ? db.sql.vendors.getAll() : [];
  const quotes = db.sql ? db.sql.quotes.getAll() : [];
  const approvals = db.결재관리.load().approvals;
  
  // 이번 달 견적
  const thisMonth = new Date().toISOString().slice(0, 7); // "2026-04"
  const monthQuotes = quotes.filter(q => (q.createdAt || '').startsWith(thisMonth));
  const monthTotal = monthQuotes.reduce((sum, q) => sum + (q.totalAmount || 0), 0);
  
  // 미처리 결재
  const pendingApprovals = approvals.filter(a => a.status === 'pending');
  
  // 최근 활동 (감사로그 최근 10건)
  const logs = db.감사로그 ? db.감사로그.load().logs.slice(-10).reverse() : [];
  
  res.json({
    stats: {
      품목수: categories.length,
      업체수: vendors.length,
      총견적수: quotes.length,
      이번달견적: monthQuotes.length,
      이번달매출: monthTotal,
      미처리결재: pendingApprovals.length,
    },
    recentActivity: logs,
    pendingApprovals: pendingApprovals.slice(0, 5)
  });
});
```

**프론트엔드 대시보드 카드:**
```html
<!-- 홈 탭 상단에 통계 카드 -->
<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
  <div class="bg-white rounded-lg shadow p-4 border-l-4 border-blue-500">
    <div class="text-sm text-gray-500">이번달 견적</div>
    <div class="text-2xl font-bold" x-text="dashboard.이번달견적 + '건'"></div>
    <div class="text-sm text-green-600" x-text="'₩' + dashboard.이번달매출.toLocaleString()"></div>
  </div>
  
  <div class="bg-white rounded-lg shadow p-4 border-l-4 border-yellow-500">
    <div class="text-sm text-gray-500">미처리 결재</div>
    <div class="text-2xl font-bold" x-text="dashboard.미처리결재 + '건'"></div>
  </div>
  
  <div class="bg-white rounded-lg shadow p-4 border-l-4 border-green-500">
    <div class="text-sm text-gray-500">등록 품목</div>
    <div class="text-2xl font-bold" x-text="dashboard.품목수 + '종'"></div>
  </div>
  
  <div class="bg-white rounded-lg shadow p-4 border-l-4 border-purple-500">
    <div class="text-sm text-gray-500">거래 업체</div>
    <div class="text-2xl font-bold" x-text="dashboard.업체수 + '개'"></div>
  </div>
</div>

<!-- 최근 활동 타임라인 -->
<div class="bg-white rounded-lg shadow p-4">
  <h3 class="font-bold mb-3">최근 활동</h3>
  <template x-for="log in dashboard.recentActivity">
    <div class="flex items-center gap-3 py-2 border-b last:border-0">
      <span class="text-xs text-gray-400" 
            x-text="new Date(log.시간).toLocaleString('ko')"></span>
      <span class="font-medium" x-text="log.사용자"></span>
      <span x-text="log.행동"></span>
      <span class="text-blue-600" x-text="log.대상"></span>
    </div>
  </template>
</div>
```

---

## 5. server.js 모듈 분리 (Route 분리)

### Paperclip 방식
모노레포 구조. 서버/UI/CLI/DB 각각 독립 패키지.
각 기능이 별도 파일로 분리되어 유지보수 용이.

### 우리 프로젝트에 적용하면 (현재 3,379줄 → 파일별 분리)

**폴더 구조 변경:**
```
price-list-app/
├── server.js              ← 메인 (라우터 연결만, 200줄)
├── routes/
│   ├── auth.js            ← 로그인/회원가입 (150줄)
│   ├── categories.js      ← 품목 CRUD (200줄)
│   ├── options.js         ← 옵션 CRUD (150줄)
│   ├── vendors.js         ← 업체 CRUD (120줄)
│   ├── quotes.js          ← 견적 CRUD + PDF (400줄)
│   ├── contacts.js        ← 연락처 (100줄)
│   ├── admin.js           ← 사용자/부서 관리 (200줄)
│   ├── approvals.js       ← 결재 (150줄)
│   ├── attendance.js      ← 근태 (300줄)
│   └── dashboard.js       ← 대시보드/통계 (100줄)
├── middleware/
│   ├── auth.js            ← requireAuth, requireAdmin
│   └── audit.js           ← auditLog 함수
```

**server.js (메인 — 깔끔하게 연결만):**
```javascript
const express = require('express');
const app = express();

// 미들웨어
app.use(express.json({ limit: '50mb' }));
app.use(require('cors')());
app.use(express.static('public'));

// 라우터 등록 (한 줄씩)
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/categories',  require('./routes/categories'));
app.use('/api/options',     require('./routes/options'));
app.use('/api/vendors',     require('./routes/vendors'));
app.use('/api/quotes',      require('./routes/quotes'));
app.use('/api/contacts',    require('./routes/contacts'));
app.use('/api/admin',       require('./routes/admin'));
app.use('/api/approvals',   require('./routes/approvals'));
app.use('/api/attendance',  require('./routes/attendance'));
app.use('/api/dashboard',   require('./routes/dashboard'));

app.listen(3000);
```

**routes/categories.js (분리된 모듈 예시):**
```javascript
const router = require('express').Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// GET /api/categories
router.get('/', requireAuth, (req, res) => {
  if (db.sql) {
    res.json(db.sql.categories.getAll());
  } else {
    const data = db.load();
    res.json(data.categories || []);
  }
});

// POST /api/categories
router.post('/', requireAuth, (req, res) => {
  // ... 생성 로직
  auditLog(req.session.userId, '품목 추가', req.body.name);
  res.json(result);
});

// PUT /api/categories/:id
router.put('/:id', requireAuth, (req, res) => {
  const before = db.sql.categories.getById(req.params.id);
  const result = db.sql.categories.update(req.params.id, req.body);
  auditLog(req.session.userId, '품목 수정', before.name);
  res.json(result);
});

// DELETE /api/categories/:id
router.delete('/:id', requireAuth, (req, res) => {
  const cat = db.sql.categories.getById(req.params.id);
  db.sql.categories.delete(req.params.id);
  auditLog(req.session.userId, '품목 삭제', cat.name);
  res.json({ ok: true });
});

module.exports = router;
```

**middleware/audit.js:**
```javascript
const db = require('../db');

function auditLog(userId, action, target, detail = {}) {
  try {
    const logs = db.감사로그.load();
    logs.logs.push({
      id: `log_${Date.now()}`,
      시간: new Date().toISOString(),
      사용자: userId,
      행동: action,
      대상: target,
      상세: detail
    });
    if (logs.logs.length > 10000) logs.logs = logs.logs.slice(-10000);
    db.감사로그.save(logs);
  } catch (e) {
    console.error('감사로그 기록 실패:', e.message);
  }
}

module.exports = { auditLog };
```

---

## 6. 알림 시스템 (이벤트 기반)

### Paperclip 방식
이벤트가 생기면(작업 할당, 멘션, 상태변경) 자동 알림.
Heartbeat(스케줄) 방식으로 주기적 체크.

### 우리 프로젝트에 적용하면

**알림 저장소 (db.js에 추가):**
```javascript
const jsonStores = {
  // ...기존...
  '알림': {
    notifications: []
  }
};
```

**알림 생성 함수:**
```javascript
function notify(targetUserId, type, message, link = '') {
  const notifs = db.알림.load();
  notifs.notifications.push({
    id: `notif_${Date.now()}`,
    대상: targetUserId,
    유형: type,           // 'approval', 'quote', 'system'
    메시지: message,      // "새 결재 요청이 있습니다"
    링크: link,           // 클릭 시 이동할 탭/페이지
    읽음: false,
    생성시간: new Date().toISOString()
  });
  
  // 사용자당 최근 100개만
  const userNotifs = notifs.notifications.filter(n => n.대상 === targetUserId);
  if (userNotifs.length > 100) {
    const cutoff = userNotifs[userNotifs.length - 100].id;
    notifs.notifications = notifs.notifications.filter(n => 
      n.대상 !== targetUserId || n.id >= cutoff
    );
  }
  db.알림.save(notifs);
}
```

**실제 사용 예시:**
```javascript
// 결재 요청 시 → 관리자에게 알림
app.post('/api/approvals', requireAuth, (req, res) => {
  // ...결재 생성 로직...
  
  // 모든 admin에게 알림
  const org = db.조직관리.load();
  org.users.filter(u => u.role === 'admin').forEach(admin => {
    notify(admin.username, 'approval', 
      `${req.session.name}님이 결재를 요청했습니다: ${req.body.title}`,
      'approvals'  // 결재 탭으로 이동
    );
  });
  
  res.json({ ok: true });
});

// 견적 승인 시 → 요청자에게 알림
app.put('/api/quotes/:id/status', requireAuth, (req, res) => {
  const quote = db.sql.quotes.getById(req.params.id);
  // ...상태 변경 로직...
  
  if (req.body.status === 'approved') {
    notify(quote.createdBy, 'quote',
      `견적서 "${quote.quoteName}"이 승인되었습니다`,
      'history'
    );
  }
  
  res.json({ ok: true });
});
```

**알림 조회 API:**
```javascript
// 내 알림 목록
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifs = db.알림.load();
  const mine = notifs.notifications
    .filter(n => n.대상 === req.session.userId)
    .reverse()  // 최신순
    .slice(0, 50);
  
  const unreadCount = mine.filter(n => !n.읽음).length;
  res.json({ unreadCount, notifications: mine });
});

// 알림 읽음 처리
app.put('/api/notifications/:id/read', requireAuth, (req, res) => {
  const notifs = db.알림.load();
  const n = notifs.notifications.find(n => n.id === req.params.id);
  if (n) { n.읽음 = true; db.알림.save(notifs); }
  res.json({ ok: true });
});
```

**프론트엔드 알림 벨:**
```html
<!-- 상단 네비게이션에 알림 벨 -->
<div class="relative" @click="showNotifPanel = !showNotifPanel">
  <svg><!-- 벨 아이콘 --></svg>
  <span x-show="unreadCount > 0" 
        class="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center"
        x-text="unreadCount"></span>
</div>

<!-- 알림 패널 -->
<div x-show="showNotifPanel" class="absolute right-0 mt-2 w-80 bg-white shadow-lg rounded-lg">
  <template x-for="n in notifications">
    <div :class="n.읽음 ? 'opacity-60' : 'bg-blue-50'" 
         class="p-3 border-b cursor-pointer"
         @click="readNotification(n); navigateToTab(n.링크)">
      <div class="text-sm" x-text="n.메시지"></div>
      <div class="text-xs text-gray-400" x-text="timeAgo(n.생성시간)"></div>
    </div>
  </template>
</div>
```

---

## 한눈에 보는 적용 순서

| 순서 | 기능 | 건드리는 파일 | 난이도 |
|------|------|---------------|--------|
| 1 | 감사 로그 | db.js (1줄) + server.js (API별 1줄씩) | ★☆☆ |
| 2 | 자동 백업 | 자동백업.bat (신규) + 작업스케줄러 | ★☆☆ |
| 3 | 알림 시스템 | db.js (1줄) + server.js + index.html | ★★☆ |
| 4 | 대시보드 개선 | server.js (API 1개) + index.html | ★★☆ |
| 5 | 견적 워크플로우 | server.js + index.html | ★★☆ |
| 6 | 단가변경 승인 | server.js + 결재관리 연동 | ★★★ |
| 7 | Route 분리 | server.js → routes/ 폴더 분리 | ★★★ |

