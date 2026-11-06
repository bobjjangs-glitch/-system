import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { Store } from "./database.ts";
import { CompanyErpClient, CompanyErpError } from "./companyErp.ts";
import { validateShipments } from "./imports.ts";
import { validateInvoiceItems, invoiceTotals } from "../src/invoiceMath.ts";
import { parseSalesReference, validSalesDate } from "../src/salesReference.ts";
import { salesImportKeys } from "./erpCatalog.ts";
import type { ShipmentInput } from "./types.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function stable(value: any): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
export class CompanySaleService {
  private flights = new Map<string, Promise<any>>();
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

  create(userId: string) {
    const id = randomUUID(),
      at = new Date().toISOString();
    this.store.run(
      "INSERT INTO company_sale_requests(id,userId,importId,shipmentId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)",
      id,
      userId,
      randomUUID(),
      randomUUID(),
      at,
      at,
    );
    return { requestId: id };
  }
  get(id: string, userId: string) {
    const r = this.store.one(
      "SELECT * FROM company_sale_requests WHERE id=? AND userId=?",
      id,
      userId,
    );
    if (!r)
      throw new CompanyErpError(
        "REQUEST_NOT_FOUND",
        "판매 작성 내역을 찾을 수 없습니다.",
        404,
      );
    return r;
  }
  pending(userId: string) {
    return this.store
      .all(
        "SELECT id,status,payload,remoteJson,error,createdAt FROM company_sale_requests WHERE userId=? AND status NOT IN ('draft','done') ORDER BY createdAt DESC LIMIT 30",
        userId,
      )
      .map((r) => ({
        id: r.id,
        status: r.status,
        recipient: JSON.parse(r.payload).recipient,
        reference: r.remoteJson
          ? JSON.parse(r.remoteJson).sale?.reference
          : null,
        error: r.error,
        createdAt: r.createdAt,
      }));
  }
  detail(id: string, userId: string) {
    const r = this.get(id, userId);
    return {
      requestId: r.id,
      status: r.status,
      row: r.payload ? JSON.parse(r.payload) : null,
      error: r.error,
      sale: r.remoteJson ? JSON.parse(r.remoteJson).sale : null,
    };
  }
  async context() {
    const r = await this.erp.saleTransport("GET");
    const parsed = parseSalesReference(r.nextReference);
    if (
      !validSalesDate(r.serverDate) ||
      !parsed ||
      parsed.date !== r.serverDate ||
      typeof r.writeEnabled !== "boolean"
    )
      throw new CompanyErpError(
        "CONTEXT_FORMAT",
        "ERP 판매번호 응답을 확인하지 못했습니다. 최신 판매 연동 파일을 설치해 주세요.",
        502,
      );
    return {
      serverDate: r.serverDate,
      nextReference: r.nextReference,
      writeEnabled: r.writeEnabled,
      preview: true,
    };
  }
  async save(id: string, userId: string, row: ShipmentInput) {
    this.get(id, userId);
    let normalized: ShipmentInput;
    try {
      const items = validateInvoiceItems(row?.items);
      const totals = invoiceTotals(items);
      if (!totals.complete) throw new Error("품목 금액 합계를 확인해 주세요.");
      normalized = validateShipments([
        {
          ...row,
          items,
          amount: totals.total,
          erpSourceKey: undefined,
          salesReference: undefined,
        },
      ])[0];
      normalized.items = items;
      if (!/^[1-9][0-9]{0,14}$/.test(normalized.erpCustomerId ?? ""))
        throw new Error("ERP 거래처 검색에서 거래처를 선택해 주세요.");
      if (normalized.recipient.length > 100 || normalized.address.length > 200)
        throw new Error(
          "ERP 거래처명은 100자, 배송주소는 200자 이하로 입력해 주세요. 상세 요청사항은 메모에 적어 주세요.",
        );
      if ((normalized.notes?.length ?? 0) > 500)
        throw new Error("요청사항은 500자 이하로 입력해 주세요.");
    } catch (e) {
      throw new CompanyErpError("INPUT", (e as Error).message, 400);
    }
    const json = stable(normalized),
      digest = hash(json);
    this.store.transaction(() => {
      const r = this.get(id, userId);
      if (r.requestHash && r.requestHash !== digest)
        throw new CompanyErpError(
          "REQUEST_CONFLICT",
          "이 전표는 이미 저장을 요청했습니다. 원래 내용으로 저장을 마무리한 뒤 새 전표를 작성해 주세요.",
          409,
        );
      if (!r.requestHash)
        this.store.run(
          "UPDATE company_sale_requests SET status='pending',payload=?,requestHash=?,error=NULL,updatedAt=? WHERE id=?",
          json,
          digest,
          new Date().toISOString(),
          id,
        );
    });
    if (this.get(id, userId).status === "done")
      return this.done(this.get(id, userId));
    if (this.flights.has(id)) return this.flights.get(id)!;
    const task = this.commit(id, userId);
    this.flights.set(id, task);
    try {
      return await task;
    } finally {
      this.flights.delete(id);
    }
  }
  private done(r: any) {
    const shipment = this.store.one(
      "SELECT id,salesReference FROM shipments WHERE id=?",
      r.shipmentId,
    );
    if (!shipment)
      throw new CompanyErpError(
        "DELETED",
        "이 저장 건의 배송지는 삭제되었습니다. ERP 원본과 배송 내역을 확인해 주세요.",
        410,
      );
    return {
      ok: true,
      count: 1,
      shipmentId: shipment.id,
      salesReference: shipment.salesReference,
      status: "done",
    };
  }
  private async commit(id: string, userId: string) {
    let r = this.get(id, userId);
    if (r.status === "done") return this.done(r);
    try {
      if (!r.remoteJson) {
        const response = await this.erp.saleTransport("POST", {
          requestId: id,
          row: JSON.parse(r.payload),
        });
        if (response.requestId !== id)
          throw new CompanyErpError(
            "REMOTE_ID",
            "ERP 저장 요청 번호가 일치하지 않습니다. 원래 전표의 저장 상태를 확인해 주세요.",
            502,
          );
        this.store.run(
          "UPDATE company_sale_requests SET remoteJson=?,status='remote_saved',updatedAt=? WHERE id=? AND status!='done'",
          JSON.stringify(response),
          new Date().toISOString(),
          id,
        );
        r = this.get(id, userId);
      }
      const remote = JSON.parse(r.remoteJson),
        sale = remote.sale,
        payload = JSON.parse(r.payload);
      if (
        !sale ||
        typeof sale.id !== "string" ||
        !/^[1-9][0-9]{0,14}$/.test(sale.id) ||
        !validSalesDate(sale.saleDate) ||
        parseSalesReference(sale.reference)?.date !== sale.saleDate ||
        sale.status !== "draft"
      )
        throw new CompanyErpError(
          "REMOTE_FORMAT",
          "ERP 저장 결과를 확인해야 합니다. ERP에는 저장되었을 수 있으니 같은 전표에서 다시 확인해 주세요.",
          502,
        );
      const row = validateShipments([
        {
          ...sale,
          salesReference: sale.reference,
          erpSourceKey:
            "company-sale-" +
            hash(
              JSON.stringify([remote.sourceUrl, remote.instanceId, sale.id]),
            ),
        },
      ])[0];
      const actualItems = validateInvoiceItems(sale.items),
        totals = invoiceTotals(actualItems),
        expected = invoiceTotals(payload.items);
      if (
        !totals.complete ||
        totals.total !== sale.amount ||
        totals.total !== expected.total ||
        actualItems.length !== payload.items.length ||
        actualItems.some(
          (item, i) =>
            item.erpItemId !== payload.items[i].erpItemId ||
            item.quantity !== payload.items[i].quantity ||
            item.supplyAmount !== payload.items[i].supplyAmount ||
            item.totalAmount !== payload.items[i].totalAmount,
        )
      )
        throw new CompanyErpError(
          "REMOTE_MONEY",
          "ERP 저장 금액·품목과 작성 내용이 다릅니다. ERP 전표를 확인해 주세요. 중복 전표는 만들지 않았습니다.",
          409,
        );
      row.items = actualItems;
      const storedName = r.importId + ".json",
        file = join(this.dataDir, "uploads", storedName),
        tmp = file + "." + randomUUID() + ".tmp";
      if (!existsSync(file)) {
        writeFileSync(tmp, JSON.stringify(sale), { mode: 0o600 });
        renameSync(tmp, file);
      }
      this.store.transaction(() => {
        const current = this.get(id, userId);
        if (current.status === "done") return;
        const linked = this.store.one(
          "SELECT id,importId FROM shipments WHERE erpSourceKey=?",
          row.erpSourceKey,
        );
        if (linked) {
          this.store.run(
            "UPDATE company_sale_requests SET status='done',shipmentId=?,importId=?,error=NULL,updatedAt=? WHERE id=?",
            linked.id,
            linked.importId,
            new Date().toISOString(),
            id,
          );
          return;
        }
        const at = new Date().toISOString();
        this.store.run(
          "INSERT INTO imports(id,fileName,storedName,mime,drafts,status,serviceDate,createdAt,count,meta) VALUES(?,?,?,?,?,'committed',?,?,1,?)",
          r.importId,
          `ERP판매_${sale.reference}.json`,
          storedName,
          "application/json",
          JSON.stringify([row]),
          sale.saleDate,
          at,
          JSON.stringify({ source: "company-erp-created", requestId: id }),
        );
        this.store.run(
          "INSERT INTO shipments(id,importId,recipient,address,phone,items,notes,lat,lng,serviceDate,createdAt,amount,customerCode,salesReference,erpSourceKey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          r.shipmentId,
          r.importId,
          row.recipient,
          row.address,
          row.phone ?? "",
          JSON.stringify(row.items),
          row.notes ?? "",
          row.lat ?? null,
          row.lng ?? null,
          sale.saleDate,
          at,
          row.amount ?? null,
          row.customerCode ?? null,
          sale.reference,
          row.erpSourceKey,
        );
        for (const key of salesImportKeys(row))
          this.store.run(
            "INSERT INTO erp_sales_links(sourceKey,importId) VALUES(?,?)",
            key,
            r.importId,
          );
        this.store.run(
          "UPDATE company_sale_requests SET status='done',error=NULL,updatedAt=? WHERE id=?",
          at,
          id,
        );
      });
      this.changed(sale.saleDate);
      return this.done(this.get(id, userId));
    } catch (e) {
      const error =
        e instanceof CompanyErpError
          ? e
          : new CompanyErpError(
              "LOCAL_SAVE",
              "ERP·배송지 저장을 마무리하지 못했습니다. 같은 전표에서 저장을 다시 눌러 주세요.",
              502,
            );
      const current = this.get(id, userId);
      if ((error as any).safeToEdit === true && !current.remoteJson)
        this.store.run(
          "UPDATE company_sale_requests SET status='draft',payload=NULL,requestHash=NULL,error=?,updatedAt=? WHERE id=?",
          error.message,
          new Date().toISOString(),
          id,
        );
      else
        this.store.run(
          "UPDATE company_sale_requests SET error=?,updatedAt=? WHERE id=?",
          error.message,
          new Date().toISOString(),
          id,
        );
      throw error;
    }
  }
  async close() {
    await Promise.allSettled([...this.flights.values()]);
  }
}
