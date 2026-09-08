# YANI Print Station — Xprinter XP-58H

Runs on the counter Windows PC. Polls the print queue, prints one sticker per drink.

## One-time setup

1. **Install the driver** — Xprinter XP-58H / 58mm series, from xprintertech.com/drivers-2
   (choose "Receipt Printer (Windows)"). Plug the printer in via USB.

2. **Share the printer**
   Settings > Bluetooth & devices > Printers & scanners > XP-58H >
   Printer properties > Sharing tab > tick "Share this printer" >
   Share name must be exactly: `XP58`

3. **Install Node.js** — nodejs.org, LTS version. Node 18+ required (uses built-in fetch).

4. **Configure** — copy `config.example.json` to `config.json` and paste the station key.

5. **Test the printer before anything else:**
   ```
   node yani-print-station.js --test
   ```
   A test label should come out. If nothing prints, the share name is wrong —
   check `Sharing` again. Nothing else in the setup matters until this works.

6. **Run it:**
   ```
   node yani-print-station.js
   ```

## Run at startup

Task Scheduler > Create Task
- General: "YANI Print Station", tick "Run whether user is logged on or not"
- Triggers: At log on
- Actions: Program `node`, Arguments `C:\yani\yani-print-station.js`, Start in `C:\yani`

## Troubleshooting

| Symptom | Cause |
|---|---|
| `auth: FAILED` | `stationKey` does not match `PRINT_STATION_KEY` in Vercel |
| `copy failed` | Share name is not `XP58`, or the printer is offline |
| Blank labels | Paper is in upside down — thermal paper only prints on one side |
| Garbled characters | Not CP437 — should not happen, non-ASCII is stripped before sending |
| Nothing claimed | No queued jobs, or another station already claimed them |

## Notes

- A job stuck in CLAIMED for 2 minutes is automatically retried.
- Failures are recorded on the job with the error text, not silently dropped.
- If the internet drops the agent keeps retrying and prints when it returns.
- The station key can only claim and complete print jobs. It cannot read
  orders, customers, payroll or anything else.

---

# Offline order entry (yani-station.js)

`yani-station.js` replaces `yani-print-station.js` — it prints labels AND takes
orders when the internet is down. Run one or the other, not both.

    node yani-station.js

Then open **http://localhost:3000** on the counter PC.

## What happens when the internet drops

| | Online | Offline |
|---|---|---|
| Customer QR ordering | works | **stops** — staff take orders at the counter |
| Staff order entry (localhost:3000) | works | **works** |
| Drink labels | print | **print** |
| Menu | refreshed every 30 min | served from local cache |
| Orders | sent to cloud immediately | queued on disk, synced when back |

Offline orders get IDs like `YANI-OFF-0001` so they can never collide with
cloud order numbers. The header badge shows ONLINE / OFFLINE and how many
orders are still queued.

## Files it creates

    data/menu.json      cached menu (survives reboots)
    data/orders.json    every local order, with a synced flag
    data/counter.json   the offline order sequence

Nothing is deleted after syncing — `orders.json` is your paper trail.

## Before an outage

Open the page once while online so the menu cache is populated. An empty
cache means an empty order screen.
