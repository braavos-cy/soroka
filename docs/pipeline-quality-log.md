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

- **01:44** — *Negative result:* upscaling small pages to 2000 px before cleanup/OCR (hypothesis: x-height too
  small for Tesseract) made recall **worse** (hard 0.845 → 0.822, set 1 0.997 → 0.991). Reverted, not committed.
- **01:48** — *Cleanup A/B* (`eval/ab_cleanup.py`, ground-truth crop + rotation, so only the OCR input differs):
  current cleanup 0.797 · background division without contrast stretch 0.784 · softer stretch 0.780 ·
  raw grey 0.505. Background division is essential (+0.29); the stretch is fine. The remaining recall loss on
  the hard set comes from the source blur / resolution, not from cleanup → left unchanged.

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

## 2026-11-14 — crop: trim leftover background, don't cut through text

Triggered by a real 199-page upload (photos of a thick case file / bound pages on a desk). Two crop errors:

- **Desk left inside the crop** (pages 25, 28, 29, 34, 38, 46, 60, 66, 72, 76…): a dark strip of desk along the
  top or bottom edge. New `cv.refine_quad` runs after boundary detection: per side, in the text-free view, it finds
  how deep a band of non-paper colour (compared with the paper just inside that side) reaches from the edge, fits a
  robust line through the per-column depths (slanted wedges are handled) and moves the two corners in.
  It stops at the first clean paper row and is capped at 8% per side, so it never cuts into the page.
  Columns that never reach clean paper inside the cap are ignored: that is a cast shadow, not a band — without this
  rule 8/80 exact crops were cut too deep (all shadows), with it 2/80.
  Check (`eval/check_refine.py`, crops loosened by 1–5%): mean IoU 0.910 → 0.986, 64 improved, 0 worse;
  exact crops stay at 0.998.
- **Crop line running through the text** (pages 65, 70, 74, 82, 83): a Hough line from a page lower in the stack
  paired with three real edges. One weak side was tolerated, so it scored 0.9. New check: for a side with no
  edge and no colour step, compare ink (thin dark strokes) just outside and just inside; if text continues outside
  the crop cuts the page (score ×0.7). Two evidence-free sides → ×0.6. A ×0.55 penalty was too strong: it pushed
  correct candidates below the 0.45 rescue cut-off. Checking text running *along* a side (to catch page 36, whose
  bottom side follows the last text line) was dropped: a receipt's dark paper edge looks the same.
- Eval: hard set unchanged (same 3 failures as before); set 1 loses one low-contrast receipt
  (its only correct-looking candidate does cut the last lines; earlier it won by luck through the rescue).
- Known gap: page 36-type crops (side follows a text line on a page lying on more pages) are still too tight.

## 2026-11-14 — deep desk bands; open-book photos (known gap)

- Page 18 of a real 199-page upload: the chosen quad's bottom side ran ~10% below the page, through the desk.
  The edge trim ignored it on purpose (no clean paper within 8% = treated as a shadow). New: a second pass looks
  further in (25%) for a band that is solidly unlike paper, ends in a sharp step, is deep at both ends of the
  side and contains no text; only then it is trimmed. Tried and rejected on the way: a brighter far paper sample
  for all trimming (trimmed shaded margins on 98 pages), deep trims without the text check (cut text on open-book
  pages), wedge-shaped deep trims (dark cast shadows in the hard set). Result: on the 199 pages only page 18
  changes; eval sets unchanged.
- Known gap: photos of a bound / open book (pages ~60–199 of that upload): several crops still have a slanted
  side through the text (e.g. 60, 71, 81, 96, 158, 159, 177, 189) or include the facing page / desk (86, 87, 161,
  163, 183, 185–191, 196). Checking "text continues beyond the side" on every side was tried: it fixed a few and
  broke more (the facing page has text too, so correct sides were penalized). Needs a different approach:
  page-vs-facing-page separation (gutter/fold detection) or a learned page segmenter.

