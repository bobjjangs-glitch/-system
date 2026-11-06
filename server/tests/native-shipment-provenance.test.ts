import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../database.ts";
import { CompanySalesList } from "../companySalesList.ts";
import type { CompanyErpClient } from "../companyErp.ts";
import { salesImportKeys, savedManualSale } from "../erpCatalog.ts";
import { normalizeSalesDocument } from "../salesDocuments.ts";
import { validateShipments } from "../imports.ts";
import { documentShipment, type SalesDocument } from "../../src/salesDocuments.ts";

const date = "2026-11-06", source = "https://erp.example.test/tire/erp/dispatch_api.php", instance = "b".repeat(32);
const raw = (native: boolean) => ({
  id: "129470", reference: "20261106-49", saleDate: date,
  status: native ? "imported" : "confirmed",
  ...(native ? { sourceSystem: "native-archive", sourceReference: "20261106-49", nativeVersionId: "22", nativeRevision: "1", nativeHeader: {} } : {}),
  customerCode: "TEST-CUSTOMER", recipient: "가상 거래처", address: "대전광역시 가상로 12", phone: "010-0000-0000", notes: "배송 요청",
  supplyAmount: native ? null : 1000, vatAmount: native ? null : 100, amount: 1100,
  items: [{ name: "가상 타이어", quantity: 1, unitPrice: native ? null : 1000, supplyAmount: native ? null : 1000, vatAmount: native ? null : 100,
    vatRate: native ? null : 10, totalAmount: 1100, ...(native ? { nativeFields: {} } : { taxType: "taxable" }) }],
});
const doc = (native: boolean) => normalizeSalesDocument(raw(native), source, instance, date);
async function fixture(t: TestContext, documents: SalesDocument[]) {
  const dir = await mkdtemp(join(tmpdir(), "native-shipment-"));
  await mkdir(join(dir, "uploads"));
  const store = new Store(dir), erp = {
    async browseSales() { return { documents, salesDate: date, sourceReadAt: "2026-11-06T00:00:00.000Z" }; },
  } as unknown as CompanyErpClient;
  const lists = new CompanySalesList(store, erp, dir, () => {});
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, lists };
}

for (const nativeFirst of [false, true]) {
  test(`동일 전표번호·거래처의 자체 ERP 보관 자료와 기존 전표를 각각 등록한다 (${nativeFirst ? "보관 자료" : "기존 전표"} 우선)`, async (t) => {
    const native = doc(true), legacy = doc(false), f = await fixture(t, [native, legacy]);
    const first = nativeFirst ? native : legacy, second = nativeFirst ? legacy : native;
    const list = await f.lists.fetch(date, date);
    assert.deepEqual(salesImportKeys(documentShipment(native)), [native.sourceKey]);
    assert.ok(salesImportKeys(documentShipment(legacy)).length > 1);
    assert.equal((await f.lists.dispatch(list.id, { sourceKeys: [first.sourceKey] })).count, 1);
    assert.equal(f.lists.get(list.id).documents.find(d => d.sourceKey === second.sourceKey)?.registered, false);
    assert.equal((await f.lists.dispatch(list.id, { sourceKeys: [second.sourceKey] })).count, 1);
    assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 2);
    const saved = f.store.all("SELECT * FROM shipments");
    assert.equal(saved.find(s => s.erpSourceKey === native.sourceKey)?.erpSourceSystem, "native-archive");
    assert.equal(saved.find(s => s.erpSourceKey === legacy.sourceKey)?.erpSourceSystem, "legacy");
    assert.equal((await f.lists.dispatch(list.id, { sourceKeys: [native.sourceKey] })).count, 0);
    assert.equal((await f.lists.dispatch(list.id, { sourceKeys: [native.sourceKey] })).alreadyRegistered, 1);
    assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 2);
  });
}

test("과거 수동 판매의 날짜·거래처 별칭은 기존 전표에만 적용하며 보관 자료를 숨기지 않는다", async (t) => {
  const f = await fixture(t, []), legacy = documentShipment(doc(false)), native = documentShipment(doc(true));
  f.store.run("INSERT INTO shipments(id,recipient,address,items,serviceDate,createdAt,salesReference,customerCode) VALUES(?,?,?,?,?,?,?,?)",
    "old-manual", legacy.recipient, legacy.address, "[]", date, "2026-11-06T00:00:00Z", "26/11/06-49", legacy.customerCode);
  assert.equal(savedManualSale(f.store, legacy), true);
  assert.equal(savedManualSale(f.store, native), false);
  f.store.run("UPDATE shipments SET erpSourceSystem='native-archive'");
  assert.equal(savedManualSale(f.store, legacy), false);
});

