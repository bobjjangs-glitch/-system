import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { Store, id, defaultCompany } from "../database.ts";
import { parseSalesExport, salesImportKeys } from "../erpCatalog.ts";
import {
  parseSalesReference,
  readSalesDate,
  validSalesDate,
} from "../../src/salesReference.ts";
import {
  deliveryRegion,
  deliveryRegionGroups,
} from "../../src/deliveryRegion.ts";
import { optimizeAssignments, planDispatch } from "../routing.ts";
import { createDispatchApp } from "../app.ts";
import type { Shipment, Driver } from "../types.ts";
const date = "2026-11-05";
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-sales-day-")),
    store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}
async function xlsx(rows: unknown[][]) {
  const book = new ExcelJS.Workbook();
  rows.forEach((row) =>
    (book.worksheets[0] ?? book.addWorksheet("판매조회")).addRow(row),
  );
  return Buffer.from(await book.xlsx.writeBuffer());
}
const header = [
  "판매번호",
  "거래처명",
  "배송주소",
  "연락처",
  "품목명",
  "수량",
  "합계금액",
];
const row = (ref: string, name = "예시 거래처", quantity: unknown = 1) => [
  ref,
  name,
  "대전광역시 동구 검증로 12",
  "010-0000-0001",
  "검증 물품",
  quantity,
  10000,
];

test("판매번호의 연·월·일과 전표 순번을 분리하고 존재하는 날짜만 허용한다", () => {
  for (const ref of [
    "26/11/05-47",
    "2026/11/05-47",
    "2026-11-05-00047",
    "26.11.5-47",
    "２０２６／１１／０５－４７",
    "20261105-47",
  ])
    assert.deepEqual(parseSalesReference(ref), {
      date,
      sequence: "47",
      canonical: "2026/11/05-47",
    });
  for (const ref of [
    "26/02/30-47",
    "26/13/05-47",
    "2026/11/05",
    "47",
    "파일 2행",
    "26/11/05-abc",
  ])
    assert.equal(parseSalesReference(ref), null);
  assert.equal(parseSalesReference("24/02/29-1")?.date, "2024-02-29");
  assert.equal(validSalesDate("2026-02-29"), false);
  assert.equal(readSalesDate("26/11/5"), date);
});

test("혼합 일자 판매조회에서 선택한 날짜만 가져오고 연도 표기가 달라도 동일 전표로 묶는다", async (t) => {
  const store = await fixture(t);
  const file = await xlsx([
    header,
    row("26/11/05-47"),
    row("2026/11/05-47"),
    row("26/11/05-48", "다른 예시 거래처"),
    row("26/11/04-9", "이전 일자", "잘못된 수량"),
    row("26/11/06-3", "다음 일자"),
    row("번호불명", "날짜 불명"),
  ]);
  const result = await parseSalesExport(store, file, "sales.xlsx", {
    salesDate: date,
  });
  assert.equal(result.drafts.length, 2);
  assert.equal(result.drafts[0].items.length, 2);
  assert.equal(result.drafts[0].amount, 20000);
  assert.equal(result.salesDate, date);
  assert.deepEqual(result.dateSummary, {
    matchedRows: 3,
    otherDateRows: 2,
    undatedRows: 1,
    duplicateDocuments: 0,
  });
  assert.ok(result.warnings.some((s) => s.includes("다른 일자 2행")));
  await assert.rejects(
    parseSalesExport(store, file, "sales.xlsx", { salesDate: "2026-11-07" }),
    /정상 판매내역이 없습니다/,
  );
  await assert.rejects(
    parseSalesExport(store, file, "sales.xlsx", { salesDate: "2026-02-30" }),
    /판매조회 일자/,
  );
});

test("판매일자와 순번이 별도 열이면 결합하고 날짜를 알 수 없는 전표를 임의 날짜로 넣지 않는다", async (t) => {
  const store = await fixture(t);
  const file = await xlsx([
    ["판매일자", "판매번호", "거래처명", "품목명", "수량"],
    ["2026/11/05", 47, "예시 거래처", "물품", 1],
    ["", "", "", "추가 물품", 2],
    ["2026/11/06", 48, "다음 거래처", "물품", 1],
  ]);
  const result = await parseSalesExport(store, file, "sales.xlsx", {
    salesDate: date,
  });
  assert.equal(result.drafts.length, 1);
  assert.equal(result.drafts[0].items.length, 2);
  assert.equal(result.drafts[0].salesReference, "2026/11/05-47");
  const conflict = await xlsx([
    ["판매일자", ...header],
    ["2026/11/06", ...row("26/11/05-47")],
  ]);
  await assert.rejects(
    parseSalesExport(store, conflict, "sales.xlsx", { salesDate: date }),
    /판매번호와 판매일자/,
  );
  const unknown = await xlsx([header, row("47")]);
  await assert.rejects(
    parseSalesExport(store, unknown, "sales.xlsx", { salesDate: date }),
    /일자 확인 불가 1행/,
  );
});

