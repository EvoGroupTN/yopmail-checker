const STORAGE_KEY = 'yopmail_address';
const STORAGE_ADDRESSES_KEY = 'yopmail_addresses';
const WALL_KEY = 'yopmail_wall_detected';
const MAX_ADDRESSES = 25;
const EMPTY_RETRY_MAX = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const els = {
  input: document.getElementById('addressInput'),
  goBtn: document.getElementById('goBtn'),
  refreshBtn: document.getElementById('refreshBtn'),
  openTabBtn: document.getElementById('openTabBtn'),
  combo: document.getElementById('addressCombo'),
  toggle: document.getElementById('addressToggle'),
  list: document.getElementById('addressList'),
  frame: document.getElementById('webmailFrame'),
  hint: document.getElementById('hint'),
  hintText: document.getElementById('hintText'),
  hintOpenTab: document.getElementById('hintOpenTab'),
};

let addresses = [];
let currentAddress = '';
let emptyAttempts = 0;
let emptyNoticeShown = false;
// HTTP status of the most recent priming fetch (0 = network error / unknown).
// Used to distinguish a rate-limited IP (429) from an empty mailbox.
let lastPrimeStatus = 0;

function cleanAddress(raw) {
  let addr = (raw || '').trim().toLowerCase();
  // Accept both login and login@yopmail.com (or any domain).
  if (addr.includes('@')) {
    addr = addr.split('@')[0];
  }
  return addr.replace(/[^a-z0-9._-]/g, '');
}

function isValidAddress(addr) {
  return addr.length >= 1 && addr.length <= 100;
}

function getInboxUrl(address) {
  return `https://yopmail.com/?${encodeURIComponent(address)}`;
}

function setHint(text, show) {
  if (show) {
    els.hintText.textContent = text;
    els.hint.hidden = false;
  } else {
    els.hint.hidden = true;
  }
}

function showWallHint() {
  setHint('YOPmail is asking for a human check. Use Open in tab to continue.', true);
}

function hideHint() {
  setHint('', false);
}

function showEmptyNotice() {
  emptyNoticeShown = true;
  setHint('Mailbox looks empty — press Refresh, or use Open in tab.', true);
}

function showRateLimitHint() {
  setHint('YOPmail is rate-limiting requests — wait a minute and press Refresh.', true);
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
    currentAddress = '';
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

function openInTab(address) {
  const addr = address || cleanAddress(els.input.value);
  if (!isValidAddress(addr)) return;
  chrome.tabs.create({ url: getInboxUrl(addr) });
}

async function clearWallFlag() {
  try {
    await chrome.storage.local.remove(WALL_KEY);
  } catch (err) {
    // Ignore.
  }
}

async function readWallFlag() {
  try {
    const stored = await chrome.storage.local.get(WALL_KEY);
    return !!stored[WALL_KEY];
  } catch (err) {
    return false;
  }
}

async function primeSession(address) {
  const login = cleanAddress(address);
  if (!login) return;

  const url = `https://yopmail.com/en/?login=${encodeURIComponent(login)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    lastPrimeStatus = res.status;
  } catch (err) {
    // Network or timeout errors are fine; the cookie write below is the
    // critical part for making the embedded frame see a valid session.
    lastPrimeStatus = 0;
  } finally {
    clearTimeout(timeoutId);
  }

  try {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const value = `${hh}:${mm}`;

    if (!chrome.cookies || !chrome.cookies.set) {
      console.warn('[YOPmail Checker] chrome.cookies API is unavailable');
      return;
    }

    await chrome.cookies.set({
      url: 'https://yopmail.com/',
      name: 'ytime',
      value,
      path: '/',
      secure: true,
      sameSite: 'no_restriction',
    });
  } catch (err) {
    console.warn('[YOPmail Checker] failed to set ytime cookie:', err);
  }
}

async function loadInbox(address) {
  const addr = cleanAddress(address);
  if (!isValidAddress(addr)) return;
  currentAddress = addr;
  emptyAttempts = 0;
  emptyNoticeShown = false;
  els.input.value = addr;
  rememberAddress(addr);
  hideHint();
  await clearWallFlag();
  await primeSession(addr);
  if (lastPrimeStatus === 429) showRateLimitHint();
  els.frame.src = getInboxUrl(addr);
}

async function refreshInbox() {
  if (!currentAddress) {
    const addr = cleanAddress(els.input.value);
    if (!isValidAddress(addr)) return;
    currentAddress = addr;
  }
  emptyAttempts = 0;
  emptyNoticeShown = false;
  hideHint();
  await clearWallFlag();
  await primeSession(currentAddress);
  if (lastPrimeStatus === 429) showRateLimitHint();
  // Reassigning src forces a reload on a cross-origin frame.
  els.frame.src = getInboxUrl(currentAddress);
}

async function selfHealInbox() {
  if (!currentAddress) return;
  // A rate-limited IP is not an empty mailbox: never retry into a 429.
  if (lastPrimeStatus === 429) {
    showRateLimitHint();
    return;
  }
  if (emptyAttempts >= EMPTY_RETRY_MAX) {
    showEmptyNotice();
    return;
  }
  emptyAttempts += 1;
  await primeSession(currentAddress);
  if (lastPrimeStatus === 429) {
    showRateLimitHint();
    return;
  }
  els.frame.src = getInboxUrl(currentAddress);
}

function go() {
  const addr = cleanAddress(els.input.value);
  if (!isValidAddress(addr)) {
    setHint('Please enter a valid YOPmail address.', true);
    return;
  }
  loadInbox(addr);
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

els.goBtn.addEventListener('click', go);
els.refreshBtn.addEventListener('click', refreshInbox);
els.openTabBtn.addEventListener('click', () => openInTab());
els.hintOpenTab.addEventListener('click', () => openInTab());

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    go();
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
    loadInbox(address);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!els.combo.contains(e.target)) {
    closeList();
  }
});

// Listen for wall-detection messages from the embedded YOPmail frame.
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://yopmail.com' && event.origin !== 'https://www.yopmail.com') return;
  if (event.data && event.data.type === 'yopmail-wall') {
    showWallHint();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'yopmail-wall') {
    showWallHint();
  } else if (message.type === 'yopmail-empty') {
    selfHealInbox();
  }
});

// After the frame loads, decide which notice (if any) applies: a rate-limit
// notice wins, then a real human-check wall, then a self-healed empty mailbox.
els.frame.addEventListener('load', async () => {
  await sleep(600);
  if (lastPrimeStatus === 429) {
    showRateLimitHint();
    return;
  }
  if (await readWallFlag()) {
    showWallHint();
    return;
  }
  if (emptyNoticeShown) {
    showEmptyNotice();
    return;
  }
  hideHint();
});

async function init() {
  await loadAddresses();

  const queryAddress = getQueryAddress();
  if (queryAddress) {
    const address = cleanAddress(queryAddress);
    if (isValidAddress(address)) {
      els.input.value = address;
      loadInbox(address);
      return;
    }
  }

  await loadAddress();
  if (els.input.value) {
    loadInbox(els.input.value);
  }
}

init();
