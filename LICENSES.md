# Third-party components and licenses

All components are free/open source. **No AGPL and no non-commercial components are used.**
Copyleft items are flagged ⚠ — all are used unmodified, as separate programs or dynamically
linked libraries, on our own server (no redistribution), which those licenses permit.

| Component | Use | License |
|---|---|---|
| PostgreSQL 16 | metadata + full-text search | PostgreSQL (permissive) |
| Redis 7 | job queue | BSD-3 |
| Caddy 2 | TLS reverse proxy | Apache-2.0 |
| FastAPI, Starlette, Pydantic, Uvicorn | API | MIT / BSD-3 |
| SQLAlchemy, Alembic | ORM / migrations | MIT |
| psycopg 3 | Postgres driver | ⚠ LGPL-3.0 (library, unmodified) |
| RQ | job workers | BSD-2 |
| argon2-cffi, pyotp | password hashing, TOTP | MIT |
| OpenCV (opencv-python-headless 4.10) | classic CV stages | Apache-2.0 |
| NumPy | | BSD-3 |
| Pillow | image decoding | HPND (MIT-like) |
| pillow-heif (+ libheif) | HEIC/HEIF | BSD-3 (⚠ libheif LGPL-3.0, bundled lib) |
| pypdfium2 / PDFium | PDF render + text layer | Apache-2.0 / BSD-3 |
| pikepdf / qpdf | PDF assembly | MPL-2.0 / Apache-2.0 |
| Tesseract 5 | OCR + OSD | Apache-2.0 |
| MobileSAM (code + weights `mobile_sam.pt`, commit f706ad9) | page outline (mask) on photos | Apache-2.0 |
| UVDoc (code + weights `best_model.pkl`, commit 4c9b82b) | page flattening mesh | MIT |
| ONNX Runtime 1.20 | runs the two models above (exported to ONNX at image build) | MIT |
| PyTorch, torchvision, timm, onnx (build stage only, not in the final image) | model export | BSD-3 / BSD-3 / Apache-2.0 / Apache-2.0 |
| tessdata_best `rus`, `eng`; tessdata `osd` (model weights) | OCR models | Apache-2.0 |
| LibreOffice (headless) | office → PDF | ⚠ MPL-2.0 (separate program) |
| ClamAV (optional) | malware scan | ⚠ GPL-2.0 (separate container, talked to over a socket) |
| React, React Router, Vite | web UI | MIT |
| qrcode (npm) | QR codes in UI | MIT |
| lucide-react (npm) | UI icons, logo, favicon | ISC |
| Baileys 6.7 | WhatsApp Web protocol | MIT |
| libsignal-node (Baileys dependency) | Signal protocol | ⚠ **GPL-3.0** — isolated in the WhatsApp container. The alternative (whatsmeow) also depends on a GPL-3.0 libsignal. |
| pino | connector logging | MIT |

Phase-2 candidates (to verify before use): PaddleOCR / PP-LCNet / PP-Structure (Apache-2.0),
DocRes (check repo/weights license), fastText LID (MIT code, CC-BY-SA-3.0 weights ⚠),
Lingua (Apache-2.0), py_webauthn (BSD-3).
