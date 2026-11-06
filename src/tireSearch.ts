/** Tire size tokens are exact triples: 2354518 and 235/45 R18 mean the same size. */
export type TireSize = {
  width: string;
  aspect: string;
  rim: string;
  canonical: string;
  compact: string;
};
export function tireSizeQuery(input: string): TireSize | null {
  const q = input.normalize("NFKC").trim().toUpperCase();
  const m = q.match(
    /^(\d{3})\s*(?:[\/ -])?\s*(\d{2})\s*(?:R|ZR|Z|[-\s])?\s*(\d{2})$/,
  );
  if (!m) return null;
  const [width, aspect, rim] = m.slice(1);
  if (
    +width < 100 ||
    +width > 999 ||
    +aspect < 10 ||
    +aspect > 99 ||
    +rim < 10 ||
    +rim > 40
  )
    return null;
  return {
    width,
    aspect,
    rim,
    canonical: `${width}/${aspect}R${rim}`,
    compact: width + aspect + rim,
  };
}
export function tireSizeKey(input: string): string | null {
  return tireSizeQuery(input)?.compact ?? null;
}
export function matchesTireSize(text: string, size: TireSize): boolean {
  const value = text.normalize("NFKC").toUpperCase();
  // Do not concatenate unrelated numbers or match 235/45R18 inside 1235/45R180.
  const re =
    /(^|[^0-9])(\d{3})\s*[\/ -]?\s*(\d{2})\s*(?:ZR|R|Z)?\s*[- ]?\s*(\d{2})(?![0-9])/g;
  for (const m of value.matchAll(re))
    if (m[2] === size.width && m[3] === size.aspect && m[4] === size.rim)
      return true;
  const compact = new RegExp(
    `(^|[^0-9])${size.width}${size.aspect}(?:ZR|R|Z)?${size.rim}(?![0-9])`,
  );
  return compact.test(value);
}
export function hasTireSize(text: string): boolean {
  const t = text.normalize("NFKC").toUpperCase();
  return /(^|[^0-9])[1-9][0-9]{2}\s*[\/ -]?\s*[1-9][0-9]\s*(?:ZR|R|Z)?\s*[- ]?\s*(?:[1-3][0-9]|40)(?![0-9])/.test(
    t,
  );
}
export function productMatchesTireSize(
  name: string,
  specification: string,
  size: TireSize,
): boolean {
  return hasTireSize(specification)
    ? matchesTireSize(specification, size)
    : matchesTireSize(name, size);
}
