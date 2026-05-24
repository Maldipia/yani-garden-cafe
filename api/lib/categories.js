// ── Category UUID ↔ name maps ─────────────────────────────────────────────
// IMPORTANT: Keep in sync with menu_categories table.
// Adding a new category → update this map AND run a DB INSERT on menu_categories.
export const CATEGORY_ID_TO_NAME = {
  '069ee74a-350f-467a-86ef-876dd48ced3e': 'HOT',
  '9094c828-1da1-4802-838b-8eb4da3c16be': 'ICE AND ICE BLENDED',
  '228b02da-1a81-46e4-aae2-794b5c88a990': 'PASTRY',
  '098a930f-3789-42fd-b7ca-bd704126ec08': 'PASTA',
  '9abfbe5e-3c68-43cb-bed3-4ed5c63380c1': 'WRAP',
  '1b803e7a-c69c-442a-991c-d62c99e6dd11': 'OTHER',
  '9268943a-b5ed-40c3-ac51-4411e06805de': 'MEALS',
  '5297871b-fa2e-4376-bd81-6d9b0c173be8': 'BEST WITH',
  'a3123278-d6ba-4004-89db-479248efea6d': 'PASALUBONG',
  '8d83f583-5d6c-4b9a-b32a-5e5639b3d162': 'BEANS',
};
export const CATEGORY_NAME_TO_ID = Object.fromEntries(
  Object.entries(CATEGORY_ID_TO_NAME).map(([id, name]) => [name.toUpperCase(), id])
);
export function getCategoryId(categoryName) {
  if (!categoryName) return null;
  return CATEGORY_NAME_TO_ID[String(categoryName).trim().toUpperCase()] || null;
}
export function getCategoryName(categoryId) {
  return CATEGORY_ID_TO_NAME[categoryId] || 'Other';
}
