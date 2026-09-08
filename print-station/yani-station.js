#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   YANI STATION — offline order entry + drink labels, on the counter PC.

   Replaces yani-print-station.js (it does printing too, plus everything below).

   WHAT IT DOES
     • Serves an order-entry page at http://localhost:3000 — works with NO internet
     • Keeps a local copy of the menu, refreshed whenever you are online
     • Saves orders to disk, prints drink labels immediately
     • Pushes queued orders to the cloud the moment the connection returns
     • Also prints labels queued by the cloud (the iPad flow), same as before

   ZERO DEPENDENCIES — no npm install. Node 18+ only.

   RUN:   node yani-station.js
   TEST:  node yani-station.js --test      (prints one label, then exits)
   ───────────────────────────────────────────────────────────────────────── */

const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CFG  = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DATA = path.join(__dirname, 'data');
const PORT = CFG.port || 3000;
const COLS = 32;

fs.mkdirSync(DATA, { recursive: true });

// ── tiny JSON store (no DB engine, nothing to corrupt on power loss) ──────
function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); }
  catch { return fallback; }
}
function save(name, value) {
  const p = path.join(DATA, name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(p + '.tmp', p);          // atomic-ish: never a half-written file
}

let menu    = load('menu.json', { items: [], fetchedAt: null });
let orders  = load('orders.json', []);   // local orders, pending or synced
let counter = load('counter.json', { seq: 0 });
let online  = false;

// ── ESC/POS label rendering (identical output to the previous agent) ──────
const ESC = 0x1b, GS = 0x1d;
const CMD = {
  init: [ESC,0x40], boldOn: [ESC,0x45,1], boldOff: [ESC,0x45,0],
  dblOn: [GS,0x21,0x11], dblOff: [GS,0x21,0x00], feed3: [ESC,0x64,3], cut: [GS,0x56,66,0],
};
const ascii = (s) => String(s == null ? '' : s)
  .replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"')
  .replace(/[\u2013\u2014]/g,'-').replace(/[^\x20-\x7E\n]/g,'');
function lr(l, r) {
  l = ascii(l); r = ascii(r);
  if (l.length + r.length >= COLS) l = l.substring(0, COLS - r.length - 1);
  return l + ' '.repeat(Math.max(1, COLS - l.length - r.length)) + r + '\n';
}
function wrap(t, w = COLS) {
  const out = []; let cur = '';
  for (const word of ascii(t).split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + word).trim().length > w) { if (cur) out.push(cur); cur = word; }
    else cur = (cur ? cur + ' ' : '') + word;
  }
  if (cur) out.push(cur);
  return out;
}
function renderLabel(job) {
  const p = job.payload || {}, parts = [];
  const push = (x) => parts.push(Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'binary'));
  push(Buffer.from(CMD.init));
  push(Buffer.from(CMD.boldOn));
  push(lr(job.order_id || '', job.table_no ? 'TABLE ' + job.table_no : ''));
  push(Buffer.from(CMD.boldOff));
  push(lr(p.customer_name || job.customer_name || '', `${job.seq_no}/${job.seq_total}`));
  push('-'.repeat(COLS) + '\n');
  push(Buffer.from(CMD.dblOn));
  for (const l of wrap(p.item, Math.floor(COLS / 2))) push(l + '\n');
  push(Buffer.from(CMD.dblOff));
  const opts = [p.size, p.sugar].filter(Boolean).map(s => String(s).toUpperCase()).join(' | ');
  if (opts) push(opts + '\n');
  const note = p.item_note || p.order_note;
  if (note) {
    push('\n'); push(Buffer.from(CMD.boldOn));
    for (const l of wrap('** ' + String(note).toUpperCase() + ' **')) push(l + '\n');
    push(Buffer.from(CMD.boldOff));
  }
  push('-'.repeat(COLS) + '\n');
  push(new Date(job.created_at || Date.now())
        .toLocaleTimeString('en-PH', { hour:'numeric', minute:'2-digit', hour12:true }) + '\n');
  push(Buffer.from(CMD.feed3)); push(Buffer.from(CMD.cut));
  return Buffer.concat(parts);
}
function sendToPrinter(buf) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `yani-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmp, buf);
    execFile('cmd', ['/c','copy','/b', tmp, `\\\\${os.hostname()}\\${CFG.shareName || 'XP58'}`],
      (err, so, se) => { fs.unlink(tmp, () => {});
        err ? reject(new Error((se || err.message || 'copy failed').trim())) : resolve(); });
  });
}

// ── cloud ────────────────────────────────────────────────────────────────
async function api(action, extra = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(CFG.apiUrl, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, stationKey: CFG.stationKey, station: CFG.station, ...extra }),
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
    return d;
  } finally { clearTimeout(t); }
}

// ── local order → labels (drinks only, one per cup) ───────────────────────
const DRINK_CATEGORIES = CFG.drinkCategories || ['HOT', 'ICE AND ICE BLENDED'];
function labelsFor(order) {
  const units = [];
  for (const it of order.items) {
    if (!DRINK_CATEGORIES.includes(String(it.category || '').toUpperCase())) continue;
    for (let n = 0; n < (parseInt(it.qty, 10) || 1); n++) units.push(it);
  }
  return units.map((it, i) => ({
    order_id: order.order_id, table_no: order.tableNo, customer_name: order.customerName,
    seq_no: i + 1, seq_total: units.length, created_at: order.created_at,
    payload: { item: it.name, size: it.size, sugar: it.sugar,
               item_note: it.note, order_note: order.notes,
               customer_name: order.customerName },
  }));
}
async function printOrder(order) {
  const labels = labelsFor(order);
  for (const l of labels) {
    try { await sendToPrinter(renderLabel(l)); }
    catch (e) { console.error(`  ! label ${l.seq_no}/${l.seq_total}: ${e.message}`); }
  }
  return labels.length;
}

// ── background: connectivity, menu refresh, sync, cloud print queue ───────
async function refreshMenu() {
  try {
    const r = await fetch(CFG.apiUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'getMenu' }),
    });
    const d = await r.json();
    const items = d.items || d.menu || d.data || [];
    if (Array.isArray(items) && items.length) {
      menu = { items, fetchedAt: new Date().toISOString() };
      save('menu.json', menu);
      console.log(`menu cached: ${items.length} items`);
    }
  } catch (e) { console.error('menu refresh failed: ' + e.message); }
}

async function syncPending() {
  const pending = orders.filter(o => !o.synced);
  if (!pending.length) return;
  for (const o of pending) {
    try {
      const r = await api('stationSyncOrder', { order: o });
      o.synced = true;
      o.cloud_order_id = r.orderId || null;
      o.synced_at = new Date().toISOString();
      console.log(`synced ${o.order_id}${r.orderId ? ' -> ' + r.orderId : ''}`);
    } catch (e) {
      o.sync_error = e.message;
      console.error(`sync failed ${o.order_id}: ${e.message}`);
      break;                                  // stop on first failure, retry next tick
    }
  }
  save('orders.json', orders);
}

async function drainCloudPrintQueue() {
  try {
    const { jobs } = await api('printClaim', { limit: 5 });
    for (const job of jobs) {
      try {
        await sendToPrinter(renderLabel(job));
        await api('printComplete', { id: job.id, success: true });
        console.log(`printed ${job.order_id} ${job.seq_no}/${job.seq_total}`);
      } catch (e) {
        try { await api('printComplete', { id: job.id, success: false, error: e.message }); } catch {}
      }
    }
  } catch { /* offline — handled by the online flag */ }
}

async function heartbeat() {
  const was = online;
  try { await api('printPing', {}, 5000); online = true; }
  catch { online = false; }
  if (online !== was) console.log(online ? '● ONLINE' : '○ OFFLINE — orders will queue locally');
  if (online) {
    await syncPending();
    await drainCloudPrintQueue();
    if (!menu.fetchedAt || Date.now() - Date.parse(menu.fetchedAt) > 30 * 60 * 1000) await refreshMenu();
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────
const PAGE = fs.existsSync(path.join(__dirname, 'station.html'))
  ? () => fs.readFileSync(path.join(__dirname, 'station.html'))
  : () => Buffer.from('<h1>station.html missing</h1>');

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const b = PAGE();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length });
    return res.end(b);
  }

  if (req.method === 'GET' && url.pathname === '/api/menu') {
    return json(res, 200, { ok: true, ...menu });
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    return json(res, 200, {
      ok: true, online,
      pending: orders.filter(o => !o.synced).length,
      today: orders.filter(o => o.created_at.slice(0,10) === new Date().toISOString().slice(0,10)).length,
      menuItems: menu.items.length, menuFetchedAt: menu.fetchedAt,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/orders') {
    return json(res, 200, { ok: true, orders: orders.slice(-30).reverse() });
  }

  if (req.method === 'POST' && url.pathname === '/api/order') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const o = JSON.parse(body);
        if (!Array.isArray(o.items) || !o.items.length) return json(res, 400, { ok:false, error:'No items' });
        counter.seq += 1; save('counter.json', counter);
        const order = {
          order_id: `YANI-OFF-${String(counter.seq).padStart(4,'0')}`,
          tableNo: String(o.tableNo || '0'),
          customerName: String(o.customerName || 'Guest').substring(0,100),
          orderType: o.orderType === 'TAKE-OUT' ? 'TAKE-OUT' : 'DINE-IN',
          notes: String(o.notes || '').substring(0,500),
          items: o.items, subtotal: o.subtotal, serviceCharge: o.serviceCharge, total: o.total,
          created_at: new Date().toISOString(), enteredOffline: !online, synced: false,
        };
        orders.push(order); save('orders.json', orders);
        const printed = await printOrder(order);
        console.log(`[${new Date().toLocaleTimeString()}] ${order.order_id} table ${order.tableNo} — ${order.items.length} lines, ${printed} labels`);
        if (online) syncPending().catch(()=>{});
        return json(res, 200, { ok:true, orderId: order.order_id, labels: printed });
      } catch (e) { return json(res, 400, { ok:false, error: e.message }); }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ── boot ─────────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--test')) {
    console.log('Printing test label...');
    await sendToPrinter(renderLabel({
      order_id: 'YANI-TEST', table_no: '1', seq_no: 1, seq_total: 1, created_at: new Date().toISOString(),
      payload: { item:'Iced Dark Cacao Ovaltine', size:'Tall 22oz', sugar:'Comfort',
                 customer_name:'Test', item_note:'extra hot' },
    }));
    console.log('Sent. Check the printer.');
    return;
  }
  console.log('YANI Station');
  console.log(`  printer : \\\\${os.hostname()}\\${CFG.shareName || 'XP58'}`);
  console.log(`  orders  : http://localhost:${PORT}`);
  console.log(`  queued  : ${orders.filter(o => !o.synced).length} unsynced\n`);
  server.listen(PORT);
  await heartbeat();
  if (!menu.items.length) await refreshMenu();
  setInterval(heartbeat, Math.max(CFG.pollMs || 3000, 3000));
}
main().catch(e => { console.error(e); process.exit(1); });
