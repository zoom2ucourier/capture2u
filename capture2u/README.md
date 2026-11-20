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

- Supabase project `capture2u` (`frbjfigqvxosswdhdjqi`, Sydney) with `supabase/migrations/0001_init.sql` applied.
- R2 bucket `capture2u-videos` (Oceania). Unfinished uploads are cleared after 7 days by a bucket rule. Do not add any rule that deletes objects; retention is done by the Worker so the Keep flag is respected.
- Queue `capture2u-jobs`.

Still to do by hand:

1. **Secret:** in the Worker's Settings > Variables and Secrets, add `SUPABASE_SERVICE_ROLE_KEY` as a secret (Supabase > Project Settings > API keys > secret key).
2. **Google sign-in:** in the Supabase project, Authentication > Sign In / Providers > Google, with a Google Cloud OAuth client whose redirect address is `https://frbjfigqvxosswdhdjqi.supabase.co/auth/v1/callback`. Turn the Email provider off.
3. **Addresses:** in Supabase, Authentication > URL Configuration, set the Site URL to the app's address and add `<address>/**` to the redirect list.
4. **Custom domain:** attach `capture2u.locate2u.com` to the Worker.

## Settings

Settings are managed in the Cloudflare dashboard (Worker > Settings > Variables and Secrets). `keep_vars` is on, so anything added there survives every deploy. Do not add these names to `wrangler.jsonc`: a value there would overwrite the dashboard on each deploy.

Only `SUPABASE_SERVICE_ROLE_KEY` is required. Everything else has a default.

| Name | Default | Meaning |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | none (required, secret) | Lets the Worker read and write the database. |
| `ALLOWED_EMAIL_DOMAINS` | the four company domains | Comma-separated. Exact match, so sub-domains must be listed. Keep in step with the `allowed_email_domains` table. |
| `RETENTION_MODE` | `report` | `report` or `delete`. Nothing is deleted unless this is exactly `delete`. |
| `RETENTION_DAYS` | `365` | Minimum 30. |
| `RETENTION_MAX_PER_RUN` | `200` | Most videos deleted in one night. |
| `TRANSCRIBE_MODEL` | `assemblyai/universal-3.5-pro` | Workers AI speech model. `@cf/openai/whisper-large-v3-turbo` is cheaper but only handles recordings under 24 MB. |
| `SUMMARY_MODEL` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Workers AI text model for title, summary and chapters. |
| `PUBLIC_BASE_URL` | the address the request came in on | Only needed to force one address. |
| `MEDIA_TOKEN_SECRET` | derived from the service key | Optional separate secret for signing playback links. Changing it expires links already issued. |

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are public values and are set in `wrangler.jsonc`.

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
