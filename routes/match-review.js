/**
 * routes/match-review.js
 * 시안 매칭 검수 — 미매칭 케이스 + 슬라이드 이미지 + 매칭 시도 결과
 *
 * 엔드포인트:
 *   GET /api/match-review/list           — 미매칭 + 매칭 케이스 (필터/정렬)
 *   GET /api/match-review/image/:name    — 슬라이드 이미지 서빙
 *   POST /api/match-review/decision      — 사장님 검수 결과 저장 (체크/무시/매출누락 마크)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

const SLIDES_DIR = path.join(__dirname, '..', '_pptx_slides');
const RESULTS = path.join(SLIDES_DIR, '_rematch_results.jsonl');
const DECISIONS = path.join(SLIDES_DIR, '_match_decisions.json');

function loadDecisions() {
  if (!fs.existsSync(DECISIONS)) return {};
  try { return JSON.parse(fs.readFileSync(DECISIONS, 'utf8')); }
  catch (_) { return {}; }
}
function saveDecisions(d) {
  fs.writeFileSync(DECISIONS, JSON.stringify(d, null, 2));
}

function classifyFailure(item, frag, spec, mats, reason) {
  const f = String(frag || '').toLowerCase();
  if (spec && spec.includes('*')) {
    const parts = spec.split('*').map(Number);
    if (parts.length >= 2 && Math.max(parts[0]||0, parts[1]||0) <= 200) return '작은부속';
  }
  if (f.includes('시안 type') || f.includes('flag')) return '깃발 매출누락';
  if ((mats||[]).includes('후렉스') || /호이스트|후렉스/.test(f)) {
    if (spec && spec.includes('*')) {
      const parts = spec.split('*').map(Number);
      if ((parts[0]||0) >= 2000) return '호이스트 미매칭';
    }
  }
  if (reason === '사이즈 후보 없음') return '사이즈 학습풀누락';
  if (String(reason).includes('점수미달')) return 'fuzzy 점수미달';
  return '기타';
}

router.get('/list', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(RESULTS)) return res.json({ ok: true, items: [], summary: {} });
    const lines = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(l => l.trim());
    const decisions = loadDecisions();
    const items = [];
    let totalExtracted = 0, totalMatched = 0;
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch(_) { continue; }
      if (!j.rematch) continue;
      const site = j.rematch.matchedSite || '';
      for (let idx = 0; idx < j.rematch.matches.length; idx++) {
        const m = j.rematch.matches[idx];
        totalExtracted++;
        if (m.matched) totalMatched++;
        const key = `${j.image}#${idx}`;
        items.push({
          key,
          slide: j.image,
          imageUrl: `/api/match-review/image/${encodeURIComponent(j.image)}`,
          date: j.date,
          pptxCat: j.cat,
          site,
          ocrFragment: (m.ocrFragment || '').slice(0, 200),
          extractedSpec: m.extractedSpec,
          extractedMaterials: m.extractedMaterials || [],
          extractedQty: m.extractedQty,
          matched: m.matched ? {
            item: m.matched.item,
            spec: m.matched.spec,
            qty: m.matched.qty,
            price: m.matched.price,
            memoDetail: m.matched.memoDetail || '',
          } : null,
          score: m.score,
          reason: m.reason,
          failureKind: m.matched ? null : classifyFailure(j.image, m.ocrFragment, m.extractedSpec, m.extractedMaterials, m.reason),
          decision: decisions[key] || null,
        });
      }
    }
    // 카테고리별 요약
    const summary = {
      total: totalExtracted,
      matched: totalMatched,
      unmatched: totalExtracted - totalMatched,
      matchRate: totalExtracted ? +(totalMatched * 100 / totalExtracted).toFixed(1) : 0,
      byKind: {},
    };
    for (const it of items.filter(i => !i.matched)) {
      const k = it.failureKind || '기타';
      summary.byKind[k] = (summary.byKind[k] || 0) + 1;
    }
    res.json({ ok: true, items, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/image/:name', requireAuth, (req, res) => {
  try {
    const name = path.basename(req.params.name); // path traversal 방지
    const fp = path.join(SLIDES_DIR, name);
    if (!fs.existsSync(fp)) return res.status(404).send('Not found');
    res.sendFile(fp);
  } catch (e) {
    res.status(500).send('Error');
  }
});

router.post('/decision', requireAuth, express.json(), (req, res) => {
  try {
    const { key, decision, memo } = req.body || {};
    if (!key || !decision) return res.status(400).json({ ok: false, error: 'key/decision 필요' });
    const decisions = loadDecisions();
    decisions[key] = { decision, memo: memo || '', at: Date.now(), by: req.session?.userId || 'unknown' };
    saveDecisions(decisions);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
