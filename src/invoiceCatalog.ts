import type { Item, ShipmentInput } from "../server/types.ts";
import type { CatalogEntry } from "./catalogTypes.ts";
import { calculateInvoiceLine, invoiceTotals } from "./invoiceMath.ts";
export function invoiceProduct(
  item: Item,
  entry: CatalogEntry,
  channel: "retail" | "wholesale" = "wholesale",
): Item {
  const value = channel === "retail" ? entry.retailPrice : entry.wholesalePrice;
  return calculateInvoiceLine({
    ...item,
    name:
      entry.name +
      (entry.specification && !entry.name.includes(entry.specification)
        ? " " + entry.specification
        : ""),
    code: entry.code,
    erpItemId: entry.remoteId,
    specification: entry.specification,
    pattern: entry.pattern,
    unitPrice: value ?? entry.unitPrice ?? null,
    retailPrice: entry.retailPrice,
    wholesalePrice: entry.wholesalePrice,
    factoryPrice: entry.factoryPrice ?? null,
    listPrice: entry.factoryPrice ?? entry.listPrice ?? null,
    taxType: entry.taxType ?? "taxable",
    discountRate: null,
    priceOrigin: "erp",
    amountBasis: "unit",
  });
}
export function invoiceCustomer(
  row: ShipmentInput,
  entry: CatalogEntry,
): Partial<ShipmentInput> {
  const channel = entry.defaultChannel ?? "wholesale";
  const items = row.items.map((item) =>
    item.priceOrigin === "erp"
      ? calculateInvoiceLine({
          ...item,
          unitPrice:
            (channel === "retail" ? item.retailPrice : item.wholesalePrice) ??
            item.unitPrice,
          amountBasis: "unit",
        })
      : item,
  );
  const totals = invoiceTotals(items);
  return {
    recipient: entry.name,
    address: entry.address ?? "",
    phone: entry.phone ?? "",
    customerCode: entry.code,
    erpCustomerId: entry.remoteId,
    erpPriceChannel: channel,
    items,
    ...(totals.complete ? { amount: totals.total } : {}),
    lat: null,
    lng: null,
  };
}
