const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [sourceArg, targetArg] = process.argv.slice(2);

if (!sourceArg || !targetArg) {
  console.error('Usage: node scripts/backup-sqlite.js <source.db> <target.db>');
  process.exit(1);
}

const source = path.resolve(sourceArg);
const target = path.resolve(targetArg);

if (!fs.existsSync(source)) {
  throw new Error(`SQLite source does not exist: ${source}`);
}

if (fs.existsSync(target)) {
  throw new Error(`Backup target already exists: ${target}`);
}

fs.mkdirSync(path.dirname(target), { recursive: true });

const sourceDb = new DatabaseSync(source);
const escapedTarget = target.replaceAll("'", "''");
sourceDb.exec(`VACUUM INTO '${escapedTarget}'`);
sourceDb.close();

const backupDb = new DatabaseSync(target, { readOnly: true });
const integrity = backupDb.prepare('PRAGMA integrity_check').get();
backupDb.close();

if (integrity.integrity_check !== 'ok') {
  throw new Error(`Backup integrity check failed: ${integrity.integrity_check}`);
}

console.log(`SQLite backup created: ${target}`);
