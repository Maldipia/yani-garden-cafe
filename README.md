# YANI Garden Café POS

Production point-of-sale + ordering system for YANI Garden Café (Amadeo, Cavite, Philippines).

**Live:**
- 🌐 https://yanigardencafe.com — customer POS (table QR ordering)
- 🛠 https://yanigardencafe.com/admin.html — staff/owner admin dashboard
- 🌱 https://yanigardencafe.com/rewards — Roots Rewards loyalty signup

**Tech stack:** Vanilla JS frontend · Vercel serverless functions · Supabase Postgres · PostgREST for data access · Vercel Cron for scheduled jobs.

---

## 🗺 Architecture overview

```
┌───────────────────────────────────────────────────────────────────┐
│ CUSTOMER (table QR)              STAFF/OWNER (PIN login)          │
│         │                                  │                       │
│         ▼                                  ▼                       │
│   yanigardencafe.com         admin.yanigardencafe.com              │
│   (index-customer.html)      (admin.html + admin-*.js)             │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼ POST /api/pos { action, ... }
┌───────────────────────────────────────────────────────────────────┐
│ VERCEL SERVERLESS FUNCTIONS  (Maldipia/yani-garden-cafe)           │
│   api/pos.js          — 65+ actions, monolithic                    │
│   api/card.js         — Yani Card public lookup + activation       │
│   api/upload-image.js — Payment screenshot uploads                 │
│   api/cron-leaves-expiry.js — Daily leaves expiry sweep            │
│   api/cron-backup.js  — Daily DB backup → Storage (Phase 0)        │
└───────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼ PostgREST + RPC
┌───────────────────────────────────────────────────────────────────┐
│ SUPABASE  (project hnynvclpvfxzlfjphefj)                           │
│   Postgres database — all business data                            │
│   Storage bucket "backups" — daily JSON snapshots                  │
│   Auth — disabled; we use PIN-based staff auth via staff_users     │
└───────────────────────────────────────────────────────────────────┘
```

**Three Vercel deployments, one Supabase database:**

| Vercel project | Domain | Role |
|---|---|---|
| `yani-garden-cafe` (`prj_sAaageyafER4acIM59K5FUhQ4020`) | yanigardencafe.com | Main customer POS, /rewards, architecture page |
| `yani-cafe` (`prj_rGTkLHObQl8MrLd4wxqlk3qWwj3Z`) | pos.yanigardencafe.com | Alternate customer POS subdomain |
| `yani-garden-cafe-d3l6` (`prj_n7PuEzWLEGsB4KiISPKTX9EbhCb2`) | admin.yanigardencafe.com | Admin dashboard |

All three deploy from the same GitHub `main` branch.

---

## 📁 Repository structure

```
/
├── index-customer.html        # Customer POS (table QR ordering)
├── admin.html + admin-*.js    # Owner/staff admin (PIN-auth)
├── rewards.html               # Roots Rewards landing page (/rewards)
├── online-order.html          # External takeout ordering page
├── kitchen.html               # Kitchen display screen
├── api/
│   ├── pos.js                 # ⚠️ 65+ actions in one file (~5K lines)
│   ├── card.js                # Public Yani Card pages
│   ├── upload-image.js        # Payment screenshot uploads
│   ├── cron-leaves-expiry.js  # Daily leaves expiry (2am PHT)
│   └── cron-backup.js         # Daily backup (3am PHT) — Phase 0
├── images/                    # Menu item photos + payment QR codes + logo
│   ├── pay-gcash.jpg          # GCash QR
│   ├── pay-bdo.jpg            # BDO QR
│   ├── pay-bpi.png            # BPI QR
│   ├── pay-unionbank.jpg      # UnionBank QR
│   ├── yani-logo.png          # Icon-only logo (transparent)
│   └── yani-logo-full.png     # Full logo with "YANI GARDEN CAFE" text
├── vercel.json                # Routes + cron schedules
├── package.json               # Dependencies (minimal)
├── README.md                  # This file
├── ARCHITECTURE.md            # Deep-dive system architecture
└── TENANT_SETUP.md            # Forward-looking: TYG POS SaaS onboarding
```

**Stale historical docs (do not trust for current state):**
- `SYSTEM_ARCHITECTURE.md` — describes the OLD Google Apps Script era. Pre-migration.
- `CLAUDE_BLUEPRINT.md` — same. Pre-migration.

---

## 🔑 Auth model

