import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createDispatchApp } from "../app.ts";
import { today } from "../database.ts";

test("관리자만 지도 키를 저장하고 운행 중 코스·전표를 보존하며 재시작 후 복원한다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-naver-"));
  let runtime = createDispatchApp({ dataDir, roadRouting: false, test: true });
  const start = async () => {
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    return `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  };
  let base = await start();
  const call = async (path: string, token?: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${token ?? ""}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const admin = (await call("/api/setup", undefined, { name: "지도 관리자", pin: "823619" })).data;
    await call("/api/demo", admin.token, {});
    const routes = (await call("/api/routes/optimize", admin.token, { serviceDate: today() })).data;
    const driverPin = (await call(`/api/drivers/${routes[0].driverId}/pin`, admin.token)).data.pin;
    const driver = (await call("/api/login", undefined, { pin: driverPin })).data;
    await call(`/api/driver/routes/${routes[0].id}/start`, driver.token, {});
    assert.equal((await call("/api/map-settings")).status, 401);
    assert.equal((await call("/api/map-settings", driver.token)).status, 403);
    assert.equal((await call("/api/map-settings", driver.token, { naverKeyId: "testkey123" }, "PUT")).status, 403);
    assert.equal((await call("/api/map-settings", admin.token, { naverKeyId: '<script>alert(1)</script>' }, "PUT")).status, 400);
    assert.equal((await call("/api/map-settings", admin.token, { naverKeyId: " testkey123 " }, "PUT")).status, 200);
    const board = (await call("/api/dashboard", admin.token)).data;
    assert.equal(board.mapSettings.naverKeyId, "testkey123");
    assert.equal(board.routes.length, 5);
    assert.equal(board.shipments.length, 25);
    assert.equal(board.routes.find((r: any) => r.id === routes[0].id).status, "active");
    await runtime.close();
    runtime = createDispatchApp({ dataDir, roadRouting: false, test: true });
    base = await start();
    assert.equal((await call("/api/map-settings", admin.token)).data.naverKeyId, "testkey123");
    assert.equal((await call("/api/routes", admin.token)).data.length, 5);
  } finally {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("네이버 지도 문서는 키를 안전하게 처리하고 배송 데이터·로그인 정보를 포함하지 않는다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-map-document-"));
  const runtime = createDispatchApp({ dataDir, roadRouting: false, test: true });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  try {
    const response = await fetch(base + "/map?provider=naver&keyId=testkey123");
    const document = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(document.includes("ncpKeyId="));
    assert.ok(document.includes("navermap_authFailure"));
    assert.ok(document.includes("strokeStyle"));
    assert.ok(!document.includes("tile.openstreetmap.org"));
    assert.ok(!document.includes("Bearer "));
    const malicious = '<script>alert("xss")</script>';
    const invalid = await fetch(base + "/map?provider=naver&keyId=" + encodeURIComponent(malicious));
    assert.ok(!(await invalid.text()).includes(malicious));
    const basic = await fetch(base + "/map");
    assert.ok((await basic.text()).includes("tile.openstreetmap.org"));
  } finally {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
