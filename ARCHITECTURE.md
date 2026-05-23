# YANI Garden Café — System Architecture

Deep-dive technical reference. Complements `README.md` (quickstart) with full system internals, audit procedures, and operational runbooks.

**Last updated:** 2026-05-23
**Maintainer:** Pia (tygfsb@gmail.com)

---

## 1. System architecture (current state)

### 1.1 The four layers

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1 — User-facing static pages                          │
│   index-customer.html  rewards.html  admin.html  kitchen.html│
│   Vanilla JS, no framework. Mobile-first.                   │
└────────────────────────┬────────────────────────────────────┘
                         │ fetch(/api/pos, POST { action })
┌────────────────────────▼────────────────────────────────────┐
│ Layer 2 — Vercel serverless functions                       │
│   api/pos.js   65+ actions, single dispatch entry point     │
│   api/card.js  Yani Card public lookup + activation         │
│   api/cron-*   Scheduled jobs (leaves expiry, backup)       │
│                                                             │
│   Each request flow:                                        │
│     1. CORS check (allowed origins only)                    │
│     2. Rate limit (60 req/min per IP via api_rate_limits)   │
│     3. Auth (if action is privileged → checkAuth(roles))    │
│     4. Validate input                                       │
│     5. Execute via Supabase REST/RPC                        │
│     6. Audit log (for sensitive actions)                    │
│     7. Return JSON                                          │
└────────────────────────┬────────────────────────────────────┘
                         │ PostgREST + RPC
┌────────────────────────▼────────────────────────────────────┐
│ Layer 3 — Supabase Postgres                                 │
│   ~25 tables, 8 RPC functions, 4 views                      │
│   Triggers enforce balance invariants                       │
│   CHECK constraints on enums (status, type, etc.)           │
│   Foreign keys enforce referential integrity                │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│ Layer 4 — Supabase Storage                                  │
│   Bucket "payments"  — customer payment screenshots         │
│   Bucket "backups"   — daily JSON snapshots (30d retention) │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 Why this design

- **No managed servers** — Vercel handles scaling, deployment, SSL. Zero ops on infra.
- **Single source of truth** — Supabase Postgres is the authoritative state. Frontend caches are advisory only.
- **Stateless API** — `api/pos.js` keeps no in-memory state between invocations except a 5-min cache for hot data. Cold starts work fine.
- **Vanilla JS frontend** — No build step. Edit HTML, push, deployed. Easier to debug, easier to hand off, smaller bundles.
- **PostgREST over Postgres** — One auth/permissions model (RLS, JWT) for all data access. Don't reinvent.

---

## 2. Data model

### 2.1 Cards (prepaid + loyalty)

```
┌──────────────────┐         ┌─────────────────────┐
│  yani_cards      │ ←──┐    │ card_transactions   │
│  ─────────────── │    │    │ ─────────────────── │
│  card_number PK  │    └────│ card_id FK          │
│  holder_name     │         │ type (enum)         │
│  holder_email    │         │ amount              │
│  holder_phone    │         │ balance_before      │
│  tier            │         │ balance_after       │
│  status (enum)   │         │ description         │
│  balance         │         │ performed_by        │
│  total_loaded    │         │ created_at          │
│  qr_token        │         └─────────────────────┘
│  activated_at    │
│  created_at      │
└──────────────────┘

Status enum: INACTIVE → ACTIVE ⇄ SUSPENDED → (rarely back to ACTIVE)

Transaction type enum:
  ACTIVATE  Card first time loaded (creates ACTIVE state)
  RELOAD    Owner adds money to existing ACTIVE card
  CHARGE    Customer spends from card on an order
  ADJUST    Owner manually corrects balance (signed amount)
  REVERSE   Reversal of a charge (refund-like)
  EDIT      Holder data change (amount = 0, audit-only)
  SUSPEND   Status change (amount = 0)

Invariant: balance_after = balance_before + (type-signed amount)
           cards.balance = balance_after of latest transaction
```

### 2.2 Loyalty (Roots Rewards / Leaves)

