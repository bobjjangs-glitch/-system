import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import {
  NaverDirections,
  trafficChunks,
  trafficRoutingStatus,
} from "../naverDirections.ts";
import {
  planDispatch,
  estimateRoute,
  optimizeAssignments,
} from "../routing.ts";
import { defaultCompany, Store } from "../database.ts";
import { createDispatchApp } from "../app.ts";
import type { Driver, Point, Shipment } from "../types.ts";
const config = { keyId: "testkey", keySecret: "server-only-secret" };
const points: Point[] = [
  defaultCompany,
  ...Array.from({ length: 14 }, (_, i) => ({
    lat: defaultCompany.lat + 0.01 * (i + 1),
    lng: defaultCompany.lng + 0.006 * (i + 1),
  })),
];
const coordinate = (p: Point) => p.lng.toFixed(6) + "," + p.lat.toFixed(6);
const id = (p: Point) =>
  points.findIndex((v) => coordinate(v) === coordinate(p));
const drivers: Driver[] = Array.from({ length: 3 }, (_, i) => ({
  id: String(i),
  name: "기사 " + i,
  phone: "",
  active: true,
  capacity: 10,
}));
function shipments(count: number): Shipment[] {
  return points.slice(1, count + 1).map((p, i) => ({
    ...p,
    id: String(i),
    recipient: "배송지",
    address: "대전 예시",
    items: [{ name: "물품", quantity: 1 }],
    serviceDate: "2026-11-03",
    status: "pending",
    routeId: null,
    sequence: null,
    deliveredAt: null,
    failureReason: null,
    importId: null,
  }));
}
function provider(cost: (a: number, b: number) => number = () => 2) {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers["x-ncp-apigw-api-key-id"], config.keyId);
    assert.equal(headers["x-ncp-apigw-api-key"], config.keySecret);
    assert.equal(url.origin, "https://maps.apigw.ntruss.com");
    assert.equal(url.searchParams.get("option"), "traoptimal");
    assert.notEqual(
      url.searchParams.get("start"),
      url.searchParams.get("goal"),
    );
    const path = [
      url.searchParams.get("start")!,
      ...(url.searchParams.get("waypoints")?.split("|") ?? []),
      url.searchParams.get("goal")!,
    ].map((v) => {
      const [lng, lat] = v.split(",").map(Number);
      return { lat, lng };
    });
    assert.ok(path.length <= 17);
    const legs = path.slice(1).map((p, i) => cost(id(path[i]), id(p)));
    return Response.json({
      code: 0,
      route: {
        traoptimal: [
          {
            summary: {
              distance: legs.reduce((a, b) => a + b, 0) * 1000,
              duration: legs.reduce((a, b) => a + b, 0) * 60000,
            },
            path: path.map((p) => [p.lng, p.lat]),
            guide: legs.map((m, i) => ({
              type: i === legs.length - 1 ? 88 : 87,
              duration: m * 60000,
            })),
          },
        ],
      },
    });
  };
  return { fetcher, requests };
}
const now = () => Date.parse("2026-11-03T00:00:00Z");

test("실시간 교통이 느린 순서 대신 역순을 선택하고 회사 복귀·10분 체류·공통 출발 시각을 포함한다", async () => {
  const stub = provider((a, b) => (a > b || (a === 0 && b === 3) ? 1 : 20));
  const groups = await planDispatch(
    defaultCompany,
    shipments(3),
    [drivers[0]],
    {
      config,
      fetcher: stub.fetcher,
      now,
      cache: false,
      trafficRequired: true,
      departureAt: "2026-11-03T09:00:00+09:00",
      serviceDate: "2026-11-03",
    },
  );
  assert.deepEqual(
    groups[0].stops.map((p) => p.id),
    ["2", "1", "0"],
  );
  assert.equal(groups[0].estimate.estimateSource, "naver-traffic");
  assert.equal(groups[0].estimate.durationMinutes, 34);
  assert.equal(groups[0].planning.departureAt, "2026-11-03T00:00:00.000Z");
  assert.equal(groups[0].planning.returnAt, "2026-11-03T00:34:00.000Z");
  assert.equal(groups[0].planning.basis, "current-traffic");
  assert.equal(groups[0].planning.legTimesEstimated, false);
  for (const stop of groups[0].planning.stops)
    assert.equal(
      Date.parse(stop.departureAt) - Date.parse(stop.arrivalAt),
      10 * 60000,
    );
  assert.ok(stub.requests.length <= 40);
  assert.equal(
    stub.requests.at(-1)?.searchParams.get("goal"),
    coordinate(defaultCompany),
  );
});

