import { createHash } from "node:crypto";
import type { Item } from "./types.ts";
import type { SalesDocument, InvoiceParty } from "../src/salesDocuments.ts";
import { dispatchBlockReason } from "../src/salesDocuments.ts";
import { CompanyErpError } from "./companyErp.ts";
import { validSalesDate, parseSalesReference } from "../src/salesReference.ts";
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
const money = (v: unknown): number | null => {
  if (v === null) return null;
  if (
    (typeof v !== "number" && typeof v !== "string") ||
    String(v).trim() === ""
  )
    return fail();
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || Math.abs(n) > 1e14)
    return fail();
  return n;
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
  const sourceId = str(row.id, 20),
    reference = str(row.reference, 200);
  if (
    !/^[1-9][0-9]{0,14}$/.test(sourceId) ||
    !validSalesDate(row.saleDate) ||
    row.saleDate !== date ||
    !["draft", "confirmed", "canceled"].includes(row.status) ||
    !Array.isArray(row.items) ||
    row.items.length > 1000
  )
    return fail();
  const parsed = parseSalesReference(reference);
  if (parsed && parsed.date !== date) return fail();
  const items: Item[] = row.items.map((l: any) => {
    const quantity = Number(l.quantity);
    if (
      (typeof l.quantity !== "number" && typeof l.quantity !== "string") ||
      String(l.quantity).trim() === "" ||
      !Number.isFinite(quantity) ||
      Math.abs(quantity) > 1e9 ||
      !["taxable", "exempt"].includes(l.taxType)
    )
      return fail();
    const net = money(l.supplyAmount),
      unit = money(l.unitPrice);
    if (net === null || unit === null) return fail();
    const factory = money(l.factoryPrice ?? null),
      total = money(l.totalAmount ?? null);
    const rate = l.discountRate == null ? null : Number(l.discountRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100))
      return fail();
    return {
      name: str(l.name, 200),
      code: str(l.code ?? "", 100),
      erpItemId: str(String(l.erpItemId ?? ""), 20),
      specification: str(l.specification ?? "", 200),
      pattern: str(l.pattern ?? "", 80),
      quantity,
      unitPrice: unit,
      supplyAmount: net,
      totalAmount: total,
      factoryPrice: factory,
      listPrice: factory,
      discountRate: rate,
      remarks: str(l.remarks ?? "", 200),
      taxType: l.taxType,
      amountBasis: total === null ? "supply" : "total",
    };
  });
  const sourceKey =
    "company-sale-" +
    createHash("sha256")
      .update(JSON.stringify([sourceUrl, instanceId, sourceId]))
      .digest("hex");
  const base = {
    sourceId,
    sourceKey,
    reference,
    saleDate: date,
    status: row.status as SalesDocument["status"],
    channel: str(row.channel ?? "", 30),
    paymentMethod: str(row.paymentMethod ?? "", 40),
    customerName: str(row.customerName ?? "", 200),
    customerCode: str(row.customerCode ?? "", 100),
    vehicleNo: str(row.vehicleNo ?? "", 100),
    cancelReason: str(row.cancelReason ?? "", 500),
    recipient: str(row.recipient ?? "", 200),
    address: str(row.address ?? "", 500),
    phone: str(row.phone ?? "", 80),
    notes: str(row.notes ?? "", 2000),
    supplyAmount: money(row.supplyAmount),
    vatAmount: money(row.vatAmount),
    amount: money(row.amount),
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
