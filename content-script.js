// content-script.js — Bridge (ISOLATED world, document_start)
// Reads chrome.storage and dispatches state to main-world interceptor via CustomEvent.
// The main interceptor runs via chrome.scripting.registerContentScripts (MAIN world, bypasses CSP).

(function() {
  'use strict';

  // ── VISUAL BANNER ────────────────────────────────────────────────────
  try {
    const banner = document.createElement('div');
    banner.id = 'cam-intercept-banner';
    banner.textContent = '⚡ CAM INTERCEPTOR ACTIVE ⚡';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#e94560;color:#fff;text-align:center;padding:4px;font:bold 12px monospace;pointer-events:none;';
    document.documentElement.appendChild(banner);
  } catch(e) {}

  // ── Chunked base64 → Blob (async, no UI freeze) ───────────────────
  function base64ToBlob(base64, mime) {
    return new Promise(function(resolve) {
      var CHUNK = 1048576;
      var binaryChunks = [];
      var total = base64.length;
      var pos = 0;

      function next() {
        if (pos >= total) {
          var totalLen = 0;
          for (var i = 0; i < binaryChunks.length; i++) totalLen += binaryChunks[i].length;
          var result = new Uint8Array(totalLen);
          var off = 0;
          for (var i = 0; i < binaryChunks.length; i++) {
            result.set(binaryChunks[i], off);
            off += binaryChunks[i].length;
          }
          resolve(new Blob([result], { type: mime }));
          return;
        }
        var end = Math.min(pos + CHUNK, total);
        var segment = base64.substring(pos, end);
        if (end === total && segment.length % 4 !== 0) {
          segment += '==='.substring(0, 4 - (segment.length % 4));
        }
        var binary = atob(segment);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        binaryChunks.push(bytes);
        pos = end;
        setTimeout(next, 0);
      }
      setTimeout(next, 0);
    });
  }

  // ── Bridge: sync chrome.storage → main world + build blob URL ────────
  function syncToMainWorld() {
    chrome.storage.local.get(
      ['interceptionEnabled', 'activeProfileId', 'profiles'],
      async function(data) {
        var enabled = data.interceptionEnabled || false;
        var activeId = data.activeProfileId;
        var profiles = data.profiles || [];
        var profile = null;
        if (activeId) {
          profile = profiles.find(function(p) { return p.id === activeId; });
        }

        if (enabled && profile && profile.videoData) {
          // Create blob URL in privileged context (extension origin, bypasses page CSP)
          try {
            var blob = await base64ToBlob(profile.videoData, profile.videoMime || 'video/webm');
            var blobUrl = URL.createObjectURL(blob);
          } catch(e) {
            console.error('[CamIntercept BRIDGE] Blob URL creation failed:', e.message);
            blobUrl = null;
          }

          var detail = {
            action: 'enable',
            videoData: profile.videoData,
            videoMime: profile.videoMime || 'video/webm',
            videoMeta: profile.videoMeta || null,
            blobUrl: blobUrl
          };
          document.dispatchEvent(new CustomEvent('__camCommand', { detail: detail }));
          window.postMessage(Object.assign({ source: 'cam-intercept-bridge' }, detail), '*');
          console.log('[CamIntercept BRIDGE] Enabled, video:', (profile.videoData.length / 1024).toFixed(1), 'KB base64', blobUrl ? '(with blob URL)' : '(no blob URL)');
        } else if (enabled) {
          var detail = { action: 'enable', videoData: null };
          document.dispatchEvent(new CustomEvent('__camCommand', { detail: detail }));
          window.postMessage(Object.assign({ source: 'cam-intercept-bridge' }, detail), '*');
          console.log('[CamIntercept BRIDGE] Enabled, NO VIDEO');
        } else {
          var detail = { action: 'disable' };
          document.dispatchEvent(new CustomEvent('__camCommand', { detail: detail }));
          window.postMessage(Object.assign({ source: 'cam-intercept-bridge' }, detail), '*');
          console.log('[CamIntercept BRIDGE] Disabled');
        }
      }
    );
  }

  // Initial sync
  syncToMainWorld();

  // Listen for storage changes
  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes.interceptionEnabled || changes.activeProfileId || changes.profiles) {
      syncToMainWorld();
    }
  });

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'STATE_CHANGED') {
      syncToMainWorld();
    }
    sendResponse({ success: true });
    return true;
  });

  console.log('[CamIntercept BRIDGE] Ready.');
})();