## 2026-11-14 — page outline (MobileSAM) + flattening (UVDoc), editable

- Compared on 10 problem pages (open bound case file, a page from the phone app as reference): MobileSAM
  prompted with points on the text block finds the page far better than the classic detector; of four ways to
  flatten (4 corners, UVDoc on the whole photo, UVDoc on the masked photo with or without a crop, Coons patch of
  the mask edges) the user picked "mask -> UVDoc, cropped first". The Coons patch was rejected (mask edge wobble
  becomes wavy text).
- Production: models exported to ONNX at image build (no PyTorch in the app). Outline cleaned (largest region,
  holes, spurs, smooth edge, strongly coloured spill removed); finger notches filled with paper colour.
- Gates, found by measurement: (1) flat photos keep the exact 4-corner crop: UVDoc on flat angled test pages cost
  ~2-5% word recall; the outline's bend separates them (flat <= 1.6% of the diagonal, books 2-12%, threshold 1.8%).
  (2) whole-frame scans skip the outline: MobileSAM outlines the text area there (crop IoU fell to 0.13-0.8).
  (3) a coloured object touching the page made the outline look curved: colour spill removed before measuring.
- Mesh editing: UVDoc's 45 x 31 grid sampled to 11 x 8 control points (visually the same result; a Catmull-Rom
  spline reproduces the full grid within 2/255 - OpenCV's cubic remap did not: 18/255).
- Results: eval sets unchanged (scan/flat paths identical); 199 real pages: book pages cropped tight and
  flattened, 4 pages without a usable outline keep the old crop, 0 errors. +1.5-2 s per photo.
- Not done: the phone app's crisper "scan look" (white page / black text) and a second UVDoc pass were tried on
  one page and help visually; not in production.

## 2026-11-15 — flattening: SyntheticDoc replaces UVDoc; crop / flattening choices per page

- Compared on 20 pages of the real 199-page case file (12 hard: book spreads, fingers, rotated, no outline;
  8 random), each model on the raw photo and on our outline crop; score = words Tesseract (rus) reads with
  confidence >= 80. Totals: SyntheticDoc high-res + shading (crop) 3399, PaperEdge (raw) 3144, SyntheticDoc
  without shading 3007, DocScanner 2995, DocTr 2965, UVDoc (crop, the previous default) 2941, DocGeoNet 2825,
  no flattening 2765. SyntheticDoc + shading was better than UVDoc on 17 of 20 pages, worse on 1; most of its
  gain comes from the shading correction (divides out the predicted lighting; it cannot add content).
  DocRes (generalist restoration) was too slow on CPU (~3 min per step) and looked over-processed.
- SyntheticDoc (MIT, ECCV 2026, same network as UVDoc + a shading decoder): both released checkpoints exported to
  ONNX at build time (checksums pinned): low 720x512 -> 31x45 map (~1 s/page), high 1440x1024 -> 121x177
  (~4 s/page). Matches the reference PyTorch output within 0.4/255 after two fixes: the model input is downscaled
  with PIL bilinear (antialiased, as in training) and the coarse map is upsampled with exact interpolation
  matrices (cv2.remap quantizes sample positions to 1/32 of a cell -> visible wobble, 5-13/255 error).
