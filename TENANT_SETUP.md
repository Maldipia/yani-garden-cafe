# TYG POS — New Tenant Setup Guide

## What a new tenant needs (30 minutes total)

### Step 1 — Supabase (10 min)
1. Create new Supabase project at supabase.com
2. Run the full schema migration (schema.sql)
3. Copy: Project URL + Service Role Key + Anon Key

### Step 2 — Vercel (10 min)
1. Fork this repo OR create new Vercel project from same GitHub
2. Set environment variables:

```
SUPABASE_URL=https://[their-project].supabase.co
SUPABASE_SECRET_KEY=[their-service-role-key]
SUPABASE_ANON_KEY=[their-anon-key]
JWT_SECRET=[generate: openssl rand -hex 32]
ALLOWED_ORIGINS=https://[their-domain.com]
BUSINESS_NAME=[e.g. "Bean & Brew Cafe"]
BUSINESS_ADDRESS=[e.g. "Tagaytay City, Cavite"]
CRON_SECRET=[generate: openssl rand -hex 16]
```

3. Set custom domain

### Step 3 — Settings table (10 min)
Fill in the `settings` table in their Supabase DB:

| Key | Value |
|-----|-------|
| BUSINESS_NAME | Bean & Brew Cafe |
| ORDER_PREFIX | BB |
| PRIMARY_COLOR | #1a3a2a (or their brand color) |
| LOGO_URL | /images/logo.png (or CDN URL) |
| ADDRESS | Tagaytay City, Cavite |
| ACCOUNT_NAME | Owner's full name |
| GCASH_QR_URL | Their GCash QR image URL |
| BDO_QR_URL | Their BDO QR image URL |
| BPI_QR_URL | Their BPI QR image URL |
| UNIONBANK_QR_URL | Their UnionBank QR URL |
| INSTAPAY_QR_URL | Their InstaPay QR URL |
| BDO_ACCOUNT | Their account number |
| BPI_ACCOUNT | Their account number |
| UNIONBANK_ACCOUNT | Their account number |
| RECEIPT_EMAIL | owner@theirdomain.com |
| SERVICE_CHARGE | 0.10 (10%) or 0 if no service charge |

### Step 4 — Staff PINs
Insert into `staff_users` table with bcrypt-hashed PINs.

### Step 5 — Menu
Add menu items to `menu_items` table.
Upload item images to `/images/` folder.

### Done ✅
Everything else (order flow, payments, receipts, analytics, kitchen dashboard) works automatically.

---
## What's shared across all tenants (zero changes needed)
- Order flow logic
- Payment processing (GCash proof upload, cash/card)
- Discount system (PWD/Senior/Promo)
- Receipt generation
- Analytics & daily reports
- Kitchen dashboard
- JWT auth & role system
- Supabase Realtime
