/**
 * routes/ai-ocr.js — Claude Vision 으로 이미지에서 텍스트 추출
 * Mounted at: app.use('/api/ai/ocr', require('./routes/ai-ocr'))
 *
 * POST /          — 이미지 업로드 → 추출 텍스트 반환
 *   body (multipart): image=<file>, mode=plain|table|numbers|translate
 *
 * Claude CLI 가 Read tool 로 이미지 파일을 읽음 (vision 자동).
 * API 모드 가능하면 직접 multimodal Messages API 호출.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const claudeClient = require('../lib/claude-client');

// 업로드 디렉토리
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'ocr-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ts = Date.now();
      const rand = crypto.randomBytes(3).toString('hex');
      const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
      cb(null, `ocr_${ts}_${rand}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

// 모드별 프롬프트
const PROMPTS = {
  plain: '이 이미지의 모든 텍스트를 정확히 추출해줘. 줄바꿈도 그대로 유지. 다른 설명/번역/마크업 없이 추출된 텍스트만 출력.',
  table: '이 이미지의 표/양식 데이터를 마크다운 표 형식으로 추출해줘. 헤더/셀 구조 그대로. 다른 설명 없이 표만 출력.',
  numbers: '이 이미지에서 모든 숫자(금액/수량/날짜/전화번호 등)를 한 줄에 하나씩 추출해줘. 라벨이 있으면 "라벨: 숫자" 형식. 다른 설명 없이.',
  translate: '이 이미지의 텍스트를 추출하고, 한국어 ↔ 영어로 번역해줘. 형식:\n\n[원문]\n...\n\n[번역]\n...',
  receipt: '이 이미지가 영수증/명세서/세금계산서면 다음 항목을 JSON 으로 추출해줘: { 일자, 업체, 금액, 부가세, 합계, 품목: [{ 이름, 수량, 단가, 금액 }] }. 없는 필드는 null. JSON 만 출력.',
};

router.post('/', requireAuth, upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '이미지 파일이 필요합니다' });

  const mode = (req.body.mode || 'plain').toString();
  const prompt = PROMPTS[mode] || PROMPTS.plain;

  const imagePath = file.path;
  const imageAbsPath = path.resolve(imagePath);

  try {
    let text = '';
    let durationMs = 0;

    if (claudeClient.apiModeAvailable && claudeClient.apiModeAvailable()) {
      // API 모드 — multimodal 메시지 직접 보냄
      const fileBuffer = fs.readFileSync(imagePath);
      const mime = (file.mimetype && file.mimetype.startsWith('image/'))
        ? file.mimetype
        : 'image/png';
      const b64 = fileBuffer.toString('base64');

      const started = Date.now();
      const result = await claudeClient.callClaudeApi(
        [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
            { type: 'text', text: prompt },
          ],
        }],
        { maxTokens: 4096 }
      );
      durationMs = Date.now() - started;
      text = (result && result.text) || '';
    } else {
      // CLI 모드 — 이미지 파일 경로를 프롬프트에 포함시켜 Claude CLI 가 Read tool 로 읽게
      const cliPrompt = prompt + '\n\n이미지 파일: ' + imageAbsPath
        + '\n\n위 파일을 Read 도구로 읽고 위 지시대로 텍스트만 출력해줘.';
      const started = Date.now();
      const result = await claudeClient.runClaudeCli(cliPrompt, {});
      durationMs = Date.now() - started;
      text = (result && result.text) || '';
    }

    res.json({
      ok: true,
      text: String(text).trim(),
      mode,
      durationMs,
      mode_label: ({
        plain: '일반 텍스트',
        table: '표/양식',
        numbers: '숫자만',
        translate: '번역 포함',
        receipt: '영수증 (JSON)',
      })[mode] || '일반',
    });
  } catch (e) {
    console.error('[ai/ocr] 실패:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    // 업로드 파일 정리 (1분 후 삭제 — 잠깐 디버그 가능)
    setTimeout(() => {
      try { fs.unlinkSync(imagePath); } catch (_) {}
    }, 60 * 1000);
  }
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    apiMode: claudeClient.apiModeAvailable && claudeClient.apiModeAvailable(),
    modes: Object.keys(PROMPTS),
    uploadDir: UPLOAD_DIR,
  });
});

module.exports = router;
