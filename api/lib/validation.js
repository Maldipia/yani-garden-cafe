// ── Input validation helpers ──────────────────────────────────────────────
export function isNonEmptyString(v, maxLen = 200) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}
export function isValidPrice(v) {
  return v === null || v === undefined || (typeof v === 'number' && v >= 0 && v < 100000);
}
export function isValidItemCode(v) {
  return typeof v === 'string' && /^[A-Z0-9_]{2,40}$/i.test(v);
}
export function isValidOrderId(v) {
  return typeof v === 'string' && /^[A-Z0-9]{2,10}-\d{1,8}$/.test(v);
}
export function validateMenuPayload(body, requireItemId = false) {
  const errors = [];
  if (requireItemId && !isValidItemCode(body.itemId)) {
    errors.push('itemId must be a valid item code (letters, digits, underscores, 2-40 chars)');
  }
  if (body.name !== undefined && !isNonEmptyString(body.name, 100)) {
    errors.push('name must be a non-empty string (max 100 chars)');
  }
  if (body.price !== undefined && !isValidPrice(Number(body.price))) {
    errors.push('price must be a non-negative number under 100000');
  }
  if (body.priceShort  !== undefined && body.priceShort  !== null && !isValidPrice(Number(body.priceShort)))  errors.push('priceShort invalid');
  if (body.priceMedium !== undefined && body.priceMedium !== null && !isValidPrice(Number(body.priceMedium))) errors.push('priceMedium invalid');
  if (body.priceTall   !== undefined && body.priceTall   !== null && !isValidPrice(Number(body.priceTall)))   errors.push('priceTall invalid');
  if (body.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(String(body.status).toUpperCase())) {
    errors.push('status must be ACTIVE or INACTIVE');
  }
  return errors;
}
