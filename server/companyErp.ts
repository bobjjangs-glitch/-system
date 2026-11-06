import { createHash } from "node:crypto";
import type { Store } from "./database.ts";
import type { ShipmentInput } from "./types.ts";
import { salesImportKeys, savedManualSale } from "./erpCatalog.ts";
import { validSalesDate, parseSalesReference } from "../src/salesReference.ts";
export const DEFAULT_COMPANY_ERP_URL =
  "https://bobjjangs1231.dothome.co.kr/tire/erp/dispatch_api.php";
export class CompanyErpError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "CompanyErpError";
    this.code = code;
    this.status = status;
  }
}
export type CompanyErpDeps = {
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  now?: () => number;
};
export type CompanyCatalogKind = "customers" | "products";
export type CompanyCatalogEntry = {
  id: string;
  remoteId?: string;
  pattern?: string;
  taxType?: "taxable" | "exempt";
  listPrice?: number | null;
  code: string;
  name: string;
  source: "company-erp" | "company-erp-live";
  updatedAt: string;
  address?: string;
  phone?: string;
  specification?: string;
  unitPrice?: number | null;
};
type Kind = CompanyCatalogKind | "sales";
type Page = {
  instanceId: string;
  snapshot: string;
  total: number;
  cursor: string;
  nextCursor: string | null;
  readAt: string;
  date: string | null;
  items: any[];
  excluded: { draft: number; canceled: number };
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (value: unknown, max: number, allowEmpty = true): string => {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim())
  )
    throw new CompanyErpError(
      "FORMAT",
      "회사 ERP의 응답 항목을 확인하지 못했습니다. 연동 파일 버전을 확인해 주세요.",
      502,
    );
  return value.trim();
};
const integer = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const remoteId = (value: unknown) =>
  typeof value === "string" && /^[1-9][0-9]{0,14}$/.test(value);
