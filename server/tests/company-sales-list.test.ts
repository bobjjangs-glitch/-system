import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../database.ts";
import { CompanyErpClient } from "../companyErp.ts";
import { CompanySalesList } from "../companySalesList.ts";
import { normalizeSalesDocument } from "../salesDocuments.ts";
import { invoiceProduct, invoiceCustomer } from "../../src/invoiceCatalog.ts";
import { changeInvoiceNumber, invoiceTotals } from "../../src/invoiceMath.ts";
const date = "2026-11-06",
  instance = "b".repeat(32),
  party = {
    name: "가상 정비점",
    address: "대전광역시 가상로 15",
    phone: "010-0000-0000",
    businessNumber: "000-00-00000",
    representative: "가상 대표",
  };
const raw = (id = "1", status = "confirmed") => ({
  id,
  reference: `20261106-${id}`,
  saleDate: date,
  status,
  channel: "wholesale",
  paymentMethod: "credit",
  customerName: "가상 고객",
  vehicleNo: "가상 차량",
  customerCode: "C1",
  recipient: party.name,
  address: party.address,
  phone: party.phone,
  notes: "전표 적요",
  cancelReason: "",
  supplier: { ...party, name: "가상 공급자" },
  buyer: party,
  supplyAmount: "490909",
  vatAmount: "49091",
  amount: "540000",
  items: [
    {
      id: "1",
      erpItemId: "1",
      code: "P1",
      name: "가상 타이어",
      specification: "205/55R16",
      pattern: "WT1R",
      quantity: "12.000",
      unitPrice: "40909",
      supplyAmount: "490909",
      totalAmount: "540000",
      factoryPrice: "78671",
      discountRate: "48.00",
      taxType: "taxable",
      remarks: "행사",
    },
  ],
});
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "sales-browse-"));
  await mkdir(join(dir, "uploads"));
  const store = new Store(dir);
  const state = {
    rows: [raw(), raw("2", "draft"), raw("3", "canceled")],
    schema: 2,
    scope: "all",
    invoiceVersion: 1,
    calls: 0,
  };
  const erp = new CompanyErpClient(store, {
    env: { COMPANY_ERP_TOKEN: "a".repeat(64) },
    fetcher: async (input, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      const u = new URL(String(input));
      assert.equal(u.searchParams.get("scope"), "all");
      state.calls++;
      return Response.json({
        schema: state.schema,
        ok: true,
        scope: state.scope,
        invoiceVersion: state.invoiceVersion,
        kind: "sales",
        instanceId: instance,
        snapshot: "c".repeat(64),
        total: state.rows.length,
        cursor: "0",
        nextCursor: null,
        readAt: new Date().toISOString(),
        date,
        excluded: { draft: 0, canceled: 0 },
        items: state.rows,
      });
    },
  });
  const lists = new CompanySalesList(store, erp, dir, () => {});
  t.after(async () => {
    await erp.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, erp, lists, state };
}
test("ERP 거래처 소매/도매에 맞는 단가와 금액을 자동 채우고 수동 수정한 금액은 거래처 변경으로 덮어쓰지 않는다", () => {
  const entry = {
    id: "p1",
    remoteId: "1",
    code: "P1",
    name: "가상 타이어",
    source: "company-erp-live",
    retailPrice: 15000,
    wholesalePrice: 10000,
    factoryPrice: 20000,
    unitPrice: 10000,
    taxType: "taxable" as const,
  };
  const retail = invoiceProduct({ name: "", quantity: 2 }, entry, "retail");
  assert.equal(retail.unitPrice, 15000);
  assert.equal(retail.totalAmount, 33000);
  assert.equal(retail.factoryPrice, 20000);
  const customer = {
    id: "c1",
    remoteId: "1",
    name: "가상 정비점",
    code: "C1",
    source: "company-erp-live",
    defaultChannel: "wholesale" as const,
  };
  const row = { recipient: "", address: "", items: [retail] };
  const changed = invoiceCustomer(row, customer);
  assert.equal(changed.items![0].unitPrice, 10000);
  assert.equal(changed.amount, 22000);
  const manual = changeInvoiceNumber(retail, "totalAmount", 12345);
  assert.equal(
    invoiceCustomer({ ...row, items: [manual] }, customer).items![0]
      .totalAmount,
    12345,
  );
  assert.equal(
    invoiceProduct(
      { name: "", quantity: 2 },
      { ...entry, wholesalePrice: 0 },
      "wholesale",
    ).totalAmount,
    0,
  );
});
test("명세서의 ERP 원본 단가·공급가액·합계·적요·공장도가를 재계산 없이 보존한다", () => {
  const doc = normalizeSalesDocument(
    raw(),
    "https://erp.test/dispatch_api.php",
    instance,
    date,
  );
  assert.equal(doc.items[0].unitPrice, 40909);
  assert.equal(doc.items[0].supplyAmount, 490909);
  assert.equal(doc.items[0].totalAmount, 540000);
  assert.equal(doc.items[0].factoryPrice, 78671);
  assert.equal(doc.items[0].remarks, "행사");
  assert.equal(doc.vatAmount, 49091);
  assert.equal(doc.buyer.name, party.name);
  assert.equal(doc.supplier.name, "가상 공급자");
  assert.ok(!JSON.stringify(doc).includes("cost_price"));
});
test("판매조회는 모든 상태를 목록에 남기고 조회만으로 배송지를 만들지 않는다", async (t) => {
  const f = await fixture(t),
    list = await f.lists.fetch(date, date);
  assert.equal(list.documents.length, 3);
  assert.equal(list.documents[1].status, "draft");
  assert.equal(list.documents[1].eligible, true);
  assert.equal(list.documents[2].eligible, false);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 0);
  assert.equal(f.lists.latest(date)?.id, list.id);
});
test("선택 전표만 원본 금액과 배송주소 보정으로 배차 대기에 넣고 재시도는 중복 등록하지 않는다", async (t) => {
  const f = await fixture(t),
    list = await f.lists.fetch(date, date),
    doc = list.documents[1];
  const result = await f.lists.dispatch(list.id, {
    sourceKeys: [doc.sourceKey],
    serviceDate: date,
    deliveryOverrides: {
      [doc.sourceKey]: {
        address: "대전광역시 가상로 20",
        phone: "010-0000-1111",
        notes: "배송 요청",
      },
    },
  });
  assert.equal(result.count, 1);
  const saved = f.store.one("SELECT * FROM shipments");
  assert.equal(saved.salesReference, doc.reference);
  assert.equal(saved.address, "대전광역시 가상로 20");
  assert.equal(JSON.parse(saved.items)[0].factoryPrice, 78671);
  assert.equal(JSON.parse(saved.items)[0].unitPrice, 40909);
  assert.equal(saved.amount, 540000);
  const before = f.state.calls;
  const retry = await f.lists.dispatch(list.id, {
    sourceKeys: [doc.sourceKey],
  });
  assert.equal(retry.count, 0);
  assert.equal(retry.alreadyRegistered, 1);
  assert.equal(f.state.calls, before);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 1);
  const statement = await f.lists.shipmentInvoice(saved.id);
  assert.equal(statement!.supplier.name, "가상 공급자");
  assert.equal(statement!.notes, "배송 요청");
  assert.equal(
    f.lists.get(list.id).documents.filter((d) => d.registered).length,
    1,
  );
});
test("선택 후 ERP 금액·상태가 변경되면 전표 일부도 저장하지 않고 재조회를 요구한다", async (t) => {
  const f = await fixture(t),
    list = await f.lists.fetch(date, date);
  f.state.rows[1].status = "canceled";
  await assert.rejects(
    f.lists.dispatch(list.id, {
      sourceKeys: list.documents.slice(0, 2).map((d) => d.sourceKey),
    }),
    (e: any) => e.status === 409,
  );
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 0);
});
test("취소·반품은 조회하되 배차하지 못하고 원본 외 번호·빈 배송주소도 거부한다", async (t) => {
  const f = await fixture(t);
  f.state.rows[0].address = "";
  f.state.rows[1].items[0].quantity = "-1";
  const list = await f.lists.fetch(date, date);
  assert.equal(list.documents[1].eligible, false);
  await assert.rejects(
    f.lists.dispatch(list.id, { sourceKeys: [list.documents[1].sourceKey] }),
  );
  await assert.rejects(
    f.lists.dispatch(list.id, { sourceKeys: ["foreign-key"] }),
  );
  await assert.rejects(
    f.lists.dispatch(list.id, { sourceKeys: [list.documents[0].sourceKey] }),
  );
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 0);
});
test("이전 연동 파일이 단가를 생략하거나 목록 기능이 없으면 빈 금액 대신 업데이트 오류를 안내한다", async (t) => {
  const f = await fixture(t);
  f.state.invoiceVersion = 0;
  await assert.rejects(f.lists.fetch(date, date), /최신 ERP 연동/);
  f.state.invoiceVersion = 1;
  delete (f.state.rows[0].items[0] as any).unitPrice;
  await assert.rejects(f.lists.fetch(date, date), /단가·금액/);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM imports").n, 0);
});
