import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import ExcelJS from "exceljs";
import { Store, id } from "../database.ts";
import {
  importCatalog,
  parseSalesExport,
  searchCatalog,
} from "../erpCatalog.ts";
import { dispatchRevision, dropShipment } from "../dragDispatch.ts";
import { createDispatchApp } from "../app.ts";
const date = "2027-02-05",
  offline = { roadRouting: false };
const customerRows = [
  ["거래처코드", "거래처명", "주소", "전화번호"],
  ["C-101", "예시 정비점", "대전광역시 가상로 15", "010-0000-0011"],
];
const productRows = [
  ["품목코드", "품목명", "규격", "판매단가"],
  ["P-101", "테스트 타이어", "205/55R16", 10000],
];
async function workbook(rows: unknown[][], merged?: string[]) {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("자료");
  rows.forEach((row) => sheet.addRow(row));
  merged?.forEach((range) => sheet.mergeCells(range));
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-erp-")),
    store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const a = store.createUser("driver", "가 기사", "853129", "", 3),
    b = store.createUser("driver", "나 기사", "763812", "", 3);
  const shipment = (lat: number | null = 36.34) => {
    const sid = id();
    store.run(
      "INSERT INTO shipments(id,recipient,address,items,lat,lng,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      sid,
      "예시 " + sid,
      "대전광역시 가상로 15",
      JSON.stringify([{ name: "테스트 물품", quantity: 2 }]),
      lat,
      lat === null ? null : 127.43,
      date,
      new Date().toISOString(),
    );
    return sid;
  };
  return { store, a, b, shipment };
}
function snapshot(store: Store) {
  return JSON.stringify({
    stops: store.all("SELECT * FROM shipments ORDER BY id"),
    routes: store.all("SELECT * FROM routes ORDER BY id"),
    markers: store.all("SELECT * FROM settings ORDER BY key"),
  });
}
async function move(
  store: Store,
  shipmentId: string,
  targetDriverId: string | null,
  beforeShipmentId: string | null = null,
) {
  return dropShipment(
    store,
    {
      shipmentId,
      targetDriverId,
      beforeShipmentId,
      serviceDate: date,
      revision: dispatchRevision(store, date),
    },
    offline,
  );
}

test("거래처·품목 엑셀을 검색 자료로 가져와 코드·주소·규격을 검색하고 원화 단가만 보관한다", async (t) => {
  const { store } = await fixture(t);
  await importCatalog(
    store,
    await workbook(customerRows),
    "customers.xlsx",
    "customers",
  );
  await importCatalog(
    store,
    await workbook(productRows),
    "products.xlsx",
    "products",
  );
  await importCatalog(
    store,
    await workbook(customerRows),
    "customers.xlsx",
    "customers",
  );
  assert.equal(store.one("SELECT COUNT(*) AS n FROM catalog_customers").n, 1);
  assert.equal(
    searchCatalog(store, "customers", "C-101")[0].phone,
    "010-0000-0011",
  );
  assert.equal(
    searchCatalog(store, "customers", "가상로15")[0].name,
    "예시 정비점",
  );
  assert.equal(
    searchCatalog(store, "products", "205/55R16")[0].unitPrice,
    10000,
  );
  assert.equal(searchCatalog(store, "products", "%' OR 1=1 --").length, 0);
  assert.equal(searchCatalog(store, "products", "P-101")[0].code, "P-101");
  const invalid = await workbook([
    ["품목명", "단가", "통화"],
    ["외화 품목", 12, "USD"],
  ]);
  await assert.rejects(
    importCatalog(store, invalid, "products.xlsx", "products"),
    /원화/,
  );
  assert.equal(store.one("SELECT COUNT(*) AS n FROM catalog_products").n, 1);
});