```
┌──────────────────────┐         ┌──────────────────────┐
│  loyalty_accounts    │ ←──┐    │ points_transactions  │
│  ─────────────────── │    │    │ ──────────────────── │
│  id UUID PK          │    └────│ account_id FK        │
│  email (UNIQUE)      │         │ type (enum)          │
│  name                │         │ points               │
│  phone               │         │ balance_before       │
│  points_balance      │         │ balance_after        │
│  total_points_earned │         │ description          │
│  total_points_redeem │         │ created_at           │
│  tier                │         └──────────────────────┘
│  linked_card_number  │
│  card_tier_request   │
│  card_request_status │         ┌──────────────────────┐
│  registration_source │         │  leaf_rewards        │
│  last_earn_at        │         │  ─────────────────── │
│  created_at          │         │  threshold           │
└──────────────────────┘         │  reward_name         │
                                 │  reward_emoji        │
                                 │  description         │
┌──────────────────────┐         └──────────────────────┘
│  leaf_redemptions    │
│  ─────────────────── │
│  account_id FK       │   ← Snapshots reward_name at claim time
│  reward_name (snap)  │     so renames don't break historical claims
│  threshold (snap)    │
│  status              │
│  claimed_at          │
└──────────────────────┘

Earn rule: floor(pre_discount_total / LEAVES_PESOS_PER_LEAF)
  setting LEAVES_PESOS_PER_LEAF = 500 (was 300, migrated 2026-05-23)
  Yani Card LOAD earns leaves; consumption does NOT (prepaid semantics)

Reward ladder (DB-driven via leaf_rewards):
   2 🍃 Free Ice Cream             (₱1,000 loaded)
   5 🍃 Free French Fries          (₱2,500 loaded)
  10 🍃 Free Luntian Bread         (₱5,000 loaded)
  15 🍃 Free French Toast          (₱7,500 loaded)
  25 🍃 Free Crispy Chicken        (₱12,500 loaded)
```

### 2.3 Orders

```
┌──────────────────────┐         ┌──────────────────────┐
│  dine_in_orders      │ ←──┐    │ dine_in_order_items  │
│  ─────────────────── │    │    │ ──────────────────── │
│  order_id PK         │    └────│ order_id FK          │
│  table_number        │         │ item_code            │
│  customer_name       │         │ item_name (snapshot) │
│  customer_email      │         │ unit_price (snap)    │
│  customer_phone      │         │ qty                  │
│  status (enum)       │         │ line_total           │
│  subtotal            │         │ sizes_choice         │
│  discounted_total    │         │ sweetness_choice     │
│  yani_card_number    │         │ notes                │
│  payment_method      │         └──────────────────────┘
│  payment_status      │
│  loyalty_account_id  │
│  ...                 │
└──────────────────────┘

Status: NEW → PREPARING → READY → COMPLETED (or CANCELLED any time)
Payment status: PENDING → SUBMITTED → VERIFIED (or REJECTED)
```

---

## 3. Security model

### 3.1 Auth chains

```
Customer (no auth) ──→ /api/pos action=placeOrder, etc.
                       │
                       ├─ rate limit per IP (60/min)
                       └─ no role check (public endpoints)

Staff (PIN login) ───→ stores currentUser in browser session
                       │
                       └─ frontend passes { userId: 'USR_001' } in every request body
                          │
                          backend api/pos.js: checkAuth([roles]) validates userId
                          ├─ regex check: /^USR_\d{3,6}$/
                          ├─ lookup in staff_users WHERE id = userId AND active = true
                          └─ role check: user.role IN allowed_roles

Cron jobs ──→ Bearer CRON_SECRET in Authorization header
              │
              └─ also accepts POST body { secret } for manual trigger
```

### 3.2 XSS protection (output-side, post-audit 2026-05-23)

All user-supplied strings (holder_name, customerName, notes, etc.) are escaped via `esc()` at every render site:
- `admin-online.js` — main admin escape helper, used in Members/Orders/Loyalty views
- `admin-cards.js` — `_esc()` used in card print preview window
- `admin-core.js` — `esc()` in order summary rows
- `kitchen.html` — local `esc()` for order items

**Test payloads previously verified safe:** `<script>alert(1)</script>`, `'; DROP TABLE yani_cards; --`

### 3.3 SQL injection

PostgREST parameterizes all queries at the protocol level. Even if input contains SQL syntax (e.g., `'; DROP TABLE yani_cards; --` as a holder name), it's treated as literal data, not code. Verified by audit.

### 3.4 Rate limiting

```
Implementation: api_rate_limits table + upsert_rate_limit RPC
Limit:          60 requests / minute / IP
Persistence:    Survives Vercel cold starts (DB-backed)
Fail mode:      Open (never block real traffic on rate-limit errors)
```

### 3.5 CORS

```
Allowed origins:  yanigardencafe.com, admin.yanigardencafe.com, pos.yanigardencafe.com
Allowed methods:  POST, OPTIONS
Allowed headers:  Content-Type, Authorization
Credentials:      Not allowed (no cookies)
```

