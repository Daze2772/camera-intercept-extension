#!/usr/bin/env node
// headless-verify.js
// Autonomous headless verification of the Camera Interceptor extension.
// Uses evaluateOnNewDocument to inject the interception script (no extension loading needed).
// Verifies: getUserMedia returns pre-recorded video, track spoofing, ImageCapture, KYC flow.

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const EXTENSION_PATH = path.join(__dirname, '..');
const INTERCEPTOR_PATH = path.join(__dirname, 'headless-interceptor.js');
const TEST_PAGES_DIR = path.join(__dirname, '..', 'test-pages');
const TEST_VIDEO_PATH = path.join(__dirname, '..', 'test-video.webm');
const SCREENSHOT_DIR = path.join(__dirname, '..', 'test-output');

const TEST_PAGE_URL = `file://${path.join(TEST_PAGES_DIR, 'basic-camera.html')}`;
const KYC_PAGE_URL = `file://${path.join(TEST_PAGES_DIR, 'kyc-simulation.html')}`;

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}${detail ? ' — ' + detail : ''}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${testName}${detail ? ' — ' + detail : ''}`);
    failed++;
    failures.push({ testName, detail });
  }
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Camera Interceptor — Headless Verification');
  console.log('═══════════════════════════════════════════\n');

  // Ensure output directory
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  // ── Pre-checks ────────────────────────────────────────────────────
  console.log('── Pre-checks ──');
  assert(fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json')), 'Extension manifest exists');
  assert(fs.existsSync(TEST_VIDEO_PATH), 'Test video exists', `${(fs.statSync(TEST_VIDEO_PATH).size / 1024).toFixed(1)} KB`);
  assert(fs.existsSync(INTERCEPTOR_PATH), 'Headless interceptor script exists');
  assert(fs.existsSync(path.join(TEST_PAGES_DIR, 'basic-camera.html')), 'Basic camera test page exists');
  assert(fs.existsSync(path.join(TEST_PAGES_DIR, 'kyc-simulation.html')), 'KYC simulation test page exists');

  // ── Load test video ────────────────────────────────────────────────
  console.log('\n── Video Loading ──');
  const videoBase64 = fs.readFileSync(TEST_VIDEO_PATH).toString('base64');
  console.log(`  Video loaded: ${(videoBase64.length / 1024).toFixed(1)} KB base64`);

  // Read the interceptor script
  const interceptorScript = fs.readFileSync(INTERCEPTOR_PATH, 'utf-8');

  const videoMeta = { width: 1280, height: 720, frameRate: 30, duration: 10 };

  // ── Launch browser ─────────────────────────────────────────────────
  console.log('\n── Browser Launch ──');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
      '--use-fake-ui-for-media-stream',    // Auto-approve camera prompts (as fallback)
      '--use-fake-device-for-media-stream' // Provide fake video (as fallback)
    ]
  });
  console.log('  Browser launched');

  // ── Test 1: Basic Camera Page ─────────────────────────────────────
  console.log('\n── Test 1: Basic Camera Page ──');

  const context = browser.defaultBrowserContext();
  // Grant camera permission for file:// URLs
  await context.overridePermissions(TEST_PAGE_URL.replace('basic-camera.html', ''), ['camera']);

  const page1 = await browser.newPage();

  // Set interception state FIRST (evaluateOnNewDocument runs in order)
  await page1.evaluateOnNewDocument((videoData, videoMeta) => {
    window.__camInterceptState = {
      enabled: true,
      videoData: videoData,
      videoMime: 'video/webm',
      videoMeta: videoMeta
    };
  }, videoBase64, videoMeta);

  // Then inject interception script (reads window.__camInterceptState)
  await page1.evaluateOnNewDocument(interceptorScript);

  const page1Logs = [];
  page1.on('console', msg => {
    const text = msg.text();
    if (text.includes('[TEST]') || text.includes('[HeadlessInterceptor]')) {
      page1Logs.push(text);
      console.log(`  [Page] ${text}`);
    }
  });

  page1.on('pageerror', err => {
    console.log(`  [Page Error] ${err.message}`);
    page1Logs.push(`[ERROR] ${err.message}`);
  });

  try {
    await page1.goto(TEST_PAGE_URL, { waitUntil: 'networkidle0', timeout: 15000 });
    console.log('  Page loaded');

    await page1.waitForSelector('#test1-btn', { timeout: 10000 });
    console.log('  Test UI rendered');

    // Wait for interceptor to initialize
    await sleep(1000);

    // Check if interceptor was injected
    const interceptorLoaded = page1Logs.some(l => l.includes('Injected'));
    assert(interceptorLoaded, 'Interceptor script injected');

    // Click "Run Test 1"
    await page1.click('#test1-btn');
    await sleep(4000);

    // Check for video element
    const videoEl = await page1.$('#test-output');
    assert(videoEl !== null, 'Video element appeared on page');

    // Check test results
    const test1Result = await page1.$eval('#test1-result', el => el.textContent).catch(() => '');
    const test1Passed = test1Result.includes('PASS');
    assert(test1Passed, 'Test 1 (getUserMedia interception)', test1Result.trim());

    // Check track label
    const labelLog = page1Logs.find(l => l.includes('Track label'));
    if (labelLog) {
      const label = labelLog.match(/"([^"]+)"/)?.[1] || '';
      const spoofed = label && !label.toLowerCase().includes('virtual');
      assert(spoofed, 'Track label is spoofed', `"${label}"`);
    }

    // Run Test 2: Capabilities
    const test2Enabled = await page1.$eval('#test2-btn', el => !el.disabled).catch(() => false);
    if (test2Enabled) {
      await page1.click('#test2-btn');
      await sleep(2000);
      const test2Result = await page1.$eval('#test2-result', el => el.textContent).catch(() => '');
      assert(test2Result.includes('PASS'), 'Test 2 (Capabilities)', test2Result.trim());
    } else {
      assert(false, 'Test 2 (Capabilities)', 'Test 2 button was not enabled');
    }

    // Run Test 3: applyConstraints + clone
    const test3Enabled = await page1.$eval('#test3-btn', el => !el.disabled).catch(() => false);
    if (test3Enabled) {
      await page1.click('#test3-btn');
      await sleep(2000);
      const test3Result = await page1.$eval('#test3-result', el => el.textContent).catch(() => '');
      assert(test3Result.includes('PASS'), 'Test 3 (applyConstraints + clone)', test3Result.trim());
    } else {
      assert(false, 'Test 3 (applyConstraints + clone)', 'Test 3 button was not enabled');
    }

    // Run Test 4: ImageCapture
    const test4Enabled = await page1.$eval('#test4-btn', el => !el.disabled).catch(() => false);
    if (test4Enabled) {
      await page1.click('#test4-btn');
      await sleep(3000);
      const test4Result = await page1.$eval('#test4-result', el => el.textContent).catch(() => '');
      assert(test4Result.includes('PASS'), 'Test 4 (ImageCapture)', test4Result.trim());
    } else {
      assert(false, 'Test 4 (ImageCapture)', 'Test 4 button was not enabled');
    }

    // Screenshot
    await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'basic-camera-result.png') });
    console.log('  Screenshot saved');

  } catch (e) {
    console.error(`  ❌ Test 1 error: ${e.message}`);
    assert(false, 'Test 1 — execution', e.message);
    try {
      await page1.screenshot({ path: path.join(SCREENSHOT_DIR, 'basic-camera-error.png') });
    } catch (_) {}
  }

  await page1.close();

  // ── Test 2: KYC Simulation Page ───────────────────────────────────
  console.log('\n── Test 2: KYC Simulation Page ──');

  await context.overridePermissions(KYC_PAGE_URL.replace('kyc-simulation.html', ''), ['camera']);

  const page2 = await browser.newPage();

  await page2.evaluateOnNewDocument((videoData, videoMeta) => {
    window.__camInterceptState = {
      enabled: true,
      videoData: videoData,
      videoMime: 'video/webm',
      videoMeta: videoMeta
    };
  }, videoBase64, videoMeta);

  await page2.evaluateOnNewDocument(interceptorScript);

  const page2Logs = [];
  page2.on('console', msg => {
    const text = msg.text();
    if (text.includes('[KYC]') || text.includes('[HeadlessInterceptor]')) {
      page2Logs.push(text);
      console.log(`  [KYC] ${text}`);
    }
  });

  page2.on('pageerror', err => {
    console.log(`  [KYC Error] ${err.message}`);
    page2Logs.push(`[ERROR] ${err.message}`);
  });

  try {
    await page2.goto(KYC_PAGE_URL, { waitUntil: 'networkidle0', timeout: 15000 });
    console.log('  Page loaded');

    await page2.waitForSelector('#start-btn', { timeout: 10000 });
    await sleep(1000);

    // Click start
    await page2.click('#start-btn');
    console.log('  KYC flow started, waiting for completion...');

    // Wait for verdict (up to 40 seconds for full KYC flow)
    let verdictText = '';
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      try {
        verdictText = await page2.$eval('#verdict', el => el.textContent);
        if (verdictText.includes('Complete') || verdictText.includes('Failed')) break;
      } catch (e) { /* still loading */ }
    }

    console.log(`  Verdict: ${verdictText}`);
    const kycPassed = verdictText.includes('Complete') && verdictText.includes('✅');
    assert(kycPassed, 'KYC simulation completed successfully', verdictText);

    // Check for errors
    const errorVisible = await page2.$eval('#error-panel', el => el.classList.contains('show')).catch(() => false);
    assert(!errorVisible, 'No errors in KYC flow');

    // Check interceptor was used
    const interceptorUsed = page2Logs.some(l => l.includes('Intercepting'));
    assert(interceptorUsed, 'Interceptor was triggered during KYC flow');

    // Screenshot
    await page2.screenshot({ path: path.join(SCREENSHOT_DIR, 'kyc-result.png') });
    console.log('  Screenshot saved');

  } catch (e) {
    console.error(`  ❌ Test 2 error: ${e.message}`);
    assert(false, 'Test 2 — KYC execution', e.message);
    try {
      await page2.screenshot({ path: path.join(SCREENSHOT_DIR, 'kyc-error.png') });
    } catch (_) {}
  }

  await page2.close();

  // ── Cleanup ───────────────────────────────────────────────────────
  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ❌ ${f.testName}: ${f.detail}`);
    }
  }

  if (failed === 0) {
    console.log('\n✅ ALL TESTS PASSED — Extension verified autonomously.');
    process.exit(0);
  } else {
    console.log(`\n❌ ${failed} test(s) failed.`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
