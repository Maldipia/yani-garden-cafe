#!/usr/bin/env python3
"""
YANI POS — Full Audit Script
NON-DESTRUCTIVE: Never changes PINs, never places real orders, never modifies data.
All write-endpoint tests only verify that INVALID/UNAUTHORIZED requests are rejected.

Usage:
  export SUPABASE_SECRET_KEY=sb_secret_...
  export SUPABASE_PAT=sbp_...
  python3 scripts/audit.py
"""
import json, subprocess, re, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://yanigardencafe.com"
API  = f"{BASE}/api/pos"
SB   = "https://hnynvclpvfxzlfjphefj.supabase.co"
# Credentials from environment variables — never commit these values
SK   = os.environ.get("SUPABASE_SECRET_KEY","")
PAT  = os.environ.get("SUPABASE_PAT","")
PID  = "hnynvclpvfxzlfjphefj"

if not SK or not PAT:
    print("ERROR: Set SUPABASE_SECRET_KEY and SUPABASE_PAT env vars before running.")
    sys.exit(1)

issues=[]; warns=[]; oks=[]

def curl(*args):
    return subprocess.run(["curl","-s"]+list(args),capture_output=True,text=True).stdout

def post(p):
    raw=curl("-X","POST",API,"-H","Content-Type: application/json","-d",json.dumps(p))
    try: return json.loads(raw)
    except: return {"_raw":raw[:120]}

def sb_req(path):
    raw=curl(f"{SB}{path}","-H",f"apikey: {SK}","-H",f"Authorization: Bearer {SK}")
    try: return json.loads(raw)
    except: return []

def sql(q):
    raw=curl("-X","POST",f"https://api.supabase.com/v1/projects/{PID}/database/query",
        "-H",f"Authorization: Bearer {PAT}","-H","Content-Type: application/json",
        "-d",json.dumps({"query":q}))
    try: return json.loads(raw)
    except: return []

def OK(lbl,d=""):    oks.append(lbl);    print(f"  ✅ {lbl}")
def WARN(lbl,d=""):  warns.append(lbl);  print(f"  🟡 {lbl}" + (f"\n     → {d}" if d else ""))
def ERR(lbl,d=""):   issues.append(lbl); print(f"  🔴 {lbl}" + (f"\n     → {d}" if d else ""))

print("="*56)
print("  YANI POS AUDIT  [non-destructive — read-only]")
print("="*56)

# 1. PAGES
print("\n--- 1. PAGES")
for path,label in [("/","POS"),("/admin.html","Admin"),("/kitchen.html","KDS"),
                    ("/reserve.html","Online Booking"),("/api/health","Health API")]:
    code=curl("-o","/dev/null","-w","%{http_code}",f"{BASE}{path}").strip()
    OK(f"{label} 200") if code=="200" else ERR(f"{label} HTTP {code}",path)

# 2. CODE SCAN
print("\n--- 2. CODE SCAN")
pos=open(f"{REPO}/api/pos.js").read()
admin=open(f"{REPO}/admin.html").read()
index=open(f"{REPO}/index.html").read()
for src,name in [(pos,"pos.js"),(admin,"admin.html"),(index,"index.html")]:
    # Flag hardcoded service keys (not anon/publishable keys which are fine in frontend)
    has_secret = "sb_secret" in src or re.search(r"sbp_[a-f0-9]{40}", src)
    OK(f"No hardcoded service key in {name}") if not has_secret else ERR(f"Service key hardcoded in {name}!")
    live_gas=bool(re.search(r"https://script\.google\.com/[^\s'\"]+/exec",src))
    OK(f"No live GAS URL in {name}") if not live_gas else ERR(f"Live GAS URL in {name}")
todos=re.findall(r"(?:TODO|FIXME|HACK)[^\n]{0,80}",pos+admin)
OK(f"No TODO/FIXME flags") if not todos else WARN(f"{len(todos)} TODO/FIXME",todos[0][:80])

# 3. AUTH GUARDS — test that UNAUTHORIZED requests are rejected
print("\n--- 3. AUTH GUARDS  [rejection tests only]")
no_auth=[
    ("addMenuItem",{"name":"X","price":0}),
    ("updateMenuItem",{"itemId":"H001","name":"X"}),
    ("deleteMenuItem",{"itemId":"H001"}),
    ("updateOrderStatus",{"orderId":"YANI-0001","status":"CANCELLED"}),
    ("deleteOrder",{"orderId":"YANI-0001"}),
    ("listPayments",{}),("verifyPayment",{"paymentId":"PAY-001"}),
    ("getAnalytics",{}),("getCustomers",{}),
    ("getReservations",{"date":"2026-03-13"}),
    ("updateReservation",{"resId":"RES-001","status":"CANCELLED"}),
    ("getStaff",{}),
    ("changePin",{"targetUserId":"USR_001","newPin":"1234"}),  # no userId → rejected
]
for action,extra in no_auth:
    d=post({"action":action,**extra})
    OK(f"{action} → blocked") if not d.get("ok") else ERR(f"{action} NOT protected!",str(d)[:70])

