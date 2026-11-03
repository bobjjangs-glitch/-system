import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, defaultCompany, COMPANY_PRESET_KEY, today } from "../database.ts";

test("넘버원타이어 설정 적용 시 미완료 코스의 순서·상태·로그인을 보존하고 회사 왕복과 10분 체류를 갱신한다", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "dispatch-company-preset-"));
  let store = new Store(dataDir);
  try {
    const driver = store.createUser("driver", "검증 기사", "781629");
    const login = store.login("781629")!;
    const legacy = { ...defaultCompany, name: "이전 회사", address: "대전광역시 중구 중앙로 101", lat: 36.3277, lng: 127.4204, serviceMinutes: 5 };
    store.run("UPDATE settings SET value=? WHERE key='company'", JSON.stringify(legacy));
    for (const [index, status] of ["planned", "active", "returning", "completed"].entries()) {
      const id = "route-" + index;
      store.run("INSERT INTO routes(id,driverId,serviceDate,status,distanceKm,durationMinutes,estimateSource,geometry,company) VALUES(?,?,?,?,?,?,?,?,?)", id, driver.id, today(), status, 4, 15, "road", JSON.stringify([legacy, { lat: 36.31, lng: 127.41 }, legacy]), JSON.stringify(legacy));
      for (let sequence = 1; sequence <= 2; sequence++)
        store.run("INSERT INTO shipments(id,recipient,address,items,serviceDate,status,routeId,sequence,lat,lng,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id + "-" + sequence, "배송지", "예시 주소", "[]", today(), status === "completed" || sequence === 1 ? "delivered" : "assigned", id, sequence, 36.31 + sequence / 1000, 127.41, new Date().toISOString());
    }
    const before = store.all("SELECT id,routeId,sequence,status FROM shipments ORDER BY id");
    store.run("DELETE FROM settings WHERE key=?", COMPANY_PRESET_KEY);
    store.close();
    store = new Store(dataDir);
    assert.deepEqual(store.company(), defaultCompany);
    assert.equal(defaultCompany.lat, 36.2719407);
    assert.equal(defaultCompany.lng, 127.4680343);
    assert.deepEqual(store.all("SELECT id,routeId,sequence,status FROM shipments ORDER BY id"), before);
    assert.equal(store.session(login.token)?.userId, driver.id);
    assert.ok(store.login("781629"));
    for (const route of store.routes(today()).filter(r => r.status !== "completed")) {
      assert.deepEqual(route.company, defaultCompany);
      assert.deepEqual(route.geometry[0], defaultCompany);
      assert.deepEqual(route.geometry.at(-1), defaultCompany);
      assert.equal(route.estimateSource, "approximate");
      assert.ok(route.durationMinutes >= 20);
    }
    const completed = store.routes(today()).find(r => r.status === "completed")!;
    assert.deepEqual(completed.company, legacy);
    assert.equal(completed.estimateSource, "road");
    assert.equal(completed.durationMinutes, 15);
    const cached = store.one<{ lat: number; lng: number }>("SELECT lat,lng FROM geocodes WHERE address=?", defaultCompany.address)!;
    assert.equal(cached.lat, defaultCompany.lat);
    assert.equal(cached.lng, defaultCompany.lng);
    const customized = { ...defaultCompany, serviceMinutes: 12 };
    store.run("UPDATE settings SET value=? WHERE key='company'", JSON.stringify(customized));
    store.close();
    store = new Store(dataDir);
    assert.equal(store.company().serviceMinutes, 12, "preset must not overwrite a later admin setting on every restart");
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
