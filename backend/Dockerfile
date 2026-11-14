# ---- page models (MobileSAM Apache-2.0, SyntheticDoc MIT): exported to ONNX here, so the app needs onnxruntime only
FROM python:3.12-bookworm AS models
RUN pip install --no-cache-dir torch==2.15.0 torchvision==0.29.2 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir timm==1.0.31 onnx==1.17.0
RUN git clone https://github.com/ChaoningZhang/MobileSAM.git /src/MobileSAM \
    && git -C /src/MobileSAM checkout f706ad9c4eb7f219c00d9050e46328518ffb65d2 \
    && git clone https://github.com/tanguymagne/SyntheticDoc.git /src/SyntheticDoc \
    && git -C /src/SyntheticDoc checkout aabd9cf05f479781df432e3bd7e940f3e6716dbd \
    && pip install --no-cache-dir --no-deps -e /src/MobileSAM
RUN cd /src/SyntheticDoc/training/model \
    && curl -fsSL -o low.ckpt https://igl.ethz.ch/projects/SyntheticDoc/original_31x45.ckpt \
    && curl -fsSL -o high.ckpt https://igl.ethz.ch/projects/SyntheticDoc/highres_121x177.ckpt \
    && echo "557af82579157c000f3cbd27c79d02b2a7cfea177849dbb04b9499ff88c81b1f  low.ckpt" | sha256sum -c \
    && echo "a9b69148fb3a8bf309757106f489df17a339a03f298f59d882f5ff51ba65a91d  high.ckpt" | sha256sum -c
COPY models/export_models.py /src/export_models.py
RUN mkdir /models && python /src/export_models.py /models

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
