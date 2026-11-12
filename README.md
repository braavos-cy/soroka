# Soroka — document management service

Self-hosted document collection + processing (crop, orientation, deskew, cleanup, OCR) + organization
and search, with manual correction of every processing step. Spec: [requirements.md](requirements.md).

## Run

```sh
cp .env.example .env        # change every secret!
docker compose up -d --build
# optional malware scanning: set CLAMAV_HOST=clamav in .env, then
docker compose --profile security up -d
```

* UI: `https://<SITE_ADDRESS>` (locally `https://localhost:8443`; accept the local CA warning once)
* API docs (OpenAPI): `/api/docs`
* First login: `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` → you must set a new password and enrol TOTP.

Services: `db` (Postgres), `redis`, `api` (FastAPI), `worker` ×2 (RQ: queues high > default > low),
`scheduler` (retention, import folder, connector alerts), `whatsapp` (connector), `web` (Caddy: TLS + UI).

### WhatsApp connector
1. Admin → Connectors: when not linked, a QR code appears. On the bot phone: WhatsApp → Linked devices → Link a device.
2. Add the bot number to groups. Groups appear under "Chats the bot is in" → **Register** (folder, tags, mode, context window),
   or generate a one-time code (`SRK-XXXXXX`) and post it in the group (the bot never replies).
3. Force-save (silent): mention the bot in the caption, reply to a file mentioning the bot, or forward a file to the bot's private chat.
4. "Unlink / re-link" logs out and shows a new QR code (e.g. after a ban, with a new number).

The connector never sends messages, reactions, read receipts or presence. Delivery receipts (grey ticks) are sent by the
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
  retention + storage-pressure rule, review queue (keyboard), search (Russian morphology, ё/е, typo tolerance, prefix,
  snippets, hit highlighting on page images), downloads, admin export, RU/EN UI.

Next phases:
* **2 — ML pipeline (GPU worker):** document/non-document classifier (chat screenshots!), PaddleOCR Cyrillic recognizer
  vs Tesseract evaluation on a Russian test set, PP-LCNet orientation, DBNet lines, UVDoc/DocRes dewarping with editable mesh,
  PP-Structure layout, dictionary-based valid-word ratio, fastText/Lingua LID, inline OCR text correction, layout editing,
  WebAuthn/passkeys, evaluation harness (§13).
* **3 — Telegram connector** (+ self-hosted Bot API server), **browser extension** (Gmail/Outlook, MV3),
  **document tools** (merge/split/reorder/move pages, image↔PDF, versions UI), auto-split of spreads.