test("기사 간 배차는 실시간 소요시간을 줄이는 이동·교환 후보를 비교하고 수용량·5곳 하한·중복 없음 보존", async () => {
  const stub = provider((a, b) => (a === 10 || b === 10 ? 40 : 2));
  const all = shipments(12);
  const groups = await planDispatch(defaultCompany, all, drivers.slice(0, 2), {
    config,
    fetcher: stub.fetcher,
    now,
    cache: false,
    trafficRequired: true,
    serviceDate: "2026-11-03",
  });
  assert.equal(groups.length, 2);
  assert.equal(
    new Set(groups.flatMap((g) => g.stops.map((p) => p.id))).size,
    12,
  );
  assert.deepEqual(
    groups.flatMap((g) => g.stops.map((p) => p.id)).sort(),
    all.map((p) => p.id).sort(),
  );
  for (const group of groups) {
    assert.ok(group.stops.length >= 5);
    assert.ok(group.stops.length <= group.driver.capacity);
  }
  assert.deepEqual(groups.map((g) => g.stops.length).sort(), [5, 7]);
  assert.ok(Math.max(...groups.map((g) => g.estimate.durationMinutes)) < 150);
  assert.ok(stub.requests.length <= 40);
  assert.equal(new Set(groups.map((g) => g.planning.departureAt)).size, 1);
});

test("기사별 수용량이 달라도 가능한 최소 5곳을 처음 배정부터 예약한다", () => {
  const data = Array.from({ length: 16 }, (_, i) => ({
    ...shipments(1)[0],
    id: String(i),
    lat: defaultCompany.lat + 0.001 * i,
  }));
  const people = [100, 1, 100, 100].map((capacity, i) => ({
    ...drivers[0],
    id: String(i),
    capacity,
  }));
  assert.deepEqual(
    optimizeAssignments(defaultCompany, data, people).map(
      (g) => g.stops.length,
    ),
    [5, 1, 5, 5],
  );
});

test("인증·경로 조회 실패와 필수 키 누락을 실시간 결과나 정적 추정으로 위장하지 않는다", async () => {
  await assert.rejects(
    planDispatch(defaultCompany, shipments(2), drivers, {
      config: null,
      trafficRequired: true,
    }),
    /NAVER_DIRECTIONS/,
  );
  await assert.rejects(
    estimateRoute(defaultCompany, points.slice(1, 3), true, {
      config,
      fetcher: async () => new Response("no", { status: 401 }),
      cache: false,
    }),
    /인증/,
  );
  await assert.rejects(
    estimateRoute(defaultCompany, points.slice(1, 3), true, {
      config,
      fetcher: async () => {
        throw new DOMException("timeout", "TimeoutError");
      },
      cache: false,
    }),
    /불러오지 못했습니다/,
  );
  await assert.rejects(
    estimateRoute(defaultCompany, points.slice(1, 3), true, {
      config,
      fetcher: async () => Response.json({ code: 2 }),
      cache: false,
    }),
    /좌표/,
  );
  const staticGroups = await planDispatch(
    defaultCompany,
    shipments(2),
    drivers,
    { roadRouting: false, config: null, now },
  );
  assert.equal(staticGroups[0].planning.basis, "static");
  assert.equal(staticGroups[0].planning.trafficCheckedAt, null);
});

test("경유지 수를 제한하고 동일 출발·도착 회사 왕복을 올바르게 분리한다", async () => {
  const loop = [defaultCompany, ...points.slice(1), defaultCompany];
  for (const chunk of trafficChunks(loop)) {
    assert.ok(chunk.length <= 17);
    assert.notEqual(coordinate(chunk[0]), coordinate(chunk.at(-1)!));
  }
  const stub = provider();
  const client = new NaverDirections(config, {
    fetcher: stub.fetcher,
    now,
    cache: false,
  });
  const route = await client.route(loop);
  assert.equal(route.legMinutes.length, loop.length - 1);
  assert.deepEqual(route.geometry[0], {
    lat: Number(defaultCompany.lat.toFixed(6)),
    lng: Number(defaultCompany.lng.toFixed(6)),
  });
  assert.deepEqual(route.geometry[0], route.geometry.at(-1));
  assert.ok(stub.requests.length <= 2);
});

test("조회 예산과 30초 캐시, 구간 안내 누락 시 추정 표시를 지킨다", async () => {
  const stub = provider();
  let clock = now();
  const client = new NaverDirections(config, {
    fetcher: stub.fetcher,
    now: () => clock,
    maxCalls: 2,
  });
  const path = [defaultCompany, points[1], defaultCompany];
  await client.route(path);
  assert.equal(stub.requests.length, 2);
  await assert.rejects(client.route(path), /한도/);
  const cached = new NaverDirections(config, {
    fetcher: stub.fetcher,
    now: () => clock,
  });
  const old = await cached.route(path);
  assert.equal(stub.requests.length, 2);
  clock += 31_000;
  await cached.route(path);
  assert.equal(stub.requests.length, 4);
  assert.ok(Date.parse(old.checkedAt) < clock);
  const missing = new NaverDirections(config, {
    now,
    cache: false,
    fetcher: async () =>
      Response.json({
        code: 0,
        route: {
          traoptimal: [
            {
              summary: { distance: 1000, duration: 120000 },
              path: [
                [127, 36],
                [127.1, 36.1],
              ],
              guide: [],
            },
          ],
        },
      }),
  });
  assert.equal(
    (await missing.route([defaultCompany, points[1]])).legTimesEstimated,
    true,
  );
});

