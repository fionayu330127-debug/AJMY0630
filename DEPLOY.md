# Deploy

Git remote:

```powershell
git remote -v
```

Local development URL:

```text
http://127.0.0.1:3001/
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

On the cloud server, update only when you are ready to publish:

```powershell
cd C:\Users\Administrator\Desktop\agimia-erp-shell
.\server-pull-restart.ps1
```

Local edits do not affect the cloud server until the server runs `git pull` and restarts.
