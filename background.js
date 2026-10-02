// Minimal service worker required by Manifest V3.
chrome.runtime.onInstalled.addListener(() => {
  // Nothing to initialise; all state lives in chrome.storage.local.
});
