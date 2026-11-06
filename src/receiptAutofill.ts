import type { ShipmentInput } from "../server/types.ts";

const nonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const itemName = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** Fill gaps in one receipt without replacing an administrator's corrections. */
export function mergeReceiptAutofill(
  current: ShipmentInput[],
  extracted: ShipmentInput,
): ShipmentInput[] {
  // A single OCR receipt cannot reliably identify the owner of several rows.
  if (current.length !== 1) return current;
  const original = current[0];
  let updated = original;
  const set = (values: Partial<ShipmentInput>) => {
    updated = { ...updated, ...values };
  };
  if (!nonblank(original.recipient) && nonblank(extracted.recipient))
    set({ recipient: extracted.recipient.trim() });
  if (!nonblank(original.address) && nonblank(extracted.address))
    set({ address: extracted.address.trim(), lat: null, lng: null });
  if (!nonblank(original.phone) && nonblank(extracted.phone))
    set({ phone: extracted.phone.trim() });
  if (!nonblank(original.notes) && nonblank(extracted.notes))
    set({ notes: extracted.notes.trim() });

  if (original.amount == null && extracted.amount != null && Number.isFinite(extracted.amount) && extracted.amount >= 0) set({ amount: extracted.amount });

  const recognized = extracted.items.filter((item) => nonblank(item.name));
  if (!original.items.some((item) => nonblank(item.name))) {
    if (recognized.length)
      set({
        items: recognized.map((item) => ({
          ...item,
          name: item.name.trim(),
          // Preserve what OCR actually extracted; do not invent a count of 1
          // when an invalid/missing count needs the administrator's attention.
          quantity: item.quantity,
        })),
      });
  } else {
    let changed = false;
    const items = original.items.map((item) => {
      if (!nonblank(item.name)) return item;
      const matches = recognized.filter(candidate => itemName(candidate.name) === itemName(item.name));
      if (matches.length !== 1) return item;
      const from = matches[0]; let next = item;
      if (!positive(item.quantity) && positive(from.quantity)) next = { ...next, quantity: from.quantity };
      for (const field of ["unitPrice", "supplyAmount", "totalAmount", "factoryPrice", "listPrice", "discountRate"] as const)
        if (item[field] == null && from[field] != null && Number.isFinite(from[field]) && from[field]! >= 0)
          next = { ...next, [field]: from[field] };
      if (next !== item) {
        changed = true;
        if (from.priceOrigin === "ocr" && item.priceOrigin == null) next.priceOrigin = "ocr";
      }
      return next;
    });
    if (changed) set({ items });
  }
  return updated === original ? current : [updated];
}
