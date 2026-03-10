#!/bin/bash
# YANI Garden Cafe POS — Comprehensive E2E Test Suite
# Tests: pages, APIs, cancel button, menu sync, queue, ordering flow

BASE="https://yanigardencafe.com"
PASS=0; FAIL=0; WARN=0
SUPA_KEY="sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM"
SUPA_URL="https://hnynvclpvfxzlfjphefj.supabase.co"

pass() { echo "  ✅ PASS: $1"; ((PASS++)); }
fail() { echo "  ❌ FAIL: $1"; ((FAIL++)); }
warn() { echo "  ⚠️  WARN: $1"; ((WARN++)); }
section() { echo ""; echo "══ $1 ══"; }

# ── 1. PAGE AVAILABILITY ─────────────────────────────────────────────────────
section "1. Page Availability"
for path in "/" "/admin.html" "/online-order.html"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "$BASE$path")
  [ "$code" = "200" ] && pass "$path → HTTP $code" || fail "$path → HTTP $code"
done

# ── 2. API HEALTH ─────────────────────────────────────────────────────────────
section "2. API Health"
health=$(curl -s "$BASE/api/health" --connect-timeout 10 --max-time 20 2>&1)
if echo "$health" | grep -q '"status"'; then
  pass "Health API responds"
  gas_ok=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('gas',{}).get('ok','?'))" 2>/dev/null)
  supa_ok=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('supabase',{}).get('ok','?'))" 2>/dev/null)
  [ "$gas_ok" = "True" ] && pass "GAS connection: OK" || warn "GAS connection: $gas_ok"
  [ "$supa_ok" = "True" ] && pass "Supabase connection: OK" || warn "Supabase connection: $supa_ok"
  drift=$(echo "$health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('menuSync',{}).get('drift',999))" 2>/dev/null)
  [ "$drift" = "0" ] && pass "Menu sync drift: 0 items" || warn "Menu sync drift: $drift items"
else
  fail "Health API did not respond"
fi

# ── 3. MENU SYNC ──────────────────────────────────────────────────────────────
section "3. Menu Sync (GAS vs Supabase)"
gas_count=$(curl -s -X POST "$BASE/api/pos" -H "Content-Type: application/json" \
  -d '{"action":"getMenu"}' --max-time 20 | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))" 2>/dev/null)
supa_count=$(curl -s "$SUPA_URL/rest/v1/menu_items?is_active=eq.true&select=id" \
  -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" \
  -H "Prefer: count=exact" -o /dev/null -w "%{header_json}" 2>/dev/null | \
  python3 -c "import sys,json; h=json.load(sys.stdin); cr=h.get('content-range',[''])[0]; print(cr.split('/')[-1] if '/' in cr else '?')" 2>/dev/null)
[ "$gas_count" = "$supa_count" ] && pass "GAS=$gas_count items == Supabase=$supa_count items" || \
  warn "GAS=$gas_count items vs Supabase=$supa_count items (drift=$(( ${supa_count:-0} - ${gas_count:-0} )))"

# ── 4. DINE-IN ORDER FLOW ─────────────────────────────────────────────────────
section "4. Dine-In Order Flow (POS API)"
orders=$(curl -s -X POST "$BASE/api/pos" -H "Content-Type: application/json" \
  -d '{"action":"getOrders"}' --max-time 20)
orders_ok=$(echo "$orders" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
orders_count=$(echo "$orders" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('orders',[])))" 2>/dev/null)
[ "$orders_ok" = "True" ] && pass "getOrders: OK ($orders_count orders)" || fail "getOrders failed"

# Test updateOrderStatus with a test order ID (should return ok:true instantly)
update_resp=$(curl -s -X POST "$BASE/api/pos" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","orderId":"TEST-0000","status":"CANCELLED"}' --max-time 10)
update_ok=$(echo "$update_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
[ "$update_ok" = "True" ] && pass "updateOrderStatus: instant response (ok:true)" || fail "updateOrderStatus failed: $update_resp"

# Test invalid status rejection
invalid_resp=$(curl -s -X POST "$BASE/api/pos" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","orderId":"TEST-0000","status":"INVALID"}' --max-time 10)
invalid_ok=$(echo "$invalid_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
[ "$invalid_ok" = "False" ] && pass "Invalid status correctly rejected" || fail "Invalid status not rejected"

# Test missing orderId rejection
missing_resp=$(curl -s -X POST "$BASE/api/pos" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","status":"CANCELLED"}' --max-time 10)
missing_ok=$(echo "$missing_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
[ "$missing_ok" = "False" ] && pass "Missing orderId correctly rejected" || fail "Missing orderId not rejected"

# ── 5. ONLINE ORDER FLOW ──────────────────────────────────────────────────────
section "5. Online Order Flow"
ol_menu=$(curl -s -X POST "$BASE/api/online-order" -H "Content-Type: application/json" \
  -d '{"action":"getMenu"}' --max-time 20)
ol_count=$(echo "$ol_menu" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',[])))" 2>/dev/null)
[ "${ol_count:-0}" -gt 40 ] && pass "Online order getMenu: $ol_count items" || fail "Online order getMenu: only $ol_count items"

# ── 6. ORDER QUEUE ────────────────────────────────────────────────────────────
section "6. Order Queue System"
queue_resp=$(curl -s "$BASE/api/queue-status?action=stats" --max-time 15)
queue_ok=$(echo "$queue_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
[ "$queue_ok" = "True" ] && pass "Queue status API: OK" || fail "Queue status API failed: $queue_resp"

# ── 7. SECURITY CHECKS ────────────────────────────────────────────────────────
section "7. Security"
# Action injection
inject_resp=$(curl -s -X POST "$BASE/api/pos" -H "Content-Type: application/json" \
  -d '{"action":"__proto__"}' --max-time 10)
inject_ok=$(echo "$inject_resp" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok',''))" 2>/dev/null)
[ "$inject_ok" != "True" ] && pass "Action injection blocked" || fail "Action injection not blocked"

# CORS headers
cors=$(curl -s -I "$BASE/api/pos" --max-time 10 | grep -i "access-control")
[ -n "$cors" ] && pass "CORS headers present" || warn "CORS headers missing"

# ── 8. CUSTOM DOMAIN & SSL ───────────────────────────────────────────────────
section "8. Custom Domain & SSL"
ssl_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "https://yanigardencafe.com/")
[ "$ssl_code" = "200" ] && pass "yanigardencafe.com SSL: Valid (HTTP $ssl_code)" || fail "yanigardencafe.com SSL: HTTP $ssl_code"
www_code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "https://www.yanigardencafe.com/" -L)
[ "$www_code" = "200" ] && pass "www.yanigardencafe.com redirects: OK" || warn "www redirect: HTTP $www_code"

# ── SUMMARY ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════"
echo "  RESULTS: $PASS passed | $FAIL failed | $WARN warnings"
echo "══════════════════════════════════════"
[ "$FAIL" -eq 0 ] && echo "  🎉 ALL TESTS PASSED" || echo "  ⚠️  $FAIL TEST(S) FAILED — review above"
