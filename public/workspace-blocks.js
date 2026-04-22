/**
 * workspace-blocks.js — 워크스페이스 에디터용 커스텀 블록
 *
 * 현재 포함 블록:
 *  - DataTableTool ("데이터 표") : 노션 스타일 인라인 DB
 *    · 컬럼 타입: 텍스트 / 선택 / 날짜 / 숫자 / 체크
 *    · 인라인 편집 · 컬럼/행 추가·삭제 · select 선택지 관리
 *    · JSON 으로 Editor.js 블록 data 에 저장
 *
 *  - FormBlockTool ("입력 폼") : 간단 폼 + 제출 시 로컬 로그
 *    · 필드 타입: 텍스트 / 긴글 / 숫자 / 날짜 / 선택
 *    · 제출 버튼 → entries[] 에 추가 (페이지 저장 시 함께 저장)
 *    · "제출 기록" 테이블로 최근 5건 확인 가능
 *
 * Editor.js 2.29.x API 사용. UMD 로드 후 window.DataTableTool / window.FormBlockTool 로 노출.
 */
(function (global) {
  'use strict';

  // ── 공통 유틸 ────────────────────────────────────────────────
  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // 팝업 메뉴 공용 닫기 (열려 있는 메뉴 하나만 유지)
  function closeAllMenus() {
    document.querySelectorAll('.wsb-menu').forEach(m => m.remove());
  }

  // 공용 CSS 1회만 주입
  function injectStyleOnce() {
    if (document.getElementById('wsb-style')) return;
    const css = `
/* ── 공통 ── */
.wsb-menu { position: fixed; z-index: 9999; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 32px rgba(0,0,0,.12); padding: 4px; min-width: 180px; display: flex; flex-direction: column; }
.wsb-menu-label { font-size: 10.5px; color: #9ca3af; padding: 6px 8px 4px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
.wsb-menu-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12.5px; color: #374151; background: none; border: none; border-radius: 6px; cursor: pointer; text-align: left; font-family: inherit; }
.wsb-menu-item:hover { background: #f3f4f6; }
.wsb-menu-item.active { background: #eef2ff; color: #4338ca; font-weight: 600; }
.wsb-menu-item .icon { font-size: 13px; width: 16px; display: inline-block; text-align: center; color: #6b7280; }
.wsb-menu-item.danger { color: #dc2626; }
.wsb-menu-item.danger:hover { background: #fef2f2; }
.wsb-menu-divider { height: 1px; background: #f0f1f3; margin: 4px 0; }

/* ── 데이터 표 (Table) ── */
.dtbl-wrap { margin: 8px 0; border-radius: 10px; overflow: hidden; }
.dtbl { border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; overflow: auto; max-width: 100%; }
.dtbl-row { display: flex; border-bottom: 1px solid #f0f1f3; position: relative; }
.dtbl-row:last-child { border-bottom: none; }
.dtbl-row.dtbl-header { background: #fafbfd; font-weight: 600; }
.dtbl-cell { flex: 1; min-width: 120px; padding: 6px 10px; border-right: 1px solid #f0f1f3; display: flex; align-items: center; gap: 6px; font-size: 13px; }
.dtbl-cell:last-of-type { border-right: none; }
.dtbl-hcell { color: #374151; position: relative; }
.dtbl-hicon { font-size: 11px; color: #9ca3af; width: 14px; display: inline-block; text-align: center; flex-shrink: 0; }
.dtbl-hname { flex: 1; outline: none; font-size: 12.5px; font-weight: 600; min-width: 20px; }
.dtbl-hname:focus { background: #f3f4f6; border-radius: 4px; padding: 2px 4px; }
.dtbl-hmenu { opacity: 0; background: none; border: none; color: #9ca3af; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 14px; line-height: 1; font-family: inherit; }
.dtbl-hmenu:hover { background: #eef2ff; color: #4338ca; }
.dtbl-hcell:hover .dtbl-hmenu { opacity: 1; }
.dtbl-text { flex: 1; outline: none; min-height: 18px; padding: 2px 4px; border-radius: 3px; font-size: 13px; line-height: 1.4; word-break: break-word; }
.dtbl-text:focus { background: #f3f4f6; }
.dtbl-input { flex: 1; border: none; outline: none; background: transparent; font-size: 13px; font-family: inherit; padding: 2px 4px; border-radius: 3px; color: #374151; }
.dtbl-input:focus { background: #f3f4f6; }
.dtbl-input.dtbl-num { text-align: right; }
.dtbl-select { flex: 1; border: none; outline: none; background: transparent; font-size: 13px; font-family: inherit; padding: 2px 4px; cursor: pointer; color: #374151; }
.dtbl-select:focus { background: #f3f4f6; border-radius: 3px; }
.dtbl-row-del { position: absolute; right: -22px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; background: #fff; border: 1px solid #fecaca; color: #dc2626; border-radius: 50%; font-size: 11px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity .1s; padding: 0; font-family: inherit; }
.dtbl-row:hover .dtbl-row-del { opacity: 1; }
.dtbl-row-del:hover { background: #fef2f2; }
.dtbl-add-col { width: 32px; background: #fafbfd; border: none; border-left: 1px solid #f0f1f3; color: #9ca3af; cursor: pointer; font-size: 16px; padding: 0; font-family: inherit; }
.dtbl-add-col:hover { background: #eef2ff; color: #4338ca; }
.dtbl-add-row { width: 100%; padding: 8px; background: #fafbfd; border: none; border-top: 1px dashed #e5e7eb; color: #6b7280; cursor: pointer; font-size: 12px; font-family: inherit; text-align: left; padding-left: 14px; }
.dtbl-add-row:hover { background: #eef2ff; color: #4338ca; }
.dtbl-empty { padding: 4px 8px; color: #d1d5db; font-size: 13px; }

/* ── 입력 폼 (Form) ── */
.wfrm-wrap { margin: 8px 0; padding: 16px; border: 1px solid #e5e7eb; border-radius: 12px; background: linear-gradient(180deg, #fff, #fafbfd); }
.wfrm-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.wfrm-title { flex: 1; font-size: 15px; font-weight: 700; color: #1a1d23; border: none; outline: none; background: transparent; font-family: inherit; padding: 2px 4px; border-radius: 4px; }
.wfrm-title:focus { background: #f3f4f6; }
.wfrm-menu-btn { background: none; border: none; color: #9ca3af; cursor: pointer; padding: 4px 8px; border-radius: 6px; font-size: 14px; font-family: inherit; }
.wfrm-menu-btn:hover { background: #f3f4f6; color: #4338ca; }
.wfrm-fields { display: flex; flex-direction: column; gap: 8px; }
.wfrm-field { display: flex; flex-direction: column; gap: 4px; position: relative; }
.wfrm-field-row { display: flex; align-items: center; gap: 6px; }
.wfrm-label { font-size: 12px; color: #4b5563; font-weight: 600; outline: none; flex: 1; padding: 2px 4px; border-radius: 3px; }
.wfrm-label:focus { background: #f3f4f6; }
.wfrm-type-badge { font-size: 10px; color: #6b7280; background: #eef2ff; padding: 1px 6px; border-radius: 99px; font-weight: 600; }
.wfrm-field-tools { display: flex; gap: 2px; opacity: 0; }
.wfrm-field:hover .wfrm-field-tools { opacity: 1; }
.wfrm-field-tool { background: none; border: none; color: #9ca3af; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: inherit; }
.wfrm-field-tool:hover { background: #eef2ff; color: #4338ca; }
.wfrm-input { padding: 7px 10px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 13px; outline: none; font-family: inherit; background: #fff; }
.wfrm-input:focus { border-color: #4f6ef7; }
.wfrm-textarea { min-height: 60px; resize: vertical; padding: 8px 10px; border: 1px solid #e5e7eb; border-radius: 8px; font-size: 13px; outline: none; font-family: inherit; background: #fff; }
.wfrm-textarea:focus { border-color: #4f6ef7; }
.wfrm-add-field { padding: 7px; background: #fff; border: 1px dashed #c7d2fe; border-radius: 8px; color: #4338ca; cursor: pointer; font-size: 12px; font-family: inherit; margin-top: 6px; font-weight: 600; }
.wfrm-add-field:hover { background: #eef2ff; }
.wfrm-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px dashed #e5e7eb; }
.wfrm-submit { padding: 8px 18px; background: linear-gradient(135deg, #4f6ef7, #3b5ce4); color: #fff; border: none; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: inherit; }
.wfrm-submit:hover { filter: brightness(1.06); }
.wfrm-submit-hint { font-size: 11px; color: #9ca3af; }
.wfrm-entries { margin-top: 12px; padding: 10px 12px; background: #f8f9fb; border: 1px solid #f0f1f3; border-radius: 8px; }
.wfrm-entries-title { font-size: 11px; font-weight: 700; color: #6b7280; margin-bottom: 6px; }
.wfrm-entry { font-size: 11.5px; color: #4b5563; padding: 4px 0; border-top: 1px dashed #f0f1f3; }
.wfrm-entry:first-of-type { border-top: none; }
.wfrm-entry time { color: #9ca3af; margin-right: 6px; }
.wfrm-toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1a1d23; color: #fff; padding: 10px 18px; border-radius: 10px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,.2); z-index: 10000; animation: wfrmToast .3s; }
@keyframes wfrmToast { from { opacity: 0; transform: translate(-50%, 10px); } to { opacity: 1; transform: translate(-50%, 0); } }
`;
    const s = document.createElement('style');
    s.id = 'wsb-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ═════════════════════════════════════════════════════════════
  // DataTableTool — 노션 스타일 인라인 DB 블록
  // ═════════════════════════════════════════════════════════════
  const TBL_TYPES = {
    text:     { label: '텍스트', icon: 'T'  },
    select:   { label: '선택',   icon: '▾'  },
    date:     { label: '날짜',   icon: '📅' },
    number:   { label: '숫자',   icon: '#'  },
    checkbox: { label: '체크',   icon: '☑'  }
  };

  class DataTableTool {
    static get toolbox() {
      return {
        title: '데이터 표',
        icon: '<svg width="17" height="15" viewBox="0 0 17 15"><g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="15" height="13"/><path d="M1 5h15M1 10h15M6 1v13M11 1v13"/></g></svg>'
      };
    }
    static get isReadOnlySupported() { return true; }
    static get sanitize() { return { columns: false, rows: false }; }

    constructor({ data, api, readOnly }) {
      injectStyleOnce();
      this.api = api;
      this.readOnly = !!readOnly;
      this.data = this._normalize(data);
    }

    _normalize(data) {
      data = data || {};
      let columns = Array.isArray(data.columns) ? data.columns.slice() : [];
      let rows = Array.isArray(data.rows) ? data.rows.slice() : [];
      // 컬럼 구조 정규화 (id 누락 보정, 타입 검증)
      columns = columns.map(c => ({
        id: c.id || uid('col'),
        name: typeof c.name === 'string' ? c.name : '컬럼',
        type: TBL_TYPES[c.type] ? c.type : 'text',
        options: Array.isArray(c.options) ? c.options.slice() : (c.type === 'select' ? [] : undefined)
      }));
      // 기본 컬럼 (신규 블록)
      if (columns.length === 0) {
        columns = [
          { id: uid('col'), name: '항목',  type: 'text' },
          { id: uid('col'), name: '상태',  type: 'select', options: ['진행', '완료', '대기'] },
          { id: uid('col'), name: '마감일', type: 'date' }
        ];
      }
      // 기본 행
      if (rows.length === 0) rows = [{}, {}, {}];
      return { columns, rows };
    }

    render() {
      this.wrapper = el('div', 'dtbl-wrap');
      this._renderAll();
      return this.wrapper;
    }

    _renderAll() {
      this.wrapper.innerHTML = '';
      const table = el('div', 'dtbl');

      // 헤더
      const header = el('div', 'dtbl-row dtbl-header');
      this.data.columns.forEach((col, ci) => header.appendChild(this._renderHeaderCell(col, ci)));
      if (!this.readOnly) {
        const addCol = el('button', 'dtbl-add-col', '+');
        addCol.title = '컬럼 추가';
        addCol.addEventListener('click', (e) => { e.stopPropagation(); this._addColumn(); });
        header.appendChild(addCol);
      }
      table.appendChild(header);

      // 데이터 행
      this.data.rows.forEach((row, ri) => {
        const rowEl = el('div', 'dtbl-row');
        this.data.columns.forEach(col => rowEl.appendChild(this._renderCell(col, row)));
        if (!this.readOnly) {
          const del = el('button', 'dtbl-row-del', '×');
          del.title = '행 삭제';
          del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteRow(ri); });
          rowEl.appendChild(del);
        }
        table.appendChild(rowEl);
      });

      // 행 추가
      if (!this.readOnly) {
        const addRow = el('button', 'dtbl-add-row', '+ 행 추가');
        addRow.addEventListener('click', (e) => { e.stopPropagation(); this._addRow(); });
        table.appendChild(addRow);
      }
      this.wrapper.appendChild(table);
    }

    _renderHeaderCell(col, ci) {
      const cell = el('div', 'dtbl-cell dtbl-hcell');
      const icon = el('span', 'dtbl-hicon', (TBL_TYPES[col.type] || TBL_TYPES.text).icon);
      const name = el('span', 'dtbl-hname');
      name.textContent = col.name;
      cell.appendChild(icon);
      cell.appendChild(name);

      if (!this.readOnly) {
        name.contentEditable = 'true';
        name.addEventListener('blur', () => {
          col.name = (name.textContent || '').trim() || '컬럼';
        });
        name.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
        });
        const btn = el('button', 'dtbl-hmenu', '⋮');
        btn.title = '컬럼 설정';
        btn.addEventListener('click', (e) => { e.stopPropagation(); this._openColumnMenu(col, ci, btn); });
        cell.appendChild(btn);
      }
      return cell;
    }

    _renderCell(col, row) {
      const cell = el('div', 'dtbl-cell');
      const val = row[col.id];
      switch (col.type) {
        case 'checkbox': {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = !!val;
          cb.disabled = this.readOnly;
          cb.addEventListener('change', () => { row[col.id] = cb.checked; });
          cell.appendChild(cb);
          break;
        }
        case 'select': {
          const sel = document.createElement('select');
          sel.className = 'dtbl-select';
          sel.disabled = this.readOnly;
          const blank = document.createElement('option');
          blank.value = ''; blank.textContent = '—';
          sel.appendChild(blank);
          (col.options || []).forEach(opt => {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            if (val === opt) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener('change', () => { row[col.id] = sel.value; });
          cell.appendChild(sel);
          break;
        }
        case 'date': {
          const inp = document.createElement('input');
          inp.type = 'date';
          inp.className = 'dtbl-input';
          inp.value = val || '';
          inp.readOnly = this.readOnly;
          inp.addEventListener('change', () => { row[col.id] = inp.value; });
          cell.appendChild(inp);
          break;
        }
        case 'number': {
          const inp = document.createElement('input');
          inp.type = 'number';
          inp.className = 'dtbl-input dtbl-num';
          inp.value = (val === 0 || val) ? val : '';
          inp.readOnly = this.readOnly;
          inp.addEventListener('input', () => {
            row[col.id] = inp.value === '' ? null : Number(inp.value);
          });
          cell.appendChild(inp);
          break;
        }
        default: {
          const span = el('span', 'dtbl-text');
          span.textContent = val || '';
          if (!this.readOnly) span.contentEditable = 'true';
          span.addEventListener('blur', () => { row[col.id] = (span.textContent || '').trim(); });
          span.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); span.blur(); }
          });
          cell.appendChild(span);
        }
      }
      return cell;
    }

    _addRow() { this.data.rows.push({}); this._renderAll(); }

    _deleteRow(ri) {
      if (this.data.rows.length <= 1) {
        this.data.rows[ri] = {}; // 마지막 1행은 유지, 값만 비움
      } else {
        this.data.rows.splice(ri, 1);
      }
      this._renderAll();
    }

    _addColumn() {
      const name = (prompt('새 컬럼 이름:', '새 컬럼') || '').trim();
      if (!name) return;
      this.data.columns.push({ id: uid('col'), name, type: 'text' });
      this._renderAll();
    }

    _openColumnMenu(col, ci, anchor) {
      closeAllMenus();
      const menu = el('div', 'wsb-menu');
      const rect = anchor.getBoundingClientRect();
      menu.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
      menu.style.top  = (rect.bottom + 4) + 'px';

      menu.appendChild(el('div', 'wsb-menu-label', '유형 변경'));
      Object.entries(TBL_TYPES).forEach(([type, info]) => {
        const item = el('button', 'wsb-menu-item' + (col.type === type ? ' active' : ''));
        item.innerHTML = `<span class="icon">${info.icon}</span> ${esc(info.label)}`;
        item.addEventListener('click', () => {
          col.type = type;
          if (type === 'select' && !Array.isArray(col.options)) col.options = [];
          closeAllMenus();
          this._renderAll();
        });
        menu.appendChild(item);
      });

      if (col.type === 'select') {
        menu.appendChild(el('div', 'wsb-menu-divider'));
        const editOpts = el('button', 'wsb-menu-item');
        editOpts.innerHTML = '<span class="icon">✎</span> 선택지 편집';
        editOpts.addEventListener('click', () => {
          const curr = (col.options || []).join('\n');
          const input = prompt('선택지를 줄 단위로 입력 (빈 줄 무시):', curr);
          if (input === null) return;
          col.options = input.split('\n').map(s => s.trim()).filter(Boolean);
          closeAllMenus();
          this._renderAll();
        });
        menu.appendChild(editOpts);
      }

      menu.appendChild(el('div', 'wsb-menu-divider'));
      const del = el('button', 'wsb-menu-item danger');
      del.innerHTML = '<span class="icon">🗑</span> 컬럼 삭제';
      del.addEventListener('click', () => {
        if (this.data.columns.length <= 1) { alert('최소 1개의 컬럼이 필요합니다.'); return; }
        if (!confirm('"' + col.name + '" 컬럼을 삭제하시겠습니까?')) return;
        this.data.columns.splice(ci, 1);
        this.data.rows.forEach(r => delete r[col.id]);
        closeAllMenus();
        this._renderAll();
      });
      menu.appendChild(del);

      document.body.appendChild(menu);
      setTimeout(() => {
        const onClickAway = (e) => {
          if (!menu.contains(e.target) && e.target !== anchor) {
            menu.remove();
            document.removeEventListener('mousedown', onClickAway, true);
          }
        };
        document.addEventListener('mousedown', onClickAway, true);
      }, 0);
    }

    save() { return { columns: this.data.columns, rows: this.data.rows }; }

    validate(data) {
      return !!(data && Array.isArray(data.columns) && Array.isArray(data.rows));
    }
  }

  // ═════════════════════════════════════════════════════════════
  // FormBlockTool — 폼 블록 (제출 → entries[] 누적)
  // ═════════════════════════════════════════════════════════════
  const FRM_TYPES = {
    text:     { label: '한 줄',   badge: '텍스트' },
    textarea: { label: '긴 글',   badge: '긴글'   },
    number:   { label: '숫자',    badge: '숫자'   },
    date:     { label: '날짜',    badge: '날짜'   },
    select:   { label: '선택',    badge: '선택'   }
  };

  class FormBlockTool {
    static get toolbox() {
      return {
        title: '입력 폼',
        icon: '<svg width="17" height="15" viewBox="0 0 17 15"><g fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="1" width="15" height="4" rx="1"/><rect x="1" y="7" width="15" height="4" rx="1"/><path d="M1 13h9"/></g></svg>'
      };
    }
    static get isReadOnlySupported() { return true; }
    static get sanitize() { return { title: {}, fields: false, entries: false }; }

    constructor({ data, api, readOnly }) {
      injectStyleOnce();
      this.api = api;
      this.readOnly = !!readOnly;
      this.data = this._normalize(data);
    }

    _normalize(data) {
      data = data || {};
      let fields = Array.isArray(data.fields) ? data.fields.slice() : [];
      fields = fields.map(f => ({
        id: f.id || uid('fld'),
        label: typeof f.label === 'string' ? f.label : '항목',
        type: FRM_TYPES[f.type] ? f.type : 'text',
        options: Array.isArray(f.options) ? f.options.slice() : (f.type === 'select' ? [] : undefined),
        placeholder: typeof f.placeholder === 'string' ? f.placeholder : ''
      }));
      if (fields.length === 0) {
        fields = [
          { id: uid('fld'), label: '이름',   type: 'text',     placeholder: '홍길동' },
          { id: uid('fld'), label: '내용',   type: 'textarea', placeholder: '내용을 입력하세요' }
        ];
      }
      return {
        title: typeof data.title === 'string' ? data.title : '입력 폼',
        fields,
        entries: Array.isArray(data.entries) ? data.entries.slice() : []
      };
    }

    render() {
      this.wrapper = el('div', 'wfrm-wrap');
      this._renderAll();
      return this.wrapper;
    }

    _renderAll() {
      this.wrapper.innerHTML = '';

      // 헤더 (폼 제목)
      const head = el('div', 'wfrm-head');
      const title = document.createElement('input');
      title.className = 'wfrm-title';
      title.value = this.data.title;
      title.readOnly = this.readOnly;
      title.placeholder = '폼 제목';
      title.addEventListener('change', () => { this.data.title = title.value.trim() || '입력 폼'; });
      head.appendChild(title);
      this.wrapper.appendChild(head);

      // 필드들
      const fieldsEl = el('div', 'wfrm-fields');
      this.data.fields.forEach((f, fi) => fieldsEl.appendChild(this._renderField(f, fi)));
      this.wrapper.appendChild(fieldsEl);

      if (!this.readOnly) {
        const addBtn = el('button', 'wfrm-add-field', '＋ 필드 추가');
        addBtn.addEventListener('click', (e) => { e.stopPropagation(); this._addField(); });
        this.wrapper.appendChild(addBtn);
      }

      // 하단 제출 행
      const foot = el('div', 'wfrm-foot');
      const submit = el('button', 'wfrm-submit', '제출');
      submit.addEventListener('click', (e) => { e.stopPropagation(); this._submit(); });
      foot.appendChild(submit);
      const hint = el('span', 'wfrm-submit-hint',
        '제출 시 페이지에 기록되며, 페이지 저장 시 함께 저장됩니다.');
      foot.appendChild(hint);
      this.wrapper.appendChild(foot);

      // 최근 제출 기록 (최대 5건)
      if (this.data.entries && this.data.entries.length) {
        const box = el('div', 'wfrm-entries');
        box.appendChild(el('div', 'wfrm-entries-title',
          `최근 제출 ${this.data.entries.length}건 (최신순)`));
        this.data.entries.slice(0, 5).forEach(entry => {
          const line = el('div', 'wfrm-entry');
          const t = document.createElement('time');
          t.textContent = (entry.at || '').slice(0, 16).replace('T', ' ');
          line.appendChild(t);
          const parts = this.data.fields
            .map(f => `${f.label}: ${entry.values && entry.values[f.id] != null ? entry.values[f.id] : '—'}`)
            .join(' · ');
          line.appendChild(document.createTextNode(parts));
          box.appendChild(line);
        });
        this.wrapper.appendChild(box);
      }
    }

    _renderField(f, fi) {
      const field = el('div', 'wfrm-field');
      // 라벨 + 타입 뱃지 + 도구
      const labelRow = el('div', 'wfrm-field-row');
      const labelEl = el('span', 'wfrm-label');
      labelEl.textContent = f.label;
      if (!this.readOnly) labelEl.contentEditable = 'true';
      labelEl.addEventListener('blur', () => { f.label = (labelEl.textContent || '').trim() || '항목'; });
      labelEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); labelEl.blur(); }
      });
      labelRow.appendChild(labelEl);
      labelRow.appendChild(el('span', 'wfrm-type-badge', (FRM_TYPES[f.type] || FRM_TYPES.text).badge));
      if (!this.readOnly) {
        const tools = el('div', 'wfrm-field-tools');
        const typeBtn = el('button', 'wfrm-field-tool', '유형');
        typeBtn.addEventListener('click', (e) => { e.stopPropagation(); this._openFieldMenu(f, fi, typeBtn); });
        const delBtn = el('button', 'wfrm-field-tool', '×');
        delBtn.title = '필드 삭제';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.data.fields.length <= 1) { alert('최소 1개의 필드가 필요합니다.'); return; }
          if (!confirm('"' + f.label + '" 필드를 삭제하시겠습니까?')) return;
          this.data.fields.splice(fi, 1);
          this._renderAll();
        });
        tools.appendChild(typeBtn);
        tools.appendChild(delBtn);
        labelRow.appendChild(tools);
      }
      field.appendChild(labelRow);

      // 입력 요소 (제출용 값을 field._val 에 임시 저장)
      let input;
      switch (f.type) {
        case 'textarea':
          input = document.createElement('textarea');
          input.className = 'wfrm-textarea';
          break;
        case 'number':
          input = document.createElement('input');
          input.type = 'number';
          input.className = 'wfrm-input';
          break;
        case 'date':
          input = document.createElement('input');
          input.type = 'date';
          input.className = 'wfrm-input';
          break;
        case 'select':
          input = document.createElement('select');
          input.className = 'wfrm-input';
          const blank = document.createElement('option');
          blank.value = ''; blank.textContent = '선택하세요';
          input.appendChild(blank);
          (f.options || []).forEach(opt => {
            const o = document.createElement('option');
            o.value = opt; o.textContent = opt;
            input.appendChild(o);
          });
          break;
        default:
          input = document.createElement('input');
          input.type = 'text';
          input.className = 'wfrm-input';
      }
      if (f.placeholder && f.type !== 'select') input.placeholder = f.placeholder;
      input.disabled = this.readOnly;
      input.addEventListener('input', () => { f._val = input.value; });
      input.addEventListener('change', () => { f._val = input.value; });
      field.appendChild(input);
      return field;
    }

    _openFieldMenu(f, fi, anchor) {
      closeAllMenus();
      const menu = el('div', 'wsb-menu');
      const rect = anchor.getBoundingClientRect();
      menu.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
      menu.style.top  = (rect.bottom + 4) + 'px';

      menu.appendChild(el('div', 'wsb-menu-label', '필드 유형'));
      Object.entries(FRM_TYPES).forEach(([type, info]) => {
        const item = el('button', 'wsb-menu-item' + (f.type === type ? ' active' : ''));
        item.textContent = info.label;
        item.addEventListener('click', () => {
          f.type = type;
          if (type === 'select' && !Array.isArray(f.options)) f.options = [];
          closeAllMenus();
          this._renderAll();
        });
        menu.appendChild(item);
      });
      if (f.type === 'select') {
        menu.appendChild(el('div', 'wsb-menu-divider'));
        const editOpts = el('button', 'wsb-menu-item');
        editOpts.textContent = '선택지 편집';
        editOpts.addEventListener('click', () => {
          const curr = (f.options || []).join('\n');
          const input = prompt('선택지를 줄 단위로 입력:', curr);
          if (input === null) return;
          f.options = input.split('\n').map(s => s.trim()).filter(Boolean);
          closeAllMenus();
          this._renderAll();
        });
        menu.appendChild(editOpts);
      }
      if (!this.readOnly) {
        menu.appendChild(el('div', 'wsb-menu-divider'));
        const placeholder = el('button', 'wsb-menu-item');
        placeholder.textContent = '안내문 설정';
        placeholder.addEventListener('click', () => {
          const input = prompt('입력란에 표시할 안내문:', f.placeholder || '');
          if (input === null) return;
          f.placeholder = input;
          closeAllMenus();
          this._renderAll();
        });
        menu.appendChild(placeholder);
      }
      document.body.appendChild(menu);
      setTimeout(() => {
        const onClickAway = (e) => {
          if (!menu.contains(e.target) && e.target !== anchor) {
            menu.remove();
            document.removeEventListener('mousedown', onClickAway, true);
          }
        };
        document.addEventListener('mousedown', onClickAway, true);
      }, 0);
    }

    _addField() {
      const label = (prompt('새 필드 이름:', '항목') || '').trim();
      if (!label) return;
      this.data.fields.push({ id: uid('fld'), label, type: 'text', placeholder: '' });
      this._renderAll();
    }

    _submit() {
      // 현재 입력값 수집
      const values = {};
      let hasValue = false;
      this.data.fields.forEach(f => {
        const v = f._val != null ? f._val : '';
        values[f.id] = v;
        if (v !== '' && v !== null) hasValue = true;
      });
      if (!hasValue) {
        this._toast('내용을 입력해주세요.');
        return;
      }
      this.data.entries.unshift({ at: new Date().toISOString(), values });
      // 최대 100건만 유지 (용량 관리)
      if (this.data.entries.length > 100) this.data.entries.length = 100;
      // 필드 값 초기화
      this.data.fields.forEach(f => { delete f._val; });
      this._renderAll();
      this._toast('제출되었습니다. 페이지가 저장될 때 기록도 함께 저장됩니다.');
      // Editor.js 변경 감지 수동 트리거 (blocks.save 호출 등)
      try { if (this.api && this.api.blocks && this.api.blocks.getCurrentBlockIndex) this.api.saver && this.api.saver.save(); } catch(e) {}
    }

    _toast(msg) {
      const t = el('div', 'wfrm-toast', msg);
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 2500);
    }

    save() {
      // 임시 _val 필드는 제외
      const fields = this.data.fields.map(f => {
        const { _val, ...rest } = f;
        return rest;
      });
      return { title: this.data.title, fields, entries: this.data.entries };
    }

    validate(data) {
      return !!(data && Array.isArray(data.fields));
    }
  }

  // ── 전역 노출 ─────────────────────────────────────────────────
  global.DataTableTool = DataTableTool;
  global.FormBlockTool = FormBlockTool;

  // Editor.js 가 변경 감지하도록 — 사용자 입력 후 onChange 을 수동으로
  // 트리거할 때 참고할 수 있는 헬퍼. (현재는 에디터 자체 이벤트만으로 충분)
})(window);
