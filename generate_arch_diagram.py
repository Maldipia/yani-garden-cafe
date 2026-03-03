"""
Yani Garden Cafe POS — System Architecture Diagram Generator
"""
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import matplotlib.patheffects as pe

fig, ax = plt.subplots(1, 1, figsize=(20, 14))
ax.set_xlim(0, 20)
ax.set_ylim(0, 14)
ax.axis('off')
fig.patch.set_facecolor('#1a1a2e')
ax.set_facecolor('#1a1a2e')

# ── Color Palette ────────────────────────────────────────────────────────────
C_BG       = '#1a1a2e'
C_LAYER    = '#16213e'
C_ACCENT   = '#e8a838'   # amber/gold
C_GREEN    = '#2ecc71'
C_BLUE     = '#3498db'
C_PURPLE   = '#9b59b6'
C_RED      = '#e74c3c'
C_TEAL     = '#1abc9c'
C_GRAY     = '#7f8c8d'
C_WHITE    = '#ecf0f1'
C_DARK     = '#0f3460'

def box(ax, x, y, w, h, color, alpha=0.9, radius=0.3):
    rect = FancyBboxPatch((x, y), w, h,
                          boxstyle=f"round,pad=0.05,rounding_size={radius}",
                          facecolor=color, edgecolor=C_WHITE,
                          linewidth=1.2, alpha=alpha, zorder=3)
    ax.add_patch(rect)

def label(ax, x, y, text, size=9, color=C_WHITE, bold=False, center=True, zorder=5):
    weight = 'bold' if bold else 'normal'
    ha = 'center' if center else 'left'
    ax.text(x, y, text, fontsize=size, color=color, ha=ha, va='center',
            fontweight=weight, zorder=zorder,
            path_effects=[pe.withStroke(linewidth=1.5, foreground='black')])

def arrow(ax, x1, y1, x2, y2, color=C_ACCENT, lw=1.8, style='->', label_text='', bidirectional=False):
    arrowstyle = '<->' if bidirectional else '->'
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle=arrowstyle, color=color,
                                lw=lw, connectionstyle='arc3,rad=0.0'),
                zorder=4)
    if label_text:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx, my+0.18, label_text, fontsize=7, color=color,
                ha='center', va='bottom', zorder=6,
                path_effects=[pe.withStroke(linewidth=1.5, foreground='black')])

# ══════════════════════════════════════════════════════════════════════════════
# TITLE
# ══════════════════════════════════════════════════════════════════════════════
label(ax, 10, 13.4, 'YANI GARDEN CAFE — SYSTEM ARCHITECTURE', size=15, bold=True, color=C_ACCENT)
label(ax, 10, 13.0, 'POS & Ordering Platform  •  v1.0  •  March 2026', size=9, color=C_GRAY)

# ══════════════════════════════════════════════════════════════════════════════
# LAYER BACKGROUNDS
# ══════════════════════════════════════════════════════════════════════════════
# Layer 1: Users
box(ax, 0.3, 11.0, 19.4, 1.6, C_DARK, alpha=0.5, radius=0.4)
label(ax, 0.85, 12.35, 'USERS', size=8, color=C_GRAY, bold=True, center=False)

# Layer 2: Vercel (CDN + Serverless)
box(ax, 0.3, 7.2, 19.4, 3.5, '#0d2137', alpha=0.5, radius=0.4)
label(ax, 0.85, 10.35, 'VERCEL  (CDN + Serverless Functions)', size=8, color=C_GRAY, bold=True, center=False)

# Layer 3: Google Cloud
box(ax, 0.3, 3.5, 19.4, 3.4, '#1a0d37', alpha=0.5, radius=0.4)
label(ax, 0.85, 6.55, 'GOOGLE CLOUD  (Apps Script + Drive)', size=8, color=C_GRAY, bold=True, center=False)

# Layer 4: GitHub
box(ax, 0.3, 0.3, 19.4, 2.9, '#0d1a0d', alpha=0.5, radius=0.4)
label(ax, 0.85, 2.85, 'GITHUB  (Source of Truth + CI/CD)', size=8, color=C_GRAY, bold=True, center=False)

