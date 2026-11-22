// MAIN-world content script for embedded YOPmail frames.
//
// 1. Render YOPmail's human check inside the popup iframe. YOPmail's /inbox page runs
//    `window.top.showRc()` when the server asks for a challenge; inside the popup
//    `window.top` is the extension page (cross-origin), so that call throws and the
//    widget never appears. The /inbox and /wm frames are same-origin, so forward the
//    request to the nearest accessible ancestor that exposes showRc().
// 2. Tell the popup when a challenge becomes visible (and when it clears).
(function () {
  'use strict';

  // A challenge counts as displayed only when its container is laid out. YOPmail keeps
  // #r_parent in the page when idle (display:none), so presence alone means nothing.
  function challengeDisplayed() {
    try {
      const el = document.getElementById('r_parent');
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (err) {
      return false;
    }
  }

  function notifyPopup(type) {
    try {
      window.parent.postMessage({ type, url: location.href }, '*');
    } catch (err) {
      // Cross-origin parent; ignore.
    }
  }

  // Nearest same-origin window (self or ancestor) exposing showRc().
  function findChallengeHost() {
    let win = window;
    for (let i = 0; i < 4; i += 1) {
      try {
        if (typeof win.showRc === 'function') return win;
      } catch (err) {
        return null;
      }
      if (!win.parent || win.parent === win) break;
      win = win.parent;
    }
    return null;
  }

  function requestChallenge() {
    const host = findChallengeHost();
    if (!host) return false;
    try {
      host.showRc();
      return true;
    } catch (err) {
      return false;
    }
  }

  // YOPmail's /inbox stub runs an inline script calling window.top.showRc() only when
  // the server is asking for a human check. That call failed in the popup, so this is
  // the reliable "challenge was requested" marker.
  function challengeRequestedByPage() {
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        if (/(?:window\.)?top\.showRc\s*\(/.test(s.textContent || '')) return true;
      }
    } catch (err) {
      // Ignore.
    }
    return false;
  }

  let wallNotified = false;

  function sample() {
    const visible = challengeDisplayed();
    if (visible && !wallNotified) {
      wallNotified = true;
      notifyPopup('yopmail-wall');
    } else if (!visible && wallNotified) {
      wallNotified = false;
      notifyPopup('yopmail-challenge-done');
    }
  }

  if (challengeDisplayed()) {
    wallNotified = true;
    notifyPopup('yopmail-wall');
  }

  // The challenge container becomes visible synchronously inside showRc(), so one
  // forward is normally enough; retry only while it is still hidden (bounded), so the
  // challenge can never be re-shown after the user solved it.
  function challengeVisibleAtHost() {
    try {
      const host = findChallengeHost();
      const el = host && host.document.getElementById('r_parent');
      return !!el && host.getComputedStyle(el).display !== 'none';
    } catch (err) {
      return false;
    }
  }

  if (challengeRequestedByPage()) {
    requestChallenge();
    if (!challengeVisibleAtHost()) {
      let tries = 0;
      const timer = setInterval(() => {
        tries += 1;
        if (challengeVisibleAtHost() || tries >= 4) {
          clearInterval(timer);
          return;
        }
        requestChallenge();
      }, 800);
    }
  }

  const observer = new MutationObserver(sample);
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
  }
})();
