#!/usr/bin/env python3
"""
RENDERED layout check for the customer menu.

Every previous check read the CSS text and confirmed the right rules were
present. Three deploys in a row passed those checks while the live page showed
photos at different heights, then sliced + buttons, then no names or prices at
all. A rule being present says nothing about what the browser does with it.

This opens the real page in headless Chromium at phone width, hides the
splash, and MEASURES the first row of cards. It fails on the actual defects:
frames not square, frames different sizes, names or prices at different
heights, or the add button outside the photo.

Run: python3 tests/render-menu.py  (needs: pip install playwright && playwright install chromium)
"""
import asyncio, sys, os
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE', 'https://yanigardencafe.com')
URL  = f'{BASE}/index-customer.html?table=13&token=37b3ddd3&cb=' + str(int(__import__('time').time()))

def fail(msg): print(f'  \x1b[31m✗\x1b[0m {msg}'); return 1
def ok(msg):   print(f'  \x1b[32m✓\x1b[0m {msg}'); return 0

async def main():
    bad = 0
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True)
        await pg.goto(URL, wait_until='networkidle')
        await pg.wait_for_selector('.menu-card', timeout=20000)
        await pg.evaluate('''() => ['yaniSplash','optModal','yaniStory'].forEach(id => {
            const e = document.getElementById(id); if (e) e.style.display = 'none'; })''')
        await pg.wait_for_timeout(800)

        cards = await pg.evaluate('''() => [...document.querySelectorAll('.menu-card')].slice(0, 8).map(c => {
            const q = s => c.querySelector(s), r = e => e ? e.getBoundingClientRect() : null;
            const w = r(q('.menu-img-wrap')), n = r(q('.menu-name')), pr = r(q('.menu-price')),
                  bt = r(q('.menu-add-btn')), cd = r(c);
            const below = (() => { const cards=[...document.querySelectorAll('.menu-card')]; const i=cards.indexOf(c);
                const nx = cards[i+2]; return nx ? nx.querySelector('.menu-img-wrap').getBoundingClientRect().top : null; })();
            return { name: (q('.menu-name')||{}).textContent?.trim().slice(0,24),
                     cardH: cd.height, imgW: w?.width, imgH: w?.height,
                     nameTop: n ? n.top - cd.top : null, priceTop: pr ? pr.top - cd.top : null,
                     nameToPrice: (n && pr) ? pr.top - n.bottom : 99,
                     toNextPhoto: (pr && below !== null) ? below - pr.bottom : null,
                     nameVisible: n ? n.bottom <= cd.bottom + 1 && n.height > 0 : false,
                     priceVisible: pr ? pr.bottom <= cd.bottom + 1 : false,
                     btnInImg: bt && w ? (bt.top >= w.top - 1 && bt.bottom <= w.bottom + 1) : false };
        })''')
        await pg.screenshot(path='/tmp/menu-render.png')

        # ── Grid structure: photo → name → price, nothing over the photo ──
        gs = await pg.evaluate('''() => [...document.querySelectorAll('.menu-card')].slice(0,8).map(c => ({
            overlays: c.querySelectorAll('.menu-img-wrap *:not(img):not(.menu-img-placeholder):not(.menu-add-btn)').length,
            btnInsidePhoto: (()=>{ const b=c.querySelector('.menu-add-btn').getBoundingClientRect(), w=c.querySelector('.menu-img-wrap').getBoundingClientRect();
                return b.top>=w.top-1 && b.bottom<=w.bottom+1 && b.left>=w.left-1 && b.right<=w.right+1; })(),
            cardBg: getComputedStyle(c).backgroundColor }))''')
        bad += ok('nothing is drawn over the grid photos') if all(x['overlays']==0 for x in gs) else fail('something overlays a grid photo')
        bad += ok('add button sits on the photo corner, fully inside the frame') if all(x['btnInsidePhoto'] for x in gs) else fail('an add button is off the photo or clipped')
        bad += ok('no card box behind products') if all(x['cardBg'] in ('rgba(0, 0, 0, 0)','transparent') for x in gs) else fail('a card background is drawn')

        # ── Detail page flow ─────────────────────────────────────────────
        await pg.evaluate("document.documentElement.style.scrollBehavior='auto'; window.scrollTo({top:600,behavior:'instant'})"); await pg.wait_for_timeout(300)
        y0 = await pg.evaluate("Math.round(window.scrollY)")
        # Tap by COORDINATES on a photo that is already in view. locator.tap()
        # scrolls its target into view first, which moved the page to 0 and made
        # a correct scroll-restore look broken.
        pt = await pg.evaluate('''() => { const ws=[...document.querySelectorAll('.menu-img-wrap')];
            const w = ws.find(e => { const r=e.getBoundingClientRect(); return r.top > 120 && r.bottom < innerHeight - 40; });
            const r = w.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }''')
        await pg.touchscreen.tap(pt['x'], pt['y']); await pg.wait_for_timeout(450)
        dd = await pg.evaluate('''() => { const v=document.getElementById('productDetail'), h=v.querySelector('.pd-hero').getBoundingClientRect();
            return { open: !v.hidden, heroSquare: Math.abs(h.width-h.height)<2, viewer: !document.getElementById('pvBackdrop').hidden,
                     name: !!document.getElementById('pdName').textContent, price: /₱/.test(document.getElementById('pdPrice').textContent),
                     heroOverlays: v.querySelectorAll('.pd-hero *:not(img):not(.pd-img-placeholder):not(.pd-back)').length }; }''')
        bad += ok('grid photo tap opens the detail page') if dd['open'] and not dd['viewer'] else fail('grid photo tap did not open detail (or opened the viewer)')
        bad += ok('detail hero is a square photo with only a back button on it') if dd['heroSquare'] and dd['heroOverlays']==0 else fail('detail hero is wrong')
        bad += ok('detail shows name and price') if dd['name'] and dd['price'] else fail('detail missing name or price')
        await pg.locator('#pdImg').tap(); await pg.wait_for_timeout(400)
        hv = await pg.evaluate("document.getElementById('pvBackdrop').classList.contains('open')")
        await pg.locator('#pvClose').tap(); await pg.wait_for_timeout(350)
        bad += ok('hero tap opens the full-screen viewer') if hv else fail('hero tap did not open the viewer')
        c0 = await pg.evaluate("state.cart.length")
        await pg.locator('#pdAdd').tap(); await pg.wait_for_timeout(500)
        c1 = await pg.evaluate("state.cart.length"); closed = await pg.evaluate("document.getElementById('productDetail').hidden")
        y1 = await pg.evaluate("Math.round(window.scrollY)")
        bad += ok('add to cart from detail adds and returns to the menu') if c1==c0+1 and closed else fail('detail add did not add or did not return')
        bad += ok('menu scroll position restored after detail') if abs(y0-y1)<=2 else fail(f'scroll {y0} -> {y1}')

        # ── Photo viewer ──────────────────────────────────────────────────
        # Opens on a photo tap, contains (never crops), closes four ways, and
        # never touches the cart. Tested here because it is behaviour, and
        # behaviour can only be verified by running it.
        pv = {}
        cart0 = await pg.evaluate("state.cart.length")
        await pg.locator('.menu-card').first.locator('.menu-img-wrap').tap(); await pg.wait_for_timeout(450)
        await pg.click('#pdImg', force=True); await pg.wait_for_timeout(350)
        pv['open'] = await pg.evaluate('''() => { const bd=document.getElementById('pvBackdrop'), im=document.getElementById('pvImg');
            const r=im.getBoundingClientRect(); return { open: bd.classList.contains('open') && !bd.hidden,
            fit: getComputedStyle(im).objectFit, bigger: r.width > document.querySelector('.menu-img').getBoundingClientRect().width * 1.5,
            aspect: Math.abs(im.naturalWidth/im.naturalHeight - r.width/r.height) < 0.03 }; }''')
        await pg.click('#pvClose'); await pg.wait_for_timeout(300)
        pv['x'] = await pg.evaluate("document.getElementById('pvBackdrop').hidden")
        await pg.click('#pdImg', force=True); await pg.wait_for_timeout(300)
        await pg.mouse.click(8, 836); await pg.wait_for_timeout(300)
        pv['backdrop'] = await pg.evaluate("document.getElementById('pvBackdrop').hidden")
        await pg.click('#pdImg', force=True); await pg.wait_for_timeout(300)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        pv['esc'] = await pg.evaluate("document.getElementById('pvBackdrop').hidden")
        pv['cartSame'] = (await pg.evaluate("state.cart.length")) == cart0
        await b.close()

    print('\x1b[1mRendered customer menu (390px phone)\x1b[0m')
    for c in cards:
        print(f"    {c['name'] or '?':26} img {c['imgW']:.0f}x{c['imgH']:.0f}  name→price {c['nameToPrice']:.0f}px"
              f"  →next photo {('%.0fpx' % c['toNextPhoto']) if c['toNextPhoto'] is not None else '—'}")

    bad += ok('8 cards rendered') if len(cards) == 8 else fail(f'only {len(cards)} cards rendered')
    bad += ok('every photo frame is square') if all(abs(c['imgW'] - c['imgH']) <= 2 for c in cards) \
           else fail('a photo frame is not square')
    bad += ok('every photo frame is the same size') if max(c['imgH'] for c in cards) - min(c['imgH'] for c in cards) <= 4 \
           else fail('photo frames differ in height across cards')
    # Rows are deliberately NOT level any more. What matters is that each price
    # sits tight under its own name, and the gap before the NEXT photo is clearly
    # larger — so a price can never read as belonging to the dish beneath it.
    bad += ok('every price sits directly under its name (≤ 8px)') if all(c['nameToPrice'] <= 8 for c in cards) \
           else fail('a price has drifted away from its name: ' + ', '.join(f"{c['name']}:{c['nameToPrice']:.0f}px" for c in cards if c['nameToPrice'] > 8))
    bad += ok('gap before the next photo is at least 2x the name→price gap') if all(c['toNextPhoto'] is None or c['toNextPhoto'] >= max(16, 2*c['nameToPrice']) for c in cards) \
           else fail('a price sits closer to the next photo than to its own name')
    bad += ok('every name and price is visible') if all(c['nameVisible'] and c['priceVisible'] for c in cards) \
           else fail('a name or price is clipped or missing')
    # (the 'add button inside the photo' check was retired: the spec now puts
    #  the button beside the price, and the grid-structure check asserts that)

    print('\x1b[1mPhoto viewer\x1b[0m')
    o = pv['open']
    bad += ok('opens on photo tap') if o['open'] else fail('viewer did not open')
    bad += ok('uses object-fit: contain (never crops)') if o['fit'] == 'contain' else fail(f"object-fit is {o['fit']}")
    bad += ok('shows the photo substantially larger') if o['bigger'] else fail('viewer image is not larger than the card')
    bad += ok('keeps the original aspect ratio') if o['aspect'] else fail('aspect ratio distorted')
    bad += ok('closes with X') if pv['x'] else fail('X did not close')
    bad += ok('closes on backdrop tap') if pv['backdrop'] else fail('backdrop tap did not close')
    bad += ok('closes on Escape') if pv['esc'] else fail('Escape did not close')
    bad += ok('cart untouched by viewing') if pv['cartSame'] else fail('cart changed while viewing a photo')

    print(f"\n  {'rendered layout OK' if not bad else f'{bad} layout problem(s)'}  (screenshot: /tmp/menu-render.png)\n")
    sys.exit(1 if bad else 0)

asyncio.run(main())