test("보관 전표의 긴 텍스트·알 수 없는 가격·원 미만 가격을 배차 저장에서도 그대로 보존한다", async (t) => {
  const row: any = raw(true);
  row.recipient = "가".repeat(500); row.customerCode = "코".repeat(500); row.customerName = "이".repeat(500);
  row.address = "대전 ".repeat(1800).trim(); row.phone = "0".repeat(500); row.notes = "메".repeat(8000);
  row.nativeHeader = { partner_name: row.recipient, note: row.notes, delivery: row.address };
  row.editUrl = "native_trade_edit.php?id=129470";
  row.statementUrl = "native_document.php?id=129470&version=22&print=statement";
  row.items[0] = { ...row.items[0], name: "품".repeat(4000), code: "코".repeat(4000), specification: "규".repeat(4000),
    pattern: "패".repeat(4000), brand: "브".repeat(4000), dot: "D".repeat(4000), remarks: "비".repeat(8000), discountRateRaw: "할".repeat(4000),
    unitPrice: 0.125, nativeFields: Object.fromEntries(Array.from({ length: 200 }, (_, i) => ["필드" + i, i === 0 ? "추".repeat(8000) : ""])) };
  const document = normalizeSalesDocument(row, source, instance, date), shipment = documentShipment(document);
  const [validated] = validateShipments([shipment]);
  assert.deepEqual(validated.items, shipment.items);
  assert.equal(validated.notes, shipment.notes); assert.equal(validated.address, shipment.address); assert.equal(validated.phone, shipment.phone);
  assert.equal(validated.customerCode, shipment.customerCode); assert.equal(validated.invoiceCustomerName, shipment.invoiceCustomerName);
  const f = await fixture(t, [document]), list = await f.lists.fetch(date, date);
  assert.equal((await f.lists.dispatch(list.id, {
    sourceKeys: [document.sourceKey],
    deliveryOverrides: { [document.sourceKey]: { address: shipment.address, phone: shipment.phone, notes: shipment.notes } },
  })).count, 1);
  const [saved] = f.store.shipments(date);
  assert.equal(saved.erpSourceSystem, "native-archive"); assert.deepEqual(saved.items, shipment.items);
  assert.equal(saved.notes, shipment.notes); assert.equal(saved.address, shipment.address); assert.equal(saved.phone, shipment.phone);
  const statement = await f.lists.shipmentInvoice(saved.id);
  assert.deepEqual(statement?.nativeHeader, document.nativeHeader); assert.deepEqual(statement?.items, document.items);
  assert.equal(statement?.editUrl, document.editUrl); assert.equal(statement?.statementUrl, document.statementUrl);
});

test("보관 자료 한도를 넘거나 출처가 없는 요청을 잘라서 저장하지 않으며 기존 입력 한도는 유지한다", () => {
  const native = documentShipment(doc(true));
  assert.throws(() => validateShipments([{ ...native, erpSourceKey: undefined }]));
  assert.throws(() => validateShipments([{ ...native, notes: "x".repeat(8001) }]));
  assert.throws(() => validateShipments([{ ...native, items: [{ ...native.items[0], remarks: "x".repeat(8001) }] }]));
  assert.throws(() => validateShipments([{ ...native, items: [{ ...native.items[0], nativeFields: { extra: "x".repeat(8001) } }] }]));
  assert.throws(() => validateShipments([{ ...native, items: [{ ...native.items[0], nativeFields: JSON.parse('{"__proto__":"x"}') }] }]));
  assert.throws(() => validateShipments([{ ...native, items: [{ ...native.items[0], nativeFields: Object.fromEntries(Array.from({ length: 201 }, (_, i) => ["f" + i, "x"])) }] }]));
  const legacy = documentShipment(doc(false));
  assert.throws(() => validateShipments([{ ...legacy, address: "x".repeat(501) }]));
  assert.equal(validateShipments([{ ...legacy, notes: "x".repeat(3000), items: [{ ...legacy.items[0], name: "x".repeat(500) }] }])[0].notes?.length, 2000);
  assert.equal(validateShipments([{ ...legacy, items: [{ ...legacy.items[0], name: "x".repeat(500) }] }])[0].items[0].name.length, 200);
});