**Staff roles:** OWNER / ADMIN / CASHIER / KITCHEN — all PIN-based via `staff_users` table.

| Role | PIN | User ID | Purpose |
|---|---|---|---|
| OWNER | 2026 | USR_001 | Full access including settings, costing, audit |
| ADMIN | 2233 | USR_002 | Most admin operations except OWNER-only |
| CASHIER | — | USR_003 | Order processing, payment handling |
| KITCHEN | 1122 | USR_004 | Order preparation, kitchen workflow only |

Admin endpoints require `userId` in request body (format `USR_\d{3,6}`). Backend validates via `checkAuth(['OWNER','ADMIN'])` helper in `api/pos.js`.

**Customers** are unauthenticated; access is via table QR token or self-service.

---

## 💾 Database

**Supabase project ID:** `hnynvclpvfxzlfjphefj`

**Core tables (current state):**

| Table | Purpose |
|---|---|
| `staff_users` | Staff PIN auth |
| `menu_categories`, `menu_items`, `menu_addons` | Menu structure |
| `dine_in_orders`, `dine_in_order_items` | Active + historical orders |
| `yani_cards` | Prepaid loyalty cards (20 total: 2 ACTIVE, 3 SUSPENDED, 15 INACTIVE) |
| `card_transactions` | Audit log per card (ACTIVATE, RELOAD, CHARGE, ADJUST, REVERSE, SUSPEND, EDIT) |
| `loyalty_accounts` | Roots Rewards memberships (email-keyed) |
| `points_transactions` | Leaves earn/redeem/expire audit log |
| `leaf_rewards` | Reward ladder config (5 tiers: 2/5/10/15/25 🍃) |
| `leaf_redemptions` | When a member claims a reward |
| `surprise_rewards` | Auto-fired magic rewards (Soul Searcher, Rainy Day, Sunset) |
| `payments` | Customer payment screenshots + verification |
| `settings` | Key-value config (LEAVES_PESOS_PER_LEAF, surprise thresholds, etc.) |
| `order_audit_logs` | Audit trail for sensitive operations |
| `api_rate_limits` | Per-IP rate limit state (60 req/min) |

**Hardcoded relationships to watch:**

⚠️ `api/pos.js` has a `CATEGORY_ID_TO_NAME` hardcoded map. **Adding a category to the DB requires updating this map too** — otherwise the menu API silently doesn't recognize the new category. This is on the refactor backlog (see Phase 2 in `ARCHITECTURE.md`).

---

## 🚀 Deployment

**Standard flow:** Edit code → commit → push to `main` → Vercel auto-deploys all 3 projects.

```bash
# Clone
git clone https://github.com/Maldipia/yani-garden-cafe.git
cd yani-garden-cafe

# Make changes...

# Sanity check inline JS before push (every HTML edit)
python3 -c "
import re
html = open('the-file.html').read()
m = re.search(r'<script>([\s\S]*?)</script>', html)
open('/tmp/check.js','w').write(m.group(1) if m else '')
" && node --check /tmp/check.js

# Push
git push origin main

# Wait ~60s for Vercel deploy, then verify nothing broke
./scripts/smoke-test.sh   # 14 read-only checks in ~10s, exit 0 = clean
```

**Cache-busting:** Vercel sets `cache-control: no-store, no-cache, must-revalidate` on HTML so browsers and in-app webviews always fetch fresh. JS/CSS use `must-revalidate` (validate every request) for performance. To force a complete edge cache flush, a whitespace commit to `README.md` busts Vercel's edge cache.

---

## 🔐 Environment variables (Vercel)

Required env vars per Vercel project:

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | ✓ | https://hnynvclpvfxzlfjphefj.supabase.co |
| `SUPABASE_SERVICE_KEY` | ✓ | Service role key — bypasses RLS |
| `SUPABASE_ANON_KEY` | ✓ | Anon key for client-side reads |
| `CRON_SECRET` | for cron | Bearer token for `/api/cron-*` routes |
| `WEATHER_API_KEY` | optional | Activates Rainy Day surprise rewards (OpenWeatherMap) |
| `SENTRY_DSN` | optional | Error monitoring (frontend + backend) |
| `ACCOUNT_NAME` | default | Defaults to `LEGERYN PIA` if not set |
| `BDO_ACCOUNT`, `BPI_ACCOUNT`, `UNIONBANK_ACCOUNT` | default | Override hardcoded bank account numbers |