test("이전 버전에서 짧은 연도로 저장한 전표와 직접 입력한 전표도 다시 가져오지 않는다", async (t) => {
  const store = await fixture(t),
    draft = (
      await parseSalesExport(
        store,
        await xlsx([header, row("26/11/05-47")]),
        "sales.xlsx",
      )
    ).drafts[0];
  const oldKey =
    "ecount-sale-" +
    createHash("sha256")
      .update(JSON.stringify(["26/11/05-47", "예시 거래처"]))
      .digest("hex");
  store.run(
    "INSERT INTO imports(id,fileName,storedName,mime,drafts,serviceDate,createdAt,status) VALUES('old','old.xlsx','old.xlsx','application/octet-stream',?,?,?,'committed')",
    JSON.stringify([{ ...draft, erpSourceKey: oldKey }]),
    date,
    new Date().toISOString(),
  );
  store.run(
    "INSERT INTO erp_sales_links(sourceKey,importId) VALUES(?,'old')",
    oldKey,
  );
  assert.ok(salesImportKeys(draft).includes(oldKey));
  await assert.rejects(
    parseSalesExport(
      store,
      await xlsx([header, row("2026/11/05-47")]),
      "new.xlsx",
      { salesDate: date },
    ),
    /이미 등록/,
  );
  store.run(
    "INSERT INTO shipments(id,recipient,address,items,serviceDate,createdAt,salesReference) VALUES(?,?,?,?,?,?,?)",
    id(),
    "다른 예시 거래처",
    "대전 동구 검증로 12",
    "[]",
    date,
    new Date().toISOString(),
    "26/11/05-48",
  );
  await assert.rejects(
    parseSalesExport(
      store,
      await xlsx([header, row("2026/11/05-48", "다른 예시 거래처")]),
      "new.xlsx",
      { salesDate: date },
    ),
    /이미 등록/,
  );
});

test("주소의 구·시·군을 분류하고 동명이거나 주소가 불분명한 지역을 합치지 않는다", () => {
  assert.deepEqual(deliveryRegion("대전광역시 동구 검증로 12"), {
    key: "대전:동구",
    label: "대전 동구",
  });
  assert.equal(deliveryRegion("대전동구물류로 12").key, "대전:동구");
  assert.equal(
    deliveryRegion("32910 충청남도 논산시 검증로 12").key,
    "충남:논산시",
  );
  assert.equal(deliveryRegion("충남 서천군 서면 검증로 13").key, "충남:서천군");
  assert.equal(
    deliveryRegion("경기도 고양시 덕양구 검증로 1").key,
    "경기:고양시 덕양구",
  );
  assert.equal(deliveryRegion("세종특별자치시 검증로 2").key, "세종");
  assert.notEqual(
    deliveryRegion("대구 중구 검증로 1").key,
    deliveryRegion("서울 중구 검증로 1").key,
  );
  assert.equal(deliveryRegion("도로명만 있는 주소").key, "unknown");
  assert.equal(
    deliveryRegionGroups([
      { address: "대전 동구 검증로 1" },
      { address: "대전광역시 동구 검증로 2" },
      { address: "충남 논산시 검증로 3" },
    ]).length,
    2,
  );
});
const drivers = (caps: number[]): Driver[] =>
  caps.map((capacity, i) => ({
    id: "d" + i,
    name: "검증 기사 " + i,
    phone: "",
    active: true,
    capacity,
  }));
function shipments(counts: number[]): Shipment[] {
  return counts.flatMap((n, r) =>
    Array.from({ length: n }, (_, i) => ({
      id: r + "-" + i,
      recipient: "예시",
      address: [
        "대전 동구 검증로 1",
        "대전 서구 검증로 2",
        "충남 논산시 검증로 3",
        "충남 서천군 검증로 4",
      ][r],
      items: [{ name: "물품", quantity: 1 }],
      lat: 36.28 + r * 0.025 + Math.sin(i) * 0.02,
      lng: 127.4 + r * 0.02 + Math.cos(i) * 0.02,
      serviceDate: date,
      status: "pending",
      routeId: null,
      sequence: null,
      deliveredAt: null,
      failureReason: null,
      importId: null,
    })),
  );
}

test("지역 우선 배차는 다른 지역을 섞지 않고 가능한 물량 5곳 하한과 기사 한도를 보존한다", async () => {
  const stops = shipments([6, 7, 5]),
    team = drivers([10, 10, 10]);
  const routes = await planDispatch(defaultCompany, stops, team, {
    groupByRegion: true,
    roadRouting: false,
    trafficRequired: false,
    serviceDate: date,
  });
  assert.equal(routes.length, 3);
  for (const route of routes) {
    assert.equal(deliveryRegionGroups(route.stops).length, 1);
    assert.ok(
      route.stops.length >= 5 && route.stops.length <= route.driver.capacity,
    );
    assert.deepEqual(
      route.estimate.geometry[0],
      route.estimate.geometry.at(-1),
    );
    assert.equal(route.planning.stops.length, route.stops.length);
  }
  assert.equal(
    new Set(routes.flatMap((r) => r.stops.map((s) => s.id))).size,
    18,
  );
});

