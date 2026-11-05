import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id } from "../database.ts";
import {
  assignPendingShipment,
  removePlannedShipment,
  PlannedShipmentMutationError,
} from "../manualAssignment.ts";
import { estimateRoute } from "../routing.ts";
import { GeocodingError } from "../geocoding.ts";
import type { Point, Route } from "../types.ts";

const date = "2027-01-15";
const offline = { roadRouting: false };
const point = { lat: 36.32, lng: 127.43 };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "dispatch-manual-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const driver = store.createUser("driver", "선택 기사", "684291", "", 4);
  const other = store.createUser("driver", "다른 기사", "794283", "", 4);
  const shipment = (coordinates: Point | null = point, serviceDate = date) => {
    const shipmentId = id();
    store.run(
      "INSERT INTO shipments(id,recipient,address,items,lat,lng,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      shipmentId,
      "배송 " + shipmentId,
      "대전광역시 테스트로 10",
      JSON.stringify([{ name: "타이어", quantity: 2 }]),
      coordinates?.lat ?? null,
      coordinates?.lng ?? null,
      serviceDate,
      new Date().toISOString(),
    );
    return shipmentId;
  };
  return { store, driver, other, shipment };
}

function businessState(store: Store) {
  return JSON.stringify({
    shipments: store.all("SELECT * FROM shipments ORDER BY id"),
    routes: store.all("SELECT * FROM routes ORDER BY id"),
    markers: store.all(
      "SELECT * FROM settings WHERE key LIKE 'manual-route:%' ORDER BY key",
    ),
    imports: store.all("SELECT * FROM imports ORDER BY id"),
    history: store.all("SELECT * FROM position_history ORDER BY id"),
  });
}

function status(expected: number) {
  return (error: unknown) =>
    error instanceof PlannedShipmentMutationError && error.status === expected;
}

function assertRoundTrip(route: Route) {
  for (const endpoint of [route.geometry[0], route.geometry.at(-1)!]) {
    assert.equal(endpoint.lat, route.company.lat);
    assert.equal(endpoint.lng, route.company.lng);
  }
  assert.deepEqual(
    route.stops.map((stop) => stop.sequence),
    route.stops.map((_, i) => i + 1),
  );
  assert.equal(route.planning?.stops.length, route.stops.length);
  assert.ok(
    Date.parse(route.planning!.returnAt) >
      Date.parse(route.planning!.departureAt),
  );
  for (const stop of route.planning!.stops)
    assert.equal(
      Date.parse(stop.departureAt) - Date.parse(stop.arrivalAt),
      10 * 60000,
    );
}

test("주소만 있는 미배차 배송지 한 곳을 선택 기사에게 배정하고 같은 날 코스에 추가한다", async (t) => {
  const { store, driver, other, shipment } = await fixture(t);
  const untouchedId = shipment({ lat: 36.4, lng: 127.5 });
  const otherRoute = await assignPendingShipment(
    store,
    { shipmentId: untouchedId, driverId: other.id },
    offline,
  );
  store.run(
    "UPDATE routes SET status='completed',completedAt=? WHERE id=?",
    "2027-01-15T05:00:00Z",
    otherRoute.id,
  );
  store.run(
    "UPDATE shipments SET status='delivered',deliveredAt=? WHERE id=?",
    "2027-01-15T04:00:00Z",
    untouchedId,
  );
  store.run(
    "INSERT INTO position_history(driverId,routeId,lat,lng,recordedAt) VALUES(?,?,?,?,?)",
    other.id,
    otherRoute.id,
    36.4,
    127.5,
    "2027-01-15T04:00:00Z",
  );
  const beforeOther = JSON.stringify(
    store.route(store.one("SELECT * FROM routes WHERE id=?", otherRoute.id)),
  );
  const history = store.all("SELECT * FROM position_history");
  let lookups = 0;
  const firstId = shipment(null);
  const first = await assignPendingShipment(
    store,
    { shipmentId: firstId, driverId: driver.id },
    {
      ...offline,
      geocode: async (_store, address) => {
        assert.equal(address, "대전광역시 테스트로 10");
        lookups++;
        return point;
      },
    },
  );
  assert.equal(lookups, 1);
  assert.equal(first.driverId, driver.id);
  assert.deepEqual(
    first.stops.map((stop) => stop.id),
    [firstId],
  );
  assert.equal(first.stops[0].status, "assigned");
  assert.equal(
    store.one(
      "SELECT value FROM settings WHERE key=?",
      "manual-route:" + first.id,
    ).value,
    "true",
  );
  assert.equal(
    store.one("SELECT lat FROM shipments WHERE id=?", firstId).lat,
    point.lat,
  );
  assertRoundTrip(first);
  const secondId = shipment({ lat: 0, lng: 0 });
  const appended = await assignPendingShipment(
    store,
    { shipmentId: secondId, driverId: driver.id },
    {
      ...offline,
      geocode: async () => {
        lookups++;
        return { lat: 36.36, lng: 127.45 };
      },
    },
  );
  assert.equal(lookups, 2, "0,0 자리표시자는 주소를 다시 확인해야 한다");
  assert.equal(appended.id, first.id);
  assert.deepEqual(
    new Set(appended.stops.map((stop) => stop.id)),
    new Set([firstId, secondId]),
  );
  assert.equal(appended.planning?.departureAt, first.planning?.departureAt);
  assert.equal(
    store.all("SELECT id FROM routes WHERE driverId=?", driver.id).length,
    1,
  );
  assertRoundTrip(appended);
  assert.equal(
    JSON.stringify(
      store.route(store.one("SELECT * FROM routes WHERE id=?", otherRoute.id)),
    ),
    beforeOther,
  );
  assert.deepEqual(store.all("SELECT * FROM position_history"), history);
});

