#!/usr/bin/env bash
# YANI POS — Quick post-deploy smoke test
# ─────────────────────────────────────────────────────────────────
# Verifies critical paths still work after any deploy. Read-only,
# zero secrets required, runs in ~30 seconds.
#
# Complements scripts/audit.py (which is a deeper security audit
# that needs SUPABASE_SECRET_KEY + SUPABASE_PAT).
#
# Usage:
#   ./scripts/smoke-test.sh                # tests https://yanigardencafe.com (default)
#   BASE=https://other.url ./scripts/smoke-test.sh
#
# Exit codes:
#   0 = all tests passed
#   1 = at least one test failed
#
# Tests intentionally avoid:
#   - Writing any data (no real orders placed, no PIN changes)
#   - Triggering rate limiters (only 1 wrong-PIN attempt per run)
#   - Requiring any secret keys
# ─────────────────────────────────────────────────────────────────

set -uo pipefail

BASE="${BASE:-https://yanigardencafe.com}"
POS="$BASE/api/pos"
HEALTH="$BASE/api/health"

# Colors (auto-disabled if not a TTY)
if [ -t 1 ]; then
  C_GREEN='\033[0;32m'; C_RED='\033[0;31m'; C_YELLOW='\033[0;33m'
  C_GRAY='\033[0;90m';  C_BOLD='\033[1m';   C_RESET='\033[0m'
else
  C_GREEN=''; C_RED=''; C_YELLOW=''; C_GRAY=''; C_BOLD=''; C_RESET=''
fi

# Counters
PASS=0
FAIL=0
FAILED_TESTS=()

# Per-test helpers
say_pass() {
  local cat="$1" msg="$2"
  printf "${C_GREEN}✅${C_RESET} ${C_GRAY}%-12s${C_RESET} %s\n" "$cat" "$msg"
  PASS=$((PASS+1))
}
say_fail() {
  local cat="$1" msg="$2" detail="${3:-}"
  printf "${C_RED}❌${C_RESET} ${C_GRAY}%-12s${C_RESET} %s\n" "$cat" "$msg"
  [ -n "$detail" ] && printf "   ${C_GRAY}→ %s${C_RESET}\n" "$detail"
  FAIL=$((FAIL+1))
  FAILED_TESTS+=("$cat: $msg")
}

# Curl wrappers
http_status() {
  curl -s -o /dev/null -w "%{http_code}" -X "${2:-GET}" "$1"
}
post_json() {
  # $1=url $2=json body. Output: raw response body
  curl -s -X POST -H 'Content-Type: application/json' -d "$2" "$1"
}
options_check() {
  curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$1"
}

# Check jq is available (we use it for response parsing)
if ! command -v jq >/dev/null 2>&1; then
  echo "${C_RED}ERROR${C_RESET}: jq is required. Install with: apt-get install jq (or brew install jq)" >&2
  exit 2
fi

START_TS=$(date +%s)
printf "\n${C_BOLD}🧪 YANI POS smoke tests${C_RESET}\n"
printf "${C_GRAY}Target: %s${C_RESET}\n" "$BASE"
printf "${C_GRAY}Time:   %s${C_RESET}\n" "$(date -u +'%Y-%m-%d %H:%M:%S UTC')"
echo "─────────────────────────────────────────────────"

# ─────────────────────────────────────────────────────────────────
# CATEGORY 1: INFRASTRUCTURE (3 tests)
# ─────────────────────────────────────────────────────────────────

# 1.1 Health endpoint returns 200
code=$(http_status "$HEALTH")
if [ "$code" = "200" ]; then
  say_pass "infra" "health endpoint returns 200"
else
  say_fail "infra" "health endpoint returns 200" "got HTTP $code"
fi

# 1.2 POS endpoint OPTIONS (CORS preflight) returns 2xx
code=$(options_check "$POS")
if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
  say_pass "infra" "POS endpoint OPTIONS preflight ok"
else
  say_fail "infra" "POS endpoint OPTIONS preflight ok" "got HTTP $code"
fi

# 1.3 cron-backup endpoint correctly refuses unauthorized requests
code=$(http_status "$BASE/api/cron-backup" POST)
if [ "$code" = "403" ]; then
  say_pass "infra" "cron-backup fails closed (no CRON_SECRET → 403)"
else
  say_fail "infra" "cron-backup fails closed (no CRON_SECRET → 403)" "got HTTP $code (expected 403)"
fi

