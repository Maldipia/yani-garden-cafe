# YANI Inventory & Production Module — API Specification

Isolated module. All new objects use the `inv_` prefix. No existing table,
API, or business rule was modified. Transport reuses the existing POS router:
`POST /api/pos` with `{ action, ...params }` and `Authorization: Bearer <jwt>`.

---

## 1. Endpoint list

All 25 actions dispatch through `routeInventory` in `api/handlers/inventory.js`,
registered **last** in `api/pos.js` so it can never shadow an existing action.

| Group | Action | Purpose |
|---|---|---|
| Meta | `invGetConfig` | Read all feature flags |
| Meta | `invSetConfig` | Write one flag (OWNER) |
| Meta | `invGetRefData` | Units, locations, suppliers, item types |
| Items | `invListItems` | List, filter by type |
| Items | `invSaveItem` | Create or update |
| Items | `invArchiveItem` | Soft-archive (OWNER) |
| Recipes | `invListRecipes` | List with nested lines |
| Recipes | `invSaveRecipe` | Upsert head + replace lines |
| Recipes | `invArchiveRecipe` | Soft-archive |
| Stock | `invReceiveStock` | Purchase / receive |
| Stock | `invListStockUnits` | Browse stock units |
| Stock | `invStockUnitHistory` | Full ledger for one unit |
| Stock | `invConsumptionQueue` | FEFO/FIFO recommendation |
| Stock | `invAdjustStock` | Waste / adjust / count / transfer / return |
| Stock | `invConsumeOverride` | Consume a specific unit out of order |
| Production | `invProduce` | Run a recipe |
| Production | `invListProductionBatches` | Batch history |
| Portioning | `invPortion` | Whole → portions |
| Sale | `invConsumeOrder` | Deduct for an order (flag-gated) |
| Sale | `invListMenuMap` | Bridge rows |
| Sale | `invSaveMenuMap` | Upsert bridge row |
| Reports | `invDashboard` | Value, counts, low stock, expiring, recent |
| Reports | `invLowStock` | Lowest remaining |
| Reports | `invExpiringSoon` | Expiry horizon (1–90 days) |
| Reports | `invTransactions` | Filterable audit ledger |

---

## 2. Request / response structures

Envelope is uniform: success `{ ok: true, ... }`, failure `{ ok: false, error: "..." }`.

### invReceiveStock
```json
{ "action": "invReceiveStock", "itemId": 12, "qty": 20, "unitId": 3,
  "unitCost": 60, "supplierId": null, "locationId": 1,
  "expiryDate": "2026-09-20", "expectedUseDate": "2026-09-10",
  "splitUnits": false, "notes": "delivery #482" }
```
```json
{ "ok": true, "units_created": 1, "stock_unit_id": 41,
  "stock_unit_code": "PR-2003", "stock_unit_ids": [41],
  "stock_unit_codes": ["PR-2003"], "batch_id": 7 }
```
`splitUnits: true` creates N separate physical units (`RM-1001`, `RM-1002`, …)
instead of one merged record, per §5.
`expectedUseDate` is **planning metadata only** and never deducts, per §6.

### invProduce
```json
{ "action": "invProduce", "recipeId": 5, "qty": 1,
  "expiryDate": "2026-09-06", "notes": "morning bake" }
```
Success:
```json
{ "ok": true, "production_batch_id": 3, "stock_unit_id": 44,
  "stock_unit_code": "PROD-4007", "qty": 1,
  "total_cost": 412.5, "cost_per_unit": 412.5, "shortfalls": [] }
```
Insufficient ingredients (HTTP 400, **nothing written**):
```json
{ "ok": false, "error": "insufficient_ingredients",
  "missing": [ { "ingredient": "Eggs", "required": 4, "available": 1, "short": 3 } ] }
```

### invPortion
```json
{ "action": "invPortion", "stockUnitId": 44, "portions": 4 }
```
```json
{ "ok": true, "parent_code": "PROD-4007", "child_stock_unit_id": 45,
  "child_code": "PROD-4007-S", "portions_available": 4 }
```

### invAdjustStock
```json
{ "action": "invAdjustStock", "stockUnitId": 41,
  "adjustType": "waste", "qtyChange": -100, "reason": "spoiled overnight" }
```
`reason` is mandatory — inventory is never changed silently (§13).
`adjustType: "count"` treats `qtyChange` as the **absolute counted value** and
logs the variance.

### invConsumeOrder
```json
{ "action": "invConsumeOrder", "orderId": "YANI-5661", "dryRun": false }
```
```json
{ "ok": true, "order_id": "YANI-5661", "direct_lines": 1,
  "recipe_deductions": 6, "skipped": 2, "cogs": 84.2, "shortfalls": [] }
```
Flag off: `{ "ok": true, "skipped": "module_disabled" }`
Replay: `{ "ok": true, "already_consumed": true, "order_id": "YANI-5661" }`

### invConsumeOverride
```json
{ "action": "invConsumeOverride", "stockUnitId": 39, "qty": 1, "unitId": 3,
  "overrideReason": "front unit damaged, using back stock" }
```
Rejected without a reason: `{ "ok": false, "error": "override_reason_required" }`

