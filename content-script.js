// Content script: read-only capture of a YOPmail message from a real tab.
// Runs on https://yopmail.com/*, but only acts on /en/mail pages and never
// inside the reCAPTCHA iframe (window.self !== window.top check).
(function () {
  'use strict';

  // Never run inside an iframe (the reCAPTCHA challenge lives in one).
  if (window.self !== window.top) return;

  const STORAGE_KEY_PREFIX = 'yopmail_captured_';
  const processed = new Set();

  function getMailInfo() {
    const url = new URL(location.href);
    if (!url.pathname.startsWith('/en/mail')) return null;
    const rawId = url.searchParams.get('id') || '';
    const address = url.searchParams.get('b') || '';
    if (!rawId || !address) return null;
    // YOPmail ids arrive with a mode prefix (m/i/h/t/s). Strip it for the canonical msgId.
    const msgId = rawId.replace(/^[a-z]/i, '');
    return { address, msgId, rawId };
  }

  function waitForMailctn() {
    const el = document.getElementById('mailctn');
    if (el && el.textContent.trim().length > 0) {
      return Promise.resolve(el);
    }
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const found = document.getElementById('mailctn');
        if (found && found.textContent.trim().length > 0) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function sanitizeFragment(html) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;

    // Strip dangerous/undesirable tags and hidden elements.
    wrapper.querySelectorAll('script, meta, link, iframe, frame, style').forEach((el) => el.remove());
    wrapper.querySelectorAll('[style*="display:none" i], [style*="display: none" i]').forEach((el) => el.remove());

    // Remove the message's own document wrapper if YOPmail nested the body directly.
    const ownWrapper = wrapper.querySelector('#mailctn, #mail');
    if (ownWrapper && ownWrapper !== wrapper) {
      ownWrapper.querySelectorAll('script, meta, link, iframe, frame, style').forEach((el) => el.remove());
    }

    // Remove any leftover YOPmail viewer toolbar items.
    const toolbarLabels = new Set(['Deliverability', 'Reply', 'Forward', 'Print', 'Delete', 'Html', 'Text', 'Headers', 'Source', 'Download']);
    wrapper.querySelectorAll('*').forEach((el) => {
      if (el.children.length === 0 && toolbarLabels.has(el.textContent.trim())) {
        el.remove();
      }
    });

    // Make links open externally.
    wrapper.querySelectorAll('a[href]').forEach((a) => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    });

    return wrapper.innerHTML;
  }

  function extractMessage() {
    const parsed = new DOMParser().parseFromString(document.documentElement.outerHTML, 'text/html');
    const container = parsed.getElementById('mailctn') || parsed.getElementById('mail');
    if (!container) return null;

    const rawFragment = container.innerHTML;
    if (!rawFragment.trim()) return null;

    const cleanHtml = sanitizeFragment(rawFragment);

    const temp = document.createElement('div');
    temp.innerHTML = cleanHtml;
    const imgs = temp.querySelectorAll('img');
    const hasBlankImages = Array.from(imgs).some((img) => !img.getAttribute('src'));

    return { html: cleanHtml, hasBlankImages };
  }

  async function captureAndReport() {
    const info = getMailInfo();
    if (!info) return;
    if (processed.has(info.msgId)) return;

    const container = await waitForMailctn();
    if (!container) return;

    const msg = extractMessage();
    if (!msg || !msg.html.trim()) return;

    processed.add(info.msgId);

    const payload = {
      type: 'captured-mail',
      address: info.address,
      msgId: info.msgId,
      html: msg.html,
      hasBlankImages: msg.hasBlankImages,
      capturedAt: Date.now(),
    };

    try {
      await chrome.storage.local.set({ [STORAGE_KEY_PREFIX + info.msgId]: payload });
    } catch (err) {
      console.warn('YOPmail Checker: failed to store captured mail', err);
    }

    try {
      await chrome.runtime.sendMessage(payload);
    } catch (err) {
      // Popup may be closed; storage is the durable fallback.
      console.warn('YOPmail Checker: sendMessage failed (popup closed?)', err);
    }
  }

  captureAndReport();
})();
