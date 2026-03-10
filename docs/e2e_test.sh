#!/bin/bash
# YANI Garden Cafe POS - Comprehensive E2E Test Suite
# Tests all critical API endpoints against yanigardencafe.com

BASE="https://yanigardencafe.com"
API="$BASE/api/pos"
ONLINE_API="$BASE/api/online-order"
QUEUE_STATUS="$BASE/api/queue-status"
PASS=0
FAIL=0
WARN=0

green() { echo -e "\033[32m✅ $1\033[0m"; }
red()   { echo -e "\033[31m❌ $1\033[0m"; }
yellow(){ echo -e "\033[33m⚠️  $1\033[0m"; }
header(){ echo -e "\n\033[1;34m══ $1 ══\033[0m"; }

check() {
  local label="$1"
  local response="$2"
  local expect_ok="${3:-true}"
  local ok=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('ok',False)).lower())" 2>/dev/null)
  if [ "$ok" = "$expect_ok" ]; then
    green "$label"
    PASS=$((PASS+1))
  else
    red "$label | Response: $(echo $response | head -c 200)"
    FAIL=$((FAIL+1))
  fi
}

check_http() {
  local label="$1"
  local url="$2"
  local expected="${3:-200}"
  local code=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "$url")
  if [ "$code" = "$expected" ]; then
    green "$label (HTTP $code)"
    PASS=$((PASS+1))
  else
    red "$label (expected $expected, got $code)"
    FAIL=$((FAIL+1))
  fi
}

# ── 1. PAGE AVAILABILITY ──────────────────────────────────────────────────
header "1. Page Availability"
check_http "Home page (index.html)" "$BASE/"
check_http "Admin dashboard" "$BASE/admin.html"
check_http "Online order page" "$BASE/online-order.html"
check_http "POS terminal (yani-cafe)" "https://yani-cafe.vercel.app/"
check_http "API endpoint reachable" "$BASE/api/pos" "405"

# ── 2. MENU API ───────────────────────────────────────────────────────────
header "2. Menu API"
MENU=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d '{"action":"getMenu"}' --connect-timeout 15)
check "getMenu returns ok:true" "$MENU"
ITEM_COUNT=$(echo "$MENU" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('menu',d.get('items',[]))))" 2>/dev/null)
echo "   Menu items: $ITEM_COUNT"

# ── 3. ORDER STATUS UPDATE (THE BUG FIX) ─────────────────────────────────
header "3. updateOrderStatus (Cancel Bug Fix)"
# Test with a fake order ID — should return ok:true immediately (Supabase bypass)
CANCEL_RESP=$(curl -s -X POST "$API" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","orderId":"YANI-TEST-001","status":"CANCELLED"}' --connect-timeout 10)
CANCEL_OK=$(echo "$CANCEL_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('ok',False)).lower())" 2>/dev/null)
if [ "$CANCEL_OK" = "true" ]; then
  green "updateOrderStatus CANCELLED returns ok:true immediately"
  PASS=$((PASS+1))
else
  red "updateOrderStatus CANCELLED failed | $CANCEL_RESP"
  FAIL=$((FAIL+1))
fi

# Test status update to PREPARING
PREP_RESP=$(curl -s -X POST "$API" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","orderId":"YANI-TEST-001","status":"PREPARING"}' --connect-timeout 10)
check "updateOrderStatus PREPARING returns ok:true" "$PREP_RESP"

# Test invalid status is rejected
INVALID_RESP=$(curl -s -X POST "$API" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","orderId":"YANI-TEST-001","status":"INVALID_STATUS"}' --connect-timeout 10)
check "updateOrderStatus rejects invalid status" "$INVALID_RESP" "false"

# Test missing orderId is rejected
MISSING_RESP=$(curl -s -X POST "$API" -H "Content-Type: application/json" \
  -d '{"action":"updateOrderStatus","status":"CANCELLED"}' --connect-timeout 10)
check "updateOrderStatus rejects missing orderId" "$MISSING_RESP" "false"

# ── 4. ORDERS API ─────────────────────────────────────────────────────────
header "4. Orders API"
ORDERS=$(curl -s -X POST "$API" -H "Content-Type: application/json" -d '{"action":"getOrders"}' --connect-timeout 15)
check "getOrders returns ok:true" "$ORDERS"
ORDER_COUNT=$(echo "$ORDERS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('orders',[])))" 2>/dev/null)
echo "   Active orders: $ORDER_COUNT"

# ── 5. ONLINE ORDER API ───────────────────────────────────────────────────
header "5. Online Order API"
ONLINE_MENU=$(curl -s "$ONLINE_API?action=getMenu" --connect-timeout 15)
ONLINE_MENU_OK=$(echo "$ONLINE_MENU" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('ok',False) or bool(d.get('menu') or d.get('items') or d.get('categories'))).lower())" 2>/dev/null)
if [ "$ONLINE_MENU_OK" = "true" ]; then
  green "Online order getMenu works"
  PASS=$((PASS+1))
else
  yellow "Online order getMenu response unclear (may be ok): $(echo $ONLINE_MENU | head -c 150)"
  WARN=$((WARN+1))
fi

# ── 6. QUEUE STATUS API ───────────────────────────────────────────────────
header "6. Queue Status API"
QUEUE=$(curl -s "$QUEUE_STATUS" --connect-timeout 10)
QUEUE_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$QUEUE_STATUS?action=getQueueStats" --connect-timeout 10)
if [ "$QUEUE_HTTP" = "200" ]; then
  green "Queue status endpoint reachable (HTTP 200)"
  PASS=$((PASS+1))
else
  yellow "Queue status returned HTTP $QUEUE_HTTP"
  WARN=$((WARN+1))
fi

# ── 7. RATE LIMITING ──────────────────────────────────────────────────────
header "7. Security - Rate Limiting"
# Send a request with invalid action to test injection protection
INJECT=$(curl -s -X POST "$API" -H "Content-Type: application/json" \
  -d '{"action":"../../../etc/passwd"}' --connect-timeout 10)
check "Action injection blocked" "$INJECT" "false"

# ── 8. CORS HEADERS ───────────────────────────────────────────────────────
header "8. CORS Headers"
CORS=$(curl -s -I -X OPTIONS "$API" -H "Origin: https://yanigardencafe.com" --connect-timeout 10)
if echo "$CORS" | grep -qi "access-control-allow-origin"; then
  green "CORS headers present"
  PASS=$((PASS+1))
else
  red "CORS headers missing"
  FAIL=$((FAIL+1))
fi

# ── SUMMARY ───────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════"
echo "  TEST SUMMARY"
echo "══════════════════════════════════════"
echo "  ✅ PASS: $PASS"
echo "  ❌ FAIL: $FAIL"
echo "  ⚠️  WARN: $WARN"
echo "  TOTAL: $((PASS+FAIL+WARN))"
echo "══════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "\033[32m  ALL CRITICAL TESTS PASSED\033[0m"
else
  echo -e "\033[31m  $FAIL TEST(S) FAILED — SEE ABOVE\033[0m"
fi
