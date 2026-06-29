// main-interceptor.js — Runs in MAIN world at document_start via dynamic registration
// Patches navigator.mediaDevices.getUserMedia, enumerateDevices, ImageCapture
// Receives commands from isolated-world bridge via CustomEvent on document

(function() {
  'use strict';

  // Storage bridge — populated by content script via CustomEvent
  let _readyResolve = null;
  let _lastEnabled = false;
  let _lastVideoData = null;
  const STATE = {
    enabled: false,
    videoData: null,
    videoMime: 'video/webm',
    videoMeta: null,
    blobUrl: null,  // Provided by content script (extension origin, bypasses CSP)
    readyPromise: new Promise(function(r) { _readyResolve = r; })
  };

  // Original references saved before patching
  const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const _origTakePhoto = (typeof ImageCapture !== 'undefined') ? ImageCapture.prototype.takePhoto : null;
  const _origGrabFrame = (typeof ImageCapture !== 'undefined') ? ImageCapture.prototype.grabFrame : null;

  // 15-second timeout so the page doesn't hang forever if bridge never responds
  // Resolves (doesn't reject) to avoid unhandled rejection noise
  var TIMEOUT_MS = 15000;
  var timeoutPromise = new Promise(function(resolve) {
    setTimeout(function() { resolve('timeout'); }, TIMEOUT_MS);
  });

  // ── Spoofed camera identity ───────────────────────────────────────
  // Realistic hardware-style IDs to avoid detection
  var FAKE_DEVICE_ID = '4e9f8a7b3c2d1e0f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f';
  var FAKE_GROUP_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

  const SPOOF = {
    capabilities: {
      width: { min: 320, max: 1920 },
      height: { min: 240, max: 1080 },
      frameRate: { min: 1, max: 30 },
      facingMode: ['user'],
      resizeMode: ['none', 'crop-and-scale'],
      aspectRatio: { min: 0.5, max: 2.0 },
      deviceId: FAKE_DEVICE_ID,
      groupId: FAKE_GROUP_ID
    },
    settings: function(meta) {
      return {
        width: (meta && meta.width) || 1280,
        height: (meta && meta.height) || 720,
        frameRate: (meta && meta.frameRate) || 30,
        deviceId: FAKE_DEVICE_ID,
        facingMode: 'user',
        aspectRatio: ((meta && meta.width) || 1280) / ((meta && meta.height) || 720)
      };
    },
    device: {
      deviceId: FAKE_DEVICE_ID,
      kind: 'videoinput',
      label: 'Integrated Camera',
      groupId: FAKE_GROUP_ID
    }
  };

  // ── Video helpers ────────────────────────────────────────────────────
  var _videoEl = null;

  // ── Chunked base64 to Blob (avoids CSP and UI freeze) ──────────────
  function base64ToBlob(base64, mime) {
    return new Promise(function(resolve) {
      var CHUNK = 1048576; // 1MB base64 per chunk (multiple of 4)
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

        // Pad last chunk to multiple of 4 for valid base64
        if (end === total && segment.length % 4 !== 0) {
          segment += '==='.substring(0, 4 - (segment.length % 4));
        }

        var binary = atob(segment);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        binaryChunks.push(bytes);
        pos = end;

        // Yield to browser between chunks — prevents UI freeze
        setTimeout(next, 0);
      }

      setTimeout(next, 0);
    });
  }

  function getVideo() {
    if (_videoEl) { _videoEl.pause(); _videoEl.removeAttribute('src'); _videoEl.remove(); _videoEl = null; }
    var v = document.createElement('video');
    // Must be visible (opacity > 0, in viewport) for Chrome to render frames into captureStream
    v.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:1;pointer-events:none;z-index:-1;';
    v.setAttribute('playsinline', '');
    v.setAttribute('autoplay', '');
    v.setAttribute('muted', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    document.body.appendChild(v);
    _videoEl = v;
    return v;
  }

  async function loadVideo(v, base64, mime) {
    mime = mime || 'video/webm';

    // Try blob: URL first (content script origin, works on Sumsub/Onfido)
    var blobUrl = STATE.blobUrl;
    if (!blobUrl) {
      var blob = await base64ToBlob(base64, mime);
      blobUrl = URL.createObjectURL(blob);
    }

    try {
      v.src = blobUrl;
      await new Promise(function(resolve, reject) {
        if (v.readyState >= 3) { resolve(); return; }
        v.addEventListener('canplay', function() { resolve(); }, { once: true });
        v.addEventListener('error', function(e) { reject(e); }, { once: true });
        v.load();
      });
      console.log('[CamIntercept MAIN] blob: URL loaded');
      return;
    } catch(e) {
      console.warn('[CamIntercept MAIN] blob: URL failed, trying data: URL:', e.message);
    }

    // Fallback: data: URL (Wise.com allows data: but not blob:)
    v.src = 'data:' + mime + ';base64,' + base64;
    return new Promise(function(resolve, reject) {
      if (v.readyState >= 3) { resolve(); return; }
      v.addEventListener('canplay', function() { resolve(); }, { once: true });
      v.addEventListener('error', function(e) { reject(e); }, { once: true });
      v.load();
    });
  }

  // ── Track wrapper ────────────────────────────────────────────────────
  function wrapTrack(track, meta) {
    var settings = SPOOF.settings(meta);
    var origCaps = track.getCapabilities ? track.getCapabilities.bind(track) : null;
    var origSets = track.getSettings ? track.getSettings.bind(track) : null;
    var origCons = track.getConstraints ? track.getConstraints.bind(track) : null;
    var origClone = track.clone ? track.clone.bind(track) : null;

    track.getCapabilities = function() {
      try {
        var r = origCaps ? origCaps() : {};
        var merged = {};
        var keys = Object.keys(SPOOF.capabilities);
        for (var i = 0; i < keys.length; i++) merged[keys[i]] = SPOOF.capabilities[keys[i]];
        return merged;
      } catch(e) { return SPOOF.capabilities; }
    };

    track.getSettings = function() {
      try { var r = origSets ? origSets() : {}; return r; }
      catch(e) { return settings; }
    };

    track.getConstraints = function() {
      try { return origCons ? origCons() : { video: { width: settings.width, height: settings.height } }; }
      catch(e) { return { video: { width: settings.width, height: settings.height } }; }
    };

    track.applyConstraints = function() { return Promise.resolve(); };

    track.clone = function() {
      var c = origClone ? origClone() : track;
      return wrapTrack(c, meta);
    };

    try {
      Object.defineProperty(track, 'label', { get: function() { return 'Integrated Camera'; }, configurable: true });
    } catch(e) {}

    return track;
  }

  // ── Frame capture ────────────────────────────────────────────────────
  function grabFrame(video, mime, quality) {
    var c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    var ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return new Promise(function(resolve) {
      c.toBlob(function(b) { resolve(b); }, mime, quality);
    });
  }

  function grabBitmap(video) {
    var c = document.createElement('canvas');
    c.width = video.videoWidth || 1280;
    c.height = video.videoHeight || 720;
    var ctx = c.getContext('2d');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return createImageBitmap(c);
  }

  // ── Core interception ────────────────────────────────────────────────
  var _activePromise = null;
  var _cachedStream = null;   // Reuse across multiple getUserMedia calls
  var _cachedCanvas = null;
  var _frameCount = 0;

  async function doIntercept() {
    // If a previous interception is still in progress, wait for it
    if (_activePromise) {
      try { return await _activePromise; } catch(e) {}
    }

    // If we already have a live stream, return it directly (Sumsub calls GUM repeatedly)
    if (_cachedStream && _cachedStream.active && _cachedStream.getVideoTracks().length > 0) {
      console.log('[CamIntercept MAIN] Reusing cached stream. Frames:', _frameCount);
      return _cachedStream;
    }

    console.log('[CamIntercept MAIN] Starting interception...');
    _activePromise = (async function() {
      var v = getVideo();
      await loadVideo(v, STATE.videoData, STATE.videoMime);
      console.log('[CamIntercept MAIN] Video loaded, readyState:', v.readyState, 'paused:', v.paused, 'size:', v.videoWidth + 'x' + v.videoHeight);

      v.loop = true;
      try {
        await v.play();
        console.log('[CamIntercept MAIN] Video playing. paused:', v.paused, 'currentTime:', v.currentTime);
      } catch (e) {
        console.error('[CamIntercept MAIN] Video play failed:', e.message);
        throw e;
      }

      _frameCount = 0;

      // Force Chrome to keep rendering frames by watching currentTime
      var _lastTime = -1;
      function tick() {
        if (!v.paused && v.currentTime !== _lastTime) {
          _lastTime = v.currentTime;
          _frameCount++;
        }
        if (!v.paused) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);

      // Use video.captureStream directly — avoids Sumsub trusted_media canvas detection
      _cachedStream = v.captureStream(30);
      var tracks = _cachedStream.getVideoTracks();
      console.log('[CamIntercept MAIN] Video stream captured, tracks:', tracks.length);

      // Log frame count after 2 seconds
      setTimeout(function() {
        console.log('[CamIntercept MAIN] Frames advanced:', _frameCount);
      }, 2000);

      for (var i = 0; i < tracks.length; i++) wrapTrack(tracks[i], STATE.videoMeta);
      return _cachedStream;
    })();
    try { return await _activePromise; } finally { _activePromise = null; }
  }

  // ── PATCH: getUserMedia ───────────────────────────────────────────────
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    // Wait for bridge to provide state, or time out
    await Promise.race([STATE.readyPromise, timeoutPromise]);

    if (!STATE.enabled || !STATE.videoData) {
      return _origGetUserMedia(constraints);
    }
    try {
      return await doIntercept();
    } catch(e) {
      console.warn('[CamIntercept MAIN] Intercept failed, fallback:', e.message);
      return _origGetUserMedia(constraints);
    }
  };

  // ── PATCH: enumerateDevices ──────────────────────────────────────────
  navigator.mediaDevices.enumerateDevices = async function() {
    await Promise.race([STATE.readyPromise, timeoutPromise]);
    if (!STATE.enabled) return _origEnumerateDevices();
    try {
      var real = await _origEnumerateDevices();
      var filtered = [];
      for (var i = 0; i < real.length; i++) {
        if (real[i].kind !== 'videoinput') filtered.push(real[i]);
      }
      filtered.unshift(SPOOF.device);
      return filtered;
    } catch(e) { return _origEnumerateDevices(); }
  };

  // ── PATCH: permissions.query ─────────────────────────────────────
  // OnlyFans/Wise check camera permission state before getUserMedia
  if (navigator.permissions && navigator.permissions.query) {
    var _origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async function(descriptor) {
      if (descriptor && descriptor.name === 'camera') {
        await Promise.race([STATE.readyPromise, timeoutPromise]);
        if (STATE.enabled) {
          return { state: 'granted', onchange: null };
        }
      }
      return _origQuery(descriptor);
    };
  }

  // ── PATCH: ImageCapture ──────────────────────────────────────────────
  if (_origTakePhoto && _origGrabFrame) {
    ImageCapture.prototype.takePhoto = function() {
      if (STATE.enabled && _videoEl && _videoEl.readyState >= 2) {
        return grabFrame(_videoEl, 'image/jpeg', 0.92);
      }
      return _origTakePhoto.call(this);
    };
    ImageCapture.prototype.grabFrame = function() {
      if (STATE.enabled && _videoEl && _videoEl.readyState >= 2) {
        return grabBitmap(_videoEl);
      }
      return _origGrabFrame.call(this);
    };
  }

  // ── Bridge: listen for commands from isolated world ──────────────────
  // CustomEvent on document (same-frame, for non-iframe pages like webcamtests.com)
  document.addEventListener('__camCommand', handleCommand);

  // postMessage on window (cross-frame, for iframes like Veriff)
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.source !== 'cam-intercept-bridge') return;
    handleCommand({ detail: e.data });
  });

  function handleCommand(e) {
    var d = e.detail;
    if (!d) return;

    if (d.action === 'enable') {
      if (_lastEnabled && _lastVideoData === d.videoData) return;
      _lastEnabled = true;
      _lastVideoData = d.videoData || null;

      STATE.enabled = true;
      STATE.videoData = d.videoData || null;
      STATE.videoMime = d.videoMime || 'video/webm';
      STATE.videoMeta = d.videoMeta || null;
      STATE.blobUrl = d.blobUrl || null;

      if (_readyResolve) {
        _readyResolve();
        _readyResolve = null;
      }
      console.log('[CamIntercept MAIN] Enabled. Video:', STATE.videoMeta ? STATE.videoMeta.width + 'x' + STATE.videoMeta.height : 'none');
    } else if (d.action === 'disable') {
      if (!_lastEnabled) return;
      _lastEnabled = false;
      _lastVideoData = null;

      STATE.enabled = false;
      if (_videoEl) { _videoEl.pause(); _videoEl.remove(); _videoEl = null; }
      console.log('[CamIntercept MAIN] Disabled');
    }
  }

  console.log('[CamIntercept MAIN] Patched getUserMedia + enumerateDevices + ImageCapture. Waiting for bridge.');
})();
