
function statementsApp() {
  return {
    items: [], total: 0, limit: 100, offset: 0,
    stats: { total: 0, pending: 0, confirmed: 0, rejected: 0, byQuadrant: [], pendingByQuadrant: [] },
    filterStatus: '', filterMonth: '', filterCompany: '', filterClass: '매입', searchQ: '',
    queue: { total: 0, processed: 0, failed: 0, queueLen: 0, processing: 0 },
    queueTimer: null,
    dragOver: false,
    selected: null, edit: {}, saveMsg: '',
    split: {
      open: false, file: null, imageUrl: '', image: null,
      boxes: [], selectedIdx: -1, drawing: false,
      startX: 0, startY: 0, msg: '',
      companyCode: 'COMPANY', docClass: '매입',
    },

    // 모드 라우팅
    currentView: 'overview',  // overview / company-buy / sm-buy
    modeRows: [], selectedRowIdx: -1,

    enterMode(company, cls) {
      const map = {
        'COMPANY_매입': 'company-buy',
        'SM_매입': 'sm-buy',
      };
      const nextView = map[`${company}_${cls}`];
      if (!nextView) {
        alert('MVP에서는 컴퍼니 매입과 에스엠 매입만 진행합니다.');
        return;
      }
      this.currentView = nextView;
      this.filterCompany = company;
      this.filterClass = cls;
      this.selectedRowIdx = -1;
      this.loadModeRows();
    },
    exitMode() {
      this.currentView = 'overview';
      this.modeRows = [];
      this.selectedRowIdx = -1;
    },

    async loadModeRows() {
      // 분할 조건에 맞는 명세서 + 라인아이템 펼쳐서 불러오기
      const params = new URLSearchParams();
      params.set('companyCode', this.filterCompany);
      params.set('docClass', this.filterClass);
      if (this.filterMonth) params.set('month', this.filterMonth);
      params.set('limit', 1000);
      try {
        const r = await fetch('/api/statements/list?' + params).then(r => r.json());
        if (!r.ok) { this.modeRows = []; return; }
        // 명세서별로 라인아이템 가져와서 펼치기 (각 명세서 GET)
        const rows = [];
        for (const st of r.items) {
          const dt = await fetch('/api/statements/' + st.id).then(r => r.json());
          if (!dt.ok) continue;
          const items = (dt.statement.items || []);
          if (items.length === 0) {
            const displayVendor = st.norm_vendor || st.vendor_name || '';
            const supply = Number(st.supply_amount) || 0;
            const vat = Number(st.vat_amount) || 0;
            const total = Number(st.total_amount) || (supply + vat);
            rows.push({
              _key: 'st_' + st.id,
              statement_id: st.id,
              source_file: st.source_file,
              vendor: displayVendor,
              vendor_biz_no: st.vendor_biz_no || '',
              uploaded_at: st.uploaded_at,
              date: st.doc_date || '',
              name: displayVendor ? displayVendor + ' 명세서 합계' : '명세서 합계',
              spec: '품목 라인 미추출',
              qty: 1, price: supply || total, amount: supply || total,
              vat, total,
              notes: [st.notes, '과거 데이터 매칭 여부와 관계없이 검토 대상으로 표시됨'].filter(Boolean).join(' / '),
              _synthetic: true,
            });
            rows[rows.length - 1]._original = {
              name: rows[rows.length - 1].name,
              spec: rows[rows.length - 1].spec,
              qty: rows[rows.length - 1].qty,
              price: rows[rows.length - 1].price,
              amount: rows[rows.length - 1].amount,
              vat: rows[rows.length - 1].vat,
              total: rows[rows.length - 1].total,
              notes: rows[rows.length - 1].notes,
            };
          } else {
            for (const it of items) {
              const amt = Number(it.amount) || 0;
              rows.push({
                _key: 'st_' + st.id + '_' + it.id,
                statement_id: st.id,
                item_id: it.id,
                source_file: st.source_file,
                vendor: st.norm_vendor || st.vendor_name || '',
                vendor_biz_no: st.vendor_biz_no || '',
                uploaded_at: st.uploaded_at,
                date: st.doc_date || '',
                name: it.item_name || '', spec: it.spec || '',
                qty: it.quantity, unit: it.unit || '', price: it.unit_price,
                amount: amt, vat: it.vat || Math.round(amt * 0.1),
                total: amt + (it.vat || Math.round(amt * 0.1)),
                notes: it.notes || st.notes || '',
              });
            }
          }
        }
        this.modeRows = rows;
        if (rows.length > 0 && this.selectedRowIdx === -1) this.selectedRowIdx = 0;
      } catch(e) { console.error(e); this.modeRows = []; }
    },

    get selectedRow() {
      return (this.modeRows && this.selectedRowIdx >= 0) ? this.modeRows[this.selectedRowIdx] : null;
    },
    selectModeRow(idx) { this.selectedRowIdx = idx; },
    prevRow() { if (this.selectedRowIdx > 0) this.selectedRowIdx--; },
    nextRow() { if (this.selectedRowIdx < (this.modeRows||[]).length - 1) this.selectedRowIdx++; },

    recalc(r, fromAmount) {
      // 수량×단가=금액 자동 계산
      if (!fromAmount && r.qty && r.price) {
        r.amount = Math.round(r.qty * r.price);
      }
      r.vat = Math.round(r.amount * 0.1);
      r.total = r.amount + r.vat;
    },
    addBlankRow() {
      const base = this.selectedRow || {};
      this.modeRows = this.modeRows || [];
      this.modeRows.push({
        _key: 'new_' + Date.now(),
        statement_id: base.statement_id || null,
        source_file: base.source_file || '',
        vendor: base.vendor || '',
        vendor_biz_no: base.vendor_biz_no || '',
        uploaded_at: base.uploaded_at || '',
        date: base.date || '',
        name: '', spec: '', qty: 0, unit: '', price: 0, amount: 0, vat: 0, total: 0, notes: '',
      });
      this.selectedRowIdx = this.modeRows.length - 1;
    },
    modeSum() {
      return (this.modeRows || []).reduce((s, r) => s + (Number(r.total) || 0), 0);
    },
    isSyntheticRowUnchanged(r) {
      if (!r?._synthetic || !r._original) return false;
      return ['name', 'spec', 'qty', 'price', 'amount', 'vat', 'total', 'notes']
        .every(k => String(r[k] ?? '') === String(r._original[k] ?? ''));
    },
    rowHasContent(r) {
      return !!(
        String(r?.name || '').trim()
        || String(r?.spec || '').trim()
        || String(r?.notes || '').trim()
        || Number(r?.qty)
        || Number(r?.price)
        || Number(r?.amount)
        || Number(r?.vat)
      );
    },
    async saveModeRows(opts = {}) {
      const rows = this.modeRows || [];
      const statementIds = [...new Set(rows.map(r => r.statement_id).filter(Boolean))];
      if (statementIds.length === 0) {
        if (!opts.silent) alert('저장할 명세서가 없습니다. 먼저 업로드된 명세서 행을 선택하세요.');
        return false;
      }

      for (const statementId of statementIds) {
        const group = rows.filter(r => r.statement_id === statementId);
        const first = group[0] || {};
        const saveableRows = group.filter(r => this.rowHasContent(r) && !this.isSyntheticRowUnchanged(r));
        const items = saveableRows.map(r => ({
          item_code: r.item_code || '',
          item_name: r.name || '',
          spec: r.spec || '',
          quantity: Number(r.qty) || 0,
          unit: r.unit || '',
          unit_price: Number(r.price) || 0,
          amount: Number(r.amount) || 0,
          vat: Number(r.vat) || 0,
          notes: r.notes || '',
        }));
        const supply = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
        const vat = items.reduce((s, it) => s + (Number(it.vat) || 0), 0);
        const fallbackSupply = group.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        const fallbackVat = group.reduce((s, r) => s + (Number(r.vat) || 0), 0);
        const body = {
          company_code: this.filterCompany,
          doc_class: this.filterClass,
          doc_date: first.date || null,
          vendor_name: first.vendor || null,
          vendor_biz_no: first.vendor_biz_no || null,
          norm_vendor: first.vendor || null,
          supply_amount: supply || fallbackSupply || null,
          vat_amount: vat || fallbackVat || null,
          total_amount: (supply || fallbackSupply || 0) + (vat || fallbackVat || 0),
          items,
        };
        const r = await fetch(`/api/statements/${statementId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(r => r.json());
        if (!r.ok) throw new Error(`명세서 #${statementId} 저장 실패`);
      }

      await this.loadModeRows();
      await this.loadStats();
      if (!opts.silent) alert(`${statementIds.length}개 명세서를 저장했습니다.`);
      return true;
    },
    exportUrl(company, statementIds = []) {
      const p = new URLSearchParams();
      p.set('status', 'confirmed');
      if (company) p.set('companyCode', company);
      if (this.filterClass) p.set('docClass', this.filterClass);
      if (this.filterMonth) p.set('month', this.filterMonth);
      if (statementIds.length) p.set('statementIds', statementIds.join(','));
      return '/api/statements/export.xlsx?' + p;
    },
    async confirmAllInMode() {
      if (!confirm(`현재 분할의 검토전 명세서 모두 확정?\n(이미 확정된 건 변경 없음)`)) return;
      try {
        const saved = await this.saveModeRows({ silent: true });
        if (!saved) return;
      } catch (e) {
        alert('저장 실패로 확정을 중단합니다.\n' + e.message);
        return;
      }
      const failed = [];
      const statementIds = [...new Set((this.modeRows || []).map(r => r.statement_id).filter(Boolean))];
      for (const statementId of statementIds) {
        try {
          const r = await fetch(`/api/statements/${statementId}/confirm`, { method: 'POST' }).then(r => r.json());
          if (!r.ok) failed.push(`#${statementId}: ${this.formatWorkflowIssues(r.workflow)}`);
        } catch(e) {
          failed.push(`#${statementId}: ${e.message}`);
        }
      }
      await this.loadModeRows();
      await this.loadStats();
      if (failed.length) alert('일부 명세서는 확정되지 않았습니다.\n\n' + failed.join('\n\n'));
    },
    async confirmModeStatementIds(statementIds) {
      const failed = [];
      for (const statementId of statementIds || []) {
        try {
          const r = await fetch(`/api/statements/${statementId}/confirm`, { method: 'POST' }).then(r => r.json());
          if (!r.ok) failed.push(`#${statementId}: ${this.formatWorkflowIssues(r.workflow)}`);
        } catch(e) {
          failed.push(`#${statementId}: ${e.message}`);
        }
      }
      await this.loadModeRows();
      await this.loadStats();
      return failed;
    },
    async downloadModeExport(company) {
      const label = company === 'SM' ? '이카운트 엑셀' : 'E2E 엑셀';
      if (!confirm(`현재 화면의 수정값을 저장하고 확정한 뒤 ${label}을 다운로드할까요?`)) return;
      try {
        const saved = await this.saveModeRows({ silent: true });
        if (!saved) return;
        const statementIds = [...new Set((this.modeRows || []).map(r => r.statement_id).filter(Boolean))];
        const failed = await this.confirmModeStatementIds(statementIds);
        if (failed.length) {
          alert('검증 실패로 다운로드를 중단합니다.\n\n' + failed.join('\n\n'));
          return;
        }
        window.location.href = this.exportUrl(company, statementIds);
      } catch (e) {
        alert('엑셀 다운로드 준비 실패: ' + e.message);
      }
    },
    // 학습 풀 통계
    poolStats: { loaded: false },
    async loadPoolStats() {
      try {
        const r = await fetch('/api/statements/learning-pool/stats').then(r => r.json());
        if (r.ok) this.poolStats = r;
      } catch(e) {}
    },
    async mergeByVendorDate(companyCode, docClass) {
      try {
        const r = await fetch('/api/statements/merge-by-vendor-date', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyCode, docClass }),
        }).then(r => r.json());
        if (r.ok) {
          alert(`병합 완료\n그룹 ${r.mergedGroups}개 → 통합된 명세서 ${r.mergedStatements}건\n라인 아이템 ${r.totalLines}개 이동`);
          this.load();
          this.loadStats();
        } else { alert('실패: ' + r.error); }
      } catch(e) { alert('에러: ' + e.message); }
    },

    async reloadPool() {
      try {
        const r = await fetch('/api/statements/learning-pool/reload', { method: 'POST' }).then(r => r.json());
        if (r.ok) {
          this.poolStats = { loaded: true, ...r.stats };
          if (this.poolStats.ready === false) {
            alert('학습자료가 로드되지 않았습니다.\n' + ((this.poolStats.errors || [])[0] || '정답 엑셀을 확인해주세요.'));
          } else {
            alert('학습 풀 다시 로드 완료');
          }
        } else { alert('실패: ' + r.error); }
      } catch(e) { alert('에러: ' + e.message); }
    },

    // 4분할 학습 데이터 풀
    dataSources: {},
    selectedDataFile: '',
    dataSheets: [],
    selectedSheetIdx: 0,
    dataLoading: false,

    async loadDataSources() {
      try {
        const r = await fetch('/api/statements/data-sources').then(r => r.json());
        if (r.ok) this.dataSources = r.sources || {};
      } catch(e) { console.error(e); }
    },

    async loadDataPreview(file) {
      this.selectedDataFile = file.path;
      this.dataLoading = true;
      this.dataSheets = [];
      this.selectedSheetIdx = 0;
      try {
        // SheetJS (XLSX 글로벌 라이브러리, index.html 에 이미 로드됨) 로 파싱
        const url = `/api/statements/data-source-file?path=${encodeURIComponent(file.path)}`;
        if (!window.XLSX) {
          alert('SheetJS 가 로드 안 됨 (index.html 의 xlsx CDN 확인)');
          this.dataLoading = false;
          return;
        }
        const ab = await fetch(url).then(r => r.arrayBuffer());
        const wb = XLSX.read(ab, { type: 'array' });
        this.dataSheets = wb.SheetNames.map(name => {
          const ws = wb.Sheets[name];
          const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          const headers = (json[0] || []).map(h => String(h ?? ''));
          // 처음 100행만 미리보기 (큰 파일 방지)
          const preview = json.slice(1, 101).map(row =>
            headers.map((_, ci) => {
              const v = row[ci];
              if (v == null || v === '') return '';
              if (v instanceof Date) return v.toISOString().slice(0, 10);
              return String(v).slice(0, 60);
            })
          );
          return { name, headers, preview, rows: Math.max(0, json.length - 1) };
        });
      } catch(e) {
        alert('미리보기 실패: ' + e.message);
      } finally {
        this.dataLoading = false;
      }
    },

    // 시안 문구 확인
    spellResults: [],
    spellChecking: false,
    spellChecked: 0,
    spellTotal: 0,
    spellSelectedIdx: -1,
    async spellCheck(files) {
      if (!files || files.length === 0) return;
      // 이미지만 필터
      const imgs = Array.from(files).filter(f => (f.type || '').startsWith('image/'));
      if (imgs.length === 0) {
        alert('이미지 파일만 확인 가능 — 카톡 시안 사진 복사 후 Ctrl+V');
        return;
      }
      this.spellChecking = true;
      this.spellChecked = 0;
      this.spellTotal = imgs.length;
      // 이미지 미리보기 dataURL 만들기
      const previews = await Promise.all(imgs.map(f => new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res({ name: f.name || '붙여넣은 이미지', dataUrl: fr.result });
        fr.readAsDataURL(f);
      })));
      const fd = new FormData();
      imgs.forEach((f, i) => fd.append('files', f, previews[i].name));
      try {
        const r = await fetch('/api/statements/spell-check', { method: 'POST', body: fd }).then(r => r.json());
        if (r.ok) {
          this.spellChecked = imgs.length;
          const results = (r.results || []).map((res, i) => ({
            ...res,
            imageDataUrl: previews[i] ? previews[i].dataUrl : null,
          }));
          // 누적 (Ctrl+V 여러번 가능)
          const wasEmpty = this.spellResults.length === 0;
          this.spellResults = [...this.spellResults, ...results];
          // 새로 들어온 첫 결과 자동 선택 (또는 이미 결과 있으면 새 결과 첫 번째)
          if (wasEmpty || this.spellSelectedIdx < 0) {
            this.spellSelectedIdx = this.spellResults.length - results.length;
          }
        } else {
          alert('실패: ' + r.error);
        }
      } catch (e) {
        alert('에러: ' + e.message);
      } finally {
        this.spellChecking = false;
      }
    },

    // 추출 텍스트에서 의심 단어 형광펜 (HTML 출력)
    highlightText(text, issues) {
      if (!text) return '(텍스트 추출 안됨)';
      const escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
      let html = escapeHtml(text);
      if (!issues || issues.length === 0) return html;
      // 각 issue 의 found 단어를 형광펜으로
      const colors = {
        '오타':       'background:#fee2e2; color:#991b1b;',
        '철자':       'background:#fee2e2; color:#991b1b;',
        '문자깨짐':   'background:#fee2e2; color:#991b1b;',
        '맞춤법':     'background:#fef3c7; color:#92400e;',
        '사이즈':     'background:#dbeafe; color:#1e40af;',
        '숫자':       'background:#e0e7ff; color:#3730a3;',
        '기타':       'background:#f3e8ff; color:#6b21a8;',
      };
      for (const iss of issues) {
        if (!iss.found) continue;
        const found = escapeHtml(iss.found);
        const color = colors[iss.type] || colors['기타'];
        const tooltip = escapeHtml(iss.message + (iss.suggest ? ' → ' + iss.suggest : ''));
        // 첫 발견되는 거 한 번만 마킹 (중복 방지)
        const re = new RegExp(found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        html = html.replace(re, `<mark style="${color} padding:1px 4px; border-radius:3px; font-weight:600;" title="${tooltip}">${found}</mark>`);
      }
      return html;
    },

    // Ctrl+V 핸들러 — 클립보드에 이미지 있으면 검사
    onSpellPaste(e) {
      if (this.currentView !== 'spell-check') return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if ((it.type || '').startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            const ts = new Date().toISOString().slice(11, 19).replace(/:/g, '');
            const ext = (f.type || 'image/png').split('/')[1] || 'png';
            files.push(new File([f], `붙여넣기_${ts}.${ext}`, { type: f.type }));
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        this.spellCheck(files);
      }
    },

    // 이카운트 등록 (dryRun OR 실제)
    ecountMsg: '',
    async ecountRegister(docClass, dryRun) {
      this.ecountMsg = dryRun ? '⚙️ dry-run 검증 중...' : '🔴 이카운트 실제 등록 중... (취소 불가)';
      if (!dryRun) {
        if (!confirm(`이카운트에 ${docClass} ${(this.modeRows||[]).length}건 실제 등록합니다. 진행?`)) {
          this.ecountMsg = '';
          return;
        }
      }
      try {
        const saved = await this.saveModeRows({ silent: true });
        if (!saved) {
          this.ecountMsg = '저장할 명세서가 없습니다.';
          return;
        }
        const statementIds = [...new Set((this.modeRows || []).map(r => r.statement_id).filter(Boolean))];
        const r = await fetch('/api/statements/ecount/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docClass,
            month: this.filterMonth || null,
            dryRun,
            statementIds,
          }),
        }).then(r => r.json());
        if (r.ok && r.dryRun) {
          this.ecountMsg = `✅ dry-run 성공\n등록 대기: ${r.itemCount}건\n샘플:\n${JSON.stringify(r.sample, null, 2)}`;
        } else if (r.ok) {
          this.ecountMsg = `✅ 이카운트 등록 성공! ${r.itemCount}건\n응답: ${JSON.stringify(r.result?.raw || r.result, null, 2).slice(0, 500)}`;
          this.loadModeRows();
        } else {
          this.ecountMsg = `❌ 실패: ${r.error || '알 수 없음'}\n${JSON.stringify(r, null, 2).slice(0, 500)}`;
        }
      } catch (e) {
        this.ecountMsg = '❌ 호출 에러: ' + e.message;
      }
    },

    // 4분할 카드 헬퍼
    quadCount(company, cls) {
      const arr = this.stats.byQuadrant || [];
      if (company === null && cls === null) {
        return arr.filter(q => q.company === '미분류' || q.class === '미분류').reduce((a,b) => a + (b.n||0), 0);
      }
      const f = arr.find(q => q.company === company && q.class === cls);
      return f ? (f.n || 0) : 0;
    },
    quadPending(company, cls) {
      const arr = this.stats.pendingByQuadrant || [];
      const f = arr.find(q => q.company === company && q.class === cls);
      return f ? (f.n || 0) : 0;
    },

    async init() {
      await this.loadStats();
      await this.load();
      await this.loadPoolStats();
      this._entryHandler = (e) => {
        const d = e.detail || {};
        if (d.company) this.enterMode(d.company, d.cls || '매입');
      };
      window.addEventListener('statement-entry', this._entryHandler);
      if (window.__statementEntry?.company) {
        this.enterMode(window.__statementEntry.company, window.__statementEntry.cls || '매입');
      }
      // Ctrl+V 붙여넣기 (매입 MVP: 회사별 화면 안에서만 업로드)
      this._pasteHandler = (e) => {
        const forcedTarget = this.currentView === 'company-buy'
          ? { companyCode: 'COMPANY', docClass: '매입' }
          : (this.currentView === 'sm-buy' ? { companyCode: 'SM', docClass: '매입' } : null);
        // input/textarea 안에 있고 클립보드에 이미지 없으면 인터셉트 안 함
        const tg = e.target;
        const items = (e.clipboardData && e.clipboardData.items) || [];
        const imgFiles = [];
        for (const it of items) {
          if (it.type && it.type.startsWith('image/')) {
            const f = it.getAsFile();
            if (f) imgFiles.push(f);
          }
        }
        if (imgFiles.length === 0) return;  // 텍스트 붙여넣기는 그대로 통과
        if (!forcedTarget) {
          alert('먼저 컴퍼니 매입 또는 에스엠 매입 화면으로 들어간 뒤 사진을 붙여넣으세요.');
          return;
        }
        if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.contentEditable === 'true')) {
          // 폼 안이지만 이미지 있으면 → 업로드 (텍스트 input 에는 어차피 이미지 못 넣음)
        }
        e.preventDefault();
        // File 배열 → uploadFiles 호출
        const dt = new DataTransfer();
        for (const f of imgFiles) {
          // 카톡 사진처럼 보이는 이름 자동 부여
          const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
          const ext = (f.type === 'image/png') ? 'png' : 'jpg';
          const renamed = new File([f], `paste_${ts}.${ext}`, { type: f.type });
          dt.items.add(renamed);
        }
        this.uploadFiles(dt.files, forcedTarget);
      };
      document.addEventListener('paste', this._pasteHandler);
    },
    destroy() {
      if (this._pasteHandler) document.removeEventListener('paste', this._pasteHandler);
      if (this._entryHandler) window.removeEventListener('statement-entry', this._entryHandler);
    },
    async loadStats() {
      try { const r = await fetch('/api/statements/stats').then(r=>r.json()); if (r.ok) this.stats = r; } catch(e) {}
    },
    async load() {
      const params = new URLSearchParams();
      if (this.filterStatus) params.set('status', this.filterStatus);
      if (this.filterMonth) params.set('month', this.filterMonth);
      if (this.filterCompany) params.set('companyCode', this.filterCompany);
      if (this.filterClass) params.set('docClass', this.filterClass);
      if (this.searchQ.trim()) params.set('q', this.searchQ.trim());
      params.set('limit', this.limit);
      params.set('offset', this.offset);
      try {
        const r = await fetch('/api/statements/list?' + params).then(r=>r.json());
        if (r.ok) { this.items = r.items; this.total = r.total; }
      } catch(e) { console.error(e); }
    },

    async uploadFiles(fileList, opts = {}) {
      const files = Array.from(fileList);
      if (files.length === 0) return;
      const targetCompany = ['COMPANY', 'SM'].includes(opts.companyCode) ? opts.companyCode : '';
      const targetClass = opts.docClass === '매입' ? '매입' : '';
      if (!targetCompany || !targetClass) {
        alert('MVP에서는 컴퍼니 매입 또는 에스엠 매입 입구에서만 업로드할 수 있습니다.');
        return;
      }
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('companyCode', targetCompany);
      fd.append('docClass', targetClass);
      try {
        const r = await fetch('/api/statements/upload-batch', { method: 'POST', body: fd }).then(r=>r.json());
        if (r.ok) {
          this.queue = { ...this.queue, ...r.queue };
          this.startQueuePoll();
        }
      } catch(e) { alert('업로드 실패: '+e.message); }
    },

    startSplitFromFiles(fileList, companyCode = 'COMPANY', docClass = '매입') {
      const file = Array.from(fileList || []).find(f => (f.type || '').startsWith('image/'));
      if (!file) {
        alert('사진 파일을 선택하세요.');
        return;
      }
      this.openSplitTool(file, companyCode, docClass);
    },
    openSplitTool(file, companyCode = 'COMPANY', docClass = '매입') {
      this.closeSplitTool();
      const imageUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        this.split.image = img;
        this.split.msg = '사진 위에서 드래그해 명세서 영역을 잡으세요.';
      };
      img.src = imageUrl;
      this.split = {
        open: true,
        file,
        imageUrl,
        image: img,
        boxes: [],
        selectedIdx: -1,
        drawing: false,
        startX: 0,
        startY: 0,
        companyCode,
        docClass,
        msg: '원본 사진을 여는 중...',
      };
    },
    closeSplitTool(revoke = true) {
      if (revoke && this.split?.imageUrl) URL.revokeObjectURL(this.split.imageUrl);
      this.split = {
        open: false, file: null, imageUrl: '', image: null,
        boxes: [], selectedIdx: -1, drawing: false,
        startX: 0, startY: 0, msg: '',
        companyCode: 'COMPANY', docClass: '매입',
      };
    },
    splitPoint(e) {
      const img = this.$refs.splitImage;
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      return { x, y };
    },
    splitPointerDown(e) {
      if (!this.split.open || !this.split.imageUrl) return;
      const p = this.splitPoint(e);
      if (!p) return;
      this.split.drawing = true;
      this.split.startX = p.x;
      this.split.startY = p.y;
      this.split.boxes.push({ x: p.x, y: p.y, w: 0.001, h: 0.001 });
      this.split.selectedIdx = this.split.boxes.length - 1;
    },
    splitPointerMove(e) {
      if (!this.split.drawing || this.split.selectedIdx < 0) return;
      const p = this.splitPoint(e);
      if (!p) return;
      const x1 = Math.min(this.split.startX, p.x);
      const y1 = Math.min(this.split.startY, p.y);
      const x2 = Math.max(this.split.startX, p.x);
      const y2 = Math.max(this.split.startY, p.y);
      this.split.boxes[this.split.selectedIdx] = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    },
    splitPointerUp() {
      if (!this.split.drawing) return;
      const idx = this.split.selectedIdx;
      this.split.drawing = false;
      const b = this.split.boxes[idx];
      if (!b || b.w < 0.025 || b.h < 0.025) {
        this.split.boxes.splice(idx, 1);
        this.split.selectedIdx = this.split.boxes.length ? this.split.boxes.length - 1 : -1;
      }
    },
    splitBoxStyle(box) {
      return `left:${box.x * 100}%;top:${box.y * 100}%;width:${box.w * 100}%;height:${box.h * 100}%;`;
    },
    addFullSplitBox() {
      this.split.boxes.push({ x: 0.02, y: 0.02, w: 0.96, h: 0.96 });
      this.split.selectedIdx = this.split.boxes.length - 1;
    },
    removeSplitBox(idx = this.split.selectedIdx) {
      if (idx < 0) return;
      this.split.boxes.splice(idx, 1);
      this.split.selectedIdx = this.split.boxes.length ? Math.min(idx, this.split.boxes.length - 1) : -1;
    },
    clearSplitBoxes() {
      this.split.boxes = [];
      this.split.selectedIdx = -1;
    },
    async saveSplitCrops() {
      if (!this.split.file || !this.split.image || !this.split.image.naturalWidth) {
        alert('원본 사진을 아직 불러오는 중입니다.');
        return;
      }
      const boxes = (this.split.boxes || [])
        .filter(b => b.w > 0.025 && b.h > 0.025)
        .slice()
        .sort((a, b) => (a.y - b.y) || (a.x - b.x));
      if (!boxes.length) {
        alert('먼저 명세서 영역을 박스로 잡아주세요.');
        return;
      }
      const img = this.split.image;
      const base = (this.split.file.name || 'statement')
        .replace(/\.[^.]+$/, '')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .slice(0, 80);
      const files = [];
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const sx = Math.max(0, Math.round(b.x * img.naturalWidth));
        const sy = Math.max(0, Math.round(b.y * img.naturalHeight));
        const sw = Math.max(1, Math.round(b.w * img.naturalWidth));
        const sh = Math.max(1, Math.round(b.h * img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
        if (!blob) continue;
        const no = String(i + 1).padStart(2, '0');
        files.push(new File([blob], `${base}__crop_${no}.jpg`, { type: 'image/jpeg' }));
      }
      if (!files.length) {
        alert('분할 이미지를 만들지 못했습니다.');
        return;
      }
      this.split.msg = `${files.length}개 분할본을 OCR 큐에 넣는 중...`;
      await this.uploadFiles(files, {
        companyCode: this.split.companyCode,
        docClass: this.split.docClass,
      });
      this.closeSplitTool();
    },

    startQueuePoll() {
      if (this.queueTimer) return;
      this.queueTimer = setInterval(async () => {
        try {
          const r = await fetch('/api/statements/queue').then(r=>r.json());
          if (r.ok) {
            this.queue = r;
            // 끝나면 폴링 멈추고 목록 갱신
            if (r.processing === 0 && r.queueLen === 0 && r.total > 0) {
              clearInterval(this.queueTimer); this.queueTimer = null;
              await this.loadStats();
              await this.load();
              if (['company-buy', 'sm-buy'].includes(this.currentView)) await this.loadModeRows();
            }
          }
        } catch(e) {}
      }, 1500);
    },

    async openModal(id) {
      try {
        const r = await fetch('/api/statements/'+id).then(r=>r.json());
        if (r.ok) {
          this.selected = r.statement;
          this.edit = {
            doc_type: r.statement.doc_type || '',
            doc_class: r.statement.doc_class || '',
            company_code: r.statement.company_code || '',
            doc_date: r.statement.doc_date || '',
            norm_vendor: r.statement.norm_vendor || r.statement.vendor_name || '',
            vendor_biz_no: r.statement.vendor_biz_no || '',
            supply_amount: r.statement.supply_amount,
            vat_amount: r.statement.vat_amount,
            total_amount: r.statement.total_amount,
            notes: r.statement.notes || '',
            items: (r.statement.items || []).map(it => ({...it})),
          };
          this.saveMsg = '';
        }
      } catch(e) { alert(e.message); }
    },
    closeModal() { this.selected = null; this.saveMsg = ''; },
    workflowClass(wf) {
      if (!wf) return 'unknown';
      if ((wf.blockingCount || 0) > 0) return 'bad';
      if ((wf.warningCount || 0) > 0) return 'warn';
      return 'ok';
    },
    workflowLabel(wf) {
      if (!wf) return '검증 대기';
      if ((wf.blockingCount || 0) > 0) return `오류 ${wf.blockingCount}`;
      if ((wf.warningCount || 0) > 0) return `확인 ${wf.warningCount}`;
      return '통과';
    },
    issueClass(issue) {
      return issue?.severity === 'error' ? 'bad' : (issue?.severity === 'warning' ? 'warn' : 'info');
    },
    formatWorkflowIssues(wf) {
      const issues = wf?.issues || [];
      if (!issues.length) return '검증 통과';
      return issues.map((issue, idx) => `${idx + 1}. ${issue.message}`).join('\n');
    },
    addEditItem() {
      if (!Array.isArray(this.edit.items)) this.edit.items = [];
      this.edit.items.push({
        item_name: '',
        spec: '',
        quantity: 1,
        unit: '',
        unit_price: 0,
        amount: 0,
        vat: 0,
        notes: '',
      });
    },
    removeEditItem(idx) {
      if (!Array.isArray(this.edit.items)) return;
      this.edit.items.splice(idx, 1);
    },
    recalcEditItem(it) {
      const qty = Number(it.quantity) || 0;
      const price = Number(it.unit_price) || 0;
      if (qty && price) it.amount = Math.round(qty * price);
      it.vat = Math.round((Number(it.amount) || 0) * 0.1);
    },

    async save() {
      if (!this.selected) return;
      try {
        const r = await fetch('/api/statements/'+this.selected.id, {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(this.edit),
        }).then(r=>r.json());
        if (r.ok) {
          this.selected = r.statement;
          this.saveMsg = '저장됨';
          this.load();
        } else { this.saveMsg = '실패: '+r.error; }
      } catch(e) { this.saveMsg = '에러: '+e.message; }
    },
    async confirm(id) {
      const r = await fetch(`/api/statements/${id}/confirm`, {method:'POST'}).then(r => r.json());
      if (!r.ok) {
        if (this.selected?.id === id && r.workflow) this.selected.workflow = r.workflow;
        alert('확정할 수 없습니다.\n\n' + this.formatWorkflowIssues(r.workflow));
        return;
      }
      await this.load(); await this.loadStats();
      if (this.selected?.id === id) this.closeModal();
    },
    async reject(id) {
      await fetch(`/api/statements/${id}/reject`, {method:'POST'});
      await this.load(); await this.loadStats();
    },
    async reset(id) {
      // 다시 pending 으로 돌리기
      await fetch(`/api/statements/${id}/reset`, { method:'POST' });
      await this.load(); await this.loadStats();
    },
    async deleteStatement(id, status) {
      if (!id) return;
      const msg = status === 'rejected'
        ? '반려된 자료를 삭제할까요?\n삭제하면 목록과 원본 미리보기 파일도 함께 정리됩니다.'
        : '이 자료를 삭제할까요?\n확정 자료는 삭제되지 않습니다.';
      if (!confirm(msg)) return;
      try {
        const r = await fetch('/api/statements/' + id, { method: 'DELETE' }).then(r => r.json());
        if (!r.ok) {
          alert('삭제 실패: ' + (r.error || '알 수 없는 오류'));
          return;
        }
        if (this.selected?.id === id) this.closeModal();
        await this.load();
        await this.loadStats();
        if (this.currentView !== 'overview') await this.loadModeRows();
      } catch (e) {
        alert('삭제 오류: ' + e.message);
      }
    },
    async cleanupRejected() {
      const payload = {
        status: 'rejected',
        month: this.filterMonth || null,
        companyCode: this.filterCompany || null,
        docClass: this.filterClass || null,
        q: this.searchQ.trim() || '',
        dryRun: true,
      };
      try {
        const preview = await fetch('/api/statements/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json());
        if (!preview.ok) {
          alert('정리 실패: ' + (preview.error || '알 수 없는 오류'));
          return;
        }
        if (!preview.count) {
          alert('현재 조건에 삭제할 반려 자료가 없습니다.');
          return;
        }
        const scope = [
          this.filterMonth ? `월 ${this.filterMonth}` : null,
          this.filterCompany ? `회사 ${this.filterCompany}` : null,
          this.filterClass ? `구분 ${this.filterClass}` : null,
          this.searchQ.trim() ? `검색 "${this.searchQ.trim()}"` : null,
        ].filter(Boolean).join(' / ') || '전체 조건';
        if (!confirm(`${scope}\n반려 자료 ${preview.count}건을 삭제할까요?\n원본 파일 ${preview.fileCount || 0}개도 함께 정리됩니다.`)) return;
        const result = await fetch('/api/statements/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, dryRun: false }),
        }).then(r => r.json());
        if (!result.ok) {
          alert('정리 실패: ' + (result.error || '알 수 없는 오류'));
          return;
        }
        await this.load();
        await this.loadStats();
        if (this.currentView !== 'overview') await this.loadModeRows();
        alert(`반려 자료 ${result.deleted || 0}건 삭제 완료\n원본 파일 ${result.filesDeleted || 0}개 정리`);
      } catch (e) {
        alert('정리 오류: ' + e.message);
      }
    },
    async del() {
      await this.deleteStatement(this.selected?.id, this.selected?.status);
    },
  };
}
