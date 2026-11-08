import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../database.ts";
import { CompanyErpClient } from "../companyErp.ts";
import { CompanySalesList } from "../companySalesList.ts";
import { deleteAdminRecord } from "../adminDelete.ts";
import { parseSalesReference } from "../../src/salesReference.ts";

const date = "2026-11-06", serviceDate = "2026-11-09", token = "a".repeat(64), instance = "b".repeat(32);
const row = (sequence: number, unitPrice = 55000, revision = 2) => ({
  id: String(129000 + sequence), reference: `20261106-${sequence}`, sourceReference: `20261106-${sequence}`,
  saleDate: date, status: "imported", sourceSystem: "native-archive", nativeVersionId: "1049", nativeRevision: String(revision),
  nativeHeader: {
    partner_code: "TEST-CUSTOMER", partner_name: "가상 정비점", staff: "가상 담당자", warehouse: "대전 가상 창고",
    trade_type: "부가세율 적용", currency: "KRW", ceo: "가상 대표", phone: "010-0000-0000", business_no: "000-00-00000",
    account: "가상 계좌", receivable: "전잔 0 / 후잔 확인", delivery: "대전광역시 동구 가상로 72", note: `수정본 ${revision}`,
  },
  editUrl: `native_trade_edit.php?id=${129000 + sequence}`,
  statementUrl: `native_document.php?id=${129000 + sequence}&version=1049&print=statement`,
  customerCode: "TEST-CUSTOMER", recipient: "가상 정비점", address: "대전광역시 동구 가상로 72", phone: "010-0000-0000", notes: `수정본 ${revision}`,
  supplier: {name: "가상 공급회사"}, buyer: {name: "가상 정비점"},
  supplyAmount: unitPrice * 3, vatAmount: unitPrice * 3 / 10, amount: unitPrice * 3 + unitPrice * 3 / 10,
  items: [{name: "가상 타이어", code: "TEST-P1", quantity: 3, unitPrice, supplyAmount: unitPrice * 3, vatAmount: unitPrice * 3 / 10,
    vatRate: 10, totalAmount: unitPrice * 3 + unitPrice * 3 / 10, factoryPrice: 330000, discountRate: 47.5, discountRateRaw: "47.5%",
    specification: "235/45R18", pattern: "WT1R", brand: "가상 브랜드", dot: "DOT 2525", remarks: `품목 수정본 ${revision}`,
    nativeFields: {"전표 번호": `20261106-${sequence}`, "품목 추가 항목": `원본 값 ${revision}`}}],
});
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "auto-daily-sales-"));
  await mkdir(join(dir, "uploads"));
  const store = new Store(dir), calls: URL[] = [], changed: string[] = [];
  const state = {rows: Array.from({length: 20}, (_, i) => row(53 + i)), pageSize: 7, partial: false, upstream: false};
  const erp = new CompanyErpClient(store, {env: {COMPANY_ERP_TOKEN: token}, fetcher: async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).get("X-Dispatch-Token"), token);
    assert.equal(url.searchParams.get("kind"), "sales");
    if (state.upstream) return Response.json({ok: false, code: "NATIVE_HELPER_MISSING", error: "회사 ERP의 원본 조회 도우미를 확인해 주세요."}, {status: 502});
    const scope = url.searchParams.get("scope"), reference = url.searchParams.get("reference"), documentId = url.searchParams.get("documentId"), cursor = url.searchParams.get("cursor") ?? "0";
    const rows = scope === "invoice" ? state.rows.filter(r => documentId ? r.id === documentId : parseSalesReference(r.reference)?.canonical === parseSalesReference(reference)?.canonical)
      : state.rows.filter(r => r.saleDate === url.searchParams.get("date"));
    const eligible = rows.filter(r => BigInt(r.id) > BigInt(cursor)), items = eligible.slice(0, state.pageSize);
    return Response.json({schema: 2, ok: true, kind: "sales", scope, sourceSystem: "native-archive", legacyAvailable: false,
      dateMode: "reference-or-date", invoiceVersion: scope === "all" ? 1 : 2, instanceId: instance,
      snapshot: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), total: rows.length + (state.partial ? 1 : 0), cursor,
      nextCursor: eligible.length > items.length ? items.at(-1)!.id : null,
      readAt: "2026-11-06T03:00:00Z", date: url.searchParams.get("date"), excluded: {draft: 0, canceled: 0}, items});
  }});
  const lists = new CompanySalesList(store, erp, dir, d => changed.push(d));
  t.after(async () => {await erp.close(); store.close(); await rm(dir, {recursive: true, force: true});});
  return {dir, store, erp, lists, state, calls, changed};
}
const counts = (store: Store) => ["imports", "shipments", "erp_sales_links"].map(table => store.one(`SELECT COUNT(*) n FROM ${table}`).n);