export class CompanyErpClient {
  private store: Store;
  private fetcher: typeof fetch;
  private now: () => number;
  private url: string;
  private token: string;
  private valid = false;
  private urlValid = false;
  private closed = false;
  private controllers = new Set<AbortController>();
  private jobs = new Set<Promise<unknown>>();
  private flights = new Map<string, Promise<any>>();
  private reads: Partial<Record<Kind, { at: string; count: number }>> = {};
  private lastError: string | null = null;
  constructor(store: Store, deps: CompanyErpDeps = {}) {
    this.store = store;
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
    const env = deps.env ?? process.env;
    this.url = env.COMPANY_ERP_API_URL?.trim() || DEFAULT_COMPANY_ERP_URL;
    this.token = env.COMPANY_ERP_TOKEN?.trim() ?? "";
    try {
      const u = new URL(this.url);
      this.urlValid =
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname.endsWith("/dispatch_api.php");
      this.valid = this.urlValid && /^[a-f0-9]{64}$/.test(this.token);
      this.url = u.toString();
    } catch {}
  }
  status() {
    return {
      provider: "company-erp",
      configured: this.valid,
      apiUrl: this.urlValid ? this.url : DEFAULT_COMPANY_ERP_URL,
      missing: [
        ...(!this.token ? ["COMPANY_ERP_TOKEN"] : []),
        ...(!this.urlValid ? ["COMPANY_ERP_API_URL"] : []),
      ],
      state: !this.valid
        ? "not-configured"
        : this.lastError
          ? "last-read-failed"
          : Object.keys(this.reads).length
            ? "last-read-succeeded"
            : "not-tested",
      lastError: this.lastError,
      reads: this.reads,
      confirmedSalesOnly: true,
    };
  }
  private requireConfig() {
    if (this.closed)
      throw new CompanyErpError(
        "CLOSED",
        "서버가 재시작 중입니다. 잠시 후 조회해 주세요.",
        503,
      );
    if (!this.valid)
      throw new CompanyErpError(
        "NOT_CONFIGURED",
        "닷홈 ERP에 연동 파일을 설치하고 Render에 COMPANY_ERP_TOKEN을 등록해 주세요.",
        503,
      );
  }
  private async track<T>(
    key: string,
    fn: () => Promise<T>,
    share = false,
  ): Promise<T> {
    this.requireConfig();
    if (share && this.flights.has(key)) return this.flights.get(key)!;
    const task = fn();
    this.jobs.add(task);
    if (share) this.flights.set(key, task);
    try {
      return await task;
    } catch (e) {
      const error =
        e instanceof CompanyErpError
          ? e
          : new CompanyErpError(
              "CONNECTION",
              "회사 ERP 조회를 처리하지 못했습니다. 연결 설정을 확인해 주세요.",
              502,
            );
      this.lastError = error.message;
      throw error;
    } finally {
      this.jobs.delete(task);
      if (share) this.flights.delete(key);
    }
  }
  private async page(
    kind: Kind,
    query: Record<string, string>,
    deadline: number,
  ): Promise<Page> {
    this.requireConfig();
    const remaining = deadline - this.now();
    if (remaining <= 0)
      throw new CompanyErpError(
        "TIMEOUT",
        "ERP 조회 시간이 초과됐습니다. 기존 자료는 유지됩니다. 다시 조회해 주세요.",
        504,
      );
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(15000, remaining),
    );
    const u = new URL(this.url);
    u.search = new URLSearchParams({ kind, ...query }).toString();
    try {
      let response: Response;
      try {
        response = await this.fetcher(u, {
          headers: {
            "X-Dispatch-Token": this.token,
            Accept: "application/json",
          },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new CompanyErpError(
          "NETWORK",
          controller.signal.aborted
            ? "회사 ERP 응답 시간이 초과됐습니다. 잠시 후 다시 조회해 주세요."
            : "닷홈 ERP에 연결하지 못했습니다. 주소와 연결 상태를 확인해 주세요.",
          controller.signal.aborted ? 504 : 502,
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if ([401, 403].includes(response.status))
          throw new CompanyErpError(
            "AUTHORIZATION",
            "회사 ERP 연동키가 일치하지 않습니다. Render의 COMPANY_ERP_TOKEN을 확인해 주세요.",
          );
        if (response.status === 404)
          throw new CompanyErpError(
            "NOT_INSTALLED",
            "닷홈 tire/erp 폴더에 dispatch_api.php와 연결 파일을 먼저 업로드해 주세요.",
            503,
          );
        if (response.status === 409)
          throw new CompanyErpError(
            "CHANGED",
            "조회 도중 ERP 자료가 변경됐습니다. 다시 가져와 주세요.",
            409,
          );
        throw new CompanyErpError(
          "UPSTREAM",
          "회사 ERP가 조회를 처리하지 못했습니다. ERP 연동 설치와 서버 상태를 확인해 주세요.",
          502,
        );
      }
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (!response.body) throw new Error();
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            controller.abort();
            throw new CompanyErpError(
              "TOO_LARGE",
              "ERP 응답이 너무 큽니다. 조회 범위를 줄여 주세요.",
            );
          }
          chunks.push(chunk);
        }
      } catch (e) {
        if (e instanceof CompanyErpError) throw e;
        throw new CompanyErpError(
          "BODY",
          "ERP 응답을 끝까지 읽지 못했습니다. 다시 조회해 주세요.",
          502,
        );
      }
      let data: any;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new CompanyErpError(
          "LOGIN_PAGE",
          "ERP가 조회 자료 대신 로그인 화면이나 다른 형식을 반환했습니다. 연동 파일 설치를 확인해 주세요.",
          502,
        );
      }
      // PHP/PDO may serialize scalar metadata as strings. Normalize only exact safe scalars.
      const numeric = (v: unknown) =>
        typeof v === "string" &&
        /^(0|[1-9][0-9]*)$/.test(v) &&
        Number.isSafeInteger(Number(v))
          ? Number(v)
          : v;
      const identifier = (v: unknown) =>
        typeof v === "number" && Number.isSafeInteger(v) && v >= 0
          ? String(v)
          : v;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        data.schema = numeric(data.schema);
        data.total = numeric(data.total);
        data.ok = [true, 1, "1", "true"].includes(data.ok);
        data.cursor = identifier(data.cursor);
        data.nextCursor = identifier(data.nextCursor);
        if (Array.isArray(data.items))
          data.items = data.items.map((row: any) =>
            row && typeof row === "object"
              ? { ...row, id: identifier(row.id) }
              : row,
          );
        if (data.excluded && typeof data.excluded === "object")
          data.excluded = {
            ...data.excluded,
            draft: numeric(data.excluded.draft),
            canceled: numeric(data.excluded.canceled),
          };
      }
      const wrong: string[] = [];
      if (data?.schema !== 1 && data?.schema !== 2) wrong.push("schema");
      if (data?.ok !== true) wrong.push("ok");
      if (data?.kind !== kind) wrong.push("kind");
      if (
        typeof data?.instanceId !== "string" ||
        !/^[a-f0-9]{32}$/.test(data.instanceId)
      )
        wrong.push("instanceId");
      if (
        typeof data?.snapshot !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.snapshot)
      )
        wrong.push("snapshot");
      if (!integer(data?.total)) wrong.push("total");
      if (
        !Array.isArray(data?.items) ||
        data.items.length > Number(query.limit ?? 500) ||
        data.items.length > data.total
      )
        wrong.push("items");
      if (data?.cursor !== (query.cursor ?? "0")) wrong.push("cursor");
      if (data?.nextCursor !== null && !remoteId(data?.nextCursor))
        wrong.push("nextCursor");
      if (
        typeof data?.readAt !== "string" ||
        !Number.isFinite(Date.parse(data.readAt))
      )
        wrong.push("readAt");
      if (kind === "sales" && data?.date !== query.date) wrong.push("date");
      if (wrong.length)
        throw new CompanyErpError(
          "FORMAT",
          `회사 ERP 연동 응답의 ${wrong.join("·")} 항목이 맞지 않습니다. dispatch_api.php와 inc/dispatch_bridge.php를 같은 최신 ZIP으로 교체해 주세요.`,
          502,
        );
      if (data.total > 100000)
        throw new CompanyErpError(
          "LIMIT",
          "전체 품목·거래처가 100,000개를 넘습니다. 검색어를 입력해 조회 범위를 줄여 주세요.",
        );
      let previous = BigInt(query.cursor ?? "0");
      for (const item of data.items) {
        if (!remoteId(item?.id) || BigInt(item.id) <= previous)
          throw new CompanyErpError(
            "ORDER",
            "ERP 응답에 중복 또는 잘못된 순번이 있습니다. 기존 자료를 유지합니다.",
            502,
          );
        previous = BigInt(item.id);
      }
      if (
        data.nextCursor !== null &&
        (!data.items.length || data.nextCursor !== data.items.at(-1).id)
      )
        throw new CompanyErpError(
          "CURSOR",
          "ERP 목록이 완전하지 않습니다. 기존 자료를 유지합니다.",
          502,
        );
      if (
        kind === "sales" &&
        (!integer(data.excluded?.draft) || !integer(data.excluded?.canceled))
      )
        throw new CompanyErpError(
          "FORMAT",
          "ERP 전표 상태 응답을 확인해 주세요.",
          502,
        );
      return data;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  private async all(kind: Kind, date?: string) {
    const deadline = this.now() + 45000;
    let cursor = "0",
      snapshot = "",
      instance = "",
      total = -1,
      latest: Page | undefined;
    const items: any[] = [];
    for (let page = 0; page < (kind === "sales" ? 41 : 201); page++) {
      const result = await this.page(
        kind,
        {
          cursor,
          limit: kind === "sales" ? "50" : "500",
          ...(date ? { date } : {}),
          ...(snapshot ? { snapshot } : {}),
        },
        deadline,
      );
      if (
        total >= 0 &&
        (result.total !== total ||
          result.snapshot !== snapshot ||
          result.instanceId !== instance)
      )
        throw new CompanyErpError(
          "CHANGED",
          "조회 중 ERP 자료가 변경됐습니다. 다시 가져와 주세요.",
          409,
        );
      total = result.total;
      snapshot = result.snapshot;
      instance = result.instanceId;
      latest = result;
      items.push(...result.items);
      if (items.length > 100000 || items.length > total)
        throw new CompanyErpError(
          "LIMIT",
          "ERP 목록의 전체 개수를 확인하지 못했습니다. 기존 자료를 유지합니다.",
          502,
        );
      if (result.nextCursor === null) {
        if (items.length !== total)
          throw new CompanyErpError(
            "PARTIAL",
            "ERP가 일부 자료만 반환했습니다. 기존 자료를 유지합니다.",
            502,
          );
        return {
          items,
          instanceId: instance,
          readAt: new Date(this.now()).toISOString(),
          excluded: latest.excluded,
        };
      }
      cursor = result.nextCursor;
    }
    throw new CompanyErpError(
      "LIMIT",
      "가져올 자료가 너무 많습니다. 조회 범위를 줄여 주세요.",
    );
  }
  private catalog(
    kind: CompanyCatalogKind,
    row: any,
    instance: string,
    at: string,
  ): CompanyCatalogEntry {
    const id =
        "company-" + hash(JSON.stringify([this.url, instance, kind, row.id])),
      code = text(row.code ?? "", 100),
      name = text(row.name, 200, false);
    return kind === "customers"
      ? {
          id,
          remoteId: row.id,
          code,
          name,
          address: text(row.address ?? "", 500),
          phone: text(row.phone ?? "", 40),
          source: "company-erp",
          updatedAt: at,
        }
      : {
          id,
          remoteId: row.id,
          code,
          name,
          pattern: text(row.pattern ?? "", 80),
          taxType: row.taxType === "exempt" ? "exempt" : "taxable",
          listPrice: row.listPrice == null ? null : this.price(row.listPrice),
          specification: text(row.specification ?? "", 200),
          unitPrice: this.price(row.unitPrice),
          source: "company-erp",
          updatedAt: at,
        };
  }
  private price(value: unknown) {
    if (value === null) return null;
    if (
      !["string", "number"].includes(typeof value) ||
      String(value).trim() === ""
    )
      throw new CompanyErpError(
        "AMOUNT",
        "ERP 금액 형식을 확인해 주세요.",
        502,
      );
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1e14)
      throw new CompanyErpError("AMOUNT", "ERP 금액을 확인해 주세요.", 502);
    return n;
  }
  async search(kind: CompanyCatalogKind, q: string) {
    return this.track("search", async () => {
      if (q.length > 100)
        throw new CompanyErpError("QUERY", "검색어를 줄여 주세요.", 400);
      const result = await this.page(
          kind,
          { q: q.trim(), cursor: "0", limit: "30" },
          this.now() + 20000,
        ),
        at = new Date(this.now()).toISOString();
      const items = result.items.map((row) =>
        this.catalog(kind, row, result.instanceId, at),
      );
      const liveItems = items.map((item) => ({
        ...item,
        source: "company-erp-live" as const,
      }));
      this.reads[kind] = { at, count: items.length };
      this.lastError = null;
      return liveItems;
    });
  }
  async sync(kind: CompanyCatalogKind) {
    return this.track(
      "sync-" + kind,
      async () => {
        const result = await this.all(kind),
          items = result.items.map((row) =>
            this.catalog(kind, row, result.instanceId, result.readAt),
          );
        this.store.transaction(() => {
          const table =
            kind === "customers" ? "catalog_customers" : "catalog_products";
          this.store.run(`DELETE FROM ${table} WHERE source='company-erp'`);
          for (const item of items) {
            if (kind === "customers")
              this.store.run(
                "INSERT INTO catalog_customers(id,code,name,address,phone,source,updatedAt) VALUES(?,?,?,?,?,?,?)",
                item.id,
                item.code,
                item.name,
                item.address,
                item.phone,
                item.source,
                item.updatedAt,
              );
            else
              this.store.run(
                "INSERT INTO catalog_products(id,code,name,specification,unitPrice,source,updatedAt) VALUES(?,?,?,?,?,?,?)",
                item.id,
                item.code,
                item.name,
                item.specification,
                item.unitPrice,
                item.source,
                item.updatedAt,
              );
          }
        });
        this.reads[kind] = { at: result.readAt, count: items.length };
        this.lastError = null;
        return { count: items.length, updatedAt: result.readAt, cached: false };
      },
      true,
    );
  }
  async sales(date: string) {
    return this.track(
      "sales-" + date,
      async () => {
        if (!validSalesDate(date))
          throw new CompanyErpError(
            "DATE",
            "판매일자를 YYYY-MM-DD 형식으로 확인해 주세요.",
            400,
          );
        const result = await this.all("sales", date),
          drafts: ShipmentInput[] = [],
          warnings = new Set<string>();
        let duplicate = 0,
          returns = 0;
        for (const row of result.items) {
          if (row.saleDate !== date || row.status !== "confirmed")
            throw new CompanyErpError(
              "DATE",
              "ERP의 판매일자 또는 확정 상태가 조회 조건과 다릅니다. 다시 확인해 주세요.",
              502,
            );
          const reference = text(row.reference, 200, false),
            parsed = parseSalesReference(reference);
          if (parsed && parsed.date !== date)
            throw new CompanyErpError(
              "DATE",
              "ERP 전표번호와 판매일자가 다릅니다. ERP 원본을 확인해 주세요.",
            );
          if (
            !Array.isArray(row.items) ||
            !row.items.length ||
            row.items.length > 1000
          )
            throw new CompanyErpError(
              "LINES",
              "물품이 없거나 너무 많은 ERP 전표입니다. ERP 원본을 확인해 주세요.",
            );
          const recipient = text(row.recipient, 200, false),
            address = text(row.address ?? "", 500),
            phone = text(row.phone ?? "", 40),
            customerCode = text(row.customerCode ?? "", 100),
            notes = text(row.notes ?? "", 2000);
          if (
            row.items.some(
              (item: any) =>
                !["string", "number"].includes(typeof item?.quantity) ||
                String(item.quantity).trim() === "" ||
                !Number.isFinite(Number(item.quantity)) ||
                Math.abs(Number(item.quantity)) > 1e9,
            )
          )
            throw new CompanyErpError(
              "QUANTITY",
              "ERP 전표 물품 수량을 확인해 주세요.",
            );
          if (row.items.some((item: any) => Number(item.quantity) <= 0)) {
            returns++;
            continue;
          }
          const items = row.items.map((item: any) => {
            const name = text(item.name, 200, false),
              spec = text(item.specification ?? "", 200),
              code = text(item.code ?? "", 100);
            return {
              name: spec && !name.includes(spec) ? name + " " + spec : name,
              quantity: Number(item.quantity),
              ...(code ? { code } : {}),
              ...(remoteId(String(item.erpItemId ?? ""))
                ? { erpItemId: String(item.erpItemId) }
                : {}),
              specification: spec,
              pattern: text(item.pattern ?? "", 80),
              ...(item.taxType === "taxable" || item.taxType === "exempt"
                ? { taxType: item.taxType }
                : {}),
              ...Object.fromEntries(
                [
                  "unitPrice",
                  "supplyAmount",
                  "totalAmount",
                  "listPrice",
                  "discountRate",
                ]
                  .filter((k) => item[k] != null)
                  .map((k) => [k, this.price(item[k])]),
              ),
              remarks: text(item.remarks ?? "", 200),
              ...(["unit", "supply", "total"].includes(item.amountBasis)
                ? { amountBasis: item.amountBasis }
                : {}),
            };
          });
          const draft: ShipmentInput = {
            recipient,
            address,
            phone,
            customerCode,
            notes,
            items,
            amount: this.price(row.amount),
            salesReference: reference,
            erpSourceKey:
              "company-sale-" +
              hash(JSON.stringify([this.url, result.instanceId, row.id])),
            lat: null,
            lng: null,
          };
          if (
            salesImportKeys(draft).some((key) =>
              this.store.one(
                "SELECT sourceKey FROM erp_sales_links WHERE sourceKey=?",
                key,
              ),
            ) ||
            savedManualSale(this.store, draft)
          ) {
            duplicate++;
            continue;
          }
          if (!address)
            warnings.add(
              "주소가 없는 전표가 있습니다. ERP 거래처 주소 또는 검토 화면에서 입력해 주세요.",
            );
          if (!phone)
            warnings.add(
              "연락처가 없는 전표가 있습니다. 저장 전 확인해 주세요.",
            );
          drafts.push(draft);
        }
        if (drafts.length > 2000)
          throw new CompanyErpError(
            "LIMIT",
            "한 번에 최대 2,000개 판매전표를 가져올 수 있습니다.",
          );
        if (result.excluded.draft || result.excluded.canceled)
          warnings.add(
            `작성중 ${result.excluded.draft}건·취소 ${result.excluded.canceled}건은 제외했습니다. 확정 판매전표만 가져옵니다.`,
          );
        if (returns)
          warnings.add(
            `반품·0 이하 수량이 포함된 ${returns}개 전표 전체를 제외했습니다. 혼합 전표는 원본을 확인해 직접 등록해 주세요.`,
          );
        if (duplicate)
          warnings.add(
            `이미 가져온 판매전표 ${duplicate}건은 제외했습니다. 등록된 배송지는 ERP 변경으로 자동 수정하지 않습니다.`,
          );
        this.reads.sales = { at: result.readAt, count: result.items.length };
        this.lastError = null;
        return {
          drafts,
          recognitionWarnings: [...warnings],
          sourceReadAt: result.readAt,
          salesDate: date,
          duplicateDocuments: duplicate,
          sourceCount: result.items.length,
        };
      },
      true,
    );
  }
  async saleTransport(method: "GET" | "POST", body?: unknown): Promise<any> {
    return this.track("sale-write", async () => {
      this.requireConfig();
      const endpoint = new URL(this.url);
      endpoint.pathname = endpoint.pathname.replace(
        /dispatch_api\.php$/,
        "dispatch_sale.php",
      );
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        let response: Response;
        try {
          response = await this.fetcher(endpoint, {
            method,
            headers: {
              "X-Dispatch-Token": this.token,
              Accept: "application/json",
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: "error",
            signal: controller.signal,
          });
        } catch {
          throw new CompanyErpError(
            "SALE_NETWORK",
            "ERP 판매 저장 결과를 확인하지 못했습니다. 같은 전표에서 저장을 다시 눌러 확인하세요.",
            502,
          );
        }
        const buf: Uint8Array[] = [];
        let size = 0;
        if (!response.body) throw new Error();
        for await (const part of response.body) {
          size += part.length;
          if (size > 2 * 1024 * 1024) {
            controller.abort();
            throw new Error();
          }
          buf.push(part);
        }
        let data: any;
        try {
          data = JSON.parse(Buffer.concat(buf).toString("utf8"));
        } catch {
          throw new CompanyErpError(
            "SALE_FORMAT",
            "ERP 판매 연동 응답을 확인하지 못했습니다. dispatch_sale.php 설치와 연결 상태를 확인해 주세요.",
            502,
          );
        }
        if (!response.ok || data?.ok !== true) {
          const error = new CompanyErpError(
            "SALE_REJECTED",
            data?.code === "WRITE_DISABLED"
              ? "ERP 관리자 연결 설정에서 ‘앱 판매 작성 허용’을 먼저 켜 주세요."
              : data?.code === "INPUT"
                ? "ERP 품목·거래처·단가·수량을 확인해 주세요."
                : data?.code === "REQUEST_CONFLICT"
                  ? "이미 ERP에 저장한 전표와 다른 내용입니다. 기존 저장 내역을 확인해 주세요."
                  : "ERP 판매 저장이 완료되지 않았습니다. 같은 전표에서 다시 확인해 주세요.",
            response.status === 404
              ? 503
              : response.status >= 500
                ? 502
                : response.status === 409
                  ? 409
                  : 422,
          );
          (error as CompanyErpError & { safeToEdit?: boolean }).safeToEdit =
            data?.safeToEdit === true &&
            ["INPUT", "WRITE_DISABLED"].includes(data?.code);
          throw error;
        }
        if (
          data.schema !== 2 ||
          typeof data.instanceId !== "string" ||
          !/^[a-f0-9]{32}$/.test(data.instanceId)
        )
          throw new CompanyErpError(
            "SALE_FORMAT",
            "ERP 판매 연동 파일 버전이 맞지 않습니다. 최신 파일을 설치해 주세요.",
            502,
          );
        this.lastError = null;
        return { ...data, sourceUrl: this.url };
      } finally {
        clearTimeout(timer);
        this.controllers.delete(controller);
      }
    });
  }
  async close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
    await Promise.allSettled([...this.jobs]);
  }
}
