#!/usr/bin/env python3
"""Deactivate 'Tiramisu Macchiato Latte' in Supabase — it's a duplicate of 'Iced Tiramisu Macchiato' from GAS."""
import requests

SUPABASE_URL = "https://hnynvclpvfxzlfjphefj.supabase.co"
SUPABASE_KEY = "sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM"
HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation"
}

# First, find the item
resp = requests.get(
    f"{SUPABASE_URL}/rest/v1/menu_items",
    params={"name": "eq.Tiramisu Macchiato Latte", "select": "id,name,item_code,is_active"},
    headers=HEADERS
)
items = resp.json()
print(f"Found: {items}")

if items and isinstance(items, list):
    item_id = items[0].get("id")
    item_code = items[0].get("item_code")
    
    # Deactivate it
    patch_resp = requests.patch(
        f"{SUPABASE_URL}/rest/v1/menu_items",
        params={"id": f"eq.{item_id}"},
        json={"is_active": False},
        headers=HEADERS
    )
    print(f"Deactivate status: {patch_resp.status_code}")
    print(f"Response: {patch_resp.text[:200]}")
    
    # Verify count
    count_resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/menu_items",
        params={"is_active": "eq.true", "select": "id"},
        headers={**HEADERS, "Prefer": "count=exact"}
    )
    count = count_resp.headers.get("content-range", "unknown")
    print(f"Active items after fix: {count}")
else:
    print("Item not found or already inactive.")