test("판매조회 전표 여러 품목을 묶고 마스터의 거래처·품목·주소·전화·금액을 연결한다", async (t) => {
  const { store } = await fixture(t);
  await importCatalog(
    store,
    await workbook(customerRows),
    "customers.xlsx",
    "customers",
  );
  await importCatalog(
    store,
    await workbook(productRows),
    "products.xlsx",
    "products",
  );
  const file = await workbook([
    ["일자-No.", "거래처코드", "품목코드", "수량", "공급가액", "부가세"],
    ["2027/02/05-1", "C-101", "P-101", 2, 20000, 2000],
    ["2027/02/05-1", "C-101", "P-101", 1, 10000, 1000],
  ]);
  const { drafts, warnings } = await parseSalesExport(
    store,
    file,
    "sales.xlsx",
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].recipient, "예시 정비점");
  assert.equal(drafts[0].address, "대전광역시 가상로 15");
  assert.equal(drafts[0].phone, "010-0000-0011");
  assert.equal(drafts[0].items.length, 2);
  assert.equal(drafts[0].items[0].name, "테스트 타이어 205/55R16");
  assert.equal(drafts[0].amount, 33000);
  assert.equal(drafts[0].lat, null);
  assert.equal(warnings.length, 0);
});

test("병합된 전표 합계금액은 품목 행마다 중복 합산하지 않는다", async (t) => {
  const { store } = await fixture(t);
  const file = await workbook(
    [
      ["일자-No.", "거래처명", "품목명", "수량", "합계금액", "공급가액"],
      ["2027/02/05-2", "예시 거래처", "타이어 A", 2, 33000, 20000],
      ["2027/02/05-2", "예시 거래처", "타이어 B", 1, null, 10000],
    ],
    ["E2:E3"],
  );
  assert.equal(
    (await parseSalesExport(store, file, "sales.xlsx")).drafts[0].amount,
    33000,
  );
});

test("동일 코드의 배송지가 모호하면 임의의 주소를 채우지 않고 취소·반품을 제외한다", async (t) => {
  const { store } = await fixture(t);
  await importCatalog(
    store,
    await workbook([
      ...customerRows,
      ["C-101", "예시 정비점", "세종시 가상로 16", "010-0000-0022"],
    ]),
    "customers.xlsx",
    "customers",
  );
  const file = await workbook([
    ["전표번호", "거래처코드", "품목명", "수량", "금액", "상태"],
    ["1", "C-101", "타이어", 1, 10000, "정상"],
    ["2", "C-101", "타이어", -1, -10000, "반품"],
    ["3", "C-101", "타이어", 1, 10000, "취소"],
  ]);
  const result = await parseSalesExport(store, file, "sales.xlsx");
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].address, "");
  assert.ok(result.warnings.some((s) => s.includes("주소")));
  assert.ok(result.warnings.some((s) => s.includes("2행")));
});

test("잘못된 수량·금액·서로 다른 주소는 조용히 등록하지 않는다", async (t) => {
  const { store } = await fixture(t);
  for (const row of [
    ["1", "예시", "타이어", "오류", 10000],
    ["1", "예시", "타이어", 1, -1],
  ])
    await assert.rejects(
      parseSalesExport(
        store,
        await workbook([
          ["전표번호", "거래처명", "품목명", "수량", "금액"],
          row,
        ]),
        "sales.xlsx",
      ),
    );
  const file = await workbook([
    ["전표번호", "거래처명", "품목명", "수량", "주소"],
    ["1", "예시", "타이어", 1, "주소 A"],
    ["1", "예시", "타이어", 1, "주소 B"],
  ]);
  await assert.rejects(
    parseSalesExport(store, file, "sales.xlsx"),
    /주소가 다릅니다/,
  );
});

test("터치 배차는 선택한 삽입 위치를 보존하며 기사 간 이동·미배차 복귀·빈 코스 정리를 처리한다", async (t) => {
  const { store, a, b, shipment } = await fixture(t);
  const ids = [shipment(), shipment(), shipment()];
  await move(store, ids[0], a.id);
  await move(store, ids[1], a.id);
  await move(store, ids[2], a.id, ids[0]);
  let route = store.routes(date)[0];
  assert.deepEqual(
    route.stops.map((s) => s.id),
    [ids[2], ids[0], ids[1]],
  );
  await move(store, ids[1], a.id, ids[2]);
  route = store.routes(date)[0];
  assert.deepEqual(
    route.stops.map((s) => s.id),
    [ids[1], ids[2], ids[0]],
  );
  assert.ok(route.manualAssigned);
  assert.equal(route.geometry[0].lat, route.company.lat);
  assert.equal(route.geometry.at(-1)!.lng, route.company.lng);
  for (const p of route.planning!.stops)
    assert.equal(Date.parse(p.departureAt) - Date.parse(p.arrivalAt), 600000);
  await move(store, ids[1], b.id);
  assert.equal(
    store.routes(date).find((r) => r.driverId === a.id)!.stops.length,
    2,
  );
  const emptyRoute = store.routes(date).find((r) => r.driverId === b.id)!.id;
  await move(store, ids[1], null);
  assert.equal(
    store.one("SELECT * FROM routes WHERE id=?", emptyRoute),
    undefined,
  );
  assert.equal(
    store.one(
      "SELECT * FROM settings WHERE key=?",
      "manual-route:" + emptyRoute,
    ),
    undefined,
  );
  assert.equal(
    store.one("SELECT status FROM shipments WHERE id=?", ids[1]).status,
    "pending",
  );
  await move(store, ids[1], b.id);
  await move(store, ids[1], a.id);
  assert.equal(store.routes(date).length, 1);
  assert.equal(store.routes(date)[0].stops.length, 3);
});

