#!/usr/bin/env bash
set -euo pipefail
umask 077

APP_DIR=/opt/agimia-erp-shell
BACKUP_DIR=/home/ecs-user/agimia-backups
STAMP=$(date +%Y-%m-%d_%H%M%S)
WORK_DIR="$BACKUP_DIR/.work-$STAMP"
ARCHIVE="$BACKUP_DIR/agimia-erp-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR" "$WORK_DIR"
chmod 700 "$BACKUP_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

DATABASE_URL=$(sed -n 's/^DATABASE_URL=//p' "$APP_DIR/.env" | head -n 1)
DATABASE_URL=${DATABASE_URL%\"}
DATABASE_URL=${DATABASE_URL#\"}
if [[ -z "$DATABASE_URL" ]]; then
  echo 'DATABASE_URL is missing' >&2
  exit 1
fi

pg_dump --dbname="$DATABASE_URL" --format=custom --file="$WORK_DIR/agimia-postgres.dump"

node - "$APP_DIR/modules/tk-creator-system/data/tk-creator.db" "$WORK_DIR/tk-creator.db" <<'NODE'
const { DatabaseSync } = require('node:sqlite');
const [source, target] = process.argv.slice(2);
const sourceDb = new DatabaseSync(source);
sourceDb.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
sourceDb.close();
const backupDb = new DatabaseSync(target, { readOnly: true });
const result = backupDb.prepare('PRAGMA integrity_check').get();
backupDb.close();
if (result.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${result.integrity_check}`);
NODE

install -m 600 "$APP_DIR/.env" "$WORK_DIR/erp.env"
install -m 600 "$APP_DIR/modules/tk-creator-system/.env" "$WORK_DIR/tk-creator.env"
if [[ -f "$APP_DIR/ai-image-system/.env" ]]; then
  install -m 600 "$APP_DIR/ai-image-system/.env" "$WORK_DIR/ai-image.env"
fi
if [[ -f "$APP_DIR/product-test-system/data/submissions.json" ]]; then
  install -m 600 "$APP_DIR/product-test-system/data/submissions.json" "$WORK_DIR/submissions.json"
fi

printf '%s\n' "$STAMP" > "$WORK_DIR/created-at.txt"
tar -C "$WORK_DIR" -czf "$ARCHIVE" .
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'agimia-erp-*.tar.gz' -o -name 'agimia-erp-*.tar.gz.sha256' \) -mtime +14 -delete
echo "$ARCHIVE"
