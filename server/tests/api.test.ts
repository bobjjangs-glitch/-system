import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import ExcelJS from "exceljs";
import { createDispatchApp } from "../app.ts";
import { today } from "../database.ts";

test("로컬 Nginx 프록시 뒤에서도 로그인 제한을 실제 클라이언트 주소별로 분리한다", async () => {
  const previous = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "loopback";
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-proxy-"));
  const runtime = createDispatchApp({ dataDir, roadRouting: false });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  const attempt = (ip: string) =>
    fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ pin: "987654" }),
    });
  try {
    for (let i = 0; i < 12; i++)
      assert.equal((await attempt("198.51.100.10")).status, 401);
    assert.equal((await attempt("198.51.100.10")).status, 429);
    assert.equal((await attempt("198.51.100.11")).status, 401);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  "출발 전 코스 이동·순서 편집과 회사 변경을 처리하고 실제 데이터의 예시 초기화를 막는다",
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dispatch-edit-")),
      runtime = createDispatchApp({ dataDir, roadRouting: false, test: true });
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
    let token = "";
    const call = async (
      path: string,
      body?: any,
      method = body === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      token = (await call("/api/setup", { name: "관리자", pin: "792184" })).data
        .token;
      assert.equal((await call("/api/demo", {})).status, 201);
      const initial = (
        await call("/api/routes/optimize", { serviceDate: today() })
      ).data;
      assert.equal(initial.length, 5);
      assert.ok(initial.every((r: any) => r.stops.length === 5));
      const source = initial[0],
        target = initial[1],
        reversed = source.stops.map((s: any) => s.id).reverse();
      assert.equal(
        (
          await call("/api/routes/" + source.id + "/reorder", {
            stopIds: [reversed[0]],
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await call("/api/routes/" + source.id + "/reorder", {
            stopIds: reversed,
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (await call("/api/routes")).data
          .find((r: any) => r.id === source.id)
          .stops.map((s: any) => s.id),
        reversed,
      );
      assert.equal(
        (
          await call(
            "/api/drivers/" + target.driverId,
            { capacity: 4 },
            "PATCH",
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await call(
            "/api/drivers/" + target.driverId,
            { capacity: 5 },
            "PATCH",
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call("/api/routes/move-stop", {
            shipmentId: source.stops[0].id,
            targetRouteId: target.id,
          })
        ).status,
        400,
      );
      await call("/api/drivers/" + target.driverId, { capacity: 10 }, "PATCH");
      assert.equal(
        (
          await call("/api/routes/move-stop", {
            shipmentId: source.stops[0].id,
            targetRouteId: target.id,
          })
        ).status,
        200,
      );
      const moved = (await call("/api/routes")).data;
      assert.equal(moved.find((r: any) => r.id === source.id).stops.length, 4);
      assert.equal(moved.find((r: any) => r.id === target.id).stops.length, 6);
      assert.equal(
        new Set(moved.flatMap((r: any) => r.stops.map((s: any) => s.id))).size,
        25,
      );
      const company = (await call("/api/company")).data;
      assert.equal(
        (
          await call(
            "/api/company",
            { ...company, name: "새 출발지", lat: 36.35, lng: 127.38 },
            "PUT",
          )
        ).status,
        200,
      );
      assert.equal((await call("/api/routes")).data.length, 0);
      assert.ok(
        (await call("/api/shipments")).data.every(
          (s: any) => s.status === "pending",
        ),
      );
      assert.equal(
        (
          await call("/api/shipments", {
            rows: [
              {
                recipient: "실제 배송지",
                address: "대전 실제 주소",
                items: [{ name: "생수", quantity: 2 }],
                lat: 36.35,
                lng: 127.38,
              },
            ],
          })
        ).status,
        201,
      );
      assert.equal((await call("/api/demo/clear", {})).status, 409);
      assert.equal((await call("/api/shipments")).data.length, 26);
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  "PIN 인증부터 전표 검토·배차·실시간 위치·회사 복귀까지 권한과 상태를 검증한다",
  { timeout: 30000 },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "dispatch-api-"));
    const runtime = createDispatchApp({
      dataDir,
      roadRouting: false,
      test: true,
    });
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const address = runtime.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    let adminToken = "";
    const sockets: WebSocket[] = [];
    const call = async (
      path: string,
      body?: any,
      token = adminToken,
      method = body === undefined ? "GET" : "POST",
    ) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(token
            ? { Authorization: `Bearer ${token}` }
            : { "X-No-Token": "1" }),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    };
    try {
      assert.equal((await call("/api/dashboard")).status, 401);
      const setup = await call("/api/setup", {
        name: "테스트 관리자",
        pin: "927461",
      });
      assert.equal(setup.status, 201);
      adminToken = setup.data.token;
      assert.equal(
        (await call("/api/setup", { name: "다른 관리자", pin: "927462" }))
          .status,
        409,
      );
      const d1 = (
          await call("/api/drivers", {
            name: "기사A",
            pin: "783294",
            capacity: 10,
          })
        ).data,
        d2 = (
          await call("/api/drivers", {
            name: "기사B",
            pin: "783295",
            capacity: 10,
          })
        ).data;
      const token1 = (await call("/api/login", { pin: "783294" })).data.token,
        token2 = (await call("/api/login", { pin: "783295" })).data.token;
      assert.equal(
        (await call("/api/dashboard", undefined, token1)).status,
        403,
      );
      const book = new ExcelJS.Workbook(),
        sheet = book.addWorksheet("배송");
      sheet.addRows([
        ["수령인", "배송주소", "품목", "수량", "위도", "경도"],
        ["대전 거래처1", "대전 동구 중앙로 215", "생수", 2, 36.3326, 127.4347],
        ["대전 거래처2", "대전 서구 둔산로 100", "쌀", 1, 36.3504, 127.3848],
        ["대전 거래처3", "대전 유성구 대학로 99", "봉투", 3, 36.3687, 127.3441],
      ]);
      const form = new FormData();
      form.append(
        "file",
        new Blob([Buffer.from(await book.xlsx.writeBuffer())]),
        "deliveries.xlsx",
      );
      form.append("serviceDate", today());
      const response = await fetch(base + "/api/imports", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: form,
      });
      assert.equal(response.status, 201);
      const batch = await response.json();
      assert.equal((await call("/api/imports?date=" + today())).data.length, 1);
      assert.equal((await call("/api/imports?date=2001-01-01")).data.length, 0);
      assert.equal(
        (await call("/api/shipments")).data.length,
        0,
        "검토 전에는 배송지가 생성되면 안 됨",
      );
      assert.equal(
        (
          await call("/api/imports/" + batch.id + "/commit", {
            rows: batch.drafts,
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await call("/api/imports/" + batch.id + "/commit", {
            rows: batch.drafts,
          })
        ).status,
        409,
        "중복 등록 방지",
      );
      const planned = await call("/api/routes/optimize", {
        serviceDate: today(),
      });
      assert.equal(planned.status, 200);
      assert.equal(planned.data.length, 2);
      const route = planned.data.find((r: any) => r.driverId === d1.id);
      assert.deepEqual(route.geometry[0], route.geometry.at(-1));
      assert.ok(route.durationMinutes > 0);
      assert.equal(route.company.name, "우리 회사");
      assert.equal(
        (await call("/api/driver/routes/" + route.id + "/start", {}, token2))
          .status,
        404,
      );
      assert.equal(
        (await call("/api/driver/routes/" + route.id + "/start", {}, token1))
          .status,
        200,
      );
      assert.equal(
        (
          await call(
            "/api/company",
            { ...route.company, name: "변경" },
            adminToken,
            "PUT",
          )
        ).status,
        409,
        "운행 중 출발지 변경 방지",
      );
      assert.equal(
        (
          await call(
            "/api/driver/stops/" + route.stops[0].id + "/complete",
            {},
            token2,
          )
        ).status,
        403,
      );
      const socket = new WebSocket(base.replace("http", "ws") + "/live");
      sockets.push(socket);
      await once(socket, "open");
      const authEvent = once(socket, "message");
      socket.send(JSON.stringify({ type: "auth", token: adminToken }));
      assert.equal(JSON.parse(String((await authEvent)[0])).event, "connected");
      const positionEvent = once(socket, "message");
      const location = {
        lat: 36.334,
        lng: 127.43,
        accuracy: 8,
        speed: 4,
        recordedAt: new Date().toISOString(),
      };
      assert.equal(
        (await call("/api/driver/location", location, token1)).status,
        200,
      );
      const live = JSON.parse(String((await positionEvent)[0]));
      assert.equal(live.event, "position");
      assert.equal(live.driverId, d1.id);
      assert.equal(live.position.lat, 36.334);
      const older = await call(
        "/api/driver/location",
        {
          ...location,
          lat: 36.31,
          recordedAt: new Date(
            Date.parse(location.recordedAt) - 1000,
          ).toISOString(),
        },
        token1,
      );
      assert.equal(older.status, 200);
      assert.equal(
        older.data.ignored,
        true,
        "지연 도착한 좌표가 최신 위치를 덮어쓰지 않음",
      );
      const secondRoute = planned.data.find((r: any) => r.driverId === d2.id);
      assert.equal(
        (
          await call(
            "/api/driver/routes/" + secondRoute.id + "/start",
            {},
            token2,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "/api/driver/location",
            {
              ...location,
              lat: 36.37,
              lng: 127.39,
              recordedAt: new Date().toISOString(),
            },
            token2,
          )
        ).status,
        200,
      );
      const positions = (await call("/api/dashboard")).data.drivers;
      assert.equal(
        positions.find((d: any) => d.id === d1.id).position.lat,
        location.lat,
      );
      assert.equal(
        positions.find((d: any) => d.id === d1.id).position.routeId,
        route.id,
      );
      assert.equal(
        positions.find((d: any) => d.id === d2.id).position.lat,
        36.37,
        "동시에 운행하는 기사별 위치를 분리해서 보존함",
      );
      const own = (await call("/api/me", undefined, token1)).data.route;
      assert.deepEqual(
        own.stops.map((s: any) => s.items),
        route.stops.map((s: any) => s.items),
        "기사에게 배정된 배송지의 물품명과 수량이 그대로 제공됨",
      );
      const stale = {
        ...location,
        recordedAt: new Date(Date.now() - 3600000).toISOString(),
      };
      assert.equal(
        (await call("/api/driver/location", stale, token1)).status,
        400,
      );
      assert.equal(
        (await call("/api/driver/routes/" + route.id + "/return", {}, token1))
          .status,
        409,
      );
      for (let i = 0; i < route.stops.length; i++) {
        const result = await call(
          "/api/driver/stops/" + route.stops[i].id + "/complete",
          { status: i === 0 ? "failed" : "delivered", reason: "수령인 부재" },
          token1,
        );
        assert.equal(result.status, 200);
        if (i === route.stops.length - 1)
          assert.equal(result.data.status, "returning");
      }
      assert.equal(
        (await call("/api/driver/routes/" + route.id + "/return", {}, token1))
          .status,
        200,
      );
      assert.equal(
        (
          await call(
            "/api/driver/location",
            { ...location, recordedAt: new Date().toISOString() },
            token1,
          )
        ).status,
        409,
        "복귀 후 위치 수집 중단",
      );
      const dashboard = (await call("/api/dashboard")).data;
      assert.equal(dashboard.stats.failed, 1);
      assert.equal(
        dashboard.routes.find((r: any) => r.id === route.id).status,
        "completed",
      );
      assert.ok(
        dashboard.shipments.some((s: any) => s.failureReason === "수령인 부재"),
      );
      const original = (await call("/api/imports/" + batch.id + "/original"))
        .data.path;
      assert.equal((await fetch(base + original)).status, 200);
      assert.equal((await call("/api/files/" + batch.id)).status, 403);
      assert.equal(
        (await call("/api/drivers/" + d1.id + "/pin", { pin: "682593" }))
          .status,
        200,
      );
      assert.equal((await call("/api/me", undefined, token1)).status, 401);
      assert.equal((await call("/api/login", { pin: "783294" })).status, 401);
      assert.equal((await call("/api/login", { pin: "682593" })).status, 200);
    } finally {
      for (const socket of sockets) socket.terminate();
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
