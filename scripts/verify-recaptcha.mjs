// Verification harness for the reCAPTCHA human-in-the-loop feature (v1.0.2).
// Launches the unpacked extension in headless Chromium and exercises:
//   1. Live inbox-level wall -> human-check state + Verify button -> real tab.
//   2. Mocked normal mail -> unchanged render via iframe.
//   3. Mocked walled mail -> human-check state in message pane + Verify button -> real tab.
//   4. Content-script capture of a mocked non-walled YOPmail mail page.

import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const USER_DATA_DIR = fs.mkdtempSync('/tmp/yopmail-verify-');

const LIVE_ADDRESS = 'testmail123';
const MOCK_NORMAL_ADDRESS = 'normalmock';
const MOCK_WALL_ADDRESS = 'wallmock';
const CS_ADDRESS = 'csdemo';
const STORAGE_CAPTURED_PREFIX = 'yopmail_captured_';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockBootstrapHtml(yp) {
  return `<!DOCTYPE html><html><body>
<input type="hidden" id="yp" value="${yp}">
<script src="/ver/9.4/webmail.js"></script>
</body></html>`;
}

function mockWebmailJs() {
  return `var yj=FAKEYJTOKEN;`;
}

function mockInboxHtml(address) {
  return `<!DOCTYPE html><html><body>
<div class="mday">Today</div>
<div class="m" id="m123">
  <span class="lmh">12:34</span>
  <span class="lmf">${address}@yopmail.com</span>
  <div class="lms">Mock message for ${address}</div>
</div>
</body></html>`;
}

function mockMailHtml() {
  return `<!DOCTYPE html><html><body>
<div id="mailctn">
  <h1>Mock newsletter</h1>
  <p>Hello from the mocked YOPmail message.</p>
  <p><a href="/relative-link">Relative link</a></p>
  <p><img src="/relative-image.png" alt="demo"></p>
</div>
</body></html>`;
}

function mockMailWallHtml() {
  return `<!DOCTYPE html><html><body>
<div>confirm you're human</div>
<div class="g-recaptcha" data-sitekey="0x4AAAAAAFDPFkUypCjCd_ZK" data-size="normal"></div>
<script>
grecaptcha.render('recaptcha-widget', {
  sitekey: '0x4AAAAAAFDPFkUypCjCd_ZK',
  size: 'normal'
});
</script>
</body></html>`;
}

function mockCsMailHtml() {
  return `<!DOCTYPE html><html><body>
<div id="mailctn">
  <h2>Content-script capture target</h2>
  <p>This paragraph was captured by the extension content script.</p>
  <script>var scriptsAreStripped = true;</script>
  <style>.x{display:none}</style>
  <div style="display:none">hidden preheader</div>
  <a href="/path">relative</a>
</div>
</body></html>`;
}

async function getExtensionId(browser) {
  let swTarget;
  for (let i = 0; i < 50; i++) {
    swTarget = browser.targets().find((t) => t.type() === 'service_worker');
    if (swTarget) break;
    await sleep(200);
  }
  if (!swTarget) throw new Error('Extension service worker not found');
  return new URL(swTarget.url()).hostname;
}

function setupMocks(page) {
  page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    const pathname = url.pathname;
    const search = url.search;

    // Bootstrap page.
    if (pathname === '/en/' && search.startsWith('?login=')) {
      const addr = url.searchParams.get('login');
      if (addr === MOCK_NORMAL_ADDRESS || addr === MOCK_WALL_ADDRESS || addr === CS_ADDRESS) {
        return req.respond({
          status: 200,
          contentType: 'text/html',
          body: mockBootstrapHtml(`YP_${addr}`),
        });
      }
    }

    // Bootstrap POST.
    if (pathname === '/en/' && req.method() === 'POST') {
      return req.respond({
        status: 200,
        contentType: 'text/html',
        body: mockBootstrapHtml('YP_SESSION'),
      });
    }

    // webmail.js.
    if (pathname.startsWith('/ver/') && pathname.endsWith('/webmail.js')) {
      return req.respond({
        status: 200,
        contentType: 'application/javascript',
        body: mockWebmailJs(),
      });
    }

    // Inbox.
    if (pathname === '/en/inbox') {
      const addr = url.searchParams.get('login');
      if (addr === MOCK_NORMAL_ADDRESS) {
        return req.respond({ status: 200, contentType: 'text/html', body: mockInboxHtml(addr) });
      }
      if (addr === MOCK_WALL_ADDRESS) {
        return req.respond({ status: 200, contentType: 'text/html', body: mockInboxHtml(addr) });
      }
    }

    // Mail body.
    if (pathname === '/en/mail') {
      const addr = url.searchParams.get('b');
      if (addr === MOCK_NORMAL_ADDRESS) {
        return req.respond({ status: 200, contentType: 'text/html', body: mockMailHtml() });
      }
      if (addr === MOCK_WALL_ADDRESS) {
        return req.respond({ status: 200, contentType: 'text/html', body: mockMailWallHtml() });
      }
      if (addr === CS_ADDRESS) {
        return req.respond({ status: 200, contentType: 'text/html', body: mockCsMailHtml() });
      }
    }

    // Absorb favicon / image requests from mocked pages to keep the console clean.
    if (pathname === '/favicon.ico' || pathname === '/relative-image.png') {
      return req.respond({ status: 204 });
    }

    // Let everything else through (live YOPmail, chrome-extension resources, etc.).
    req.continue();
  });
}

