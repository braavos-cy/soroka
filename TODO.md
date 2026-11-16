# To do

What is left to build. Section numbers (§) refer to [requirements.md](requirements.md).
What is already built: [README.md](README.md) "Status". Pipeline measurements: [docs/pipeline-quality-log.md](docs/pipeline-quality-log.md).

## 1. Chat-first features (what sets Soroka apart)

**Decision needed first:** all three make the bot write in chats. The spec says the bots are fully silent
(§3.2, §3.3, §4.3), and for WhatsApp silence is what keeps the ban risk low. Proposed: build these for Telegram first
(official Bot API, no ban risk), and make WhatsApp replies an opt-in setting per registered chat, off by default.

- [ ] **Instant quality feedback in the chat.** Within seconds of a photo arriving the bot replies when the page
      should be retaken: blurry, glare, too dark, edge cut off, not readable. Uses the existing quality and
      acceptance checks. Needs a fast first pass (reply before the full pipeline finishes) and a per-chat on/off switch.
- [ ] **Automatic assembly of what people send.**
  - [ ] Several photos sent in a row by one person become one multi-page document, in sending order.
  - [ ] The same page photographed twice: keep the better shot, drop the other (not a byte-for-byte duplicate, so
        the existing hash dedup does not catch it).
  - [ ] Caption or the nearest context message becomes the document title.
  - [ ] Undo in the UI: split a wrongly assembled document back into separate ones.
- [ ] **Retrieval from the chat.** "Send me the lease", "the March electricity bill" → the bot sends the file back.
  - [ ] Search by text, date, sender, tag; when several match, offer a short list to pick from.
  - [ ] Access rule: who may ask (service users only? any member of a registered chat?) and what they may receive.
  - [ ] Works in the bot's private chat; in groups only when the bot is addressed.

## 2. Connectors

- [ ] **Telegram connector** (§3.3): official Bot API, self-hosted Bot API server for files over ~20 MB, same
      capture / context window / force-save / chat registration as WhatsApp. Setup notes: privacy mode off or bot is admin.
- [ ] **Email**
  - [ ] Browser extension for Gmail and Outlook web, Chrome + Firefox, Manifest V3 (§3.4): "Send to Soroka" on the
        email and on each attachment; authenticates with a scoped API token (tokens already exist).
  - [ ] Dedicated import address polled over IMAP (§3.4 "later").
  - [ ] Sender, recipients, subject, date and body stored as metadata / context; attachments from one thread kept together.
  - [ ] User-defined auto-import rules (§3.4 "later").

## 3. Automatic classification

Local models only: no paid or cloud APIs (§1.2).

- [ ] Document / non-document image classifier (§4.1) — chat screenshots with words are currently kept by design
      of the word rule.
- [ ] Use logged force-save overrides and rescues as training data (§4.3).
- [ ] Document type (contract, invoice, receipt, ID, letter…).
- [ ] Automatic tag suggestions (§6.2 "later") and a suggested destination folder.
- [ ] Document date extracted from the text.

## 4. Pipeline: ML models (GPU worker)

- [ ] GPU worker process with models loaded once (§11).
- [ ] PaddleOCR Cyrillic recognizer vs Tesseract, measured on a Russian test set (§5.2); keep the better one.
- [ ] Orientation classifier (PP-LCNet) and text-line detector (DBNet) as extra orientation candidates (§5.4 stage 5).
- [ ] Restoration models: shadow removal, deblur, wrinkle reduction (§5.4 stage 8).
- [ ] Layout analysis with PP-Structure: tables, headings, reading order, multi-column (§5.4 stage 10).
- [ ] Language ID with fastText / Lingua, per block — currently script-based, ru/en only (`pipeline/ocr.py`).
- [ ] Check whether the valid-word ratio in the consistency check uses real Russian/English dictionaries (§5.4 stage 11).

## 5. Pipeline: known gaps

From the quality log, "Known gaps / next steps":

- [ ] Dark, low-contrast, shadowed pages get rejected (2 of 40 on the hard set): add a "looks like a document but
      unreadable → review" signal instead of rejecting.
- [ ] Low-light + shadow pages read poorly (recall 0.55): stronger recognizer or a sharpening / deblur step.
- [ ] Non-documents cost up to two extra pipeline passes (2–8 s of CPU per wordless photo).
- [ ] Open-book photos and two-page spreads: detect, flag, then auto-split (§5.4 stage 3).
- [ ] Several documents in one photo: detect and flag (§5.4 stage 3).

## 6. Viewer and editor

- [ ] Inline OCR text correction per block / word (§8).
- [ ] Layout editing: block boxes, block type, reading order (§8).

## 7. Document tools (§9)

All non-destructive: new version, originals kept, undo.

- [ ] Merge documents; split by ranges / every N pages / at selected pages.
- [ ] Reorder, delete, rotate pages; copy or move pages to another document; extract pages into a new document.
- [ ] Images → PDF, PDF → images (format and DPI).
- [ ] Duplicate document.
- [ ] Versions UI.
- [ ] Multi-select pages across documents for bulk operations.

## 8. Security and operations

- [ ] WebAuthn / passkeys as a second factor (§2.3) — no backend support yet.
- [ ] Monitoring view: queue length, stage failures, connector health, disk usage (§11).
- [ ] Run the restore procedure once end to end and record the result (§11 "tested restore").
- [ ] Optional S3-compatible storage behind the storage interface (§11).

## 9. Evaluation (§13)

- [ ] Real-photo test set, ~200 Russian-heavy pages: curved pages, hands / fingers, glossy glare, spreads, chat
      screenshots, handwriting, receipts. The current sets are mostly synthetic.
- [ ] Ground truth for skew angle (deskew errors are invisible in OCR recall today).
- [ ] End-to-end test of the worker path (`process_page`, `finalize_document`), not only the stubbed eval.
- [ ] Regression run on every model or threshold change.

## Ideas, not planned

- Expiry and due dates extracted from documents, with reminders sent to the chat.
- Document sets with completeness tracking ("4 of 6 received, missing: …"), the bot chasing the missing ones.
- Positioning: "nothing leaves your server, including the AI" — already true because of §1.2.
