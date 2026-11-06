import { createHash } from "node:crypto";
import type { Store } from "./database.ts";

export class EcountReadError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(
    code: string,
    message: string,
    status = 422,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "EcountReadError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
export type EcountReadDeps = {
  fetcher?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
};
export type ApiProduct = {
  id: string;
  code: string;
  name: string;
  specification: string;
  unitPrice: number | null;
  source: "ecount-api";
  updatedAt: string;
};
const required = [
  "ECOUNT_COM_CODE",
  "ECOUNT_USER_ID",
  "ECOUNT_API_CERT_KEY",
] as const;
const listInterval = 600000,
  singleInterval = 1100;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const clean = (v: unknown, max: number) =>
  typeof v === "string" || typeof v === "number"
    ? String(v).trim().slice(0, max)
    : "";
/** Read-only ECOUNT client. Only Zone, login and the two product read paths exist here. */
export class EcountReadClient {
  private store: Store;
  private fetcher: typeof fetch;
  private now: () => number;
  private env?: EcountReadDeps["env"];
  private session: {
    fingerprint: string;
    id: string;
    base: string;
    expiresAt: number;
  } | null = null;
  private logging: Promise<{
    fingerprint: string;
    id: string;
    base: string;
    expiresAt: number;
  }> | null = null;
  private syncFlight: Promise<any> | null = null;
  private loginNext = 0;
  private controllers = new Set<AbortController>();
  private lookups = new Set<Promise<unknown>>();
  private closed = false;
  constructor(store: Store, deps: EcountReadDeps = {}) {
    this.store = store;
    this.fetcher = deps.fetcher ?? fetch;
    this.now = deps.now ?? Date.now;
    const env = deps.env ?? process.env;
    this.env = Object.fromEntries(
      [...required, "ECOUNT_ENV"].map((key) => [key, env[key]]),
    );
    const meta = this.setting("ecount-product-read"),
      config = this.config();
    if (config.configured && meta && meta.fingerprint !== config.fingerprint) {
      // Switching API accounts must not leave the previous account's catalog selectable.
      this.store.transaction(() => {
        this.store.run(
          "DELETE FROM catalog_products WHERE source='ecount-api'",
        );
        this.store.run("DELETE FROM settings WHERE key='ecount-product-read'");
      });
    }
  }
  private config() {
    const env = this.env ?? process.env;
    const missing = required.filter((key) => !env[key]?.trim());
    const mode = env.ECOUNT_ENV?.trim() || "production";
    const configured =
      !missing.length && ["production", "sandbox"].includes(mode);
    const code = env.ECOUNT_COM_CODE?.trim() ?? "",
      user = env.ECOUNT_USER_ID?.trim() ?? "",
      key = env.ECOUNT_API_CERT_KEY?.trim() ?? "";
    return {
      configured,
      missing,
      mode,
      code,
      user,
      key,
      fingerprint: hash(JSON.stringify([mode, code, user, key])),
    };
  }
  private setting(key: string) {
    const raw = this.store.one(
      "SELECT value FROM settings WHERE key=?",
      key,
    )?.value;
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  private put(key: string, value: unknown) {
    this.store.run(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  status() {
    const c = this.config(),
      meta = this.setting("ecount-product-read"),
      same = meta?.fingerprint === c.fingerprint;
    return {
      mode: "ecount-api",
      configured: c.configured,
      missing: c.missing,
      environment: c.mode,
      products: {
        supported: true,
        state: !c.configured
          ? "not-configured"
          : same
            ? meta.error
              ? "last-read-failed"
              : "last-read-succeeded"
            : "not-tested",
        lastReadAt: same ? meta.at : null,
        count: same && !meta.error ? meta.count : null,
        nextListAt: new Date(
          Math.max(this.now(), Number(this.setting("ecount-list-next") ?? 0)),
        ).toISOString(),
        listIntervalSeconds: listInterval / 1000,
        lastError: same ? (meta.error ?? null) : null,
      },
      customers: {
        supported: false,
        reason:
          "현재 확인한 Open API에는 거래처 등록만 있고 거래처 조회는 제공되지 않습니다.",
      },
      sales: {
        supported: false,
        reason:
          "현재 확인한 Open API에는 판매 입력만 있고 판매내역 조회는 제공되지 않습니다.",
      },
    };
  }
  private requireConfig() {
    if (this.closed)
      throw new EcountReadError(
        "CLOSED",
        "서버가 재시작 중입니다. 잠시 후 다시 조회해 주세요.",
        503,
      );
    const c = this.config();
    if (!c.configured)
      throw new EcountReadError(
        "NOT_CONFIGURED",
        "서버에 ECOUNT_COM_CODE·ECOUNT_USER_ID·ECOUNT_API_CERT_KEY와 운영/테스트 구분을 설정해 주세요.",
        503,
      );
    if (c.code.length > 100 || c.user.length > 100 || c.key.length > 2048)
      throw new EcountReadError(
        "INVALID_CONFIG",
        "E카운트 서버 인증 설정을 확인해 주세요.",
      );
    return c;
  }
  private async post(url: string, body: unknown) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
          redirect: "error",
        });
      } catch {
        throw new EcountReadError(
          controller.signal.aborted ? "TIMEOUT" : "NETWORK",
          controller.signal.aborted
            ? "E카운트 응답 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요."
            : "E카운트 서버에 연결하지 못했습니다.",
          controller.signal.aborted ? 504 : 502,
        );
      }
      if ([412, 429].includes(response.status))
        throw new EcountReadError(
          "RATE_LIMIT",
          "E카운트의 API 전송 횟수 제한에 걸렸습니다. 잠시 후 다시 조회해 주세요.",
          429,
          600,
        );
      if ([401, 403].includes(response.status)) {
        this.session = null;
        throw new EcountReadError(
          "AUTHORIZATION",
          "E카운트 API 인증키·사용자 조회 권한·허용 IP를 확인해 주세요.",
        );
      }
      if (!response.ok)
        throw new EcountReadError(
          "PROVIDER",
          "E카운트 요청을 처리하지 못했습니다. API 매뉴얼과 서비스 상태를 확인해 주세요.",
          502,
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (!response.body)
        throw new EcountReadError(
          "FORMAT",
          "E카운트의 응답 형식을 확인하지 못했습니다.",
          502,
        );
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            controller.abort();
            throw new EcountReadError(
              "TOO_LARGE",
              "품목 응답이 너무 큽니다. 품목코드로 개별 조회해 주세요.",
            );
          }
          chunks.push(chunk);
        }
      } catch (error) {
        if (error instanceof EcountReadError) throw error;
        throw new EcountReadError(
          controller.signal.aborted ? "TIMEOUT" : "NETWORK",
          "E카운트 응답을 끝까지 읽지 못했습니다. 다시 조회해 주세요.",
          502,
        );
      }
      let data: any;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new EcountReadError(
          "FORMAT",
          "E카운트 응답 형식이 API 매뉴얼과 다릅니다.",
          502,
        );
      }
      if ([412, 429].includes(Number(data?.Status)))
        throw new EcountReadError(
          "RATE_LIMIT",
          "E카운트 API 전송 횟수 제한입니다. 잠시 후 다시 조회해 주세요.",
          429,
          600,
        );
      if (
        Number(data?.Status) !== 200 ||
        data.Error ||
        (Array.isArray(data.Errors) && data.Errors.length)
      ) {
        this.session = null;
        throw new EcountReadError(
          "API_REJECTED",
          "E카운트 API 요청이 거절되었습니다. 운영/테스트 인증키·조회 권한·허용 IP와 전송 기준을 확인해 주세요.",
        );
      }
      return data.Data;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  private async auth() {
    const c = this.requireConfig();
    if (
      this.session?.fingerprint === c.fingerprint &&
      this.session.expiresAt > this.now()
    )
      return this.session;
    if (this.logging) return this.logging;
    if (this.now() < this.loginNext)
      throw new EcountReadError(
        "LOGIN_COOLDOWN",
        "연속 인증 요청을 제한하고 있습니다. 잠시 후 다시 시도해 주세요.",
        429,
        Math.ceil((this.loginNext - this.now()) / 1000),
      );
    this.loginNext = this.now() + 10000;
    this.logging = (async () => {
      const zoneData = await this.post(
        "https://" +
          (c.mode === "sandbox" ? "sboapi" : "oapi") +
          ".ecount.com/OAPI/V2/Zone",
        { COM_CODE: c.code },
      );
      const zone = clean(zoneData?.ZONE, 10).toLowerCase();
      if (!/^[a-z0-9]{2}$/.test(zone))
        throw new EcountReadError(
          "ZONE",
          "E카운트 Zone 응답을 확인하지 못했습니다.",
          502,
        );
      const host =
          (c.mode === "sandbox" ? "sboapi" : "oapi") + zone + ".ecount.com",
        base = "https://" + host + "/OAPI/V2";
      const data = await this.post(base + "/OAPILogin", {
        COM_CODE: c.code,
        USER_ID: c.user,
        API_CERT_KEY: c.key,
        LAN_TYPE: "ko-KR",
        ZONE: zone.toUpperCase(),
      });
      const id = data?.Datas?.SESSION_ID;
      if (typeof id !== "string" || !id || id.length > 4096)
        throw new EcountReadError(
          "LOGIN",
          "E카운트 API 로그인에 실패했습니다. 인증키 종류·사용자 ID·허용 IP를 확인해 주세요.",
        );
      this.session = {
        fingerprint: c.fingerprint,
        id,
        base,
        expiresAt: this.now() + 25 * 60000,
      };
      return this.session;
    })().finally(() => {
      this.logging = null;
    });
    return this.logging;
  }
  private products(data: any): ApiProduct[] {
    let rows = data?.Result;
    if (typeof rows === "string") {
      try {
        rows = JSON.parse(rows);
      } catch {
        throw new EcountReadError(
          "FORMAT",
          "E카운트 품목 응답 형식을 확인해 주세요.",
          502,
        );
      }
    }
    if (
      rows &&
      typeof rows === "object" &&
      !Array.isArray(rows) &&
      rows.PROD_CD
    )
      rows = [rows];
    if (!Array.isArray(rows) || rows.length > 20000)
      throw new EcountReadError(
        "FORMAT",
        "E카운트 품목 목록 응답을 확인하지 못했습니다. 공식 조회 매뉴얼을 확인해 주세요.",
        502,
      );
    if (
      Number.isFinite(Number(data.TotalCount)) &&
      Number(data.TotalCount) > rows.length
    )
      throw new EcountReadError(
        "PARTIAL",
        "E카운트가 일부 품목만 반환했습니다. 전체 목록으로 저장하지 않았습니다. API의 조회 범위를 확인해 주세요.",
      );
    const at = new Date(this.now()).toISOString();
    const products: ApiProduct[] = rows.map((row: any) => {
      const code = clean(row?.PROD_CD, 100),
        name = clean(row?.PROD_DES, 200),
        specification = clean(row?.SIZE_DES, 200);
      if (!code || !name)
        throw new EcountReadError(
          "FORMAT",
          "품목코드·품목명이 빠진 API 응답입니다. 이전 목록을 유지합니다.",
          502,
        );
      const raw = clean(row.OUT_PRICE, 100).replace(/,/g, ""),
        price = raw ? Number(raw) : null;
      return {
        id: "api-" + hash(JSON.stringify([code, name, specification])),
        code,
        name,
        specification,
        unitPrice:
          price !== null &&
          Number.isFinite(price) &&
          price >= 0 &&
          price <= 1e14
            ? price
            : null,
        source: "ecount-api",
        updatedAt: at,
      };
    });
    return [...new Map(products.map((p) => [p.id, p])).values()];
  }
  async syncProducts() {
    if (this.syncFlight) return this.syncFlight;
    this.syncFlight = this.sync().finally(() => {
      this.syncFlight = null;
    });
    return this.syncFlight;
  }
  private async sync() {
    const c = this.requireConfig(),
      meta = this.setting("ecount-product-read"),
      next = Number(this.setting("ecount-list-next") ?? 0);
    if (next > this.now()) {
      if (meta?.fingerprint === c.fingerprint && !meta.error)
        return {
          count: meta.count,
          updatedAt: meta.at,
          cached: true,
          nextAvailableAt: new Date(next).toISOString(),
        };
      throw new EcountReadError(
        "LIST_COOLDOWN",
        "품목 목록의 연속 조회를 제한하고 있습니다. 조회 가능 시각 뒤 다시 시도하거나 품목코드로 개별 조회해 주세요.",
        429,
        Math.ceil((next - this.now()) / 1000),
      );
    }
    const auth = await this.auth();
    this.store.transaction(() => {
      const current = Number(this.setting("ecount-list-next") ?? 0);
      if (current > this.now())
        throw new EcountReadError(
          "LIST_COOLDOWN",
          "다른 품목 목록 조회가 진행 중입니다.",
          429,
          Math.ceil((current - this.now()) / 1000),
        );
      this.put("ecount-list-next", this.now() + listInterval);
    });
    try {
      const data = await this.post(
          auth.base +
            "/InventoryBasic/GetBasicProductsList?SESSION_ID=" +
            encodeURIComponent(auth.id),
          {},
        ),
        items = this.products(data),
        at = new Date(this.now()).toISOString();
      this.store.transaction(() => {
        this.store.run(
          "DELETE FROM catalog_products WHERE source='ecount-api'",
        );
        for (const item of items)
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
        this.put("ecount-product-read", {
          fingerprint: c.fingerprint,
          at,
          count: items.length,
        });
      });
      return {
        count: items.length,
        updatedAt: at,
        cached: false,
        nextAvailableAt: new Date(
          Number(this.setting("ecount-list-next")),
        ).toISOString(),
      };
    } catch (error) {
      this.put("ecount-product-read", {
        fingerprint: c.fingerprint,
        at: meta?.at ?? null,
        count: meta?.count ?? null,
        error:
          error instanceof EcountReadError
            ? error.message
            : "품목 목록 조회에 실패했습니다.",
      });
      throw error instanceof EcountReadError
        ? error
        : new EcountReadError(
            "STORAGE",
            "품목 목록을 저장하지 못했습니다. 이전 목록을 유지합니다.",
            500,
          );
    }
  }
  async lookupProduct(code: unknown) {
    const task = this.lookup(code);
    this.lookups.add(task);
    try {
      return await task;
    } finally {
      this.lookups.delete(task);
    }
  }
  private async lookup(code: unknown) {
    const cleanCode = typeof code === "string" ? code.trim() : "";
    if (!cleanCode || cleanCode.length > 100)
      throw new EcountReadError(
        "CODE",
        "조회할 정확한 품목코드를 입력해 주세요.",
        400,
      );
    this.requireConfig();
    const next = Number(this.setting("ecount-single-next") ?? 0);
    if (next > this.now())
      throw new EcountReadError(
        "SINGLE_COOLDOWN",
        "품목 개별 조회를 잠시 후 다시 실행해 주세요.",
        429,
        Math.ceil((next - this.now()) / 1000),
      );
    const auth = await this.auth();
    this.store.transaction(() => {
      const next = Number(this.setting("ecount-single-next") ?? 0);
      if (next > this.now())
        throw new EcountReadError(
          "SINGLE_COOLDOWN",
          "품목 조회가 진행 중입니다.",
          429,
          1,
        );
      this.put("ecount-single-next", this.now() + singleInterval);
    });
    const data = await this.post(
      auth.base +
        "/InventoryBasic/ViewBasicProduct?SESSION_ID=" +
        encodeURIComponent(auth.id),
      { PROD_CD: cleanCode },
    );
    const items = this.products(data);
    if (items.some((item) => item.code !== cleanCode))
      throw new EcountReadError(
        "CODE_MISMATCH",
        "API가 다른 품목코드를 반환했습니다. 조회 조건을 확인해 주세요.",
        502,
      );
    return {
      items,
      updatedAt: new Date(this.now()).toISOString(),
      cached: false,
    };
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(
      [this.syncFlight, ...this.lookups].filter(Boolean),
    );
    this.session = null;
  }
}
