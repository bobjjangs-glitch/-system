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

  const recognized = extracted.items.filter((item) => nonblank(item.name));
  if (!original.items.some((item) => nonblank(item.name))) {
    if (recognized.length)
      set({
        items: recognized.map((item) => ({
          name: item.name.trim(),
          // Preserve what OCR actually extracted; do not invent a count of 1
          // when an invalid/missing count needs the administrator's attention.
          quantity: item.quantity,
        })),
      });
  } else {
    let changed = false;
    const items = original.items.map((item) => {
      if (!nonblank(item.name) || positive(item.quantity)) return item;
      const matches = recognized.filter(
        (candidate) => itemName(candidate.name) === itemName(item.name),
      );
      // Several equal names may be separate lines/units. Never guess which
      // quantity belongs to a manually entered item or combine those counts.
      if (matches.length !== 1 || !positive(matches[0].quantity)) return item;
      changed = true;
      return { ...item, quantity: matches[0].quantity };
    });
    if (changed) set({ items });
  }
  return updated === original ? current : [updated];
}