# ══════════════════════════════════════════════════════════════════════════════
# LAYER 1: USERS
# ══════════════════════════════════════════════════════════════════════════════
# Customer
box(ax, 0.6, 11.2, 2.8, 1.2, C_TEAL, radius=0.3)
label(ax, 2.0, 12.0, '📱 Customer', size=10, bold=True)
label(ax, 2.0, 11.6, 'Scans QR Code', size=8, color='#d5f5e3')

# Staff / Admin
box(ax, 4.0, 11.2, 2.8, 1.2, C_BLUE, radius=0.3)
label(ax, 5.4, 12.0, '🧑‍💼 Staff / Admin', size=10, bold=True)
label(ax, 5.4, 11.6, 'Dashboard Login', size=8, color='#d6eaf8')

# Owner
box(ax, 7.4, 11.2, 2.8, 1.2, C_PURPLE, radius=0.3)
label(ax, 8.8, 12.0, '👑 Owner', size=10, bold=True)
label(ax, 8.8, 11.6, 'Full Access', size=8, color='#e8daef')

# External (GrabFood etc.)
box(ax, 10.8, 11.2, 3.2, 1.2, C_RED, radius=0.3)
label(ax, 12.4, 12.0, '🛵 Platform Orders', size=10, bold=True)
label(ax, 12.4, 11.6, 'GrabFood / FoodPanda', size=8, color='#fadbd8')

# ══════════════════════════════════════════════════════════════════════════════
# LAYER 2: VERCEL
# ══════════════════════════════════════════════════════════════════════════════
# index.html
box(ax, 0.6, 8.8, 2.8, 1.2, '#1565c0', radius=0.3)
label(ax, 2.0, 9.55, '🛒 index.html', size=10, bold=True)
label(ax, 2.0, 9.15, 'Customer Ordering', size=8, color='#bbdefb')

# admin.html
box(ax, 4.0, 8.8, 2.8, 1.2, '#1565c0', radius=0.3)
label(ax, 5.4, 9.55, '⚙️ admin.html', size=10, bold=True)
label(ax, 5.4, 9.15, 'Staff Dashboard', size=8, color='#bbdefb')

# login.html
box(ax, 7.4, 8.8, 2.8, 1.2, '#1565c0', radius=0.3)
label(ax, 8.8, 9.55, '🔐 login.html', size=10, bold=True)
label(ax, 8.8, 9.15, 'PIN Auth Gate', size=8, color='#bbdefb')

# /images CDN
box(ax, 10.8, 8.8, 3.2, 1.2, '#0d47a1', radius=0.3)
label(ax, 12.4, 9.55, '🖼️ /images CDN', size=10, bold=True)
label(ax, 12.4, 9.15, '54 photos (PNG/JPG)', size=8, color='#bbdefb')

# Serverless: /api/pos
box(ax, 0.6, 7.4, 4.2, 1.1, C_ACCENT, alpha=0.85, radius=0.3)
label(ax, 2.7, 8.1, '⚡ /api/pos', size=10, bold=True, color='#1a1a2e')
label(ax, 2.7, 7.7, 'Proxy → GAS (handles 302 redirect)', size=8, color='#1a1a2e')

# Serverless: /api/upload-image
box(ax, 5.3, 7.4, 4.5, 1.1, C_ACCENT, alpha=0.85, radius=0.3)
label(ax, 7.55, 8.1, '⚡ /api/upload-image', size=10, bold=True, color='#1a1a2e')
label(ax, 7.55, 7.7, 'Commits image to GitHub → Vercel redeploy', size=8, color='#1a1a2e')

# Env vars note
box(ax, 14.5, 7.4, 5.0, 1.1, '#263238', radius=0.3)
label(ax, 17.0, 8.1, '🔑 Env Variables', size=10, bold=True, color=C_ACCENT)
label(ax, 17.0, 7.7, 'GITHUB_TOKEN  •  VERCEL_TOKEN', size=8, color=C_GRAY)