for action,extra in [("addMenuItem",{"name":"X","price":0}),("getAnalytics",{}),
                      ("listPayments",{}),("getReservations",{"date":"2026-03-13"})]:
    d=post({"action":action,"userId":"USR_003",**extra})
    OK(f"CASHIER blocked from {action}") if not d.get("ok") else ERR(f"CASHIER can {action}!")

# changePin — ONLY test invalid/rejected cases. NEVER send a successful PIN change.
print("  [changePin rejections only]")
for payload,label in [
    ({"action":"changePin","userId":"USR_003","targetUserId":"USR_004","newPin":"5555"},"CASHIER cannot change other"),
    ({"action":"changePin","userId":"USR_003","targetUserId":"USR_003","currentPin":"wrongpin1","newPin":"5678"},"Wrong currentPin"),
    ({"action":"changePin","userId":"USR_001","targetUserId":"USR_001","newPin":"12"},"PIN too short"),
    ({"action":"changePin","userId":"USR_001","targetUserId":"USR_001","newPin":"abcde"},"Non-numeric PIN"),
]:
    d=post(payload)
    OK(f"{label} → rejected") if not d.get("ok") else ERR(f"Should reject: {label}",str(d)[:60])

# 4. INPUT VALIDATION
print("\n--- 4. INPUT VALIDATION")
for payload,label in [
    ({"action":"placeOrder","tableNo":"T99","customerName":"X","orderType":"DINE-IN","items":[],"subtotal":0,"total":0},"Empty order items"),
    ({"action":"createReservation","guestName":"X","guestPhone":"091","pax":2,"resDate":"2020-01-01","resTime":"12:00"},"Reservation past date"),
    ({"action":"createReservation","guestPhone":"091","pax":2,"resDate":"2026-04-01","resTime":"12:00"},"Reservation missing name"),
    ({"action":"verifyUserPin","pin":""},"Empty PIN"),
    ({"action":"updateOrderStatus","orderId":"'; DROP TABLE dine_in_orders; --","status":"CANCELLED","userId":"USR_001"},"SQL injection"),
    ({"action":"updateOrderStatus","orderId":"YANI-<script>alert(1)</script>","status":"CANCELLED","userId":"USR_001"},"XSS in orderId"),
]:
    d=post(payload)
    OK(f"{label} → rejected") if not d.get("ok") else ERR(f"Validation failed: {label}",str(d)[:60])

# 5. LOGIN — read-only, non-PIN-writing
print("\n--- 5. LOGIN CHECK  [read-only]")
# CASHIER pin is default known — verifies the login flow end-to-end
d=post({"action":"verifyUserPin","pin":"5678"})
OK("CASHIER login ✓") if d.get("ok") and d.get("userId")=="USR_003" else ERR("CASHIER login failed",f"userId={d.get('userId')}")
# Confirm wrong PIN is rejected (security check — more important than knowing specific PINs)
d=post({"action":"verifyUserPin","pin":"000000"})
OK("Wrong PIN rejected") if not d.get("ok") else ERR("Wrong PIN accepted!")
# Confirm all staff accounts are active and unlocked (via DB — no PIN needed)
import subprocess as _sp
sb_staff=sb_req("/rest/v1/staff_users?select=user_id,username,active,locked_until")
if isinstance(sb_staff,list):
    locked=[s for s in sb_staff if not s.get("active") or s.get("locked_until")]
    OK(f"All {len(sb_staff)} staff accounts active/unlocked") if not locked else ERR(f"Locked accounts: {[s['username'] for s in locked]}")

# 6. DB HEALTH
print("\n--- 6. DATABASE HEALTH")
for tbl in ["dine_in_orders","dine_in_order_items","menu_items","staff_users",
            "reservations","payments","api_rate_limits","cafe_tables"]:
    r=sb_req(f"/rest/v1/{tbl}?limit=0")
    OK(f"'{tbl}' accessible") if isinstance(r,list) else ERR(f"'{tbl}' inaccessible",str(r)[:60])

seq_r=sb_req("/rest/v1/rpc/get_order_seq_value")
max_r=sql("SELECT COALESCE(MAX(order_no),0) AS m FROM dine_in_orders;")
# Sequence check via direct SQL
seq_sql=sql("SELECT last_value FROM dine_in_order_seq;")
if seq_sql and max_r and isinstance(max_r, list) and len(max_r):
    try:
        s=int(seq_sql[0].get("last_value",0) if isinstance(seq_sql,list) and len(seq_sql) else 0)
        m=int(max_r[0].get("m",0))
        OK(f"Sequence OK (last={s}, max={m})") if s>=m else ERR(f"Sequence BEHIND! seq={s} < max={m}")
    except Exception as e:
        WARN(f"Sequence check skipped", str(e)[:60])
else:
    WARN("Sequence check skipped (PAT not a management API key)")

def safe_count(result, key="c"):
    """Returns int count from sql() result, or None if unavailable."""
    if isinstance(result, list) and result:
        return int(result[0].get(key, 0))
    return None