# ─────────────────────────────────────────────────────────────────
# CATEGORY 2: PUBLIC READS (4 tests)
# ─────────────────────────────────────────────────────────────────

# 2.1 getMenu returns >0 items
resp=$(post_json "$POS" '{"action":"getMenu"}')
items=$(echo "$resp" | jq -r '.items | length // 0' 2>/dev/null)
if [ -n "$items" ] && [ "$items" -gt 0 ] 2>/dev/null; then
  say_pass "read" "getMenu returns $items items"
else
  say_fail "read" "getMenu returns items" "got: $(echo "$resp" | head -c 100)"
fi

# 2.2 getSettings returns LEAVES_PESOS_PER_LEAF
# Note: settings is an array of {key, value, description} objects
resp=$(post_json "$POS" '{"action":"getSettings"}')
val=$(echo "$resp" | jq -r '.settings[]? | select(.key == "LEAVES_PESOS_PER_LEAF") | .value' 2>/dev/null)
if [ -n "$val" ]; then
  say_pass "read" "getSettings has LEAVES_PESOS_PER_LEAF=$val"
else
  say_fail "read" "getSettings has LEAVES_PESOS_PER_LEAF" "value not found in response"
fi

# 2.3 listLeafRewards returns the ladder (expect 5 tiers)
resp=$(post_json "$POS" '{"action":"listLeafRewards"}')
tier_count=$(echo "$resp" | jq -r '.rewards | length // 0' 2>/dev/null)
if [ "$tier_count" = "5" ] 2>/dev/null; then
  say_pass "read" "listLeafRewards returns 5 tiers"
elif [ -n "$tier_count" ] && [ "$tier_count" -gt 0 ] 2>/dev/null; then
  say_fail "read" "listLeafRewards returns 5 tiers" "got $tier_count tiers (ladder may have changed)"
else
  say_fail "read" "listLeafRewards returns 5 tiers" "no rewards array in response"
fi

# 2.4 getLeavesProfile for nonexistent email returns ok:true with null/empty profile
fake_email="nonexistent-smoke-test-$(date +%s)@example.com"
resp=$(post_json "$POS" "{\"action\":\"getLeavesProfile\",\"email\":\"$fake_email\"}")
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
has_profile=$(echo "$resp" | jq -r '.profile // .account // null | if . == null then "no" else "yes" end' 2>/dev/null)
if [ "$ok" = "true" ] && [ "$has_profile" = "no" ]; then
  say_pass "read" "getLeavesProfile returns ok:true with no profile for new email"
else
  say_fail "read" "getLeavesProfile for new email" "ok=$ok has_profile=$has_profile"
fi

# ─────────────────────────────────────────────────────────────────
# CATEGORY 3: YANI CARD PUBLIC LOOKUP (2 tests)
# ─────────────────────────────────────────────────────────────────

CARD_API="$BASE/api/card"

