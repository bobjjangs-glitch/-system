import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createDispatchApp } from "../app.ts";
import { today } from "../database.ts";
import { DEFAULT_COMPANY_ERP_URL } from "../companyErp.ts";
const date = "2026-11-06";
const row = (n: number) => ({id: String(129000 + n), reference: `26/11/06-${n}`, sourceReference: `20261106-${n}`,
  sourceSystem: "native-archive", saleDate: date, status: "imported", nativeVersionId: "1072", nativeRevision: "2",
  customerCode: "C00072", recipient: "가상 정비소", address: "대전광역시 동구 가상로 72", phone: "010-0000-0000",
  supplyAmount: 165000, vatAmount: 16500, amount: 181500,
  items: [{name: "가상 타이어", code: "P72", quantity: 3, unitPrice: 55000, supplyAmount: 165000, vatAmount: 16500,
    totalAmount: 181500, vatRate: 10, remarks: "원본 적요", factoryPrice: 330000, discountRate: 47.5}]});
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "automatic-sales-api-")), calls: URL[] = [];
  const state = {legacy: false, rows: Array.from({length: 20}, (_, i) => row(53 + i))};
  const runtime = createDispatchApp({dataDir: dir, test: true, autoGeocode: false, roadRouting: false,
    companyErp: {env: {COMPANY_ERP_TOKEN: "a".repeat(64)}, fetcher: async input => {
      const url = new URL(String(input)); calls.push(url); assert.equal(url.origin, new URL(DEFAULT_COMPANY_ERP_URL).origin);
      const scope = url.searchParams.get("scope"), requestedId = url.searchParams.get("documentId"), cursor = url.searchParams.get("cursor") ?? "0";
      const selected = scope === "invoice" ? state.rows.filter(r => r.id === requestedId) : state.rows;
      const items = scope === "capabilities" ? [] : selected.filter(r => BigInt(r.id) > BigInt(cursor));
      return Response.json({schema: 2, ok: true, kind: "sales", scope, invoiceVersion: scope === "all" ? 1 : 2,
        dateMode: "reference-or-date", sourceSystem: state.legacy ? undefined : "native-archive", legacyAvailable: false,
        bridgeVersion: state.legacy ? "1.12.0" : "1.13.0", salesTable: state.legacy ? "erp_trades" : "erp_ecount_documents",
        instanceId: "b".repeat(32), snapshot: "c".repeat(64), cursor, nextCursor: null,
        total: scope === "capabilities" ? 0 : selected.length, items, date: url.searchParams.get("date"),
        readAt: new Date().toISOString(), excluded: {draft: 0, canceled: 0}, matchedSales: 20, totalSales: 20});
    }}});
  runtime.store.createUser("admin", "가상 관리자", "631792"); runtime.store.createUser("driver", "가상 기사", "827493");
  const admin = runtime.store.login("631792")!.token, driver = runtime.store.login("827493")!.token;
  runtime.server.listen(0, "127.0.0.1"); await once(runtime.server, "listening");
  const base = "http://127.0.0.1:" + (runtime.server.address() as {port: number}).port;
  const call = async (path: string, body?: unknown, token: string | null = admin) => {
    const response = await fetch(base + path, {method: body === undefined ? "GET" : "POST",
      headers: {"Content-Type": "application/json", ...(token ? {Authorization: "Bearer " + token} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json() as any};
  };
  t.after(async () => {await runtime.close(); await rm(dir, {recursive: true, force: true});});
  return {runtime, call, calls, state, driver};
}
test("자동 판매조회 API는 관리자만 접근하며 한국 오늘 기본값·20건·실제 자체ERP출처를 반환하고 조회내역을 만들지 않는다", async t => {
  const {runtime, call, calls, driver, state} = await fixture(t);
  state.rows = state.rows.map((value, i) => ({...value, saleDate: today(), reference: today().replace(/-/g, "") + "-" + (53 + i), sourceReference: today().replace(/-/g, "") + "-" + (53 + i)}));
  assert.equal((await call("/api/company-erp/sales/preview", undefined, null)).status, 401);
  assert.equal((await call("/api/company-erp/sales/preview", undefined, driver)).status, 403); assert.equal(calls.length, 0);
  const status = await call("/api/erp/status"); assert.equal(status.data.company.provider, "company-erp");
  assert.equal(status.data.company.externalEcount, false); assert.equal(status.data.company.apiUrl, DEFAULT_COMPANY_ERP_URL);
  const result = await call("/api/company-erp/sales/preview"); assert.equal(result.status, 200);
  assert.equal(result.data.salesDate, today()); assert.equal(result.data.documents.length, 20); assert.equal(result.data.live, true);
  assert.equal(result.data.source.sourceSystem, "native-archive"); assert.equal(result.data.source.salesTable, "erp_ecount_documents");
  await call("/api/company-erp/sales/preview");
  assert.equal(runtime.store.one("SELECT COUNT(*) n FROM imports").n, 0); assert.equal(runtime.store.one("SELECT COUNT(*) n FROM shipments").n, 0);
  const before = calls.length; assert.equal((await call("/api/company-erp/sales/preview?salesDate=2026-02-30")).status, 400); assert.equal(calls.length, before);
});
test("구형 PHP 저장소 응답을 실제 0건으로 표시하지 않고 직접조회도 같은 연결 오류를 전달한다", async t => {
  const {call, state} = await fixture(t); state.legacy = true;
  const response = await call("/api/company-erp/sales/preview?salesDate=" + date); assert.equal(response.status, 502);
  assert.match(response.data.error, /원본 전표 연결|저장소/);
  const direct = await call("/api/company-erp/invoices?reference=20261106-72&expectedSource=native-archive");
  assert.equal(direct.status, 502); assert.match(direct.data.error, /원본 전표 연결|저장소/);
  assert.equal((await call("/api/company-erp/connection?date=" + date + "&expectedSource=native-archive")).status, 502);
});
test("선택된 원본ID를 상세와 확인 API로 전달해 해당 전표만 전체금액으로 한 번 등록한다", async t => {
  const {runtime, call, calls} = await fixture(t);
  const detail = await call("/api/company-erp/invoices?reference=20261106-72&sourceSystem=native-archive&documentId=129072");
  assert.equal(detail.status, 200); assert.equal(detail.data.document.sourceId, "129072");
  const payload = {reference: detail.data.document.reference, sourceSystem: "native-archive", documentId: "129072",
    fingerprint: detail.data.document.fingerprint, serviceDate: date};
  assert.equal((await call("/api/company-erp/sales/confirm-reference", payload)).status, 201);
  assert.equal((await call("/api/company-erp/sales/confirm-reference", payload)).status, 201);
  assert.equal(runtime.store.one("SELECT COUNT(*) n FROM shipments").n, 1);
  assert.equal(runtime.store.one("SELECT amount FROM shipments").amount, 181500);
  assert.ok(calls.some(url => url.searchParams.get("documentId") === "129072"));
});
