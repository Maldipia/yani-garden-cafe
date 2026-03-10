#!/usr/bin/env python3
"""
YANI POS — Menu Sync: GAS → Supabase
Fetches all active menu items from Google Apps Script and upserts them
into the Supabase menu_items table so online ordering and table ordering
pages show the complete, up-to-date menu.
"""
import json
import urllib.request
import urllib.error
import sys

SUPABASE_URL = 'https://hnynvclpvfxzlfjphefj.supabase.co'
SUPABASE_KEY = 'sb_publishable_PQBb1nDY7U7SxNfgDYoXyg_GtoLowLM'
GAS_URL = 'https://script.google.com/macros/s/AKfycbzprf6_LpDwcVujm8kcGFZE5JdkL0k9b6Wfg5l82gjZzFua8w1QWH8UoFFlhznc6EtL/exec'

def gas_request(action, body=None):
    """Call GAS via POST (handles redirect)."""
    data = json.dumps(body or {'action': action}).encode()
    req = urllib.request.Request(
        GAS_URL,
        data=data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    # Follow redirects manually
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308):
            location = e.headers.get('Location')
            if location:
                req2 = urllib.request.Request(location, data=data,
                    headers={'Content-Type': 'application/json'}, method='POST')
                with urllib.request.urlopen(req2, timeout=45) as resp:
                    return json.loads(resp.read().decode())
        raise

def supabase_request(method, path, body=None, params=None):
    """Make a Supabase REST API request."""
    url = f'{SUPABASE_URL}/rest/v1/{path}'
    if params:
        url += '?' + '&'.join(f'{k}={v}' for k, v in params.items())
    headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates'
    }
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode()
            return json.loads(text) if text else []
    except urllib.error.HTTPError as e:
        err_body = e.read().decode()
        print(f'  Supabase {method} error {e.code}: {err_body[:200]}')
        return None

def check_table_schema():
    """Check what columns exist in menu_items."""
    result = supabase_request('GET', 'menu_items', params={'limit': '1'})
    if result and len(result) > 0:
        print(f'  Existing columns: {list(result[0].keys())}')
        return list(result[0].keys())
    return []

def main():
    print('═' * 60)
    print('YANI POS — Menu Sync: GAS → Supabase')
    print('═' * 60)

    # Step 1: Check existing schema
    print('\n1. Checking Supabase menu_items schema...')
    existing_cols = check_table_schema()
    print(f'   Existing items in Supabase: checking...')
    
    existing = supabase_request('GET', 'menu_items', params={'select': 'id,name,category', 'limit': '200'})
    existing_count = len(existing) if existing else 0
    print(f'   Current Supabase count: {existing_count}')

    # Step 2: Fetch from GAS
    print('\n2. Fetching menu from GAS...')
    try:
        gas_data = gas_request('getMenu', {'action': 'getMenu'})
        if not gas_data.get('ok'):
            print(f'   GAS error: {gas_data}')
            sys.exit(1)
        gas_items = gas_data.get('items', [])
        print(f'   GAS returned: {len(gas_items)} items')
    except Exception as e:
        print(f'   Failed to fetch from GAS: {e}')
        sys.exit(1)

    if not gas_items:
        print('   No items from GAS — aborting')
        sys.exit(1)

    # Step 3: Map GAS items to Supabase schema
    print('\n3. Mapping items to Supabase schema...')
    
    # Determine what columns exist (or need to be created)
    # The menu_items table may have: id, name, category, price, available, image,
    # has_sizes, has_sugar, price_short, price_medium, price_tall, code
    supabase_items = []
    for item in gas_items:
        sb_item = {
            'name': item.get('name', ''),
            'category': item.get('category', 'OTHER'),
            'price': float(item.get('price', 0)),
            'available': True,
            'image': item.get('image', ''),
            'has_sizes': bool(item.get('hasSizes', False)),
            'has_sugar': bool(item.get('hasSugar', False)),
            'code': item.get('code', ''),
        }
        # Add size prices if available
        if item.get('priceShort'):
            sb_item['price_short'] = float(item['priceShort'])
        if item.get('priceMedium'):
            sb_item['price_medium'] = float(item['priceMedium'])
        if item.get('priceTall'):
            sb_item['price_tall'] = float(item['priceTall'])
        
        supabase_items.append(sb_item)
    
    print(f'   Prepared {len(supabase_items)} items for upsert')
    
    # Show category breakdown
    cats = {}
    for item in supabase_items:
        cat = item['category']
        cats[cat] = cats.get(cat, 0) + 1
    for cat, count in sorted(cats.items()):
        print(f'     {cat}: {count}')

    # Step 4: Upsert to Supabase in batches
    print('\n4. Upserting to Supabase...')
    
    # First, try to upsert with code as the conflict key
    # If that fails, we'll use name+category
    batch_size = 20
    success_count = 0
    fail_count = 0
    
    for i in range(0, len(supabase_items), batch_size):
        batch = supabase_items[i:i+batch_size]
        batch_names = [b['name'] for b in batch]
        
        # Try upsert with on_conflict=code
        result = supabase_request('POST', 'menu_items', body=batch)
        
        if result is not None:
            if isinstance(result, list):
                success_count += len(result)
                print(f'   Batch {i//batch_size + 1}: ✅ {len(result)} items upserted')
            else:
                success_count += len(batch)
                print(f'   Batch {i//batch_size + 1}: ✅ {len(batch)} items upserted')
        else:
            fail_count += len(batch)
            print(f'   Batch {i//batch_size + 1}: ❌ Failed for {batch_names[:3]}...')

    # Step 5: Verify
    print('\n5. Verifying sync...')
    final = supabase_request('GET', 'menu_items', params={'select': 'id,name,category', 'limit': '200'})
    final_count = len(final) if final else 0
    print(f'   Before: {existing_count} items')
    print(f'   After:  {final_count} items')
    print(f'   Added:  {final_count - existing_count} new items')
    
    print('\n' + '═' * 60)
    if fail_count == 0:
        print(f'✅ SYNC COMPLETE — {final_count} items now in Supabase')
    else:
        print(f'⚠️  PARTIAL SYNC — {success_count} ok, {fail_count} failed')
    print('═' * 60)

if __name__ == '__main__':
    main()
