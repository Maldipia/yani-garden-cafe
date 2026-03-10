#!/usr/bin/env python3
"""
Generate the Online Ordering QR code for YANI Garden Cafe.
URL: https://yanigardencafe.com/online-order.html
"""

import qrcode
import os
from PIL import Image, ImageDraw, ImageFont

OUTPUT_DIR = "/home/ubuntu/yani-garden-cafe/docs/table-qr-codes"
FOREST_GREEN = (45, 90, 39)
GOLD         = (180, 140, 60)
CREAM        = (250, 245, 230)
WHITE        = (255, 255, 255)

os.makedirs(OUTPUT_DIR, exist_ok=True)

url = "https://yanigardencafe.com/online-order.html"

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
qr_size = qr_img.size[0]

header_h = 100
footer_h = 90
padding  = 24
canvas_w = qr_size + padding * 2
canvas_h = qr_size + header_h + footer_h + padding * 2

canvas = Image.new("RGB", (canvas_w, canvas_h), CREAM)
draw   = ImageDraw.Draw(canvas)

# Header background
draw.rectangle([(0, 0), (canvas_w, header_h)], fill=FOREST_GREEN)

try:
    font_title  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    font_sub    = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 16)
    font_label  = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
    font_url    = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 13)
except:
    font_title = font_sub = font_label = font_url = ImageFont.load_default()

# Header text
title_text = "YANI Garden Cafe"
sub_text   = "Order Online — Delivery / Pickup"

for text, font, y, color in [
    (title_text, font_title, 12,  CREAM),
    (sub_text,   font_sub,   52,  (200, 230, 180)),
]:
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    draw.text(((canvas_w - w) // 2, y), text, fill=color, font=font)

# Paste QR
qr_x = padding
qr_y = header_h + padding
canvas.paste(qr_img, (qr_x, qr_y))

# Footer label
label_text = "ONLINE ORDER"
lb = draw.textbbox((0, 0), label_text, font=font_label)
lw = lb[2] - lb[0]
draw.text(((canvas_w - lw) // 2, qr_y + qr_size + 12), label_text, fill=FOREST_GREEN, font=font_label)

# URL hint
url_text = "yanigardencafe.com/online-order"
ub = draw.textbbox((0, 0), url_text, font=font_url)
uw = ub[2] - ub[0]
draw.text(((canvas_w - uw) // 2, qr_y + qr_size + 54), url_text, fill=(120, 120, 120), font=font_url)

out_path = os.path.join(OUTPUT_DIR, "online_order_qr.png")
canvas.save(out_path, "PNG", dpi=(300, 300))
print(f"✓ Online Order QR → {out_path}")
print(f"  URL: {url}")
