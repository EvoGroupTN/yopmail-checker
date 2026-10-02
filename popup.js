const VERSION_DEFAULT = '9.4';
const STORAGE_KEY = 'yopmail_address';
const STORAGE_ADDRESSES_KEY = 'yopmail_addresses';
const MAX_ADDRESSES = 25;

const els = {
  input: document.getElementById('addressInput'),
  goBtn: document.getElementById('goBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  status: document.getElementById('status'),
  inboxList: document.getElementById('inboxList'),
  mailContent: document.getElementById('mailContent'),
  combo: document.getElementById('addressCombo'),
  toggle: document.getElementById('addressToggle'),
  list: document.getElementById('addressList'),
};

let addresses = [];

let state = {
  address: '',
  yp: '',
  yj: '',
  version: VERSION_DEFAULT,
  mails: [],
  selectedId: null,
  loading: false,
};

function cleanAddress(raw) {
  let addr = (raw || '').trim().toLowerCase();
  if (addr.endsWith('@yopmail.com')) {
    addr = addr.slice(0, -12);
  }
  return addr.replace(/[^a-z0-9._-]/g, '');
}

function isValidAddress(addr) {
  return addr.length >= 1 && addr.length <= 100;
}

function setStatus(text, type = '') {
  els.status.textContent = text;
  els.status.className = 'status ' + type;
}

function setLoading(loading) {
  state.loading = loading;
  els.goBtn.disabled = loading;
  els.refreshBtn.disabled = loading;
  if (loading) {
    setStatus('Loading…', 'loading');
  } else if (els.status.classList.contains('loading')) {
    setStatus('');
  }
}

async function setYTimeCookie() {
  const d = new Date();
  const value = `${d.getHours()}:${d.getMinutes()}`;
  try {
    await chrome.cookies.set({
      url: 'https://yopmail.com',
      name: 'ytime',
      value,
      domain: '.yopmail.com',
      path: '/',
    });
  } catch (err) {
    // Non-fatal; some Chromium builds may reject the domain format.
    console.warn('Could not set ytime cookie:', err.message);
  }
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function bootstrapSession(address, force = false) {
  if (state.yp && !force) return;

  // Step 1a: GET bootstrap page (sets yc/yses cookies and gives initial yp).
  const url = `https://yopmail.com/en/?login=${encodeURIComponent(address)}`;
  const { ok, status, text } = await fetchText(url);
  if (!ok) {
    throw new Error(`Bootstrap failed: HTTP ${status}`);
  }

  const ypMatch = text.match(/id="yp"[^>]*value="([^"]+)"/);
  if (!ypMatch) {
    throw new Error('Could not find yp token in YOPmail page.');
  }
  const yp1 = ypMatch[1];

  const verMatch = text.match(/\/ver\/([0-9.]+)\/webmail\.js/);
  state.version = verMatch ? verMatch[1] : VERSION_DEFAULT;

  // Step 1b: auto-submit the form to establish the session page and compte/ywm cookies.
  const formRes = await fetch('https://yopmail.com/en/', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `yp=${encodeURIComponent(yp1)}&login=${encodeURIComponent(address)}&id=`,
  });
  const formText = await formRes.text();
  if (!formRes.ok) {
    throw new Error(`Session form submit failed: HTTP ${formRes.status}`);
  }

  const yp2Match = formText.match(/id="yp"[^>]*value="([^"]+)"/);
  state.yp = yp2Match ? yp2Match[1] : yp1;

  // Step 2: read anti-bot token from the served webmail.js.
  const jsUrl = `https://yopmail.com/ver/${state.version}/webmail.js`;
  const jsRes = await fetchText(jsUrl);
  if (!jsRes.ok) {
    throw new Error(`Could not load webmail.js: HTTP ${jsRes.status}`);
  }
  const yjMatch = jsRes.text.match(/yj=([A-Za-z0-9]+)/);
  if (!yjMatch) {
    throw new Error('Could not find yj token in webmail.js.');
  }
  state.yj = yjMatch[1];
}

async function fetchInbox(address) {
  await bootstrapSession(address);

  // ytime is set by JS on the YOPmail page; set it manually from the extension.
  await setYTimeCookie();

  const params = new URLSearchParams({
    login: address,
    p: '1',
    d: '',
    ctrl: '',
    yp: state.yp,
    yj: state.yj,
    v: state.version,
    r_c: '',
    id: '',
    ad: '0',
  });
  const url = `https://yopmail.com/en/inbox?${params.toString()}`;
  let res = await fetchText(url);

  if (!res.ok || res.status === 400) {
    // Session token probably stale; refresh once and retry.
    await bootstrapSession(address, true);
    params.set('yp', state.yp);
    params.set('yj', state.yj);
    params.set('v', state.version);
    await setYTimeCookie();
    res = await fetchText(`https://yopmail.com/en/inbox?${params.toString()}`);
  }

  if (!res.ok) {
    throw new Error(`Inbox request failed: HTTP ${res.status}`);
  }

  return parseInbox(res.text);
}