# ══════════════════════════════════════════════════════════════════════════════
# LAYER 3: GOOGLE CLOUD
# ══════════════════════════════════════════════════════════════════════════════
# GAS Web App
box(ax, 0.6, 5.5, 5.0, 1.7, '#4a148c', radius=0.3)
label(ax, 3.1, 6.85, '🔧 Google Apps Script', size=10, bold=True)
label(ax, 3.1, 6.45, 'Code.gs  •  PaymentAndReceipts.gs', size=8, color='#e1bee7')
label(ax, 3.1, 6.1, 'auth-functions.gs', size=8, color='#e1bee7')
label(ax, 3.1, 5.75, '18 API actions  •  doPost() entry point', size=8, color='#ce93d8')

# Google Sheets
box(ax, 6.2, 5.5, 7.5, 1.7, '#1b5e20', radius=0.3)
label(ax, 9.95, 6.85, '📊 Google Sheets (Database)', size=10, bold=True)
# Sheet tabs
sheets = [
    ('YGC_MENU', 6.4), ('ORDERS', 7.55), ('ORDER_ITEMS', 8.7),
    ('PAYMENTS', 9.85), ('USERS', 11.0), ('LOGS', 12.05), ('SETTINGS', 13.0)
]
for i, (name, xpos) in enumerate(sheets):
    box(ax, xpos, 5.65, 1.0, 0.5, '#2e7d32', alpha=0.9, radius=0.15)
    label(ax, xpos+0.5, 5.9, name, size=6.5, color='#a5d6a7')

# Google Drive
box(ax, 14.3, 5.5, 5.0, 1.7, '#e65100', alpha=0.8, radius=0.3)
label(ax, 16.8, 6.85, '📁 Google Drive', size=10, bold=True)
label(ax, 16.8, 6.45, 'Payment Proofs', size=8, color='#ffe0b2')
label(ax, 16.8, 6.1, 'Receipt PDFs', size=8, color='#ffe0b2')
label(ax, 16.8, 5.75, 'Email Receipts (Gmail)', size=8, color='#ffcc80')

# GAS doPost note
box(ax, 0.6, 3.7, 5.0, 1.5, '#311b92', radius=0.3)
label(ax, 3.1, 5.0, '🔐 Security Layer', size=9, bold=True)
label(ax, 3.1, 4.65, 'PIN hash verification', size=8, color='#d1c4e9')
label(ax, 3.1, 4.35, 'Table token validation', size=8, color='#d1c4e9')
label(ax, 3.1, 4.05, 'RBAC: OWNER / ADMIN / STAFF', size=8, color='#b39ddb')

# ══════════════════════════════════════════════════════════════════════════════
# LAYER 4: GITHUB
# ══════════════════════════════════════════════════════════════════════════════
# GitHub Repo
box(ax, 0.6, 0.5, 7.5, 2.1, '#2d4a1e', radius=0.3)
label(ax, 4.35, 2.2, '🐙 GitHub: Maldipia/yani-garden-cafe', size=10, bold=True)
label(ax, 4.35, 1.85, 'index.html  •  admin.html  •  login.html', size=8, color='#c8e6c9')
label(ax, 4.35, 1.55, 'api/pos.js  •  api/upload-image.js', size=8, color='#c8e6c9')
label(ax, 4.35, 1.25, 'apps-script/Code.gs  •  PaymentAndReceipts.gs', size=8, color='#c8e6c9')
label(ax, 4.35, 0.95, 'images/ (54 menu photos)', size=8, color='#a5d6a7')
label(ax, 4.35, 0.65, 'vercel.json  •  package.json', size=8, color='#a5d6a7')

# CI/CD note
box(ax, 8.7, 0.5, 5.0, 2.1, '#1a2e1a', radius=0.3)
label(ax, 11.2, 2.2, '🔄 CI/CD Pipeline', size=10, bold=True, color=C_GREEN)
label(ax, 11.2, 1.85, 'git push → Vercel auto-deploy', size=8, color='#c8e6c9')
label(ax, 11.2, 1.55, 'Image upload → GitHub commit', size=8, color='#c8e6c9')
label(ax, 11.2, 1.25, '→ Vercel redeploy (~1-2 min)', size=8, color='#c8e6c9')
label(ax, 11.2, 0.95, 'Branch: main', size=8, color='#a5d6a7')
label(ax, 11.2, 0.65, 'Auto-alias: yani-garden-cafe-d3l6.vercel.app', size=8, color='#a5d6a7')

