# Capture2u

Our internal Loom replacement: record the screen in the browser, get a link, share it. It runs on Cloudflare (Worker, R2, Queues, Workers AI) and Supabase (sign-in and database).

This folder is self-contained and is not part of the Cap monorepo's workspaces. It reuses Cap's open-source browser recorder from `../packages/recorder-core`, which is why it lives in this fork and is AGPLv3.

## Layout

| Path | What it is |
|---|---|
| `worker/` | The Cloudflare Worker: API, uploads, playback, share-page link previews, background jobs |
| `src/` | The website (React): sign-in, library, recorder, watch page |
| `shared/` | Types used by both |
| `supabase/migrations/` | Database schema |
| `test/` | Unit tests |

## How it fits together

- **Sign-in:** Supabase Auth with Google. Sign-up is refused at the database for any address outside `allowed_email_domains`, and the Worker checks the domain again on every request.
- **Data:** every table has row level security on with no policies. The browser never reads the database; all access goes through the Worker using the service key.
- **Recording:** the browser records H.264/AAC MP4, rewrites it into a seekable MP4 locally (no re-encode), then uploads it in parts.
- **Uploads:** the Worker implements the same multipart routes Cap's uploader expects, but the "presigned URL" points back at the Worker, which writes each part to R2 through its bucket binding. The bucket stays private and needs no CORS rules or API keys.
- **Playback:** `/media/:id/video` streams from R2 with range support after checking a short-lived signed token.
- **Transcripts and AI:** a queue job calls Workers AI for speech-to-text, then for title, summary and chapters.
- **Retention:** a nightly scheduled job deletes videos older than `RETENTION_DAYS` unless `keep` is set. It only deletes when `RETENTION_MODE` is exactly `delete`; otherwise it writes a report to `retention_runs`.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev        # local site + Worker
npm run deploy     # build and deploy to Cloudflare
```

Local development needs a `.dev.vars` file (see `.dev.vars.example`) and, because the account has more than one Cloudflare account attached, `CLOUDFLARE_ACCOUNT_ID` set in the shell.

## First-time setup

Each step creates something on a company account. Get approval first.

1. **Supabase project** in `ap-southeast-2` on the Locate Technologies org. Apply `supabase/migrations/0001_init.sql`.
2. **Google sign-in** in the Supabase project: Authentication > Providers > Google, with a Google Cloud OAuth client. Add `https://capture2u.locate2u.com` to the allowed redirect URLs.
3. **Cloudflare resources:**
   ```bash
   npx wrangler r2 bucket create capture2u-videos
   npx wrangler queues create capture2u-jobs
   ```
   Add a lifecycle rule on the bucket to abort unfinished multipart uploads after 7 days. Do not add any rule that deletes objects; retention is done by the Worker so the Keep flag is respected.
4. **Settings** in `wrangler.jsonc` under `vars`: `SUPABASE_URL` and `SUPABASE_ANON_KEY` (the publishable key).
5. **Secrets:**
   ```bash
   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   npx wrangler secret put MEDIA_TOKEN_SECRET     # openssl rand -hex 32
   ```
6. **Deploy:** `npm run deploy`, then attach the custom domain `capture2u.locate2u.com` to the Worker.

## Settings

| Name | Meaning |
|---|---|
| `PUBLIC_BASE_URL` | The public address. Used when the speech model fetches a recording. |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated. Exact match, so sub-domains must be listed. Keep in step with the `allowed_email_domains` table. |
| `RETENTION_MODE` | `report` or `delete` |
| `RETENTION_DAYS` | Default 365, minimum 30 |
| `RETENTION_MAX_PER_RUN` | Most videos deleted in one night. Default 200. |
| `TRANSCRIBE_MODEL` | Workers AI speech model. `assemblyai/universal-3.5-pro` reads the file by URL. `@cf/openai/whisper-large-v3-turbo` is cheaper but only handles recordings under 24 MB. |
| `SUMMARY_MODEL` | Workers AI text model for title, summary and chapters |

## Checks after the first deploy

- [ ] Sign in with a company Google account. A non-company account is refused.
- [ ] Record 1 minute in Chrome. The link works in a private window and the video seeks.
- [ ] Transcript, title, summary and chapters appear within a few minutes. If not, check the Worker logs for the shape the speech model returned.
- [ ] Set a video to "Company only" and to a password. Both are enforced in a private window.
- [ ] The view count goes up once per viewer per day, and not for the owner.
- [ ] Mark a video Keep and un-keep it.
- [ ] `retention_runs` gets a row after the nightly job, in `report` mode.
- [ ] Note the stored size of a 5-minute recording. The cost plan assumes about 50 MB.

## Licence

AGPL-3.0, because this app includes Cap's recorder. Keep the repository public and keep secrets out of it.
