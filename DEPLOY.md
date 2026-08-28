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

Release flow:

```powershell
git add .
git commit -m "Your message"
git push origin main
```

Publish the clean commit to local production and verify port `3001`:

```powershell
cd C:\Users\Administrator\Desktop\agimia-erp-shell
.\publish-to-production.ps1 -Confirmed
```

After local production verification, publish the same commit publicly:

```powershell
.\publish-to-public.ps1 -Confirmed
```

Both scripts publish files from Git `HEAD`, not arbitrary worktree files. They exclude `.env`,
SQLite/PostgreSQL data, logs, dependency folders, and product submission data. A database and
code backup is created before deployment. Public deployment restarts `agimia-erp.service`, checks
`/healthz`, and restores the previous code when deployment fails.