test("자동 일자 조회는 ERP의 20개 판매전표를 모든 페이지에서 읽고 반복 조회에도 내역·배송 파일을 만들지 않는다", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const result = await f.lists.preview(date, serviceDate);
    assert.equal(result.live, true); assert.equal(result.historical, false);
    assert.equal(result.salesDate, date); assert.equal(result.serviceDate, serviceDate);
    assert.match(result.id, /^live:/); assert.equal(result.documents.length, 20);
    assert.equal(result.documents.at(-1)?.reference, "20261106-72");
    assert.ok(result.documents.every(d => d.eligible && !d.registered));
  }
  assert.deepEqual(f.calls.map(u => u.searchParams.get("cursor")), ["0", "129059", "129066", "0", "129059", "129066", "0", "129059", "129066"]);
  assert.deepEqual(counts(f.store), [0, 0, 0]); assert.deepEqual(await readdir(join(f.dir, "uploads")), []); assert.deepEqual(f.changed, []);
});

test("자동 조회는 다른 일자의 판매전표를 섞지 않고 정상 0건과 ERP 오류를 구분한다", async t => {
  const f = await fixture(t);
  const empty = await f.lists.preview("2026-11-07", serviceDate);
  assert.equal(empty.documents.length, 0); assert.equal(empty.salesDate, "2026-11-07");
  f.state.upstream = true;
  await assert.rejects(f.lists.preview(date, serviceDate), (e: any) => e.code === "NATIVE_HELPER_MISSING" && e.status === 502);
  assert.deepEqual(counts(f.store), [0, 0, 0]); assert.deepEqual(await readdir(join(f.dir, "uploads")), []);
});

test("자동 조회 목록의 전표72 선택은 최신 내용을 다시 읽고 확인 시 그 전표만 저장하며 재조회·재확인으로 중복 생성하지 않는다", async t => {
  const f = await fixture(t), initial = await f.lists.preview(date, serviceDate), stale = initial.documents.at(-1)!;
  f.state.rows[19] = row(72, 60000, 3);
  await assert.rejects(f.lists.confirmReference(stale.reference, stale.fingerprint, serviceDate, undefined, "native-archive"),
    (e: any) => e.code === "SALES_SELECTION" && /변경/.test(e.message));
  assert.deepEqual(counts(f.store), [0, 0, 0]);
  const latest = (await f.erp.invoice("20261106-72", "native-archive")).document;
  assert.equal(latest.nativeRevision, "3"); assert.equal(latest.items[0].unitPrice, 60000); assert.equal(latest.amount, 198000);
  assert.equal(latest.nativeHeader?.partner_name, "가상 정비점"); assert.equal(latest.items[0].nativeFields?.["품목 추가 항목"], "원본 값 3");
  const saved = await f.lists.confirmReference(latest.reference, latest.fingerprint, serviceDate, undefined, "native-archive");
  assert.equal(saved.count, 1); assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 1);
  const shipment = f.store.one("SELECT * FROM shipments");
  assert.equal(shipment.salesReference, "20261106-72"); assert.equal(shipment.erpSourceSystem, "native-archive");
  assert.equal(shipment.amount, 198000); assert.deepEqual(JSON.parse(shipment.items), latest.items);
  const snapshot = await f.lists.shipmentInvoice(shipment.id);
  assert.equal(snapshot?.nativeRevision, "3"); assert.deepEqual(snapshot?.nativeHeader, latest.nativeHeader); assert.deepEqual(snapshot?.items, latest.items);
  const before = counts(f.store), files = await readdir(join(f.dir, "uploads"));
  const reread = await f.lists.preview(date, serviceDate), seen = reread.documents.find(d => d.reference === "20261106-72")!;
  assert.equal(seen.registered, true); assert.equal(seen.eligible, false); assert.equal(reread.documents.length, 20);
  assert.deepEqual(counts(f.store), before); assert.deepEqual(await readdir(join(f.dir, "uploads")), files);
  const duplicate = await f.lists.confirmReference(latest.reference, latest.fingerprint, serviceDate, undefined, "native-archive");
  assert.equal(duplicate.count, 0); assert.equal(duplicate.alreadyRegistered, 1); assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 1);
});