**Setting env vars:**
1. Vercel dashboard → Project → Settings → Environment Variables
2. Add for all environments (Production, Preview, Development)
3. Trigger a redeploy for changes to take effect

---

## 🛡 Security

**Audited and hardened (last audit: May 23, 2026):**

- ✅ All user-supplied strings escaped at every render site (XSS-safe)
- ✅ PostgREST parameterizes all queries (SQLi-safe)
- ✅ CORS restricted (no `Access-Control-Allow-Origin: *`)
- ✅ Per-IP rate limit: 60 req/min (persisted via `api_rate_limits` table)
- ✅ No secrets in client HTML/JS
- ✅ Admin endpoints require valid `userId` (regex-checked + role-gated)
- ✅ Zero balance drift on cards, zero leaves drift on accounts (verified daily)

See `ARCHITECTURE.md` for the full security model.

---

## 🔄 Backups

**Two layers:**

1. **Supabase native backups** — automatic daily backups (retention varies by plan: free=7d, Pro=14d + PITR)
2. **Custom backup cron** (Phase 0) — `/api/cron-backup` exports all critical tables to Supabase Storage bucket `backups` as JSON, retained 30 days. Runs daily at 3am PHT.

**To restore from custom backup:**
```bash
# Download backup file from Supabase Storage → backups bucket
# Each file is a JSON with all critical tables snapshotted
# Restore by inserting rows back via PostgREST or SQL
```

---

## 🎯 Common operations

### Add a menu item
1. Insert row in `menu_items` table (with proper `category_id`)
2. Upload item image to `/images/{ITEM_CODE}.{ext}` in repo
3. Commit + push
4. **No code change needed** — menu items load from DB

### Add a menu category
1. Insert row in `menu_categories` table
2. **⚠️ Also update `CATEGORY_ID_TO_NAME` map in `api/pos.js`**
3. Commit + push

### Activate a Yani Card (admin)
1. Admin → Members → Roots Rewards → View Requests
2. Find pending request → click ⚡ Activate & Fulfill
3. System: card status ACTIVE, balance = tier, leaves credited, audit row inserted

### Adjust card balance manually (OWNER only)
1. Admin → Members → Yani Cards → Find card → Edit
2. Enter new balance + reason
3. System logs `ADJUST` transaction with before/after balance

### Run leaves expiry sweep manually
```bash
curl -X POST https://yanigardencafe.com/api/cron-leaves-expiry \
  -H "Authorization: Bearer $CRON_SECRET"
```

### Re-run integrity audit
See SQL in `ARCHITECTURE.md` § Audit Queries.

---

## 🪲 Known gotchas

1. **`CATEGORY_ID_TO_NAME` hardcoded map** — add a category to DB, you must also update the code map. Silent failure otherwise.
2. **Vercel in-memory cache** has 5-min TTL per function instance. Only a fresh deploy flushes it.
3. **Messenger's in-app browser** caches HTML aggressively, sometimes for hours. Test in real Safari/Chrome.
4. **Sales totals count `COMPLETED + READY + PREPARING`** orders — staff don't always click Complete after serving.
5. **Cards earn leaves at LOAD, not consumption** — prepaid semantics. Don't double-count.
6. **Email is the loyalty identity key** (not phone). Phone is contact-only.
7. **Holder data on yani_cards** must be set BEFORE a customer's loyalty account can link to it.

---

## 📚 Further reading

- `ARCHITECTURE.md` — System architecture deep-dive, security model, audit queries
- `TENANT_SETUP.md` — Forward-looking: how to onboard a new tenant when TYG POS SaaS launches
- https://yanigardencafe.com/architecture — Public-facing architecture page (UI version)

---

## 🤝 Contributing / handoff

If you (a future developer or future Claude with no memory) need to make changes:

1. Read this README first
2. Read `ARCHITECTURE.md` for system internals
3. Open `api/pos.js` — search for the action you want to change (look for `if (action === '...')`)
4. Make change → push to `main` → verify live via curl
5. Re-run audit queries from `ARCHITECTURE.md` to confirm no drift
6. Update `ARCHITECTURE.md` if you changed the architecture

**Bus factor mitigation in progress** — refactoring `api/pos.js` into modules is on the Phase 2 backlog.

---

**Owner:** Pia (tygfsb@gmail.com / LEGERYN PIA)
**Repo:** https://github.com/Maldipia/yani-garden-cafe
**Last meaningful README update:** 2026-05-23