- Automatic choice unchanged in spirit: curved pages (outline crop) -> high-res + shading; flat pages / scans -> none.
- Editable per page: crop 4 corners | page outline | no crop (the other mode's points are kept); flattening
  none | low | high, shading on | off, mesh hand-edited (11x8 control points; replaces the model's map, the model
  still provides shading; choosing a model drops the hand edit). Recipes from the UVDoc version migrate on read.
- Eval sets: normal set unchanged (39/40, 16/16, crop 39/40, recall 0.973); hard set 38/40 kept (was 37/40),
  recall 0.838 (was 0.819). E2E with real DB/worker: 39/39 checks; browser: 20/20 (incl. "Original" hold-to-compare).
- Known: an 11x8 hand-edited mesh cannot carry all the detail of the 121x177 model map (mean 18/255 difference
  vs the full map on a book page), so editing starts from a smoothed version of the model's flattening.

## 2026-11-15 — order of tools (orient / crop / flatten / deskew / cleanup): study, no change

Question: is another order (e.g. flatten first, then crop) or other tool settings better than production
(crop → flatten curved pages → orientation → deskew → cleanup)? Each tool was run in isolation as an
image → image step; final image OCR'd with the production call (rus+eng, PNG). Score = confident words
(conf >= 80, alphabetic, >= 3 letters) on real pages; word recall vs ground truth on the synthetic sets.
Equal scores broken by line straightness from the OCR word boxes (median |angle| and bow per line).

- Real pages: 20 pages of the case file (12 hard: book spreads, fingers, rotated; 8 random; p005 is sideways
  handwriting, uninformative). Phase A: every order of every subset of the 5 tools (326 pipelines). Phase B:
  settings grid on 3 orders (crop auto/quad/mask x flattening auto/low/high/±shading/shading only x cleanup
  auto/gray/color/bw, 217) + the real production runner. Phase D: both again with a page-validity metric.
- **OCR alone is fooled.** "orient → cleanup → crop → flatten-low → deskew" ranked first (15/4 wins vs
  production, p=0.02), but cleanup makes the crop detector find nothing (crop is a no-op on 15/20 pages), and
  the low-res model does not crop by itself: the outputs were the whole photo — desk, hands, page stack — and
  Tesseract reads past the clutter. Added a page-ness gate: largest MobileSAM mask holding the text must fill
  >= 90% of the output (cropped pages 0.93–1.0, uncropped photos 0.65–0.85; one false negative: a mostly blank
  page). Scores below are gated.
- **Production ranks 7 of 284 (norm 0.949) and has the best worst case** (worst page 0.87 of that page's best;
  1 page < 0.90). The 6 above it are +0.5–1.1%, none significant (best: 10 wins / 8 losses).
- **Flatten first works only with the high-res model**, which then segments the page itself: orient →
  flatten-high+shading on the uncropped photo → deskew → cleanup = 2981 words vs production 2982. Visibly
  straighter on strongly curved book pages (p191: 199 vs 187 words), but sometimes keeps a fingertip.
  Low-res on the uncropped photo never yields a page (fill 0.6–0.85).
- **Crop first + always flatten loses** (2797): flattening an already flat, quad-cropped page distorts it
  (p027: 73 vs 189). Production's "flatten only curved pages" gate is what avoids this.
- **Cleanup before or after crop/flatten: a tie when the crop really runs** (mask crop: 8/8, 9/9 wins/losses).
  The apparent "cleanup first" gain was entirely the skipped crop.
- Ablation (best order per tool set): without flattening the curved pages lose most; without orientation the
  rotated pages are lost; cleanup adds ~2–3%. Orientation must come first (rotated pages: crop/flatten on a
  sideways page fail — p014 crop→flatten gave 1 word).
- Settings (marginal means): flattening low ≈ high on cropped pages; shading-only (no geometry) is worst;
  cleanup auto = color ≈ gray > bw.
- Synthetic sets (40 normal + 19 of 40 hard documents, ground-truth recall; stopped early): production is
  first of 77 by a wide margin (0.975 vs 0.899; hard 0.891 vs 0.563), also on upright images — the isolated
  tools lack production's fallbacks (alternative crops, acceptance gates). Forced flattening hurts these flat
  pages (0.90 → 0.71–0.77). So the synthetic sets cannot rank orders; they show the fallbacks matter more.
- **Decision: no change.** Possible follow-up (not done): for strongly curved pages, offer flattening the
  uncropped photo with the high-res model (straighter, same OCR), with a finger/background check.

## 2026-11-25 — crop mode: why the outline is chosen and how to choose; several outline runs (consensus)

Two questions: (1) why do some pages get the page-outline crop (MobileSAM mask + flattening) and others the
4-corner crop, and how to choose better; (2) does running the outline several times and keeping the intersection
(or another consensus) give a better outline?

**Production data (1992 image pages in the DB).** 547 scans (no outline by design), 156 photos without an
outline (no text block 74, no plausible mask 81, area 1), 1258 with an outline. Of these, 1070 (85%) passed
`bend >= 0.018` and got the outline crop; 188 got the 4-corner crop. Bends of outlined pages: 2.5 / 25 / 50 / 75 /
97.5 percentiles 0.009 / 0.026 / 0.037 / 0.052 / 0.091 — one broad distribution, no flat / curved groups for a
threshold to separate. Neighbouring pages of
the same upload flip mode in 135 of 1066 pairs (12.7%); 15 multi-page uploads mix both modes. Crop corrections in
the correction log: 7 × outline → 4 corners (5 of them with hand-drawn corners, i.e. the automatic corners were
wrong too), 2 × 4 corners → outline (one at bend 0.011, just under the threshold).

**Why (answer to 1).** `outline_bend` is the *largest* distance of any outline point from the 4-corner frame. On
real photos of the case files that maximum is set by outline noise — an index tab or the edge of the pages
underneath, a finger notch, a dog-eared corner — not by the page's curvature (p1707: a flat page, median point
distance 0.0001, bend 0.024 from one kink at the stack edge). So the mode is decided by noise around 0.018, and on
a flat page it is close to a coin toss. The threshold came from synthetic flat photos (bend ≤ 0.016), which have
no such noise.

