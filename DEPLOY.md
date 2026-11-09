# Release Baseline

Git remote:

```powershell
git remote -v
```

Directory ownership:

- `agimia-erp-shell`: the only development Git worktree.
- `agimia-erp-production`: local production verification; never edit it directly.
- `/opt/agimia-erp-shell`: public runtime; deploy release artifacts only.
- `modules/tk-creator-system`: the only TK creator module source.

Local development URL (use a preview port such as `3002`):

```text
http://127.0.0.1:3002/
```

Public server URL:

```text
http://120.26.178.11:3001/
```

Current release boundary:

```powershell
git add <intended-files>
git commit -m "video: <stage>-<description>"
```

The coding agent normally stops after the clean local commit. After explicit owner confirmation for
the exact release target, Codex may run the corresponding publish script and report its result. It
must not edit `agimia-erp-production` directly or run `git push`.

Explicitly confirmed local production release:

```powershell
cd C:\Users\Administrator\Desktop\agimia-erp-shell
.\publish-to-production.ps1 -Confirmed
```

Explicitly confirmed public release, after local verification:

```powershell
.\publish-to-public.ps1 -Confirmed
```

Both scripts publish files from Git `HEAD`, not arbitrary worktree files. They exclude `.env`,
SQLite/PostgreSQL data, logs, dependency folders, and product submission data. A database and
code backup is created before deployment. Public deployment restarts `agimia-erp.service`, checks
`/healthz`, and restores the previous code when deployment fails.
