// ═══════════════════════════════════════════════
// OCR 텍스트 추출 — Claude Vision 기반
// index.html 에서 x-data="ocrApp()" 으로 사용
// ═══════════════════════════════════════════════
function ocrApp() {
  return {
    imageFile: null,
    imagePreview: null,
    mode: 'plain',
    loading: false,
    elapsed: 0,
    _timer: null,
    resultText: '',
    durationMs: 0,
    errorMsg: '',
    dragOver: false,
    history: [],

    init() {
      // 세션 동안 history 유지
      try {
        const saved = sessionStorage.getItem('ocr:history');
        if (saved) this.history = JSON.parse(saved);
      } catch(_) {}
    },

    onFileSelect(e) {
      const f = e.target.files && e.target.files[0];
      if (f) this.acceptFile(f);
      e.target.value = '';
    },
    onDrop(e) {
      this.dragOver = false;
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.acceptFile(f);
    },
    onPaste(e) {
      // Ctrl+V 로 클립보드 이미지 붙여넣기
      if (!e.clipboardData || !e.clipboardData.items) return;
      for (const item of e.clipboardData.items) {
        if (item.type && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            this.acceptFile(f);
            e.preventDefault();
            break;
          }
        }
      }
    },
    acceptFile(file) {
      if (!file.type.startsWith('image/')) {
        this.errorMsg = '이미지 파일만 가능합니다 (PNG/JPG/WebP)';
        return;
      }
      if (file.size > 20 * 1024 * 1024) {
        this.errorMsg = '20MB 초과 — 더 작은 이미지로';
        return;
      }
      this.errorMsg = '';
      this.imageFile = file;
      const reader = new FileReader();
      reader.onload = (e) => { this.imagePreview = e.target.result; };
      reader.readAsDataURL(file);
    },
    clearImage() {
      this.imageFile = null;
      this.imagePreview = null;
      this.resultText = '';
      this.errorMsg = '';
      this.durationMs = 0;
    },

    async runOcr() {
      if (!this.imageFile || this.loading) return;
      this.loading = true;
      this.resultText = '';
      this.errorMsg = '';
      this.elapsed = 0;
      this._timer = setInterval(() => { this.elapsed++; }, 1000);

      try {
        const fd = new FormData();
        fd.append('image', this.imageFile);
        fd.append('mode', this.mode);

        const r = await fetch('/api/ai/ocr', { method:'POST', body: fd });
        const d = await r.json();
        if (d.ok) {
          this.resultText = d.text || '(추출된 텍스트 없음)';
          this.durationMs = d.durationMs || 0;
          // 히스토리에 추가
          this.history.unshift({
            preview: this.imagePreview,
            text: this.resultText,
            mode: this.mode,
            timeAgo: '방금',
            ts: Date.now(),
          });
          this.history = this.history.slice(0, 5);
          try { sessionStorage.setItem('ocr:history', JSON.stringify(this.history)); } catch(_) {}
        } else {
          this.errorMsg = '❌ ' + (d.error || '추출 실패');
        }
      } catch (e) {
        this.errorMsg = '❌ 네트워크 오류: ' + e.message;
      } finally {
        this.loading = false;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
      }
    },

    async copyResult() {
      if (!this.resultText) return;
      try {
        await navigator.clipboard.writeText(this.resultText);
        this._showCopiedBriefly();
      } catch(_) {
        // 폴백
        const ta = document.createElement('textarea');
        ta.value = this.resultText;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this._showCopiedBriefly();
      }
    },
    _showCopiedBriefly() {
      const t = document.createElement('div');
      t.textContent = '✅ 클립보드에 복사됨';
      t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;padding:8px 18px;border-radius:8px;font-size:12px;font-weight:600;z-index:9999;box-shadow:0 4px 12px rgba(16,185,129,.3);';
      document.body.appendChild(t);
      setTimeout(() => { t.remove(); }, 1500);
    },

    downloadResult() {
      if (!this.resultText) return;
      const blob = new Blob([this.resultText], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ocr_' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.txt';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    },

    restoreFromHistory(h) {
      this.imagePreview = h.preview;
      this.imageFile = null;
      this.resultText = h.text;
      this.mode = h.mode || 'plain';
    },
  };
}
