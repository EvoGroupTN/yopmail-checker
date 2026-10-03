# YOPmail Checker

A minimal Manifest V3 Chrome extension that embeds the YOPmail webmail UI under an
address bar inside the popup.

## Install

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select this folder (the one containing `manifest.json`).
5. The YOPmail Checker icon should appear in your toolbar.

## Use

1. Click the extension icon.
2. Enter a YOPmail address (e.g. `hermes.test.e091mc` or `hermes.test.e091mc@yopmail.com`).
3. Click **Go** to load the inbox inside the popup.
4. Click **Refresh** to reload the embedded page.
5. Click **Open in tab** to open the same inbox in a real Chrome tab.

### Saved addresses

- The last used address is stored under `yopmail_address` and restored when the popup opens.
- Every address you check is added to `yopmail_addresses` (newest first, capped at 25).
- Click the **▾** toggle to open the saved-addresses dropdown.
- Pick a row to load that inbox immediately.
- Click the **✕** on a row to remove that address from history.
- If you upgraded from an older version that only saved a single address, the first launch migrates that value into the new history list automatically.

### Human-check wall

YOPmail occasionally asks for a human verification before showing the inbox list.
Because third-party cookies are blocked inside the popup, the embedded page may hit
this wall more often than a normal tab. When the extension detects the wall state it:

- displays a hint bar with an **Open in tab** button in the popup, and
- calls the page's own challenge handler so the challenge is visible inside the frame.

Always use **Open in tab** if the embedded view does not load correctly.

## Files

- `manifest.json` — MV3 manifest.
- `rules.json` — Declarative Net Request rules that remove framing/CSP headers from YOPmail responses.
- `popup.html`, `popup.css`, `popup.js` — popup UI and logic.
- `background.js` — minimal service worker.
- `content-script.js` — MAIN-world script that surfaces the human-check wall inside embedded frames.
- `icon16.png`, `icon48.png`, `icon128.png` — extension icons.
- `notes/` — coordination briefs (not shipped in the zip).

## Testing / dev

The popup supports a `?address=` query parameter for headless testing and automation:

```bash
chromium --headless=new --load-extension=/path/to/yopmail-chrome-ext \
  --user-data-dir=/tmp/yp-profile --dump-dom \
  "chrome-extension://<extension-id>/popup.html?address=hermes.test.e091mc@yopmail.com"
```

When `?address=` is present, the popup prefills and saves that address and immediately loads the inbox without requiring a click.

## Zip

`yopmail-checker.zip` is a packaged copy of the extension for easy sharing. It excludes `notes/`,
`node_modules/`, the screenshots, and the zip itself.
