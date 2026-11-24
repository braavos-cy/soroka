# Page models (MobileSAM Apache-2.0, SyntheticDoc MIT), exported to ONNX: the app needs onnxruntime only.
# Built once into its own image (soroka-models:<version>, see ensure.sh) because it downloads torch and the
# checkpoints (> 1 GB): as a stage of the backend build it lived only in the build cache, which Docker clears,
# and every backend build then downloaded everything again. The result image holds just /models.
FROM python:3.12-bookworm AS build
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
COPY export_models.py /src/export_models.py
RUN mkdir /models && python /src/export_models.py /models

FROM scratch
COPY --from=build /models /models
