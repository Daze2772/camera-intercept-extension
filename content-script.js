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

  // ── Bridge: sync chrome.storage → main world via postMessage + CustomEvent ─
  function syncToMainWorld() {
    chrome.storage.local.get(
      ['interceptionEnabled', 'activeProfileId', 'profiles'],
      function(data) {
        var enabled = data.interceptionEnabled || false;
        var activeId = data.activeProfileId;
        var profiles = data.profiles || [];
        var profile = null;
        if (activeId) {
          profile = profiles.find(function(p) { return p.id === activeId; });
        }

        var detail;
        if (enabled && profile && profile.videoData) {
          detail = {
            action: 'enable',
            videoData: profile.videoData,
            videoMime: profile.videoMime || 'video/webm',
            videoMeta: profile.videoMeta || null
          };
          console.log('[CamIntercept BRIDGE] Enabled, video:', (profile.videoData.length / 1024).toFixed(1), 'KB base64');
        } else if (enabled) {
          detail = { action: 'enable', videoData: null };
          console.log('[CamIntercept BRIDGE] Enabled, NO VIDEO loaded');
        } else {
          detail = { action: 'disable' };
          console.log('[CamIntercept BRIDGE] Disabled');
        }

        // 1. CustomEvent for same-frame main-world interceptor
        document.dispatchEvent(new CustomEvent('__camCommand', { detail: detail }));

        // 2. postMessage to reach cross-origin iframes (Veriff, etc.)
        window.postMessage({
          source: 'cam-intercept-bridge',
          action: detail.action,
          videoData: detail.videoData,
          videoMime: detail.videoMime,
          videoMeta: detail.videoMeta
        }, '*');
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
