# Capture2u runbook

Capture2u is our self-hosted fork of [Cap](https://github.com/CapSoftware/Cap) (AGPLv3). This folder holds everything needed to run it in production. The project plan is kept internally and is not part of this repo.

## What runs

One server, five containers, started from `docker-compose.yml` in this folder:

| Container | What it does |
|---|---|
| `cap-web` | The website: dashboard, share pages, sign-in, in-browser recorder. Built from this fork. |
| `media-server` | Converts recordings and makes thumbnails. Cap's image, unchanged. |
| `mysql` | Accounts, video listings, comments. |
| `scheduler` | Nightly database backup, nightly retention run, Cap's upkeep jobs every 15 minutes. |
| `cloudflared` | Cloudflare Tunnel. Connects `capture2u.locate2u.com` to `cap-web`. The server has no open ports. |

Video files live in Cloudflare R2, not on the server.

## What we changed from upstream Cap

Keep this list current. It is what has to survive every upstream merge.

| Change | Files |
|---|---|
| Retention job (delete after 1 year unless kept) | `apps/web/lib/capture2u/retention.ts`, `apps/web/app/api/cron/capture2u-retention/route.ts` |
| Keep switch on each video | `apps/web/actions/capture2u/keep.ts`, `apps/web/app/(org)/dashboard/caps/components/CapCard/KeepMenuItem.tsx`, 5 lines in `CapCard.tsx`, 4 lines in `packages/database/types/metadata.ts` |
| Email through Amazon SES | `packages/database/emails/capture2u-ses.ts`, 23 lines in `packages/database/emails/config.ts` |
| Deployment | everything under `deploy/capture2u/` |

No database changes of our own. The Keep flag is stored inside a field Cap already has.

## One-time setup

Each of these creates or changes something outside the repo. **Get approval before doing any of them.**

1. **Server.** Vultr, Sydney, 4 CPU / 8 GB / 160 GB, Ubuntu 24.04. Install Docker Engine with the compose plugin. No inbound firewall rules are needed except SSH.
2. **R2 buckets.** Create `capture2u-videos` and `capture2u-backups`, both private, location hint Oceania.
   - On `capture2u-videos`: apply the CORS rules in `r2/cors.json` and the lifecycle rule in `r2/lifecycle-videos.json` (abort unfinished uploads after 7 days). **Do not add any rule that deletes objects in this bucket.** Retention is done by the app so the Keep flag is respected.
   - On `capture2u-backups`: apply `r2/lifecycle-backups.json` (delete backups after 35 days).
   - Create two API tokens, each "Object Read & Write" and limited to one bucket.
3. **Cloudflare Tunnel.** Zero Trust > Networks > Tunnels > create. Public hostname `capture2u.locate2u.com`, service `http://cap-web:3000`. Copy the tunnel token. This creates the DNS record.
4. **Google sign-in.** Google Cloud console > OAuth client (Web application). Authorised redirect URI: `https://capture2u.locate2u.com/api/auth/callback/google`.
5. **Email.** In SES (region in `.env`), verify the sending address or domain and confirm the account is out of the SES sandbox. Create an IAM user allowed `ses:SendEmail` only.
6. **Transcripts and AI.** AssemblyAI account and key. Groq account and key.
7. **View counts.** Tinybird workspace on the free plan. From a development machine with this repo and `bun` installed, set `TINYBIRD_ADMIN_TOKEN` in a local `.env` and run `bun run analytics:setup`, then `bun run analytics:check`. Use this workspace for nothing else: the setup command removes anything it does not recognise.
8. **Slack.** Create a Slack app from `slack-app-manifest.json` at api.slack.com (needs a Slack admin). Copy the client ID, client secret and signing secret. After the site is up, connect it under Organization settings > Integrations.
9. **Website image.** In GitHub, run the **Docker Build Web** action on this fork with a tag such as `c2u-20261127`. It publishes `ghcr.io/zoom2ucourier/cap-web:<tag>`. If the package is private, log the server in with `docker login ghcr.io` using a read-only token.

## First deploy

On the server:

```bash
git clone https://github.com/zoom2ucourier/capture2u.git
cd capture2u/deploy/capture2u
cp .env.example .env
# fill in .env, generating each random secret with: openssl rand -hex 32
docker compose pull
docker compose up -d --build
docker compose logs -f cap-web
```

The website applies its own database setup on first start. Wait for the log to settle, then open `https://capture2u.locate2u.com`.

Save `DATABASE_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_PASSPHRASE` in the password manager straight away.

### First sign-in and workspace

1. Sign in with Google as the person who will own the company workspace.
2. Rename the workspace, add the logo, and set the default sharing options under Organization settings.
3. Invite everyone under Organization settings > Members (up to 50 addresses at a time). People who are invited before they first sign in land in the company workspace. People who sign up without an invite get their own empty workspace.

### Checks before telling anyone

- [ ] Record a 1-minute video with the in-browser recorder. It plays back from the share link in a private window.
- [ ] Record with the Chrome extension after setting its Cap URL in the extension options.
- [ ] Transcript, title, summary and chapters appear within a few minutes.
- [ ] Upload an existing MP4 and a PNG from the dashboard. (One upload path may not suit R2. If either fails, note the error.)
- [ ] The view count goes up after watching in a private window.
- [ ] A sign-in code email arrives (use "sign in with email").
- [ ] Paste a public video link in Slack. It plays in place.
- [ ] A sign-up from an address outside the allowed domains is refused.
- [ ] `docker compose restart cap-web` while a video is still processing. The video still finishes.
- [ ] `docker compose logs scheduler` shows a backup upload and a retention run in `report` mode.
- [ ] Mark a video Keep from its menu, then un-keep it.
- [ ] Note the real stored size of a 5-minute video in R2. The cost plan assumes about 50 MB.

## Day-to-day

```bash
docker compose ps                    # everything should be "healthy" or "running"
docker compose logs -f cap-web       # website
docker compose logs -f media-server  # video processing
docker compose logs --since 24h scheduler
```

**Adding staff:** invite them from Organization settings > Members.

**Removing a leaver:** remove them from Members (their videos can be handed to someone else in that dialog), then add their address to `CAP_BLOCKED_SIGNUP_DOMAINS` in `.env` and run `docker compose up -d cap-web`.

**Adding an email domain:** add it to `CAP_ALLOWED_SIGNUP_DOMAINS`, then `docker compose up -d cap-web`.

## Retention

- Every night the scheduler calls the retention job. It looks for videos recorded more than `CAPTURE2U_RETENTION_DAYS` days ago that are not marked Keep.
- `CAPTURE2U_RETENTION_MODE=report` only lists what it would delete. `delete` actually deletes, through Cap's own delete, so the listing, shares and files go together.
- It deletes at most `CAPTURE2U_RETENTION_MAX_PER_RUN` videos a night.
- Any value other than the exact word `delete` leaves it in report mode.

To see what it would do right now:

```bash
docker compose exec scheduler call-cron.sh /api/cron/capture2u-retention 1800
```

**Going live with deletion:** leave it on `report` until the nightly list has been checked for at least two weeks. Then set `CAPTURE2U_RETENTION_MODE=delete` and run `docker compose up -d cap-web`. Deleted videos cannot be recovered.

## Backup

- Every night at `BACKUP_AT_UTC` the scheduler dumps the database, compresses it, encrypts it with `BACKUP_ENCRYPTION_PASSPHRASE`, and uploads it to `capture2u-backups/mysql/`.
- The bucket's lifecycle rule removes backups after 35 days.
- Videos are not backed up a second time. They are only in `capture2u-videos`.

Run one now:

```bash
docker compose exec scheduler backup.sh
```

## Restore

Use this on a fresh server or to roll back a bad update.

1. Download the backup you want from `capture2u-backups/mysql/` (Cloudflare dashboard, or any S3 tool pointed at the R2 endpoint).
2. Decrypt and unpack it:
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
     -in capture2u-<stamp>.sql.gz.enc -out restore.sql.gz \
     -pass pass:'<BACKUP_ENCRYPTION_PASSPHRASE>'
   gunzip restore.sql.gz
   ```
3. Stop the website so nothing writes during the restore:
   ```bash
   docker compose stop cap-web scheduler
   ```
4. Load it:
   ```bash
   docker compose exec -T mysql sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE cap; CREATE DATABASE cap CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
   docker compose exec -T mysql sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" cap' < restore.sql
   ```
5. Start again with **the same `DATABASE_ENCRYPTION_KEY` the backup was made with**:
   ```bash
   docker compose up -d
   ```

Videos recorded after the backup was taken will still be in R2 but will have no listing. Test a restore on a scratch machine before go-live and once a quarter.

## Updating from upstream Cap

Do this about once a month, and sooner for a security fix.

1. On a development machine:
   ```bash
   git remote add upstream https://github.com/CapSoftware/Cap.git   # first time only
   git fetch upstream
   git checkout main
   git merge upstream/main
   ```
2. Resolve conflicts. They should only ever be in the three upstream files listed under "What we changed": `CapCard.tsx`, `metadata.ts` and `emails/config.ts`. Re-apply our few lines.
3. Check `docker-compose.yml` at the repo root and `apps/web/content/docs/self-hosting.mdx` for new or renamed settings, and carry them into `deploy/capture2u/docker-compose.yml`.
4. Push, then run the **Docker Build Web** action with a new tag.
5. On the server:
   ```bash
   cd capture2u && git pull
   cd deploy/capture2u
   docker compose exec scheduler backup.sh          # always back up first
   # set the new CAPTURE2U_WEB_IMAGE tag in .env
   docker compose pull
   docker compose up -d --build
   docker compose logs -f cap-web
   ```
6. The website updates the database itself on start. If the log shows a database update error, do not delete any volumes. Put the old image tag back in `.env`, restore the backup taken in step 5, and start again.
7. Update `media-server` at the same time as the website. The two are released together and the website refuses some jobs if the media server is older than it expects.
8. Run the checks from "Checks before telling anyone".

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Site unreachable | `docker compose ps`, then `docker compose logs cloudflared cap-web` |
| Recording uploads fail in the browser | R2 CORS rules on `capture2u-videos`. `ETag` must be an exposed header and the origin must match the site address exactly. |
| Video stuck on "processing" | `docker compose logs media-server`. A busy media server queues jobs and retries. The upkeep job retries failed ones every 15 minutes. |
| No transcript | `ASSEMBLY_API_KEY`, then `docker compose logs cap-web` |
| No emails | `docker compose logs cap-web` and search for `[email]`. SES rejects unverified senders and sandboxed accounts. |
| View counts stay at 0 | `TINYBIRD_HOST` and `TINYBIRD_TOKEN`, and that the Tinybird setup command was run |
| Chrome extension cannot sign in | `CAP_CHROME_EXTENSION_ID` must be set, and the extension's Cap URL must be our address |
| Slack does not play videos | The video must be public with no password. Check the Slack app is connected under Integrations. |

Never run `docker compose down -v`. It deletes the database.

## Licence

Cap is AGPLv3. We keep its licence notices, and this fork stays public so that anyone who uses our server, including outside viewers of a share link, can get the source. Do not commit secrets. Settings live in `.env` on the server only.
