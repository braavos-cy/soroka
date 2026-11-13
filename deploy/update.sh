#!/bin/sh
# Auto-deploy: if GitHub main has a commit that isn't deployed yet, rebuild and restart production.
# Run every minute by soroka-update.timer (see deploy/install.sh). Safe to run by hand.
# Running containers keep serving until the new images are built; a failed build is retried next run.
set -eu
cd "$(dirname "$0")/.."
BRANCH=${DEPLOY_BRANCH:-main}
STATE=.deployed-commit
exec 9>.deploy.lock
flock -n 9 || exit 0   # previous deploy still running

git fetch -q origin "$BRANCH"
target=$(git rev-parse "origin/$BRANCH")
[ "$target" = "$(cat "$STATE" 2>/dev/null || true)" ] && [ "${1:-}" != "--force" ] && exit 0

echo "deploying $(git log -1 --format='%h %s' "$target")"
git reset -q --hard "$target"
docker compose up -d --build --remove-orphans
echo "$target" > "$STATE"
docker image prune -f >/dev/null
echo "deployed $(git rev-parse --short "$target")"
