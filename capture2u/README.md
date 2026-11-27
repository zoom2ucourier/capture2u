# Capture2u

Our internal Loom replacement: record the screen in the browser, get a link, share it. It runs on Cloudflare (Worker, R2, Queues, Workers AI) and Supabase (sign-in and database).

This folder is self-contained and is not part of the Cap monorepo's workspaces. It reuses Cap's open-source browser recorder from `../packages/recorder-core`, which is why it lives in this fork and is AGPLv3.

## Layout

| Path | What it is |
|---|---|
| `worker/` | The Cloudflare Worker: API, uploads, playback, share-page link previews, background jobs |
| `src/` | The website (React): sign-in, library, recorder, watch page |
| `shared/` | Types and pure helpers used by both |
| `extension/` | The Chrome extension (Cap's open-source extension, pointed at this Worker) |
| `supabase/migrations/` | Database schema |
| `test/` | Unit tests |

## How it fits together

- **Sign-in:** enter a work email, get a 6-digit code by email, type it in. The Worker checks the domain, creates the code (10 minutes, 5 guesses, 5 codes an hour per address) and emails it through Cloudflare Email Sending. A correct code is swapped for a normal Supabase Auth session. Sign-up is also refused at the database for any address outside `allowed_email_domains`, and the Worker checks the domain again on every request.
- **Data:** every table has row level security on with no policies. The browser never reads the database; all access goes through the Worker using the service key.
- **Recording:** the browser records H.264/AAC MP4 and uploads it in parts while it is still recording, so the link works the moment recording stops (it is copied to the clipboard on stop). The video row is created when recording starts.
- **Seekable copy:** what is uploaded live is a fragmented MP4 with no seek index. A queue job (`optimize-video`) rewrites the container into a normal MP4 with its index first (no re-encode, read and written in 8 MB pieces) and switches the video over to it. Until then the first upload plays from the start. The first upload is kept for a few hours so anyone already watching it is not cut off, then the nightly job deletes it.
- **Crash safety:** the recorded pieces are also written to the browser's own storage. If the tab is closed or the browser crashes, the next visit offers to recover the recording and uploads it to the same link.
- **Uploading a file:** an existing MP4, MOV or WebM (up to 4 GB) can be uploaded from the library and gets the same link, transcript and summary.
- **Uploads:** the Worker implements the same multipart routes Cap's uploader expects, but the "presigned URL" points back at the Worker, which writes each part to R2 through its bucket binding. The bucket stays private and needs no CORS rules or API keys.
- **Playback:** `/media/:id/video` streams from R2 with range support after checking a short-lived signed token.
- **Transcripts and AI:** a queue job calls Workers AI for speech-to-text, then for title, summary and chapters.
- **Comments and reactions:** signed-in staff only, optionally tied to a moment in the video. One reply level. Each person can toggle each emoji once per video.
- **Folders:** each person groups their own videos. A folder shared with the company can be browsed by all signed-in staff; videos set to "Only me" stay hidden.
- **Trim and cuts:** hide the start, the end or any section in the middle from viewers (player, transcript, chapters, captions). The file is not cut, so the owner can undo it and the owner's download is the full recording. Because the file is untouched, do not rely on a cut to hide something confidential. After transcription the owner is offered one-click removal of pauses (2 seconds or more with no speech) and of "um" and "uh" where the speech model writes them down.
- **Embed:** `/embed/:id` is a bare player for iframes. The share page offers a copy-and-paste embed code and advertises oEmbed for open videos.
- **Slack:** `/api/slack/events` answers Slack's link events with a playable video card for open videos. Locked videos keep the plain preview card. With the bot token set, the owner also gets a direct message when a colleague watches for the first time, when the first person who is not signed in watches, and when someone comments; a person mentioned with `@` in a comment, or replied to, gets one too. People are matched to Slack by email address. Each person can switch their alerts off in the library.
- **Chrome extension:** `extension/` records from any page without a Capture2u tab open, with on-page drawing, click highlights and blur. It signs in through `/extension/connect`, which hands it a long random key (stored hashed in `extension_keys`) that the Worker accepts in place of a sign-in session. Its routes are under `/api/extension` and keep the shapes Cap's extension expects. `npm run package` in `extension/` rebuilds `public/capture2u-extension.zip`, which the site offers for download at `/extension`.
- **Viewers:** the owner sees who watched on the video page: signed-in staff by name, plus a count of viewers who were not signed in. The only email the app sends is the sign-in code.
- **Retention:** a nightly scheduled job deletes videos older than `RETENTION_DAYS` unless `keep` is set. It only deletes when `RETENTION_MODE` is exactly `delete`; otherwise it writes a report to `retention_runs`.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev        # local site + Worker
npm run deploy     # manual deploy; normally Cloudflare deploys on push
```

Local development needs a `.dev.vars` file (see `.dev.vars.example`) and, because the account has more than one Cloudflare account attached, `CLOUDFLARE_ACCOUNT_ID` set in the shell.

## Deploying

The Worker is deployed by Cloudflare from this repository (Workers Builds) on every push to `main`. It works with Cloudflare's default settings, with no root directory set:

| Field | Value |
|---|---|
| Build command | `bun run build` (or `npm run build`) |
| Deploy command | `npx wrangler deploy` |

The repository's top-level `build` script builds only this app (`scripts/build-from-repo-root.mjs`) and leaves a pointer so the deploy command picks it up. Cap's original build is kept as `build:cap`. Setting the root directory to `capture2u` with build command `npm run build` also works and skips installing Cap's dependencies.

Already created on the Locate Technologies accounts:

- Supabase project `capture2u` (`frbjfigqvxosswdhdjqi`, Sydney) with every file in `supabase/migrations/` applied.
- R2 bucket `capture2u-videos` (Oceania). Unfinished uploads are cleared after 7 days by a bucket rule. Do not add any rule that deletes objects; retention is done by the Worker so the Keep flag is respected.
- Queue `capture2u-jobs`.

- Email sending for `capture2u.locate2u.com` (Cloudflare Email Sending). Sign-in codes come from `no-reply@capture2u.locate2u.com`; set `EMAIL_FROM` to use another address on an onboarded domain.
- The app's address, `https://capture.locate2u.io`, attached to the Worker as a custom domain (`routes` in `wrangler.jsonc`). It also answers at `https://capture2u.steve-590.workers.dev`.

The `SUPABASE_SERVICE_ROLE_KEY` secret is set on the Worker. Still to do by hand:

1. **Slack (optional):** a Slack admin creates an app from `slack-app-manifest.json` and installs it. Add its signing secret as `SLACK_SIGNING_SECRET` and its bot token as `SLACK_BOT_TOKEN`, then press Retry on the app's Event Subscriptions page. An app installed before the alerts were added needs the three extra permissions in the manifest (`chat:write`, `users:read`, `users:read.email`) and a reinstall; until then videos still play in Slack but no alerts are sent.
2. **Transcripts for long recordings (optional):** add credit under AI Gateway in the Cloudflare dashboard. Without it, recordings over about 8 minutes get no transcript or summary.

In Supabase, leave the Email sign-in provider on with "Confirm email" on (both are the defaults). No Google client, redirect addresses or email template changes are needed.

## Settings

Settings are managed in the Cloudflare dashboard (Worker > Settings > Variables and Secrets). `keep_vars` is on, so anything added there survives every deploy. Do not add these names to `wrangler.jsonc`: a value there would overwrite the dashboard on each deploy.

Only `SUPABASE_SERVICE_ROLE_KEY` is required. Everything else has a default or is optional.

| Name | Default | Meaning |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | none (required, secret) | Lets the Worker read and write the database. |
| `ALLOWED_EMAIL_DOMAINS` | the four company domains | Comma-separated. Exact match, so sub-domains must be listed. Keep in step with the `allowed_email_domains` table. |
| `RETENTION_MODE` | `report` | `report` or `delete`. Nothing is deleted unless this is exactly `delete`. |
| `RETENTION_DAYS` | `365` | Minimum 30. |
| `RETENTION_MAX_PER_RUN` | `200` | Most videos deleted in one night. |
| `TRANSCRIBE_MODEL` | `assemblyai/universal-3.5-pro` | Workers AI speech model. It is a paid third-party model, so it needs credit under AI Gateway in the Cloudflare dashboard. Without credit (or if it fails) the app falls back to `@cf/openai/whisper-large-v3-turbo`, which only handles recordings under 24 MB (roughly 8 minutes of screen recording). |
| `SUMMARY_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI text model for title, summary and chapters. |
| `PUBLIC_BASE_URL` | the address the request came in on | Only needed to force one address. |
| `MEDIA_TOKEN_SECRET` | derived from the service key | Optional separate secret for signing playback links and sign-in codes. Changing it expires links and codes already issued. |
| `EMAIL_FROM` | `no-reply@capture2u.locate2u.com` | Address sign-in codes come from. Its domain must be onboarded in Cloudflare Email Sending. |
| `SLACK_SIGNING_SECRET` | none (secret) | From the Slack app's Basic Information page. Needed for videos to play in Slack. |
| `SLACK_BOT_TOKEN` | none (secret) | The Slack app's bot token (`xoxb-...`). Needed for videos to play in Slack and for Slack alerts. |

| `EXTENSION_IDS` | the ID fixed by the `key` in the extension's manifest | Comma-separated Chrome extension IDs allowed to sign in. Add the Chrome Web Store ID here if the extension is ever published there, because the store gives it a different ID. |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are public values and are set in `wrangler.jsonc`.

## Checks after the first deploy

- [ ] Sign in with a company email address and the emailed code. A non-company address is refused before any email is sent.
- [ ] A wrong code is refused, and a sixth code within the hour is refused.
- [ ] Record 1 minute in Chrome. The link is on the clipboard when you stop, works in a private window straight away, and seeks once the seekable copy is ready (seconds later; the row's `optimized` turns true).
- [ ] Start a recording, close the tab after 20 seconds, open the app again and recover it. It lands on the same link.
- [ ] Upload an MP4 from the library.
- [ ] Cut a section out of the middle. A private window skips it.
- [ ] Install the extension from `/extension`, sign in, record a tab, draw and blur.
- [ ] Transcript, title, summary and chapters appear within a few minutes. If not, check the Worker logs for the shape the speech model returned.
- [ ] Set a video to "Company only" and to a password. Both are enforced in a private window.
- [ ] The view count goes up once per viewer per day, and not for the owner.
- [ ] Mark a video Keep and un-keep it.
- [ ] Comment and react as a colleague, and mention someone with `@`. With Slack set up, the owner and the mentioned person each get a Slack message, and the owner gets one for the first view.
- [ ] Put a video in a folder, share the folder, and see it from a second account.
- [ ] Trim a video. A private window shows only the kept part.
- [ ] Paste the embed code into a Confluence or Notion page.
- [ ] Paste a link in Slack after the Slack app is installed. It plays in the message.
- [ ] `retention_runs` gets a row after the nightly job, in `report` mode.
- [ ] Note the stored size of a 5-minute recording. The cost plan assumes about 50 MB.

## Licence

AGPL-3.0, because this app includes Cap's recorder. Keep the repository public and keep secrets out of it.
