const express = require('express');
const path = require('node:path');

const app = express();
const ROOT = __dirname;
const MODULE_INFO = {
  id: 'inventory-center',
  title: '库存货件',
  icon: '库',
  items: [
    {
      id: 'inventory-detail',
      label: '库存明细',
      url: 'http://47.110.59.28/',
      order: 10,
    },
    {
      id: 'inventory',
      label: '库存货件',
      url: '/inventory/',
      order: 20,
    },
  ],
};

app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/health', (req, res) => {
  res.json({ ok: true, module: 'inventory-shipment-system' });
});

app.get(['/module-info', '/api/module-info'], (req, res) => {
  res.json(MODULE_INFO);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

module.exports = app;