test("배차 상태는 관리자 전용이며 키를 노출하지 않고 기존 코스 내역은 마이그레이션 후 유지한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-traffic-"));
  const runtime = createDispatchApp({
    dataDir: dir,
    roadRouting: false,
    test: true,
  });
  try {
    const pin = String(randomInt(10000000, 99999999));
    runtime.store.createUser("admin", "교통 검증 관리자", pin);
    const session = runtime.store.login(pin);
    assert.ok(session);
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const base =
      "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
    assert.equal((await fetch(base + "/api/routing-status")).status, 401);
    const status = await fetch(base + "/api/routing-status", {
      headers: { Authorization: "Bearer " + session.token },
    }).then((r) => r.json());
    assert.equal(status.provider, "naver-directions15");
    assert.equal(status.authenticationVerified, false);
    assert.ok(!JSON.stringify(status).includes(config.keySecret));
    const failed = await fetch(base + "/api/routes/optimize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + session.token,
      },
      body: JSON.stringify({
        serviceDate: "2026-11-03",
        trafficRequired: true,
      }),
    });
    // No deliveries in this store: validation fails without changing account/history.
    assert.equal(failed.status, 400);
    assert.equal(
      runtime.store.one("SELECT COUNT(*) AS count FROM users")?.count,
      1,
    );
    assert.ok(
      runtime.store
        .all("PRAGMA table_info(routes)")
        .some((column) => column.name === "planning"),
    );
  } finally {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("기존 계정·완료 코스를 지우지 않고 일정 열을 추가하며 다시 열어도 ETA를 유지한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dispatch-traffic-migration-"));
  let store = new Store(dir);
  try {
    const pin = String(randomInt(10000000, 99999999));
    const person = store.createUser("driver", "기존 기사", pin);
    store.run(
      "INSERT INTO routes(id,driverId,serviceDate,status,distanceKm,durationMinutes,estimateSource,geometry,company) VALUES(?,?,?,?,?,?,?,?,?)",
      "old-route",
      person.id,
      "2026-11-02",
      "completed",
      12,
      100,
      "approximate",
      JSON.stringify([defaultCompany, defaultCompany]),
      JSON.stringify(defaultCompany),
    );
    store.db.exec("ALTER TABLE routes DROP COLUMN planning");
    store.close();
    store = new Store(dir);
    const row = store.route(
      store.one("SELECT * FROM routes WHERE id='old-route'"),
    );
    assert.equal(row.status, "completed");
    assert.equal(row.durationMinutes, 100);
    assert.equal(row.planning, null);
    assert.ok(store.login(pin));
    const stub = provider();
    const [planned] = await planDispatch(
      defaultCompany,
      shipments(2),
      [drivers[0]],
      {
        config,
        fetcher: stub.fetcher,
        cache: false,
        now,
        serviceDate: "2026-11-04",
        departureAt: "2026-11-04T10:00:00+09:00",
      },
    );
    assert.equal(planned.planning.departureAt, "2026-11-04T01:00:00.000Z");
    assert.equal(planned.planning.trafficCheckedAt, "2026-11-03T00:00:00.000Z");
    assert.equal(planned.planning.basis, "current-traffic");
    store.run(
      "UPDATE routes SET planning=? WHERE id='old-route'",
      JSON.stringify(planned.planning),
    );
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.route(store.one("SELECT * FROM routes WHERE id='old-route'"))
        .planning,
      planned.planning,
    );
    await assert.rejects(
      planDispatch(defaultCompany, shipments(2), [drivers[0]], {
        config: null,
        roadRouting: false,
        serviceDate: "2026-11-03",
        departureAt: "2026-11-04T09:00:00+09:00",
      }),
      /배송일/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("서버에 키가 있어도 명시한 일반 배차는 교통 API를 호출하지 않는다", async () => {
  const previous = globalThis.fetch;
  let trafficCalls = 0;
  const staticFetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "router.project-osrm.org");
    return Response.json({
      routes: [
        {
          distance: 2000,
          duration: 120000,
          geometry: {
            coordinates: [
              [defaultCompany.lng, defaultCompany.lat],
              [points[1].lng, points[1].lat],
              [defaultCompany.lng, defaultCompany.lat],
            ],
          },
        },
      ],
    });
  };
  globalThis.fetch = staticFetcher;
  try {
    const groups = await planDispatch(
      defaultCompany,
      shipments(2),
      [drivers[0]],
      {
        config,
        trafficRequired: false,
        now,
        fetcher: async () => {
          trafficCalls++;
          throw new Error("Must not request paid traffic");
        },
      },
    );
    assert.equal(trafficCalls, 0);
    assert.equal(groups[0].estimate.estimateSource, "road");
    assert.equal(groups[0].planning.basis, "static");
    assert.equal(groups[0].planning.trafficCheckedAt, null);
  } finally {
    globalThis.fetch = previous;
  }
});
