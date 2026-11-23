# Soroka — document management service

Self-hosted document collection + processing (crop, orientation, deskew, cleanup, OCR) + organization
and search, with manual correction of every processing step. Spec: [requirements.md](requirements.md).

## Development server

```sh
./dev.sh
```

Runs everything in the foreground of one terminal (logs from all services, interleaved); **Ctrl+C stops it**.
Open `http://<server-public-ip>:5173` (port: `DEV_PORT` in `.env`). Code changes apply immediately, no rebuild:
UI via Vite hot reload, `api` via uvicorn `--reload`, `worker`/`scheduler` restart on `.py` changes, WhatsApp via `node --watch`.
Restart `./dev.sh` only after changing `requirements.txt`, `package.json` or a Dockerfile.

* First run creates `.env` with random secrets and prints the admin password.
* Dev is a separate compose project (`soroka-dev`): its own database and files, production volumes are untouched.
* Plain HTTP (cookies not `Secure`) — dev only, don't put real documents in it.
* `DEV_NO_PASSWORD=true` in `.env`: no login on the dev server, every browser is the admin (no 2FA/password prompts).
  Production ignores it: only the dev override passes it to the backend, and the backend refuses it with `Secure` cookies.
* The port must be open in the cloud firewall (Oracle Cloud: VCN → Security List → ingress TCP 5173).
* Wipe dev data: `docker compose -p soroka-dev down -v`.

## Production (auto-deploy)

Production runs from `/opt/soroka` (separate from any dev checkout) and redeploys itself: a systemd timer checks
GitHub every minute and, when `main` has a new commit, runs `deploy/update.sh` (`git reset` to `origin/main` +
`docker compose up -d --build`). The old containers keep serving until the new build is done; a failed build is retried.
Containers restart automatically (`restart: unless-stopped`, Docker starts on boot).

```sh
git clone https://github.com/braavos-cy/soroka.git /opt/soroka
cd /opt/soroka && cp .env.example .env    # change every secret; SITE_ADDRESS=<domain>, HTTP_PORT=80, HTTPS_PORT=443
deploy/install.sh                         # Docker, auto-deploy timer, daily backup (03:00), log rotation
```

* Deploy log: `journalctl -u soroka-update -f` · force a redeploy: `/opt/soroka/deploy/update.sh --force`
* Pause auto-deploy: `sudo systemctl stop soroka-update.timer` (`start` to resume)
* Ports 80 and 443 must be open in the cloud firewall; Caddy gets and renews the Let's Encrypt certificate itself.
* Never edit files in `/opt/soroka` (other than `.env`) — they're overwritten on the next deploy.

## Run (manual)

```sh
cp .env.example .env        # change every secret!
docker compose up -d --build
# optional malware scanning: set CLAMAV_HOST=clamav in .env, then
docker compose --profile security up -d
```

* UI: `https://<SITE_ADDRESS>` (locally `https://localhost:8443`). Locally, trust Caddy's CA instead of clicking through
  the warning — browsers disable password saving/suggestions on pages with certificate errors:
  `docker compose exec web cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt` then (Windows)
  `certutil -user -addstore Root caddy-root.crt` and restart the browser.
* API docs (OpenAPI): `/api/docs` — only when `API_DOCS=true` in `.env` (always on in the dev server)
* First login: `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` → you must set a new password and enrol TOTP.

Services: `db` (Postgres), `redis`, `api` (FastAPI), `worker` ×2 (RQ: queues high > default > low),
`scheduler` (retention, import folder, connector alerts), `whatsapp` (connector), `web` (Caddy: TLS + UI).

### WhatsApp connector
1. Admin → Connectors: when not linked, a QR code appears. On the bot phone: WhatsApp → Linked devices → Link a device.
2. Add the bot number to groups. Groups appear under "Chats the bot is in" → **Register** (folder, tags, mode, context window),
   or generate a one-time code (`SRK-XXXXXX`) and post it in the group (the bot never replies).
3. Force-save (silent): mention the bot in the caption, reply to a file mentioning the bot, or forward a file to the bot's private chat.
4. "Unlink / re-link" logs out and shows a new QR code (e.g. after a ban, with a new number).

5. "Leave chat" (admins only, next to each chat): the bot leaves the group and the chat is unregistered; saved
   documents stay. Group members see the usual "left" notice. Nobody can make the bot leave from inside the chat.

6. Reactions: the bot reacts to a message once its outcome is known — ✅ saved (also for a file that is already
   stored), ❌ rejected as a non-document. One reaction per message; a later rescue or manual reject does not change it.
   Switch off for everything in Admin → Settings, or per chat in the chat's settings. Note that anything the bot
   sends raises the WhatsApp ban risk compared with staying fully silent.

The connector never sends text messages, read receipts or presence. Delivery receipts (grey ticks) are sent by the
protocol automatically and cannot be disabled.

### Bulk import
* Upload ZIPs or whole folders in the UI (folder structure is preserved; tick "bulk import" for the low-priority queue), or
* copy files into the `files` volume under `import/…` — they are imported into the "Import" folder (structure kept) and moved to `import/_done`.

### Backup & restore
`deploy/backup.sh` (cron daily) dumps Postgres and archives the files + WhatsApp session volumes.
Restore: `docker compose down`; recreate volumes; `tar xzf files-*.tgz` into `soroka_files`;
`docker compose up -d db`; `docker compose exec -T db pg_restore -U soroka -d soroka --clean < db-*.dump`; `docker compose up -d`.
Encryption at rest: put the Docker data dir / volumes and backups on LUKS-encrypted disks.

## Status — phase 1 (vertical slice)

Done:
* Auth: Argon2id, mandatory TOTP + recovery codes, lockout + rate limit, sessions with revoke, re-auth for sensitive actions,
  scoped API tokens, audit log, roles, admin user management, CSRF protection, TLS (Caddy).
* Ingestion: common ingest model with context window (before/after), dedup by hash, upload (files/folders/ZIP, per-file or
  combined), watched import dir, WhatsApp connector (registration via UI or one-time code, auto/override modes, overrides,
  health + email alerts, QR re-link), optional ClamAV.
* Pipeline (CPU, classic): normalize (EXIF, HEIC/AVIF/TIFF/GIF…), quality, acceptance (heuristic), boundary detection with
  candidates + fusion + tiers, perspective, orientation (Tesseract OSD + line direction, 4-rotation OCR fallback),
  curvature measurement, deskew, cleanup (color/gray/B&W), two-pass OCR (tessdata_best rus+eng), look-alike Latin/Cyrillic
  fixes, basic layout, consistency check, searchable PDF/text/JSON/thumbnails. PDF: text layer per page (with garbled-text
  detection → OCR). Office via LibreOffice.
* Recipe-based editing: crop corners (magnifier, candidates), rotation, deskew (live preview), cleanup, OCR languages,
  acceptance; per-stage reset, full history with undo/redo, reset to automatic; correction log.
* Folders (tree, drag & drop), tags (hierarchy, colors, AND/OR/NOT, rename/merge), bulk actions, trash, rejected area +
  retention + storage-pressure rule, review queue, search (Russian morphology, ё/е, typo tolerance, prefix,
  snippets, hit highlighting on page images), downloads, admin export, RU/EN UI.

What's next: [TODO.md](TODO.md).
