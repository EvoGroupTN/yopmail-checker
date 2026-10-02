// Node test of the verified YOPmail HTTP pipeline.
// Performs steps 1-4 against hermes.test.e091mc@yopmail.com and prints the
// parsed last-3 inbox + first 200 chars of the newest message body.

const ADDRESS = 'hermes.test.e091mc';
const VERSION_DEFAULT = '9.4';

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

function parseInbox(html) {
  const mails = [];
  const messageRe = /<div[^>]*\bclass="m"[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*\bclass="(?:m|mday|adbar)"|<\/div>\s*$|$)/g;
  let m;
  while ((m = messageRe.exec(html)) !== null && mails.length < 3) {
    const id = m[1];
    const block = m[2];
    const time = (block.match(/<span class="lmh">([^<]*)<\/span>/) || ['', ''])[1];
    const sender = (block.match(/<span class="lmf">([^<]*)<\/span>/) || ['', ''])[1];
    const subject = (block.match(/<div class="lms">([^<]*)<\/div>/) || ['', ''])[1];
    mails.push({ id, time, sender, subject });
  }
  return mails;
}

async function main() {
  console.log('--- YOPmail fetch test ---');
  console.log(`Address: ${ADDRESS}@yopmail.com\n`);

  // Step 1a: GET bootstrap page (sets yc/yses cookies and gives initial yp).
  const bootstrapUrl = `https://yopmail.com/en/?login=${encodeURIComponent(ADDRESS)}`;
  const bootstrap = await yopFetch(bootstrapUrl);
  if (!bootstrap.ok) throw new Error(`Bootstrap failed: HTTP ${bootstrap.status}`);
  const yp1 = extractYP(bootstrap.text);
  const version = extractVersion(bootstrap.text);
  console.log(`Step 1a OK - version=${version}, yp=${yp1.slice(0, 8)}...`);

  // Step 1b: auto-submit the session form (sets compte/ywm cookies and returns wm page).
  const formRes = await yopFetch('https://yopmail.com/en/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `yp=${encodeURIComponent(yp1)}&login=${encodeURIComponent(ADDRESS)}&id=`,
  });
  if (!formRes.ok) throw new Error(`Session form submit failed: HTTP ${formRes.status}`);
  const yp2 = extractYP(formRes.text);
  console.log(`Step 1b OK - session yp=${yp2.slice(0, 8)}...`);

  // Step 2: fetch anti-bot token yj from the served webmail.js.
  const jsUrl = `https://yopmail.com/ver/${version}/webmail.js`;
  const jsRes = await yopFetch(jsUrl);
  if (!jsRes.ok) throw new Error(`webmail.js failed: HTTP ${jsRes.status}`);
  const yj = extractYJ(jsRes.text);
  console.log(`Step 2 OK - yj=${yj.slice(0, 8)}...`);

  // Step 3: inbox list (ytime cookie is required by the server).
  cookieJar.setYTime();
  const inboxParams = new URLSearchParams({
    login: ADDRESS,
    p: '1',
    d: '',
    ctrl: '',
    yp: yp2,
    yj,
    v: version,
    r_c: '',
    id: '',
    ad: '0',
  });
  const inboxUrl = `https://yopmail.com/en/inbox?${inboxParams.toString()}`;
  let inbox = await yopFetch(inboxUrl);

  if (!inbox.ok || inbox.status === 400) {
    console.log('Inbox 400, refreshing session and retrying...');
    const fresh = await yopFetch(bootstrapUrl);
    const freshYP1 = extractYP(fresh.text);
    const freshVer = extractVersion(fresh.text);
    const freshForm = await yopFetch('https://yopmail.com/en/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `yp=${encodeURIComponent(freshYP1)}&login=${encodeURIComponent(ADDRESS)}&id=`,
    });
    const freshYP2 = extractYP(freshForm.text);
    const freshJS = await yopFetch(`https://yopmail.com/ver/${freshVer}/webmail.js`);
    const freshYJ = extractYJ(freshJS.text);
    cookieJar.setYTime();
    inboxParams.set('yp', freshYP2);
    inboxParams.set('yj', freshYJ);
    inboxParams.set('v', freshVer);
    inbox = await yopFetch(`https://yopmail.com/en/inbox?${inboxParams.toString()}`);
  }

  if (!inbox.ok) throw new Error(`Inbox failed: HTTP ${inbox.status}`);
  const mails = parseInbox(inbox.text);
  console.log(`\nStep 3 OK - found ${mails.length} mail(s) on page 1`);

  console.log('\n--- Last 3 emails ---');
  for (const mail of mails) {
    console.log(`[${mail.time}] ${mail.sender} | ${mail.subject}`);
  }

  if (mails.length === 0) {
    console.log('\nNo messages to display.');
    return;
  }

  // Step 4: first mail body
  const first = mails[0];
  cookieJar.setYTime();
  const bodyUrl = `https://yopmail.com/en/mail?b=${encodeURIComponent(ADDRESS)}&id=m${encodeURIComponent(first.id)}`;
  const bodyRes = await yopFetch(bodyUrl);
  if (!bodyRes.ok) throw new Error(`Mail body failed: HTTP ${bodyRes.status}`);

  function extractMailText(html) {
    // YOPmail wraps the actual message in <div id="mail">; ignore viewer chrome.
    const mailMatch = html.match(/<div id="mail"[^>]*>([\s\S]*?)<\/div>/i);
    const raw = mailMatch ? mailMatch[1] : (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || ['', html])[1];
    return decodeHtmlEntities(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }

  function decodeHtmlEntities(str) {
    return str
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  }

  const cleanText = extractMailText(bodyRes.text);
  console.log(`\nStep 4 OK - body preview (${first.id}):`);
  console.log(cleanText);
}

main().catch((err) => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
