import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../database.ts";
import { CompanyErpClient } from "../companyErp.ts";
import { invoiceProduct, invoiceCustomer } from "../../src/invoiceCatalog.ts";
const date = "2026-11-06", instance = "b".repeat(32), token = "a".repeat(64);
const native = {
  id: "129470", sourceSystem: "native-archive", reference: "26/11/06-49", sourceReference: "20261105-48",
  saleDate: date, status: "imported", nativeVersionId: "1049", nativeRevision: "2",
  recipient: "가상 정비소", address: "대전광역시 시험로 1", amount: 11000, supplyAmount: 10000, vatAmount: 1000,
  items: [{name: "가상 타이어", quantity: 1, unitPrice: 10000, supplyAmount: 10000, vatAmount: 1000, vatRate: 10, totalAmount: 11000}],
};
const legacy = {...native, id: "1", sourceSystem: undefined, status: "confirmed", items: [{...native.items[0], taxType: "taxable"}]};
async function fixture(t: TestContext, fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), "native-client-")), store = new Store(dir);
  const client = new CompanyErpClient(store, {env: {COMPANY_ERP_TOKEN: token}, fetcher});
  t.after(async () => {await client.close(); store.close(); await rm(dir, {recursive: true, force: true});});
  return client;
}
function page(url: URL, rows: any[], extra: object = {}) {
  const scope = url.searchParams.get("scope");
  return Response.json({schema: 2, ok: true, kind: "sales", scope, invoiceVersion: scope === "all" ? 1 : 2,
    dateMode: "reference-or-date", date: url.searchParams.get("date"), instanceId: instance, snapshot: "c".repeat(64),
    cursor: "0", nextCursor: null, total: rows.length, items: rows, readAt: "2026-11-06T00:00:00Z",
    excluded: {draft: 0, canceled: 0}, ...extra});
}
test("날짜 조회는 보관 전표와 일반 전표를 병합하고 같은 표시 번호도 별도 원본으로 조회한다", async t => {
  const calls: URL[] = [];
  const client = await fixture(t, async input => {
    const url = new URL(String(input)); calls.push(url);
    return url.searchParams.get("sourceSystem") === "legacy"
      ? page(url, [legacy]) : page(url, [native], {sourceSystem: "native-archive", legacyAvailable: true});
  });
  const list = await client.browseSales(date);
  assert.equal(list.documents.length, 2); assert.notEqual(list.documents[0].sourceKey, list.documents[1].sourceKey);
  assert.equal((await client.invoice(native.reference, "native-archive")).document.sourceId, "129470");
  assert.equal((await client.invoice(native.reference, "legacy")).document.sourceId, "1");
  assert.equal((await client.invoice(native.sourceReference, "native-archive")).document.sourceId, "129470");
  assert.ok(calls.some(u => u.searchParams.get("sourceSystem") === "legacy"));
});
test("두 저장소를 읽는 사이 ERP 인스턴스가 바뀌면 혼합 목록을 표시하지 않는다", async t => {
  const client = await fixture(t, async input => {
    const url = new URL(String(input));
    return url.searchParams.get("sourceSystem") === "legacy" ? page(url, [legacy], {instanceId: "d".repeat(32)})
      : page(url, [native], {sourceSystem: "native-archive", legacyAvailable: true});
  });
  await assert.rejects(client.browseSales(date), (e: any) => e.code === "CHANGED" && e.status === 409);
});
test("원본 도우미 설치 오류는 빈 판매목록이나 일반 통신 오류로 바꾸지 않는다", async t => {
  const client = await fixture(t, async () => Response.json({ok: false, code: "NATIVE_HELPER_MISSING", error: "회사 ERP의 원본 조회 도우미를 확인해 주세요."}, {status: 502}));
  await assert.rejects(client.browseSales(date), (e: any) => e.code === "NATIVE_HELPER_MISSING" && /원본 조회 도우미/.test(e.message));
});
test("네이티브 목록의 미확인 세금과 참고가격은 자동단가로 추정하지 않는다", async t => {
  const client = await fixture(t, async input => {
    const url = new URL(String(input));
    return Response.json({schema: 2, ok: true, kind: "products", instanceId: instance, snapshot: "c".repeat(64), cursor: "0", nextCursor: null,
      readAt: "2026-11-06T00:00:00Z", total: 1, items: [{id: "1", code: "P1", name: "가상 타이어", catalogSource: "native-master", taxType: null,
        priceBasis: "catalog-reference", unitPrice: null, retailPrice: null, wholesalePrice: null, referenceRetailPrice: 11000, referenceWholesalePrice: 9900}], date: null});
  });
  const result = await client.search("products", "가상");
  assert.equal(result[0].taxType, undefined); assert.equal(result[0].unitPrice, null);
  assert.equal(result[0].referenceRetailPrice, 11000);
  const selected = invoiceProduct({name: "이전 품목", quantity: 1, unitPrice: 1234, supplyAmount: 1234, totalAmount: 1357, retailPrice: 90000, wholesalePrice: 80000, priceOrigin: "erp"}, result[0]);
  assert.equal(selected.unitPrice, 1234); assert.equal(selected.retailPrice, null); assert.equal(selected.priceOrigin, "manual");
  const changed = invoiceCustomer({recipient: "가상", address: "대전", items: [selected]}, {id: "C1", code: "C1", name: "다른 거래처", source: "company-erp-live", defaultChannel: "retail"});
  assert.equal(changed.items![0].unitPrice, 1234); assert.equal(changed.items![0].totalAmount, 1357);
});
