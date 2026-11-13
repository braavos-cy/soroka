# Pipeline quality work — log

Autonomous session, started 2026-11-14 00:57 (Cyprus time, EET). Goal: revisit every image-pipeline stage, build a
test set (EN/RU, 0/90/180/270, scanned / straight photo / angled photo, plus zero-text photos), measure, fix, re-measure.

## Timeline

- **00:57** — Read the whole pipeline (`backend/soroka/pipeline/{cv,ocr,runner,recipe,sources}.py`).
  First observations before measuring:
  - *Acceptance* is decided **before OCR** from cheap signals only (text-blob density 35 %, line count 15 %,
    boundary score 25 %, "not colourful" 25 %). A grey/beige photo with no text gets 0.25 for "not colourful" plus
    up to 0.25 for any quad-ish contour, and blob detection counts texture as "text lines" → lands in *uncertain*
    (≥ 0.30) instead of *non_document*. The document is only rejected when **all** pages are `non_document`,
    so "uncertain" documents are kept. OCR output (the strongest signal: zero real words) is never used for acceptance.
  - *Boundary*: only two quad detectors (Canny contour, Otsu threshold); full-frame fallback score is fixed;
    the Canny detector returns the first 4-point approximation of the biggest contour, which is often the text block
    or a background object rather than the page.
- **01:00** — Built the evaluation tooling (`backend/eval/`): `make_testset.py` (reproducible synthetic set),
  `run_eval.py` (runs the real `runner._process_image_page` with DB/storage stubbed out, scores every stage),
  `debug_one.py` (dumps all stage records for one image). Commit `7165a81`.
- **01:04** — Test-set bug found while debugging a 3 % word recall: the Caladea font has no Cyrillic glyphs, so
  Russian text rendered as boxes. Removed it. Added two harder capture modes that match the complaints:
  `lowcontrast` (page on a light desk) and `cluttered` (other objects around the page).
  Set: 2 languages × 5 captures × 4 rotations = 40 documents + 16 zero-text photos (landscape, people, desk,
  blank sheet, wall, dark shot, colour noise, wordless UI screenshot).
- **01:07** — **Baseline** (pipeline as of `7318095`):

  | metric | baseline |
  |---|---|
  | documents kept | 39/40 |
  | zero-text photos rejected | **6/16** |
  | orientation correct | 32/40 |
  | crop IoU ≥ 0.9 | 26/40 (scan 6/8 — table grid chosen as page; lowcontrast 0/8 — falls back to full frame; cluttered 1/8) |
  | OCR word recall | 0.79 |
  | time / image (4 in parallel) | 20.8 s, worst 192 s (orientation fallback = 4 full OCR runs) |

  The 10 kept non-documents all ended as `uncertain` (score 0.33–0.51) — and `uncertain` is never rejected.
- **01:08** — **Acceptance fix** (`c592df1`). The final accept/reject decision is now made *after* OCR from the
  number of real words (one script, ≥ 3 letters, has a vowel, confidence ≥ 60; long numbers count ½):
  ≥ 10 → document, ≤ 2 → non-document (unless strongly text-structured → uncertain), else by the old score.
  Zero-text photos rejected **6/16 → 16/16**, no document lost.
- **01:09** — **Boundary rewrite** (`e3334fa`). Key idea: score candidates on *evidence of a page edge* — edge
  support per side + colour contrast between just inside and just outside each side, measured on a text-free view
  (morphological closing removes text and table lines, LAB colour). A table inside a scan has paper on both sides
  → no contrast → loses to the full frame. More candidate generators (Canny on every LAB channel at two
  sensitivities, paper-likeness threshold). Also found `quad_iou` returned IoU > 300 for non-convex quads
  (OpenCV `intersectConvexConvex` misuse) → rasterized fallback. Crop ≥ 0.9 IoU: 26/40 → 36/40.
