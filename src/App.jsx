import { useState, useEffect, useCallback, useRef } from "react";

// ══════════════════════════════════════════════════════════════════
// YANI GARDEN CAFE — Online Menu & Ordering System
// Theme: Grounded Elevation
// Brand Bible Compliant
// ══════════════════════════════════════════════════════════════════

const API_URL = "https://script.google.com/macros/s/AKfycbyZas3mCRQ2KmFCGlDqSbcNX1lqkrcUjCKyOOgALywtPNjsHA_IOFadv40sZT9VMNQ9/exec";

// ── Brand Bible Color Palette: Mountain Mist & Roasted Earth ──
const B = {
  forest:     "#314C47",  // Deep Forest Green — Primary (Foliage)
  terra:      "#CB694C",  // Roasted Terra — Accent (The Cherry)
  gold:       "#C0AC56",  // Antique Gold (The Blessing)
  mist:       "#C9CAC4",  // Mountain Mist — Negative Space (Fog)
  coffee:     "#533720",  // Coffee Brown
  timber:     "#84592E",  // Raw Timber
  cream:      "#F4F2ED",  // Light mist/linen background
  parchment:  "#FAFAF6",  // Near-white warm
  forestDeep: "#243B37",  // Deeper forest for gradients
  mistLight:  "#E8E8E4",  // Lighter mist
  terraLight: "#F2DDD4",  // Light terra for subtle accents
  goldLight:  "#EDE8D0",  // Light gold wash
};

// ── Typography (Brand Bible) ──
const FONT_SOUL = "'STIX Two Text', 'Georgia', 'Times New Roman', serif";     // Headlines — The Soul
const FONT_FUNC = "'Montserrat', 'Segoe UI', system-ui, sans-serif";          // Body — The Function

// ── Local image map (bundled in /public/images/) ──
const IMG = (id, ext = "png") => `/images/${id}.${ext}`;

// ── Menu Data (from your Google Sheet — active items only) ──
const FALLBACK_MENU = [
  // ── COLD BEVERAGES ──
  { id: "C001", category: "COLD BEVERAGE", name: "Iced Dark Cocoa Ovaltine", price: 150, isHot: false, isCold: true, image: IMG("C001") },
  { id: "C003", category: "COLD BEVERAGE", name: "Strawberry Sunrise", price: 160, isHot: false, isCold: true, image: IMG("C003") },
  { id: "C006", category: "COLD BEVERAGE", name: "Blueberry Milk", price: 170, isHot: false, isCold: true, image: IMG("C006") },
  { id: "C008", category: "COLD BEVERAGE", name: "Caramel Macchiato Frappe", price: 180, isHot: false, isCold: true, image: IMG("C008") },
  { id: "C009", category: "COLD BEVERAGE", name: "Creamy Double Dutch Frappe", price: 180, isHot: false, isCold: true, image: IMG("C009") },
  { id: "C010", category: "COLD BEVERAGE", name: "Lush Oreo Frappe", price: 180, isHot: false, isCold: true, image: IMG("C010") },
  // ── COFFEE (Hot & Iced) ──
  { id: "C004", category: "COFFEE", name: "Coffee Frost", price: 150, isHot: false, isCold: true, image: IMG("C004", "jpg") },
  { id: "C005", category: "COFFEE", name: "Katapang", price: 140, isHot: false, isCold: true, image: IMG("C005") },
  { id: "H001", category: "COFFEE", name: "Hot Americano", price: 120, isHot: true, isCold: false, image: IMG("H001") },
  { id: "H002", category: "COFFEE", name: "Hot Spanish Latte", price: 150, isHot: true, isCold: false, image: IMG("H002") },
  { id: "H003", category: "COFFEE", name: "Hot Cafe Mocha", price: 160, isHot: true, isCold: false, image: IMG("H003") },
  { id: "H004", category: "COFFEE", name: "Cinnamon Espresso Latte", price: 130, isHot: true, isCold: false, image: IMG("H004") },
  { id: "H007", category: "COFFEE", name: "Cinnamon Espresso Choco Latte", price: 130, isHot: true, isCold: false, image: IMG("H007") },
  // ── PASTRY ──
  { id: "P001", category: "PASTRY", name: "Banana Bread Loaf", price: 180, isHot: true, isCold: false, image: IMG("P001") },
  { id: "P002", category: "PASTRY", name: "Banana Bread Cupcake", price: 85, isHot: false, isCold: false, image: IMG("P002") },
  // ── SODA ──
  { id: "S001", category: "SODA", name: "Strawberry Soda", price: 120, isHot: false, isCold: true, image: IMG("S001") },
  { id: "S002", category: "SODA", name: "Blueberry Soda", price: 120, isHot: false, isCold: true, image: IMG("S002") },
];

