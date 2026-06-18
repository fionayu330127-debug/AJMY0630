# Agimia ERP Backend Framework

## Current layout

```text
agimia-erp-shell/
  server.js
  database/
  modules/
    tk-creator-system/
      server.js
      db.js
      data/tk-creator.db
```

`agimia-erp-shell` is the company system shell. It owns login, users, global navigation, and shared PostgreSQL data.

`modules/tk-creator-system` is mounted by the shell at `/tk`. It keeps its own SQLite database under `modules/tk-creator-system/data/`, so the TikTok creator data is independent from the main ERP database.

## Module rules

Each staged module should live under:

```text
modules/<module-name>/
```

Recommended module contract:

```js
const express = require('express');
const app = express.Router();

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

module.exports = app;
```

The shell mounts the module in `server.js`:

```js
const moduleApp = require('./modules/<module-name>/server.js');
app.use('/<module-route>', moduleApp);
```

## Git strategy

Use one main repository for `agimia-erp-shell`.

Runtime files must not be committed:

- `.env`
- `node_modules/`
- `*.log`
- SQLite files such as `data/*.db`, `*.db-wal`, and `*.db-shm`
- local tunnel executables

If a module later needs a separate remote repository, convert that module to a Git submodule after the remote repository exists. Until then, keep module source under `modules/` and let the main repository protect it.

## Backend deployment path

1. Keep the shell entry point as `server.js`.
2. Mount each module under a stable route, for example `/tk`, `/orders`, `/inventory`.
3. Keep global business data in PostgreSQL.
4. Keep isolated module data in the module folder only when the module is not part of shared ERP reporting.
5. Start the shell with `npm start`; do not start mounted modules as separate services unless they are intentionally split out.
