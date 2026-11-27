# Capture2u Chrome extension

Record your screen from any page and get a share link. For Locate2u staff.

Click the toolbar icon (or press the shortcut) on any page to record the screen, a window or a tab, with microphone and optional camera, without keeping a Capture2u tab open. While recording you can draw on the page, blur parts of it and have clicks highlighted. Stopping uploads the video to Capture2u and opens its share page.

## Where it comes from

This is a derived work of the Chrome extension in [Cap](https://github.com/CapSoftware/Cap), the open-source screen recorder this repository is forked from. The source it started as is in `apps/chrome-extension`, and it still uses Cap's recorder library from `packages/recorder-core` (resolved by alias, the same way the Capture2u site does). Both are AGPL-3.0, so this extension is AGPL-3.0 too: keep the source public.

What changed from Cap's extension:

- It talks to the Capture2u Worker (`https://capture.locate2u.com`) instead of Cap.
- Capture2u name, icon and Locate2u colours. No Cap fonts are shipped; the UI uses the system font stack.
- No plans, organisations, upgrade prompts, welcome page or store listing. Every signed-in user is unlimited.
- It records MP4 (H.264 + AAC) first and WebM only as a fallback, because Capture2u has no transcoder.
- It takes a thumbnail from the recorded picture and uploads it, because the Worker cannot make one.
- New: click highlights, and a keyboard shortcut that starts and stops a recording.
- The recorder panel stays out of the sign-in window.

## Build

Needs Node 22 and npm. It is not part of the monorepo workspaces: install here.

```bash
npm install
npm run typecheck
npm test
npm run build      # writes dist/
npm run package    # build, then write ../public/capture2u-extension.zip
```

`npm run icons` redraws `public/icons/` from `../public/favicon.svg` using an installed Chrome. The icons are committed, so a normal build does not need Chrome.

## Load it unpacked

1. Run `npm run build`, or unzip `capture2u-extension.zip`.
2. Open `chrome://extensions` and turn on Developer mode.
3. Choose Load unpacked and pick the `dist` folder (or the unzipped folder).
4. Pin Capture2u to the toolbar, click it and sign in with your work email.

The manifest carries a fixed `key`, so the extension id is the same on every computer. The Worker only hands sign-in keys to that id.

## Using it

- Toolbar icon: opens the recorder on the page. While recording, clicking it stops the recording.
- `Alt+Shift+S`: starts a recording with your last settings, and stops it. Chrome leaves the shortcut unset if another extension already has it; change it at `chrome://extensions/shortcuts`.
- The round badge on the page while recording: stop, pause, blur, draw, click highlights, camera and microphone.
- Options (the cog in the recorder): defaults, failed uploads to retry, and the Capture2u address, which only needs changing for local testing.

## End-to-end check

```bash
npm run build
npm run test:e2e
```

This loads `dist` in installed Chrome (or Playwright's Chromium with `C2U_E2E_BROWSER=chromium`) against an in-memory stand-in for the Worker (`e2e/fake-server.mjs`). It signs in through the real `chrome.identity` window, records, draws, blurs, checks click highlights, and confirms the upload parts, the completion call and the thumbnail arrive. A second pass records a real tab and plays the uploaded file back to confirm the page, a click ripple and a pen stroke are in the picture. Screenshots and the uploaded files are written to `e2e/.output`.

## Layout

| Path | What it is |
|---|---|
| `src/background` | Service worker: sign-in, recording start and stop, shortcut, tab messaging |
| `src/offscreen` | The recorder: capture, encoding, upload, thumbnail |
| `src/content` | What shows on the page: recorder panel, recording bar, camera bubble, countdown, drawing, blur, click highlights |
| `src/popup` | The recorder panel's contents |
| `src/options`, `src/permission`, `src/recorder`, `src/uploading` | The extension's own pages |
| `src/shared` | API client, settings, types |
| `e2e` | End-to-end check and the stand-in server |
