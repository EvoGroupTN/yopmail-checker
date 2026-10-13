// ISOLATED-world content script for embedded YOPmail frames.
// It detects the human-check wall state and an empty inbox caused by missing
// third-party cookies, then durably signals the popup via chrome.storage.local
// plus chrome.runtime.sendMessage.
(function () {
  'use strict';

  const WALL_KEY = 'yopmail_wall_detected';

  // YOPmail keeps the challenge container (#r_parent) in the page even when no
  // challenge is running; in that case its computed display is 'none'. A challenge
  // counts only when it is actually being displayed, or when its widget frame has
  // been injected (the widget is created only when a challenge is served).
  function challengeActive(doc) {
    try {
      const el = doc.getElementById('r_parent');
      if (!el) return false;
      const cs = (doc.defaultView || window).getComputedStyle(el);
      if (cs.display !== 'none' && cs.visibility !== 'hidden') return true;
      return !!el.querySelector(
        'iframe[src*="challenges.cloudflare.com"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'
      );
    } catch (err) {
      return false;
    }
  }

  function isWallState() {
    return challengeActive(document);
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

  const wallObserver = new MutationObserver(() => {
    if (isWallState()) {
      signalWall();
      wallObserver.disconnect();
    }
  });

  if (document.documentElement) {
    wallObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }

  // Empty-inbox self-heal detection: runs only on the main inbox page (path '/'
  // with a mailbox query string), where YOPmail creates the #ifinbox list frame.
  // If the list frame loads but contains no message rows and no wall is shown,
  // tell the popup to prime the session and reload once.
  function isMainInboxPage() {
    const hostOk = location.hostname === 'yopmail.com' || location.hostname === 'www.yopmail.com';
    if (!hostOk) return false;
    // The mailbox loads at /?login initially and quickly redirects to /inbox?login=...
    return (location.pathname === '/' && location.search.length > 1) || location.pathname === '/inbox';
  }

  // The human-check container (#r_parent) is rendered by YOPmail in the /wm frame,
  // while the message rows live in the child /inbox frame. They are same-origin, so
  // walk the accessible ancestor chain as well: an empty list caused by a live
  // challenge must not be reported as an empty mailbox.
  function wallInAccessibleTree() {
    let win = window;
    for (let i = 0; i < 5; i += 1) {
      let doc;
      try {
        doc = win.document;
      } catch (err) {
        // Cross-origin ancestor: stop walking.
        return false;
      }
      if (!doc) return false;
      if (challengeActive(doc)) return true;
      if (!win.parent || win.parent === win) break;
      win = win.parent;
    }
    return false;
  }

  function hasMessageRows() {
    try {
      const ifinbox = document.getElementById('ifinbox');
      if (ifinbox && ifinbox.contentDocument) {
        return ifinbox.contentDocument.querySelectorAll('.m').length > 0;
      }
    } catch (err) {
      // Cross-origin or not ready yet; fall through.
    }
    return document.querySelectorAll('.m').length > 0;
  }

  function signalEmpty() {
    try {
      chrome.runtime.sendMessage({ type: 'yopmail-empty', url: location.href });
    } catch (err) {
      // Popup may not be open.
    }
  }

  function checkEmptyInbox() {
    if (!isMainInboxPage()) return;
    if (wallInAccessibleTree()) return;
    if (hasMessageRows()) return;
    signalEmpty();
  }

  if (isMainInboxPage()) {
    // Poll a few times to give YOPmail's iframe list time to render.
    let checks = 0;
    const maxChecks = 5;
    const intervalId = setInterval(() => {
      checks += 1;
      if (wallInAccessibleTree() || hasMessageRows()) {
        clearInterval(intervalId);
        return;
      }
      if (checks >= maxChecks) {
        checkEmptyInbox();
        clearInterval(intervalId);
      }
    }, 1200);
  }
})();
