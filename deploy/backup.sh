#!/bin/sh
# Daily backup (cron: 0 3 * * * /opt/soroka/deploy/backup.sh). Keeps 14 days.
# Restore: see README "Backup & restore". Test the restore regularly.
set -eu
cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-/var/backups/soroka}
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"
docker compose exec -T db pg_dump -U soroka -Fc soroka > "$DEST/db-$TS.dump"
docker run --rm -v soroka_files:/data:ro -v "$DEST":/out alpine tar czf "/out/files-$TS.tgz" -C /data .
docker run --rm -v soroka_wa_auth:/data:ro -v "$DEST":/out alpine tar czf "/out/wa-auth-$TS.tgz" -C /data .
find "$DEST" -type f -mtime +14 -delete
echo "backup ok: $DEST/*-$TS.*"
