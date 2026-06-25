// popup.js — Dashboard UI logic for Camera Interceptor extension

// ── DOM refs ──────────────────────────────────────────────────────────
const interceptToggle = document.getElementById('intercept-toggle');
const statusText = document.getElementById('status-text');
const profileSelect = document.getElementById('profile-select');
const loadVideoBtn = document.getElementById('load-video-btn');
const renameProfileBtn = document.getElementById('rename-profile-btn');
const deleteProfileBtn = document.getElementById('delete-profile-btn');
const fileInput = document.getElementById('file-input');
const videoMeta = document.getElementById('video-meta');
const metaResolution = document.getElementById('meta-resolution');
const metaFramerate = document.getElementById('meta-framerate');
const metaDuration = document.getElementById('meta-duration');
const metaCodec = document.getElementById('meta-codec');
const metaSize = document.getElementById('meta-size');
const previewVideo = document.getElementById('preview-video');
const noPreviewText = document.getElementById('no-preview-text');
const activeCount = document.getElementById('active-count');
const currentUrl = document.getElementById('current-url');
const logToggle = document.getElementById('log-toggle');
const logPanel = document.getElementById('log-panel');
const logEntries = document.getElementById('log-entries');
const logArrow = document.getElementById('log-arrow');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const testPageBtn = document.getElementById('test-page-btn');

// ── State ─────────────────────────────────────────────────────────────
let profiles = [];
let activeProfileId = null;

// ── Helpers ───────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Load state ────────────────────────────────────────────────────────
async function loadState() {
  const data = await chrome.storage.local.get([
    'interceptionEnabled', 'profiles', 'activeProfileId', 'logs'
  ]);

  interceptToggle.checked = data.interceptionEnabled || false;
  updateStatusText(data.interceptionEnabled);

  profiles = data.profiles || [];
  activeProfileId = data.activeProfileId || null;

  renderProfileSelect();

  // Load active profile video for preview
  if (activeProfileId) {
    const activeProfile = profiles.find(p => p.id === activeProfileId);
    if (activeProfile) {
      displayActiveVideoMeta(activeProfile.videoMeta);
      loadPreviewVideo(activeProfile.videoData, activeProfile.videoMime || 'video/webm');
    }
  }

  renderLogs(data.logs || []);
  fetchCurrentTabUrl();
}

function updateStatusText(enabled) {
  statusText.textContent = enabled
    ? 'Interception ACTIVE — pre-recorded video fed to pages'
    : 'Passthrough Mode — real camera active';
  statusText.className = enabled ? 'status-text status-active' : 'status-text status-passthrough';
}

// ── Profile management ────────────────────────────────────────────────
function renderProfileSelect() {
  profileSelect.innerHTML = '<option value="">— No profile loaded —</option>';
  for (const p of profiles) {
    const selected = p.id === activeProfileId ? ' selected' : '';
    profileSelect.innerHTML += `<option value="${p.id}"${selected}>${p.name}</option>`;
  }
}

async function selectProfile(profileId) {
  activeProfileId = profileId;
  await chrome.storage.local.set({ activeProfileId: profileId });

  if (!profileId) {
    previewVideo.src = '';
    previewVideo.classList.add('hidden');
    noPreviewText.classList.remove('hidden');
    videoMeta.classList.add('hidden');
    return;
  }

  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return;

  // Just set the active profile ID — video data is in profiles array
  await chrome.storage.local.set({ activeProfileId: profileId });

  loadPreviewVideo(profile.videoData, profile.videoMime || 'video/webm');
  displayActiveVideoMeta(profile.videoMeta);

  // Notify content scripts about the new video source
  notifyContentScripts();
}

// ── Video loading ─────────────────────────────────────────────────────
loadVideoBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Check size cap (50MB)
  if (file.size > 50 * 1024 * 1024) {
    alert('Video exceeds 50MB size cap. Please select a smaller file.');
    fileInput.value = '';
    return;
  }

  // Read as base64
  const reader = new FileReader();
  reader.onload = async (ev) => {
    const base64 = ev.target.result.split(',')[1]; // strip data: prefix
    const mime = file.type || 'video/webm';

    console.log('[Popup] Video read, base64 size:', (base64.length / 1024).toFixed(1), 'KB');

    // Extract metadata from video
    const meta = await extractVideoMeta(base64, mime);
    console.log('[Popup] Metadata extracted:', meta);

    // Create profile
    const profile = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, ''),
      videoData: base64,
      videoMime: mime,
      videoMeta: meta,
      fileName: file.name,
      fileSize: file.size,
      addedAt: Date.now()
    };

    profiles.push(profile);

    // Store profiles array (video data lives here only — no duplication)
    try {
      await chrome.storage.local.set({ profiles: profiles });
      if (chrome.runtime.lastError) {
        console.error('[Popup] Storage error:', chrome.runtime.lastError.message);
        alert('Failed to save: ' + chrome.runtime.lastError.message);
        profiles.pop();
        return;
      }
      console.log('[Popup] Profiles saved, count:', profiles.length);
    } catch (e) {
      console.error('[Popup] Storage exception:', e.message);
      alert('Failed to save video: ' + e.message);
      profiles.pop();
      return;
    }

    // Auto-select the new profile (store only the ID)
    activeProfileId = profile.id;
    try {
      await chrome.storage.local.set({ activeProfileId: profile.id });
    } catch (e) {
      console.error('[Popup] Storage exception on profile select:', e.message);
    }

    renderProfileSelect();
    displayActiveVideoMeta(meta);
    loadPreviewVideo(base64, mime);
    notifyContentScripts();
  };

  reader.onerror = (err) => {
    console.error('[Popup] FileReader error:', err);
    alert('Failed to read video file.');
  };

  reader.readAsDataURL(file);
  fileInput.value = '';
});

