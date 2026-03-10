#!/usr/bin/env python3
"""
Generate QR codes for all YANI Garden Cafe tables.
Each QR code encodes the URL: https://yanigardencafe.com/?table=N&token=TOKEN
"""

import qrcode
import os
from PIL import Image, ImageDraw, ImageFont

# ── CONFIG ──────────────────────────────────────────────────────────────────
BASE_URL = "https://yanigardencafe.com"
OUTPUT_DIR = "/home/ubuntu/yani-garden-cafe/docs/table-qr-codes"

# Table tokens from index.html TABLE_TOKENS constant
TABLE_TOKENS = {
    '1': 'b36e8426', '2': 'c331ce3e', '3': '60e9fc3d',
    '4': 'a1765c4b', '5': '8d07a408', '6': '8239ded5',
    '7': 'f9612bc6', '8': '28027fc0', '9': '9e4c1053',
    '10': '662937dc'
}

# Brand colors
FOREST_GREEN = (45, 90, 39)       # #2D5A27
CREAM = (250, 245, 230)           # #FAF5E6
WHITE = (255, 255, 255)

os.makedirs(OUTPUT_DIR, exist_ok=True)

def make_table_qr(table_no, token):
    url = f"{BASE_URL}/?table={table_no}&token={token}"

    # Generate QR code
    qr = qrcode.QRCode(
        version=3,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=12,
        border=2,
    )
    qr.add_data(url)
    qr.make(fit=True)

    qr_img = qr.make_image(fill_color=FOREST_GREEN, back_color=WHITE).convert("RGB")
    qr_size = qr_img.size[0]  # square

    # Canvas: add top header and bottom label
    header_h = 90
    footer_h = 80
    padding = 24
    canvas_w = qr_size + padding * 2
    canvas_h = qr_size + header_h + footer_h + padding * 2

    canvas = Image.new("RGB", (canvas_w, canvas_h), CREAM)
    draw = ImageDraw.Draw(canvas)

    # Header background
    draw.rectangle([(0, 0), (canvas_w, header_h)], fill=FOREST_GREEN)

    # Try to load a font; fall back to default
    try:
        font_title = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
        font_sub   = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
        font_table = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 36)
        font_url   = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
    except:
        font_title = ImageFont.load_default()
        font_sub   = font_title
        font_table = font_title
        font_url   = font_title

    # Header text: YANI Garden Cafe
    title_text = "YANI Garden Cafe"
    sub_text   = "Scan to Order"
    title_bbox = draw.textbbox((0, 0), title_text, font=font_title)
    sub_bbox   = draw.textbbox((0, 0), sub_text, font=font_sub)
    title_w = title_bbox[2] - title_bbox[0]
    sub_w   = sub_bbox[2] - sub_bbox[0]
    draw.text(((canvas_w - title_w) // 2, 12), title_text, fill=CREAM, font=font_title)
    draw.text(((canvas_w - sub_w) // 2, 50), sub_text, fill=(200, 230, 180), font=font_sub)

    # Paste QR code
    qr_x = padding
    qr_y = header_h + padding
    canvas.paste(qr_img, (qr_x, qr_y))

    # Footer: Table number
    table_text = f"TABLE {table_no}"
    t_bbox = draw.textbbox((0, 0), table_text, font=font_table)
    t_w = t_bbox[2] - t_bbox[0]
    draw.text(((canvas_w - t_w) // 2, qr_y + qr_size + 12), table_text, fill=FOREST_GREEN, font=font_table)

    # URL hint
    url_text = "yanigardencafe.com"
    u_bbox = draw.textbbox((0, 0), url_text, font=font_url)
    u_w = u_bbox[2] - u_bbox[0]
    draw.text(((canvas_w - u_w) // 2, qr_y + qr_size + 52), url_text, fill=(120, 120, 120), font=font_url)

    # Save
    out_path = os.path.join(OUTPUT_DIR, f"table_{table_no:02d}_qr.png")
    canvas.save(out_path, "PNG", dpi=(300, 300))
    print(f"  ✓ Table {table_no:>2} → {out_path}")
    print(f"           URL: {url}")
    return out_path

print("Generating QR codes for YANI Garden Cafe tables...")
print(f"Base URL: {BASE_URL}\n")

paths = []
for table_no_str, token in sorted(TABLE_TOKENS.items(), key=lambda x: int(x[0])):
    path = make_table_qr(int(table_no_str), token)
    paths.append(path)

print(f"\nDone! {len(paths)} QR codes saved to: {OUTPUT_DIR}")
