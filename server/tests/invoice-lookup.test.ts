import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../database.ts";
import { CompanyErpClient } from "../companyErp.ts";
import { CompanySalesList } from "../companySalesList.ts";
import { normalizeSalesDocument } from "../salesDocuments.ts";
import { searchCatalog } from "../erpCatalog.ts";
import {
  tireSizeQuery,
  matchesTireSize,
  productMatchesTireSize,
} from "../../src/tireSearch.ts";
const date = "2026-11-06",
  inst = "b".repeat(32),
  token = "a".repeat(64);
const doc = (reference = "20261106-49", saleDate = "2026-11-05") => ({
  id: "49",
  reference,
  saleDate,
  status: "draft",
  channel: "wholesale",
  customerName: "기존 ERP 고객",
  vehicleNo: "ERP차량",
  recipient: "가상 거래처",
  address: "대전광역시 가상로 49",
  phone: "010-0000-0000",
  supplyAmount: 10000,
  vatAmount: 1000,
  amount: 11000,
  supplier: { name: "가상 공급자" },
  buyer: { name: "가상 거래처" },
  items: [
    {
      name: "가상 타이어",
      code: "P49",
      erpItemId: "1",
      specification: "235/45R18",
      pattern: "WT1R",
      quantity: 1,
      unitPrice: 10000,
      supplyAmount: 10000,
      totalAmount: 11000,
      taxType: "taxable",
      remarks: "행사",
      factoryPrice: 20000,
      discountRate: 50,
    },
  ],
});
test("2354518·235/45r18·띄어쓰기 규격은 같은 타이어 크기이며 다른 인치·편평비·긴 숫자는 매칭하지 않는다", () => {
  const wanted = tireSizeQuery("2354518")!;
  for (const q of [
    "2354518",
    "235/45r18",
    "235 / 45 R18",
    "23545ZR18",
    "２３５／４５Ｒ１８",
  ])
    assert.deepEqual(tireSizeQuery(q), wanted);
  for (const text of ["타이어 235/45R18 98W", "235/45 R18", "2354518"])
    assert.equal(matchesTireSize(text, wanted), true, text);
  for (const text of ["235/45R19", "235/50R18", "1235/45R180", "235/45R180"])
    assert.equal(matchesTireSize(text, wanted), false, text);
  assert.equal(
    productMatchesTireSize("P2354518 타이어", "225/45R17", wanted),
    false,
  );
  assert.equal(tireSizeQuery("12NX1526225"), null);
});
test("저장 품목 검색도 7자리와 슬래시 규격에서 같은 정확한 결과를 반환한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tire-local-")),
    store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (const [i, name, spec] of [
    ["1", "정상 A", "235/45R18"],
    ["2", "정상 B", "235/45 R18"],
    ["3", "다른 인치", "235/45R19"],
    ["4", "P2354518 품번", "225/45R17"],
    ["5", "긴 숫자", "1235/45R180"],
  ])
    store.run(
      "INSERT INTO catalog_products VALUES(?,?,?,?,?,'ecount',?)",
      i,
      "P" + i,
      name,
      spec,
      10000,
      "2026-11-06",
    );
  const a = searchCatalog(store, "products", "2354518"),
    b = searchCatalog(store, "products", "235/45r18");
  assert.deepEqual(
    a.map((r) => r.id),
    ["1", "2"],
  );
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id),
  );
});
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "invoice-direct-"));
  await mkdir(join(dir, "uploads"));
  const store = new Store(dir);
  let clock = Date.parse("2026-11-06T05:00:00Z");
  const calls: URL[] = [];
  const state = {
    response: null as Response | null,
    missing: false,
    old: false,
    wrong: false,
  };
  const deps = {
    env: { COMPANY_ERP_TOKEN: token },
    now: () => clock,
    fetcher: async (input: any, init: any) => {
      const u = new URL(input);
      calls.push(u);
      assert.equal(new Headers(init.headers).get("X-Dispatch-Token"), token);
      if (state.response) return state.response;
      const scope = u.searchParams.get("scope"),
        rows =
          scope === "capabilities" || state.missing
            ? []
            : [doc(state.wrong ? "20261106-48" : "20261106-49")];
      return Response.json({
        schema: 2,
        ok: true,
        kind: "sales",
        scope: state.old ? "all" : scope,
        invoiceVersion: scope === "all" ? 1 : 2,
        dateMode: "reference-or-date",
        bridgeVersion: "1.11.0",
        matchedSales: 1,
        totalSales: 2,
        instanceId: inst,
        snapshot: "c".repeat(64),
        total: rows.length,
        cursor: "0",
        nextCursor: null,
        readAt: new Date(clock).toISOString(),
        date: u.searchParams.get("date"),
        excluded: { draft: 0, canceled: 0 },
        items: rows,
      });
    },
  };
  const client = new CompanyErpClient(store, deps);
  t.after(async () => {
    await client.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    client,
    deps,
    state,
    calls,
    tick: () => {
      clock += 1000;
    },
  };
}
test("전표번호 직접 조회는 날짜와 독립된 요청으로 전체 명세서를 가져오고 ERP 원본 판매일자를 보존한다", async (t) => {
  const f = await fixture(t),
    r = await f.client.invoice("20261106-49");
  assert.equal(f.calls[0].searchParams.get("scope"), "invoice");
  assert.equal(f.calls[0].searchParams.get("reference"), "20261106-49");
  assert.equal(r.document.reference, "20261106-49");
  assert.equal(r.document.saleDate, "2026-11-05");
  assert.equal(r.document.referenceDate, "2026-11-06");
  assert.equal(r.document.items[0].unitPrice, 10000);
  assert.equal(r.document.items[0].factoryPrice, 20000);
  assert.equal(r.document.supplyAmount, 10000);
  assert.equal(r.document.vatAmount, 1000);
  assert.equal(r.document.amount, 11000);
  assert.equal(r.document.items[0].remarks, "행사");
});
test("날짜별 목록은 판매일자 또는 전표번호 날짜가 일치하면 보존하고 양쪽 모두 다른 전표는 거부한다", () => {
  const d = normalizeSalesDocument(
    doc(),
    "https://erp.test/dispatch_api.php",
    inst,
    date,
  );
  assert.equal(d.saleDate, "2026-11-05");
  assert.equal(d.referenceDate, date);
  assert.throws(() =>
    normalizeSalesDocument(
      doc("20261104-49", "2026-11-05"),
      "https://erp.test/dispatch_api.php",
      inst,
      date,
    ),
  );
  const noDate = normalizeSalesDocument(
    { ...doc(), saleDate: null },
    "https://erp.test/dispatch_api.php",
    inst,
    date,
  );
  assert.equal(noDate.saleDate, date);
  assert.equal(noDate.saleDateInferred, true);
});
test("전표번호 직접 조회 실패·이전 연동 버전·다른 전표 반환은 빈 성공 목록으로 표시하지 않는다", async (t) => {
  const f = await fixture(t);
  f.state.missing = true;
  await assert.rejects(
    f.client.invoice("20261106-49"),
    (e: any) => e.code === "INVOICE_NOT_FOUND" && e.status === 404,
  );
  f.state.missing = false;
  f.state.old = true;
  await assert.rejects(
    f.client.invoice("20261106-49"),
    (e: any) => e.code === "INVOICE_VERSION",
  );
  f.state.old = false;
  f.state.wrong = true;
  await assert.rejects(
    f.client.invoice("20261106-49"),
    (e: any) => e.code === "INVOICE_MISMATCH",
  );
});
test("HTML 401 호스팅 차단과 JSON 연결키 거절을 구분하고 판매조회 실패 기록을 재시작 후에도 보존한다", async (t) => {
  const f = await fixture(t);
  await f.client.invoice("20261106-49");
  f.tick();
  f.state.response = new Response("<html>blocked private upstream</html>", {
    status: 401,
    headers: { "Content-Type": "text/html" },
  });
  await assert.rejects(
    f.client.browseSales(date),
    (e: any) =>
      e.code === "HOST_ACCESS_DENIED" &&
      e.status === 422 &&
      !e.message.includes("private"),
  );
  const restarted = new CompanyErpClient(f.store, f.deps);
  assert.equal(restarted.status().reads.sales?.count, 1);
  assert.equal(restarted.status().failures.sales?.code, "HOST_ACCESS_DENIED");
  assert.equal(restarted.status().state, "last-read-failed");
  await restarted.close();
  f.state.response = Response.json({ ok: false }, { status: 401 });
  await assert.rejects(
    f.client.browseSales(date),
    (e: any) => e.code === "AUTHORIZATION",
  );
});
test("성공한 판매조회 일자·건수는 클라이언트 재생성 뒤에도 조회 기록 없음으로 돌아가지 않는다", async (t) => {
  const f = await fixture(t);
  await f.client.browseSales(date);
  const restarted = new CompanyErpClient(f.store, f.deps);
  assert.equal(restarted.status().reads.sales?.count, 1);
  assert.equal(restarted.status().reads.sales?.date, date);
  await restarted.close();
});
test("번호로 고른 명세서 하나만 배차 목록을 만들며 조회 자체는 배송지·재고를 만들지 않는다", async (t) => {
  const f = await fixture(t),
    service = new CompanySalesList(f.store, f.client, f.dir, () => {}),
    list = await service.reference("20261106-49", date);
  assert.equal(list.documents.length, 1);
  assert.equal(list.documents[0].reference, "20261106-49");
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 0);
  const r = await service.dispatch(list.id, {
    sourceKeys: [list.documents[0].sourceKey],
  });
  assert.equal(r.count, 1);
  assert.equal(
    f.store.one("SELECT salesReference FROM shipments").salesReference,
    "20261106-49",
  );
});
test("규격 검색의 ERP 요청도 구분자 있는 표준값으로 통일하고 잘못된 다른 규격은 반환하지 않는다", async (t) => {
  const f = await fixture(t);
  const row = (id: string, specification: string) => ({
    id,
    code: "P" + id,
    name: "타이어",
    specification,
    unitPrice: 10000,
  });
  const requests: string[] = [];
  const client = new CompanyErpClient(f.store, {
    env: { COMPANY_ERP_TOKEN: token },
    fetcher: async (input) => {
      const u = new URL(String(input));
      requests.push(u.searchParams.get("q")!);
      return Response.json({
        schema: 1,
        ok: true,
        kind: "products",
        instanceId: inst,
        snapshot: "c".repeat(64),
        total: 3,
        cursor: "0",
        nextCursor: null,
        readAt: new Date().toISOString(),
        items: [
          row("1", "235/45R18"),
          row("2", "235/45 R18"),
          row("3", "235/45R19"),
        ],
      });
    },
  });
  const a = await client.search("products", "2354518"),
    b = await client.search("products", "235/45r18");
  assert.deepEqual(requests, ["235/45R18", "235/45R18"]);
  assert.deepEqual(
    a.map((r) => r.code),
    ["P1", "P2"],
  );
  assert.deepEqual(
    a.map((r) => r.id),
    b.map((r) => r.id),
  );
  await client.close();
});
