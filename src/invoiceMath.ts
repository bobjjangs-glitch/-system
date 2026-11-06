import type { Item } from "../server/types.ts";
export const MAX_LINE_WON = 1_000_000_000_000;
const won = (n: unknown): n is number =>
  typeof n === "number" &&
  Number.isSafeInteger(n) &&
  n >= 0 &&
  n <= MAX_LINE_WON;
const half = (a: bigint, b: bigint) => Number((a + b / 2n) / b);
export function numberInput(text: string): number | null {
  const t = text.replace(/[,₩원%\s]/g, "");
  return t === "" ? null : Number(t);
}
export function quantityMilli(n: number): number | null {
  const m = Math.round(n * 1000);
  return Number.isFinite(n) &&
    n > 0 &&
    n <= 1_000_000 &&
    Math.abs(n * 1000 - m) < 1e-5
    ? m
    : null;
}
/** Each row preserves the value the operator edited; VAT totals sum the displayed rows. */
export function calculateInvoiceLine(item: Item): Item {
  // An OCR reading is a printed observation, not permission to invent VAT or replace a conflicting digit.
  if (item.priceOrigin === "ocr") return { ...item };
  const q = quantityMilli(item.quantity),
    basis = item.amountBasis ?? "unit",
    taxable = item.taxType !== "exempt";
  if (q === null) return { ...item, supplyAmount: null, totalAmount: null };
  let net: number,
    total: number,
    unit = item.unitPrice;
  if (basis === "total") {
    if (!won(item.totalAmount)) return { ...item, supplyAmount: null };
    total = item.totalAmount;
    net = taxable ? half(BigInt(total) * 10n, 11n) : total;
    unit = half(BigInt(net) * 1000n, BigInt(q));
  } else if (basis === "supply") {
    if (!won(item.supplyAmount)) return { ...item, totalAmount: null };
    net = item.supplyAmount;
    total = net + (taxable ? half(BigInt(net), 10n) : 0);
    unit = half(BigInt(net) * 1000n, BigInt(q));
  } else {
    if (!won(unit)) return { ...item, supplyAmount: null, totalAmount: null };
    net = half(BigInt(q) * BigInt(unit), 1000n);
    total = net + (taxable ? half(BigInt(net), 10n) : 0);
  }
  if (!won(net) || !won(total) || !won(unit))
    return { ...item, supplyAmount: null, totalAmount: null };
  return {
    ...item,
    unitPrice: unit,
    supplyAmount: net,
    totalAmount: total,
    amountBasis: basis,
  };
}
export function changeInvoiceNumber(
  item: Item,
  field:
    | "quantity"
    | "unitPrice"
    | "supplyAmount"
    | "totalAmount"
    | "discountRate"
    | "factoryPrice",
  value: number | null,
): Item {
  const next = {
    ...item,
    ...(field !== "quantity" || item.priceOrigin === "ocr" ? { priceOrigin: "manual" as const } : {}),
    [field]: field === "quantity" && value === null ? NaN : value,
  };
  if (field === "factoryPrice") {
    next.listPrice = value;
    return item.discountRate == null
      ? calculateInvoiceLine(next)
      : changeInvoiceNumber(next, "discountRate", item.discountRate);
  }
  if (field === "discountRate") {
    if (value === null) return next;
    const bp = Math.round(value * 100);
    if (
      !Number.isFinite(value) ||
      value < 0 ||
      value > 100 ||
      Math.abs(value * 100 - bp) > 1e-5 ||
      !won(item.listPrice)
    )
      return {
        ...next,
        unitPrice: null,
        supplyAmount: null,
        totalAmount: null,
      };
    next.unitPrice = half(BigInt(item.listPrice) * BigInt(10000 - bp), 10000n);
    next.amountBasis = "unit";
  } else
    next.amountBasis =
      field === "totalAmount"
        ? "total"
        : field === "supplyAmount"
          ? "supply"
          : "unit";
  return calculateInvoiceLine(next);
}
export function invoiceTotals(items: Item[]) {
  let supply = 0,
    total = 0,
    complete = true;
  for (const item of items) {
    if (won(item.supplyAmount) && won(item.totalAmount)) {
      supply += item.supplyAmount;
      total += item.totalAmount;
    } else complete = false;
  }
  return {
    supply,
    vat: total - supply,
    total,
    complete: complete && items.length > 0 && won(supply) && won(total),
  };
}
/** Show observed totals independently: a missing net or tax field must not turn a known printed gross total into zero. */
export function invoiceDisplayTotals(items: Item[]) {
  const sum = (field: "supplyAmount" | "totalAmount") => items.length && items.every(i => won(i[field]))
    ? items.reduce((n,i) => n + i[field]!,0) : null;
  const supply=sum("supplyAmount"), total=sum("totalAmount");
  const taxKnown=items.every(i => i.taxType === "taxable" || i.taxType === "exempt");
  return {supply,total,vat:taxKnown && supply!=null && total!=null && total>=supply ? total-supply : null};
}
export function validateInvoiceItems(items: Item[]): Item[] {
  if (!Array.isArray(items) || !items.length || items.length > 200)
    throw new Error("품목은 1개 이상 200개 이하로 입력해 주세요.");
  return items.map((item, i) => {
    if (!/^[1-9][0-9]{0,14}$/.test(item.erpItemId ?? ""))
      throw new Error(`${i + 1}행은 ERP 품목 검색에서 선택해 주세요.`);
    if (!item.name?.trim() || item.name.length > 200)
      throw new Error(`${i + 1}행 품목명을 확인해 주세요.`);
    if (item.taxType !== "taxable" && item.taxType !== "exempt")
      throw new Error(
        `${i + 1}행 ERP 품목을 다시 선택해 과세 구분을 확인해 주세요.`,
      );
    if (quantityMilli(item.quantity) === null)
      throw new Error(
        `${i + 1}행 수량은 양수, 소수점 세 자리까지 입력해 주세요.`,
      );
    if (
      item.discountRate != null &&
      (!Number.isFinite(item.discountRate) ||
        item.discountRate < 0 ||
        item.discountRate > 100 ||
        Math.abs(
          item.discountRate * 100 - Math.round(item.discountRate * 100),
        ) > 1e-5)
    )
      throw new Error(
        `${i + 1}행 DC율은 0~100%, 소수점 두 자리까지 입력해 주세요.`,
      );
    if (
      item.amountBasis !== undefined &&
      !["unit", "supply", "total"].includes(item.amountBasis)
    )
      throw new Error(`${i + 1}행 금액 기준을 확인해 주세요.`);
    if (item.factoryPrice != null && !won(item.factoryPrice))
      throw new Error(`${i + 1}행 공장도가를 원 단위로 확인해 주세요.`);
    const line = calculateInvoiceLine(item.priceOrigin === "ocr" ? { ...item, priceOrigin: "manual" } : item);
    if (
      !won(line.unitPrice) ||
      !won(line.supplyAmount) ||
      !won(line.totalAmount)
    )
      throw new Error(`${i + 1}행 단가·금액·합계를 원 단위로 확인해 주세요.`);
    if (
      (line.remarks?.length ?? 0) > 200 ||
      (line.pattern?.length ?? 0) > 80 ||
      (line.specification?.length ?? 0) > 200
    )
      throw new Error(`${i + 1}행 패턴·규격·비고를 줄여 주세요.`);
    return line;
  });
}
