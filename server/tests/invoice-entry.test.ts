import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../database.ts";
import { CompanyErpClient } from "../companyErp.ts";
import { CompanySaleService } from "../companySale.ts";
import {
  calculateInvoiceLine,
  changeInvoiceNumber,
  invoiceTotals,
} from "../../src/invoiceMath.ts";
import { parseSalesReference } from "../../src/salesReference.ts";
import type { ShipmentInput, Item } from "../types.ts";
const date = "2026-11-06",
  inst = "b".repeat(32),
  token = "a".repeat(64);
const base: Item = {
  name: "가상 타이어",
  code: "P-1",
  erpItemId: "1",
  pattern: "WT1R",
  quantity: 12,
  unitPrice: 40909,
  listPrice: 78671,
  taxType: "taxable",
  amountBasis: "unit",
};
const row = (): ShipmentInput => ({
  recipient: "가상 정비점",
  address: "대전광역시 가상로 15",
  phone: "010-0000-0000",
  erpCustomerId: "1",
  customerCode: "C00001",
  items: [changeInvoiceNumber(base, "totalAmount", 540000)],
  notes: "검증",
});
test("20261106-48 번호를 날짜·순번으로 읽고 표의 합계 수동 입력을 원 단위로 보존한다", () => {
  assert.deepEqual(parseSalesReference("20261106-48"), {
    date,
    sequence: "48",
    canonical: "2026/11/06-48",
  });
  const line = changeInvoiceNumber(base, "totalAmount", 540000);
  assert.equal(line.supplyAmount, 490909);
  assert.equal(line.unitPrice, 40909);
  assert.equal(line.totalAmount, 540000);
  assert.equal(calculateInvoiceLine(line).totalAmount, 540000);
  assert.deepEqual(invoiceTotals([line]), {
    supply: 490909,
    vat: 49091,
    total: 540000,
    complete: true,
  });
});
test("단가·수량·DC율·면세 계산은 입력한 기준을 보존하며 빈 값은 0으로 만들지 않는다", () => {
  assert.equal(
    changeInvoiceNumber(
      { ...base, quantity: 2, listPrice: 10000 },
      "discountRate",
      25,
    ).unitPrice,
    7500,
  );
  assert.equal(
    changeInvoiceNumber(
      { ...base, quantity: 2, listPrice: null },
      "discountRate",
      25,
    ).unitPrice,
    null,
  );
  assert.equal(changeInvoiceNumber(base, "unitPrice", null).supplyAmount, null);
  assert.equal(
    calculateInvoiceLine({
      ...base,
      quantity: 1.5,
      unitPrice: 100,
      taxType: "exempt",
    }).totalAmount,
    150,
  );
  assert.equal(
    calculateInvoiceLine({ ...base, quantity: 1.0001 }).totalAmount,
    null,
  );
});
async function fixture(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "erp-sale-request-"));
  await mkdir(join(dir, "uploads"));
  const store = new Store(dir),
    records = new Map<string, any>();
  let calls = 0,
    writes = 0,
    drop = false,
    disabled = false;
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    assert.ok(u.pathname.endsWith("/dispatch_sale.php"));
    calls++;
    if (init?.method !== "POST")
      return Response.json({
        schema: 2,
        ok: true,
        instanceId: inst,
        serverDate: date,
        nextReference: "20261106-49",
        writeEnabled: !disabled,
      });
    const p = JSON.parse(String(init.body));
    if (disabled)
      return Response.json(
        { ok: false, code: "WRITE_DISABLED", safeToEdit: true },
        { status: 422 },
      );
    if (!records.has(p.requestId)) {
      writes++;
      records.set(p.requestId, {
        schema: 2,
        ok: true,
        instanceId: inst,
        requestId: p.requestId,
        sale: {
          ...p.row,
          id: String(writes),
          reference: `20261106-${48 + writes}`,
          saleDate: date,
          status: "draft",
          amount: invoiceTotals(p.row.items).total,
        },
      });
    }
    if (drop) {
      drop = false;
      throw new Error("simulated dropped reply");
    }
    return Response.json(records.get(p.requestId));
  };
  const erp = new CompanyErpClient(store, {
      env: { COMPANY_ERP_TOKEN: token },
      fetcher,
    }),
    service = new CompanySaleService(store, erp, dir, () => {});
  t.after(async () => {
    await service.close();
    await erp.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    store,
    service,
    records,
    get calls() {
      return calls;
    },
    get writes() {
      return writes;
    },
    drop: () => {
      drop = true;
    },
    disable: () => {
      disabled = true;
    },
    enable: () => {
      disabled = false;
    },
  };
}
test("ERP가 발급한 당일 번호로 판매·배송지를 한 번 저장하고 변경된 재사용 요청을 거부한다", async (t) => {
  const f = await fixture(t),
    op = f.service.create("admin");
  assert.equal((await f.service.context()).nextReference, "20261106-49");
  const [a, b] = await Promise.all([
    f.service.save(op.requestId, "admin", row()),
    f.service.save(op.requestId, "admin", row()),
  ]);
  assert.equal(a.salesReference, "20261106-49");
  assert.deepEqual(a, b);
  assert.equal(f.writes, 1);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 1);
  assert.equal(
    (await f.service.save(op.requestId, "admin", row())).salesReference,
    a.salesReference,
  );
  await assert.rejects(
    f.service.save(op.requestId, "admin", { ...row(), recipient: "다른 고객" }),
    (e: any) => e.status === 409,
  );
  const saved = f.store.shipment(f.store.one("SELECT * FROM shipments"));
  assert.equal(saved.items[0].pattern, "WT1R");
  assert.equal(saved.items[0].discountRate, undefined);
  assert.equal(saved.amount, 540000);
});
test("ERP 저장 직후 응답이 끊겨도 같은 요청을 다시 보내면 번호·전표·배송지를 중복 생성하지 않는다", async (t) => {
  const f = await fixture(t),
    op = f.service.create("admin");
  f.drop();
  await assert.rejects(f.service.save(op.requestId, "admin", row()));
  assert.equal(f.writes, 1);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 0);
  assert.equal(f.service.pending("admin").length, 1);
  const done = await f.service.save(op.requestId, "admin", row());
  assert.equal(done.salesReference, "20261106-49");
  assert.equal(f.writes, 1);
  assert.equal(f.store.one("SELECT COUNT(*) n FROM shipments").n, 1);
  assert.equal(f.service.pending("admin").length, 0);
});
test("ERP 성공 후 로컬 파일 저장 실패는 원격 결과를 보존하고 연결 재호출 없이 마무리한다", async (t) => {
  const f = await fixture(t),
    op = f.service.create("admin");
  await chmod(join(f.dir, "uploads"), 0);
  await assert.rejects(f.service.save(op.requestId, "admin", row()));
  await chmod(join(f.dir, "uploads"), 0o700);
  assert.equal(f.service.detail(op.requestId, "admin").status, "remote_saved");
  const before = f.calls;
  const done = await f.service.save(op.requestId, "admin", row());
  assert.equal(done.salesReference, "20261106-49");
  assert.equal(f.calls, before);
  assert.equal(f.writes, 1);
});
test("확실한 입력 거절은 편집을 허용하고 미승인 계정이나 잘못된 품목은 저장 전에 차단한다", async (t) => {
  const f = await fixture(t),
    op = f.service.create("admin");
  await assert.rejects(
    f.service.save(op.requestId, "other", row()),
    (e: any) => e.status === 404,
  );
  await assert.rejects(
    f.service.save(op.requestId, "admin", {
      ...row(),
      erpCustomerId: undefined,
    }),
    (e: any) => e.status === 400,
  );
  assert.equal(f.calls, 0);
  f.disable();
  await assert.rejects(f.service.save(op.requestId, "admin", row()));
  assert.equal(f.service.detail(op.requestId, "admin").status, "draft");
  f.enable();
  await f.service.save(op.requestId, "admin", row());
  assert.equal(f.writes, 1);
});
