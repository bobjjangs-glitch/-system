/** Two-digit years mean 2000–2099; native SL prefixes and zero-padded sequences identify the same invoice. */
export type SalesReference = {
  date: string;
  sequence: string;
  canonical: string;
};
export function validSalesDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number),
    date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    year <= 2199 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
export function readSalesDate(value: string): string | null {
  const text = value.normalize("NFKC").trim();
  const match =
    text.match(/^(\d{4}|\d{2})[/.\-](\d{1,2})[/.\-](\d{1,2})$/) ??
    text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) return null;
  const date = `${match[1].length === 2 ? "20" + match[1] : match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  return validSalesDate(date) ? date : null;
}
export function parseSalesReference(value: unknown): SalesReference | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").replace(/\s+/g, "");
  const split = text.match(/^(.+?)[\-–—](\d{1,12})$/);
  if (!split) return null;
  const date = readSalesDate(split[1].replace(/^SL-/i, ""));
  if (!date) return null;
  const sequence = split[2].replace(/^0+(?=\d)/, "");
  return {
    date,
    sequence,
    canonical: date.replace(/-/g, "/") + "-" + sequence,
  };
}

/** Search the ERP's displayed number and archive alias as one date/sequence identity. */
export function matchesSalesDocumentQuery(document: {
  reference: string;
  sourceReference?: string;
  recipient?: string;
  address?: string;
  phone?: string;
  items?: { name: string; code?: string }[];
}, query: string): boolean {
  const value = query.normalize("NFKC").trim().toLocaleLowerCase();
  if (!value) return true;
  const references = [document.reference, document.sourceReference ?? ""];
  const parsed = parseSalesReference(value);
  if (parsed) return references.some(reference => parseSalesReference(reference)?.canonical === parsed.canonical);
  const compact = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const fields = [...references, ...references.map(reference => parseSalesReference(reference)?.canonical ?? ""),
    document.recipient ?? "", document.address ?? "", document.phone ?? "",
    ...(document.items ?? []).map(item => item.name + " " + (item.code ?? ""))];
  const key = compact(value);
  return fields.some(field => field.normalize("NFKC").toLocaleLowerCase().includes(value) || (!!key && compact(field).includes(key)));
}