test("지역 물량이 기사 한도를 넘거나 지역보다 기사 수가 적어도 누락 없이 나눠 배차한다", () => {
  for (const [counts, caps] of [
    [
      [16, 7],
      [10, 10, 10],
    ],
    [
      [4, 4, 4, 4],
      [8, 8],
    ],
    [
      [1, 1],
      [1, 10, 10],
    ],
    [
      [6, 6, 6],
      [3, 8, 8],
    ],
  ]) {
    const stops = shipments(counts);
    const result = optimizeAssignments(defaultCompany, stops, drivers(caps), {
      groupByRegion: true,
    });
    assert.equal(
      new Set(result.flatMap((r) => r.stops.map((s) => s.id))).size,
      stops.length,
    );
    assert.equal(
      result.reduce((n, r) => n + r.stops.length, 0),
      stops.length,
    );
    for (const group of result)
      assert.ok(
        group.stops.length > 0 && group.stops.length <= group.driver.capacity,
      );
  }
});

test("날짜 필터 API가 저장·재조회되고 연도 표기만 바꾼 중복 등록과 기사 접근을 막는다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-date-api-")),
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
    const res = await fetch(base + path, {
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
    return { status: res.status, data: await res.json() };
  };
  token = (await call("/api/setup", { name: "검증 관리자", pin: "627194" }))
    .data.token;
  const status = await call("/api/erp/status");
  assert.equal(status.data.salesDateFilter, true);
  const upload = async (file: Buffer, salesDate = date) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(file)]), "sales.xlsx");
    form.append("serviceDate", "2026-11-06");
    form.append("salesDate", salesDate);
    return call("/api/erp/sales/import", form);
  };
  const file = await xlsx([
    header,
    row("26/11/05-47"),
    row("26/11/04-46"),
    row("26/11/06-48"),
  ]);
  const first = await upload(file);
  assert.equal(first.status, 201);
  assert.equal(first.data.serviceDate, "2026-11-06");
  assert.equal(first.data.salesDate, date);
  assert.equal(first.data.drafts.length, 1);
  const stored = await call("/api/imports/" + first.data.id);
  assert.ok(
    stored.data.recognitionWarnings.some((s: string) => s.includes(date)),
  );
  const alternate = await upload(await xlsx([header, row("2026/11/05-47")]));
  assert.equal(
    (
      await call("/api/imports/" + first.data.id + "/commit", {
        rows: first.data.drafts,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call("/api/imports/" + alternate.data.id + "/commit", {
        rows: alternate.data.drafts,
      })
    ).status,
    409,
  );
  assert.equal((await upload(file)).status, 422);
  assert.equal((await upload(file, "2026-02-30")).status, 422);
  const manual = await call("/api/shipments", {
    serviceDate: date,
    rows: [
      {
        recipient: "직접 입력",
        address: "대전 동구 검증로 1",
        items: [{ name: "물품", quantity: 1 }],
        salesReference: "26/11/05-49",
      },
    ],
  });
  assert.equal(manual.status, 201);
  const stop = (await call("/api/dashboard?date=" + date)).data.shipments[0];
  assert.equal(stop.salesReference, "26/11/05-49");
  assert.equal(
    (
      await call(
        "/api/shipments/" + stop.id,
        { ...stop, salesReference: "26/11/05-50" },
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/api/dashboard?date=" + date)).data.shipments[0]
      .salesReference,
    "26/11/05-50",
  );
});

test("판매일자만 있으면 서로 다른 전표를 한 건으로 추정해 합치지 않는다", async (t) => {
  const store = await fixture(t);
  const file = await xlsx([
    ["판매일자", "거래처명", "품목명", "수량"],
    ["2026/11/05", "예시 거래처", "물품 A", 1],
    ["2026/11/05", "예시 거래처", "물품 B", 2],
  ]);
  const result = await parseSalesExport(store, file, "sales.xlsx", {
    salesDate: date,
  });
  assert.equal(result.drafts.length, 2);
  assert.ok(result.warnings.some((s) => s.includes("전표번호 열이 없어")));
  const invalid = await xlsx([
    ["판매일자", ...header],
    ["2026/11/05", ...row("26/02/30-47")],
  ]);
  await assert.rejects(
    parseSalesExport(store, invalid, "sales.xlsx", { salesDate: date }),
    /일자 확인 불가 1행/,
  );
});