test("기사 정원·활성 상태와 진행 중인 다른 날짜 코스를 확인하고 이미 배차된 배송지는 거부한다", async (t) => {
  const { store, driver, shipment } = await fixture(t);
  store.run("UPDATE users SET capacity=1 WHERE id=?", driver.id);
  const firstId = shipment();
  const route = await assignPendingShipment(
    store,
    { shipmentId: firstId, driverId: driver.id },
    offline,
  );
  const secondId = shipment();
  const before = businessState(store);
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId: secondId, driverId: driver.id },
      offline,
    ),
    status(409),
  );
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId: firstId, driverId: driver.id },
      offline,
    ),
    status(409),
  );
  assert.equal(businessState(store), before);
  store.run("UPDATE users SET capacity=4,active=0 WHERE id=?", driver.id);
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId: secondId, driverId: driver.id },
      offline,
    ),
    status(409),
  );
  store.run("UPDATE users SET active=1 WHERE id=?", driver.id);
  store.run(
    "UPDATE routes SET serviceDate=?,status='active' WHERE id=?",
    "2027-01-14",
    route.id,
  );
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId: secondId, driverId: driver.id },
      offline,
    ),
    status(409),
  );
  store.run("UPDATE routes SET status='returning' WHERE id=?", route.id);
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId: secondId, driverId: driver.id },
      offline,
    ),
    status(409),
  );
});

test("주소 확인·경로 제공자 실패에는 좌표나 코스 일부를 저장하지 않는다", async (t) => {
  const { store, driver, shipment } = await fixture(t);
  const shipmentId = shipment(null);
  const before = businessState(store);
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      {
        ...offline,
        geocode: async () => {
          throw new Error("offline");
        },
      },
    ),
    status(422),
  );
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      { ...offline, geocode: async () => ({ lat: NaN, lng: 127 }) },
    ),
    status(422),
  );
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      { ...offline, geocode: async () => ({ lat: 0, lng: 0 }) },
    ),
    status(422),
  );
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      {
        ...offline,
        geocode: async () => {
          throw new GeocodingError(
            "CONFIGURATION",
            "관리자에게 지도 인증 정보를 확인해 주세요.",
            422,
          );
        },
      },
    ),
    (error: unknown) =>
      error instanceof PlannedShipmentMutationError &&
      error.status === 422 &&
      error.message === "관리자에게 지도 인증 정보를 확인해 주세요.",
  );
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      {
        ...offline,
        geocode: async () => point,
        estimateRoute: async () => {
          throw new Error("provider unavailable");
        },
      },
    ),
    /provider unavailable/,
  );
  assert.equal(businessState(store), before);
});