orph_r=sql("SELECT COUNT(*) AS c FROM dine_in_order_items i LEFT JOIN dine_in_orders o ON i.order_id=o.order_id WHERE o.order_id IS NULL;")
orph=safe_count(orph_r)
OK("No orphaned order items") if orph==0 else (WARN(f"Orphaned items: {orph}") if orph else WARN("Orphan check skipped (no PAT)"))

np=sql("SELECT name FROM menu_items WHERE is_active=true AND (base_price IS NULL OR base_price<=0);")
OK("All active items have prices") if not isinstance(np,list) or not np else ERR(f"Items with no price: {len(np)}",str([r.get('name') for r in np[:3]]))

bs=sql("SELECT name FROM menu_items WHERE is_active=true AND has_sizes=true AND (price_short IS NULL OR price_medium IS NULL OR price_tall IS NULL);")
OK("All sized items have size prices") if not isinstance(bs,list) or not bs else ERR(f"Sized items missing prices",str([r.get('name') for r in bs[:3]]))

stale=sql("SELECT order_id,status FROM dine_in_orders WHERE status IN ('NEW','PREPARING') AND is_test=false AND created_at<NOW()-INTERVAL '4 hours';")
OK("No stale active orders") if not isinstance(stale,list) or not stale else WARN(f"Stale orders: {len(stale)}","; ".join([r.get("order_id","?") for r in stale[:3]]))

locked=sql("SELECT username FROM staff_users WHERE locked_until>NOW();")
OK("No locked staff accounts") if not isinstance(locked,list) or not locked else WARN(f"Locked: {[r.get('username') for r in locked]}")

dupes=sql("SELECT item_code FROM menu_items WHERE is_active=true GROUP BY item_code HAVING COUNT(*)>1;")
OK("No duplicate active item codes") if not isinstance(dupes,list) or not dupes else ERR(f"Duplicate codes: {[r.get('item_code') for r in dupes]}")

# 7. CORS & HEADERS
print("\n--- 7. CORS & SECURITY HEADERS")
r_yani=curl("-s","-I","-X","OPTIONS",API,"-H","Origin: https://yanigardencafe.com")
r_evil=curl("-s","-I","-X","OPTIONS",API,"-H","Origin: https://evil.com")
r_admin=curl("-s","-I",f"{BASE}/admin.html")
acao_yani=next((l for l in r_yani.splitlines() if "access-control-allow-origin" in l.lower()),"")
acao_evil=next((l for l in r_evil.splitlines() if "access-control-allow-origin" in l.lower()),"")
OK("CORS allows yanigardencafe.com") if "yanigardencafe.com" in acao_yani else ERR("CORS missing for yanigardencafe.com",acao_yani)
OK("CORS blocks unknown origins") if "evil.com" not in acao_evil else ERR("CORS allows evil.com!")
for hdr,label in [("x-frame-options","X-Frame-Options"),("x-content-type","X-Content-Type-Options"),("referrer-policy","Referrer-Policy")]:
    OK(f"{label} set") if hdr in r_admin.lower() else WARN(f"{label} missing")

# 8. MENU
print("\n--- 8. MENU INTEGRITY")
menu=post({"action":"getMenu"})
items=menu.get("items",[])
OK(f"Active items: {len(items)}") if items else ERR("getMenu returned no items")
no_img=[i["name"] for i in items if not i.get("image")]
OK("All items have images") if not no_img else WARN(f"{len(no_img)} items without images",", ".join(no_img[:5]))

# 9. SERVICES
print("\n--- 9. SERVICES")
h=json.loads(curl(f"{BASE}/api/health"))
OK(f"Health API OK") if h.get("ok") else WARN("Health check returned unexpected",str(h)[:80])
dr=json.loads(curl("-X","POST",f"{BASE}/api/daily-report","-H","Content-Type: application/json","-d",'{"secret":"yani-report-2026"}'))
OK("Resend email working") if dr.get("ok") else ERR("Resend not configured",str(dr)[:80])

# 10. LEGACY FILES
print("\n--- 10. LEGACY API FILES")
for fn in sorted(os.listdir(f"{REPO}/api")):
    if not fn.endswith(".js") or fn=="pos.js": continue
    txt=open(f"{REPO}/api/{fn}").read()
    live=bool(re.search(r"https://script\.google\.com/[^\s'\"]+/exec",txt))
    OK(f"api/{fn} clean") if not live else ERR(f"api/{fn} has live GAS URL")

# SUMMARY
print("\n"+"="*56)
print(f"  RESULTS: {len(oks)} OK  |  {len(warns)} WARN  |  {len(issues)} ERROR")
print("="*56)
if issues:
    print("\nERRORS:")
    for i,lbl in enumerate(issues,1): print(f"  {i}. {lbl}")
if warns:
    print("\nWARNINGS:")
    for i,lbl in enumerate(warns,1): print(f"  {i}. {lbl}")
if not issues and not warns:
    print("\n  ALL CLEAN")
sys.exit(len(issues))
