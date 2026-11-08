import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../database.ts";
import { CompanyErpClient } from "../companyErp.ts";
import { matchesSalesDocumentQuery } from "../../src/salesReference.ts";
import { readTime } from "../../src/erpTypes.ts";

const date = "2026-11-06", instance = "b".repeat(32), token = "a".repeat(64);
test("오늘 판매조회 시각도 단말 시간대와 무관하게 한국 날짜로 표시한다", () => {
  assert.match(readTime("2026-11-08T23:00:00Z"), /2026\.\s*11\.\s*9\./);
  assert.equal(readTime(null), "조회 기록 없음");
});
const native = (id = "129472", reference = "26/11/06-72") => ({
  id, reference, sourceReference: "20261106-72", sourceSystem: "native-archive",
  saleDate: date, status: "imported", nativeVersionId: "1072", nativeRevision: "3",
  recipient: "가상 정비소", customerCode: "C00072", address: "대전광역시 동구 시험로 72", phone: "010-0000-0072",
  amount: 181500, supplyAmount: 165000, vatAmount: 16500,
  items: [{name: "가상 타이어", code: "P0072", quantity: 3, unitPrice: 55000, supplyAmount: 165000,
    vatAmount: 16500, vatRate: 10, totalAmount: 181500, factoryPrice: 330000, discountRate: 47.5, remarks: "최신 수정본"}],
});
function page(url: URL, rows: unknown[] = [], extra: Record<string, unknown> = {}) {
  const scope = url.searchParams.get("scope");
  return Response.json({schema: 2, ok: true, kind: "sales", scope, invoiceVersion: scope === "all" ? 1 : 2,
    sourceSystem: "native-archive", bridgeVersion: "1.13.0", salesTable: "erp_ecount_documents",
    dateMode: "reference-or-date", instanceId: instance, snapshot: "c".repeat(64), total: rows.length,
    cursor: url.searchParams.get("cursor") ?? "0", nextCursor: null, items: rows,
    date: url.searchParams.get("date"), readAt: "2026-11-06T00:00:00Z", excluded: {draft: 0, canceled: 0},
    matchedSales: rows.length, totalSales: rows.length, legacyAvailable: false, ...extra});
}
async function fixture(t: TestContext, responder: (url: URL) => Response) {
  const dir = await mkdtemp(join(tmpdir(), "native-reference-")), store = new Store(dir), calls: URL[] = [];
  const client = new CompanyErpClient(store, {
    env: {COMPANY_ERP_TOKEN: token},
    fetcher: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(new Headers(init?.headers).get("X-Dispatch-Token"), token);
      return responder(url);
    },
  });
  t.after(async () => {await client.close(); store.close(); await rm(dir, {recursive: true, force: true});});
  return {client, calls};
}

test("자체 ERP 자동 조회는 구형 PHP의 다른 판매 저장소를 정상 0건으로 판정하지 않는다", async t => {
  const {client, calls} = await fixture(t, url => page(url, [], {
    sourceSystem: undefined, bridgeVersion: "1.12.0", salesTable: "erp_trades",
  }));
  await assert.rejects(client.verifyNativeConnection(date), (error: any) =>
    error.code === "NATIVE_SOURCE_REQUIRED" && error.status === 502);
  assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get("scope"), "capabilities");
  // Ordinary ERP support remains available to the separate legacy flow.
  assert.deepEqual((await client.browseSales(date)).documents, []);
});

test("자체 ERP 검증은 실제 원본 저장소·출처·최소 연동 버전을 모두 확인한다", async t => {
  for (const extra of [
    {sourceSystem: "legacy"},
    {salesTable: "erp_trades"},
    {salesTable: null},
    {bridgeVersion: "1.12.9"},
    {bridgeVersion: undefined},
  ]) {
    const {client} = await fixture(t, url => page(url, [], extra));
    await assert.rejects(client.verifyNativeConnection(date), (error: any) =>
      error.code === "NATIVE_SOURCE_REQUIRED" && error.status === 502, JSON.stringify(extra));
  }
});

test("최신 자체 ERP 원본 연결은 0건인 날도 연결 성공으로 구분한다", async t => {
  for (const bridgeVersion of ["1.13.0", "1.14.2", "2.0.0"]) {
    const {client, calls} = await fixture(t, url => page(url, [], {bridgeVersion}));
    await client.verifyNativeConnection(date);
    assert.equal(calls.length, 1); assert.equal(calls[0].searchParams.get("scope"), "capabilities");
  }
});