---

## 3. RPC list

| RPC | Purpose | Security |
|---|---|---|
| `inv_cfg(key)` | Read a feature flag | DEFINER, authenticated |
| `inv_convert(qty, from, to)` | Unit conversion, same type only | DEFINER, authenticated |
| `inv_next_stock_code(type)` | `RM-` / `PR-` / `PREP-` / `PROD-` codes | DEFINER, authenticated |
| `inv_consume_item(...)` | FEFO/FIFO multi-unit consumption engine | DEFINER, authenticated |
| `inv_consume_from_unit(...)` | Manual override, reason mandatory, always logged | DEFINER, authenticated |
| `inv_receive_stock(...)` | Purchase/receive, optional unit splitting | DEFINER, authenticated |
| `inv_produce(...)` | Pre-flight validate → deduct → create finished stock | DEFINER, authenticated |
| `inv_portion(...)` | Whole → portions, parent retired | DEFINER, authenticated |
| `inv_adjust_stock_unit(...)` | Waste/adjust/count/transfer/return | DEFINER, authenticated |
| `inv_consume_order(...)` | Sale deduction, flag-gated + idempotent | DEFINER, authenticated |
| `inv_selftest()` | 20-case regression suite | **service_role only** |

`anon` has `EXECUTE` revoked on every one. View `inv_v_consumption_queue`
exposes the FEFO/FIFO recommendation with a `consume_rank` and a `rule` column.

---

## 4. Authentication / authorization

- Transport auth is the existing JWT path (`verifyToken` → `buildAuthCtx`).
  Nothing in the auth layer was modified.
- **Every** inventory action calls `checkAdminAuth()` → `ADMIN` or `OWNER`.
  There is no anonymous or cashier surface.
- OWNER-only: `invSetConfig`, `invArchiveItem`, and the `allowShortfall`
  flag on `invProduce` (a non-owner requesting it is silently downgraded to
  a strict run rather than being granted the privilege).
- Actor identity flows from the JWT into `performed_by` / `created_by`, which
  are constrained to `^USR_\d{3,6}$` or `SYSTEM`.
- All `inv_*` tables have RLS enabled and `DELETE`/`TRUNCATE` revoked from
  `anon` and `authenticated`. The two ledgers additionally have `UPDATE`
  revoked — they are strictly append-only.

---

## 5. Feature-flag behaviour

| Key | Default | Effect |
|---|---|---|
| `module_enabled` | `false` | Master switch. `inv_consume_order` returns `skipped` and writes nothing. |
| `auto_deduct_on_sale` | `false` | Whether the POS hook calls the module at all. |
| `deduct_trigger` | `COMPLETED` | Which order status fires deduction. |
| `costing_method` | `FEFO` | `FEFO` or `FIFO`. |
| `allow_negative` | `true` | Warn vs hard-fail on shortfall during sale. |
| `default_location` | `Main Storage` | Fallback location. |

With `module_enabled = false` the POS behaves exactly as it does today.
Setup, mapping, and reporting endpoints remain usable while disabled, so the
whole module can be configured before anything goes live. Reversible at any
time by flipping the flag back — no data is destroyed.

---

## 6. Error handling

| Condition | HTTP | Body |
|---|---|---|
| Not ADMIN/OWNER | 403 | `{ ok:false, error:"Unauthorized: insufficient role" }` |
| OWNER-only action | 403 | `{ ok:false, error:"OWNER only" }` |
| Missing/invalid param | 400 | `{ ok:false, error:"<field> required" }` |
| Business rule refusal | 400 | `{ ok:false, error:"insufficient_ingredients", missing:[...] }` |
| Duplicate item_code | 400 | `{ ok:false, error:"item_code already exists" }` |
| Infrastructure failure | 500 | `{ ok:false, error:"<operation> failed" }` |

Business refusals are 400, not 500 — a caller can distinguish "you asked for
something invalid" from "the database is down". Incompatible unit conversions
`RAISE EXCEPTION` and roll the whole call back.

---

## 7. Transaction / rollback behaviour

Each RPC is a single PL/pgSQL function, so it runs in one implicit
transaction: any `RAISE` unwinds every write in that call.

`inv_produce` is explicitly two-phase:
1. **Pre-flight** — loop every ingredient, convert to base units, sum available
   stock, collect shortfalls. **No writes.**
2. If anything is short and `allowShortfall` is false, return `ok:false` before
   touching a single row.
3. Only then deduct, create the production batch, create the finished stock
   unit, and write the ledger.

This satisfies §9's "no partial production transactions" — a failed production
leaves zero rows behind, verified by test T5.

Row-level locking: `inv_consume_item`, `inv_portion`, `inv_adjust_stock_unit`,
and `inv_consume_from_unit` all take `FOR UPDATE` on the stock units they
touch, so concurrent sales cannot double-spend the same unit.

---

## 8. Idempotency strategy

`stock_consumption_guard` has `order_id` as its **primary key**. Every
non-dry-run `inv_consume_order` begins with:

