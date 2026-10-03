// ISOLATED-world content script for embedded YOPmail frames.
// It detects the human-check wall state and durably signals the popup via
// chrome.storage.local plus chrome.runtime.sendMessage.
(function () {
  'use strict';

  const WALL_KEY = 'yopmail_wall_detected';

  function isWallState() {
    return !!document.getElementById('r_parent');
  }

  function signalWall() {
    try {
      chrome.storage.local.set({ [WALL_KEY]: true });
    } catch (err) {
      // Ignore.
    }
    try {
      chrome.runtime.sendMessage({ type: 'yopmail-wall', url: location.href });
    } catch (err) {
      // Popup may not be open.
    }
  }

  if (isWallState()) {
    signalWall();
  }

  const observer = new MutationObserver(() => {
    if (isWallState()) {
      signalWall();
      observer.disconnect();
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
