import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchApp } from "../app.ts";

const serviceDate = "2026-11-03";
const rows = [
  { recipient: "검증 거래처 가", address: "대전광역시 동구 중앙로 215", items: [{ name: "검증 물품", quantity: 2 }] },
  { recipient: "검증 거래처 나", address: "대전광역시 중구 중앙로 101", items: [{ name: "검증 물품", quantity: 3 }] },
];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bareun-receipt-delete-"));
  const runtime = createDispatchApp({ dataDir: dir, roadRouting: false, test: true });
  const adminPin = String(randomInt(10000000, 49999999));
  const driverPin = String(randomInt(50000000, 99999999));
  runtime.store.createUser("admin", "삭제 검증 관리자", adminPin);
  const driver = runtime.store.createUser("driver", "삭제 검증 기사", driverPin);
  const adminToken = runtime.store.login(adminPin)!.token;
  const driverToken = runtime.store.login(driverPin)!.token;
  const image = await readFile(new URL("./fixtures/receipt.png", import.meta.url));
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
  // Capture the client transport so tests can forbid server-side provider calls.
  const request = fetch;
  async function api(path: string, method: string, body?: unknown, token: string | null = adminToken) {
    const response = await request(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
  async function upload(receiptId: string) {
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(image)], { type: "image/png" }), "receipt.png");
    form.append("recognitionSource", "android-device");
    form.append("recognizedText", "거래처: 검증 거래처\n배송주소: 대전광역시 동구 중앙로 215\n품목: 검증 물품 2");
    form.append("serviceDate", serviceDate);
    form.append("deviceReceiptId", receiptId);
    const response = await request(base + "/api/imports", {
      method: "POST", body: form, headers: { Authorization: "Bearer " + adminToken },
    });
    assert.equal(response.status, 201);
    const data = await response.json();
    const batch = runtime.store.one("SELECT * FROM imports WHERE id=?", data.id);
    return { ...data, path: join(dir, "uploads", batch.storedName) };
  }
  async function commit(importId: string, count = 2) {
    const result = await api("/api/imports/" + importId + "/commit", "POST", { rows: rows.slice(0, count) });
    assert.equal(result.status, 201);
  }
  function route(status: string) {
    const routeId = randomUUID();
    runtime.store.run(
      "INSERT INTO routes(id,driverId,serviceDate,status,distanceKm,durationMinutes,estimateSource,geometry,company) VALUES(?,?,?,?,?,?,?,?,?)",
      routeId, driver.id, serviceDate, status, 3, 24, "approximate", "[]", JSON.stringify(runtime.store.company()),
    );
    return routeId;
  }
  function mappings() {
    return runtime.store.all("SELECT key,value FROM settings WHERE key GLOB 'device-receipt:*' ORDER BY key");
  }
  function snapshot() {
    return JSON.stringify({
      imports: runtime.store.all("SELECT * FROM imports ORDER BY id"),
      shipments: runtime.store.all("SELECT * FROM shipments ORDER BY id"),
      settings: runtime.store.all("SELECT * FROM settings ORDER BY key"),
      routes: runtime.store.all("SELECT * FROM routes ORDER BY id"),
      users: runtime.store.all("SELECT * FROM users ORDER BY id"),
    });
  }
  return {
    dir, runtime, image, driverToken, adminPin, driverPin,
    api, upload, commit, route, mappings, snapshot,
    close: async () => { await runtime.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test("전표 한 건과 연결된 미배차 배송지만 삭제하고 다른 전표·코스·기사 PIN은 보존한다", async () => {
  const f = await fixture();
  try {
    const target = await f.upload("delete-this-receipt");
    const other = await f.upload("keep-this-receipt");
    await f.commit(target.id);
    await f.commit(other.id, 1);
    const routeId = f.route("active");
    f.runtime.store.run("UPDATE shipments SET routeId=?,status='assigned',sequence=1 WHERE importId=?", routeId, other.id);
    const preserved = {
      batch: f.runtime.store.one("SELECT * FROM imports WHERE id=?", other.id),
      shipments: f.runtime.store.all("SELECT * FROM shipments WHERE importId=?", other.id),
      routes: f.runtime.store.all("SELECT * FROM routes"),
      users: f.runtime.store.all("SELECT * FROM users ORDER BY id"),
    };
    const otherMapping = f.mappings().find((setting) => JSON.parse(setting.value).importId === other.id)!;
    f.runtime.store.run("INSERT INTO settings(key,value) VALUES(?,?)", "device-receipt:matching-alias", JSON.stringify({ importId: target.id }));
    f.runtime.store.run("INSERT INTO settings(key,value) VALUES(?,?)", "device-receipt:malformed", "{broken json");
    f.runtime.store.run("INSERT INTO settings(key,value) VALUES(?,?)", "unrelated-receipt-setting", JSON.stringify({ importId: target.id }));
    const result = await f.api("/api/imports/" + target.id, "DELETE");
    assert.deepEqual(result, { status: 200, data: { ok: true, deletedShipments: 2 } });
    assert.equal(f.runtime.store.one("SELECT * FROM imports WHERE id=?", target.id), undefined);
    assert.equal(f.runtime.store.one("SELECT * FROM shipments WHERE importId=?", target.id), undefined);
    assert.equal(existsSync(target.path), false);
    assert.deepEqual(await readFile(other.path), f.image);
    assert.deepEqual({
      batch: f.runtime.store.one("SELECT * FROM imports WHERE id=?", other.id),
      shipments: f.runtime.store.all("SELECT * FROM shipments WHERE importId=?", other.id),
      routes: f.runtime.store.all("SELECT * FROM routes"),
      users: f.runtime.store.all("SELECT * FROM users ORDER BY id"),
    }, preserved);
    assert.deepEqual(f.runtime.store.one("SELECT * FROM settings WHERE key=?", otherMapping.key), otherMapping);
    assert.equal(f.runtime.store.one("SELECT * FROM settings WHERE key='device-receipt:matching-alias'"), undefined);
    assert.equal(f.runtime.store.one("SELECT value FROM settings WHERE key='device-receipt:malformed'")!.value, "{broken json");
    assert.ok(f.runtime.store.one("SELECT * FROM settings WHERE key='unrelated-receipt-setting'"));
    assert.ok(f.runtime.store.login(f.adminPin));
    assert.ok(f.runtime.store.login(f.driverPin));
    assert.equal((await f.api("/api/imports/" + target.id + "/original", "GET")).status, 404);
    const fresh = await f.upload("delete-this-receipt");
    assert.notEqual(fresh.id, target.id);
    assert.equal(fresh.status, "review");
    assert.equal((await f.upload("delete-this-receipt")).id, fresh.id);
  } finally { await f.close(); }
});

test("검토 중인 전표 삭제는 관리자만 가능하며 없는 전표는 404로 응답한다", async () => {
  const f = await fixture();
  try {
    const batch = await f.upload("review-delete");
    const before = f.snapshot();
    assert.equal((await f.api("/api/imports/" + batch.id, "DELETE", undefined, null)).status, 401);
    assert.equal((await f.api("/api/imports/" + batch.id, "DELETE", undefined, f.driverToken)).status, 403);
    assert.equal((await f.api("/api/imports/" + randomUUID(), "DELETE")).status, 404);
    assert.equal(f.snapshot(), before);
    assert.deepEqual(await readFile(batch.path), f.image);
    assert.deepEqual(await f.api("/api/imports/" + batch.id, "DELETE"), {
      status: 200, data: { ok: true, deletedShipments: 0 },
    });
    assert.equal(existsSync(batch.path), false);
    assert.equal((await f.api("/api/imports/" + batch.id, "DELETE")).status, 404);
  } finally { await f.close(); }
});

test("배차·운행·완료·실패한 배송지가 하나라도 있으면 전표 전체를 변경 없이 거부한다", async (t) => {
  const f = await fixture();
  try {
    const cases = [
      { shipment: "assigned", route: "planned" },
      { shipment: "assigned", route: "active" },
      { shipment: "assigned", route: "returning" },
      { shipment: "delivered", route: "completed" },
      { shipment: "failed", route: "completed" },
      { shipment: "pending", route: "planned" },
      { shipment: "assigned", route: null },
      { shipment: "delivered", route: null },
      { shipment: "failed", route: null },
    ];
    const batches = [];
    for (const [i, state] of cases.entries()) {
      const batch = await f.upload("used-receipt-" + i);
      await f.commit(batch.id);
      const shipment = f.runtime.store.one("SELECT id FROM shipments WHERE importId=? LIMIT 1", batch.id);
      f.runtime.store.run("UPDATE shipments SET status=?,routeId=? WHERE id=?", state.shipment, state.route ? f.route(state.route) : null, shipment.id);
      batches.push(batch);
    }
    const before = f.snapshot();
    let providerCalls = 0;
    t.mock.method(globalThis, "fetch", async () => { providerCalls++; throw new Error("삭제 중 외부 경로 API 호출 금지"); });
    for (const batch of batches) {
      const result = await f.api("/api/imports/" + batch.id, "DELETE");
      assert.equal(result.status, 409);
      assert.match(result.data.error, /배차|운행|배송/);
      assert.equal(f.snapshot(), before);
      assert.deepEqual(await readFile(batch.path), f.image);
    }
    assert.equal(providerCalls, 0);
  } finally { await f.close(); }
});

test("원본 유실·파일 정리 실패에도 DB 삭제를 완료하고 업로드 디렉터리 밖의 파일은 건드리지 않는다", async (t) => {
  const f = await fixture();
  try {
    const missing = await f.upload("missing-original");
    await rm(missing.path);
    assert.equal((await f.api("/api/imports/" + missing.id, "DELETE")).status, 200);
    assert.equal(f.runtime.store.one("SELECT id FROM imports WHERE id=?", missing.id), undefined);

    const escaped = await f.upload("escaped-original");
    const outside = join(f.dir, "outside-original.png");
    await writeFile(outside, "must remain outside uploads");
    f.runtime.store.run("UPDATE imports SET storedName=? WHERE id=?", "../outside-original.png", escaped.id);
    assert.equal((await f.api("/api/imports/" + escaped.id, "DELETE")).status, 200);
    assert.equal(await readFile(outside, "utf8"), "must remain outside uploads");

    const inaccessible = await f.upload("cleanup-error");
    await f.commit(inaccessible.id, 1);
    await rm(inaccessible.path);
    await mkdir(inaccessible.path);
    const log = t.mock.method(console, "error", () => {});
    assert.deepEqual(await f.api("/api/imports/" + inaccessible.id, "DELETE"), {
      status: 200, data: { ok: true, deletedShipments: 1 },
    });
    assert.equal(log.mock.callCount(), 1);
    assert.equal(f.runtime.store.one("SELECT id FROM imports WHERE id=?", inaccessible.id), undefined);
    assert.equal(f.runtime.store.one("SELECT id FROM shipments WHERE importId=?", inaccessible.id), undefined);
    assert.equal(f.mappings().some((setting) => JSON.parse(setting.value).importId === inaccessible.id), false);
  } finally { await f.close(); }
});

test("배송지 단건 삭제는 미배차 한 곳만 지우고 전표·다른 배송지·코스를 보존한다", async () => {
  const f = await fixture();
  try {
    const batch = await f.upload("delete-single-shipment");
    await f.commit(batch.id);
    const [target, routed] = f.runtime.store.all("SELECT * FROM shipments WHERE importId=? ORDER BY id", batch.id);
    const routeId = f.route("planned");
    // Even a pending status must not permit deletion while it references a route.
    f.runtime.store.run("UPDATE shipments SET routeId=?,sequence=1 WHERE id=?", routeId, routed.id);
    const before = f.snapshot();
    assert.equal((await f.api("/api/shipments/" + routed.id, "DELETE")).status, 409);
    assert.equal(f.snapshot(), before);
    assert.equal((await f.api("/api/shipments/" + target.id, "DELETE", undefined, f.driverToken)).status, 403);
    const preservedBatch = f.runtime.store.one("SELECT * FROM imports WHERE id=?", batch.id);
    const preservedRoutes = f.runtime.store.all("SELECT * FROM routes");
    const preservedShipment = f.runtime.store.one("SELECT * FROM shipments WHERE id=?", routed.id);
    assert.deepEqual(await f.api("/api/shipments/" + target.id, "DELETE"), { status: 200, data: { ok: true } });
    assert.equal(f.runtime.store.one("SELECT * FROM shipments WHERE id=?", target.id), undefined);
    assert.deepEqual(f.runtime.store.one("SELECT * FROM shipments WHERE id=?", routed.id), preservedShipment);
    assert.deepEqual(f.runtime.store.one("SELECT * FROM imports WHERE id=?", batch.id), preservedBatch);
    assert.deepEqual(f.runtime.store.all("SELECT * FROM routes"), preservedRoutes);
    assert.deepEqual(await readFile(batch.path), f.image);
    assert.equal((await f.api("/api/shipments/" + target.id, "DELETE")).status, 404);
  } finally { await f.close(); }
});
