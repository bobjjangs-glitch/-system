import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const key = "bareun-dispatch-driver-automation-v2";
async function setup(t: TestContext) {
  const memory = new Map<string, string>(),
    calls: { path: string; body: any }[] = [],
    notices: any[] = [];
  const state = {
    now: Date.now() - 30000,
    appState: "background",
    os: "android",
    delay: 0,
    denied: false,
  };
  const stop = {
    id: "first",
    sequence: 1,
    status: "assigned",
    lat: 36.33,
    lng: 127.43,
    recipient: "예시 배송지",
    address: "대전 동구 검증로 1",
    items: [{ name: "물품", quantity: 2 }],
  };
  const route = {
    id: "route-one",
    status: "active",
    stops: [stop, { ...stop, id: "second", sequence: 2, lat: 36.34 }],
    company: { lat: 36.3, lng: 127.4 },
  };
  const env = { memory, calls, notices, state };
  (globalThis as any).__arrivalTest = env;
  const unique = Math.random();
  const source = (text: string) =>
    "data:text/javascript," + encodeURIComponent(text) + "#" + unique;
  const hooks = registerHooks({
    resolve(spec, context, next) {
      if (context.parentURL?.includes("driverAutomation.ts")) {
        const code =
          spec === "react-native"
            ? `const e=globalThis.__arrivalTest;export const Platform={get OS(){return e.state.os}};export const AppState={get currentState(){return e.state.appState}};`
            : spec === "expo-secure-store"
              ? `const e=globalThis.__arrivalTest;export const getItemAsync=async k=>e.memory.get(k)??null;export const setItemAsync=async(k,v)=>{e.memory.set(k,v)};export const deleteItemAsync=async k=>{e.memory.delete(k)};`
              : spec === "expo-notifications"
                ? `const e=globalThis.__arrivalTest;export const setNotificationHandler=()=>{};export const AndroidImportance={HIGH:4};export const setNotificationChannelAsync=async()=>{};export const setNotificationCategoryAsync=async()=>{};export const getPermissionsAsync=async()=>({granted:true});export const requestPermissionsAsync=getPermissionsAsync;export const scheduleNotificationAsync=async v=>{e.notices.push(v)};export const dismissNotificationAsync=async id=>{};`
                : spec === "./api"
                  ? `export const API_URL='https://dispatch.example';export const SESSION_KEY='session';export const getSession=()=>({token:'test-token',user:{role:'driver'}});`
                  : null;
        if (code !== null) return { url: source(code), shortCircuit: true };
        if (spec === "./arrival")
          return {
            url: new URL("../../src/arrival.ts", import.meta.url).href,
            shortCircuit: true,
          };
      }
      return next(spec, context);
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
    if (state.denied) return new Response("{}", { status: 401 });
    assert.ok(
      !path.endsWith("/complete"),
      "GPS must never complete a delivery",
    );
    return new Response(
      JSON.stringify(path === "/api/me" ? { route } : { ok: true }),
      { status: 200 },
    );
  };
  t.mock.method(Date, "now", () => state.now);
  memory.set(
    "session",
    JSON.stringify({ token: "test-token", apiUrl: "https://dispatch.example" }),
  );
  const module = await import(
    "../../src/driverAutomation.ts?test=" + Math.random()
  );
  t.after(() => {
    hooks.deregister();
    globalThis.fetch = originalFetch;
    delete (globalThis as any).__arrivalTest;
  });
  await module.configureDriverAutomation(route.id, true);
  const gps = (seconds: number) => {
    state.now += seconds * 1000;
    return {
      lat: 36.33,
      lng: 127.43,
      accuracy: 5,
      speed: 0,
      recordedAt: new Date(state.now).toISOString(),
    };
  };
  return { module, state, route, stop, memory, calls, notices, gps };
}
test("GPS 도착은 확인 요청과 알림만 저장하고 배송완료 API를 호출하지 않는다", async (t) => {
  const e = await setup(t);
  for (const sec of [0, 10, 10, 10])
    await e.module.handleDriverLocation(e.gps(sec), true);
  assert.equal(
    (await e.module.getDriverAutomation()).pendingArrival.stopId,
    e.stop.id,
  );
  assert.equal(e.notices.length, 1);
  assert.equal(e.notices[0].content.data.dispatchAction, "confirm-arrival");
  assert.equal(e.route.stops[0].status, "assigned");
  await e.module.handleDriverLocation(e.gps(10), true);
  assert.equal(e.notices.length, 1);
  assert.equal(e.calls.filter((c) => c.path.endsWith("/complete")).length, 0);
});
test("기사 확인 뒤 다음 코스 요청을 보관하고 완료한 장소에서 다음 배송지를 연쇄 처리하지 않는다", async (t) => {
  const e = await setup(t);
  for (const sec of [0, 10, 10, 10])
    await e.module.handleDriverLocation(e.gps(sec), true);
  e.route.stops[0].status = "delivered";
  await e.module.recordHandledStop(e.route.id, e.stop as any);
  let settings = await e.module.getDriverAutomation();
  assert.equal(settings.pendingArrival, undefined);
  assert.equal(settings.pendingNavigation.completedStopId, e.stop.id);
  await e.module.clearPendingNavigation(e.route.id);
  assert.equal(
    (await e.module.getDriverAutomation()).pendingNavigation,
    undefined,
  );
});
test("앱을 보는 동안에는 확인창 이벤트만 보내고 중복 도착 알림을 만들지 않는다", async (t) => {
  const e = await setup(t);
  e.state.appState = "active";
  let count = 0;
  const off = e.module.subscribeDriverArrival(() => count++);
  for (const sec of [0, 10, 10, 10])
    await e.module.handleDriverLocation(e.gps(sec), false);
  assert.equal(e.notices.length, 0);
  assert.ok(count > 0);
  assert.ok((await e.module.getDriverAutomation()).pendingArrival);
  off();
});
test("나중에 확인을 누르면 도착 요청을 지우고 즉시 반복해서 묻지 않는다", async (t) => {
  const e = await setup(t);
  for (const sec of [0, 10, 10, 10])
    await e.module.handleDriverLocation(e.gps(sec), true);
  await e.module.dismissDriverArrival(e.route.id, e.stop.id);
  for (const sec of [10, 10, 10])
    await e.module.handleDriverLocation(e.gps(sec), true);
  assert.equal(
    (await e.module.getDriverAutomation()).pendingArrival,
    undefined,
  );
  assert.equal(e.notices.length, 1);
});
test("네트워크가 느리면 오래된 GPS를 모두 쌓지 않고 최신 위치를 전송한다", async (t) => {
  const e = await setup(t);
  e.state.delay = 20;
  const updates = [e.module.handleDriverLocation(e.gps(0), true)];
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 8; i++)
    updates.push(e.module.handleDriverLocation(e.gps(1), true));
  await Promise.all(updates);
  const uploads = e.calls.filter((c) => c.path === "/api/driver/location");
  assert.equal(uploads.length, 2);
  assert.equal(
    uploads.at(-1)!.body.recordedAt,
    new Date(e.state.now).toISOString(),
  );
});
test("업데이트 전의 미확인 자동완료 요청은 다시 보내지 않으며 인증 실패 시 중단한다", async (t) => {
  const e = await setup(t);
  const old = await e.module.getDriverAutomation();
  old.pendingCompletion = {
    stopId: e.stop.id,
    point: { lat: 36.33, lng: 127.43 },
    at: new Date(e.state.now).toISOString(),
  };
  e.memory.set(key, JSON.stringify(old));
  await e.module.handleDriverLocation(e.gps(0), true);
  assert.equal(
    (await e.module.getDriverAutomation()).pendingCompletion,
    undefined,
  );
  e.state.denied = true;
  assert.equal(
    (await e.module.handleDriverLocation(e.gps(10), true)).stop,
    true,
  );
});

test("앱에서 확인하지 않은 도착은 앱을 닫아도 한 번 알림으로 이어진다", async (t) => {
  const e = await setup(t);
  e.state.appState = "active";
  for (const sec of [0, 10, 10, 10])
    await e.module.handleDriverLocation(e.gps(sec), false);
  assert.equal(e.notices.length, 0);
  e.state.appState = "background";
  await e.module.handleDriverLocation(e.gps(10), true);
  assert.equal(e.notices.length, 1);
  assert.equal(
    (await e.module.getDriverAutomation()).pendingArrival.notified,
    true,
  );
  await e.module.handleDriverLocation(e.gps(10), true);
  assert.equal(e.notices.length, 1);
  assert.equal(e.route.stops[0].status, "assigned");
});
