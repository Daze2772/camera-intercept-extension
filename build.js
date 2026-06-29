// build.js — Obfuscates and bundles the extension for distribution
// Output: dist/ folder ready for Chrome "Load unpacked"

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const DIST = path.join(__dirname, '..', 'dist');

// Files to copy as-is (no obfuscation needed)
const COPY_FILES = [
  'manifest.json',
  'popup.html',
  'styles.css',
  'csp-rules.json'
];

// Files in icons/ to keep
const ICON_FILES = ['icon16.png', 'icon48.png', 'icon128.png'];

// Obfuscator options — strong but functional
const OBFS_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,        // Keep false — debug protection breaks in extensions
  debugProtectionInterval: 0,    // Must be 0 when debugProtection is false
  disableConsoleOutput: true,    // Strip console.log/warn/error
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,          // MUST be false — chrome API globals break if renamed
  selfDefending: false,          // Keep false — injects code that breaks in extensions
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
};

// Ensure dist dir
if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

// Copy static files
for (const file of COPY_FILES) {
  const src = path.join(SRC, file);
  const dest = path.join(DIST, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  COPY  ${file}`);
  }
}

// Copy icons
fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
for (const file of ICON_FILES) {
  const src = path.join(SRC, 'icons', file);
  const dest = path.join(DIST, 'icons', file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  COPY  icons/${file}`);
  }
}

// Obfuscate JS files
const JS_FILES = [
  'content-script.js',
  'main-interceptor.js',
  'background.js',
  'popup.js'
];

let totalIn = 0;
let totalOut = 0;

for (const file of JS_FILES) {
  const src = path.join(SRC, file);
  const dest = path.join(DIST, file);

  if (!fs.existsSync(src)) {
    console.log(`  SKIP  ${file} (not found)`);
    continue;
  }

  const code = fs.readFileSync(src, 'utf-8');
  totalIn += code.length;

  try {
    const result = JavaScriptObfuscator.obfuscate(code, OBFS_OPTIONS);
    const obfuscated = result.getObfuscatedCode();
    fs.writeFileSync(dest, obfuscated);
    totalOut += obfuscated.length;
    console.log(`  OBFS  ${file}  ${(code.length / 1024).toFixed(1)}KB → ${(obfuscated.length / 1024).toFixed(1)}KB`);
  } catch (e) {
    console.error(`  FAIL  ${file}: ${e.message}`);
    // Fallback: copy original
    fs.copyFileSync(src, dest);
    console.log(`  COPY  ${file} (fallback — unobfuscated)`);
  }
}

// Copy test pages (for your own testing, not customer distribution)
fs.mkdirSync(path.join(DIST, 'test-pages'), { recursive: true });
const testPages = fs.readdirSync(path.join(SRC, 'test-pages'));
for (const file of testPages) {
  fs.copyFileSync(path.join(SRC, 'test-pages', file), path.join(DIST, 'test-pages', file));
}
console.log(`  COPY  test-pages/ (${testPages.length} files)`);

console.log(`\nDone. Output: ${DIST}`);
console.log(`Total JS: ${(totalIn / 1024).toFixed(1)}KB → ${(totalOut / 1024).toFixed(1)}KB (${(totalIn > 0 ? ((totalIn - totalOut) / totalIn * 100).toFixed(0) : 0)}% growth from obfuscation)`);
console.log(`Load unpacked from: ${DIST}`);