- **01:11** — **GrabCut + erosion separation** (`0a920bb`). GrabCut on a 360 px copy seeded by the
  paper-likeness map separates white paper from a light/tinted/textured desk where edges are too weak; masks are
  eroded until the page separates from a touching bright object (another sheet) and the quad pushed back out.
  Lowcontrast 4/8 → 7/8, cluttered → 8/8. Crop 39/40, word recall 0.97.
- **01:13** — **Orientation** (`8209dd8`): discovered that in the 4-rotation OCR fallback Tesseract reads *sideways* text
  as well as upright text — 0° and 270° got identical scores (0.929) and the tie went to 0°. The fallback now
  only compares the two rotations on the axis given by the text-line direction. The line-direction estimator
  itself was replaced (projection profiles were confidently wrong on receipts/tables because of column structure)
  by a nearest-neighbour-character direction vote, which got the axis right on 40/40 pages.
- **01:15** — Result on set 1: kept 40/40, rejected 16/16, orientation 40/40, crop 40/40 (mean IoU 0.985),
  word recall 0.998, 4.4 s/image. The set is saturated → building a harder, unseen set (different seed) next.
- **01:17** — **Hard set** (`--hard --seed 11`, never used for tuning before this point): cast shadows, low light,
  0.55–0.75× resolution, more blur, heavier JPEG, scans skewed up to ±4°, plus brick-wall and striped-fabric
  non-documents (regular dark lines that look like text lines). Current code: orientation only 28/40, crop 35/40,
  2 brick walls kept.
- **01:20** — **Orientation, round 2** (`eb45db0`). Two more root causes:
  1. OSD / line direction / fallback OCR ran on the raw photo. On dark or shadowed pages OSD returned nothing and
     the fallback OCR found **0 words in every rotation** (while the final OCR, which runs on the cleaned image,
     read 217 words). They now get a background-normalized grey page.
  2. Tesseract's layout analysis reads sideways text (vertical-text path): an upside-down page scored 0.907 at
     270° — i.e. text read in the wrong axis with 93 % confidence. Words read that way have boxes taller than
     wide → the fallback score is multiplied by the share of horizontally-read words.
  3. The nearest-neighbour line direction fails on low-resolution photos (letters merge into words): 8 confident
     wrong axes. Added a second vote — length of thin elongated blobs after a horizontal closing at 1.5× the
     character height, vs. the same on the transposed image — combined by geometric mean. 0 wrong on both sets.
  Hard-set orientation 28/40 → 39/40.
- **01:25** — **Shadows vs. crop** (`e142c58`). Remaining crop failures were all cast shadows: region detectors
  (threshold, GrabCut) follow the shadow edge and cut the page in half. Added a straight-line (Hough) quad
  generator on the text-free view and an *edge sharpness* test per side (peak gradient ÷ colour step: paper edge
  ≈ 0.22–0.53, synthetic shadow ≈ 0.13–0.16) — soft sides give no contrast evidence. Hard-set crop 35 → 38/40.
- **01:28** — Found a new failure mode created by the stricter acceptance: when the crop is wrong, OCR finds no
  text and the page is **rejected** (2 documents on the hard set). First attempt — OCR the whole uncropped photo
  before rejecting — failed: Tesseract finds 0 words on a full textured photo where the page is small, and takes
  27 s on a noisy wall. Replaced by (`da2b844`): before rejecting, re-run the page with up to two *different*
  boundary candidates (IoU < 0.8, score ≥ 0.45); the first that yields text wins. Also brick walls: the
  "unreadable text-like → uncertain" escape now needs OCR to have seen ≥ 20 tokens. Hard set: rejected 20/20.
- **01:36** — Pipeline version → 1.1 (`7446df5`) so reprocessing picks up the changes.
- **01:40** — The softness rule also discarded a real low-contrast receipt edge on set 1 (step 14). Shadows give
  large steps (37–58), so the rule now needs a step > 20 (`a2039d2`). Set 1 back to all-pass.

## Results

Same harness, same images; "before" = commit `7318095`, "after" = `a2039d2`.

