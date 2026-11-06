import { createHash } from "node:crypto";
import type { Item } from "./types.ts";
import type { SalesDocument, InvoiceParty, NativeInvoiceHeader } from "../src/salesDocuments.ts";
import { dispatchBlockReason } from "../src/salesDocuments.ts";
import { CompanyErpError } from "./companyErp.ts";
import {
  validSalesDate,
  parseSalesReference,
  readSalesDate,
} from "../src/salesReference.ts";
const fail = () => {
  throw new CompanyErpError(
    "INVOICE_FORMAT",
    "ERP 명세서의 단가·금액 응답을 확인하지 못했습니다. 최신 ERP 연동 ZIP의 PHP 파일을 모두 교체하고 서버도 업데이트해 주세요.",
    502,
  );
};
const str = (v: unknown, max = 500) => {
  if (typeof v !== "string" || v.length > max) return fail();
  return v.trim();
};
const money = (v: unknown, native = false): number | null => {
  if (v === null || (native && (v === undefined || (typeof v === "string" && v.trim() === "")))) return null;
  if (
    (typeof v !== "number" && typeof v !== "string") ||
    String(v).trim() === ""
  )
    return fail();
  if (native && typeof v === "string" && !/^-?\d{1,14}(?:\.\d{1,10})?$/.test(v.trim())) return fail();
  const n = Number(v);
  if (!Number.isFinite(n) || (!native && !Number.isSafeInteger(n)) || Math.abs(n) > 1e14)
    return fail();
  return n;
};
const nativeHeaderKeys = new Set([
  "partner_code", "partner_name", "staff", "warehouse", "trade_type", "currency",
  "ceo", "phone", "business_no", "account", "receivable", "delivery", "note",
]);
const nativeFields = (value: unknown, header = false): Record<string, string> => {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return fail();
  const entries = Object.entries(value);
  if (entries.length > (header ? nativeHeaderKeys.size : 200)) return fail();
  return Object.fromEntries(entries.map(([key, v]) => {
    if (!key.trim() || key.length > 200 || ["__proto__", "prototype", "constructor"].includes(key) ||
      (header && !nativeHeaderKeys.has(key))) return fail();
    if (v !== null && typeof v !== "string" && !(typeof v === "number" && Number.isFinite(v))) return fail();
    const text = v === null ? "" : String(v);
    if (text.length > 8000) return fail();
    return [key, text];
  }));
};
const nativeIdentifier = (value: unknown, zero = false) => {
  if (typeof value !== "string" && typeof value !== "number") return fail();
  const text = String(value);
  if (!(zero ? /^(0|[1-9][0-9]{0,14})$/ : /^[1-9][0-9]{0,14}$/).test(text)) return fail();
  return text;
};
const nativeUrl = (value: unknown, source: string, id: string, version: string, statement = false): string | undefined => {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 300 || /^[/.]/.test(value) || /[\\#]/.test(value)) return fail();
  let base: URL, url: URL;
  try { base = new URL(source); url = new URL(value, base); } catch { return fail(); }
  const file = statement ? "native_document.php" : "native_trade_edit.php";
  const expected = new URL(file, base);
  const keys = [...url.searchParams.keys()];
  if (base.protocol !== "https:" || base.username || base.password || url.origin !== base.origin ||
    url.pathname !== expected.pathname || url.hash || url.username || url.password ||
    keys.length !== (statement ? 3 : 1) || url.searchParams.get("id") !== id ||
    keys.some(k => !(statement ? ["id", "version", "print"] : ["id"]).includes(k)) ||
    new Set(keys).size !== keys.length ||
    (statement && (url.searchParams.get("version") !== version || url.searchParams.get("print") !== "statement"))) return fail();
  return url.toString();
};
const party = (p: any): InvoiceParty => ({
  name: str(p?.name ?? "", 200),
  businessNumber: str(p?.businessNumber ?? "", 80),
  representative: str(p?.representative ?? "", 100),
  address: str(p?.address ?? "", 500),
  phone: str(p?.phone ?? "", 80),
});
export function normalizeSalesDocument(
  row: any,
  sourceUrl: string,
  instanceId: string,
  date: string,
): SalesDocument {
  const native = row.sourceSystem === "native-archive";
  const sourceReference = native ? str(row.sourceReference ?? "", 200) : "";
  const sourceParsed = native ? parseSalesReference(sourceReference) : null;
  const reference = str(row.reference, 200),
    parsed = parseSalesReference(reference);
  const rawDate = readSalesDate(String(row.saleDate ?? "").slice(0, 10));
  const actualDate = rawDate ?? parsed?.date ?? sourceParsed?.date ?? null;
  const sourceId = str(row.id, 20);
  if (
    !/^[1-9][0-9]{0,14}$/.test(sourceId) ||
    !actualDate ||
    !(native ? ["imported", "canceled"] : ["draft", "confirmed", "canceled"]).includes(row.status) ||
    !Array.isArray(row.items) ||
    row.items.length > 1000
  )
    return fail();
  if (actualDate !== date && parsed?.date !== date && sourceParsed?.date !== date) return fail();
  const items: Item[] = row.items.map((l: any) => {
    const quantityUnknown = native && (l.quantityUnknown === true || l.quantity === null || l.quantity === "" || l.quantity === undefined);
    const quantity = quantityUnknown ? 0 : Number(l.quantity);
    if (
      (!quantityUnknown && (typeof l.quantity !== "number" && typeof l.quantity !== "string")) ||
      (!quantityUnknown && String(l.quantity).trim() === "") ||
      !Number.isFinite(quantity) ||
      Math.abs(quantity) > 1e9 ||
      (!native && !["taxable", "exempt"].includes(l.taxType)) ||
      (native && l.taxType != null && !["taxable", "exempt"].includes(l.taxType))
    )
      return fail();
    const net = money(l.supplyAmount, native),
      unit = money(l.unitPrice, native);
    if (!native && (net === null || unit === null)) return fail();
    const factory = money(l.factoryPrice ?? null, native),
      total = money(l.totalAmount ?? null, native);
    const rate = l.discountRate == null ? null : Number(l.discountRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100))
      return fail();
    const vatRate = l.vatRate == null ? null : Number(l.vatRate);
    if (native && vatRate !== null && vatRate !== 0 && vatRate !== 10) return fail();
    return {
      name: str(l.name, native ? 4000 : 200),
      code: str(l.code ?? "", native ? 4000 : 100),
      erpItemId: str(String(l.erpItemId ?? ""), 20),
      specification: str(l.specification ?? "", native ? 4000 : 200),
      pattern: str(l.pattern ?? "", native ? 4000 : 80),
      quantity,
      ...(quantityUnknown ? { quantityUnknown: true } : {}),
      unitPrice: unit,
      supplyAmount: net,
      totalAmount: total,
      factoryPrice: factory,
      listPrice: factory,
      discountRate: rate,
      remarks: str(l.remarks ?? "", native ? 8000 : 200),
      ...(!native || l.taxType != null ? { taxType: l.taxType } : {}),
      amountBasis: total === null ? "supply" : "total",
      ...(native ? {
        priceOrigin: "native-erp" as const,
        vatAmount: money(l.vatAmount, true),
        vatRate,
        brand: str(l.brand ?? "", 4000),
        dot: str(l.dot ?? "", 4000),
        discountRateRaw: str(l.discountRateRaw ?? "", 4000),
        nativeFields: nativeFields(l.nativeFields),
      } : {}),
    };
  });
  const sourceKey =
    "company-sale-" +
    createHash("sha256")
      .update(JSON.stringify(native ? [sourceUrl, instanceId, "native-archive", sourceId] : [sourceUrl, instanceId, sourceId]))
      .digest("hex");
  const version = native ? nativeIdentifier(row.nativeVersionId) : "";
  const base = {
    sourceId,
    sourceKey,
    reference,
    saleDate: actualDate!,
    ...(!rawDate ? { saleDateInferred: true } : {}),
    ...(parsed && parsed.date !== actualDate
      ? { referenceDate: parsed.date }
      : {}),
    status: row.status as SalesDocument["status"],
    ...(native ? {
      sourceSystem: "native-archive" as const,
      sourceReference,
      ...(sourceParsed && sourceParsed.date !== actualDate ? { sourceReferenceDate: sourceParsed.date } : {}),
      nativeVersionId: version,
      nativeRevision: nativeIdentifier(row.nativeRevision, true),
      nativeHeader: nativeFields(row.nativeHeader, true) as NativeInvoiceHeader,
      ...(row.editUrl ? { editUrl: nativeUrl(row.editUrl, sourceUrl, sourceId, version) } : {}),
      ...(row.statementUrl ? { statementUrl: nativeUrl(row.statementUrl, sourceUrl, sourceId, version, true) } : {}),
    } : {}),
    channel: str(row.channel ?? "", 30),
    paymentMethod: str(row.paymentMethod ?? "", 40),
    ...(row.paymentAccount ? {paymentAccount: { id: str(String(row.paymentAccount.id ?? ""),20), name: str(row.paymentAccount.name ?? "",200), kind: str(row.paymentAccount.kind ?? "",40) }} : {}),
    customerName: str(row.customerName ?? "", native ? 500 : 200),
    customerCode: str(row.customerCode ?? "", native ? 500 : 100),
    ...(row.erpCustomerId ? { erpCustomerId: str(String(row.erpCustomerId),20) } : {}),
    vehicleNo: str(row.vehicleNo ?? "", 100),
    cancelReason: str(row.cancelReason ?? "", 500),
    recipient: str(row.recipient ?? "", native ? 500 : 200),
    address: str(row.address ?? "", native ? 8000 : 500),
    phone: str(row.phone ?? "", native ? 500 : 80),
    notes: str(row.notes ?? "", native ? 8000 : 2000),
    supplyAmount: money(row.supplyAmount, native),
    vatAmount: money(row.vatAmount, native),
    amount: money(row.amount, native),
    supplier: party(row.supplier),
    buyer: party(row.buyer),
    items,
  };
  const reason = dispatchBlockReason(base);
  return {
    ...base,
    registered: false,
    eligible: !reason,
    reason,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(base))
      .digest("hex"),
  };
}
