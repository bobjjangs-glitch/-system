import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocket } from "ws";
import { createDispatchApp } from "../app.ts";
import { today } from "../database.ts";
import type { Route } from "../types.ts";
import { createDriverMapData } from "../../src/driverMapData.ts";
import { createMapDocument } from "../../src/mapDocument.ts";
import { DEFAULT_NAVER_MAP_KEY_ID } from "../../src/mapConfig.ts";

test(
  "기사 지도 키를 공유해도 본인 코스만 보이고 설정 변경은 관리자만 할 수 있다",
  { timeout: 20000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dispatch-driver-map-"));
    const runtime = createDispatchApp({
      dataDir,
      roadRouting: false,
      test: true,
    });
    const sockets: WebSocket[] = [];
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
    const call = async (
      path: string,
      token?: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token ?? ""}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      const admin = (
        await call("/api/setup", undefined, {
          name: "지도 관리자",
          pin: "823619",
        })
      ).data;
      assert.equal((await call("/api/demo", admin.token, {})).status, 201);
      const planned = await call("/api/routes/optimize", admin.token, {
        serviceDate: today(),
      });
      assert.equal(planned.status, 200);
      const routes = planned.data as Route[];
      assert.ok(routes.length >= 2);
      const drivers = [];
      for (const route of routes.slice(0, 2)) {
        const pin = (
          await call(`/api/drivers/${route.driverId}/pin`, admin.token)
        ).data.pin;
        const login = await call("/api/login", undefined, { pin });
        assert.equal(login.status, 200);
        drivers.push(login.data);
      }
      assert.equal((await call("/api/me")).status, 401);
      assert.equal(
        (await call("/api/map-settings", drivers[0].token)).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/api/map-settings",
            drivers[0].token,
            { naverKeyId: "forbiddenKey" },
            "PUT",
          )
        ).status,
        403,
      );
      assert.equal((await call("/api/routes", drivers[0].token)).status, 403);
      assert.equal(
        (
          await call(
            "/api/map-settings",
            admin.token,
            { naverKeyId: "sharedKey123" },
            "PUT",
          )
        ).status,
        200,
      );

      for (const [index, driver] of drivers.entries()) {
        const other = routes[index === 0 ? 1 : 0];
        const response = await call(
          `/api/me?driverId=${other.driverId}&id=${other.id}`,
          driver.token,
        );
        assert.equal(response.status, 200);
        assert.deepEqual(response.data.mapSettings, {
          naverKeyId: "sharedKey123",
        });
        assert.equal(response.data.route.id, routes[index].id);
        assert.equal(response.data.route.driverId, driver.user.userId);
        assert.deepEqual(
          response.data.route.stops.map((stop: { id: string }) => stop.id),
          routes[index].stops.map((stop) => stop.id),
        );
        assert.ok(
          !("routes" in response.data) && !("drivers" in response.data),
        );
        const mapData = createDriverMapData(
          response.data.route,
          response.data.mapSettings,
        );
        assert.equal(mapData.routes.length, 1);
        assert.equal(mapData.routes[0].id, routes[index].id);
        const document = createMapDocument(base, mapData.map);
        assert.ok(document.includes('const key="sharedKey123"'));
        assert.ok(document.includes("oapi.map.naver.com"));
        assert.ok(!document.includes("tile.openstreetmap.org"));
      }

      assert.equal(
        (
          await call(
            `/api/driver/routes/${routes[0].id}/start`,
            drivers[0].token,
            {},
          )
        ).status,
        200,
      );
      const before = (await call("/api/me", drivers[0].token)).data.route;
      for (const driver of drivers) {
        const socket = new WebSocket(base.replace("http", "ws") + "/live");
        sockets.push(socket);
        await once(socket, "open");
        const connected = once(socket, "message", {
          signal: AbortSignal.timeout(3000),
        });
        socket.send(JSON.stringify({ type: "auth", token: driver.token }));
        assert.deepEqual(JSON.parse(String((await connected)[0])), {
          event: "connected",
        });
      }
      const changed = sockets.map((socket) =>
        once(socket, "message", { signal: AbortSignal.timeout(3000) }),
      );
      assert.equal(
        (
          await call(
            "/api/map-settings",
            admin.token,
            { naverKeyId: "updatedKey456" },
            "PUT",
          )
        ).status,
        200,
      );
      for (const event of await Promise.all(changed))
        assert.deepEqual(
          JSON.parse(String(event[0])),
          { event: "changed" },
          "설정 변경 알림에 다른 기사 데이터가 없어야 한다",
        );
      const refreshed = (await call("/api/me", drivers[0].token)).data;
      assert.deepEqual(refreshed.mapSettings, { naverKeyId: "updatedKey456" });
      assert.deepEqual(
        refreshed.route,
        before,
        "지도 키 변경은 진행 중인 본인 코스에 영향을 주지 않는다",
      );
      assert.equal(
        createDriverMapData(refreshed.route, refreshed.mapSettings).map
          .naverKeyId,
        "updatedKey456",
      );

      assert.equal(
        (
          await call(
            "/api/map-settings",
            admin.token,
            { naverKeyId: "" },
            "PUT",
          )
        ).status,
        200,
      );
      const cleared = (await call("/api/me", drivers[0].token)).data;
      assert.deepEqual(cleared.mapSettings, { naverKeyId: "" });
      const clearedMap = createDriverMapData(
        cleared.route,
        cleared.mapSettings,
      );
      assert.equal(clearedMap.map.naverKeyId, "");
      assert.ok(
        !createMapDocument(base, clearedMap.map).includes(
          "tile.openstreetmap.org",
        ),
      );

      const unassigned = await call("/api/drivers", admin.token, {
        name: "미배정 기사",
        pin: "597246",
        capacity: 10,
      });
      assert.equal(unassigned.status, 201);
      const login = (await call("/api/login", undefined, { pin: "597246" }))
        .data;
      const empty = await call("/api/me", login.token);
      assert.equal(empty.status, 200);
      assert.equal(empty.data.route, null);
      assert.deepEqual(empty.data.mapSettings, { naverKeyId: "" });
    } finally {
      for (const socket of sockets) socket.terminate();
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test("구버전 서버 응답도 기사 지도는 네이버를 사용하고 명시적으로 지운 키는 보존한다", () => {
  const route = {
    company: { name: "회사", lat: 36.35, lng: 127.38 },
    stops: [
      { id: "delivered", status: "delivered" },
      { id: "next", status: "assigned" },
    ],
  } as Route;
  const legacy = createDriverMapData(route);
  assert.equal(legacy.map.naverKeyId, DEFAULT_NAVER_MAP_KEY_ID);
  assert.equal(legacy.nextStopId, "next");
  assert.equal(legacy.routes[0], route);
  assert.deepEqual(legacy.drivers, []);
  assert.ok(createMapDocument("", legacy.map).includes("oapi.map.naver.com"));
  const cleared = createDriverMapData(route, { naverKeyId: "" });
  const document = createMapDocument("", cleared.map);
  assert.ok(document.includes("네이버 지도 연결이 필요해요."));
  assert.ok(!document.includes("tile.openstreetmap.org"));
});