# Apps Script note
box(ax, 14.3, 0.5, 5.0, 2.1, '#1a1a2e', radius=0.3)
label(ax, 16.8, 2.2, '📝 GAS Deployment', size=10, bold=True, color=C_ACCENT)
label(ax, 16.8, 1.85, 'Manual deploy required', size=8, color='#ffe082')
label(ax, 16.8, 1.55, 'Apps Script Editor → Deploy', size=8, color='#fff9c4')
label(ax, 16.8, 1.25, '→ Manage Deployments', size=8, color='#fff9c4')
label(ax, 16.8, 0.95, '→ New Version', size=8, color='#fff9c4')
label(ax, 16.8, 0.65, 'URL stored in api/pos.js', size=8, color='#ffe082')

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — User to Frontend
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 2.0, 11.2, 2.0, 10.0, color=C_TEAL, label_text='QR → URL token')
arrow(ax, 5.4, 11.2, 5.4, 10.0, color=C_BLUE, label_text='PIN login')
arrow(ax, 8.8, 11.2, 8.8, 10.0, color=C_PURPLE, label_text='Full access')
arrow(ax, 12.4, 11.2, 5.4, 10.0, color=C_RED, label_text='Platform orders')

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — Frontend to Serverless
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 2.0, 8.8, 2.0, 8.5, color=C_ACCENT, label_text='POST /api/pos')
arrow(ax, 5.4, 8.8, 5.4, 8.5, color=C_ACCENT)
arrow(ax, 8.8, 8.8, 7.55, 8.5, color=C_ACCENT, label_text='POST /api/upload-image')

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — Serverless to GAS
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 2.7, 7.4, 2.7, 7.2, color=C_GREEN, label_text='JSON-RPC via HTTPS')
arrow(ax, 7.55, 7.4, 7.55, 7.2, color=C_GREEN)

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — GAS to Sheets
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 5.6, 6.35, 6.2, 6.35, color=C_GREEN, bidirectional=True, label_text='Read / Write')

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — GAS to Drive
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 13.7, 6.35, 14.3, 6.35, color='#ff8f00', label_text='Store files / Send email')

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — GitHub to Vercel
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 8.1, 2.6, 8.1, 7.2, color=C_GREEN, label_text='Auto-deploy on push')

# ══════════════════════════════════════════════════════════════════════════════
# ARROWS — upload-image to GitHub
# ══════════════════════════════════════════════════════════════════════════════
arrow(ax, 7.55, 7.4, 4.35, 2.6, color='#ff8f00', label_text='Commit image via GitHub API')

# ══════════════════════════════════════════════════════════════════════════════
# LEGEND
# ══════════════════════════════════════════════════════════════════════════════
box(ax, 14.8, 3.7, 4.8, 1.5, '#1c1c2e', radius=0.3)
label(ax, 17.2, 5.0, 'LEGEND', size=9, bold=True, color=C_ACCENT)
legend_items = [
    (C_TEAL, 'Customer Flow'),
    (C_BLUE, 'Admin/Staff Flow'),
    (C_GREEN, 'Data Flow'),
    ('#ff8f00', 'File / Deploy Flow'),
    (C_ACCENT, 'API Call'),
]
for i, (col, lbl) in enumerate(legend_items):
    y_pos = 4.7 - i * 0.22
    ax.plot([15.0, 15.5], [y_pos, y_pos], color=col, lw=2, zorder=6)
    label(ax, 15.6, y_pos, lbl, size=7.5, color=C_WHITE, center=False)

plt.tight_layout(pad=0.5)
plt.savefig('/home/ubuntu/yani-garden-cafe/system_architecture.png',
            dpi=150, bbox_inches='tight', facecolor=C_BG)
plt.close()
print("Diagram saved: system_architecture.png")