---

## 4. Audit procedures

### 4.1 Daily integrity check (run before any major change)

```sql
-- 1. Card balance drift
WITH latest_txn AS (
  SELECT DISTINCT ON (card_id) card_id, balance_after
  FROM card_transactions ORDER BY card_id, created_at DESC
)
SELECT yc.card_number, yc.balance, lt.balance_after,
       yc.balance::numeric - lt.balance_after::numeric AS drift
FROM yani_cards yc
LEFT JOIN latest_txn lt ON lt.card_id = yc.id
WHERE yc.status IN ('ACTIVE','SUSPENDED')
  AND ABS(yc.balance::numeric - COALESCE(lt.balance_after::numeric, 0)) > 0.01;

-- 2. Leaves balance drift
SELECT la.email, la.points_balance,
       COALESCE(SUM(CASE WHEN pt.type='EARN' THEN pt.points
                         WHEN pt.type IN ('REDEEM','EXPIRE') THEN -pt.points
                         ELSE 0 END), 0) AS computed
FROM loyalty_accounts la
LEFT JOIN points_transactions pt ON pt.account_id = la.id
GROUP BY la.id, la.email, la.points_balance
HAVING la.points_balance != COALESCE(SUM(CASE WHEN pt.type='EARN' THEN pt.points
                                              WHEN pt.type IN ('REDEEM','EXPIRE') THEN -pt.points
                                              ELSE 0 END), 0);

-- 3. Orphan transactions
SELECT COUNT(*) FROM card_transactions ct
  LEFT JOIN yani_cards yc ON yc.id = ct.card_id WHERE yc.id IS NULL;
SELECT COUNT(*) FROM points_transactions pt
  LEFT JOIN loyalty_accounts la ON la.id = pt.account_id WHERE la.id IS NULL;

-- 4. Invalid linked_card_number
SELECT la.email, la.linked_card_number
FROM loyalty_accounts la
WHERE la.linked_card_number IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM yani_cards yc WHERE yc.card_number = la.linked_card_number);

-- 5. Duplicate emails
SELECT LOWER(email), COUNT(*) FROM loyalty_accounts WHERE email IS NOT NULL
GROUP BY LOWER(email) HAVING COUNT(*) > 1;

-- 6. XSS/SQLi payload residue
SELECT card_number, holder_name FROM yani_cards
WHERE holder_name ~ '(<script|onerror|javascript:|DROP TABLE|UNION SELECT|--$)';
```

**All should return 0 rows / 0 drift on a healthy system.**

### 4.2 What to do if drift is found

1. **Don't panic** — drift means something updated balance directly bypassing transaction log
2. Trace recent activity in `card_transactions` for the affected card
3. Insert an `ADJUST` transaction with the diff to reconcile
4. Update `yani_cards.balance` to match the new `balance_after`
5. Log the reconciliation in `order_audit_logs` with the reason

Example reconciliation (from real history, YANI-1005):
```sql
INSERT INTO card_transactions (card_id, type, amount, balance_before, balance_after,
                               description, performed_by)
VALUES (
  (SELECT id FROM yani_cards WHERE card_number = 'YANI-1005'),
  'ADJUST',
  -1261.26,
  2000.00,
  738.74,
  'Reconcile: real load ₱500 + ₱1500 = ₱2000, minus consumption ₱1261.26',
  'OWNER_RECONCILE'
);
UPDATE yani_cards SET balance = 738.74 WHERE card_number = 'YANI-1005';
```

---

## 5. Cron jobs

### 5.1 Leaves expiry sweep
- **Route:** `/api/cron-leaves-expiry`
- **Schedule:** Daily 18:00 UTC (02:00 PHT)
- **Auth:** Bearer `CRON_SECRET`
- **Function:** Calls `expire_leaves()` RPC which zeroes balances on accounts inactive ≥ 6 months (configurable via `LEAVES_EXPIRY_MONTHS` setting). Logs `EXPIRE` rows in `points_transactions`. Also marks PENDING surprise rewards older than `SURPRISE_REWARD_EXPIRY_DAYS` as EXPIRED.

### 5.2 Daily backup (Phase 0)
- **Route:** `/api/cron-backup`
- **Schedule:** Daily 19:00 UTC (03:00 PHT) — 1 hour after expiry
- **Auth:** Bearer `CRON_SECRET`
- **Function:** Exports critical tables to JSON, uploads to Supabase Storage bucket `backups/backup-YYYY-MM-DD.json`. Retains 30 days, deletes older.
- **Tables backed up:** yani_cards, card_transactions, loyalty_accounts, points_transactions, leaf_redemptions, surprise_rewards, leaf_rewards, dine_in_orders, dine_in_order_items, menu_categories, menu_items, menu_item_addons, settings, order_audit_logs, staff_users

