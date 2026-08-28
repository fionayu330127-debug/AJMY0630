#!/usr/bin/env bash
set -euo pipefail

release_archive=${1:?release archive is required}
revision=${2:?revision is required}
root=${AGIMIA_ROOT:-/opt/agimia-erp-shell}
backup_root=${AGIMIA_BACKUP_ROOT:-/home/ecs-user/agimia-backups}
stamp=$(date +%Y%m%d-%H%M%S)
backup="$backup_root/release-$stamp-$revision"
db="$root/modules/tk-creator-system/data/tk-creator.db"

mkdir -p "$backup"
tar \
  --exclude='.git' --exclude='.env' --exclude='node_modules' --exclude='logs' \
  --exclude='data' --exclude='modules/tk-creator-system/data' \
  --exclude='modules/tk-trend-system/data' --exclude='product-test-system/data' \
  --exclude='*.log' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
  -czf "$backup/code.tar.gz" -C "$root" .

node - "$db" "$backup/tk-creator.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const [source, target] = process.argv.slice(2);
const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
db.close();
const check = new DatabaseSync(target, { readOnly: true });
const result = check.prepare('PRAGMA integrity_check').get().integrity_check;
check.close();
if (result !== 'ok') throw new Error(`SQLite backup integrity check failed: ${result}`);
NODE

rollback() {
  echo "Release failed; restoring code backup $backup" >&2
  tar -xzf "$backup/code.tar.gz" -C "$root"
  sudo systemctl restart agimia-erp.service
}
trap rollback ERR

tar \
  --exclude='.env' --exclude='node_modules' --exclude='logs' --exclude='data' \
  --exclude='modules/tk-creator-system/data' --exclude='modules/tk-trend-system/data' \
  --exclude='product-test-system/data' --exclude='*.log' --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' \
  -xzf "$release_archive" -C "$root"

cd "$root"
npm install --omit=dev
node --check server.js
node --check modules/tk-creator-system/server.js
printf '%s\n' "$revision" > .release-revision
sudo systemctl restart agimia-erp.service

for _ in $(seq 1 15); do
  if curl --fail --silent http://127.0.0.1:3001/healthz >/dev/null; then
    trap - ERR
    rm -f "$release_archive"
    echo "Published revision $revision"
    echo "Backup: $backup"
    exit 0
  fi
  sleep 1
done

echo 'Public health check failed.' >&2
false