**Study set.** 96 real pages from 73 uploads, stratified by bend (22 below 0.018, 26 in 0.018–0.03, 26 in
0.03–0.05, 22 above). Paths, each finished with orientation → deskew → cleanup and OCR'd with the production
call: Q = 4-corner crop (detector + edge trim); QF = Q + flattening (high + shading); QM = 4-corner crop from the
outline's corners, no flattening; M0 = outline crop, no flattening; M = outline crop + flattening (production's
outline path); M_maj / M_inter = M with the majority / intersection outline of 10 runs. Score = confident words
(conf ≥ 80, ≥ 3 letters); "gated" = 0 when the output is not a page (MobileSAM page fill < 0.9, as in the order
study: the output still shows desk / facing page). "Oracle" = the better of the paths per page.

- **The 4-corner detector misses the page on these photos far more often than the outline does.** On the 96
  pages it returned the whole frame on 31, and the facing page / desk on several `paper_edges` results (outline
  agreement ≈ 0.65). Agreement IoU(4-corner crop, outline): quartiles 0.79 / 0.89 / 0.94. Visual checks (p2003,
  p3036, p5579, p5598, p1882): where they disagree, the outline is right and Q keeps desk strips, a sliver of the
  page below, or the facing page.
- Totals (gated / raw): Q 7657 / 11513, QF 9259 / 9259, QM 11315 / 11495, M0 7815 / 11346, **M 12581 / 12670**.
  M vs Q: 64 better / 11 worse (gated), 46 / 15 (raw). Flattening + shading matters even on "flat" handheld
  pages: QM loses to M on 49 pages, wins on 11; flattening a 4-corner crop (QF) mostly hurts, as found before.
