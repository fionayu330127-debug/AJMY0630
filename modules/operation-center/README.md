# Operation Center

This module owns operation workflows while preserving the ERP shell's public URLs.

Current ownership:

- Sample submission API: `/api/sample-submissions`
- Product listing UI: `/product-test/`
- Amazon ads UI and API: shell compatibility layer

The shell injects authentication and database access into `server.js`. This keeps
sessions and existing PostgreSQL data unchanged while isolating module code.
