#!/bin/sh
# One-time production setup on a fresh Ubuntu server (run as the deploy user, needs sudo):
#   git clone https://github.com/braavos-cy/soroka.git /opt/soroka && /opt/soroka/deploy/install.sh
# Installs Docker, auto-deploy timer (polls GitHub every minute), daily backup, Docker log rotation.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=$(id -un)

if ! command -v docker >/dev/null; then
  sudo apt-get update -q
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker.io docker-compose-v2 docker-buildx
fi
sudo usermod -aG docker "$USER_NAME"
# rotate container logs so a 24/7 server doesn't fill the disk
[ -f /etc/docker/daemon.json ] || echo '{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"}}' \
  | sudo tee /etc/docker/daemon.json >/dev/null
sudo systemctl enable docker
sudo systemctl restart docker

[ -f "$DIR/.env" ] || { echo "Create $DIR/.env first (see .env.example)"; exit 1; }

sudo tee /etc/systemd/system/soroka-update.service >/dev/null <<UNIT
[Unit]
Description=Soroka auto-deploy from GitHub
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=$USER_NAME
SupplementaryGroups=docker
ExecStart=$DIR/deploy/update.sh
UNIT
sudo tee /etc/systemd/system/soroka-update.timer >/dev/null <<UNIT
[Unit]
Description=Check GitHub for Soroka updates every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now soroka-update.timer

echo "0 3 * * * root $DIR/deploy/backup.sh >> /var/log/soroka-backup.log 2>&1" | sudo tee /etc/cron.d/soroka-backup >/dev/null
echo "installed; first deploy: sudo systemctl start soroka-update; logs: journalctl -u soroka-update -f"
