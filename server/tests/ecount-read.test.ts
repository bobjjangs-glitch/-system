import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import ExcelJS from "exceljs";
import { Store } from "../database.ts";
import { EcountReadClient, EcountReadError } from "../ecountRead.ts";
import { createDispatchApp } from "../app.ts";
import { searchCatalog, parseSalesExport } from "../erpCatalog.ts";
const env = {
  ECOUNT_COM_CODE: "example-company",
  ECOUNT_USER_ID: "example-user",
  ECOUNT_API_CERT_KEY: "example-cert-not-real",
  ECOUNT_ENV: "production",
};
const product = {
  PROD_CD: "P-1",
  PROD_DES: "예시 API 타이어",
  SIZE_DES: "205/55R16",
  OUT_PRICE: "15,000",
};
const success = (Data: unknown) => Response.json({ Status: "200", Data });
function provider() {
  const calls: { url: URL; body: any }[] = [];
  const state = {
    zone: "AA",
    list: { Result: [product] } as any,
    single: { Result: product } as any,
    listResponse: null as Response | null,
    loginResponse: null as Response | null,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      body = JSON.parse(String(init?.body));
    calls.push({ url, body });
    assert.equal(init?.redirect, "error");
    assert.equal(init?.method, "POST");
    if (url.pathname.endsWith("/Zone"))
      return success({
        ZONE: state.zone,
        HOST_URL: "https://untrusted.example",
      });
    if (url.pathname.endsWith("/OAPILogin"))
      return (
        state.loginResponse ??
        success({
          Datas: {
            SESSION_ID: "example-session-not-real",
            HOST_URL: "https://untrusted.example",
          },
        })
      );
    if (url.pathname.endsWith("/GetBasicProductsList"))
      return state.listResponse ?? success(state.list);
    if (url.pathname.endsWith("/ViewBasicProduct"))
      return success(state.single);
    throw new Error("Unexpected API path: " + url.pathname);
  };
  return { calls, state, fetcher };
}
async function fixture(t: TestContext, overrides: Partial<typeof env> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ecount-read-")),
    store = new Store(dir),
    fake = provider();
  let time = Date.parse("2026-11-06T00:00:00Z");
  const deps = {
      env: { ...env, ...overrides },
      fetcher: fake.fetcher,
      now: () => time,
    },
    client = new EcountReadClient(store, deps);
  t.after(async () => {
    await client.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    store,
    client,
    deps,
    ...fake,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
test("E카운트 인증 설정이 없으면 외부 호출 없이 관리자에게 설정 항목만 알린다", async (t) => {
  const { client, calls } = await fixture(t, { ECOUNT_API_CERT_KEY: "" });
  assert.equal(client.status().configured, false);
  assert.deepEqual(client.status().missing, ["ECOUNT_API_CERT_KEY"]);
  await assert.rejects(
    client.syncProducts(),
    (e: any) => e.status === 503 && e.code === "NOT_CONFIGURED",
  );
  await assert.rejects(client.lookupProduct("P-1"), /설정/);
  assert.equal(calls.length, 0);
});
test("Zone·로그인·목록 조회만 호출하고 API 스냅샷을 저장하며 엑셀과 전표는 보존한다", async (t) => {
  const { client, store, calls } = await fixture(t);
  store.run(
    "INSERT INTO catalog_products VALUES('excel','P-1','이전 엑셀 품목','',100,'ecount','2026-11-06')",
  );
  assert.equal(client.status().products.state, "not-tested");
  const result = await client.syncProducts();
  assert.equal(result.count, 1);
  assert.equal(result.cached, false);
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    [
      "/OAPI/V2/Zone",
      "/OAPI/V2/OAPILogin",
      "/OAPI/V2/InventoryBasic/GetBasicProductsList",
    ],
  );
  assert.equal(calls[1].url.hostname, "oapiaa.ecount.com");
  assert.equal(calls[1].body.API_CERT_KEY, env.ECOUNT_API_CERT_KEY);
  assert.deepEqual(calls[2].body, {});
  assert.equal(
    calls[2].url.searchParams.get("SESSION_ID"),
    "example-session-not-real",
  );
  assert.equal(store.one("SELECT COUNT(*) n FROM catalog_products").n, 2);
  const rows = searchCatalog(store, "products", "P-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, product.PROD_DES);
  assert.equal(rows[0].unitPrice, 15000);
  assert.equal(searchCatalog(store, "products", "이전 엑셀").length, 0);
  assert.equal(client.status().products.lastReadAt, result.updatedAt);
  const visible =
    JSON.stringify(client.status()) +
    JSON.stringify(
      store.all("SELECT value FROM settings WHERE key LIKE 'ecount-%'"),
    );
  for (const secret of [
    env.ECOUNT_API_CERT_KEY,
    env.ECOUNT_USER_ID,
    env.ECOUNT_COM_CODE,
    "example-session-not-real",
  ])
    assert.equal(visible.includes(secret), false);
});
test("목록 재요청은 원래 조회시각을 유지하고 재시작해도 10분 제한을 지킨다", async (t) => {
  const { client, calls, store, deps, advance } = await fixture(t);
  const [a, b] = await Promise.all([
    client.syncProducts(),
    client.syncProducts(),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);
  advance(30000);
  const cached = await client.syncProducts();
  assert.equal(cached.cached, true);
  assert.equal(cached.updatedAt, a.updatedAt);
  assert.equal(calls.length, 3);
  const restarted = new EcountReadClient(store, deps);
  assert.equal((await restarted.syncProducts()).cached, true);
  assert.equal(calls.length, 3);
  advance(600000);
  assert.equal((await restarted.syncProducts()).cached, false);
  assert.equal(calls.length, 6);
  await restarted.close();
});
test("품목코드 직접 조회는 새 데이터를 받고 다른 코드·빈 코드·동시 반복 호출을 거부한다", async (t) => {
  const { client, calls, state, advance } = await fixture(t);
  await client.syncProducts();
  state.single = {
    Result: JSON.stringify([{ ...product, PROD_DES: "변경된 품목" }]),
  };
  assert.equal(
    (await client.lookupProduct("P-1")).items[0].name,
    "변경된 품목",
  );
  assert.equal(
    calls.at(-1)?.url.pathname,
    "/OAPI/V2/InventoryBasic/ViewBasicProduct",
  );
  assert.deepEqual(calls.at(-1)?.body, { PROD_CD: "P-1" });
  await assert.rejects(
    client.lookupProduct("P-1"),
    (e: any) => e.status === 429,
  );
  await assert.rejects(client.lookupProduct(""), (e: any) => e.status === 400);
  advance(1100);
  state.single = { Result: product };
  await assert.rejects(
    client.lookupProduct("P-2"),
    (e: any) => e.code === "CODE_MISMATCH",
  );
});
test("잘못된 응답·일부 결과·API 오류는 이전 목록을 지우지 않고 실패로 표시한다", async (t) => {
  const { client, store, state, advance } = await fixture(t);
  await client.syncProducts();
  for (const data of [
    { Result: [{ PROD_CD: "P-2" }] },
    { Result: [product], TotalCount: 2 },
    { Unexpected: [product] },
  ]) {
    advance(600000);
    state.list = data;
    await assert.rejects(client.syncProducts(), EcountReadError);
    assert.equal(
      store.one(
        "SELECT COUNT(*) n FROM catalog_products WHERE source='ecount-api'",
      ).n,
      1,
    );
    assert.equal(client.status().products.state, "last-read-failed");
  }
  advance(600000);
  state.listResponse = Response.json({
    Status: 500,
    Error: { Message: env.ECOUNT_API_CERT_KEY + "example-session-not-real" },
  });
  await assert.rejects(
    client.syncProducts(),
    (e: any) =>
      e.code === "API_REJECTED" && !e.message.includes(env.ECOUNT_API_CERT_KEY),
  );
  assert.equal(
    JSON.stringify(client.status()).includes(env.ECOUNT_API_CERT_KEY),
    false,
  );
});
test("운영/테스트 Zone을 구분하고 외부 응답의 호스트 주소를 신뢰하지 않는다", async (t) => {
  const { client, calls } = await fixture(t, { ECOUNT_ENV: "sandbox" });
  await client.syncProducts();
  assert.equal(calls[0].url.hostname, "sboapi.ecount.com");
  assert.equal(calls[1].url.hostname, "sboapiaa.ecount.com");
  assert.equal(calls[2].url.hostname, "sboapiaa.ecount.com");
});
test("Zone 주입·리다이렉트·인증 실패는 키와 원문 오류를 노출하지 않는다", async (t) => {
  const { client, state, calls, advance } = await fixture(t);
  state.zone = "evil.example/";
  await assert.rejects(client.syncProducts(), (e: any) => e.code === "ZONE");
  assert.equal(calls.length, 1);
  advance(10000);
  state.zone = "AA";
  state.loginResponse = new Response(env.ECOUNT_API_CERT_KEY, { status: 401 });
  await assert.rejects(
    client.syncProducts(),
    (e: any) =>
      e.status === 422 && !e.message.includes(env.ECOUNT_API_CERT_KEY),
  );
  advance(10000);
  state.loginResponse = new Response("redirect", {
    status: 302,
    headers: { Location: "https://untrusted.example" },
  });
  await assert.rejects(client.syncProducts(), (e: any) => e.status === 502);
  assert.ok(calls.every((c) => c.url.hostname.endsWith(".ecount.com")));
});
test("API 제한과 큰 응답을 처리하고 실패한 목록을 캐시 성공으로 돌려주지 않는다", async (t) => {
  const { client, state, advance } = await fixture(t);
  state.listResponse = new Response("rate", { status: 429 });
  await assert.rejects(
    client.syncProducts(),
    (e: any) => e.status === 429 && e.retryAfter === 600,
  );
  await assert.rejects(
    client.syncProducts(),
    (e: any) => e.code === "LIST_COOLDOWN",
  );
  advance(600000);
  state.listResponse = new Response("x".repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(
    client.syncProducts(),
    (e: any) => e.code === "TOO_LARGE",
  );
});
test("API 계정 변경은 이전 계정 목록을 지우고 기존 세션·스냅샷을 재사용하지 않는다", async (t) => {
  const { client, store, deps, calls, advance } = await fixture(t);
  await client.syncProducts();
  advance(600000);
  const other = new EcountReadClient(store, {
    ...deps,
    env: { ...deps.env, ECOUNT_COM_CODE: "another-example-company" },
  });
  assert.equal(other.status().products.state, "not-tested");
  assert.equal(
    store.one(
      "SELECT COUNT(*) n FROM catalog_products WHERE source='ecount-api'",
    ).n,
    0,
  );
  await other.syncProducts();
  assert.equal(calls.length, 6);
  assert.equal(calls[3].body.COM_CODE, "another-example-company");
  await other.close();
});
test("판매 엑셀의 품목코드는 엑셀 구자료 대신 API 조회 자료로 연결한다", async (t) => {
  const { client, store } = await fixture(t);
  store.run(
    "INSERT INTO catalog_products VALUES('excel','P-1','이전 엑셀 품목','',100,'ecount','2026-11-06')",
  );
  await client.syncProducts();
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("자료");
  sheet.addRow(["일자-No.", "거래처명", "주소", "품목코드", "수량"]);
  sheet.addRow([
    "2026/11/06-1",
    "예시 거래처",
    "대전광역시 가상로 1",
    "P-1",
    2,
  ]);
  const parsed = await parseSalesExport(
    store,
    Buffer.from(await book.xlsx.writeBuffer()),
    "sales.xlsx",
  );
  assert.equal(parsed.drafts[0].items[0].name, "예시 API 타이어 205/55R16");
});
test("관리자만 품목 조회를 실행하며 거래처·판매 조회 미지원은 외부 호출 없이 명시한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ecount-api-")),
    fake = provider(),
    runtime = createDispatchApp({
      dataDir: dir,
      roadRouting: false,
      test: true,
      ecount: { env, fetcher: fake.fetcher },
    });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = `http://127.0.0.1:${(runtime.server.address() as any).port}`;
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (path: string, token = "", body?: any) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (
    await call("/api/setup", "", { name: "예시 관리자", pin: "724816" })
  ).data.token;
  const driver = runtime.store.createUser(
      "driver",
      "예시 기사",
      "892745",
      "",
      15,
    ),
    driverToken = runtime.store.login("892745")!.token;
  for (const token of ["", driverToken]) {
    assert.ok(
      [401, 403].includes((await call("/api/erp/status", token)).status),
    );
    assert.ok(
      [401, 403].includes(
        (await call("/api/erp/products/sync", token, {})).status,
      ),
    );
    assert.ok(
      [401, 403].includes(
        (await call("/api/erp/products/lookup?code=P-1", token)).status,
      ),
    );
  }
  assert.equal((await call("/api/erp/live/customers", admin)).status, 501);
  assert.equal((await call("/api/erp/live/sales", admin)).status, 501);
  assert.equal(fake.calls.length, 0);
  const status = (await call("/api/erp/status", admin)).data;
  assert.equal(status.direct.configured, true);
  assert.equal(status.direct.sales.supported, false);
  assert.equal((await call("/api/erp/products/sync", admin, {})).status, 200);
  assert.equal(
    (await call("/api/erp/products/lookup?code=P-1", admin)).data.items[0].code,
    "P-1",
  );
  assert.ok(
    fake.calls.every(
      (c) => !/(Save|Delete|Update|Sale|AccountBasic)/i.test(c.url.pathname),
    ),
  );
});
