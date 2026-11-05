import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { once } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDispatchApp } from "../app.ts";
import type { Point, Route, ShipmentInput } from "../types.ts";

const serviceDate = "2027-01-18";
const nextDate = "2027-01-19";
const examplePoint = { lat: 36.34, lng: 127.44 };

async function fixture(t: TestContext, autoGeocode = false) {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-address-api-"));
  const runtime = createDispatchApp({
    dataDir: directory,
    roadRouting: false,
    test: true,
    autoGeocode,
  });
  t.after(async () => {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const pins = [0, 1, 2].map((index) =>
    String(randomInt(10000000 + index * 20000000, 29999999 + index * 20000000)),
  );
  runtime.store.createUser("admin", "주소 검증 관리자", pins[0]);
  const driver = runtime.store.createUser(
    "driver",
    "개별 배정 기사",
    pins[1],
    "",
    10,
  );
  const other = runtime.store.createUser(
    "driver",
    "추천 배차 기사",
    pins[2],
    "",
    10,
  );
  const adminToken = runtime.store.login(pins[0])!.token;
  const driverToken = runtime.store.login(pins[1])!.token;
  const otherToken = runtime.store.login(pins[2])!.token;
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  // Client traffic uses the captured transport; provider requests are forbidden
  // unless a test explicitly supplies a synthetic response.
  const clientFetch = fetch;
  const provider = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("A test attempted an external address/routing request");
  });
  const api = async (
    path: string,
    method: string,
    body?: unknown,
    token: string | null = adminToken,
  ) => {
    const response = await clientFetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const template = () =>
    clientFetch(base + "/api/template", {
      headers: { Authorization: "Bearer " + adminToken },
    });
  const cache = (address: string, point: Point = examplePoint) => {
    runtime.store.run(
      "INSERT OR REPLACE INTO geocodes(address,lat,lng) VALUES(?,?,?)",
      address,
      point.lat,
      point.lng,
    );
  };
  let counter = 0;
  const save = async (
    address?: string,
    date = serviceDate,
    coordinates: Point | null = null,
  ) => {
    const recipient = "주소 검증 거래처 " + ++counter;
    const row: ShipmentInput = {
      recipient,
      address: address ?? `대전광역시 동구 검증로 ${counter}`,
      items: [{ name: "검증 타이어", quantity: counter }],
      ...(coordinates ?? {}),
    };
    const result = await api("/api/shipments", "POST", {
      serviceDate: date,
      rows: [row],
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return runtime.store.shipment(
      runtime.store.one("SELECT * FROM shipments WHERE recipient=?", recipient),
    );
  };
  const assign = (
    shipmentId: string,
    driverId = driver.id,
    token: string | null = adminToken,
  ) => api(`/api/shipments/${shipmentId}/assign`, "POST", { driverId }, token);
  return {
    template,
    directory,
    runtime,
    driver,
    other,
    adminToken,
    driverToken,
    otherToken,
    api,
    cache,
    save,
    assign,
    provider,
    clientFetch,
    base,
  };
}

function assertRoundTrip(route: Route) {
  assert.ok(route.geometry.length >= 3);
  for (const point of [route.geometry[0], route.geometry.at(-1)!]) {
    assert.equal(point.lat, route.company.lat);
    assert.equal(point.lng, route.company.lng);
  }
  assert.deepEqual(
    route.stops.map((stop) => stop.sequence),
    route.stops.map((_, index) => index + 1),
  );
  assert.equal(route.planning?.stops.length, route.stops.length);
  for (const stop of route.planning!.stops)
    assert.equal(
      Date.parse(stop.departureAt) - Date.parse(stop.arrivalAt),
      10 * 60_000,
    );
}

async function eventually(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      "background address lookup did not finish",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "주소만 등록한 배송지를 개별 배정하고 추천 배차 후에도 선택 기사와 코스를 유지한다",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const firstAddress = "대전광역시 동구 검증로 101";
    f.cache(firstAddress);
    const first = await f.save(firstAddress);
    assert.equal(first.lat, null);
    assert.equal((await f.assign(first.id, f.driver.id, null)).status, 401);
    assert.equal(
      (await f.assign(first.id, f.driver.id, f.driverToken)).status,
      403,
    );
    const assigned = await f.assign(first.id);
    assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
    const initial = assigned.data as Route;
    assert.equal(initial.driverId, f.driver.id);
    assert.equal(initial.manualAssigned, true);
    assert.deepEqual(
      initial.stops.map((stop) => stop.id),
      [first.id],
    );
    assert.equal(initial.stops[0].lat, examplePoint.lat);
    assertRoundTrip(initial);
    const retried = await f.assign(first.id);
    assert.equal(retried.status, 200);
    assert.deepEqual(
      retried.data,
      initial,
      "유실 응답 재시도는 기존 개별 코스를 반환하며 중복 생성하지 않는다",
    );
    const secondAddress = "대전광역시 중구 검증로 102";
    f.cache(secondAddress, { lat: 36.35, lng: 127.42 });
    const second = await f.save(secondAddress);
    const appended = await f.assign(second.id);
    assert.equal(appended.status, 200);
    assert.equal(appended.data.id, initial.id);
    assert.deepEqual(
      new Set(appended.data.stops.map((stop: { id: string }) => stop.id)),
      new Set([first.id, second.id]),
    );
    assertRoundTrip(appended.data);
    const before = JSON.stringify(appended.data);
    const automatic = [];
    for (let index = 0; index < 3; index++) {
      const address = `대전광역시 서구 검증로 ${110 + index}`;
      f.cache(address, { lat: 36.36 + index * 0.01, lng: 127.39 });
      automatic.push(await f.save(address));
    }
    const optimized = await f.api("/api/routes/optimize", "POST", {
      serviceDate,
      trafficRequired: false,
    });
    assert.equal(optimized.status, 200, JSON.stringify(optimized.data));
    const routes = optimized.data as Route[];
    assert.equal(
      JSON.stringify(routes.find((route) => route.id === initial.id)),
      before,
    );
    const otherRoutes = routes.filter((route) => route.id !== initial.id);
    assert.ok(otherRoutes.length > 0);
    assert.ok(otherRoutes.every((route) => route.driverId !== f.driver.id));
    assert.deepEqual(
      new Set(
        otherRoutes.flatMap((route) => route.stops.map((stop) => stop.id)),
      ),
      new Set(automatic.map((shipment) => shipment.id)),
    );
    assert.equal((await f.assign(first.id)).status, 200);
    assert.equal((await f.assign(first.id, f.other.id)).status, 409);
    assert.equal(f.provider.mock.callCount(), 0);
  },
);

test(
  "출발 전 배송지 삭제는 남은 왕복 코스를 계산하고 전표 원본·다른 코스와 진행 내역을 보존한다",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const importId = randomUUID();
    const storedName = "synthetic-original.txt";
    const original = Buffer.from("검증 전표 원본 보존");
    await writeFile(join(f.directory, "uploads", storedName), original);
    f.runtime.store.run(
      "INSERT INTO imports(id,fileName,storedName,mime,drafts,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?)",
      importId,
      "원본.txt",
      storedName,
      "text/plain",
      "[]",
      serviceDate,
      new Date().toISOString(),
    );
    const beforeImport = f.runtime.store.one(
      "SELECT * FROM imports WHERE id=?",
      importId,
    );
    const ids = [];
    let route: Route | undefined;
    for (let index = 0; index < 3; index++) {
      const address = `대전광역시 동구 삭제검증로 ${index + 1}`;
      f.cache(address, {
        lat: 36.31 + index * 0.015,
        lng: 127.43 + index * 0.01,
      });
      const shipment = await f.save(address);
      f.runtime.store.run(
        "UPDATE shipments SET importId=? WHERE id=?",
        importId,
        shipment.id,
      );
      ids.push(shipment.id);
      const response = await f.assign(shipment.id);
      assert.equal(response.status, 200);
      route = response.data;
    }
    const other = await f.save("대전광역시 동구 보존로 1", serviceDate, {
      lat: 36.39,
      lng: 127.49,
    });
    const otherRoute = (await f.assign(other.id, f.other.id)).data as Route;
    const otherBefore = JSON.stringify(otherRoute);
    const targetId = route!.stops[1].id;
    assert.equal(
      (await f.api(`/api/shipments/${targetId}`, "DELETE", undefined, null))
        .status,
      401,
    );
    assert.equal(
      (
        await f.api(
          `/api/shipments/${targetId}`,
          "DELETE",
          undefined,
          f.driverToken,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api(`/api/shipments/${targetId}`, "DELETE")).status,
      200,
    );
    assert.equal(
      f.runtime.store.one("SELECT id FROM shipments WHERE id=?", targetId),
      undefined,
    );
    const remaining = f.runtime.store
      .routes(serviceDate)
      .find((candidate) => candidate.id === route!.id)!;
    assert.deepEqual(
      new Set(remaining.stops.map((stop) => stop.id)),
      new Set(ids.filter((id) => id !== targetId)),
    );
    assertRoundTrip(remaining);
    assert.ok(remaining.durationMinutes < route!.durationMinutes);
    assert.equal(
      JSON.stringify(
        f.runtime.store
          .routes(serviceDate)
          .find((candidate) => candidate.id === otherRoute.id),
      ),
      otherBefore,
    );
    assert.deepEqual(
      f.runtime.store.one("SELECT * FROM imports WHERE id=?", importId),
      beforeImport,
    );
    assert.deepEqual(
      await readFile(join(f.directory, "uploads", storedName)),
      original,
    );
    for (const status of ["active", "returning", "completed"]) {
      f.runtime.store.run(
        "UPDATE routes SET status=? WHERE id=?",
        status,
        otherRoute.id,
      );
      f.runtime.store.run(
        "UPDATE shipments SET status=? WHERE id=?",
        status === "completed" ? "delivered" : "assigned",
        other.id,
      );
      const before = JSON.stringify(
        f.runtime.store.one("SELECT * FROM shipments WHERE id=?", other.id),
      );
      assert.equal(
        (await f.api(`/api/shipments/${other.id}`, "DELETE")).status,
        409,
      );
      assert.equal(
        JSON.stringify(
          f.runtime.store.one("SELECT * FROM shipments WHERE id=?", other.id),
        ),
        before,
      );
    }
    for (const stop of remaining.stops)
      assert.equal(
        (await f.api(`/api/shipments/${stop.id}`, "DELETE")).status,
        200,
      );
    assert.equal(
      f.runtime.store.one("SELECT id FROM routes WHERE id=?", route!.id),
      undefined,
    );
    assert.equal(
      f.runtime.store.one(
        "SELECT key FROM settings WHERE key=?",
        "manual-route:" + route!.id,
      ),
      undefined,
    );
    const pending = await f.save("대전광역시 동구 삭제대기로 1");
    assert.equal(
      (await f.api(`/api/shipments/${pending.id}`, "DELETE")).status,
      200,
    );
    assert.deepEqual(
      await readFile(join(f.directory, "uploads", storedName)),
      original,
    );
    assert.equal(f.provider.mock.callCount(), 0);
  },
);

test("주소 길찾기는 관리자와 해당 배송지 기사만 허용하며 좌표 없는 주소도 확인한다", async (t) => {
  const f = await fixture(t);
  const ownAddress = "대전광역시 동구 본인검증로 1";
  const otherAddress = "대전광역시 중구 타인검증로 2";
  const pendingAddress = "대전광역시 서구 미배차검증로 3";
  f.cache(ownAddress);
  f.cache(otherAddress, { lat: 36.37, lng: 127.45 });
  f.cache(pendingAddress, { lat: 36.39, lng: 127.4 });
  const own = await f.save(ownAddress);
  const other = await f.save(otherAddress);
  const pending = await f.save(pendingAddress);
  assert.equal((await f.assign(own.id)).status, 200);
  assert.equal((await f.assign(other.id, f.other.id)).status, 200);
  // Legacy saved courses may still have an address without its internal point.
  f.runtime.store.run(
    "UPDATE shipments SET lat=NULL,lng=NULL WHERE id IN (?,?)",
    own.id,
    other.id,
  );
  const resolve = (body: unknown, token: string | null = f.adminToken) =>
    f.api("/api/navigation/resolve", "POST", body, token);
  assert.equal((await resolve({ shipmentId: own.id }, null)).status, 401);
  assert.equal(
    (await resolve({ shipmentId: other.id }, f.driverToken)).status,
    403,
  );
  assert.equal(
    (await resolve({ shipmentId: pending.id }, f.driverToken)).status,
    403,
  );
  assert.equal(
    (await resolve({ address: otherAddress }, f.driverToken)).status,
    403,
  );
  const mine = await resolve(
    { shipmentId: own.id, address: otherAddress },
    f.driverToken,
  );
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data, examplePoint);
  const confirmed = await resolve({ shipmentId: pending.id });
  assert.equal(confirmed.status, 200);
  assert.equal(
    f.runtime.store.one("SELECT lat FROM shipments WHERE id=?", pending.id).lat,
    36.39,
  );
  assert.equal(
    f.runtime.store.one("SELECT lat FROM shipments WHERE id=?", other.id).lat,
    null,
  );
  assert.deepEqual((await resolve({ address: otherAddress })).data, {
    lat: 36.37,
    lng: 127.45,
  });
  assert.equal((await resolve({ shipmentId: randomUUID() })).status, 404);
  assert.equal((await resolve({ shipmentId: 42 })).status, 400);
  assert.equal(f.provider.mock.callCount(), 0);
});

test(
  "등록 주소 일괄 확인은 날짜·선택 배송지·25곳 제한을 지키고 실패 주소를 남긴다",
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const addressA = "대전광역시 동구 일괄검증로 1";
    const addressB = "대전광역시 동구 일괄검증로 2";
    const addressC = "대전광역시 동구 일괄검증로 3";
    for (const address of [addressA, addressB, addressC]) f.cache(address);
    const a = await f.save(addressA);
    const b = await f.save(addressB);
    const c = await f.save(addressC, nextDate);
    const invalid = await f.save("주소:");
    const lookup = (body: unknown, token: string | null = f.adminToken) =>
      f.api("/api/shipments/geocode", "POST", body, token);
    assert.equal((await lookup({ serviceDate }, null)).status, 401);
    assert.equal((await lookup({ serviceDate }, f.driverToken)).status, 403);
    assert.equal((await lookup({ serviceDate, shipmentIds: [] })).status, 400);
    assert.equal((await lookup({ serviceDate, shipmentIds: [1] })).status, 400);
    const selected = await lookup({ serviceDate, shipmentIds: [a.id, c.id] });
    assert.equal(selected.status, 200);
    assert.equal(selected.data.resolved, 1);
    assert.equal(
      f.runtime.store.one("SELECT lat FROM shipments WHERE id=?", b.id).lat,
      null,
    );
    assert.equal(
      f.runtime.store.one("SELECT lat FROM shipments WHERE id=?", c.id).lat,
      null,
    );
    const all = await lookup({ serviceDate });
    assert.equal(all.status, 200);
    assert.equal(all.data.resolved, 1);
    assert.deepEqual(
      all.data.unresolved.map((row: { id: string }) => row.id),
      [invalid.id],
    );
    assert.equal(all.data.remaining, 1);
    const boundedDate = "2027-01-20";
    for (let index = 0; index < 27; index++) {
      const address = `대전광역시 동구 제한검증로 ${index + 1}`;
      f.cache(address);
      await f.save(address, boundedDate);
    }
    const bounded = await lookup({ serviceDate: boundedDate });
    assert.equal(bounded.status, 200);
    assert.equal(bounded.data.resolved, 25);
    assert.equal(bounded.data.remaining, 2);
    assert.equal((await lookup({ serviceDate: boundedDate })).data.resolved, 2);
    assert.equal(f.provider.mock.callCount(), 0);
  },
);

