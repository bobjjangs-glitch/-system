import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Store } from "../database.ts";
import { CompanyErpClient, CompanyErpError } from "../companyErp.ts";
const token = "a".repeat(64),
  date = "2026-11-06";
const customer = {
  id: "1",
  code: "C00001",
  name: "가상 정비점",
  address: "대전광역시 검증로 1",
  phone: "010-0000-0001",
};
const product = {
  id: "1",
  code: "P-1",
  name: "가상 타이어",
  specification: "205/55R16",
  unitPrice: "10000",
};
const sale = {
  id: "1",
  reference: "26/11/06-47",
  saleDate: date,
  status: "confirmed",
  customerCode: customer.code,
  recipient: customer.name,
  address: customer.address,
  phone: customer.phone,
  amount: "55000",
  notes: "검증",
  items: [
    {
      id: "1",
      code: product.code,
      name: product.name,
      specification: product.specification,
      quantity: "5.000",
    },
  ],
};
function provider() {
  const calls: { url: URL; method: string }[] = [],
    state = {
      customers: [customer],
      products: [product],
      sales: [sale],
      size: 500,
      response: null as Response | null,
      mutate: null as ((data: any) => any) | null,
    };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? "GET" });
    assert.equal(new Headers(init?.headers).get("X-Dispatch-Token"), token);
    assert.equal(init?.redirect, "error");
    const kind = url.searchParams.get("kind") as
        | "customers"
        | "products"
        | "sales",
      rows = state[kind],
      cursor = url.searchParams.get("cursor") ?? "0",
      selected = rows.filter((r) => BigInt(r.id) > BigInt(cursor)),
      size = Math.min(state.size, Number(url.searchParams.get("limit")));
    const items = selected.slice(0, size);
    const data = {
      schema: 1,
      ok: true,
      kind,
      instanceId: "b".repeat(32),
      snapshot: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
      total: rows.length,
      cursor,
      nextCursor: selected.length > size ? items.at(-1)!.id : null,
      readAt: "2026-11-06T00:00:00Z",
      date: kind === "sales" ? url.searchParams.get("date") : null,
      excluded: { draft: 0, canceled: 0 },
      items,
    };
    return (
      state.response ?? Response.json(state.mutate ? state.mutate(data) : data)
    );
  };
  return { state, calls, fetcher };
}
async function fixture(
  t: TestContext,
  env: Record<string, string | undefined> = { COMPANY_ERP_TOKEN: token },
) {
  const dir = await mkdtemp(join(tmpdir(), "company-erp-")),
    store = new Store(dir),
    fake = provider(),
    client = new CompanyErpClient(store, { env, fetcher: fake.fetcher });
  t.after(async () => {
    await client.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, client, ...fake };
}
test("회사 ERP 인증 누락·잘못된 URL은 외부 호출 없이 거부하고 URL 내 비밀값도 반환하지 않는다", async (t) => {
  const { client, calls } = await fixture(t, {});
  assert.equal(client.status().configured, false);
  await assert.rejects(client.sync("customers"), (e: any) => e.status === 503);
  assert.equal(calls.length, 0);
  const f = await fixture(t, {
    COMPANY_ERP_API_URL:
      "https://user:example-password@host.test/dispatch_api.php",
  });
  assert.equal(f.client.status().configured, false);
  assert.ok(!JSON.stringify(f.client.status()).includes("example-password"));
});
test("목록은 전 페이지를 검증한 뒤 저장하고 기존 엑셀 자료를 보존하며 매 클릭마다 새로 조회한다", async (t) => {
  const { client, store, state, calls } = await fixture(t);
  state.size = 1;
  state.customers = [
    customer,
    { ...customer, id: "2", code: "C00002", name: "가상 거래처2" },
  ];
  store.run(
    "INSERT INTO catalog_customers VALUES('old','OLD','기존 엑셀','','','ecount','2026-01-01')",
  );
  const [a, b] = await Promise.all([
    client.sync("customers"),
    client.sync("customers"),
  ]);
  assert.equal(a.count, 2);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 2);
  assert.equal(store.one("SELECT COUNT(*) n FROM catalog_customers").n, 3);
  state.customers[0] = { ...customer, address: "변경된 ERP 주소" };
  await client.sync("customers");
  assert.equal(calls.length, 4);
  assert.equal(
    store.one("SELECT address FROM catalog_customers WHERE code='C00001'")
      .address,
    "변경된 ERP 주소",
  );
  assert.ok(calls.every((c) => c.method === "GET"));
});
test("검색은 ERP의 최신 응답을 사용하고 인증 실패 시 저장 자료로 바꾸지 않는다", async (t) => {
  const { client, state, store } = await fixture(t);
  await client.sync("products");
  state.products = [{ ...product, name: "수정된 품목" }];
  let rows = await client.search("products", "P-1");
  assert.equal(rows[0].name, "수정된 품목");
  assert.equal(rows[0].source, "company-erp-live");
  assert.equal(rows[0].unitPrice, 10000);
  state.response = new Response("private upstream error " + token, {
    status: 401,
  });
  await assert.rejects(
    client.search("products", "P-1"),
    (e: any) => e.status === 422 && !e.message.includes(token),
  );
  assert.equal(
    store.one("SELECT name FROM catalog_products WHERE source='company-erp'")
      .name,
    product.name,
  );
  assert.ok(!JSON.stringify(client.status()).includes(token));
});
test("부분 응답·변경된 스냅샷·잘못된 페이지 순번은 원자적으로 거부하고 이전 목록을 보존한다", async (t) => {
  const { client, state, store } = await fixture(t);
  await client.sync("customers");
  state.mutate = (data) => ({ ...data, total: 2 });
  await assert.rejects(
    client.sync("customers"),
    (e: any) => e.code === "PARTIAL",
  );
  assert.equal(store.one("SELECT COUNT(*) n FROM catalog_customers").n, 1);
  state.customers = [customer, { ...customer, id: "2" }];
  state.size = 1;
  state.mutate = (data) =>
    data.cursor === "0" ? data : { ...data, instanceId: "c".repeat(32) };
  await assert.rejects(
    client.sync("customers"),
    (e: any) => e.code === "CHANGED",
  );
  assert.equal(store.one("SELECT COUNT(*) n FROM catalog_customers").n, 1);
  state.mutate = (data) => ({ ...data, nextCursor: "0" });
  await assert.rejects(client.sync("customers"), CompanyErpError);
});
test("HTML 로그인 화면·원문 API 오류·과대 응답은 안전한 안내로 처리한다", async (t) => {
  const { client, state } = await fixture(t);
  state.response = new Response("<html>login " + token + "</html>");
  await assert.rejects(
    client.sync("customers"),
    (e: any) => e.code === "LOGIN_PAGE" && !e.message.includes(token),
  );
  state.response = Response.json({ ok: false, error: token });
  await assert.rejects(
    client.sync("customers"),
    (e: any) => e.code === "FORMAT" && !e.message.includes(token),
  );
  state.response = new Response("x".repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(
    client.sync("customers"),
    (e: any) => e.code === "TOO_LARGE",
  );
});
test("선택 날짜 확정 판매를 배송 입력으로 매핑하고 ERP 전표 ID로 중복을 방지한다", async (t) => {
  const { client, state, store } = await fixture(t);
  state.sales = [
    {
      ...sale,
      items: [sale.items[0], { ...sale.items[0], id: "2", quantity: "2.000" }],
    },
  ];
  const result = await client.sales(date),
    d = result.drafts[0];
  assert.equal(d.items.length, 2);
  assert.equal(d.items[0].quantity, 5);
  assert.equal(d.items[0].name, "가상 타이어 205/55R16");
  assert.equal(d.amount, 55000);
  assert.equal(d.address, customer.address);
  assert.equal(d.customerCode, customer.code);
  assert.match(d.erpSourceKey!, /^company-sale-[a-f0-9]{64}$/);
  store.run(
    "INSERT INTO imports(id,fileName,storedName,mime,drafts,serviceDate,createdAt) VALUES('batch','x','x','application/json','[]',?,?)",
    date,
    new Date().toISOString(),
  );
  store.run("INSERT INTO erp_sales_links VALUES(?,'batch')", d.erpSourceKey);
  assert.equal((await client.sales(date)).drafts.length, 0);
});
test("작성중·다른 날짜·없는 수량을 정상 전표로 만들지 않고 반품 혼합 전표 전체를 제외한다", async (t) => {
  const { client, state } = await fixture(t);
  state.sales = [{ ...sale, status: "draft" }];
  await assert.rejects(client.sales(date), (e: any) => e.code === "DATE");
  state.sales = [{ ...sale, saleDate: "2026-11-05" }];
  await assert.rejects(client.sales(date), (e: any) => e.code === "DATE");
  state.sales = [{ ...sale, items: [{ ...sale.items[0], quantity: "" }] }];
  await assert.rejects(client.sales(date), (e: any) => e.code === "QUANTITY");
  state.sales = [
    {
      ...sale,
      items: [sale.items[0], { ...sale.items[0], id: "2", quantity: "-1" }],
    },
  ];
  const r = await client.sales(date);
  assert.equal(r.drafts.length, 0);
  assert.ok(r.recognitionWarnings.some((s) => s.includes("전표 전체")));
});
test("진행 중 조회를 종료하면 요청을 취소하고 DB 종료 전에 작업을 정리한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "company-erp-close-")),
    store = new Store(dir);
  let started: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const fetcher: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      started();
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
  const client = new CompanyErpClient(store, {
    env: { COMPANY_ERP_TOKEN: token },
    fetcher,
  });
  const task = client.sync("customers");
  const caught = assert.rejects(task, CompanyErpError);
  await ready;
  await client.close();
  await caught;
  await assert.rejects(
    client.sync("customers"),
    (e: any) => e.code === "CLOSED",
  );
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("ERP의 선택 코드·주소·연락처가 NULL이어도 수량이나 주소를 만들지 않고 확인을 요청한다", async (t) => {
  const { client, state } = await fixture(t);
  state.customers = [
    {
      ...customer,
      code: null as any,
      address: null as any,
      phone: null as any,
    },
  ];
  const rows = await client.search("customers", "");
  assert.equal(rows[0].code, "");
  assert.equal(rows[0].address, "");
  assert.equal(rows[0].phone, "");
  state.sales = [
    {
      ...sale,
      customerCode: null as any,
      address: null as any,
      phone: null as any,
    },
  ];
  const result = await client.sales(date);
  assert.equal(result.drafts[0].address, "");
  assert.equal(result.drafts[0].items[0].quantity, 5);
  assert.ok(result.recognitionWarnings.some((s) => s.includes("주소가 없는")));
});