function loadPreviewVideo(base64Data, mimeType) {
  const byteChars = atob(base64Data);
  const byteNums = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNums[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteNums], { type: mimeType });
  const url = URL.createObjectURL(blob);

  previewVideo.src = url;
  previewVideo.classList.remove('hidden');
  noPreviewText.classList.add('hidden');
  previewVideo.play().catch(() => {});
}

async function extractVideoMeta(base64Data, mimeType) {
  return new Promise((resolve) => {
    const byteChars = atob(base64Data);
    const byteNums = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNums[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteNums], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      const meta = {
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        frameRate: 30, // default, browser doesn't expose reliably
        duration: video.duration || 0,
        codec: 'unknown'
      };

      // Attempt codec detection via MediaSource or canPlayType
      URL.revokeObjectURL(url);
      resolve(meta);
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0, frameRate: 30, duration: 0, codec: 'unknown' });
    };

    video.src = url;
  });
}

function displayActiveVideoMeta(meta) {
  if (!meta) {
    videoMeta.classList.add('hidden');
    return;
  }
  videoMeta.classList.remove('hidden');
  metaResolution.textContent = meta.width && meta.height
    ? `${meta.width} × ${meta.height}`
    : '—';
  metaFramerate.textContent = meta.frameRate ? `${meta.frameRate} fps` : '—';
  metaDuration.textContent = meta.duration ? formatDuration(meta.duration) : '—';
  metaCodec.textContent = meta.codec || '—';
  metaSize.textContent = '—'; // Updated on profile load
}

// ── Profile actions ───────────────────────────────────────────────────
profileSelect.addEventListener('change', () => {
  selectProfile(profileSelect.value || null);
});

deleteProfileBtn.addEventListener('click', async () => {
  if (!activeProfileId) return;
  const profile = profiles.find(p => p.id === activeProfileId);
  if (!confirm(`Delete profile "${profile?.name}"?`)) return;

  profiles = profiles.filter(p => p.id !== activeProfileId);
  await chrome.storage.local.set({ profiles });

  if (profiles.length === 0) {
    activeProfileId = null;
    await selectProfile(null);
  } else {
    activeProfileId = profiles[0].id;
    await selectProfile(activeProfileId);
  }
  renderProfileSelect();
});

renameProfileBtn.addEventListener('click', async () => {
  if (!activeProfileId) return;
  const profile = profiles.find(p => p.id === activeProfileId);
  const newName = prompt('New profile name:', profile?.name || '');
  if (!newName) return;

  profile.name = newName;
  await chrome.storage.local.set({ profiles });
  renderProfileSelect();
});

// ── Toggle interception ──────────────────────────────────────────────
interceptToggle.addEventListener('change', async () => {
  const enabled = interceptToggle.checked;
  await chrome.storage.local.set({ interceptionEnabled: enabled });
  updateStatusText(enabled);
  notifyContentScripts();
});

// ── Content script communication ──────────────────────────────────────
async function notifyContentScripts() {
  const enabled = interceptToggle.checked;
  // Storage changes trigger content script bridge automatically via onChanged.
  // Still send direct message for immediate response on active tab.
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    chrome.tabs.sendMessage(tabs[0].id, {
      type: 'STATE_CHANGED'
    }).catch(() => {});
  });
}

// ── Status panel ──────────────────────────────────────────────────────
async function fetchCurrentTabUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      currentUrl.textContent = tabs[0].url;
    }
  } catch (e) {
    currentUrl.textContent = '—';
  }
}

// ── Log panel ─────────────────────────────────────────────────────────
logToggle.addEventListener('click', () => {
  const isOpen = logPanel.style.display !== 'none';
  logPanel.style.display = isOpen ? 'none' : 'block';
  logArrow.textContent = isOpen ? '▶' : '▼';
});

function renderLogs(logs) {
  if (!logs.length) {
    logEntries.innerHTML = '<p class="muted">No events yet</p>';
    return;
  }
  logEntries.innerHTML = logs.reverse().slice(0, 50).map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    let typeClass = 'log-info';
    if (log.event === 'interception') typeClass = 'log-success';
    if (log.event === 'error') typeClass = 'log-error';

    let detail = '';
    if (log.url) detail += `<span class="log-detail">${log.url}</span>`;
    if (log.trackLabel) detail += `<span class="log-detail">track: ${log.trackLabel}</span>`;

    return `
      <div class="log-entry ${typeClass}">
        <span class="log-time">${time}</span>
        <span class="log-event">${log.event}</span>
        ${detail}
      </div>
    `;
  }).join('');
}

clearLogsBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
  logEntries.innerHTML = '<p class="muted">No events yet</p>';
});

// ── Test page ─────────────────────────────────────────────────────────
testPageBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('test-pages/basic-camera.html') });
});

// ── Periodic status refresh ───────────────────────────────────────────
setInterval(fetchCurrentTabUrl, 3000);
setInterval(async () => {
  const data = await chrome.storage.local.get(['logs']);
  renderLogs(data.logs || []);
}, 5000);

// ── Init ──────────────────────────────────────────────────────────────
loadState();
