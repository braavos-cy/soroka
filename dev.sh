#!/usr/bin/env bash
# Start the development server in the foreground. Ctrl+C stops it.
# Code changes are picked up immediately (no rebuild needed); only dependency/Dockerfile changes need a restart.
set -euo pipefail
cd "$(dirname "$0")"

# first run: create .env with random secrets
if [ ! -f .env ]; then
  rnd() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; }
  db=$(rnd); admin=$(rnd 16)
  sed -e "s/change-me-db/$db/g" -e "s/change-me-long-random/$(rnd 40)/" -e "s/change-me-admin/$admin/" \
      .env.example > .env
  echo ">> Created .env — first login: admin@example.com / $admin (also in .env)"
fi

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

port=$(grep -E '^DEV_PORT=' .env | cut -d= -f2 || true)
ip=$(curl -s -m 3 https://ifconfig.me || hostname -I | awk '{print $1}')
echo ">> Dev server: http://${ip}:${port:-5173}   (Ctrl+C to stop)"

DOCKER="$DOCKER" backend/models/ensure.sh
exec $DOCKER compose -p soroka-dev -f docker-compose.yml -f docker-compose.dev.yml up --build --remove-orphans
