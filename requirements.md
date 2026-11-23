# Document Management Service — Requirements Specification
Version 0.2

## 1. Overview
A self-hosted service on a remote server that collects documents from several sources, automatically processes them (cleanup, dewarping, rotation, cropping, OCR), and lets users organize, search, review, correct, and edit them. Conceptually similar to Paperless-ngx, but with a far more robust processing pipeline and full manual correction of every processing step.

### 1.1 Components
1. **Core server**: API, processing pipeline, storage, search, auth.
2. **Web UI**: organization, search, viewer, pipeline editor, document tools, admin.
3. **Ingestion connectors**:
   - WhatsApp bot account (unofficial bridge)
   - Telegram bot
   - Browser extension for webmail
   - Direct upload in the UI
The UI and all connectors use the same documented API (API-first).

### 1.2 Hard constraints
- Free and open-source components only. No paid APIs, no commercial SDKs. Verify licenses of all code AND model weights; prefer permissive licenses (Apache 2.0, MIT, BSD, MPL). Flag any AGPL or non-commercial component before using it.
- Runs on our own Linux server. GPU available for ML inference.
- Originals are never modified or deleted by processing.

### 1.3 Scale
- ~10 user accounts, ~5 active.
- Initial bulk import (backlog), then several documents per day.
- Design for simplicity: a single server is sufficient. Avoid distributed infrastructure unless needed.

## 2. Users, roles, authentication

### 2.1 Workspace model
- ONE shared workspace. All users see and can work with all documents, folders, and tags. No personal spaces, no per-folder permissions (for now). Keep the data model ready for adding permissions later, but do not build them.

### 2.2 Roles
- **User**: full access to all documents: upload, organize, tag, edit, review, use document tools, move to trash.
- **Admin**: everything a user can do, plus: manage users (invite, disable, delete, reset 2FA), system settings, connectors (bot accounts, registered chats), retention settings, permanent deletion (empty trash), audit log.

### 2.3 Authentication & security
- Login with email + password (Argon2id hashing).
- 2FA ON and mandatory by default: TOTP apps and WebAuthn/passkeys. One-time recovery codes. Admin can change the policy, but the default is enforced.
- Rate limiting and lockout on failed attempts; session list with remote revoke; re-auth for sensitive actions (2FA changes, permanent deletion, exports).
- Scoped, revocable API tokens for the browser extension (per device).
- Audit log of logins, deletions, settings and admin actions.
- TLS everywhere; encryption at rest for files and database.
- Uploads scanned for malware (e.g. ClamAV) before processing.
- Deleted documents go to Trash [Assumption: 30 days], restorable by any user, permanently purged by admin or automatically after the period.

## 3. Ingestion

### 3.1 Common ingestion model
Every incoming item becomes an **ingest event** with:
- Files (original bytes, filename, MIME type, hash for dedup)
- Source: platform (whatsapp / telegram / email / upload), chat or mailbox ID and name, message ID / link
- Who: sender (platform user ID, display name, phone / username / email where available)
- When: original send time and ingest time
- Where: chat/group name; location if shared
- Forwarding info if forwarded
- **Context**: caption, the message it replies to, and surrounding text messages. Default window: up to 5 text messages before and after, within ±10 minutes, same chat. Configurable per chat.
- Target folder and tags from chat registration (§3.5)
Context and metadata are stored with the document and fully searchable.

### 3.2 WhatsApp connector (unofficial bridge)
- Uses a dedicated WhatsApp account (own phone number / SIM) connected as a linked device through an unofficial client library speaking the WhatsApp Web multi-device protocol. Candidates: whatsmeow (Go) or Baileys (Node). Evaluate maintenance status and license before choosing.
- The account is added to chats and groups like a normal participant and captures images, PDFs and office files from registered chats, plus context (§3.1).
- **Fully silent**: never sends messages, reactions, read receipts or typing indicators to chats [read receipts off if the library allows]. Listening-only behavior reduces ban risk.
- Session persisted on the server; automatic reconnect; QR-code / pairing-code re-linking from the admin UI.
- Health monitoring: admin is alerted (UI + email) on disconnect, logout, or suspected ban.
- Runs as an isolated container behind a connector interface. A ban or crash must not affect the rest of the system; switching to a new number must be a simple re-link.
- Known risk, accepted: this violates WhatsApp's terms; the number may be banned at any time.