| | set 1 before | set 1 after | hard set before | hard set after |
|---|---|---|---|---|
| zero-text photos rejected | 6/16 | **16/16** | 7/20 | **20/20** |
| documents kept | 39/40 | **40/40** | 40/40 | 38/40 |
| orientation correct | 32/40 | **40/40** | 28/40 | **38/40** |
| crop IoU ≥ 0.9 | 26/40 | **40/40** | 24/40 | **38/40** |
| mean crop IoU | 0.78* | 0.986 | 0.76 | 0.962 |
| OCR word recall | 0.79 | **0.997** | 0.59 | **0.845** |
| s / image (4 parallel) | 20.8 | 5.3 | 4.2 | 8.0 |

\* the original `quad_iou` returned 386 for one non-convex quad; counted as 0 here.

Hard set per capture type after: scan 8/8 everything; photo / angled / cluttered: orientation 8/8, IoU ≈ 0.98;
lowcontrast (light desk + shadow + low light) is the weak spot: 6/8 orientation, recall 0.55.

## What mattered most

1. **Acceptance must use OCR.** The pre-OCR heuristic cannot tell a beige wall from a page; "found no real words"
   can. This was the user-visible bug (zero-word photos not rejected) and it is a ~40-line fix.
2. **Score boundary candidates on evidence of an edge, not on shape.** Inside-vs-outside colour contrast on a
   text-free view is what separates the page from a table inside it, from the desk, and (with sharpness) from a
   shadow. More generators only help once the scoring can reject their bad proposals.
3. **Tesseract reads sideways text.** Any "OCR in 4 rotations and pick the best" scheme is broken without a
   check of the reading direction (word-box aspect) and an independent axis estimate.
4. **Feed estimators the normalized image.** OSD and quick OCR on the raw dark/shadowed photo silently fail.
5. **Fail safe.** Stricter rejection turns every upstream error (wrong crop) into a lost document; the retry with
   alternative crops is what keeps that in check.

## Known gaps / next steps

- 2/40 hard-set documents are still rejected: dark, low-contrast, shadowed Russian pages where every boundary
  candidate is wrong and OCR on them is empty. They go to the rejected area (retention), not deleted. A
  "document-like but unreadable → review" signal (text-blob density after a correct crop) would catch them.
- Low-light + shadow pages: recall 0.55. Next: shadow removal before OCR (the cleanup's background division
  helps but its kernel is small), and a second OCR pass at a higher upscale for small text.
- Non-documents now cost up to two extra pipeline passes (alternative crops): ~2–8 s of CPU per wordless photo.
- The test set is synthetic. Real photos (curved pages, hands/fingers, glossy glare, multi-page spreads, chat
  screenshots with words — which this pipeline will *keep*, by design of the word rule) must be added:
  drop real images + a `manifest.json` in the same format into a folder and run `run_eval` on it.
- Deskew and cleanup were reviewed but not changed: on the sets their errors are invisible in OCR recall
  (scans skewed ±4° read at 0.99). No ground truth for skew angle is recorded yet.
- The eval runs `_process_image_page` with DB/storage stubbed; the worker path around it (`process_page`,
  `finalize_document`) is unchanged and was not exercised end-to-end in this session (production stack not
  touched; nothing pushed — pushing `main` auto-deploys).

## How to reproduce

```sh
cd backend
docker run --rm -u $(id -u) -v $PWD:/app -w /app soroka-backend python -m eval.make_testset eval/data
docker run --rm -u $(id -u) -v $PWD:/app -w /app soroka-backend python -m eval.make_testset eval/data_hard --seed 11 --hard
docker run --rm -u $(id -u) -e TESSERACT_THREADS=1 -v $PWD:/app -w /app soroka-backend \
    python -m eval.run_eval eval/data -j 4 --out eval/results/run.json
# diagnostics: python -m eval.debug_one IMG | python -m eval.debug_crop OUT_DIR IMG... | python -m eval.check_linedir DIR
```
