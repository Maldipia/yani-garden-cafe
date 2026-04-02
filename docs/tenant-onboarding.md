# TYG POS — New Tenant Onboarding Guide
## Time to complete: ~30 minutes

---

## STEP 1 — Create Supabase Project (5 min)
1. Go to https://supabase.com → New Project
2. Name: `[cafe-name]-pos` (e.g. `bloomcafe-pos`)
3. Region: Southeast Asia (Singapore)
4. Password: generate a strong one, save it
5. Wait ~2 min for project to initialize

---

## STEP 2 — Run Migration (3 min)
1. In Supabase → SQL Editor → New Query
2. Paste the contents of `tyg-pos-migration.sql`
3. Click Run
4. Should complete with no errors

---

## STEP 3 — Create Owner Account (2 min)
In SQL Editor, run (replace YOUR_8_DIGIT_PIN):
```sql
INSERT INTO staff_users (user_id, username, display_name, role, pin_hash)
VALUES (
  'USR_001',
  'owner',
  'Owner',
  'OWNER',
  encode(digest('YOUR_8_DIGIT_PIN', 'sha256'), 'hex')
);
```
> Note: The actual PIN hashing uses bcrypt in the API — this is a bootstrap.
> First login will work, then change PIN via admin dashboard.

---

## STEP 4 — Create Vercel Project (5 min)
1. Go to https://vercel.com → Add New Project
2. Import from GitHub: `Maldipia/yani-garden-cafe`
3. Project name: `[cafe-name]-pos`
4. Add these Environment Variables:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | From Supabase → Settings → API |
| `SUPABASE_SECRET_KEY` | From Supabase → Settings → API → service_role key |
| `JWT_SECRET` | Any random 32-char string |
| `ALLOWED_ORIGINS` | `https://[their-domain].com` |

5. Deploy

---

## STEP 5 — Fill Settings Table (10 min)
In Supabase → Table Editor → settings, update these rows:

| Key | Value |
|-----|-------|
| `BUSINESS_NAME` | e.g. `Bloom Cafe` |
| `ORDER_PREFIX` | e.g. `BLOOM` |
| `ADDRESS` | Full address |
| `ACCOUNT_NAME` | GCash account name |
| `GCASH_QR_URL` | Upload to storage, paste URL |
| `BDO_ACCOUNT` | If applicable |
| `BDO_QR_URL` | If applicable |
| `BPI_ACCOUNT` | If applicable |
| `BPI_QR_URL` | If applicable |
| `UNIONBANK_ACCOUNT` | If applicable |
| `UNIONBANK_QR_URL` | If applicable |
| `PRIMARY_COLOR` | Brand hex color |
| `LOGO_URL` | Upload logo to storage |
| `RECEIPT_EMAIL` | Owner's email for daily report |
| `OR_NUMBER_START` | Starting OR# (e.g. 1001) |
| `OR_NUMBER_CURRENT` | Same as start |

---

## STEP 6 — Add Their Domain (3 min)
1. Vercel → Project → Settings → Domains
2. Add `pos.[theirdomain].com`
3. They add a CNAME record in their DNS: `pos` → `cname.vercel-dns.com`
4. SSL provisions automatically

---

## STEP 7 — Upload Menu (varies)
1. Log in to admin with OWNER PIN
2. Menu tab → Add categories first (Hot, Cold, Pastry, etc.)
3. Add menu items with prices and photos
4. Or: bulk insert via SQL if they have a spreadsheet

---

## STEP 8 — Print Table QR Codes
1. Go to admin → Tables tab
2. Each table has a QR code → print and laminate

---

## STEP 9 — Add Staff Accounts
In admin → Staff tab, create accounts for:
- CASHIER (can process payments, apply discounts)
- KITCHEN (can update order status only)
- ADMIN (full access except settings)

---

## PRICING (your cost to deliver)
| Item | Cost |
|------|------|
| Supabase (free tier) | ₱0/mo for <500MB, <50k monthly active users |
| Vercel (hobby) | ₱0/mo |
| Your time to onboard | ~1 hour |

**Suggested price to tenant:** ₱499–₱999/month (Starter tier)

---

## TENANT SELF-SERVICE (after onboarding)
Tenant can manage themselves:
- Add/edit/disable menu items
- Manage staff PINs
- View orders and analytics
- Adjust inventory stock levels
- Open/close cash sessions
- Trigger daily reports manually