To trigger manually:
```bash
curl -X POST https://yanigardencafe.com/api/cron-backup \
  -H "Authorization: Bearer $CRON_SECRET"
```

---

## 6. Operational runbook

### 6.1 Deploying a change

```bash
# 1. Clone or pull latest
git pull origin main

# 2. Edit code

# 3. If you edited an HTML file with inline JS, syntax-check it
python3 -c "
import re
html = open('FILENAME.html').read()
m = re.search(r'<script>([\s\S]*?)</script>', html)
open('/tmp/check.js','w').write(m.group(1) if m else '')
" && node --check /tmp/check.js

# 4. Commit + push
git add . && git commit -m "your message" && git push origin main

# 5. Wait ~60 seconds for Vercel auto-deploy

# 6. Verify live
curl -s 'https://yanigardencafe.com/path-you-changed' | grep "your change"

# 7. If something looks wrong, immediate rollback:
#    Vercel dashboard → Deployments → previous READY deployment → Promote to Production
```

### 6.2 Adding a new admin action

1. Open `api/pos.js`
2. Find the long `if (action === 'X') { ... } else if (action === 'Y')` chain
3. Add your new block. Pattern:
```js
if (action === 'myNewAction') {
  const auth = await checkAuth(['OWNER','ADMIN'], body.userId);
  if (!auth.ok) return res.status(403).json({ ok: false, error: auth.error });
  // ... your logic ...
  await auditLog({ action: 'MY_NEW_ACTION', actor: { userId: body.userId },
                   details: { ... } });
  return res.status(200).json({ ok: true, ...result });
}
```
4. Add corresponding admin-side fetch in the appropriate `admin-*.js` file
5. Pass `userId: currentUser && currentUser.userId` in the fetch body
6. Test on staging first (once staging is set up)

### 6.3 Restoring from backup

1. Download backup JSON from Supabase Storage → backups bucket
2. Parse JSON. Each top-level key is a table name; value is an array of rows
3. For tables with sensitive uniqueness (yani_cards, loyalty_accounts):
   - Either truncate + re-insert (DESTRUCTIVE — full restore)
   - Or upsert by primary key (SURGICAL — selective restore)
4. Verify with audit queries from § 4.1 after restoration

---

## 7. Performance characteristics

- **Cold start latency:** ~600-900ms (Vercel serverless, Node 18, no native deps)
- **Warm request latency:** ~80-200ms typical (~70% Supabase query time)
- **Cache:** In-memory 5-min TTL for hot data (settings, menu, leaf_rewards). Whitespace commit to README.md busts edge cache.
- **Throughput limit:** 60 req/min/IP (rate-limit), unlimited per-instance (Vercel scales horizontally)
- **DB size:** ~50MB currently (free tier supports up to 500MB)
- **Storage size:** ~2MB images + ~5MB payment screenshots + growing daily backups

---

## 8. Backlog (architecture improvements)

**Phase 1 (operational maturity)**
- [ ] Staging environment (`staging.yanigardencafe.com` + Supabase branch DB)
- [ ] Smoke test suite (curl-based, 15-20 tests, GitHub Actions)
- [ ] Cache-busting via `?v={sha}` on static assets
- [ ] Delete dead code (legacy `_maybeLookupLoyalty`, etc.)

**Phase 2 (architecture refactor)**
- [ ] Break `api/pos.js` into `api/_handlers/{orders,cards,leaves,customers,kitchen,admin,payments}.js`
- [ ] Action registry pattern (replace if/else chain)
- [ ] Eliminate `CATEGORY_ID_TO_NAME` hardcoded map (denormalize via DB trigger)
- [ ] Centralized input validation (Zod schemas)
- [ ] TypeScript on money-touching paths (cards.js, leaves.js)
- [ ] Push more invariants into DB (CHECK constraints, triggers)

**Phase 3 (SaaS prep)**
- [ ] Add `organization_id` column to every table (single-tenant for now)
- [ ] Wrap all data access in `withTenant(orgId)` helper
- [ ] Document tenant onboarding process (see `TENANT_SETUP.md`)

**Phase 4 (TYG POS SaaS — fresh codebase)**
- See `TENANT_SETUP.md` and the broader TYG POS roadmap (Pia's planning doc)