- Decision rules (gated words as share of the per-page best; bootstrap 95% interval; pages vs production):

  | rule | share | pages below 0.9 | vs production |
  |---|---|---|---|
  | production: bend ≥ 0.018 → outline | 0.860 [0.80–0.92] | 24 | |
  | always 4 corners | 0.576 | 49 | +11 / −51 |
  | always outline + flattening | 0.946 | 15 | +13 / −0 |
  | robust bend (smooth per-side bow) < 0.02 → corners from outline | 0.922 | 22 | +10 / −8 |
  | text-line curvature of the 4-corner crop < 0.1 → corners from outline | 0.943 | 18 | +15 / −5 |
  | **4 corners if agreement ≥ 0.97, or ≥ 0.95 with bend < 0.018; else outline** | **0.949 [0.92–0.97]** | 14 | **+13 / −3** |

  Raw (ungated) the differences shrink (production 0.939, new rule 0.946, +5 / −4): OCR reads past desk strips,
  so the gate is what shows the wrong crops. Higher bend thresholds only make it worse (0.03: 0.75; 0.05: 0.57).
- On the synthetic test photos a correct flat 4-corner crop agrees with the outline at 0.952–0.99 (the outline sits
  ~1% inside the page edge, see below), all with bend < 0.018. Agreement ≥ 0.97 alone sent
  `doc_en_angled_letter_r90` to the outline and flattening cost it 31% recall; the "≥ 0.95 and straight" arm keeps
  those on the exact crop.

**How to choose (answer to 1).** Don't ask "is the outline bent?", ask "do the two independent crops agree?". If
the 4-corner crop and the outline agree, the corners found the page and it is flat → exact 4-corner crop. If they
disagree, either the corners missed (the usual case on these photos) or the page is curved; both are handled by
the outline + flattening. Implemented on local branch **`crop-choice-agreement`** (commit `3b01958`, not merged,
not pushed — pushing `main` deploys): `pagemodel.outline_agreement`, `AGREE_FLAT = 0.97`,
`AGREE_FLAT_STRAIGHT = 0.95`; the crop record keeps `bend` and adds `agree`. On the 96 pages it uses the outline on
84 (bend rule: 74; the sample over-represents low bends), and the choice no longer depends on outline noise.
Synthetic sets with the branch: normal set identical (39/40, 16/16, crop 39/40, recall 0.973); **hard set kept
38 → 39, orientation 38 → 40, crop IoU ≥ 0.9 37 → 39, recall 0.838 → 0.864** — the pages fixed are the dark
low-contrast Russian pages listed below as a known gap (every 4-corner candidate was wrong; the outline was right).
+0.6 s / image on the hard set (more pages flattened).

**Several outline runs (answer to 2).** MobileSAM is deterministic, so "several runs" = 10 differently prompted /
scaled / flipped runs per page: production prompts, centre, wide spread, 4 random 5-point sets inside the text
block, horizontal flip, input 768 and 1400 px. Consensus outlines: intersection (all runs), ≥ 80%, majority,
union; "trimmed" = after dropping runs with IoU < 0.9 to the majority; a text-protected intersection (never removes
an area with text); a robust per-side fit (Tukey-weighted polynomial per side, ignores spurs and notches).

- Synthetic photos with ground truth (45): MobileSAM is already very precise (share of mask on the page 0.9999);
  the only error is a slight under-coverage at the edges (recall 0.988). Mean IoU: production 0.9886 / 0.9879
  (normal / hard), majority 0.9885 / 0.9875, **intersection 0.9839 / 0.9823 (worst)**, ≥ 80% 0.9872 / 0.9863,
  union 0.9922 / 0.9910. Growing the production outline by 1 px at the 1000-px working scale: **0.9941 / 0.9938**
  (2 px 0.993, 3 px 0.987).
- Real pages: the runs agree — on 71 / 96 pages all 10 are within IoU 0.9 of their majority; production vs
  majority mean IoU 0.993. Text cut away (pages losing > 1% of their text pixels): production 9, majority 11,
  **intersection 37 (8 lose > 5%)**, trimmed intersection 27, ≥ 80% 17, text-protected intersection 12.
