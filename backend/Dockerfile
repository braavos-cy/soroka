# Page models (ONNX) come from their own image, built once by models/ensure.sh (bump the version in both places).
ARG MODELS_IMAGE=soroka-models:1
FROM ${MODELS_IMAGE} AS models

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app \
    TESSDATA_PREFIX=/usr/share/tessdata-best MODELS_DIR=/models

# Tesseract (Apache-2.0), LibreOffice (MPL-2.0) for office->PDF, fonts with Cyrillic
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-osd curl ca-certificates \
        libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
        fonts-dejavu fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# tessdata_best (Apache-2.0): higher accuracy LSTM models; Russian quality is the priority
RUN mkdir -p $TESSDATA_PREFIX && cd $TESSDATA_PREFIX \
    && curl -fsSL -o rus.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/rus.traineddata \
    && curl -fsSL -o eng.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata \
    && curl -fsSL -o osd.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/osd.traineddata

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
COPY --from=models /models /models

CMD ["sh", "-c", "alembic upgrade head && python -m soroka.bootstrap && uvicorn soroka.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