# 3.1 lookupCard for valid card YANI-1004 (active card with known holder)
resp=$(post_json "$CARD_API" '{"action":"lookupCard","card_number":"YANI-1004"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
balance=$(echo "$resp" | jq -r '.card.balance // empty' 2>/dev/null)
if [ "$ok" = "true" ] && [ -n "$balance" ]; then
  say_pass "card" "lookupCard YANI-1004 returns balance=$balance"
else
  say_fail "card" "lookupCard YANI-1004" "ok=$ok balance=$balance"
fi

# 3.2 lookupCard for nonexistent card returns 404 / ok:false
resp=$(post_json "$CARD_API" '{"action":"lookupCard","card_number":"YANI-9999"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "card" "lookupCard YANI-9999 correctly returns ok:false"
else
  say_fail "card" "lookupCard YANI-9999 returns ok:false" "got ok=$ok"
fi

# ─────────────────────────────────────────────────────────────────
# CATEGORY 4: AUTH (2 tests — keep wrong-PIN count low to avoid rate limit)
# ─────────────────────────────────────────────────────────────────

# 4.1 OWNER PIN authenticates and returns role=OWNER
resp=$(post_json "$POS" '{"action":"verifyUserPin","pin":"2026"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
role=$(echo "$resp" | jq -r '.user.role // .role // empty' 2>/dev/null)
if [ "$ok" = "true" ] && [ "$role" = "OWNER" ]; then
  say_pass "auth" "OWNER PIN authenticates with role=OWNER"
else
  say_fail "auth" "OWNER PIN authenticates" "ok=$ok role=$role"
fi

# 4.2 Wrong PIN returns ok:false (this counts toward pin_brute rate limit — 1/10 budget)
resp=$(post_json "$POS" '{"action":"verifyUserPin","pin":"0000"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "auth" "wrong PIN correctly rejected"
else
  say_fail "auth" "wrong PIN rejected" "got ok=$ok (should be false)"
fi

# ─────────────────────────────────────────────────────────────────
# CATEGORY 5: SECURITY REGRESSIONS (3 tests — all read-only / failing-by-design)
# ─────────────────────────────────────────────────────────────────

# 5.1 placeOrder with tampered price (₱1 instead of ₱189) → server rejects
# Uses Table 1 with the canonical public token b36e8426 from system docs.
# Server-side price validation must reject; if this test passes, an attacker
# could place ₱1 orders.
resp=$(post_json "$POS" '{
  "action":"placeOrder",
  "tableNo":"1",
  "token":"b36e8426",
  "items":[{"code":"C001","qty":1,"price":1,"addons":[],"size":"","sugarLevel":""}],
  "subtotal":1,"serviceCharge":0.1,"total":1.1,
  "orderType":"DINE-IN",
  "customerName":"SMOKE_TEST_DO_NOT_FULFILL"
}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
err=$(echo "$resp" | jq -r '.error // empty' 2>/dev/null)
if [ "$ok" = "false" ] && echo "$err" | grep -qi "invalid price"; then
  say_pass "security" "tampered price rejected by server-side validation"
else
  say_fail "security" "tampered price rejected" "ok=$ok err='$err' — if this passed, a tampered ₱1 order may have been created!"
fi

# 5.2 Admin action without userId returns auth error
resp=$(post_json "$POS" '{"action":"getAuditLogs"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "security" "admin action without userId rejected"
else
  say_fail "security" "admin action without userId rejected" "got ok=$ok"
fi

# 5.3 Admin action with malformed userId rejected
resp=$(post_json "$POS" '{"action":"getAuditLogs","userId":"hacker"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "security" "admin action with malformed userId rejected"
else
  say_fail "security" "admin action with malformed userId rejected" "got ok=$ok"
fi

# 5.4 claimLeafReward without staff auth must be rejected (was unauthenticated before)
resp=$(post_json "$POS" '{"action":"claimLeafReward","accountId":"00000000-0000-0000-0000-000000000000","tierOrder":1}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
err=$(echo "$resp" | jq -r '.error // ""' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "security" "claimLeafReward without auth rejected (no anonymous claims)"
else
  say_fail "security" "claimLeafReward without auth rejected" "ok=$ok err='$err' — anonymous claim was allowed!"
fi

# 5.5 revokeLeafReward requires OWNER (KITCHEN role with reason should still be rejected)
resp=$(post_json "$POS" '{"action":"revokeLeafReward","userId":"USR_004","accountId":"00000000-0000-0000-0000-000000000000","tierOrder":1,"reason":"test"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "security" "revokeLeafReward KITCHEN-role attempt rejected (OWNER only)"
else
  say_fail "security" "revokeLeafReward OWNER-only enforcement" "got ok=$ok — KITCHEN was able to revoke!"
fi

# 5.6 getMemberLeafState requires staff auth (anonymous should be rejected)
resp=$(post_json "$POS" '{"action":"getMemberLeafState","accountId":"00000000-0000-0000-0000-000000000000"}')
ok=$(echo "$resp" | jq -r '.ok // false' 2>/dev/null)
if [ "$ok" = "false" ]; then
  say_pass "security" "getMemberLeafState without auth rejected"
else
  say_fail "security" "getMemberLeafState without auth rejected" "got ok=$ok"
fi

# ─────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────

ELAPSED=$(( $(date +%s) - START_TS ))
TOTAL=$((PASS + FAIL))

echo "─────────────────────────────────────────────────"
if [ $FAIL -eq 0 ]; then
  printf "${C_GREEN}${C_BOLD}✅ %d/%d passing${C_RESET} ${C_GRAY}(%ds)${C_RESET}\n" "$PASS" "$TOTAL" "$ELAPSED"
  exit 0
else
  printf "${C_RED}${C_BOLD}❌ %d/%d failing${C_RESET} ${C_GRAY}(%ds)${C_RESET}\n\n" "$FAIL" "$TOTAL" "$ELAPSED"
  printf "${C_BOLD}Failures:${C_RESET}\n"
  for t in "${FAILED_TESTS[@]}"; do
    printf "  ${C_RED}•${C_RESET} %s\n" "$t"
  done
  exit 1
fi