- Outcome after flattening: M_maj vs M: 12 better / 14 worse; M_inter vs M: 15 / 20; totals within 0.3%.
  "Majority only when the runs disagree" (stability < 0.97): 0.944 vs 0.949 — no gain. Always-intersection 0.952
  (+28 / −22 pages vs production: churn, not a gain). Cost: +4 encoder and +9 decoder passes ≈ 3–5 s per page.
- Visual review of the 16 pages where the consensus differs: the remaining real errors are **systematic** — the
  outline runs onto index tabs or the edge of the stack underneath, and every run does it. Voting removes random
  errors, not shared ones. The intersection does pull the edge in from tabs on some pages (p1750, p1829, p1895,
  p1907, p1929) but cuts into text whenever one run is wrong (p1811, p1973, p5574, p5643, p7091). The union adds
  desk and stack. One real rescue: p1750, where the single run had notches and the flattening bent the page
  (48 words) and the majority outline gave a clean page (146) — rare enough to be outweighed elsewhere.
- Robust per-side fit: smooth edges (perimeter / hull 1.02 vs 1.08), text cut 7 pages vs 9, synthetic 0.9897 —
  but visually 2 better / 5 worse of the 8 pages it changes: the corners come from the same spilled outline, so a
  wrong corner makes a diagonal cut through the page corner. Rejected in this form.

**Answer to 2: no** — intersection is the worst variant (cuts text, shrinks the edge), and majority / trimmed
variants equal a single run at 3–5 s extra per page. Not implemented. What would help instead: (a) grow the
outline by ~1 px at the working scale (systematic edge loss, synthetic evidence only; not implemented);
(b) remove the shared spill with independent geometry — robust straight-line fits to the outline sides (RANSAC)
to place the corners, then the per-side smooth fit; or re-prompt MobileSAM with negative points on detected tabs /
a box prompt from the agreed corners.

Scripts (scratchpad, not in the repo): `exp.py` (paths + features), `masks.py` / `realeval.py` / `sidefit.py`
(consensus), `qm.py`, `analyze4.py`.

### Follow-up: area first, then the regular 4-corner crop inside it

Idea: take the MobileSAM outline as the region (optionally grown a little), run the normal 4-corner detector only
inside it, and warp to that quad. Two ways to restrict the detector were tried, each with the outline grown by
0 / 1 / 3% of its diagonal:
- **select**: the detector's candidates on the unchanged photo; the best-scoring one lying ≥ 97% inside the grown
  outline and covering ≥ 85% of it; none → the outline's own 4 corners (refined), i.e. path QM.
- **paint**: everything outside the grown outline painted with the background colour found just outside it, then
  detector + refine on that image (full frame not allowed).
Plus a guard against quads that cut the page diagonally when the page fills the photo (the "inside" test is then
almost free): the inner quad must overlap the outline (IoU ≥ 0.9), else QM. OCR-scored at 1% growth with the select
method: S (no flattening), SF (+ flattening), and QMF (outline corners + flattening) for reference.

**Synthetic (IoU with the true page, 23 normal / 22 hard photos that get an outline):**

| crop | normal | hard (mean / min) |
|---|---|---|
| Q (detector, production) | 0.983 | 0.904 / 0.001 |
| QM (outline corners) | 0.966 | 0.955 / 0.906 |
| select, outline +0% | 0.982 | 0.969 / 0.911 |
| **select, outline +1%** | **0.983** | **0.976 / 0.911** |
| select, outline +3% | 0.983 | 0.975 / 0.898 |
| paint +0 / +1 / +3% | 0.980 / 0.986 / 0.983 | 0.948 / 0.934 / 0.970 (min 0.37–0.59) |
| paint +1%, guarded | 0.986 | 0.976 / 0.912 |

As a 4-corner crop, area-first is the best one: it keeps the detector's precision where the detector is right and
never takes the whole frame or the facing page. Growing the area helps a little (+0% leaves 48 / 96 real pages with
no candidate inside, +1% 35, +3% 26); 1% and 3% are equal. Paint is erratic unguarded: when the outline touches the
frame there is no background left, and the detector latches onto the text block.

