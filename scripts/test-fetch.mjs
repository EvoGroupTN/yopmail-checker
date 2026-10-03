// Node test of the verified YOPmail HTTP pipeline.
// Performs steps 1-4 against testmail123@yopmail.com and prints a mode matrix
// for the first messages: m/i length, image counts, human-wall detection, and
// extracted fragment length. Stale-session stubs are detected and labelled STUB.

const ADDRESS = 'testmail123';
const VERSION_DEFAULT = '9.4';
const MAX_MESSAGES = 5;
const BASE_URL = process.env.YOPMAIL_BASE_URL || 'https://yopmail.com';

// Minimal cookie jar using fetch's cookie header handling.
const cookieJar = {
  cookies: new Map(),
  set(setCookieHeader) {
    if (!setCookieHeader) return;
    const parts = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const raw of parts) {
      const [nameValue] = raw.split(';');
      const [name, value] = nameValue.trim().split('=');
      if (name && value !== undefined) {
        const n = name.trim();
        const v = value.trim();
        if (v.toLowerCase() === 'deleted') {
          this.cookies.delete(n);
        } else {
          this.cookies.set(n, v);
        }
      }
    }
  },
  get() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  },
  setYTime() {
    const d = new Date();
    this.cookies.set('ytime', `${d.getHours()}:${d.getMinutes()}`);
  },
};

async function yopFetch(url, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  const cookie = cookieJar.get();
  if (cookie) headers.set('Cookie', cookie);

  const res = await fetch(url, { ...opts, headers, redirect: 'follow' });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : res.headers.get('set-cookie');
  cookieJar.set(setCookie);

  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

function extractYP(html) {
  const m = html.match(/id="yp"[^>]*value="([^"]+)"/);
  if (!m) throw new Error('yp token not found');
  return m[1];
}

function extractVersion(html) {
  const m = html.match(/\/ver\/([0-9.]+)\/webmail\.js/);
  return m ? m[1] : VERSION_DEFAULT;
}

function extractYJ(js) {
  const m = js.match(/yj=([A-Za-z0-9]+)/);
  if (!m) throw new Error('yj token not found');
  return m[1];
}

