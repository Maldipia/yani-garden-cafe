const express = require('express');
const path = require('path');
// Node 22 has built-in fetch
const app = express();

const VERCEL = 'https://yanigardencafe.com';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Proxy function
async function proxyToVercel(req, res) {
  try {
    const url = `${VERCEL}${req.path}`;
    const opts = { method: req.method, headers: { 'Content-Type': 'application/json' } };
    if (req.method !== 'GET' && req.body) opts.body = JSON.stringify(req.body);
    const r = await fetch(url, opts);
    const text = await r.text();
    res.status(r.status).set('Content-Type', 'application/json').send(text);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

// Explicit API routes
app.all('/api/pos', proxyToVercel);
app.all('/api/online-order', proxyToVercel);
app.all('/api/health', proxyToVercel);
app.all('/api/sync-menu', proxyToVercel);
app.all('/api/upload-image', proxyToVercel);
app.all('/api/upload-proof', proxyToVercel);

// Serve static files
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/online-order.html', (req, res) => res.sendFile(path.join(__dirname, 'online-order.html')));

const PORT = 3456;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yani Cafe proxy running on port ${PORT}`);
});