test("조회가 끝날 때까지 변경된 배송지·기사·코스·회사는 다시 확인하여 배차를 원자적으로 거부한다", async (t) => {
  const races: [
    string,
    (
      store: Store,
      values: { shipmentId: string; route: Route; driverId: string },
    ) => void,
  ][] = [
    [
      "주소 변경",
      (store, v) => {
        store.run(
          "UPDATE shipments SET address=? WHERE id=?",
          "변경된 주소",
          v.shipmentId,
        );
      },
    ],
    [
      "배송지 삭제",
      (store, v) => {
        store.run("DELETE FROM shipments WHERE id=?", v.shipmentId);
      },
    ],
    [
      "기사 정원 변경",
      (store, v) => {
        store.run("UPDATE users SET capacity=1 WHERE id=?", v.driverId);
      },
    ],
    [
      "기사 비활성",
      (store, v) => {
        store.run("UPDATE users SET active=0 WHERE id=?", v.driverId);
      },
    ],
    [
      "운행 출발",
      (store, v) => {
        store.run("UPDATE routes SET status='active' WHERE id=?", v.route.id);
      },
    ],
    [
      "코스 배송지 수정",
      (store, v) => {
        store.run(
          "UPDATE shipments SET items=? WHERE id=?",
          '[{"name":"변경","quantity":5}]',
          v.route.stops[0].id,
        );
      },
    ],
    [
      "기존 코스 삭제",
      (store, v) => {
        store.run(
          "UPDATE shipments SET routeId=NULL,status='pending',sequence=NULL WHERE routeId=?",
          v.route.id,
        );
        store.run("DELETE FROM routes WHERE id=?", v.route.id);
      },
    ],
    [
      "회사 변경",
      (store) => {
        store.run(
          "UPDATE settings SET value=? WHERE key='company'",
          JSON.stringify({
            ...store.company(),
            lat: 36.2,
            address: "다른 회사",
          }),
        );
      },
    ],
  ];
  for (const [name, mutate] of races)
    await t.test(name, async (child) => {
      const { store, driver, shipment } = await fixture(child);
      const route = await assignPendingShipment(
        store,
        { shipmentId: shipment(), driverId: driver.id },
        offline,
      );
      const shipmentId = shipment();
      let afterConcurrentEdit = "";
      await assert.rejects(
        assignPendingShipment(
          store,
          { shipmentId, driverId: driver.id },
          {
            ...offline,
            estimateRoute: async (...args) => {
              mutate(store, { shipmentId, route, driverId: driver.id });
              afterConcurrentEdit = businessState(store);
              return estimateRoute(...args);
            },
          },
        ),
        status(409),
      );
      assert.equal(businessState(store), afterConcurrentEdit);
    });
});

test("조회 중 새 코스가 생기면 덮어쓰지 않고 저장 실패도 전체 배차를 되돌린다", async (t) => {
  const { store, driver, shipment } = await fixture(t);
  const shipmentId = shipment();
  const concurrentId = shipment({ lat: 36.36, lng: 127.42 });
  let concurrentState = "";
  await assert.rejects(
    assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      {
        ...offline,
        estimateRoute: async (...args) => {
          const routeId = id();
          const company = store.company();
          store.run(
            "INSERT INTO routes(id,driverId,serviceDate,distanceKm,durationMinutes,estimateSource,geometry,company) VALUES(?,?,?,?,?,?,?,?)",
            routeId,
            driver.id,
            date,
            1,
            20,
            "approximate",
            JSON.stringify([company, point, company]),
            JSON.stringify(company),
          );
          store.run(
            "UPDATE shipments SET routeId=?,sequence=1,status='assigned' WHERE id=?",
            routeId,
            concurrentId,
          );
          concurrentState = businessState(store);
          return estimateRoute(...args);
        },
      },
    ),
    status(409),
  );
  assert.equal(businessState(store), concurrentState);
  store.db.exec(
    "CREATE TRIGGER reject_manual_marker BEFORE INSERT ON settings WHEN NEW.key LIKE 'manual-route:%' BEGIN SELECT RAISE(ABORT,'manual marker storage failed'); END",
  );
  const before = businessState(store);
  await assert.rejects(
    assignPendingShipment(store, { shipmentId, driverId: driver.id }, offline),
    /manual marker storage failed/,
  );
  assert.equal(businessState(store), before);
});

