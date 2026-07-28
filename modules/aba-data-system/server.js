const path = require('node:path');
const express = require('express');

const app = express.Router();
const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir, {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

module.exports = app;
