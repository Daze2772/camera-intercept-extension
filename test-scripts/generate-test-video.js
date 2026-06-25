#!/usr/bin/env node
// generate-test-video.js
// Creates a 10-second test video with moving colored rectangles and frame counter
// Uses Puppeteer headless browser to render canvas + record via MediaRecorder
// Output: test-video.webm (VP8 codec, Chrome-native support)

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const OUTPUT = path.join(__dirname, '..', 'test-video.webm');
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const DURATION_SEC = 10;

async function main() {
  console.log('[GenVideo] Starting test video generation...');
  console.log(`[GenVideo] Output: ${OUTPUT}`);
  console.log(`[GenVideo] Resolution: ${WIDTH}x${HEIGHT}, ${FPS}fps, ${DURATION_SEC}s`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--allow-file-access-from-files']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT });

  // Set page content with canvas
  await page.setContent(`
    <canvas id="c" width="${WIDTH}" height="${HEIGHT}" style="background:#1a1a2e;"></canvas>
  `, { waitUntil: 'domcontentloaded' });

  // Run the entire recording inside the browser context
  const result = await page.evaluate(async ({ width, height, fps, durationSec }) => {
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');

    // Create stream from canvas
    const stream = canvas.captureStream(fps);
    const chunks = [];

    // Pick best supported codec
    let mimeType = 'video/webm;codecs=vp8';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm;codecs=vp9';
    }
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm';
    }
    console.log('[Browser] Using mimeType:', mimeType);

    const recorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      videoBitsPerSecond: 2500000
    });

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.start(100);

    const colors = ['#e94560', '#0f3460', '#00c853', '#ff6b81', '#533483', '#f5a623'];
    const totalFrames = durationSec * fps;
    const frameInterval = 1000 / fps;

    await new Promise((resolve) => {
      const startTime = performance.now();
      let frameCount = 0;

      function drawFrame() {
        const elapsed = performance.now() - startTime;
        if (elapsed >= durationSec * 1000) {
          recorder.stop();
          resolve();
          return;
        }

        const cf = Math.floor(elapsed / frameInterval);

        // Background
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, width, height);

        // Grid
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 40) {
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
        }
        for (let y = 0; y < height; y += 40) {
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
        }

        // Moving rectangles
        for (let i = 0; i < 3; i++) {
          const color = colors[(cf + i) % colors.length];
          const x = ((cf * (2 + i) * 0.7) % (width + 200)) - 200;
          const y = 150 + i * 180;
          const w = 180 + Math.sin(cf * 0.05 + i) * 40;

          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, 120);
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, 120);
        }

        // Frame counter
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 48px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`FRAME ${String(cf).padStart(4, '0')}`, width / 2, 60);

        // Timestamp
        ctx.font = '24px monospace';
        ctx.fillText(`${(elapsed / 1000).toFixed(1)}s / ${durationSec}s`, width / 2, 95);

        // Hash per frame (used for verification)
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = '14px monospace';
        ctx.fillText(`hash:${cf.toString(16).padStart(4, '0')}`, width - 200, height - 20);

        // Watermark
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.textAlign = 'center';
        ctx.fillText('CAM-INTERCEPTOR-TEST-VIDEO', width / 2, height - 8);

        requestAnimationFrame(drawFrame);
      }

      requestAnimationFrame(drawFrame);
    });

    // Convert chunks to base64
    const blob = new Blob(chunks, { type: mimeType });
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return {
      base64: btoa(binary),
      size: blob.size,
      mimeType: mimeType
    };
  }, { width: WIDTH, height: HEIGHT, fps: FPS, durationSec: DURATION_SEC });

  // Write the video file
  const binaryStr = Buffer.from(result.base64, 'base64');
  fs.writeFileSync(OUTPUT, binaryStr);

  console.log(`[GenVideo] Video written: ${OUTPUT}`);
  console.log(`[GenVideo] Size: ${(result.size / 1024).toFixed(1)} KB`);
  console.log(`[GenVideo] Format: ${result.mimeType}`);
  console.log('[GenVideo] Done.');

  await browser.close();
}

main().catch(err => {
  console.error('[GenVideo] ERROR:', err.message);
  process.exit(1);
});
