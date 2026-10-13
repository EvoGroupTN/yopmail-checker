// MAIN-world content script for embedded YOPmail frames.
// It detects the human-check wall state, calls the page's own showRc() so the
// challenge is rendered inside the frame, and also notifies the popup via postMessage.
(function () {
  'use strict';

  function isWallState() {
    // YOPmail always carries the challenge container (#r_parent) in the page; it is
    // only a human-check wall when it is actually being displayed, or when its
    // widget frame has been injected (the widget exists only when a challenge is
    // served). Gating on that avoids calling showRc() — and thus displaying the
    // challenge — on a perfectly healthy mailbox.
    try {
      const el = document.getElementById('r_parent');
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
      return !!el.querySelector(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
      );
    } catch (err) {
      return false;
    }
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
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }
})();