### 3.3 Telegram connector
- Official Telegram Bot API.
- Bot must have privacy mode disabled or be a group admin to see all group messages. Document this in setup.
- Run a self-hosted Telegram Bot API server to allow files larger than the standard ~20 MB download limit.
- Silent, same capture/context/override behavior as WhatsApp.

### 3.4 Browser extension (webmail)
- Chrome and Firefox (Manifest V3). Gmail and Outlook web first.
- "Send to [service]" button on the open email and on each attachment; one click imports selected or all attachments.
- Metadata: from, to, cc, subject, date, mailbox; email body stored as context.
- Later: user-defined auto-import rules; optional dedicated import email address (IMAP polling).
- Authenticates with a scoped API token.

### 3.5 Chat registration
- Bots ignore chats that are not registered.
- Registration from the admin UI: select a chat the bot is in.
- Per registered chat: default destination folder, default tags, context-window settings, mode (auto-capture all / override-only).

### 3.6 Direct upload and bulk import
- Drag and drop / file picker, multiple files and folders, into a chosen folder with chosen tags.
- Per upload: "one document from all files" (pages) or "one document per file".
- Bulk import for the initial backlog: upload of ZIP archives and/or a watched import directory on the server, preserving the source folder structure as folders [Assumption].
- Bulk imports run in a low-priority queue so new incoming documents are never stuck behind the backlog.

## 4. Document acceptance (non-document rejection)

### 4.1 Classification
Runs after ingest, before heavy processing, for images. PDFs and office files are always accepted.
Signals (multiple methods, scored):
- Image classifier: document / non-document (photo, selfie, meme, chat screenshot, etc.)
- Text density from fast text detection
- Page-boundary detection success (§5.3.3)
Tiers:
- Document (high confidence) → processed normally
- Uncertain → processed, flagged "is this a document?" in the review queue
- Non-document → rejected

### 4.2 Rejected items
- Kept in a "Rejected" area visible to all users.
- Retention: default 10 days, admin-configurable. Storage-pressure rule: if the Rejected area exceeds a configured size, or free disk space falls below a configured threshold, delete oldest rejected items first (with a configurable minimum retention, e.g. 3 days).
- Any user can rescue an item; it then goes through the full pipeline.

### 4.3 Force-save overrides
Any of these forces an item to be saved as a document regardless of classification:
- Mentioning the bot in a reply to the message
- Mentioning the bot in the message caption
- Forwarding the message to the bot's private chat
- Rescue from Rejected in the UI
The bot gives NO confirmation in the chat (silent). Status is visible only in the UI.
Overrides are logged as training data for the classifier.

## 5. Processing pipeline

### 5.1 Supported formats
- Images: JPEG, PNG, HEIC/HEIF, WebP, TIFF (incl. multi-page), BMP, GIF (first frame), AVIF.
- PDF: born-digital, scanned, mixed. Decide per page: pages with a real text layer skip image processing and use extracted text; image pages go through the full pipeline.
- Office: DOCX, DOC, XLSX, XLS, PPTX, PPT, ODT, ODS, ODP, RTF, TXT, CSV.
  - Extract text natively (incl. tables and slides); OCR embedded images.
  - Generate PDF rendition for preview (e.g. LibreOffice headless). The original file stays authoritative and downloadable.

### 5.2 Languages
- Russian and English only, for now. Russian quality is the priority.
- Select and tune OCR models primarily on Russian documents (Cyrillic recognizers of PaddleOCR, Tesseract `rus`, combined `rus+eng` for mixed pages); evaluate each candidate on a Russian test set before choosing.
- Handle Russian specifics: ё/е equivalence, mixed Cyrillic/Latin text (company names, codes), common look-alike character confusion (Latin/Cyrillic а/a, о/o, р/p, с/c, е/e, х/x) corrected using word-level context.
- Keep language support configurable so more languages can be added later.

### 5.3 Design principles
1. **Candidates, not answers.** Each stage produces candidates with confidence scores and the method that produced them.
2. **Fusion.** Picks the winner using weighted scores and agreement between methods. Weights/thresholds in config.
3. **Three tiers** per stage and per page: HIGH → auto-accept; MEDIUM → accept + "please check" flag; LOW or disagreement → review queue with top 2–3 candidates side by side.
4. **Recipe-based rendering.** Output = original + JSON recipe. Edits change the recipe; only downstream stages re-run.
5. **Cheap first, expensive on doubt.**
6. **Every correction is training data.** Log all candidates, scores, auto choice, user choice.
7. **Per page.** All stages and edits apply to each page independently.