test("native 전표를 요청했는데 구형 일반 저장소가 응답하면 전표 없음으로 표시하지 않는다", async t => {
  const {client} = await fixture(t, url => page(url, [], {sourceSystem: undefined, salesTable: "erp_trades", bridgeVersion: "1.12.0"}));
  await assert.rejects(client.invoice("20261106-72", "native-archive"), (error: any) =>
    error.code === "NATIVE_SOURCE_REQUIRED" && error.status === 502);
});

test("응답이 native 저장소라고 주장해도 다른 출처의 전표 행은 그대로 채우지 않는다", async t => {
  for (const sourceSystem of ["native-archive", undefined] as const) {
    for (const rowSource of ["legacy", undefined]) {
      const row = {...native(), sourceSystem: rowSource, status: "draft",
        items: native().items.map(item => ({...item, taxType: "taxable"}))};
      const {client} = await fixture(t, url => page(url, [row]));
      await assert.rejects(client.invoice("20261106-72", sourceSystem), (error: any) =>
        error.code === "NATIVE_SOURCE_REQUIRED" && error.status === 502);
    }
  }
});

test("20261106-72 수동 조회는 ERP의 26/11/06-72 번호와 같은 전표로 읽는다", async t => {
  const {client, calls} = await fixture(t, url => page(url, [native()]));
  const result = await client.invoice("20261106-72", "native-archive");
  assert.equal(result.document.sourceId, "129472"); assert.equal(result.document.reference, "26/11/06-72");
  assert.equal(result.document.items[0].unitPrice, 55000); assert.equal(result.document.amount, 181500);
  assert.equal(calls[0].searchParams.get("reference"), "20261106-72");
});

test("선택한 원본 ID는 표시 번호가 달라져도 정확한 최신 전표를 채운다", async t => {
  const {client, calls} = await fixture(t, url => page(url, [{...native("129472", "26/11/06-75"), sourceReference: "20261106-75"}]));
  const result = await client.invoice("20261106-72", "native-archive", "129472");
  assert.equal(result.document.sourceId, "129472"); assert.equal(result.document.reference, "26/11/06-75");
  assert.equal(result.document.nativeRevision, "3"); assert.equal(result.document.items[0].remarks, "최신 수정본");
  assert.equal(calls[0].searchParams.get("documentId"), "129472");
  assert.equal(calls[0].searchParams.get("sourceSystem"), "native-archive");
});

test("같은 번호의 다른 원본 ID가 반환되면 선택한 전표로 오인하지 않는다", async t => {
  const {client} = await fixture(t, url => page(url, [native("129473")]));
  await assert.rejects(client.invoice("20261106-72", "native-archive", "129472"), (error: any) =>
    error.code === "INVOICE_MISMATCH" && error.status === 502);
});

test("원본 ID 조회는 native 출처와 정상 ID를 요구하며 잘못된 요청은 ERP로 보내지 않는다", async t => {
  const {client, calls} = await fixture(t, url => page(url, [native()]));
  for (const id of ["", "0", "-1", "1 OR 1=1", "129472&token=wrong", "1".repeat(16)])
    await assert.rejects(client.invoice("20261106-72", "native-archive", id), (error: any) => error.status === 400, id);
  await assert.rejects(client.invoice("20261106-72", "legacy", "129472"), (error: any) => error.status === 400);
  assert.equal(calls.length, 0);
});

test("ID를 지정하지 않은 수동 번호 조회가 여러 전표와 일치하면 임의 선택하지 않는다", async t => {
  const {client} = await fixture(t, url => page(url, [native("129472"), native("129473")]));
  await assert.rejects(client.invoice("20261106-72", "native-archive"), (error: any) =>
    error.code === "INVOICE_AMBIGUOUS" && error.status === 409);
});

test("판매목록 검색은 날짜·순번이 같은 compact·슬래시·SL 번호를 찾는다", () => {
  const doc = {reference: "26/11/06-72", sourceReference: "20261106-72", recipient: "가상 정비소", address: "대전 동구 시험로 72",
    phone: "010-0000-0072", items: [{name: "가상 타이어", code: "TY-P0072"}]};
  for (const query of ["20261106-72", "2026/11/06-72", "26/11/06-72", "SL-20261106-00072", "２０２６１１０６－７２", " 20261106 - 72 ", "가상 정비소", "시험로", "ty-p0072", "72", ""])
    assert.equal(matchesSalesDocumentQuery(doc, query), true, query);
  for (const query of ["20261107-72", "20261106-73", "다른 정비소", "TY-NONE"])
    assert.equal(matchesSalesDocumentQuery(doc, query), false, query);
});
