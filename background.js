// background.js — Service Worker
// Registers main-world content script (bypasses page CSP)
// Handles extension lifecycle, message routing, and storage coordination

const STORAGE_KEYS = {
  INTERCEPTION_ENABLED: 'interceptionEnabled',
  PROFILES: 'profiles',
  ACTIVE_PROFILE_ID: 'activeProfileId',
  LOGS: 'logs'
};

// Register main-world interceptor script on startup
// chrome.scripting.registerContentScripts persists, so only needed once,
// but calling on every startup ensures it's always registered
async function registerMainWorldScript() {
  try {
    // Remove any previous registration first
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    for (const s of scripts) {
      if (s.id === 'main-interceptor') {
        await chrome.scripting.unregisterContentScripts({ ids: ['main-interceptor'] });
      }
    }

    await chrome.scripting.registerContentScripts([{
      id: 'main-interceptor',
      js: ['main-interceptor.js'],
      matches: ['<all_urls>', 'file:///*'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true
    }]);
    console.log('[BG] Main-world interceptor registered');
  } catch (e) {
    console.error('[BG] Failed to register main-world script:', e.message);
  }
}

// Initialize default state on install
chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.local.set({
    [STORAGE_KEYS.INTERCEPTION_ENABLED]: false,
    [STORAGE_KEYS.PROFILES]: [],
    [STORAGE_KEYS.ACTIVE_PROFILE_ID]: null,
    [STORAGE_KEYS.LOGS]: []
  });

  // Register main-world script (only on install to avoid duplicate registrations)
  await registerMainWorldScript();

  console.log('[BG] Extension installed, default state set, main-world script registered');
});

// Also register on every service worker start (handles cases where SW restarts)
registerMainWorldScript();

// Keep service worker alive during message chains
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_STATE':
      chrome.storage.local.get(null, (data) => {
        sendResponse({ success: true, data });
      });
      return true;

    case 'SET_STATE':
      chrome.storage.local.set(message.payload, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'GET_ACTIVE_TAB':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        sendResponse({ success: true, tab: tabs[0] });
      });
      return true;

    case 'ADD_LOG':
      chrome.storage.local.get([STORAGE_KEYS.LOGS], (data) => {
        const logs = data[STORAGE_KEYS.LOGS] || [];
        logs.push({ timestamp: Date.now(), ...message.entry });
        const trimmed = logs.slice(-500);
        chrome.storage.local.set({ [STORAGE_KEYS.LOGS]: trimmed }, () => {
          sendResponse({ success: true });
        });
      });
      return true;

    default:
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
  }
});

console.log('[BG] Service worker started');
