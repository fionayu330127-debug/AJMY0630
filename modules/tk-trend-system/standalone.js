const express = require('express');
const trendApp = require('./server');
const app = express();
const port = Number(process.env.PORT || 3111);
app.get('/', (req, res) => res.redirect('/tk-trend/'));
app.use('/tk-trend', trendApp);
app.listen(port, '127.0.0.1', () => console.log(`TK trend: http://127.0.0.1:${port}/tk-trend/`));
