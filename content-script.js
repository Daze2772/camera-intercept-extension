// content-script.js — Bridge (ISOLATED world, document_start)
// Handles ALL video loading/decoding/streaming (bypasses page CSP)
// Communicates with main-interceptor.js (MAIN world) via CustomEvent + postMessage

(function() {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────
  var _cachedStream = null;    // Pre-built MediaStream (created on enable)
  var _cachedCanvas = null;
  var _videoEl = null;
  var _frameCount = 0;
  var _streamPromise = null;   // Promise for stream-in-progress

  // ── VISUAL BANNER ────────────────────────────────────────────────────
  try {
    var banner = document.createElement('div');
    banner.id = 'cam-intercept-banner';
    banner.textContent = '⚡ CAM INTERCEPTOR ACTIVE ⚡';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#e94560;color:#fff;text-align:center;padding:4px;font:bold 12px monospace;pointer-events:none;';
    document.documentElement.appendChild(banner);
  } catch(e) {}

  // ── Chunked base64 to Blob (async, no UI freeze) ────────────────────
  function base64ToBlob(base64, mime) {
    return new Promise(function(resolve) {
      var CHUNK = 1048576; // 1MB
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

  // ── Video loading + stream creation ──────────────────────────────────
  function wrapTrack(track, meta) {
    var spoofCaps = {
      width: { min: 320, max: 1920 },
      height: { min: 240, max: 1080 },
      frameRate: { min: 1, max: 30 },
      facingMode: ['user'],
      resizeMode: ['none', 'crop-and-scale'],
      aspectRatio: { min: 0.5, max: 2.0 },
      deviceId: 'default-camera-interceptor',
      groupId: 'default-group-interceptor'
    };
    var settings = {
      width: (meta && meta.width) || 1280,
      height: (meta && meta.height) || 720,
      frameRate: (meta && meta.frameRate) || 30,
      deviceId: 'default-camera-interceptor',
      facingMode: 'user'
    };

    var origCaps = track.getCapabilities ? track.getCapabilities.bind(track) : null;
    var origSets = track.getSettings ? track.getSettings.bind(track) : null;
    var origCons = track.getConstraints ? track.getConstraints.bind(track) : null;
    var origClone = track.clone ? track.clone.bind(track) : null;

    track.getCapabilities = function() {
      try { return spoofCaps; } catch(e) { return spoofCaps; }
    };
    track.getSettings = function() {
      try { var r = origSets ? origSets() : {}; return r; } catch(e) { return settings; }
    };
    track.getConstraints = function() {
      try { return origCons ? origCons() : {}; } catch(e) { return {}; }
    };
    track.applyConstraints = function() { return Promise.resolve(); };
    track.clone = function() {
      var c = origClone ? origClone() : track;
      return wrapTrack(c, meta);
    };
    try {
      Object.defineProperty(track, 'label', { get: function() { return 'USB Camera'; }, configurable: true });
    } catch(e) {}
    return track;
  }

  async function buildStream(base64, mime, meta) {
    console.log('[CamIntercept BRIDGE] Building stream...');

    // Clean up previous
    if (_videoEl) { _videoEl.pause(); _videoEl.removeAttribute('src'); _videoEl.remove(); _videoEl = null; }
    _cachedStream = null;
    _cachedCanvas = null;

    // Create tiny visible video in DOM (autoplay requires DOM attachment)
    var v = document.createElement('video');
    v.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:1;pointer-events:none;z-index:-1;';
    v.setAttribute('playsinline', '');
    v.setAttribute('autoplay', '');
    v.setAttribute('muted', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    document.body.appendChild(v);
    _videoEl = v;

    // Decode base64 → Blob (async, chunked)
    var blob = await base64ToBlob(base64, mime || 'video/webm');
    var blobUrl = URL.createObjectURL(blob);
    v.src = blobUrl;

    // Wait for video to be playable
    await new Promise(function(resolve, reject) {
      if (v.readyState >= 3) { resolve(); return; }
      v.addEventListener('canplay', function() { resolve(); }, { once: true });
      v.addEventListener('error', function(e) { reject(e); }, { once: true });
      v.load();
    });

    console.log('[CamIntercept BRIDGE] Video ready, size:', v.videoWidth + 'x' + v.videoHeight);

    v.loop = true;
    try { await v.play(); } catch(e) {
      console.error('[CamIntercept BRIDGE] Play failed:', e.message);
      throw e;
    }

    // Canvas-based captureStream (downscaled for perf)
    var MAX_DIM = 1280;
    var vw = v.videoWidth || 640;
    var vh = v.videoHeight || 480;
    var scale = 1;
    if (vw > MAX_DIM || vh > MAX_DIM) scale = MAX_DIM / Math.max(vw, vh);
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    _cachedCanvas = canvas;

    _frameCount = 0;
    function drawFrame() {
      if (!v.paused && v.readyState >= 2) {
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        _frameCount++;
      }
      if (!v.paused) {
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(drawFrame);
        else requestAnimationFrame(drawFrame);
      }
    }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(drawFrame);
    else requestAnimationFrame(drawFrame);

    var fps = (canvas.width * canvas.height > 1280 * 720) ? 15 : 30;
    var stream = canvas.captureStream(fps);
    var tracks = stream.getVideoTracks();
    for (var i = 0; i < tracks.length; i++) wrapTrack(tracks[i], meta);

    _cachedStream = stream;

    setTimeout(function() {
      console.log('[CamIntercept BRIDGE] Stream built. Frames:', _frameCount);
    }, 2000);

    console.log('[CamIntercept BRIDGE] Stream ready, tracks:', tracks.length);
    return stream;
  }

  // ── Respond to stream requests from main world ──────────────────────
  document.addEventListener('__camRequest', function(e) {
    var requestId = e.detail && e.detail.requestId;
    if (!requestId) return;

    // If we already have a live cached stream, send it immediately
    if (_cachedStream && _cachedStream.active && _cachedStream.getVideoTracks().length > 0) {
      window.postMessage({
        type: '__camResponse',
        requestId: requestId,
        stream: _cachedStream
      }, '*');
      console.log('[CamIntercept BRIDGE] Sent cached stream for request', requestId);
      return;
    }

    // If stream is being built, wait for it
    if (_streamPromise) {
      _streamPromise.then(function(stream) {
        window.postMessage({
          type: '__camResponse',
          requestId: requestId,
          stream: stream
        }, '*');
      }).catch(function(err) {
        window.postMessage({
          type: '__camResponse',
          requestId: requestId,
          error: err.message
        }, '*');
      });
      return;
    }

    // No video data loaded — send error
    window.postMessage({
      type: '__camResponse',
      requestId: requestId,
      error: 'No video source loaded'
    }, '*');
  });

  // ── Bridge: sync chrome.storage → main world + build stream ──────────
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

        if (enabled && profile && profile.videoData) {
          // Fire enable to main world FIRST (so it's ready)
          document.dispatchEvent(new CustomEvent('__camCommand', {
            detail: { action: 'enable' }
          }));
          window.postMessage({
            source: 'cam-intercept-bridge',
            action: 'enable'
          }, '*');

          // Build stream asynchronously (only if not already building)
          if (!_streamPromise && (!_cachedStream || !_cachedStream.active)) {
            _streamPromise = buildStream(profile.videoData, profile.videoMime || 'video/webm', profile.videoMeta)
              .then(function(stream) {
                _streamPromise = null;
                return stream;
              })
              .catch(function(err) {
                console.error('[CamIntercept BRIDGE] Stream build failed:', err.message);
                _streamPromise = null;
                _cachedStream = null;
              });
          }

          console.log('[CamIntercept BRIDGE] Enabled, video:', (profile.videoData.length / 1024).toFixed(1), 'KB base64');
        } else if (enabled) {
          document.dispatchEvent(new CustomEvent('__camCommand', {
            detail: { action: 'enable' }
          }));
          window.postMessage({
            source: 'cam-intercept-bridge',
            action: 'enable'
          }, '*');
          console.log('[CamIntercept BRIDGE] Enabled, NO VIDEO');
        } else {
          document.dispatchEvent(new CustomEvent('__camCommand', {
            detail: { action: 'disable' }
          }));
          window.postMessage({
            source: 'cam-intercept-bridge',
            action: 'disable'
          }, '*');
          _cachedStream = null;
          _cachedCanvas = null;
          _streamPromise = null;
          if (_videoEl) { _videoEl.pause(); _videoEl.removeAttribute('src'); _videoEl.remove(); _videoEl = null; }
          console.log('[CamIntercept BRIDGE] Disabled');
        }
      }
    );
  }

  // Initial sync
  syncToMainWorld();

  // Storage changes
  chrome.storage.onChanged.addListener(function(changes, areaName) {
    if (areaName !== 'local') return;
    if (changes.interceptionEnabled || changes.activeProfileId || changes.profiles) {
      syncToMainWorld();
    }
  });

  // Popup messages
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'STATE_CHANGED') syncToMainWorld();
    sendResponse({ success: true });
    return true;
  });

  console.log('[CamIntercept BRIDGE] Ready.');
})();
