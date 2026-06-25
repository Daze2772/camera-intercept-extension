// headless-interceptor.js
// Standalone version of content-script.js for headless testing.
// Injected via page.evaluateOnNewDocument() — no chrome.* API dependencies.
// Communicates via window.__camInterceptState instead of chrome.storage.

(function() {
  'use strict';

  // ── State (configurable via window.__camInterceptState) ────────────
  const state = window.__camInterceptState || {
    enabled: false,
    videoData: null,
    videoMime: 'video/webm',
    videoMeta: null
  };
  window.__camInterceptState = state;

  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const originalEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

  // ── Spoofed capabilities / settings ─────────────────────────────────
  const SPOOFED_CAPABILITIES = {
    width: { min: 320, max: 1920 },
    height: { min: 240, max: 1080 },
    frameRate: { min: 1, max: 30 },
    facingMode: ['user'],
    resizeMode: ['none', 'crop-and-scale'],
    aspectRatio: { min: 0.5, max: 2.0 },
    deviceId: 'default-camera-interceptor',
    groupId: 'default-group-interceptor'
  };

  function buildSpoofedSettings(meta) {
    return {
      width: meta?.width || 1280,
      height: meta?.height || 720,
      frameRate: meta?.frameRate || 30,
      deviceId: 'default-camera-interceptor',
      facingMode: 'user',
      aspectRatio: (meta?.width || 1280) / (meta?.height || 720)
    };
  }

  // ── Video helpers ────────────────────────────────────────────────────
  let videoElementCache = null;

  function createHiddenVideo(base64Data, mimeType) {
    if (videoElementCache) {
      videoElementCache.pause();
      videoElementCache.removeAttribute('src');
    }

    const video = document.createElement('video');
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.crossOrigin = 'anonymous';

    const byteChars = atob(base64Data);
    const byteNums = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNums[i] = byteChars.charCodeAt(i);
    const blob = new Blob([byteNums], { type: mimeType || 'video/webm' });
    const url = URL.createObjectURL(blob);
    video.src = url;
    document.body.appendChild(video);
    videoElementCache = video;
    return video;
  }

  function waitForVideoReady(video) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 3) { resolve(); return; }
      video.addEventListener('canplay', () => resolve(), { once: true });
      video.addEventListener('error', (e) => reject(e), { once: true });
      video.load();
    });
  }

  // ── Track wrapper ────────────────────────────────────────────────────
  function wrapVideoTrack(originalTrack, meta) {
    const settings = buildSpoofedSettings(meta);
    const origGetCapabilities = originalTrack.getCapabilities?.bind(originalTrack);
    const origGetSettings = originalTrack.getSettings?.bind(originalTrack);
    const origGetConstraints = originalTrack.getConstraints?.bind(originalTrack);
    const origClone = originalTrack.clone?.bind(originalTrack);

    originalTrack.getCapabilities = function() {
      try {
        const realCaps = origGetCapabilities ? origGetCapabilities() : {};
        return { ...SPOOFED_CAPABILITIES, ...realCaps, deviceId: SPOOFED_CAPABILITIES.deviceId };
      } catch (e) { return { ...SPOOFED_CAPABILITIES }; }
    };

    originalTrack.getSettings = function() {
      try {
        const realSettings = origGetSettings ? origGetSettings() : {};
        return { ...realSettings, ...settings };
      } catch (e) { return { ...settings }; }
    };

    originalTrack.getConstraints = function() {
      try {
        return origGetConstraints ? origGetConstraints() : { video: { width: settings.width, height: settings.height } };
      } catch (e) { return { video: { width: settings.width, height: settings.height } }; }
    };

    originalTrack.applyConstraints = function(newConstraints) {
      return Promise.resolve();
    };

    originalTrack.clone = function() {
      const cloned = origClone ? origClone() : originalTrack;
      return wrapVideoTrack(cloned, meta);
    };

    Object.defineProperty(originalTrack, 'label', {
      get: function() { return 'USB Camera'; },
      configurable: true
    });

    return originalTrack;
  }

  // ── Core interception ────────────────────────────────────────────────
  let activeInterceptionPromise = null;

  async function interceptGetUserMedia(constraints) {
    if (activeInterceptionPromise) {
      try { return await activeInterceptionPromise; } catch (e) { /* fall through */ }
    }

    activeInterceptionPromise = (async () => {
      const videoData = state.videoData;
      const videoMime = state.videoMime || 'video/webm';
      const videoMeta = state.videoMeta || null;

      if (!videoData) {
        throw new DOMException('No video source loaded', 'NotReadableError');
      }

      const video = createHiddenVideo(videoData, videoMime);
      await waitForVideoReady(video);

      let stream;
      try {
        stream = video.captureStream(30);
      } catch (e) {
        if (video.captureStream) {
          stream = video.captureStream(30);
        }
        if (!stream) throw new DOMException('captureStream not supported', 'NotSupportedError');
      }

      const videoTracks = stream.getVideoTracks();
      for (const track of videoTracks) {
        wrapVideoTrack(track, videoMeta);
      }

      video.loop = true;
      await video.play();
      return stream;
    })();

    try {
      return await activeInterceptionPromise;
    } finally {
      activeInterceptionPromise = null;
    }
  }

  // ── Patch getUserMedia ──────────────────────────────────────────────
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (!state.enabled) {
      return originalGetUserMedia(constraints);
    }

    try {
      console.log('[HeadlessInterceptor] Intercepting getUserMedia...');
      return await interceptGetUserMedia(constraints);
    } catch (e) {
      console.warn('[HeadlessInterceptor] Interception failed, falling back:', e.message);
      return originalGetUserMedia(constraints);
    }
  };

  // ── Patch enumerateDevices ─────────────────────────────────────────
  navigator.mediaDevices.enumerateDevices = async function() {
    if (!state.enabled) {
      return originalEnumerateDevices();
    }
    try {
      const realDevices = await originalEnumerateDevices();
      const spoofedVideo = {
        deviceId: 'default-camera-interceptor',
        kind: 'videoinput',
        label: 'USB Camera',
        groupId: 'default-group-interceptor'
      };
      const filtered = realDevices.filter(d => d.kind !== 'videoinput');
      filtered.unshift(spoofedVideo);
      return filtered;
    } catch (e) {
      return originalEnumerateDevices();
    }
  };

  // ── Patch ImageCapture ──────────────────────────────────────────────
  if (typeof ImageCapture !== 'undefined') {
    const origTakePhoto = ImageCapture.prototype.takePhoto;
    const origGrabFrame = ImageCapture.prototype.grabFrame;

    ImageCapture.prototype.takePhoto = function() {
      const s = window.__camInterceptState;
      if (s.enabled && videoElementCache && videoElementCache.readyState >= 2) {
        const canvas = document.createElement('canvas');
        canvas.width = videoElementCache.videoWidth || 1280;
        canvas.height = videoElementCache.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoElementCache, 0, 0, canvas.width, canvas.height);
        return new Promise((resolve) => {
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
        });
      }
      return origTakePhoto.call(this);
    };

    ImageCapture.prototype.grabFrame = function() {
      const s = window.__camInterceptState;
      if (s.enabled && videoElementCache && videoElementCache.readyState >= 2) {
        const canvas = document.createElement('canvas');
        canvas.width = videoElementCache.videoWidth || 1280;
        canvas.height = videoElementCache.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(videoElementCache, 0, 0, canvas.width, canvas.height);
        return createImageBitmap(canvas);
      }
      return origGrabFrame.call(this);
    };
  }

  console.log('[HeadlessInterceptor] Injected. getUserMedia patched. Enabled:', state.enabled);
})();