test("회사 출발·복귀 주소는 좌표 입력 없이 저장하고 확인 실패나 운행 중 변경은 보존한다", async (t) => {
  const f = await fixture(t);
  const address = "대전광역시 동구 회사검증로 14";
  f.cache(address);
  const company = {
    name: "주소 검증 회사",
    address,
    serviceMinutes: 10,
    navigation: "naver",
  };
  assert.equal(
    (await f.api("/api/company", "PUT", company, f.driverToken)).status,
    403,
  );
  const saved = await f.api("/api/company", "PUT", company);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data, { ...company, ...examplePoint });
  const before = JSON.stringify(f.runtime.store.company());
  const invalid = await f.api("/api/company", "PUT", {
    ...company,
    address: "주소:",
  });
  assert.ok(invalid.status >= 400 && invalid.status < 500);
  assert.equal(JSON.stringify(f.runtime.store.company()), before);
  const shipment = await f.save("대전광역시 동구 운행검증로 1", serviceDate, {
    lat: 36.36,
    lng: 127.46,
  });
  const assigned = await f.assign(shipment.id);
  assert.equal(assigned.status, 200);
  f.runtime.store.run(
    "UPDATE routes SET status='active' WHERE id=?",
    assigned.data.id,
  );
  assert.equal(
    (await f.api("/api/company", "PUT", { ...company, name: "변경 회사" }))
      .status,
    409,
  );
  assert.equal(JSON.stringify(f.runtime.store.company()), before);
  assert.equal(f.provider.mock.callCount(), 0);
});