test("최대 개수·비활성·운행 중·오래된 화면·잘못된 삽입 대상은 배차를 변경하지 않는다", async (t) => {
  const { store, a, b, shipment } = await fixture(t),
    first = shipment(),
    second = shipment();
  await move(store, first, a.id);
  const stale = dispatchRevision(store, date);
  store.run("UPDATE users SET capacity=1 WHERE id=?", a.id);
  let before = snapshot(store);
  await assert.rejects(move(store, second, a.id), /최대/);
  assert.equal(snapshot(store), before);
  await assert.rejects(
    dropShipment(
      store,
      {
        shipmentId: second,
        targetDriverId: b.id,
        serviceDate: date,
        revision: stale,
      },
      offline,
    ),
    /변경/,
  );
  await assert.rejects(move(store, second, b.id, "nonexistent"), /위치/);
  store.run("UPDATE users SET active=0 WHERE id=?", b.id);
  await assert.rejects(move(store, second, b.id), /활성/);
  store.run("UPDATE routes SET status='active' WHERE driverId=?", a.id);
  await assert.rejects(move(store, first, b.id), /운행/);
  await assert.rejects(move(store, second, a.id), /운행/);
});

test("경로 API 실패나 계산 중 편집 충돌 시 이동 전체를 취소하며 좌표 확인 갱신은 허용한다", async (t) => {
  const { store, a, b, shipment } = await fixture(t),
    first = shipment(),
    second = shipment(null);
  await move(store, first, a.id);
  let before = snapshot(store);
  await assert.rejects(
    dropShipment(
      store,
      {
        shipmentId: first,
        targetDriverId: b.id,
        serviceDate: date,
        revision: dispatchRevision(store, date),
      },
      {
        roadRouting: false,
        estimateRoute: async () => {
          throw new Error("provider failure");
        },
      },
    ),
  );
  assert.equal(snapshot(store), before);
  await assert.rejects(
    dropShipment(
      store,
      {
        shipmentId: second,
        targetDriverId: b.id,
        serviceDate: date,
        revision: dispatchRevision(store, date),
      },
      {
        roadRouting: false,
        geocode: async () => {
          store.run(
            "UPDATE shipments SET address='수정된 주소' WHERE id=?",
            second,
          );
          return { lat: 36.3, lng: 127.4 };
        },
      },
    ),
    /변경/,
  );
  assert.equal(
    store.one("SELECT status FROM shipments WHERE id=?", second).status,
    "pending",
  );
  const revision = dispatchRevision(store, date);
  store.run("UPDATE shipments SET lat=36.3,lng=127.4 WHERE id=?", second);
  assert.equal(dispatchRevision(store, date), revision);
  await move(store, second, b.id);
});