### 5.4 Stages (in this order)

**0. Ingest & normalize.** Decode; apply and strip EXIF orientation; store original; dedup by hash.

**1. Quality check.** Blur, exposure/glare, resolution. Poor quality → flag (still process).

**2. Document acceptance** (§4).

**3. Page boundary detection.**
Candidates: classic CV (edges + contour/Hough quadrilateral); segmentation model → quad fit; corner-regression model; "already cropped" detector (flat scans → full frame).
Scoring: method agreement (IoU), geometry (convex, plausible angles, aspect ratio near A4/Letter/receipt/ID card), boundary edge contrast, area fraction.
Detect and flag multiple documents in one photo and two-page spreads (later: auto-split).

**4. Perspective correction.** Homography warp; output size from estimated real aspect ratio.

**5. Orientation (0/90/180/270) + script detection.**
Runs on the cropped, flattened page (cleaner input; boundary detection doesn't depend on orientation), before dewarping (dewarp models expect upright pages) and before any OCR.
Single-pass, language-independent: document orientation classifier (e.g. PaddleOCR/PaddleX PP-LCNet); Tesseract OSD (orientation + script + confidences); text-line detector (e.g. DBNet) for line direction.
Fallback only on low confidence/disagreement: OCR at all 4 rotations with the detected script's recognizer; pick by OCR confidence and valid-word ratio.

**6. Dewarping.**
Measure curvature first (text-line straightness); flat pages skip.
Candidates: two dewarping models (e.g. UVDoc and DocRes / DocTr family). Output includes an editable mesh.
Accept only if text lines become measurably straighter than without dewarping.

**7. Fine deskew.** ±10° from text-line angles / projection profiles.

**8. Restoration & cleanup.** Shadow removal, background whitening, contrast, deblur, wrinkle reduction (e.g. DocRes; classic background estimation + adaptive threshold as alternative). Variants: color, grayscale, B&W; default chosen per page content.

**9. OCR, two-pass.**
Pass 1: script-level recognizer (Cyrillic/Latin models, or `rus+eng`).
Language ID on the text (fastText LID and/or Lingua), per block for mixed pages.
Pass 2 with the exact language model only if language is confident and differs; keep the better-scoring pass.
Output: text with word boxes and confidences.

**10. Layout analysis.** Headings, paragraphs, tables, lists, images, handwriting regions; reading order; multi-column (e.g. PaddleOCR PP-Structure).

**11. Consistency check.** Low valid-word ratio (Russian/English dictionaries) despite high orientation/script confidence → reopen orientation and script, run fallback, downgrade tier.

**12. Outputs.** Searchable PDF (cleaned image + invisible text layer), plain text, structured JSON (blocks/words/boxes), thumbnails; index into search.

## 6. Organization: folders and tags
Folders and tags are independent, side-by-side systems, each fully usable on its own.

### 6.1 Folders
- Physical location: each document is in exactly one folder.
- Hierarchical tree in the UI sidebar: create, rename, move (drag and drop), delete (non-empty folders: confirm; contents go to Trash).
- One shared tree for everyone. Default "Inbox" folder for unsorted items; registered chats can target their own folders.
- Bulk move of documents.

### 6.2 Tags
- Many tags per document; colors; optional hierarchy (e.g. `finance/tax`).
- All tags shared by everyone.
- Tag panel next to the folder tree: click to filter; combine with AND / OR / NOT.
- Bulk tagging; tag rename and merge.
- Later: automatic tag suggestions.

## 7. Search
- Full-text over: OCR text, extracted text from PDFs and office files, filenames, titles, chat/email context, metadata (sender, chat, subject).
- Filters, combinable: folder (with/without subfolders), tags (AND/OR/NOT), date ranges (document date, received date), source, sender, chat, language, file type, review status.
- **Russian morphology is required**: searching one word form must find other forms (e.g. договор / договора / договору). Plus English stemming, ё/е normalization, typo tolerance, prefix search.
- Results show highlighted snippets; opening a result highlights hits on the page image using OCR word boxes.
- Performance: p95 < 100 ms per query; new documents searchable within seconds after processing.
- Recommended at this scale: PostgreSQL full-text search (russian + english configurations) plus pg_trgm for typo tolerance — no separate search server. Keep search behind an interface so a dedicated engine (e.g. OpenSearch with Russian analyzers) can replace it if needed.

## 8. Document viewer & pipeline editor
- Opening a document shows: page thumbnails (left), page view (center), pipeline panel (right).
- Pipeline panel lists every stage for the selected page with status and tier (OK / check / needs review).
- Every stage is editable:
  - Acceptance: document / non-document
  - Crop: drag 4 corners on the original image, magnifier while dragging, reset to auto, pick another candidate
  - Orientation: rotate buttons
  - Dewarp: toggle, choose candidate, drag mesh control points
  - Deskew: angle slider
  - Cleanup: color/gray/B&W, strength sliders
  - OCR: change language(s), re-run, correct text inline per block/word
  - Layout: adjust block boxes, change block type, change reading order
- View re-renders after each change: geometric edits preview instantly client-side; final render on the server in background.
- Upstream edits re-run downstream automatic stages; manual downstream edits are kept when still valid, otherwise the user is warned.
- Full edit history per page with undo/redo and "reset to automatic".
- Review queue: all flagged pages across documents, fast workflow (accept / pick candidate / open editor). No keyboard shortcuts.

## 9. Document tools
All operations are non-destructive (new version; originals kept; undo available). Pages keep their recipes and corrections when moved between documents.
- Images → PDF (chosen order)
- PDF → images (format and DPI selectable; per page or all)
- Merge documents
- Split: by page ranges, every N pages, or at selected pages
- Delete pages
- Reorder pages (drag and drop thumbnails)
- Rotate pages
- Copy or move pages to another document (existing or new)
- Extract pages into a new document
- Duplicate document
- Multi-select pages across documents for bulk operations
- Download: original, processed PDF, text, or ZIP of a selection
- PDF libraries must respect license constraints (e.g. pikepdf/qpdf, pypdf; avoid AGPL unless approved).

## 10. Data model (minimum)
- `user`, `role`, `session`, `api_token`, `audit_log`
- `connector_account` (bot accounts, session state, health), `registered_chat` (default folder/tags, context settings, mode)
- `ingest_event` (source, sender, time, location, context messages, forwarding info)
- `document` (title, folder_id, source ingest_event, document date, status, overall tier, current version, trashed_at)
- `document_version` (ordered list of page references)
- `file_original` (blob ref, hash, MIME, filename)
- `page` (original blob, source file + page index, current recipe version)
- `recipe` (versioned JSON per page: quad corners, rotation, dewarp method + mesh, deskew angle, cleanup params, OCR languages, manual text corrections, layout edits)
- `stage_candidate` (page, stage, method, params, score, signals, chosen_by auto/user)
- `correction_log` (page, stage, auto choice, user choice, scores)
- `folder` (tree), `tag`, `document_tag`
- `rejected_item` (with expiry)

## 11. Architecture & non-functional requirements
- Single server, Docker Compose deployment.
- Object storage: S3-compatible (e.g. MinIO) or local filesystem behind a storage interface. PostgreSQL for metadata and search.
- Job queue: Redis-backed (Celery or RQ), with priority queues (live ingest > user edits re-render > bulk backlog).
- Workers: CPU workers for classic CV and office conversion; one GPU worker process for ML models (models loaded once).
- Stages idempotent and individually retriable; results keyed by (page, stage, recipe version, pipeline version).
- Pipeline versioning: re-process old documents with new models without overwriting user-corrected steps.
- Each connector in its own container; failures isolated from the core.
- Daily backups of database and files, with a tested restore procedure.
- Monitoring: processing queue length, stage failures, connector health, disk usage (also drives the rejected-items storage rule).

## 12. Privacy & compliance (GDPR applies)
- Bots capture content from group members who are not service users. Capture only registered chats and only the context window, never full chat history.
- Rejected items deleted per retention policy; trash purged per policy.
- Support deletion requests: remove a document with all derived data, renditions, index entries, and context.
- Admin data export.

## 13. Evaluation & improvement
- Labeled test set, Russian-heavy (start ~200 pages: receipts, contracts, forms, handwriting, curved book pages, rotated, dark, glare, flat scans, mixed Russian/English, non-documents).
- Metrics: document/non-document accuracy, corner error, orientation accuracy, text-line straightness, OCR character error rate (Russian and English separately), search latency, % auto-accepted, % corrected by users.
- Regression tests on every model or threshold change.
- Use correction logs to tune fusion weights and thresholds first; fine-tune models later.