```sql
INSERT INTO stock_consumption_guard(order_id, actor_id)
VALUES (p_order_id, p_actor) ON CONFLICT (order_id) DO NOTHING;
```

Zero rows inserted means the order was already consumed, and the function
returns `already_consumed: true` without deducting. The guard is claimed
inside the same transaction as the deduction, so a crash mid-deduction rolls
the guard back too — no order can be left half-consumed and permanently
blocked. Verified by T17.

`dryRun: true` bypasses the guard entirely and writes nothing.

---

## 9. Existing-system dependency map

**What the module reads from existing tables (read-only, no locks held):**

| Existing object | Read by | Purpose |
|---|---|---|
| `dine_in_order_items` | `inv_consume_order` | Order lines to deduct |
| `menu_items.item_code` | `inv_menu_map` (value copy) | Bridge key — **no FK, no writes** |

**What the module writes to existing tables:** nothing, with one exception —
`stock_consumption_guard`, which is itself a table this project created.

**Dependency check on the columns added in the earlier turn:**

| Check | Result |
|---|---|
| `pg_views` / matviews | 0 references |
| `pg_proc` | Self-references only (the 4 v1 RPCs) |
| `pg_trigger` | 0 references |
| `pg_policy` | 0 references |
| `pg_indexes` | 0 references |
| Repo grep, all `.js` / `.html` | 0 references to `stock_mode`, `yield_pct`, `stock_type`, `track_stock`, or any v1 RPC |

`stock_qty`, `low_stock_threshold`, and `last_restocked_at` **do** appear in
`api/handlers/orders.js`, `api/handlers/admin-ops.js`, `api/low-stock.js`,
`admin.js`, and `admin-costing.js` — but every one of those reads the
**`inventory`** table, never `costing_ingredients`. Confirmed line by line.

**One live exposure found and not yet reverted** — see Stage 1 of
`inv-module-rollback.sql`. 23 rows were added to `inventory` in the earlier
turn; `orders.js:376-399` reads that table on every order and would deduct
them. No deduction has fired yet (0 log rows since insert) and `auto_disable`
is false on all 23, so nothing can be pulled off the menu. Recommended
reversion, staged and awaiting approval.

---

## 10. Test results — 20 / 20 pass

Harness: `SELECT * FROM inv_selftest();` — builds fixtures, asserts, tears
itself down. Re-runnable. Residue after run verified as zero.

| # | Test | Expected | Result |
|---|---|---|---|
| 1 | Purchased-ready sale | 20 → sell 1 → 19 pc | ✅ |
| 2 | Unit conversion | 1 L → use 180 ml → 820 ml | ✅ |
| 3 | Countable | 30 eggs → use 2 → 28 | ✅ |
| 4 | Partial weight usage | 500 g → use 100 → 400 g | ✅ |
| 5 | Production blocked when short | `ok:false`, 0 rows written | ✅ |
| 6 | Sub-recipe batch | → 1,000 g sauce, choc 1000 → 500 g | ✅ |
| 7 | Prep used by another recipe | sauce 1000 → 970 g | ✅ |
| 8 | Production | cake created, eggs 28 → 24 | ✅ |
| 9 | Portioning | 1 whole → 0 whole (`portioned`) + 4 slices | ✅ |
| 10 | Slice sale | 4 → 3 slices | ✅ |
| 11 | Wastage | 400 g → waste 100 → 300 g | ✅ |
| 12 | FEFO | near-expiry unit drained first | ✅ |
| 13 | FIFO (no expiry) | oldest consumed, newer untouched | ✅ |
| 14 | Expected-use date | 200 g untouched — planning only | ✅ |
| 15 | Split physical units | 3 separate stock units | ✅ |
| 16 | Feature flag off | `skipped: module_disabled` | ✅ |
| 17 | Duplicate sale / retry | `already_consumed: true`, no double deduct | ✅ |
| 18 | Manual override | consumed + override row logged | ✅ |
| 19 | Override without reason | rejected | ✅ |
| 20 | Audit trail | 36 ledger rows across the run | ✅ |

**One real bug caught by the suite:** `inv_receive_stock` built `batch_code`
from `now()`, which is frozen for the whole transaction — two receives in one
call collided on the unique constraint. Fixed with `clock_timestamp()` plus a
dedicated sequence.

**POS baseline, before and after the full run — unchanged:**

| Metric | Value |
|---|---|
| `dine_in_orders` | 3,638 |
| completed | 2,948 |
| `dine_in_order_items` | 11,857 |
| `online_orders` | 29 |
| active `menu_items` | 88 |
| `inventory_log` | 1,523 |
| `costing_recipe_ingredients` | 273 (all preserved) |

---

## Not yet done

- The `orders.js` sale hook is **not written**. Integrating it means editing an
  existing file, so it is staged as a reviewable patch rather than applied.
  Shape: `try { if (flag) await rpc('inv_consume_order', ...) } catch {}` —
  fire-and-forget, so an inventory fault can never fail an order (§8).
- 8 UI pages.
- Role permission rows in `role_permissions` for the 25 new actions (currently
  they fall back to the handler's own `ADMIN`/`OWNER` gate, which is correct
  but not yet configurable from the admin screen).
