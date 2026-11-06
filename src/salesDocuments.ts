import type { Item, ShipmentInput } from "../server/types.ts";
export type InvoiceParty = {
  name: string;
  businessNumber: string;
  representative: string;
  address: string;
  phone: string;
};
export type SalesDocument = {
  sourceId: string;
  sourceKey: string;
  reference: string;
  saleDate: string;
  referenceDate?: string;
  saleDateInferred?: boolean;
  status: "draft" | "confirmed" | "canceled";
  channel: string;
  paymentMethod: string;
  paymentAccount?: { id: string; name: string; kind: string };
  customerName: string;
  customerCode: string;
  erpCustomerId?: string;
  vehicleNo: string;
  cancelReason: string;
  deliveryAddress?: string;
  deliveryPhone?: string;
  recipient: string;
  address: string;
  phone: string;
  notes: string;
  supplyAmount: number | null;
  vatAmount: number | null;
  amount: number | null;
  supplier: InvoiceParty;
  buyer: InvoiceParty;
  items: Item[];
  registered: boolean;
  eligible: boolean;
  reason: string;
  fingerprint: string;
};
export type SalesList = {
  id: string;
  salesDate: string;
  serviceDate: string;
  sourceReadAt: string;
  documents: SalesDocument[];
  historical?: boolean;
};
export const invoiceStatus = (status: string) =>
  ({ draft: "작성중", confirmed: "확정", canceled: "취소" })[status] ?? status;
export const invoiceMoney = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("ko-KR", { maximumFractionDigits: 0 })
    : "미등록";
export function documentShipment(doc: SalesDocument): ShipmentInput {
  return {
    recipient: doc.recipient,
    address: doc.address,
    phone: doc.phone,
    notes: doc.notes,
    items: doc.items,
    amount: doc.amount,
    customerCode: doc.customerCode,
    ...(doc.erpCustomerId ? { erpCustomerId: doc.erpCustomerId } : {}),
    invoiceCustomerName: doc.customerName,
    invoiceVehicleNo: doc.vehicleNo,
    ...(doc.channel === "retail" || doc.channel === "wholesale" ? { erpPriceChannel: doc.channel } : {}),
    salesReference: doc.reference,
    erpSourceKey: doc.sourceKey,
  };
}

export function dispatchBlockReason(
  doc: Pick<
    SalesDocument,
    "status" | "items" | "amount" | "supplyAmount" | "vatAmount"
  >,
): string {
  if (doc.status === "canceled") return "취소 전표는 배차할 수 없습니다.";
  if (!doc.items.length || doc.items.some((i) => i.quantity <= 0))
    return "반품·0 이하 수량 또는 빈 품목은 배차할 수 없습니다.";
  if (doc.amount == null || doc.supplyAmount == null || doc.vatAmount == null)
    return "ERP 전표 합계가 없습니다.";
  if (
    doc.amount < 0 ||
    doc.supplyAmount < 0 ||
    doc.items.some((i) => (i.unitPrice ?? 0) < 0 || (i.supplyAmount ?? 0) < 0)
  )
    return "반품 금액이 포함된 전표는 배차할 수 없습니다.";
  return "";
}
