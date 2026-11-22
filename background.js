// Minimal service worker required by Manifest V3.
chrome.runtime.onInstalled.addListener(() => {
  // Nothing to initialise; all state lives in chrome.storage.local.
});

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// Make YOPmail's cookies survive the browser session. The embedded frame is a
// third-party context, so cookies from the challenge response can be session-scoped
// (or dropped); re-setting them through chrome.cookies persists them, HttpOnly ones
// included, because the extension sees the whole jar.
async function persistYopmailCookies() {
  const saved = [];
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'yopmail.com' });
    const minExpiry = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    for (const c of cookies) {
      const host = String(c.domain || 'yopmail.com').replace(/^\./, '');
      const cookiePath = c.path || '/';
      const details = {
        url: `https://${host}${cookiePath}`,
        name: c.name,
        value: c.value,
        path: cookiePath,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate && c.expirationDate > minExpiry ? c.expirationDate : minExpiry,
      };
      // Mirror the original domain cookie (".yopmail.com") instead of creating a
      // host-only clone, otherwise the jar ends up with two cookies of the same name.
      if (!c.hostOnly && c.domain) details.domain = c.domain;
      if (c.storeId) details.storeId = c.storeId;
      try {
        await chrome.cookies.set(details);
        saved.push(c.name);
      } catch (err) {
        console.warn('[YOPmail Checker] could not persist cookie', c.name, err);
      }
    }
  } catch (err) {
    console.warn('[YOPmail Checker] cookie persistence failed', err);
  }
  return saved;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'yopmail-challenge-done') return false;
  persistYopmailCookies().then((names) => {
    try {
      chrome.runtime.sendMessage({ type: 'yopmail-session-saved', names }).catch(() => {});
    } catch (err) {
      // No popup open.
    }
    sendResponse({ ok: true, names });
  });
  return true;
});
