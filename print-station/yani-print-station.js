#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────
   YANI PRINT STATION  —  Xprinter XP-58H (58mm, ESC/POS, 384 dots, 32 cols)

   Runs on the Windows PC at the counter. Polls the print queue, renders each
   drink label as ESC/POS bytes, sends it to the printer, marks it PRINTED.

   SETUP (once):
     1. Install the Xprinter Windows driver (XP-58H / 58mm series).
     2. Windows Settings > Printers > XP-58H > Printer properties > Sharing
        Tick "Share this printer", set Share name to exactly:  XP58
     3. Put this file in a folder with config.json (see below), then:
          node yani-print-station.js
     4. To run at startup: Task Scheduler > Create Task > At log on >
          Program: node    Arguments: C:\yani\yani-print-station.js

   config.json:
     {
       "apiUrl":     "https://yanigardencafe.com/api/pos",
       "stationKey": "<same value as PRINT_STATION_KEY in Vercel>",
       "station":    "counter-pc",
       "shareName":  "XP58",
       "pollMs":     3000
     }
   ───────────────────────────────────────────────────────────────────────── */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const POLL = Math.max(CFG.pollMs || 3000, 1000);
const COLS = 32;                       // XP-58H Font A = 32 chars per line

// ── ESC/POS ───────────────────────────────────────────────────────────────
const ESC = 0x1b, GS = 0x1d;
const CMD = {
  init:        [ESC, 0x40],
  alignLeft:   [ESC, 0x61, 0],
  alignCenter: [ESC, 0x61, 1],
  boldOn:      [ESC, 0x45, 1],
  boldOff:     [ESC, 0x45, 0],
  dblOn:       [GS, 0x21, 0x11],       // double width + height
  dblOff:      [GS, 0x21, 0x00],
  feed3:       [ESC, 0x64, 3],
  cut:         [GS, 0x56, 66, 0],      // ignored harmlessly if no cutter
};

const bytes = (...parts) => Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
const line  = (ch = '-') => ch.repeat(COLS) + '\n';

// CP437 is what the XP-58H ships with; strip anything it cannot render
// so a stray emoji in a customer note never garbles the whole label.
function ascii(s) {
  return String(s == null ? '' : s)
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x20-\x7E\n]/g, '');
}

// Left text + right text padded to exactly COLS
function lr(left, right) {
  left = ascii(left); right = ascii(right);
  const space = COLS - left.length - right.length;
  if (space < 1) left = left.substring(0, COLS - right.length - 1);
  return left + ' '.repeat(Math.max(1, COLS - left.length - right.length)) + right + '\n';
}

function wrap(text, width = COLS) {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const out = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { if (cur) out.push(cur); cur = w; }
    else cur = (cur ? cur + ' ' : '') + w;
  }
  if (cur) out.push(cur);
  return out;
}

function renderLabel(job) {
  const p = job.payload || {};
  const chunks = [];
  const push = (x) => chunks.push(Buffer.isBuffer(x) ? x : Buffer.from(x, 'binary'));

  push(Buffer.from(CMD.init));
  push(Buffer.from(CMD.alignLeft));

  // Header: order id + table
  push(Buffer.from(CMD.boldOn));
  push(lr(job.order_id || '', job.table_no ? 'TABLE ' + job.table_no : ''));
  push(Buffer.from(CMD.boldOff));

  // Customer + sequence
  push(lr(p.customer_name || job.customer_name || '', `${job.seq_no}/${job.seq_total}`));
  push(line('-'));

  // Drink name, big
  push(Buffer.from(CMD.dblOn));
  for (const l of wrap(p.item, Math.floor(COLS / 2))) push(l + '\n');
  push(Buffer.from(CMD.dblOff));

  // Size | sugar
  const opts = [p.size, p.sugar].filter(Boolean).map(s => String(s).toUpperCase()).join(' | ');
  if (opts) push(opts + '\n');
  if (p.addons) for (const l of wrap('+ ' + p.addons)) push(l + '\n');

  // Special request — the thing that must not be missed
  const note = p.item_note || p.order_note;
  if (note) {
    push('\n');
    push(Buffer.from(CMD.boldOn));
    for (const l of wrap('** ' + String(note).toUpperCase() + ' **')) push(l + '\n');
    push(Buffer.from(CMD.boldOff));
  }

  push(line('-'));
  push(new Date(job.created_at || Date.now())
        .toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', hour12: true }) + '\n');

  push(Buffer.from(CMD.feed3));
  push(Buffer.from(CMD.cut));
  return bytes(...chunks);
}

// ── Windows raw printing via the shared printer ───────────────────────────
function sendToPrinter(buf) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `yani-label-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmp, buf);
    const target = `\\\\${os.hostname()}\\${CFG.shareName || 'XP58'}`;
    execFile('cmd', ['/c', 'copy', '/b', tmp, target], (err, stdout, stderr) => {
      fs.unlink(tmp, () => {});
      if (err) return reject(new Error((stderr || err.message || '').trim() || 'copy failed'));
      resolve();
    });
  });
}

// ── API ───────────────────────────────────────────────────────────────────
async function api(action, extra = {}) {
  const r = await fetch(CFG.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, stationKey: CFG.stationKey, station: CFG.station, ...extra }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { throw new Error('Bad response: ' + text.slice(0, 200)); }
  if (!r.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

let consecutiveErrors = 0;

async function tick() {
  try {
    const { jobs } = await api('printClaim', { limit: 5 });
    consecutiveErrors = 0;
    for (const job of jobs) {
      try {
        await sendToPrinter(renderLabel(job));
        await api('printComplete', { id: job.id, success: true });
        console.log(`[${new Date().toLocaleTimeString()}] printed ${job.order_id} ${job.seq_no}/${job.seq_total} — ${(job.payload || {}).item || ''}`);
      } catch (e) {
        console.error(`  ! ${job.order_id} ${job.seq_no}: ${e.message}`);
        try { await api('printComplete', { id: job.id, success: false, error: e.message }); } catch {}
      }
    }
  } catch (e) {
    consecutiveErrors++;
    // Back off when the network or Vercel is down, but never give up.
    if (consecutiveErrors <= 3 || consecutiveErrors % 20 === 0) {
      console.error(`[${new Date().toLocaleTimeString()}] poll error (${consecutiveErrors}): ${e.message}`);
    }
  }
}

async function main() {
  console.log('YANI Print Station — XP-58H');
  console.log(`  api      : ${CFG.apiUrl}`);
  console.log(`  station  : ${CFG.station}`);
  console.log(`  printer  : \\\\${os.hostname()}\\${CFG.shareName || 'XP58'}`);
  try {
    await api('printPing');
    console.log('  auth     : OK\n');
  } catch (e) {
    console.error('  auth     : FAILED — ' + e.message);
    console.error('\nCheck stationKey matches PRINT_STATION_KEY in Vercel, then restart.\n');
  }
  if (process.argv.includes('--test')) {
    console.log('Printing test label...');
    await sendToPrinter(renderLabel({
      order_id: 'YANI-TEST', table_no: '1', seq_no: 1, seq_total: 1, created_at: new Date().toISOString(),
      payload: { item: 'Iced Dark Cacao Ovaltine', size: 'Tall 22oz', sugar: 'Comfort',
                 customer_name: 'Test', item_note: 'extra hot' },
    }));
    console.log('Sent. Check the printer.');
    return;
  }
  setInterval(tick, POLL);
  tick();
}

main().catch(e => { console.error(e); process.exit(1); });