test("예정 코스 배송지 삭제는 남은 순서·회사 왕복·체류 시간·원본 전표와 다른 코스를 보존한다", async (t) => {
  const { store, driver, other, shipment } = await fixture(t);
  const ids = [
    shipment({ lat: 36.35, lng: 127.4 }),
    shipment({ lat: 36.36, lng: 127.41 }),
    shipment({ lat: 36.37, lng: 127.42 }),
  ];
  let route: Route;
  for (const shipmentId of ids)
    route = await assignPendingShipment(
      store,
      { shipmentId, driverId: driver.id },
      offline,
    );
  const reversed = route!.stops.map((stop) => stop.id).reverse();
  reversed.forEach((shipmentId, index) =>
    store.run(
      "UPDATE shipments SET sequence=? WHERE id=?",
      index + 1,
      shipmentId,
    ),
  );
  const otherRoute = await assignPendingShipment(
    store,
    { shipmentId: shipment(), driverId: other.id },
    offline,
  );
  const originalOther = JSON.stringify(
    store.route(store.one("SELECT * FROM routes WHERE id=?", otherRoute.id)),
  );
  const importId = id();
  store.run(
    "INSERT INTO imports(id,fileName,storedName,mime,drafts,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?)",
    importId,
    "전표.jpg",
    "stored.jpg",
    "image/jpeg",
    '[{"recipient":"원본"}]',
    date,
    new Date().toISOString(),
  );
  store.run(
    "UPDATE shipments SET importId=? WHERE id=?",
    importId,
    reversed[1],
  );
  const originalImport = store.one(
    "SELECT * FROM imports WHERE id=?",
    importId,
  );
  const removed = await removePlannedShipment(
    store,
    { shipmentId: reversed[1] },
    offline,
  );
  assert.deepEqual(removed, {
    driverId: driver.id,
    routeId: route!.id,
    deletedRoute: false,
  });
  const remaining = store.route(
    store.one("SELECT * FROM routes WHERE id=?", route!.id),
  );
  assert.deepEqual(
    remaining.stops.map((stop) => stop.id),
    [reversed[0], reversed[2]],
  );
  assert.equal(remaining.planning?.departureAt, route!.planning?.departureAt);
  assertRoundTrip(remaining);
  assert.equal(
    store.one("SELECT * FROM shipments WHERE id=?", reversed[1]),
    undefined,
  );
  assert.deepEqual(
    store.one("SELECT * FROM imports WHERE id=?", importId),
    originalImport,
  );
  assert.equal(
    JSON.stringify(
      store.route(store.one("SELECT * FROM routes WHERE id=?", otherRoute.id)),
    ),
    originalOther,
  );
  assert.equal(
    store.one(
      "SELECT value FROM settings WHERE key=?",
      "manual-route:" + route!.id,
    ).value,
    "true",
  );
  await removePlannedShipment(store, { shipmentId: reversed[0] }, offline);
  const last = await removePlannedShipment(
    store,
    { shipmentId: reversed[2] },
    {
      ...offline,
      estimateRoute: async () => {
        throw new Error("must not estimate empty route");
      },
    },
  );
  assert.equal(last.deletedRoute, true);
  assert.equal(
    store.one("SELECT * FROM routes WHERE id=?", route!.id),
    undefined,
  );
  assert.equal(
    store.one(
      "SELECT * FROM settings WHERE key=?",
      "manual-route:" + route!.id,
    ),
    undefined,
  );
});

test("미배차 주소 삭제는 조회 없이 처리하며 출발·완료·실패 배송지는 삭제할 수 없다", async (t) => {
  const { store, driver, shipment } = await fixture(t);
  const pending = shipment(null);
  const removed = await removePlannedShipment(
    store,
    { shipmentId: pending },
    {
      ...offline,
      geocode: async () => {
        throw new Error("no lookup");
      },
      estimateRoute: async () => {
        throw new Error("no estimate");
      },
    },
  );
  assert.deepEqual(removed, {
    driverId: null,
    routeId: null,
    deletedRoute: false,
  });
  const shipmentId = shipment();
  const route = await assignPendingShipment(
    store,
    { shipmentId, driverId: driver.id },
    offline,
  );
  for (const state of ["active", "returning", "completed"]) {
    store.run("UPDATE routes SET status=? WHERE id=?", state, route.id);
    await assert.rejects(
      removePlannedShipment(store, { shipmentId }, offline),
      status(409),
    );
  }
  store.run("UPDATE routes SET status='planned' WHERE id=?", route.id);
  for (const state of ["delivered", "failed"]) {
    store.run("UPDATE shipments SET status=? WHERE id=?", state, shipmentId);
    await assert.rejects(
      removePlannedShipment(store, { shipmentId }, offline),
      status(409),
    );
    assert.ok(store.one("SELECT id FROM shipments WHERE id=?", shipmentId));
  }
});

test("삭제 경로 재계산 실패와 재계산 중 출발·삭제·수정은 부분 삭제를 남기지 않는다", async (t) => {
  for (const change of ["provider", "start", "edit", "delete"] as const)
    await t.test(change, async (child) => {
      const { store, driver, shipment } = await fixture(child);
      const firstId = shipment();
      await assignPendingShipment(
        store,
        { shipmentId: firstId, driverId: driver.id },
        offline,
      );
      const route = await assignPendingShipment(
        store,
        {
          shipmentId: shipment({ lat: 36.36, lng: 127.45 }),
          driverId: driver.id,
        },
        offline,
      );
      let expected = businessState(store);
      await assert.rejects(
        removePlannedShipment(
          store,
          { shipmentId: firstId },
          {
            ...offline,
            estimateRoute: async (...args) => {
              if (change === "provider") throw new Error("provider failed");
              if (change === "start")
                store.run(
                  "UPDATE routes SET status='active' WHERE id=?",
                  route.id,
                );
              if (change === "edit")
                store.run(
                  "UPDATE shipments SET address=? WHERE id=?",
                  "다른 주소",
                  route.stops.find((stop) => stop.id !== firstId)!.id,
                );
              if (change === "delete")
                store.run("DELETE FROM shipments WHERE id=?", firstId);
              expected = businessState(store);
              return estimateRoute(...args);
            },
          },
        ),
        change === "provider" ? /provider failed/ : status(409),
      );
      assert.equal(businessState(store), expected);
    });
});
