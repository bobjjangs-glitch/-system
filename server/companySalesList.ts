import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./database.ts";
import { CompanyErpClient, CompanyErpError } from "./companyErp.ts";
import { salesImportKeys, savedManualSale } from "./erpCatalog.ts";
import { validateShipments } from "./imports.ts";
import {
  documentShipment,
  dispatchBlockReason,
  type SalesDocument,
  type SalesList,
} from "../src/salesDocuments.ts";
import { validSalesDate, parseSalesReference } from "../src/salesReference.ts";
const failure = (message: string, status = 409): never => {
  throw new CompanyErpError("SALES_SELECTION", message, status);
};
export class CompanySalesList {
  private store: Store;
  private erp: CompanyErpClient;
  private dataDir: string;
  private changed: (date: string) => void;
  constructor(
    store: Store,
    erp: CompanyErpClient,
    dataDir: string,
    changed: (date: string) => void,
  ) {
    this.store = store;
    this.erp = erp;
    this.dataDir = dataDir;
    this.changed = changed;
  }
  private registered(doc: SalesDocument) {
    const row = documentShipment(doc);
    return (
      salesImportKeys(row).some((key) =>
        this.store.one(
          "SELECT sourceKey FROM erp_sales_links WHERE sourceKey=?",
          key,
        ),
      ) || savedManualSale(this.store, row)
    );
  }
  private decorate(doc: SalesDocument) {
    const registered = this.registered(doc);
    const reason = registered
      ? "이미 배차 대기에 등록한 전표입니다."
      : dispatchBlockReason(doc);
    return { ...doc, registered, eligible: !reason, reason };
  }
  async fetch(salesDate: string, serviceDate: string) {
    if (!validSalesDate(serviceDate))
      failure("배송 예정일을 확인해 주세요.", 400);
    const result = await this.erp.browseSales(salesDate);
    return this.persistList(result, serviceDate);
  }
  async reference(reference: string, serviceDate: string) {
    if (!validSalesDate(serviceDate))
      failure("배송 예정일을 확인해 주세요.", 400);
    const result = await this.erp.invoice(reference);
    return this.persistList(
      {
        documents: [result.document],
        salesDate:
          parseSalesReference(reference)?.date ?? result.document.saleDate,
        sourceReadAt: result.sourceReadAt,
      },
      serviceDate,
    );
  }
  async confirmReference(reference: string, fingerprint: string, serviceDate: string, delivery?: unknown) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !validSalesDate(serviceDate))
      failure("확인할 전표와 배송일을 확인해 주세요.",400);
    const result = await this.erp.invoice(reference);
    if (result.document.fingerprint !== fingerprint)
      failure("ERP 전표가 확인 중 변경되었습니다. 전표번호를 다시 눌러 최신 내용을 확인해 주세요.");
    const list = this.persistList({ documents: [result.document], salesDate: parseSalesReference(reference)?.date ?? result.document.saleDate,
      sourceReadAt: result.sourceReadAt }, serviceDate);
    return this.dispatch(list.id, { sourceKeys: [result.document.sourceKey], serviceDate,
      deliveryOverrides: delivery ? { [result.document.sourceKey]: delivery } : {} });
  }
  private persistList(
    result: {
      documents: SalesDocument[];
      salesDate: string;
      sourceReadAt: string;
    },
    serviceDate: string,
  ) {
    const salesDate = result.salesDate;
    const id = randomUUID(),
      storedName = id + ".json",
      at = new Date().toISOString();
    writeFileSync(
      join(this.dataDir, "uploads", storedName),
      JSON.stringify(result),
      { mode: 0o600, flag: "wx" },
    );
    try {
      this.store.run(
        "INSERT INTO imports(id,fileName,storedName,mime,drafts,status,serviceDate,createdAt,count,meta) VALUES(?,?,?,?,?,'sales-list',?,?,?,?)",
        id,
        `회사ERP_판매목록_${salesDate}.json`,
        storedName,
        "application/json",
        JSON.stringify(result.documents.map(documentShipment)),
        serviceDate,
        at,
        result.documents.length,
        JSON.stringify({ source: "company-erp-selection", ...result }),
      );
    } catch (e) {
      unlinkSync(join(this.dataDir, "uploads", storedName));
      throw e;
    }
    this.changed(serviceDate);
    return this.get(id);
  }
  latest(salesDate: string) {
    if (!validSalesDate(salesDate)) failure("판매일자를 확인해 주세요.", 400);
    const row = this.store.one(
      "SELECT id FROM imports WHERE json_extract(meta,'$.source')='company-erp-selection' AND json_extract(meta,'$.salesDate')=? ORDER BY createdAt DESC LIMIT 1",
      salesDate,
    );
    return row ? this.get(row.id) : null;
  }
  get(id: string): SalesList {
    const row = this.store.one("SELECT * FROM imports WHERE id=?", id);
    if (!row) failure("조회 목록을 찾을 수 없습니다.", 404);
    const meta = JSON.parse(row.meta || "{}");
    if (!Array.isArray(meta.documents))
      failure(
        "이 내역에는 명세서 원본 정보가 없습니다. ERP에서 다시 조회해 주세요.",
        422,
      );
    return {
      id: row.id,
      salesDate:
        meta.salesDate ?? meta.documents[0]?.saleDate ?? row.serviceDate,
      serviceDate: row.serviceDate,
      sourceReadAt: meta.sourceReadAt ?? row.createdAt,
      documents: meta.documents.map((d: SalesDocument) => this.decorate(d)),
      historical: meta.source !== "company-erp-selection",
    };
  }
  async dispatch(id: string, input: any) {
    const saved = this.get(id);
    const keys = input?.sourceKeys;
    if (
      !Array.isArray(keys) ||
      !keys.length ||
      keys.length > 2000 ||
      keys.some((k) => typeof k !== "string") ||
      new Set(keys).size !== keys.length
    )
      failure("배차할 전표를 선택해 주세요.", 400);
    const serviceDate = input.serviceDate ?? saved.serviceDate;
    if (!validSalesDate(serviceDate))
      failure("배송 예정일을 확인해 주세요.", 400);
    const originals: SalesDocument[] = (keys as string[]).map((key: string) => {
      const doc = saved.documents.find(
        (d: SalesDocument) => d.sourceKey === key,
      );
      if (!doc) failure("조회 목록에 없는 전표입니다.", 400);
      return doc as SalesDocument;
    });
    const toCheck = originals.filter((d) => !this.registered(d));
    const latest = toCheck.length
      ? (await this.erp.browseSales(saved.salesDate)).documents
      : [];
    for (const original of toCheck) {
      const current = latest.find((d) => d.sourceKey === original.sourceKey);
      if (
        !current ||
        current.fingerprint !== original.fingerprint ||
        !current.eligible
      )
        failure(
          "ERP에서 전표가 변경·취소되었거나 이미 등록되었습니다. 판매내역을 다시 조회한 뒤 선택해 주세요.",
        );
    }
    const overrides = input.deliveryOverrides ?? {};
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      failure("배송정보를 확인해 주세요.", 400);
    const docs = toCheck.map((d) => {
      const o = overrides[d.sourceKey];
      if (o !== undefined && (!o || typeof o !== "object" || Array.isArray(o)))
        failure("배송정보를 확인해 주세요.", 400);
      return {
        ...d,
        ...Object.fromEntries(
          ["address", "phone", "notes"]
            .filter((k) => o?.[k] !== undefined)
            .map((k) => {
              if (
                typeof o[k] !== "string" ||
                o[k].length >
                  (k === "notes" ? 2000 : k === "address" ? 500 : 40)
              )
                failure("배송주소·연락처·요청사항을 확인해 주세요.", 400);
              return [k, o[k].trim()];
            }),
        ),
      };
    });
    if (!docs.length)
      return { count: 0, alreadyRegistered: originals.length, serviceDate };
    const rows = validateShipments(docs.map(documentShipment));
    const child = randomUUID(),
      storedName = child + ".json";
    let count = 0,
      alreadyRegistered = originals.length - toCheck.length;
    if (!rows.length) return { count: 0, alreadyRegistered, serviceDate };
    writeFileSync(
      join(this.dataDir, "uploads", storedName),
      JSON.stringify({ documents: docs, sourceListId: id }),
      { mode: 0o600, flag: "wx" },
    );
    try {
      this.store.transaction(() => {
        const picked = docs
          .map((doc, i) => ({ doc, row: rows[i] }))
          .filter(({ doc }) => {
            if (this.registered(doc)) {
              alreadyRegistered++;
              return false;
            }
            return true;
          });
        if (!picked.length) return;
        const at = new Date().toISOString();
        this.store.run(
          "INSERT INTO imports(id,fileName,storedName,mime,drafts,status,serviceDate,createdAt,count,meta) VALUES(?,?,?,?,?,'committed',?,?,?,?)",
          child,
          `ERP선택전표_${saved.salesDate}.json`,
          storedName,
          "application/json",
          JSON.stringify(picked.map((p) => p.row)),
          serviceDate,
          at,
          picked.length,
          JSON.stringify({
            source: "company-erp-selected",
            sourceListId: id,
            salesDate: saved.salesDate,
            sourceReadAt: saved.sourceReadAt,
            documents: picked.map((p) => p.doc),
          }),
        );
        for (const { row, doc } of picked) {
          for (const key of salesImportKeys(row))
            this.store.run(
              "INSERT INTO erp_sales_links(sourceKey,importId) VALUES(?,?)",
              key,
              child,
            );
          this.store.run(
            "INSERT INTO shipments(id,importId,recipient,address,phone,items,notes,lat,lng,serviceDate,createdAt,amount,customerCode,salesReference,erpSourceKey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            randomUUID(),
            child,
            row.recipient,
            row.address,
            row.phone ?? "",
            JSON.stringify(row.items),
            row.notes ?? "",
            null,
            null,
            serviceDate,
            at,
            row.amount ?? null,
            row.customerCode ?? null,
            doc.reference,
            doc.sourceKey,
          );
          count++;
        }
      });
    } catch (e) {
      try {
        unlinkSync(join(this.dataDir, "uploads", storedName));
      } catch {}
      throw e;
    }
    if (!count) unlinkSync(join(this.dataDir, "uploads", storedName));
    else this.changed(serviceDate);
    return {
      count,
      alreadyRegistered,
      serviceDate,
      importId: count ? child : null,
    };
  }
  async shipmentInvoice(id: string) {
    const shipment = this.store.one("SELECT * FROM shipments WHERE id=?", id);
    if (!shipment) failure("배송지를 찾을 수 없습니다.", 404);
    if (shipment.importId) {
      try {
        const list = this.get(shipment.importId);
        const doc = list.documents.find(
          (d: SalesDocument) =>
            d.sourceKey === shipment.erpSourceKey ||
            d.reference === shipment.salesReference,
        );
        if (doc)
          return {
            ...doc,
            deliveryAddress: shipment.address,
            deliveryPhone: shipment.phone,
          };
      } catch (e) {
        if (!(e instanceof CompanyErpError)) throw e;
      }
    }
    const date = parseSalesReference(shipment.salesReference)?.date;
    if (date && this.erp.status().configured) {
      const live = await this.erp.browseSales(date);
      const doc = live.documents.find(
        (d) =>
          d.sourceKey === shipment.erpSourceKey ||
          d.reference === shipment.salesReference,
      );
      if (doc)
        return {
          ...doc,
          deliveryAddress: shipment.address,
          deliveryPhone: shipment.phone,
        };
    }
    failure(
      "ERP 명세서 정보가 없는 배송지입니다. 판매내역에서 해당 전표를 다시 조회해 주세요.",
      422,
    );
  }
}