test(
  "배송지 저장과 기기 OCR 전표 저장 뒤에는 주소를 자동 확인한다",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, true);
    const address = "대전광역시 동구 자동검증로 1";
    f.cache(address);
    const saved = await f.save(address);
    await eventually(
      () =>
        f.runtime.store.one("SELECT lat FROM shipments WHERE id=?", saved.id)
          .lat === examplePoint.lat,
    );
    const receiptAddress = "대전광역시 동구 자동전표로 2";
    f.cache(receiptAddress, { lat: 36.38, lng: 127.47 });
    const image = await readFile(
      new URL("./fixtures/receipt.png", import.meta.url),
    );
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(image)], { type: "image/png" }),
      "receipt.png",
    );
    form.append("recognitionSource", "android-device");
    form.append(
      "recognizedText",
      `거래처: 자동 전표 검증\n배송주소: ${receiptAddress}\n품목: 검증 타이어 2`,
    );
    form.append("serviceDate", serviceDate);
    const upload = await f.clientFetch(f.base + "/api/imports", {
      method: "POST",
      body: form,
      headers: { Authorization: "Bearer " + f.adminToken },
    });
    assert.equal(upload.status, 201);
    const batch = await upload.json();
    const committed = await f.api(`/api/imports/${batch.id}/commit`, "POST", {
      rows: [
        {
          recipient: "자동 전표 검증",
          address: receiptAddress,
          items: [{ name: "검증 타이어", quantity: 2 }],
        },
      ],
    });
    assert.equal(committed.status, 201);
    await eventually(
      () =>
        f.runtime.store.one(
          "SELECT lat FROM shipments WHERE importId=?",
          batch.id,
        )?.lat === 36.38,
    );
    assert.equal(f.provider.mock.callCount(), 0);
  },
);

test("새 엑셀 양식은 주소만 입력하며 위도·경도 열을 요구하지 않는다", async (t) => {
  const f = await fixture(t);
  const response = await f.template();
  assert.equal(response.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(await response.arrayBuffer()) as any);
  const sheet = book.worksheets[0];
  assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), [
    "수령인",
    "배송주소",
    "전화번호",
    "품목",
    "수량",
    "비고",
  ]);
  assert.equal(sheet.columnCount, 6);
  assert.equal(f.provider.mock.callCount(), 0);
});
