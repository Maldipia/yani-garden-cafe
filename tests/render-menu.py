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
URL  = f'{BASE}/index-customer.html?table=13&token=37b3ddd3&cb=render'

def fail(msg): print(f'  \x1b[31m✗\x1b[0m {msg}'); return 1
def ok(msg):   print(f'  \x1b[32m✓\x1b[0m {msg}'); return 0

async def main():
    bad = 0
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        await pg.goto(URL, wait_until='networkidle')
        await pg.wait_for_selector('.menu-card', timeout=20000)
        await pg.evaluate('''() => ['yaniSplash','optModal','yaniStory'].forEach(id => {
            const e = document.getElementById(id); if (e) e.style.display = 'none'; })''')
        await pg.wait_for_timeout(800)

        cards = await pg.evaluate('''() => [...document.querySelectorAll('.menu-card')].slice(0, 8).map(c => {
            const q = s => c.querySelector(s), r = e => e ? e.getBoundingClientRect() : null;
            const w = r(q('.menu-img-wrap')), n = r(q('.menu-name')), pr = r(q('.menu-price')),
                  bt = r(q('.menu-add-btn')), cd = r(c);
            return { name: (q('.menu-name')||{}).textContent?.trim().slice(0,24),
                     cardH: cd.height, imgW: w?.width, imgH: w?.height,
                     nameTop: n ? n.top - cd.top : null, priceTop: pr ? pr.top - cd.top : null,
                     nameVisible: n ? n.bottom <= cd.bottom + 1 && n.height > 0 : false,
                     priceVisible: pr ? pr.bottom <= cd.bottom + 1 : false,
                     btnInImg: bt && w ? (bt.top >= w.top - 1 && bt.bottom <= w.bottom + 1) : false };
        })''')
        await pg.screenshot(path='/tmp/menu-render.png')
        await b.close()

    print('\x1b[1mRendered customer menu (390px phone)\x1b[0m')
    for c in cards:
        print(f"    {c['name'] or '?':26} card {c['cardH']:.0f}  img {c['imgW']:.0f}x{c['imgH']:.0f}"
              f"  name@{c['nameTop']:.0f}  price@{c['priceTop']:.0f}"
              f"  {'btn✓' if c['btnInImg'] else 'btn✗'}")

    bad += ok('8 cards rendered') if len(cards) == 8 else fail(f'only {len(cards)} cards rendered')
    bad += ok('every photo frame is square') if all(abs(c['imgW'] - c['imgH']) <= 2 for c in cards) \
           else fail('a photo frame is not square')
    bad += ok('every photo frame is the same size') if max(c['imgH'] for c in cards) - min(c['imgH'] for c in cards) <= 4 \
           else fail('photo frames differ in height across cards')
    bad += ok('every card is the same height') if max(c['cardH'] for c in cards) - min(c['cardH'] for c in cards) <= 4 \
           else fail('cards differ in height')
    bad += ok('names are level') if max(c['nameTop'] for c in cards) - min(c['nameTop'] for c in cards) <= 4 \
           else fail('names sit at different heights')
    bad += ok('prices are level') if max(c['priceTop'] for c in cards) - min(c['priceTop'] for c in cards) <= 4 \
           else fail('prices sit at different heights')
    bad += ok('every name and price is visible') if all(c['nameVisible'] and c['priceVisible'] for c in cards) \
           else fail('a name or price is clipped or missing')
    bad += ok('every add button sits inside its photo') if all(c['btnInImg'] for c in cards) \
           else fail('an add button is outside or clipped by the photo')

    print(f"\n  {'rendered layout OK' if not bad else f'{bad} layout problem(s)'}  (screenshot: /tmp/menu-render.png)\n")
    sys.exit(1 if bad else 0)

asyncio.run(main())