const CATEGORIES = [
  { key: "all", label: "All", icon: "✦" },
  { key: "COFFEE", label: "Coffee", icon: "☕" },
  { key: "COLD BEVERAGE", label: "Cold Drinks", icon: "❄" },
  { key: "SODA", label: "Soda", icon: "🫧" },
  { key: "PASTRY", label: "Pastry", icon: "🌿" },
];

const fmt = (n) => n ? `₱${Number(n).toLocaleString()}` : "—";

// ── API ──
const api = {
  ok: () => API_URL && !API_URL.includes("YOUR_"),
  fetchMenu: async () => {
    if (!api.ok()) return { menu: FALLBACK_MENU.filter(i => i.price > 0) };
    const r = await fetch(`${API_URL}?action=menu`); return r.json();
  },
  submitOrder: async (d) => {
    if (!api.ok()) return { success: true, orderId: `YANI-${Date.now().toString().slice(-8)}`, total: d.items.reduce((s, i) => s + i.price * i.qty, 0) };
    const r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "order", ...d }) }); return r.json();
  },
  fetchOrders: async (s) => {
    if (!api.ok()) return { orders: [] };
    const r = await fetch(s ? `${API_URL}?action=orders&status=${s}` : `${API_URL}?action=orders`); return r.json();
  },
  updateStatus: async (id, s) => {
    if (!api.ok()) return { success: true };
    const r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "updateStatus", orderId: id, status: s }) }); return r.json();
  },
};

// ══════════════════════════════════════════════════════════════════
// INJECT BRAND STYLES
// ══════════════════════════════════════════════════════════════════
if (!document.querySelector("[data-yani-styles]")) {
  const s = document.createElement("style");
  s.setAttribute("data-yani-styles", "true");
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=STIX+Two+Text:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600&family=Montserrat:wght@300;400;500;600;700;800&display=swap');

    @keyframes yFadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
    @keyframes yFadeIn { from { opacity:0; } to { opacity:1; } }
    @keyframes yBounce { 0% { transform:scale(0); } 60% { transform:scale(1.12); } 100% { transform:scale(1); } }
    @keyframes ySteam {
      0% { opacity:0; transform:translateY(0) scaleX(1); }
      40% { opacity:0.35; }
      100% { opacity:0; transform:translateY(-14px) scaleX(1.6); }
    }
    @keyframes yShimmer { 0% { background-position:-200% 0; } 100% { background-position:200% 0; } }
    @keyframes yFloat { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-6px); } }
    @keyframes yLeafDrift {
      0% { transform:rotate(0deg) translateX(0); opacity:0.15; }
      50% { transform:rotate(8deg) translateX(6px); opacity:0.25; }
      100% { transform:rotate(0deg) translateX(0); opacity:0.15; }
    }

    .y-up { animation: yFadeUp 0.5s ease both; }
    .y-fade { animation: yFadeIn 0.4s ease both; }
    .y-badge { animation: yBounce 0.3s ease both; }
    .y-float { animation: yFloat 4s ease-in-out infinite; }
    .y-shimmer { background:linear-gradient(90deg,${B.mistLight} 25%,${B.mist} 50%,${B.mistLight} 75%); background-size:200% 100%; animation:yShimmer 1.5s infinite; }

    .y-card { animation: yFadeUp 0.45s ease both; transition: transform 0.25s ease, box-shadow 0.25s ease; }
    .y-card:active { transform: scale(0.97) !important; }

    .y-btn { transition: all 0.2s ease; }
    .y-btn:active { transform: scale(0.92); }

    * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
    input,button { font-family:${FONT_FUNC}; }

    ::-webkit-scrollbar { width:3px; height:3px; }
    ::-webkit-scrollbar-track { background:transparent; }
    ::-webkit-scrollbar-thumb { background:${B.mist}; border-radius:3px; }
  `;
  document.head.appendChild(s);
}

// ══════════════════════════════════════════════════════════════════
// COMPONENTS
// ══════════════════════════════════════════════════════════════════

function ProductImage({ item, size = 72 }) {
  const [err, setErr] = useState(false);
  const getUrl = (link, id) => {
    // Local path (starts with /)
    if (link && link.startsWith("/")) return link;
    // Google Drive link
    if (link) {
      const m = link.match(/[?&]id=([a-zA-Z0-9_-]+)/) || link.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (m) return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w400`;
      if (link.startsWith("http")) return link;
    }
    // Fallback: try local image by item ID
    if (id) {
      const ext = id === "C004" ? "jpg" : "png";
      return `/images/${id}.${ext}`;
    }
    return null;
  };
  const url = getUrl(item.image, item.id);
  if (!url || err) {
    const icons = { "COFFEE": "☕", "COLD BEVERAGE": "🧊", "SODA": "🫧", "PASTRY": "🍞" };
    return (
      <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.5, position: "relative" }}>
        {item.isHot && (
          <>
            <span style={{ position: "absolute", top: -4, left: "38%", fontSize: 10, opacity: 0.4, animation: "ySteam 2.2s infinite" }}>~</span>
            <span style={{ position: "absolute", top: -4, left: "52%", fontSize: 10, opacity: 0.4, animation: "ySteam 2.2s infinite 0.6s" }}>~</span>
          </>
        )}
        {icons[item.category?.toUpperCase()] || "☕"}
      </div>
    );
  }
  return <img src={url} alt={item.name} onError={() => setErr(true)} style={{ width: size, height: size, objectFit: "cover", borderRadius: 10 }} />;
}