function parseInbox(html) {
  const mails = [];
  const div = document.createElement('div');
  div.innerHTML = html;

  const items = div.querySelectorAll('.m');
  let i = 0;
  for (const item of items) {
    if (i >= 3) break;
    const id = item.getAttribute('id');
    if (!id) continue;

    const timeEl = item.querySelector('.lmh');
    const senderEl = item.querySelector('.lmf');
    const subjectEl = item.querySelector('.lms');

    mails.push({
      id,
      time: timeEl ? timeEl.textContent.trim() : '',
      sender: senderEl ? senderEl.textContent.trim() : '',
      subject: subjectEl ? subjectEl.textContent.trim() : '(no subject)',
    });
    i++;
  }

  return mails;
}

async function fetchMailBody(address, msgId) {
  await setYTimeCookie();
  const url = `https://yopmail.com/en/mail?b=${encodeURIComponent(address)}&id=m${encodeURIComponent(msgId)}`;
  const { ok, status, text } = await fetchText(url);
  if (!ok) {
    throw new Error(`Mail body failed: HTTP ${status}`);
  }
  return text;
}

function stripScripts(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script').forEach((s) => s.remove());
  div.querySelectorAll('iframe, frame').forEach((f) => f.remove());
  // Make links open externally rather than inside the iframe.
  div.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  return div.innerHTML;
}

