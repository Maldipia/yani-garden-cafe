#!/usr/bin/env python3
"""
YANI POS — Menu Sync v2: GAS → Supabase (schema-aware)
1. Adds missing categories to menu_categories
2. Deactivates test/duplicate items in Supabase
3. Upserts all 47 active GAS items with correct category_id mapping
4. Verifies final state
"""
import json
import urllib.request
import urllib.error
import sys
import time

SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co'
SUPABASE_KEY = 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM'
GAS_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec'

def sb_get(path, params=None):
    url = f'{SUPABASE_URL}/rest/v1/{path}'
    if params:
        url += '?' + '&'.join(f'{k}={v}' for k, v in params.items())
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())

def sb_post(path, body, prefer='return=representation'):
    url = f'{SUPABASE_URL}/rest/v1/{path}'
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': prefer,
    }, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            text = r.read().decode()
            return json.loads(text) if text else []
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f'  POST error {e.code}: {err[:200]}')
        return None

def sb_patch(path, filter_str, body):
    url = f'{SUPABASE_URL}/rest/v1/{path}?{filter_str}'
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
    }, method='PATCH')
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return True
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f'  PATCH error {e.code}: {err[:200]}')
        return False

def sb_delete(path, filter_str):
    url = f'{SUPABASE_URL}/rest/v1/{path}?{filter_str}'
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Prefer': 'return=minimal',
    }, method='DELETE')
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return True
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f'  DELETE error {e.code}: {err[:200]}')
        return False

def gas_get_menu():
    data = json.dumps({'action': 'getMenu'}).encode()
    req = urllib.request.Request(GAS_URL, data=data,
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            loc = e.headers.get('Location')
            if loc:
                req2 = urllib.request.Request(loc, data=data,
                    headers={'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(req2, timeout=45) as r:
                    return json.loads(r.read().decode())
        raise

def main():
    print('═' * 65)
    print('YANI POS — Menu Sync v2: GAS → Supabase')
    print('═' * 65)

    # ── Step 1: Get existing categories ──────────────────────────
    print('\n[1/6] Loading existing menu_categories...')
    cats = sb_get('menu_categories', {'select': 'id,name', 'order': 'display_order'})
    cat_map = {c['name'].upper(): c['id'] for c in cats}
    print(f'  Found {len(cats)} categories: {list(cat_map.keys())}')

    # ── Step 2: Add missing categories ───────────────────────────
    print('\n[2/6] Checking for missing categories...')
    needed_cats = ['BEST WITH', 'HOT', 'ICE AND ICE BLENDED', 'PASTA', 'PASTRY', 'OTHER']
    max_order = max((c.get('display_order', 0) for c in cats), default=0)
    
    for cat_name in needed_cats:
        if cat_name.upper() not in cat_map:
            max_order += 1
            result = sb_post('menu_categories', {'name': cat_name, 'display_order': max_order})
            if result and len(result) > 0:
                new_id = result[0]['id']
                cat_map[cat_name.upper()] = new_id
                print(f'  ✅ Added category: {cat_name} (id: {new_id[:8]}...)')
            else:
                print(f'  ❌ Failed to add category: {cat_name}')
        else:
            print(f'  ✓  {cat_name} already exists')

    # ── Step 3: Fetch GAS menu ────────────────────────────────────
    print('\n[3/6] Fetching menu from GAS...')
    try:
        gas_data = gas_get_menu()
        if not gas_data.get('ok'):
            print(f'  GAS error: {gas_data}')
            sys.exit(1)
        gas_items = gas_data.get('items', [])
        print(f'  ✅ GAS returned {len(gas_items)} active items')
    except Exception as e:
        print(f'  ❌ GAS fetch failed: {e}')
        sys.exit(1)

    # ── Step 4: Clean up test/duplicate items ─────────────────────
    print('\n[4/6] Cleaning up test and duplicate items...')
    all_items = sb_get('menu_items', {'select': 'id,item_code,name,is_active', 'limit': '200'})
    
    # Items to deactivate: test items, items with ITEM_TEST_ prefix, empty names
    test_ids = []
    for item in all_items:
        code = item.get('item_code', '')
        name = item.get('name', '').strip()
        if (code.startswith('ITEM_TEST_') or 
            'test' in name.lower() or
            'e2e' in name.lower() or
            not name or
            name == 'X'):
            test_ids.append(item['id'])
    
    if test_ids:
        # Deactivate test items (don't delete, just mark inactive)
        for tid in test_ids:
            sb_patch('menu_items', f'id=eq.{tid}', {'is_active': False})
        print(f'  ✅ Deactivated {len(test_ids)} test/invalid items')
    else:
        print('  ✓  No test items found')

    # ── Step 5: Upsert all GAS items ─────────────────────────────
    print('\n[5/6] Upserting GAS menu items to Supabase...')
    
    # Build a lookup of existing items by item_code
    existing_by_code = {i['item_code']: i['id'] for i in all_items if i.get('item_code')}
    
    success = 0
    failed = 0
    
    for item in gas_items:
        code = item.get('code', '')
        name = item.get('name', '').strip()
        category = item.get('category', 'OTHER').upper()
        price = float(item.get('price', 0))
        
        cat_id = cat_map.get(category)
        if not cat_id:
            # Try partial match
            for k, v in cat_map.items():
                if category in k or k in category:
                    cat_id = v
                    break
        if not cat_id:
            cat_id = cat_map.get('OTHER')
        
        sb_item = {
            'item_code': code,
            'name': name,
            'category_id': cat_id,
            'base_price': price,
            'is_active': True,
            'has_sizes': bool(item.get('hasSizes', False)),
            'has_sugar_levels': bool(item.get('hasSugar', False)),
            'image_path': f'/images/{code}.png' if code else '',
        }
        
        # Add size prices
        if item.get('priceShort'):
            sb_item['price_short'] = float(item['priceShort'])
        if item.get('priceMedium'):
            sb_item['price_medium'] = float(item['priceMedium'])
        if item.get('priceTall'):
            sb_item['price_tall'] = float(item['priceTall'])
        
        if code in existing_by_code:
            # Update existing item
            ok = sb_patch('menu_items', f'item_code=eq.{code}', sb_item)
            if ok:
                success += 1
                print(f'  ✅ Updated: {code:8} {name[:35]}')
            else:
                failed += 1
                print(f'  ❌ Failed update: {code} {name}')
        else:
            # Insert new item
            result = sb_post('menu_items', sb_item)
            if result is not None:
                success += 1
                print(f'  ✅ Inserted: {code:8} {name[:35]}')
            else:
                failed += 1
                print(f'  ❌ Failed insert: {code} {name}')
        
        time.sleep(0.05)  # Small delay to avoid rate limiting

    # ── Step 6: Verify ───────────────────────────────────────────
    print('\n[6/6] Verifying final state...')
    final_all = sb_get('menu_items', {'select': 'id,item_code,name,is_active', 'limit': '200'})
    final_active = [i for i in final_all if i.get('is_active')]
    
    print(f'  Total items in Supabase: {len(final_all)}')
    print(f'  Active items: {len(final_active)}')
    print(f'  Inactive items: {len(final_all) - len(final_active)}')
    
    print('\n' + '═' * 65)
    if failed == 0:
        print(f'✅ SYNC COMPLETE — {success} items synced, {len(final_active)} active in Supabase')
    else:
        print(f'⚠️  PARTIAL SYNC — {success} ok, {failed} failed')
    print('═' * 65)

if __name__ == '__main__':
    main()