test("ERP API는 관리자만 허용하고 판매전표 저장·재가져오기 중복 방지·금액 보존·삭제를 처리한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-erp-api-")),
    runtime = createDispatchApp({
      dataDir: dir,
      roadRouting: false,
      test: true,
    });
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = "http://127.0.0.1:" + (runtime.server.address() as any).port;
  let token = "";
  const call = async (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  const upload = async (path: string, file: Buffer) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)]), "data.xlsx");
    form.append("serviceDate", date);
    return call(path, form);
  };
  token = (await call("/api/setup", { name: "테스트 관리자", pin: "954213" }))
    .data.token;
  const driver = (
    await call("/api/drivers", {
      name: "예시 기사",
      pin: "862913",
      capacity: 3,
    })
  ).data;
  assert.equal(
    (
      await upload(
        "/api/erp/catalog/customers/import",
        await workbook(customerRows),
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await upload(
        "/api/erp/catalog/products/import",
        await workbook(productRows),
      )
    ).status,
    201,
  );
  const file = await workbook([
    ["일자-No.", "거래처코드", "품목코드", "수량", "합계금액"],
    ["2027/02/05-8", "C-101", "P-101", 2, 22000],
  ]);
  const batch = (await upload("/api/erp/sales/import", file)).data;
  assert.equal(batch.drafts[0].amount, 22000);
  const other = (await upload("/api/erp/sales/import", file)).data;
  const forged = batch.drafts.map((s: any) => ({
    ...s,
    erpSourceKey: "ecount-sale-" + "0".repeat(64),
  }));
  assert.equal(
    (await call("/api/imports/" + batch.id + "/commit", { rows: forged }))
      .status,
    409,
  );
  assert.equal(
    (await call("/api/imports/" + batch.id + "/commit", { rows: batch.drafts }))
      .status,
    201,
  );
  assert.equal(
    (await call("/api/imports/" + other.id + "/commit", { rows: other.drafts }))
      .status,
    409,
  );
  assert.equal((await upload("/api/erp/sales/import", file)).status, 422);
  let dashboard = (await call("/api/dashboard?date=" + date)).data;
  const stop = dashboard.shipments[0];
  assert.equal(stop.amount, 22000);
  assert.equal(stop.items[0].code, "P-101");
  assert.equal(
    (
      await call(
        "/api/shipments/" + stop.id,
        { ...stop, amount: 25000 },
        "PATCH",
      )
    ).status,
    200,
  );
  runtime.store.run(
    "UPDATE shipments SET lat=36.32,lng=127.43 WHERE id=?",
    stop.id,
  );
  dashboard = (await call("/api/dashboard?date=" + date)).data;
  assert.equal(
    (
      await call("/api/dispatch/drop", {
        shipmentId: stop.id,
        targetDriverId: driver.id,
        serviceDate: date,
        revision: dashboard.dispatchRevision,
      })
    ).status,
    200,
  );
  const adminToken = token;
  token = (await call("/api/login", { pin: "862913" })).data.token;
  for (const path of [
    "/api/catalog/customers",
    "/api/catalog/products",
    "/api/erp/status",
    "/api/dashboard",
  ])
    assert.equal((await call(path)).status, 403);
  assert.equal((await upload("/api/erp/sales/import", file)).status, 403);
  assert.equal((await call("/api/dispatch/drop", {})).status, 403);
  const me = (await call("/api/me?date=" + date)).data;
  assert.equal(me.route.stops[0].amount, undefined);
  assert.equal(me.route.stops[0].erpSourceKey, undefined);
  assert.equal(me.route.stops[0].items[0].quantity, 2);
  token = adminToken;
  dashboard = (await call("/api/dashboard?date=" + date)).data;
  assert.equal(
    (
      await call("/api/dispatch/drop", {
        shipmentId: stop.id,
        targetDriverId: null,
        serviceDate: date,
        revision: dashboard.dispatchRevision,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/api/imports/" + batch.id, undefined, "DELETE")).status,
    200,
  );
  assert.equal((await upload("/api/erp/sales/import", file)).status, 201);
});

test("UTF-8·UTF-16LE·CP949 CSV를 읽고 갱신한 코드의 현재 주소만 검색한다", async (t) => {
  const { store } = await fixture(t);
  const text =
    "거래처코드,거래처명,주소,전화번호\r\nC-201,예시 정비점,대전광역시 가상로 21,010-0000-0021\r\n";
  const { createRequire } = await import("node:module"),
    iconv = createRequire(import.meta.url)("iconv-lite");
  for (const buffer of [
    Buffer.from("\uFEFF" + text),
    Buffer.from("\uFEFF" + text, "utf16le"),
    iconv.encode(text, "cp949"),
  ]) {
    await importCatalog(store, buffer, "customers.csv", "customers");
    assert.equal(
      searchCatalog(store, "customers", "C-201")[0].address,
      "대전광역시 가상로 21",
    );
  }
  await importCatalog(
    store,
    Buffer.from(text.replace("가상로 21", "가상로 22")),
    "customers.csv",
    "customers",
  );
  const entries = searchCatalog(store, "customers", "C-201");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].address, "대전광역시 가상로 22");
});
