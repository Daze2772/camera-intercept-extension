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
    readyPromise: new Promise(function(r) { _readyResolve = r; })
  };

  // Original references saved before patching
  const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const _origTakePhoto = (typeof ImageCapture !== 'undefined') ? ImageCapture.prototype.takePhoto : null;
  const _origGrabFrame = (typeof ImageCapture !== 'undefined') ? ImageCapture.prototype.grabFrame : null;

  // 5-second timeout so the page doesn't hang forever if bridge never responds
  const TIMEOUT_MS = 5000;
  const timeout = new Promise(function(_, reject) {
    setTimeout(function() { reject(new Error('cam-intercept-timeout')); }, TIMEOUT_MS);
  });

  // ── Spoofed camera ──────────────────────────────────────────────────
  const SPOOF = {
    capabilities: {
      width: { min: 320, max: 1920 },
      height: { min: 240, max: 1080 },
      frameRate: { min: 1, max: 30 },
      facingMode: ['user'],
      resizeMode: ['none', 'crop-and-scale'],
      aspectRatio: { min: 0.5, max: 2.0 },
      deviceId: 'default-camera-interceptor',
      groupId: 'default-group-interceptor'
    },
    settings: function(meta) {
      return {
        width: (meta && meta.width) || 1280,
        height: (meta && meta.height) || 720,
        frameRate: (meta && meta.frameRate) || 30,
        deviceId: 'default-camera-interceptor',
        facingMode: 'user',
        aspectRatio: ((meta && meta.width) || 1280) / ((meta && meta.height) || 720)
      };
    },
    device: {
      deviceId: 'default-camera-interceptor',
      kind: 'videoinput',
      label: 'USB Camera',
      groupId: 'default-group-interceptor'
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
    // Decode base64 → Blob in chunks (async, no UI freeze, no CSP issues)
    var blob = await base64ToBlob(base64, mime || 'video/webm');
    v.src = URL.createObjectURL(blob);
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
      Object.defineProperty(track, 'label', { get: function() { return 'USB Camera'; }, configurable: true });
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

  async function doIntercept() {
    if (_activePromise) { try { return await _activePromise; } catch(e) {} }
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

      // Canvas-based captureStream — more reliable than video.captureStream()
      // Chrome reliably pushes canvas frames into the stream regardless of visibility
      var canvas = document.createElement('canvas');
      canvas.width = v.videoWidth || 640;
      canvas.height = v.videoHeight || 480;
      // Tell Chrome we'll read pixels frequently (avoids GPU readback warnings)
      var ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Draw every frame, keep track for debugging
      var _frameCount = 0;
      function drawFrame() {
        if (!v.paused && v.readyState >= 2) {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          _frameCount++;
        }
        if (!v.paused) requestAnimationFrame(drawFrame);
      }
      requestAnimationFrame(drawFrame);

      var stream = canvas.captureStream(30);
      var tracks = stream.getVideoTracks();
      console.log('[CamIntercept MAIN] Canvas stream captured, tracks:', tracks.length, 'canvas:', canvas.width + 'x' + canvas.height);

      // Verify frames are flowing after a short delay
      setTimeout(function() {
        console.log('[CamIntercept MAIN] Frames drawn so far:', _frameCount);
      }, 2000);

      for (var i = 0; i < tracks.length; i++) wrapTrack(tracks[i], STATE.videoMeta);
      return stream;
    })();
    try { return await _activePromise; } finally { _activePromise = null; }
  }

  // ── PATCH: getUserMedia ───────────────────────────────────────────────
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    // Wait for bridge to provide state, or time out
    try { await Promise.race([STATE.readyPromise, timeout]); } catch(e) {}

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
    try { await Promise.race([STATE.readyPromise, timeout]); } catch(e) {}
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