function extractBody(html) {
  // YOPmail wraps the actual message in <div id="mail">.
  const mailMatch = html.match(/<div id="mail"[^>]*>([\s\S]*?)<\/div>/i);
  if (mailMatch) return mailMatch[1];
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

function renderInbox() {
  els.inboxList.innerHTML = '';

  if (state.mails.length === 0) {
    els.inboxList.innerHTML = '<div class="empty">No mail.</div>';
    els.mailContent.innerHTML = '<div class="empty">Select an email to read it.</div>';
    return;
  }

  state.mails.forEach((mail) => {
    const item = document.createElement('div');
    item.className = 'mail-item' + (mail.id === state.selectedId ? ' active' : '');
    item.innerHTML = `
      <span class="time">${escapeHtml(mail.time)}</span>
      <div class="sender">${escapeHtml(mail.sender)}</div>
      <div class="subject">${escapeHtml(mail.subject)}</div>
    `;
    item.addEventListener('click', () => selectMail(mail.id));
    els.inboxList.appendChild(item);
  });

  if (!state.selectedId && state.mails[0]) {
    selectMail(state.mails[0].id);
  }
}

async function selectMail(msgId) {
  state.selectedId = msgId;
  renderInbox();

  const mail = state.mails.find((m) => m.id === msgId);
  if (!mail) return;

  els.mailContent.innerHTML = '<div class="empty">Loading message…</div>';

  try {
    const rawHtml = await fetchMailBody(state.address, msgId);
    const cleanHtml = stripScripts(rawHtml);
    const body = extractBody(cleanHtml);

    const iframe = document.createElement('iframe');
    iframe.sandbox = '';
    iframe.srcdoc = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <base target="_blank">
        <style>
          html, body { background: #ffffff; color: #1a1a1a; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; padding: 12px; margin: 0; }
          pre, code { white-space: pre-wrap; word-break: break-word; }
          img { max-width: 100%; height: auto; }
          a { color: #4f8cff; }
        </style>
      </head>
      <body>${body}</body>
      </html>
    `;

    els.mailContent.innerHTML = '';
    els.mailContent.appendChild(iframe);
  } catch (err) {
    els.mailContent.innerHTML = `<div class="empty error">${escapeHtml(err.message)}</div>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadAddresses() {
  const saved = await chrome.storage.local.get([STORAGE_KEY, STORAGE_ADDRESSES_KEY]);
  let list = saved[STORAGE_ADDRESSES_KEY];
  if (!Array.isArray(list)) {
    list = saved[STORAGE_KEY] ? [saved[STORAGE_KEY]] : [];
    await chrome.storage.local.set({ [STORAGE_ADDRESSES_KEY]: list });
  }
  addresses = list.slice(0, MAX_ADDRESSES);
}

async function rememberAddress(address) {
  const cleaned = cleanAddress(address);
  if (!isValidAddress(cleaned)) return;
  addresses = [cleaned, ...addresses.filter((a) => a !== cleaned)].slice(0, MAX_ADDRESSES);
  await chrome.storage.local.set({
    [STORAGE_KEY]: cleaned,
    [STORAGE_ADDRESSES_KEY]: addresses,
  });
}

async function removeAddress(address) {
  const inputAddress = cleanAddress(els.input.value);
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  const storedAddress = cleanAddress(saved[STORAGE_KEY] || '');

  addresses = addresses.filter((a) => a !== address);
  const updates = { [STORAGE_ADDRESSES_KEY]: addresses };

  if (inputAddress === address || storedAddress === address) {
    els.input.value = '';
    updates[STORAGE_KEY] = '';
  }

  await chrome.storage.local.set(updates);
  renderAddressList();
}

async function loadAddress() {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  if (saved[STORAGE_KEY]) {
    els.input.value = saved[STORAGE_KEY];
  }
}

function getQueryAddress() {
  return new URLSearchParams(location.search).get('address');
}

async function go(forceRefresh = false) {
  if (state.loading) return;

  const raw = els.input.value;
  const address = cleanAddress(raw);

  if (!isValidAddress(address)) {
    setStatus('Please enter a valid YOPmail address.', 'error');
    return;
  }

  state.address = address;
  els.input.value = address;
  await rememberAddress(address);

  setLoading(true);
  setStatus('');

  try {
    if (forceRefresh) {
      state.yp = '';
    }
    state.mails = await fetchInbox(address);
    state.selectedId = null;
    renderInbox();
    if (state.mails.length > 0) {
      setStatus(`Last updated: ${new Date().toLocaleTimeString()}`);
    } else {
      setStatus('No mail.');
    }
  } catch (err) {
    setStatus(err.message, 'error');
    state.mails = [];
    state.selectedId = null;
    renderInbox();
  } finally {
    setLoading(false);
  }
}

function renderAddressList() {
  els.list.innerHTML = '';
  if (addresses.length === 0) {
    els.list.innerHTML = '<li class="combo-empty">No saved addresses</li>';
    return;
  }
  for (const addr of addresses) {
    const li = document.createElement('li');
    li.className = 'combo-item';
    li.setAttribute('role', 'option');
    li.dataset.address = addr;
    li.innerHTML = `
      <span class="combo-label">${escapeHtml(addr)}</span>
      <button class="combo-remove" type="button" aria-label="Remove ${escapeHtml(addr)}" title="Remove">✕</button>
    `;
    els.list.appendChild(li);
  }
}

function openList() {
  renderAddressList();
  els.list.hidden = false;
  els.toggle.setAttribute('aria-expanded', 'true');
}

function closeList() {
  els.list.hidden = true;
  els.toggle.setAttribute('aria-expanded', 'false');
}

function toggleList() {
  if (els.list.hidden) {
    openList();
  } else {
    closeList();
  }
}

els.goBtn.addEventListener('click', () => go(false));
els.refreshBtn.addEventListener('click', () => go(true));
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    go(false);
  } else if (e.key === 'Escape') {
    closeList();
  }
});

els.input.addEventListener('focus', openList);
els.input.addEventListener('click', openList);

// Keep focus on the input when the toggle button is pressed with a pointing device.
els.combo.addEventListener('mousedown', (e) => {
  if (e.target.closest('.combo-toggle')) {
    e.preventDefault();
  }
});

// Drive open/close and item selection from click so keyboard activation
// (Enter/Space on the focused toggle) and programmatic element.click() work.
els.combo.addEventListener('click', (e) => {
  const toggle = e.target.closest('.combo-toggle');
  if (toggle) {
    toggleList();
    return;
  }
  const item = e.target.closest('.combo-item');
  if (!item) return;
  const address = item.dataset.address;
  if (e.target.closest('.combo-remove')) {
    removeAddress(address);
  } else {
    closeList();
    els.input.value = address;
    go(false);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!els.combo.contains(e.target)) {
    closeList();
  }
});

async function init() {
  await loadAddresses();

  const queryAddress = getQueryAddress();
  if (queryAddress) {
    const address = cleanAddress(queryAddress);
    if (isValidAddress(address)) {
      els.input.value = address;
      go(false);
      return;
    }
  }

  await loadAddress();
  if (els.input.value) {
    go(false);
  }
}

init();
