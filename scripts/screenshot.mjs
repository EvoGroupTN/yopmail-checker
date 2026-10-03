// Load the unpacked extension in headless Chromium, open the popup for
// testmail123@yopmail.com, and take screenshots of a newsletter (pictures off/on),
// a text mail, and a human-verification wall mail.

import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(__dirname, '..');

const ADDRESS = 'testmail123';
const USER_DATA_DIR = fs.mkdtempSync('/tmp/yopmail-screenshot-');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForItems(page) {
  await page.waitForFunction(
    () => document.querySelectorAll('#inboxList .mail-item').length > 0,
    { timeout: 20000 }
  );
  await sleep(500);
}

async function screenshot(page, name) {
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log('saved', file);
  return file;
}

async function findItemByText(page, text) {
  return page.evaluate((t) => {
    const items = Array.from(document.querySelectorAll('#inboxList .mail-item'));
    const el = items.find((item) => item.textContent.toLowerCase().includes(t.toLowerCase()));
    return el ? items.indexOf(el) : -1;
  }, text);
}

async function waitForIframeContent(page) {
  await page.waitForFunction(
    () => {
      const iframe = document.querySelector('#mailContent .mail-iframe');
      if (!iframe) return false;
      try {
        const doc = iframe.contentDocument;
        return doc && doc.body && doc.body.innerHTML.length > 0;
      } catch {
        return false;
      }
    },
    { timeout: 15000 }
  );
  // Allow images / resize observers to settle.
  await sleep(1500);
}

async function main() {
  console.log('Launching Chromium with extension');

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

    // Wait for the extension service worker to load and derive its ID.
    let swTarget;
    for (let i = 0; i < 50; i++) {
      swTarget = browser.targets().find((t) => t.type() === 'service_worker');
      if (swTarget) break;
      await sleep(200);
    }
    if (!swTarget) {
      throw new Error('Extension service worker not found');
    }
    const swUrl = swTarget.url();
    const extId = new URL(swUrl).hostname;
    console.log('Extension ID:', extId);

    const popupUrl = `chrome-extension://${extId}/popup.html?address=${encodeURIComponent(ADDRESS)}`;
    const page = await browser.newPage();
    await page.setViewport({ width: 760, height: 520 });
    await page.goto(popupUrl, { waitUntil: 'networkidle2' });

    await waitForItems(page);
    await screenshot(page, 'screenshot-inbox.png');

    // 1. HTML newsletter with pictures off (ChatGPT / Wrangler / Instagram / Fetch).
    let idx = await findItemByText(page, 'chatgpt');
    if (idx < 0) idx = await findItemByText(page, 'wrangler');
    if (idx < 0) idx = await findItemByText(page, 'instagram');
    if (idx < 0) idx = await findItemByText(page, 'fetch');
    if (idx < 0) idx = 1;

    const items = await page.$$('#inboxList .mail-item');
    await items[idx].click();
    await waitForIframeContent(page);
    await screenshot(page, 'screenshot-newsletter-off.png');

    // 2. Same newsletter with pictures on.
    await page.click('#showPictures');
    await waitForIframeContent(page);
    await screenshot(page, 'screenshot-newsletter-on.png');

    // 3. Text mail (Fetch Pet Insurance has no images and a short fragment).
    let textIdx = await findItemByText(page, 'fetch');
    if (textIdx < 0) textIdx = await findItemByText(page, 'insurance');
    if (textIdx < 0) {
      textIdx = items.length - 1;
    }

    const items2 = await page.$$('#inboxList .mail-item');
    await items2[textIdx].click();
    await waitForIframeContent(page);
    await screenshot(page, 'screenshot-text.png');

    // 4. Human-verification wall mail (Meta Account Security).
    let wallIdx = await findItemByText(page, 'meta account security');
    if (wallIdx < 0) wallIdx = 0;

    const items3 = await page.$$('#inboxList .mail-item');
    await items3[wallIdx].click();
    await page.waitForSelector('.human-check', { timeout: 15000 });
    await sleep(500);
    await screenshot(page, 'screenshot-wall.png');

    console.log('Done.');
  } finally {
    if (browser) {
      await browser.close();
    }
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
