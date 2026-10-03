// MAIN-world content script for embedded YOPmail frames.
// It detects the human-check wall state, calls the page's own showRc() so the
// challenge is rendered inside the frame, and also notifies the popup via postMessage.
(function () {
  'use strict';

  function isWallState() {
    // The challenge container is present and hidden on the /wm frame when the
    // inbox triggers the human check.
    return !!document.getElementById('r_parent');
  }

  function notifyPopup() {
    try {
      window.parent.postMessage(
        { type: 'yopmail-wall', url: location.href },
        '*'
      );
    } catch (err) {
      // Ignore cross-origin postMessage failures.
    }
  }

  function showChallenge() {
    if (typeof showRc === 'function') {
      try {
        showRc();
      } catch (err) {
        // showRc may rely on window.top which is cross-origin in the popup.
      }
    }
  }

  function handleWall() {
    notifyPopup();
    showChallenge();
  }

  let handled = false;

  if (isWallState()) {
    handled = true;
    handleWall();
  }

  // YOPmail builds the inbox dynamically; watch for the challenge container to appear.
  const observer = new MutationObserver(() => {
    if (isWallState() && !handled) {
      handled = true;
      handleWall();
      observer.disconnect();
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
