#!/usr/bin/env bash
# Build the page-models image if it is not there yet (the backend image copies /models from it).
# Bump VERSION here and in backend/Dockerfile (MODELS_IMAGE) after changing this folder, so it is rebuilt.
set -euo pipefail
VERSION=1
DOCKER=${DOCKER:-docker}
cd "$(dirname "$0")"
if ! $DOCKER image inspect "soroka-models:$VERSION" >/dev/null 2>&1; then
  echo ">> Building soroka-models:$VERSION (downloads torch and model checkpoints once, takes a while)"
  $DOCKER build -t "soroka-models:$VERSION" .
fi