async function bootstrap() {
  // Step 1a: GET bootstrap page (sets yc/yses cookies and gives initial yp).
  const r1 = await yopFetch(`${BASE_URL}/en/?login=${encodeURIComponent(ADDRESS)}`);
  if (!r1.ok) throw new Error(`Bootstrap failed: HTTP ${r1.status}`);
  const yp1 = extractYP(r1.text);
  const version = extractVersion(r1.text);

  // Step 1b: auto-submit the session form (sets compte/ywm cookies and returns wm page).
  const r2 = await yopFetch(`${BASE_URL}/en/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `yp=${encodeURIComponent(yp1)}&login=${encodeURIComponent(ADDRESS)}&id=`,
  });
  if (!r2.ok) throw new Error(`Session form submit failed: HTTP ${r2.status}`);
  const yp2 = extractYP(r2.text);

  // Step 2: fetch anti-bot token yj from the served webmail.js.
  const r3 = await yopFetch(`${BASE_URL}/ver/${version}/webmail.js`);
  if (!r3.ok) throw new Error(`webmail.js failed: HTTP ${r3.status}`);
  const yj = extractYJ(r3.text);

  return { yp: yp2, yj, version };
}

function parseInbox(html, max = 3) {
  const mails = [];
  const messageRe = /<div[^>]*\bclass="m"[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*\bclass="(?:m|mday|adbar)"|<\/div>\s*$|$)/g;
  let m;
  while ((m = messageRe.exec(html)) !== null && mails.length < max) {
    const id = m[1];
    const block = m[2];
    const time = (block.match(/<span class="lmh">([^<]*)<\/span>/) || ['', ''])[1];
    const sender = (block.match(/<span class="lmf">([^<]*)<\/span>/) || ['', ''])[1];
    const subject = (block.match(/<div class="lms">([^<]*)<\/div>/) || ['', ''])[1];
    mails.push({ id, time, sender, subject });
  }
  return mails;
}

function detectWall(html) {
  const hasMailctn = /<[^>]*\bid=["']?mailctn["']?[^>]*>/i.test(html);
  return !hasMailctn && /confirm you're human/i.test(html);
}

function isRetStub(html) {
  return /\.ret\s*\{/i.test(html);
}

function classifyMailBody(html) {
  const hasMailctn = /<[^>]*\bid=["']?mailctn["']?[^>]*>/i.test(html);
  const hasMail = /<[^>]*\bid=["']?mail["']?[^>]*>/i.test(html);
  if (hasMailctn || hasMail) return 'valid';
  if (detectWall(html)) return 'wall';
  if (isRetStub(html) || html.length < 1024) return 'stub';
  return 'stub';
}

function classifyInbox(html) {
  if (detectWall(html)) return 'wall';
  const hasMessage = /<div[^>]*\bclass=["'][^"']*\bm\b/i.test(html);
  const hasDay = /<div[^>]*\bclass=["']?mday["']?/i.test(html);
  if (hasMessage || hasDay) return 'valid';
  // A genuine empty inbox still has the inbox chrome; the stale-session stub is the .ret page.
  if (isRetStub(html)) return 'stub';
  return 'valid';
}

function extractFragment(html) {
  if (detectWall(html)) {
    return { wall: true, fragment: '' };
  }

  let fragment = '';
  const mailctnMatch = html.match(/<div\b[^>]*\bid=["']?mailctn["']?[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/body>|<\/html>|$)/i);
  if (mailctnMatch) {
    fragment = mailctnMatch[1];
  } else {
    const mailMatch = html.match(/<div\b[^>]*\bid=["']?mail["']?[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/body>|<\/html>|$)/i);
    if (mailMatch) {
      fragment = mailMatch[1];
    } else {
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      fragment = bodyMatch ? bodyMatch[1] : html;
    }
  }

  // Strip scripts, styles, meta, links, iframes and display:none elements.
  fragment = fragment
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/<[^>]+\bstyle=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');

  return { wall: false, fragment };
}

function countImages(fragment) {
  const imgCount = (fragment.match(/<img\b/gi) || []).length;
  const withSrc = (fragment.match(/<img\b[^>]*\bsrc=/gi) || []).length;
  return { imgCount, withSrc };
}

async function fetchInboxWithRetry() {
  let { yp, yj, version } = await bootstrap();
  cookieJar.setYTime();

  const params = new URLSearchParams({
    login: ADDRESS,
    p: '1',
    d: '',
    ctrl: '',
    yp,
    yj,
    v: version,
    r_c: '',
    id: '',
    ad: '0',
  });
  let inbox = await yopFetch(`${BASE_URL}/en/inbox?${params.toString()}`);
  let kind = classifyInbox(inbox.text);

  if (!inbox.ok || inbox.status === 400 || kind === 'stub' || kind === 'wall') {
    console.log('Inbox response classified as', kind, '- refreshing session and retrying...');
    ({ yp, yj, version } = await bootstrap());
    cookieJar.setYTime();
    params.set('yp', yp);
    params.set('yj', yj);
    params.set('v', version);
    inbox = await yopFetch(`${BASE_URL}/en/inbox?${params.toString()}`);
    kind = classifyInbox(inbox.text);
  }

  if (!inbox.ok) throw new Error(`Inbox failed: HTTP ${inbox.status}`);
  if (kind === 'wall') throw new Error('Inbox requires human verification.');
  if (kind === 'stub') throw new Error('Inbox returned a stub after retry.');

  return { mails: parseInbox(inbox.text, MAX_MESSAGES), yp, yj, version };
}

async function fetchMailBodyWithRetry(mail, mode) {
  const buildUrl = () => `${BASE_URL}/en/mail?b=${encodeURIComponent(ADDRESS)}&id=${mode}${encodeURIComponent(mail.id)}`;

  let body = await yopFetch(buildUrl());
  let kind = classifyMailBody(body.text);

  if (kind === 'stub') {
    console.log(`  ${mail.id} ${mode}: stub detected, refreshing session and retrying...`);
    await bootstrap();
    cookieJar.setYTime();
    body = await yopFetch(buildUrl());
    kind = classifyMailBody(body.text);
  }

  if (!body.ok) {
    return { status: 'failed', statusCode: body.status };
  }
  if (kind === 'stub') {
    return { status: 'stub', length: body.text.length };
  }

  const { wall, fragment } = extractFragment(body.text);
  const { imgCount, withSrc } = countImages(fragment);
  return {
    status: wall ? 'wall' : 'ok',
    length: body.text.length,
    imgCount,
    withSrc,
    fragmentLength: fragment.length,
  };
}

async function main() {
  console.log('--- YOPmail fetch test ---');
  console.log(`Address: ${ADDRESS}@yopmail.com\n`);

  const { mails } = await fetchInboxWithRetry();
  console.log(`Step 3 OK - found ${mails.length} mail(s) on page 1`);

  console.log('\n--- Inbox (first 5) ---');
  for (const mail of mails) {
    console.log(`[${mail.time}] ${mail.sender} | ${mail.subject}`);
  }

  if (mails.length === 0) {
    console.log('\nNo messages to display.');
    return;
  }

  console.log('\n--- Mode matrix per message ---');
  console.log('id                | mode | length | imgs | src | wall | fragment');

  for (const mail of mails) {
    for (const mode of ['m', 'i']) {
      const result = await fetchMailBodyWithRetry(mail, mode);
      if (result.status === 'failed') {
        console.log(`${mail.id.padEnd(17)} | ${mode}    | FAILED HTTP ${result.statusCode}`);
      } else if (result.status === 'stub') {
        console.log(`${mail.id.padEnd(17)} | ${mode}    | ${String(result.length).padStart(6)} |    - |   - |  -  | STUB`);
      } else if (result.status === 'wall') {
        console.log(`${mail.id.padEnd(17)} | ${mode}    | ${String(result.length).padStart(6)} |    0 |   0 | YES | 0`);
      } else {
        console.log(
          `${mail.id.padEnd(17)} | ${mode}    | ${String(result.length).padStart(6)} | ${String(result.imgCount).padStart(4)} | ${String(result.withSrc).padStart(3)} | no  | ${result.fragmentLength}`
        );
      }
    }
  }
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
