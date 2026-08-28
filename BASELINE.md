# ERP Version Baseline

Established on 2026-08-28.

## Sources of truth

- Development Git worktree: `C:\Users\Administrator\Desktop\agimia-erp-shell`
- Local production verification: `C:\Users\Administrator\Desktop\agimia-erp-production`
- Public runtime: `/opt/agimia-erp-shell`, managed by `agimia-erp.service`
- TK creator module: `modules/tk-creator-system`
- Baseline parent: `4094b46ab4de3d61d775b5f49f1ca1ce24b55bfc`

The baseline commit contains the public route surface plus locally verified additions. At baseline
creation, all 79 public GET/write route declarations were present locally and one route was added:
`POST /api/sync/samples`.

## Persistent data

Releases must not overwrite:

- `.env` files
- `node_modules`
- logs
- root `data`
- `modules/tk-creator-system/data`
- `modules/tk-trend-system/data`
- `product-test-system/data`
- SQLite `*.db`, `*.db-wal`, and `*.db-shm` files

Database schema changes belong in `database/migrations` and must be repeatable.

## Release gates

1. Work only in the development Git worktree.
2. Test on a preview port such as `3002` without calling live sync endpoints unnecessarily.
3. Commit the complete change and keep the worktree clean.
4. Run `publish-to-production.ps1 -Confirmed` and verify local port `3001`.
5. Push the same commit to `origin/main`.
6. Run `publish-to-public.ps1 -Confirmed` and verify the public health endpoint and changed workflow.

Both publish scripts create code and SQLite backups before changing a runtime. Public deployment
uses a Git archive and systemd; it does not use the public server's dirty worktree as a release source.
Local release backups use the ASCII-only path `E:\Agimia-ERP-Release-Backups` so Windows PowerShell
5 cannot corrupt the path when reading a UTF-8 script without a BOM.

## Recovery archive

Pre-baseline snapshots and the duplicate root TK module are stored under:

`E:\奥吉米亚ERP已删除备份\版本基线整理-20260828`