test("자동 일자 조회에서 전표가 일부만 반환되면 빈 성공이나 부분 성공으로 저장하지 않는다", async t => {
  const f = await fixture(t); f.state.partial = true;
  await assert.rejects(f.lists.preview(date, serviceDate), (e: any) => e.code === "PARTIAL");
  assert.deepEqual(counts(f.store), [0, 0, 0]); assert.deepEqual(await readdir(join(f.dir, "uploads")), []); assert.deepEqual(f.changed, []);
});

test("자동 조회의 잘못된 날짜는 ERP 요청 전에 거부한다", async t => {
  const f = await fixture(t);
  await assert.rejects(f.lists.preview("2026-02-30", serviceDate), (e: any) => e.status === 400);
  await assert.rejects(f.lists.preview(date, "2026-02-30"), (e: any) => e.status === 400);
  assert.equal(f.calls.length, 0); assert.deepEqual(counts(f.store), [0, 0, 0]);
});

test("자동 조회는 기존 저장 목록을 대체하지 않으며 관리자의 저장 JSON 삭제 후에도 오늘 목록을 다시 읽을 수 있다", async t => {
  const f = await fixture(t), saved = await f.lists.fetch(date, serviceDate);
  const storedName = f.store.one("SELECT storedName FROM imports WHERE id=?", saved.id).storedName;
  assert.equal(f.lists.latest(date)?.id, saved.id); assert.equal(existsSync(join(f.dir, "uploads", storedName)), true);
  await f.lists.preview(date, serviceDate);
  assert.equal(f.lists.latest(date)?.id, saved.id); assert.deepEqual(counts(f.store), [1, 0, 0]);
  await deleteAdminRecord(f.store, f.dir, "imports", saved.id);
  assert.equal(f.lists.latest(date), null); assert.equal(existsSync(join(f.dir, "uploads", storedName)), false);
  assert.equal((await f.lists.preview(date, serviceDate)).documents.length, 20);
  assert.deepEqual(counts(f.store), [0, 0, 0]); assert.deepEqual(await readdir(join(f.dir, "uploads")), []);
});

test("자동 목록에서 같은 표시번호의 두 전표도 선택한 문서 ID로 상세 조회하고 정확한 원본 한 건만 등록한다", async t => {
  const f = await fixture(t);
  const second = row(72, 60000, 3);
  second.reference = "20261106-71";
  f.state.rows = [row(71), second];
  const live = await f.lists.preview(date, serviceDate), selected = live.documents[1];
  assert.equal(live.documents.length, 2); assert.equal(live.documents[0].reference, selected.reference);
  assert.notEqual(live.documents[0].sourceKey, selected.sourceKey);
  await assert.rejects(f.erp.invoice(selected.reference, "native-archive"), (e: any) => e.code === "INVOICE_AMBIGUOUS");
  const detail = await f.lists.reference(selected.reference, serviceDate, "native-archive", selected.sourceId);
  assert.equal(detail.documents.length, 1); assert.equal(detail.documents[0].sourceId, second.id); assert.equal(detail.documents[0].amount, 198000);
  const confirmed = await f.lists.confirmReference(selected.reference, selected.fingerprint, serviceDate, undefined, "native-archive", selected.sourceId);
  assert.equal(confirmed.count, 1);
  const shipment = f.store.one("SELECT * FROM shipments");
  assert.equal(shipment.erpSourceKey, selected.sourceKey); assert.equal(shipment.amount, 198000);
  assert.ok(f.calls.filter(u => u.searchParams.get("scope") === "invoice" && u.searchParams.has("documentId")).length >= 2);
});
