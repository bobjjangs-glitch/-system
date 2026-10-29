import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createDispatchApp } from "../app.ts";
import { Store } from "../database.ts";

test("기사 PIN은 관리자만 조회하고 암호화 보관하며 재발급 시 조회 값과 로그인을 함께 갱신한다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-pin-access-"));
  const runtime = createDispatchApp({ dataDir, roadRouting: false, test: true });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = `http://127.0.0.1:${(runtime.server.address() as { port: number }).port}`;
  const adminPin = "940517280631", initialPin = "072154390864", nextPin = "083264501975";
  const admin = runtime.store.createUser("admin", "관리자", adminPin);
  const driver = runtime.store.createUser("driver", "기사", initialPin);
  const other = runtime.store.createUser("driver", "다른 기사", "072154390865");
  const adminToken = runtime.store.login(adminPin)!.token;
  const driverToken = runtime.store.login(initialPin)!.token;
  const call = async (path: string, token = "", body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  try {
    const path = "/api/drivers/" + driver.id + "/pin";
    assert.equal((await call(path)).status, 401);
    assert.equal((await call(path, driverToken)).status, 403);
    assert.equal((await call("/api/drivers/" + admin.id + "/pin", adminToken)).status, 404);
    const viewed = await call(path, adminToken);
    assert.equal(viewed.status, 200);
    assert.ok(viewed.data.pin === initialPin);
    assert.equal(viewed.headers.get("cache-control"), "no-store");
    assert.equal((await call("/api/me", driverToken)).status, 200, "조회만으로 기사 로그인을 취소하면 안 됨");
    const encrypted = runtime.store.one("SELECT pinEncrypted FROM users WHERE id=?", driver.id)!.pinEncrypted as string;
    assert.ok(encrypted !== initialPin && !encrypted.includes(initialPin));
    assert.equal(encrypted.split(".")[0], "v1");
    assert.equal(runtime.store.one("SELECT pinEncrypted FROM users WHERE id=?", admin.id)!.pinEncrypted, null);
    const listed = JSON.stringify((await call("/api/drivers", adminToken)).data);
    assert.ok(!listed.includes(initialPin) && !listed.includes("pinEncrypted"));
    const changed = await call(path, adminToken, { pin: nextPin });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get("cache-control"), "no-store");
    assert.ok((await call(path, adminToken)).data.pin === nextPin);
    assert.equal((await call("/api/login", "", { pin: initialPin })).status, 401);
    assert.equal((await call("/api/login", "", { pin: nextPin })).status, 200);
    assert.equal((await call("/api/me", driverToken)).status, 401);
    const currentSecret = runtime.store.one("SELECT pinEncrypted FROM users WHERE id=?", driver.id)!.pinEncrypted;
    runtime.store.run("UPDATE users SET pinEncrypted=? WHERE id=?", encrypted, driver.id);
    assert.equal((await call(path, adminToken)).status, 400, "이전 PIN의 암호문을 현재 PIN으로 보여주면 안 됨");
    runtime.store.run("UPDATE users SET pinEncrypted=? WHERE id=?", currentSecret, driver.id);
    runtime.store.run("UPDATE users SET pinEncrypted=NULL WHERE id=?", other.id);
    assert.equal((await call("/api/drivers/" + other.id + "/pin", adminToken)).data.pin, null);
    // Authentication binds the ciphertext to a specific driver, so swapping rows fails closed.
    const secret = runtime.store.one("SELECT pinEncrypted FROM users WHERE id=?", driver.id)!.pinEncrypted;
    runtime.store.run("UPDATE users SET pinEncrypted=? WHERE id=?", secret, other.id);
    const swapped = await call("/api/drivers/" + other.id + "/pin", adminToken);
    assert.equal(swapped.status, 400);
    assert.equal(swapped.data.error, "PIN 정보를 읽을 수 없습니다. 새 PIN을 발급해 주세요.");
  } finally {
    await runtime.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("기존 DB의 PIN을 변경하지 않고 마이그레이션하며 정상 기사 로그인 후 조회·재시작 복원을 지원한다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-pin-upgrade-"));
  let store: Store | undefined;
  const pin = "061538204927";
  try {
    store = new Store(dataDir);
    const driver = store.createUser("driver", "기존 기사", pin);
    // Recreate the previous schema: hashes and IDs exist, recoverable PINs do not.
    store.db.exec("ALTER TABLE users DROP COLUMN pinEncrypted");
    store.close();
    store = undefined;
    store = new Store(dataDir);
    assert.equal(store.driverPin(driver.id), null);
    assert.equal(store.login("061538204928"), null);
    assert.equal(store.driverPin(driver.id), null, "실패한 로그인은 PIN 복구 정보를 만들면 안 됨");
    assert.ok(store.login(pin)?.user.userId === driver.id);
    assert.ok(store.driverPin(driver.id) === pin);
    const ciphertext = store.one("SELECT pinEncrypted FROM users WHERE id=?", driver.id)!.pinEncrypted as string;
    assert.ok(ciphertext !== pin && !ciphertext.includes(pin));
    store.close();
    store = undefined;
    store = new Store(dataDir);
    assert.ok(store.driverPin(driver.id) === pin);
    assert.ok(store.login(pin)?.user.userId === driver.id);
  } finally {
    store?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