// ── Leaf decoration SVG ──
function LeafDecor({ style }) {
  return (
    <svg viewBox="0 0 60 60" fill="none" style={{ width: 28, height: 28, opacity: 0.12, ...style }}>
      <path d="M30 5C30 5 10 20 10 35C10 50 25 55 30 55C35 55 50 50 50 35C50 20 30 5 30 5Z" fill={B.forest} />
      <path d="M30 15V50M20 25L30 35M40 28L30 38" stroke={B.forest} strokeWidth="1.5" opacity="0.5" />
    </svg>
  );
}

// ── Noise texture overlay ──
function GrainOverlay({ opacity = 0.03 }) {
  return (
    <div style={{
      position: "absolute", inset: 0, opacity, pointerEvents: "none", mixBlendMode: "multiply",
      backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`
    }} />
  );
}

// ══════════════════════════════════════════════════════════════════
// ORDER RECEIPT — "The Blessing Slip"
// ══════════════════════════════════════════════════════════════════
function OrderReceipt({ order, tableNumber, zone, onClose, onConfirm }) {
  const total = order.reduce((s, i) => s + i.price * i.qty, 0);
  const now = new Date();
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [result, setResult] = useState(null);

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      const res = await api.submitOrder({
        tableNumber: `${zone ? zone + " — " : ""}${tableNumber}`,
        items: order.map(i => ({ id: i.id, name: i.name, price: i.price, qty: i.qty })),
        paymentMethod: "PENDING",
      });
      setResult(res);
    } catch (e) {
      setResult({ success: true, orderId: `YANI-${Date.now().toString().slice(-6)}` });
    }
    setDone(true);
    setSubmitting(false);
  };

  return (
    <div className="y-fade" style={{
      position: "fixed", inset: 0, background: "rgba(36,59,55,0.75)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      backdropFilter: "blur(14px)"
    }} onClick={done ? onConfirm : undefined}>
      <div onClick={e => e.stopPropagation()} style={{
        background: B.parchment, borderRadius: 20, padding: "36px 28px", maxWidth: 380,
        width: "100%", boxShadow: "0 30px 60px rgba(36,59,55,0.35)", fontFamily: FONT_FUNC,
        position: "relative", overflow: "hidden"
      }}>
        <GrainOverlay opacity={0.02} />

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24, position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: B.forest, letterSpacing: 2, fontFamily: FONT_SOUL }}>
            Yani Garden Cafe
          </div>
          <div style={{ fontSize: 10, color: B.gold, letterSpacing: 4, marginTop: 4, fontWeight: 500 }}>
            FEED YOUR SOUL
          </div>
          <div style={{ width: 40, height: 1.5, background: B.gold, margin: "14px auto 10px", borderRadius: 1 }} />
          <div style={{ fontSize: 11, color: B.timber }}>
            {now.toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric' })}
            {" · "}{now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' })}
          </div>
          {tableNumber && (
            <div style={{ fontSize: 12, fontWeight: 600, color: B.forest, marginTop: 6 }}>
              {zone && <span style={{ color: B.terra }}>{zone}</span>}
              {zone && " — "}{tableNumber}
            </div>
          )}
        </div>

        {done && result && (
          <div style={{
            background: B.forest, color: B.cream, padding: "10px 16px", borderRadius: 10,
            textAlign: "center", marginBottom: 16, fontSize: 12, fontWeight: 700, letterSpacing: 2
          }}>✦ ORDER {result.orderId}</div>
        )}

        {/* Items */}
        <div style={{ borderTop: `1px solid ${B.mist}`, borderBottom: `1px solid ${B.mist}`, padding: "14px 0", marginBottom: 12, position: "relative", zIndex: 1 }}>
          {order.map((item, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13 }}>
              <span style={{ color: B.coffee }}><span style={{ fontWeight: 700 }}>{item.qty}×</span> {item.name}</span>
              <span style={{ fontWeight: 700, color: B.forest }}>{fmt(item.price * item.qty)}</span>
            </div>
          ))}
        </div>

        <div style={{
          display: "flex", justifyContent: "space-between", padding: "14px 0",
          fontSize: 22, fontWeight: 700, color: B.forest, borderTop: `2px solid ${B.forest}`,
          fontFamily: FONT_SOUL, position: "relative", zIndex: 1
        }}>
          <span>Total</span><span>{fmt(total)}</span>
        </div>

        {!done ? (
          <div style={{ display: "flex", gap: 10, marginTop: 20, position: "relative", zIndex: 1 }}>
            <button onClick={onClose} className="y-btn" style={{
              flex: 1, padding: 14, background: B.mistLight, border: "none", borderRadius: 12,
              fontWeight: 600, fontSize: 13, cursor: "pointer", color: B.timber
            }}>← Back</button>
            <button onClick={handleConfirm} disabled={submitting} className="y-btn" style={{
              flex: 2, padding: 14, background: submitting ? B.mist : B.forest,
              border: "none", borderRadius: 12, color: B.cream, fontWeight: 700,
              fontSize: 15, cursor: submitting ? "wait" : "pointer", letterSpacing: 1
            }}>{submitting ? "Sending..." : "✦ Place Order"}</button>
          </div>
        ) : (
          <div style={{ textAlign: "center", marginTop: 20, position: "relative", zIndex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: B.forest, fontFamily: FONT_SOUL, marginBottom: 4 }}>
              Order received
            </div>
            <div style={{ fontSize: 12, color: B.timber, marginBottom: 16, fontStyle: "italic" }}>
              Your cup is being prepared with care
            </div>
            <button onClick={onConfirm} className="y-btn" style={{
              width: "100%", padding: 14, background: B.forest, border: "none",
              borderRadius: 12, color: B.cream, fontWeight: 700, fontSize: 14, cursor: "pointer"
            }}>Done</button>
          </div>
        )}

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 10, color: B.mist, letterSpacing: 2, fontStyle: "italic", position: "relative", zIndex: 1 }}>
          Yani... essential ✦
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MENU CARD
// ══════════════════════════════════════════════════════════════════
function MenuCard({ item, onAdd, cartQty, index }) {
  const catGradients = {
    "COFFEE": `linear-gradient(155deg, ${B.coffee} 0%, ${B.timber} 100%)`,
    "COLD BEVERAGE": `linear-gradient(155deg, ${B.forest} 0%, ${B.forestDeep} 100%)`,
    "SODA": `linear-gradient(155deg, ${B.terra} 0%, #A85A40 100%)`,
    "PASTRY": `linear-gradient(155deg, ${B.timber} 0%, ${B.coffee} 100%)`,
  };
  const gradient = catGradients[item.category?.toUpperCase()] || catGradients["COFFEE"];

  return (
    <div className="y-card" style={{
      background: B.parchment, borderRadius: 16, overflow: "hidden",
      boxShadow: "0 2px 16px rgba(49,76,71,0.08)", position: "relative",
      animationDelay: `${index * 0.07}s`, cursor: "pointer",
    }} onClick={() => onAdd(item)}>

      {cartQty > 0 && (
        <div className="y-badge" style={{
          position: "absolute", top: 8, right: 8, zIndex: 10,
          background: B.terra, color: "#fff", width: 24, height: 24,
          borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, fontWeight: 800, boxShadow: "0 3px 10px rgba(203,105,76,0.4)"
        }}>{cartQty}</div>
      )}

      {/* Image area */}
      <div style={{
        background: gradient, padding: "22px 16px", textAlign: "center",
        position: "relative", minHeight: 100, display: "flex",
        alignItems: "center", justifyContent: "center",
      }}>
        <GrainOverlay opacity={0.06} />
        <div style={{ position: "relative", zIndex: 1 }}>
          <ProductImage item={item} size={68} />
        </div>
        {/* Temperature tags */}
        <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: 4, zIndex: 2 }}>
          {item.isHot && (
            <span style={{
              background: "rgba(203,105,76,0.9)", color: "#fff", fontSize: 8,
              padding: "2px 7px", borderRadius: 10, fontWeight: 700, letterSpacing: 1,
              fontFamily: FONT_FUNC
            }}>HOT</span>
          )}
          {item.isCold && (
            <span style={{
              background: "rgba(49,76,71,0.85)", color: "#fff", fontSize: 8,
              padding: "2px 7px", borderRadius: 10, fontWeight: 700, letterSpacing: 1,
              fontFamily: FONT_FUNC
            }}>ICED</span>
          )}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: "12px 14px 14px" }}>
        <div style={{
          fontSize: 12.5, fontWeight: 600, color: B.forest, lineHeight: 1.35,
          minHeight: 34, fontFamily: FONT_FUNC,
          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden"
        }}>{item.name}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: B.forest, fontFamily: FONT_SOUL }}>
            {fmt(item.price)}
          </div>
          <button className="y-btn" onClick={(e) => { e.stopPropagation(); onAdd(item); }} style={{
            background: B.forest, border: "none", color: B.cream,
            width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
            fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 3px 12px rgba(49,76,71,0.3)`,
          }}>+</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// CART DRAWER
// ══════════════════════════════════════════════════════════════════
function CartDrawer({ cart, setCart, onCheckout }) {
  const items = Object.values(cart);
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const count = items.reduce((s, i) => s + i.qty, 0);
  if (count === 0) return null;

  return (
    <div className="y-fade" style={{
      position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 900,
      maxWidth: 480, margin: "0 auto",
    }}>
      <div style={{
        background: `linear-gradient(to top, ${B.forestDeep}, ${B.forest})`,
        borderRadius: "20px 20px 0 0", padding: "16px 20px 20px",
        boxShadow: "0 -10px 40px rgba(36,59,55,0.5)", color: B.cream,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 700, fontFamily: FONT_SOUL }}>Your Order</span>
            <span style={{
              background: B.terra, color: "#fff", padding: "2px 10px",
              borderRadius: 14, fontSize: 11, fontWeight: 700
            }}>{count}</span>
          </div>
          <button onClick={() => setCart({})} style={{
            background: "rgba(255,255,255,0.1)", border: "none", color: "rgba(255,255,255,0.6)",
            borderRadius: 8, padding: "4px 12px", cursor: "pointer", fontSize: 11, fontWeight: 600
          }}>Clear</button>
        </div>

        <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 14 }}>
          {items.map(item => (
            <div key={item.id} style={{
              display: "flex", alignItems: "center", padding: "7px 0",
              borderBottom: "1px solid rgba(255,255,255,0.08)"
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)" }}>{fmt(item.price)}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 10 }}>
                <button onClick={() => setCart(prev => {
                  const n = { ...prev };
                  if (n[item.id].qty <= 1) delete n[item.id];
                  else n[item.id] = { ...n[item.id], qty: n[item.id].qty - 1 };
                  return n;
                })} style={{
                  width: 24, height: 24, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.2)",
                  background: "transparent", color: "#fff", cursor: "pointer", fontSize: 14,
                  display: "flex", alignItems: "center", justifyContent: "center"
                }}>−</button>
                <span style={{ fontWeight: 700, fontSize: 13, minWidth: 16, textAlign: "center" }}>{item.qty}</span>
                <button onClick={() => setCart(prev => ({ ...prev, [item.id]: { ...prev[item.id], qty: prev[item.id].qty + 1 } }))} style={{
                  width: 24, height: 24, borderRadius: "50%", border: "none",
                  background: B.terra, color: "#fff", cursor: "pointer", fontSize: 14,
                  display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700
                }}>+</button>
              </div>
              <div style={{ fontWeight: 600, fontSize: 13, minWidth: 56, textAlign: "right" }}>{fmt(item.price * item.qty)}</div>
            </div>
          ))}
        </div>

        <button onClick={() => onCheckout(items)} className="y-btn" style={{
          width: "100%", padding: 15, borderRadius: 14, border: "none",
          background: B.terra, color: "#fff",
          fontWeight: 700, fontSize: 15, cursor: "pointer", letterSpacing: 1,
          boxShadow: "0 4px 18px rgba(203,105,76,0.35)", fontFamily: FONT_FUNC,
          display: "flex", justifyContent: "space-between", alignItems: "center"
        }}>
          <span>Place Order</span>
          <span style={{ fontFamily: FONT_SOUL, fontSize: 17 }}>{fmt(total)}</span>
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// KITCHEN QUEUE (Staff)
// ══════════════════════════════════════════════════════════════════
function KitchenQueue({ onBack }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try { const d = await api.fetchOrders(); setOrders(d.orders || []); } catch(e){}
    setLoading(false);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);

  const update = async (id, s) => { await api.updateStatus(id, s); load(); };
  const colors = { NEW: B.terra, PREPARING: B.gold, SERVED: B.forest, PAID: "#5B8A72", VOID: B.mist };

  return (
    <div style={{ minHeight: "100vh", background: B.cream, fontFamily: FONT_FUNC, padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, color: B.forest, fontSize: 20, fontWeight: 700, fontFamily: FONT_SOUL }}>The Slow Bar</h2>
          <div style={{ fontSize: 11, color: B.timber }}>Kitchen Queue · Auto-refreshes</div>
        </div>
        <button onClick={onBack} className="y-btn" style={{
          padding: "8px 16px", background: B.parchment, border: `1px solid ${B.mist}`,
          borderRadius: 10, cursor: "pointer", fontSize: 12, fontWeight: 600, color: B.forest
        }}>← Menu</button>
      </div>
      {loading ? <div style={{ textAlign: "center", padding: 60, color: B.mist }}>Loading...</div> :
       orders.length === 0 ? <div style={{ textAlign: "center", padding: 60, color: B.mist, fontFamily: FONT_SOUL, fontSize: 16 }}>Quiet moment... no orders yet ✦</div> :
        <div style={{ display: "grid", gap: 12 }}>
          {orders.filter(o => o.status !== 'VOID').slice(0, 20).map(o => (
            <div key={o.orderId} style={{
              background: B.parchment, borderRadius: 14, padding: 16,
              boxShadow: "0 2px 12px rgba(49,76,71,0.06)", borderLeft: `4px solid ${colors[o.status] || B.mist}`
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14, color: B.forest }}>{o.orderId}</div>
                  <div style={{ fontSize: 11, color: B.timber }}>{o.tableNumber} · {o.timestamp}</div>
                </div>
                <span style={{ background: colors[o.status], color: "#fff", padding: "3px 10px", borderRadius: 10, fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>{o.status}</span>
              </div>
              <div style={{ fontSize: 13, color: B.coffee, marginBottom: 10 }}>{o.itemsSummary}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 700, fontSize: 16, color: B.forest, fontFamily: FONT_SOUL }}>{fmt(o.subtotal)}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {o.status === "NEW" && <button onClick={() => update(o.orderId, "PREPARING")} className="y-btn" style={{ padding: "6px 14px", background: B.gold, border: "none", borderRadius: 8, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>▶ Prepare</button>}
                  {o.status === "PREPARING" && <button onClick={() => update(o.orderId, "SERVED")} className="y-btn" style={{ padding: "6px 14px", background: B.forest, border: "none", borderRadius: 8, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>✦ Served</button>}
                  {o.status === "SERVED" && <button onClick={() => update(o.orderId, "PAID")} className="y-btn" style={{ padding: "6px 14px", background: "#5B8A72", border: "none", borderRadius: 8, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>💰 Paid</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      }
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP — THE PORTAL
// ══════════════════════════════════════════════════════════════════
export default function YaniGardenCafe() {
  const [mode, setMode] = useState("welcome");
  const [menu, setMenu] = useState([]);
  const [activeCategory, setActiveCategory] = useState("all");
  const [cart, setCart] = useState({});
  const [tableNumber, setTableNumber] = useState("");
  const [zone, setZone] = useState("");
  const [showReceipt, setShowReceipt] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const d = await api.fetchMenu();
        setMenu((d.menu || []).filter(i => i.price > 0));
      } catch (e) {
        setMenu(FALLBACK_MENU.filter(i => i.price > 0));
      }
      setLoading(false);
    })();
  }, []);

  const filtered = activeCategory === "all" ? menu : menu.filter(i => (i.category || "").toUpperCase() === activeCategory);
  const cartCount = Object.values(cart).reduce((s, i) => s + i.qty, 0);
  const addToCart = (item) => {
    setCart(prev => ({
      ...prev,
      [item.id]: prev[item.id] ? { ...prev[item.id], qty: prev[item.id].qty + 1 } : { ...item, qty: 1 }
    }));
  };

  if (mode === "kitchen") return <KitchenQueue onBack={() => setMode("menu")} />;

  // ── WELCOME: The Portal ──
  if (mode === "welcome") {
    return (
      <div className="y-fade" style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: `linear-gradient(165deg, ${B.forestDeep} 0%, ${B.forest} 50%, #3D5D57 100%)`,
        fontFamily: FONT_FUNC, padding: 24, position: "relative", overflow: "hidden"
      }}>
        <GrainOverlay opacity={0.04} />

        {/* Floating leaf decorations */}
        <div style={{ position: "absolute", top: "10%", left: "8%", animation: "yLeafDrift 8s ease-in-out infinite" }}><LeafDecor /></div>
        <div style={{ position: "absolute", bottom: "15%", right: "10%", animation: "yLeafDrift 10s ease-in-out infinite 2s", transform: "rotate(45deg)" }}><LeafDecor /></div>
        <div style={{ position: "absolute", top: "60%", left: "5%", animation: "yLeafDrift 12s ease-in-out infinite 4s", transform: "rotate(-30deg)" }}><LeafDecor /></div>

        <div style={{
          background: B.parchment, borderRadius: 24, padding: "44px 32px", maxWidth: 380,
          width: "100%", textAlign: "center", boxShadow: "0 30px 70px rgba(36,59,55,0.4)",
          position: "relative", overflow: "hidden", zIndex: 1
        }}>
          <GrainOverlay opacity={0.015} />

          {/* Gold accent line */}
          <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: 60, height: 3, background: B.gold, borderRadius: "0 0 3px 3px" }} />

          {/* Logo mark */}
          <div style={{ marginBottom: 16, position: "relative", zIndex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: 5, color: B.mist, fontWeight: 500, marginBottom: 10 }}>WELCOME TO</div>
            {/* Leaf + Cup icon */}
            <div style={{ fontSize: 42, marginBottom: 8, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.08))" }}>🌿☕</div>
          </div>

          <h1 style={{
            margin: 0, fontSize: 30, fontWeight: 700, color: B.forest,
            letterSpacing: 1, fontFamily: FONT_SOUL, lineHeight: 1.2,
            position: "relative", zIndex: 1
          }}>Yani Garden Cafe</h1>

          <div style={{
            fontSize: 10, letterSpacing: 5, color: B.gold, marginTop: 6,
            fontWeight: 600, textTransform: "uppercase", position: "relative", zIndex: 1
          }}>Feed Your Soul</div>

          <div style={{ width: 40, height: 1.5, background: B.gold, margin: "24px auto", borderRadius: 1, position: "relative", zIndex: 1 }} />

          {/* Zone selection */}
          <div style={{ marginBottom: 16, position: "relative", zIndex: 1 }}>
            <div style={{ fontSize: 12, color: B.timber, marginBottom: 8, fontWeight: 500 }}>Where are you seated?</div>
            <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
              {[
                { key: "The Campfire", label: "🔥 The Campfire" },
                { key: "The Gallery", label: "🖼 The Gallery" },
                { key: "The Nest", label: "🪺 The Nest" },
              ].map(z => (
                <button key={z.key} onClick={() => setZone(z.key)} className="y-btn" style={{
                  padding: "7px 14px", borderRadius: 20, border: zone === z.key ? `2px solid ${B.forest}` : `1px solid ${B.mist}`,
                  background: zone === z.key ? B.forest : B.parchment,
                  color: zone === z.key ? B.cream : B.timber,
                  fontWeight: 600, fontSize: 11, cursor: "pointer",
                  transition: "all 0.2s"
                }}>{z.label}</button>
              ))}
            </div>
          </div>

          <input
            type="text" value={tableNumber}
            onChange={e => setTableNumber(e.target.value)}
            placeholder="Table number"
            style={{
              width: "100%", padding: 15, borderRadius: 12,
              border: `2px solid ${B.mist}`, fontSize: 18, textAlign: "center",
              fontWeight: 600, color: B.forest, outline: "none", background: B.cream,
              fontFamily: FONT_FUNC, transition: "border-color 0.2s",
              position: "relative", zIndex: 1
            }}
            onFocus={e => e.target.style.borderColor = B.forest}
            onBlur={e => e.target.style.borderColor = B.mist}
          />

          <button onClick={() => setMode("menu")} className="y-btn" style={{
            width: "100%", marginTop: 16, padding: 16, borderRadius: 14, border: "none",
            background: B.forest, color: B.cream, fontWeight: 700, fontSize: 15,
            cursor: "pointer", letterSpacing: 2, fontFamily: FONT_FUNC,
            boxShadow: `0 6px 24px rgba(49,76,71,0.3)`,
            position: "relative", zIndex: 1
          }}>VIEW MENU →</button>

          <button onClick={() => setMode("kitchen")} className="y-btn" style={{
            width: "100%", marginTop: 10, padding: 10, background: "transparent",
            border: `1px solid ${B.mistLight}`, borderRadius: 12, color: B.mist,
            fontSize: 11, fontWeight: 500, cursor: "pointer", fontFamily: FONT_FUNC,
            position: "relative", zIndex: 1
          }}>🔐 Staff — The Slow Bar</button>

          {!api.ok() && (
            <div style={{
              marginTop: 16, padding: "8px 12px", background: B.goldLight,
              borderRadius: 8, fontSize: 10, color: B.timber, lineHeight: 1.5,
              position: "relative", zIndex: 1
            }}>
              ✦ <strong>Demo Mode</strong> — Deploy Apps Script backend to go live.
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── MENU VIEW ──
  return (
    <div style={{
      minHeight: "100vh", fontFamily: FONT_FUNC,
      background: `linear-gradient(180deg, ${B.cream} 0%, ${B.parchment} 40%, ${B.cream} 100%)`,
      maxWidth: 480, margin: "0 auto", position: "relative",
      paddingBottom: cartCount > 0 ? 210 : 24,
    }}>
      {showReceipt && (
        <OrderReceipt
          order={Object.values(cart)} tableNumber={tableNumber} zone={zone}
          onClose={() => setShowReceipt(false)}
          onConfirm={() => { setShowReceipt(false); setCart({}); }}
        />
      )}

      {/* ── Header: The Portal Bar ── */}
      <div style={{
        background: `linear-gradient(165deg, ${B.forestDeep} 0%, ${B.forest} 60%, #3D5D57 100%)`,
        padding: "32px 20px 22px", borderRadius: "0 0 24px 24px",
        color: B.cream, textAlign: "center", position: "relative", overflow: "hidden",
        boxShadow: "0 8px 30px rgba(36,59,55,0.25)",
      }}>
        <GrainOverlay opacity={0.05} />

        {/* Back button */}
        <button onClick={() => setMode("welcome")} style={{
          position: "absolute", top: 16, left: 16, background: "rgba(255,255,255,0.1)",
          border: "none", color: "rgba(255,255,255,0.7)", borderRadius: 8,
          padding: "4px 10px", cursor: "pointer", fontSize: 12, zIndex: 2
        }}>←</button>

        <div style={{ position: "relative", zIndex: 1 }}>
          <div style={{ fontSize: 10, letterSpacing: 5, color: B.gold, marginBottom: 6, fontWeight: 500 }}>
            YANI GARDEN CAFE
          </div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, letterSpacing: 1, fontFamily: FONT_SOUL }}>
            Feed your Soul.
          </h1>
          <div style={{
            display: "flex", justifyContent: "center", gap: 12, marginTop: 12, fontSize: 11
          }}>
            {zone && (
              <span style={{
                background: "rgba(255,255,255,0.1)", padding: "3px 12px", borderRadius: 14,
                backdropFilter: "blur(4px)"
              }}>🌿 {zone}</span>
            )}
            {tableNumber && (
              <span style={{
                background: "rgba(255,255,255,0.1)", padding: "3px 12px", borderRadius: 14,
                backdropFilter: "blur(4px)"
              }}>📍 {tableNumber}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Category pills ── */}
      <div style={{
        display: "flex", gap: 8, padding: "16px 16px 8px", overflowX: "auto",
        scrollbarWidth: "none", WebkitOverflowScrolling: "touch",
      }}>
        {CATEGORIES.map(cat => {
          const active = activeCategory === cat.key;
          return (
            <button key={cat.key} onClick={() => setActiveCategory(cat.key)} className="y-btn" style={{
              padding: "9px 18px", borderRadius: 22, border: "none",
              background: active ? B.forest : B.parchment,
              color: active ? B.cream : B.timber,
              fontWeight: 600, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
              boxShadow: active ? `0 3px 12px rgba(49,76,71,0.2)` : "0 1px 6px rgba(0,0,0,0.04)",
              flexShrink: 0, transition: "all 0.2s",
            }}>{cat.icon} {cat.label}</button>
          );
        })}
      </div>

      {/* ── Menu Grid ── */}
      {loading ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, padding: "12px 16px" }}>
          {[0,1,2,3].map(i => <div key={i} className="y-shimmer" style={{ height: 200, borderRadius: 16 }} />)}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, padding: "12px 16px" }}>
          {filtered.map((item, i) => (
            <MenuCard key={item.id} item={item} index={i} onAdd={addToCart} cartQty={cart[item.id]?.qty || 0} />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div style={{ textAlign: "center", padding: 48, color: B.mist, fontFamily: FONT_SOUL, fontSize: 15, fontStyle: "italic" }}>
          Nothing here yet... the garden grows 🌱
        </div>
      )}

      {/* ── Cart ── */}
      <CartDrawer cart={cart} setCart={setCart} onCheckout={() => setShowReceipt(true)} />
    </div>
  );
}
