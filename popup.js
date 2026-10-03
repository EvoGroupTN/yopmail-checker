const STORAGE_KEY = 'yopmail_address';
const STORAGE_ADDRESSES_KEY = 'yopmail_addresses';
const WALL_KEY = 'yopmail_wall_detected';
const MAX_ADDRESSES = 25;

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

async function loadInbox(address) {
  const addr = cleanAddress(address);
  if (!isValidAddress(addr)) return;
  currentAddress = addr;
  els.input.value = addr;
  rememberAddress(addr);
  hideHint();
  await clearWallFlag();
  els.frame.src = getInboxUrl(addr);
}

async function refreshInbox() {
  if (!currentAddress) {
    const addr = cleanAddress(els.input.value);
    if (!isValidAddress(addr)) return;
    currentAddress = addr;
  }
  hideHint();
  await clearWallFlag();
  // Reassigning src forces a reload on a cross-origin frame.
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
  if (message && message.type === 'yopmail-wall') {
    showWallHint();
  }
});

// Reset the hint when the frame starts loading a new mailbox, then check whether
// the embedded content script flagged a human-check wall.
els.frame.addEventListener('load', async () => {
  hideHint();
  await sleep(500);
  if (await readWallFlag()) {
    showWallHint();
  }
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
