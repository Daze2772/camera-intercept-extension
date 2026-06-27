// main-interceptor.js — Runs in MAIN world at document_start via dynamic registration
// Patches navigator.mediaDevices.getUserMedia, enumerateDevices, ImageCapture
// Delegates stream creation to content-script.js (isolated world, bypasses CSP)

(function() {
  'use strict';

  // Original references saved before patching
  const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _origEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const _origTakePhoto = (typeof ImageCapture !== 'undefined') ? ImageCapture.prototype.takePhoto : null;
  const _origGrabFrame = (typeof ImageCapture !== 'undefined') ? ImageCapture.prototype.grabFrame : null;

  // 15-second timeout so the page doesn't hang forever
  var TIMEOUT_MS = 15000;
  var timeoutPromise = new Promise(function(resolve) {
    setTimeout(function() { resolve('timeout'); }, TIMEOUT_MS);
  });

  // ── State ────────────────────────────────────────────────────────────
  var _readyResolve = null;
  var STATE = {
    enabled: false,
    readyPromise: new Promise(function(r) { _readyResolve = r; }),
    activeInterception: null
  };

  var _lastEnabled = false;

  // ── Spoofed camera ──────────────────────────────────────────────────
  const SPOOF = {
    device: {
      deviceId: 'default-camera-interceptor',
      kind: 'videoinput',
      label: 'USB Camera',
      groupId: 'default-group-interceptor'
    }
  };

  // ── Request stream from content script (isolated world) ──────────────
  var _requestId = 0;
  var _pendingRequests = {};

  function requestStream() {
    var id = ++_requestId;
    var promise = new Promise(function(resolve, reject) {
      _pendingRequests[id] = { resolve: resolve, reject: reject };
    });
    document.dispatchEvent(new CustomEvent('__camRequest', { detail: { requestId: id } }));
    return promise;
  }

  // ── Listen for stream responses from content script ─────────────────
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== '__camResponse') return;
    var id = e.data.requestId;
    var req = _pendingRequests[id];
    if (!req) return;
    delete _pendingRequests[id];

    if (e.data.error) {
      req.reject(new Error(e.data.error));
    } else if (e.data.stream) {
      req.resolve(e.data.stream);
    } else {
      req.reject(new Error('No stream in response'));
    }
  });

  // ── PATCH: getUserMedia ───────────────────────────────────────────────
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    await Promise.race([STATE.readyPromise, timeoutPromise]);

    if (!STATE.enabled) {
      return _origGetUserMedia(constraints);
    }

    try {
      console.log('[CamIntercept MAIN] Requesting stream from bridge...');
      var stream = await Promise.race([
        requestStream(),
        new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error('Stream request timed out')); }, 15000);
        })
      ]);
      console.log('[CamIntercept MAIN] Stream received from bridge');
      return stream;
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

  // ── PATCH: ImageCapture ──────────────────────────────────────────────
  if (_origTakePhoto && _origGrabFrame) {
    ImageCapture.prototype.takePhoto = function() {
      return _origTakePhoto.call(this);
    };
    ImageCapture.prototype.grabFrame = function() {
      return _origGrabFrame.call(this);
    };
  }

  // ── Bridge: listen for enable/disable from isolated world ────────────
  document.addEventListener('__camCommand', function(e) {
    var d = e.detail;
    if (!d) return;
    if (d.action === 'enable') {
      if (_lastEnabled) return;
      _lastEnabled = true;
      STATE.enabled = true;
      if (_readyResolve) { _readyResolve(); _readyResolve = null; }
      console.log('[CamIntercept MAIN] Enabled');
    } else if (d.action === 'disable') {
      if (!_lastEnabled) return;
      _lastEnabled = false;
      STATE.enabled = false;
      console.log('[CamIntercept MAIN] Disabled');
    }
  });

  // postMessage fallback
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.source !== 'cam-intercept-bridge') return;
    if (e.data.action === 'enable') {
      if (_lastEnabled) return;
      _lastEnabled = true;
      STATE.enabled = true;
      if (_readyResolve) { _readyResolve(); _readyResolve = null; }
    } else if (e.data.action === 'disable') {
      if (!_lastEnabled) return;
      _lastEnabled = false;
      STATE.enabled = false;
    }
  });

  console.log('[CamIntercept MAIN] Patched getUserMedia + enumerateDevices. Waiting for bridge.');
})();