**Real pages (96, gated confident words):** the S quad came from the detector's chosen quad on 29 pages, from another
detector candidate inside the area on 11, and from the outline corners on 56.

| path | total | vs |
|---|---|---|
| Q (detector) | 7657 | |
| QM (outline corners) | 11315 | |
| **S (area-first quad)** | **11519** | vs Q 38 better / 10 worse; vs QM 15 / 4 |
| M (outline + flattening, current) | 12581 | S vs M 15 better / 45 worse |
| SF (area-first quad + flattening) | 8166 | vs M 2 / 84 |
| QMF (outline corners + flattening) | 7902 | vs M 2 / 84 |

Rules, share of the per-page best of all 10 paths [95% CI] (this oracle has more paths than the one above, so the
shares are lower):

| rule | total | share | vs branch rule |
|---|---|---|---|
| production (bend) | 11429 | 0.848 [0.78–0.91] | −1183 |
| **branch `crop-choice-agreement`** | **12612** | **0.936 [0.91–0.96]** | — |
| always outline + flattening | 12581 | 0.934 | −31 [−229..+110] |
| branch rule with S in place of Q | 12568 | 0.933 | −44 [−122..+26] (+2 / −4 pages) |
| S if straight (bend < 0.018), else outline + flattening | 12341 | 0.916 | −271 [−578..−34] |
| S always | 11519 | 0.855 | −1093 |
| SF always | 8166 | 0.606 | −4446 |

A relative guard (accept the inner quad if its overlap with the outline is within 0.02 of the outline corners' own
overlap; even the outline's own corners overlap a bent outline only 0.84–0.9) changes 12 pages both ways, net +1
word.

**Why it does not win on real pages:**
1. Most real pages are bent (74 of 96 have bend ≥ 0.018), so the crop has to be followed by flattening, and the
   flattening model needs the masked outline crop as input: flattening a perspective-warped quad crop loses a third
   of the words (SF 8166, QMF 7902, QF 9259 vs M 12581; 84 of 96 pages worse). So the better quad only matters on
   flat pages.
2. Even on the 22 flat-ish pages (bend < 0.018) the outline crop with flattening reads slightly more (3832 vs S
   3592; Q 2680): the flattening also corrects the residual perspective and shading.
3. Where the area-first quad is a different candidate from the detector's own choice (11 pages), it beats Q
   (1611 vs 1098) and QM (1499) and ties M (1585). That is exactly the case the branch rule already sends to the
   outline.

**Answer: not adopted.** Area-first is the best *4-corner* crop measured (synthetic hard set 0.976 vs 0.904 for the
detector), and if a no-flattening mode is ever needed (e.g. a "fast" setting, or flattening switched off by the
user), it is the crop to use: outline grown 1%, detector's best candidate inside it, outline corners as the
fallback. For the default pipeline the branch rule (detector quad when it agrees with the outline, else outline +
flattening) stays better, because the flattening only works on the outline crop.

Scripts (scratchpad): `qim.py` (variants, synthetic geometry, real quads + overlays), `qim_ocr.py`, `qim_rel.py`,
`qim_an.py`, `analyze_qim.py`.

## Known gaps / next steps

- 2/40 hard-set documents are still rejected (1/40 with branch `crop-choice-agreement`, see 2026-11-25): dark,
  low-contrast, shadowed Russian pages where every boundary candidate is wrong and OCR on them is empty. They go to the rejected area (retention), not deleted. A
  "document-like but unreadable → review" signal (text-blob density after a correct crop) would catch them.
- Low-light + shadow pages: recall 0.55. Cleanup variants and upscaling were tested and do not help (see 01:44 and
  01:48); the next lever is a stronger recognizer for blurry text (phase-2 PaddleOCR evaluation) or a
  sharpening/deblur step, measured with `eval/ab_cleanup.py`.
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
