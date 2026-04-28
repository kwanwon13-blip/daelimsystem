/**
 * make-icon.js — data/logo.png 의 SM 부분만 크롭해서 ICO + 트레이 PNG 생성
 *
 * 실행: node build/make-icon.js
 *   또는 빌드 시 자동 (electron-builder 'beforeBuild' hook)
 *
 * 결과물:
 *   - build/icon.ico         (16/32/48/64/128/256 포함, .exe + 윈도우 아이콘)
 *   - build/tray-icon.png    (16x16 트레이 표시용)
 *   - build/tray-icon@2x.png (32x32 고DPI 트레이용)
 */
const fs = require('fs');
const path = require('path');

const SOURCE_LOGO = path.join(__dirname, '..', '..', 'data', 'logo.png');
const OUT_DIR = __dirname;

(async function main() {
  let sharp;
  // 우선 desktop-memo/node_modules, 없으면 부모 ../node_modules 시도
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'sharp'),
    path.join(__dirname, '..', '..', 'node_modules', 'sharp'),
  ];
  for (const p of candidates) {
    try { sharp = require(p); break; } catch (_) {}
  }
  if (!sharp) {
    try { sharp = require('sharp'); } catch (_) {}
  }
  if (!sharp) {
    console.error('❌ sharp 미설치 — price-list-app 폴더에서 npm install 후 재시도');
    process.exit(1);
  }

  if (!fs.existsSync(SOURCE_LOGO)) {
    console.error('❌ 원본 로고 없음:', SOURCE_LOGO);
    process.exit(1);
  }

  // 1. 메타 읽기
  const meta = await sharp(SOURCE_LOGO).metadata();
  console.log('원본:', meta.width + 'x' + meta.height);

  // 2. SM 부분만 크롭 (오른쪽 끝 ~28% 영역, "SM" 글자 + 청록 액센트)
  // logo.png 는 가로 긴 형태 (대략 5:1). SM 은 우측 끝부분.
  const cropW = Math.round(meta.width * 0.28);
  const cropH = meta.height;
  const cropL = meta.width - cropW;
  const cropT = 0;

  console.log(`크롭: ${cropL},${cropT} ${cropW}x${cropH}`);

  // 3. SM 영역만 추출 → 정사각형 캔버스에 중앙 배치 (투명 배경)
  const square = Math.max(cropW, cropH);
  const padX = Math.round((square - cropW) / 2);
  const padY = Math.round((square - cropH) / 2);

  const cropped = await sharp(SOURCE_LOGO)
    .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
    .extend({ top: padY, bottom: padY, left: padX, right: padX, background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .toBuffer();

  // 4. 다양한 사이즈로 PNG 생성 (ICO 변환에 사용)
  const SIZES = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = {};
  for (const size of SIZES) {
    const buf = await sharp(cropped)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    pngBuffers[size] = buf;
  }

  // 5. 트레이용 PNG 별도 저장 (16x16 / 32x32)
  fs.writeFileSync(path.join(OUT_DIR, 'tray-icon.png'), pngBuffers[16]);
  fs.writeFileSync(path.join(OUT_DIR, 'tray-icon@2x.png'), pngBuffers[32]);
  console.log('✅ tray-icon.png / tray-icon@2x.png 생성');

  // 6. ICO 생성 (Windows .ico 포맷)
  // 직접 ICO 헤더 작성 (외부 lib 안 쓰고 PNG 들을 ICO 컨테이너에 묶음)
  const icoBuf = createIco([
    pngBuffers[16],
    pngBuffers[24],
    pngBuffers[32],
    pngBuffers[48],
    pngBuffers[64],
    pngBuffers[128],
    pngBuffers[256],
  ], SIZES);

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), icoBuf);
  console.log('✅ icon.ico 생성 (' + icoBuf.length + ' bytes)');

  console.log('\n완료! electron-builder 가 build/icon.ico 자동 사용');
})().catch(err => {
  console.error('실패:', err);
  process.exit(1);
});

// ICO 포맷: ICONDIR(6 bytes) + ICONDIRENTRY * N(16 bytes each) + PNG data
function createIco(pngBuffers, sizes) {
  const count = pngBuffers.length;
  const headerSize = 6 + 16 * count;
  let offset = headerSize;
  const dirEntries = [];

  for (let i = 0; i < count; i++) {
    const size = sizes[i];
    const png = pngBuffers[i];
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    const entry = Buffer.alloc(16);
    entry.writeUInt8(w, 0);          // width
    entry.writeUInt8(h, 1);          // height
    entry.writeUInt8(0, 2);          // colorCount (0 = no palette)
    entry.writeUInt8(0, 3);          // reserved
    entry.writeUInt16LE(1, 4);       // colorPlanes
    entry.writeUInt16LE(32, 6);      // bitsPerPixel
    entry.writeUInt32LE(png.length, 8);  // imageSize
    entry.writeUInt32LE(offset, 12); // imageOffset
    dirEntries.push(entry);
    offset += png.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);        // reserved
  header.writeUInt16LE(1, 2);        // type (1=ICO)
  header.writeUInt16LE(count, 4);    // count

  return Buffer.concat([header, ...dirEntries, ...pngBuffers]);
}
