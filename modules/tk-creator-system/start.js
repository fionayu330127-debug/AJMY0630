require('dotenv').config();

const app = require('./server');

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.log(`TikTok creator system listening on http://127.0.0.1:${port}`);
  app.startShopSyncScheduler();
  app.startAgentScheduler();
});