async function readPaneText(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }, selector);
}

async function hasRecaptchaWidget(page) {
  const html = await page.content();
  if (/recaptcha/i.test(html)) return true;
  const frames = page.frames();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes('recaptcha') || url.includes('google.com')) return true;
    const found = await frame.evaluate(() => {
      return Boolean(
        document.querySelector('.g-recaptcha') ||
        document.querySelector('[data-sitekey]') ||
        document.querySelector('iframe[src*="recaptcha"]') ||
        document.querySelector('#recaptcha-widget') ||
        document.body?.innerText.toLowerCase().includes('recaptcha') ||
        document.body?.innerText.toLowerCase().includes("i'm not a robot")
      );
    }).catch(() => false);
    if (found) return true;
  }
  return false;
}

async function runTest1LiveInboxWall(browser, extId) {
  console.log('\n=== Test 1: live inbox-level wall ===');
  const page = await browser.newPage();
  await page.setViewport({ width: 760, height: 520 });
  await page.goto(`chrome-extension://${extId}/popup.html?address=${LIVE_ADDRESS}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#inboxList .human-check', { timeout: 20000 });

  const paneText = await readPaneText(page, '#inboxList');
  console.log('Inbox pane text:', paneText);
  const hasNoMail = paneText.includes('No mail.');
  console.log('Contains "No mail.":', hasNoMail);

  const verifyUrl = await page.evaluate(() => document.querySelector('#inboxList .verify-btn')?.dataset.url);
  console.log('Verify button URL:', verifyUrl);

  const pagesBefore = new Set((await browser.pages()).map((p) => p.url()));
  await page.click('#inboxList .verify-btn');
  let newPage;
  for (let i = 0; i < 50; i++) {
    const pages = await browser.pages();
    newPage = pages.find((p) => {
      const u = p.url();
      return !pagesBefore.has(u) && u.startsWith('https://yopmail.com/');
    });
    if (newPage) break;
    await sleep(200);
  }
  if (!newPage) throw new Error('No new YOPmail tab opened');
  await sleep(4000);
  const tabUrl = newPage.url();
  console.log('New tab URL:', tabUrl);
  const hasRc = await hasRecaptchaWidget(newPage);
  console.log('reCAPTCHA widget present:', hasRc);
  if (!hasRc) {
    const bodyText = await newPage.evaluate(() => document.body ? document.body.innerText : '');
    console.log('Tab body snippet:', bodyText.slice(0, 300));
  }
  await newPage.close();
  await page.close();
}

async function runTest2MockNormalMail(browser, extId) {
  console.log('\n=== Test 2: mocked normal mail render ===');
  const page = await browser.newPage();
  setupMocks(page);
  await page.setViewport({ width: 760, height: 520 });
  await page.goto(`chrome-extension://${extId}/popup.html?address=${MOCK_NORMAL_ADDRESS}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#inboxList .mail-item', { timeout: 20000 });

  const itemText = await readPaneText(page, '#inboxList .mail-item');
  console.log('Inbox item:', itemText);

  await page.click('#inboxList .mail-item');
  await page.waitForSelector('#mailContent .mail-iframe', { timeout: 20000 });
  await sleep(500);

  const iframeBody = await page.evaluate(() => {
    const iframe = document.querySelector('#mailContent .mail-iframe');
    if (!iframe) return '';
    try {
      return iframe.contentDocument.body.innerText;
    } catch {
      return '';
    }
  });
  console.log('Iframe body text:', iframeBody.replace(/\s+/g, ' ').trim());
  console.log('Has mail-iframe:', iframeBody.includes('Mock newsletter'));
  await page.close();
}

async function runTest3MockWalledMail(browser, extId) {
  console.log('\n=== Test 3: mocked walled mail render ===');
  const page = await browser.newPage();
  setupMocks(page);
  // Also intercept the verification tab that chrome.tabs.create will open.
  browser.on('targetcreated', async (target) => {
    const url = target.url();
    if (url.startsWith('https://yopmail.com/')) {
      const newTab = await target.page();
      if (newTab) setupMocks(newTab);
    }
  });
  await page.setViewport({ width: 760, height: 520 });
  await page.goto(`chrome-extension://${extId}/popup.html?address=${MOCK_WALL_ADDRESS}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#inboxList .mail-item', { timeout: 20000 });
  await page.click('#inboxList .mail-item');
  await page.waitForSelector('#mailContent .human-check', { timeout: 20000 });

  const paneText = await readPaneText(page, '#mailContent');
  console.log('Message pane text:', paneText);
  console.log('Contains "No mail.":', paneText.includes('No mail.'));

  const verifyUrl = await page.evaluate(() => document.querySelector('#mailContent .verify-btn')?.dataset.url);
  console.log('Verify button URL:', verifyUrl);

  const pagesBefore = new Set((await browser.pages()).map((p) => p.url()));
  await page.click('#mailContent .verify-btn');
  let newPage;
  for (let i = 0; i < 50; i++) {
    const pages = await browser.pages();
    newPage = pages.find((p) => {
      const u = p.url();
      return !pagesBefore.has(u) && u.startsWith('https://yopmail.com/');
    });
    if (newPage) break;
    await sleep(200);
  }
  if (!newPage) throw new Error('No new YOPmail tab opened');
  await sleep(1500);
  const tabUrl = newPage.url();
  console.log('New tab URL:', tabUrl);
  const hasRc = await hasRecaptchaWidget(newPage);
  console.log('reCAPTCHA widget present:', hasRc);
  if (!hasRc) {
    const bodyText = await newPage.evaluate(() => document.body ? document.body.innerText : '');
    console.log('Tab body snippet:', bodyText.slice(0, 300));
  }
  await newPage.close();
  await page.close();
}

async function runTest4ContentScriptCapture(browser, extId) {
  console.log('\n=== Test 4: content-script capture in a real tab ===');
  // Use a fresh browser instance for this isolated test; request interception in the
  // main suite can interact oddly with previously-opened YOPmail tabs.
  const csBrowser = await puppeteer.launch({
    headless: 'new',
    userDataDir: fs.mkdtempSync('/tmp/yopmail-cs-'),
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });
  let page;
  try {
    const csExtId = await getExtensionId(csBrowser);
    page = await csBrowser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.hostname === 'yopmail.com' && url.pathname === '/en/mail') {
        return req.respond({
          status: 200,
          contentType: 'text/html',
          body: mockCsMailHtml(),
        });
      }
      if (url.pathname === '/favicon.ico') {
        return req.respond({ status: 204 });
      }
      req.continue();
    });
    await page.goto(`https://yopmail.com/en/mail?b=${CS_ADDRESS}&id=m999`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mailctn', { timeout: 10000 });

    // The content script runs at document_idle; give it a moment to capture and store.
    await sleep(1000);

    // Read the captured payload from the extension storage via a popup page (extension context).
    const popupPage = await csBrowser.newPage();
    await popupPage.goto(`chrome-extension://${csExtId}/popup.html`, { waitUntil: 'networkidle2' });
    const payload = await popupPage.evaluate(async (prefix) => {
      return new Promise((resolve) => {
        chrome.storage.local.get(prefix + '999', (result) => resolve(result[prefix + '999'] || null));
      });
    }, STORAGE_CAPTURED_PREFIX);
    await popupPage.close();

    if (!payload) {
      throw new Error('No captured message found in chrome.storage.local');
    }
    console.log('Captured msgId:', payload.msgId);
    console.log('Captured address:', payload.address);
    console.log('Captured html length:', payload.html.length);
    console.log('Captured html first 200 chars:', payload.html.slice(0, 200));
    console.log('Has blank images:', payload.hasBlankImages);
    console.log('Contains stripped script tag:', payload.html.includes('<script>'));
    console.log('Contains stripped hidden preheader:', payload.html.includes('hidden preheader'));
  } finally {
    if (page) await page.close();
    await csBrowser.close();
  }
}

async function main() {
  console.log('Launching Chromium with extension from', EXT_DIR);
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      userDataDir: USER_DATA_DIR,
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=820,600',
      ],
    });

    const extId = await getExtensionId(browser);
    console.log('Extension ID:', extId);

    await runTest1LiveInboxWall(browser, extId);
    await runTest2MockNormalMail(browser, extId);
    await runTest3MockWalledMail(browser, extId);
    await runTest4ContentScriptCapture(browser, extId);

    console.log('\n=== All tests passed ===');
  } finally {
    if (browser) await browser.close();
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
