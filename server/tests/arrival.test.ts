import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArrival, afterAutomaticDelivery } from "../../src/arrival.ts";
import type { ArrivalState } from "../../src/arrival.ts";
import { defaultCompany } from "../database.ts";
import type { Route, Shipment } from "../types.ts";

const time = Date.parse("2026-10-30T01:00:00Z");
const stop = {
  id: "first",
  sequence: 1,
  status: "assigned",
  lat: 36.35,
  lng: 127.38,
  recipient: "테스트 배송지",
  address: "테스트 주소",
  items: [{ name: "생수", quantity: 3 }],
} as Shipment;
const route = {
  id: "route",
  status: "active",
  stops: [stop, { ...stop, id: "second", sequence: 2, lat: 36.36 }],
  company: defaultCompany,
} as Route;
const location = (seconds: number, extra = {}) => ({
  lat: stop.lat!,
  lng: stop.lng!,
  accuracy: 8,
  speed: 0,
  recordedAt: new Date(time + seconds * 1000).toISOString(),
  ...extra,
});

test("도착 반경에서 일정 시간 멈춘 현재 배송지만 자동 완료 대상으로 반환한다", () => {
  let state: ArrivalState = {};
  for (const seconds of [0, 10, 20]) {
    const result = checkArrival(
      route,
      location(seconds),
      state,
      time + seconds * 1000,
    );
    assert.equal(result.stop, undefined);
    state = result.state;
  }
  assert.equal(
    checkArrival(route, location(30), state, time + 30000).stop?.id,
    stop.id,
  );
});
test("위치 오차·속도·좌표 누락·오래된 위치는 자동 완료하지 않는다", () => {
  for (const extra of [
    { accuracy: 100 },
    { speed: 12 },
    { lat: NaN },
    { accuracy: null },
  ])
    assert.equal(
      checkArrival(route, location(0, extra), {}, time).stop,
      undefined,
    );
  assert.equal(
    checkArrival(route, location(0), {}, time + 180000).reason,
    "stale_location",
  );
  assert.equal(
    checkArrival(route, location(0, { lat: 36.4 }), {}, time).reason,
    "outside",
  );
});
test("GPS가 끊겼거나 반경을 벗어나면 체류 시간을 새로 측정한다", () => {
  const first = checkArrival(route, location(0), {}, time).state;
  assert.equal(
    checkArrival(route, location(60), first, time + 60000).state.enteredAt,
    time + 60000,
  );
  const outside = checkArrival(
    route,
    location(10, { lat: 36.4 }),
    first,
    time + 10000,
  ).state;
  assert.equal(
    checkArrival(route, location(30), outside, time + 30000).stop,
    undefined,
  );
});
test("중복·역순 위치와 다른 코스의 후보 상태로 완료를 앞당기지 않는다", () => {
  const first = checkArrival(route, location(10), {}, time + 10000).state;
  assert.equal(
    checkArrival(route, location(10), first, time + 10000).reason,
    "old_sample",
  );
  assert.equal(
    checkArrival(route, location(0), first, time + 10000).reason,
    "old_sample",
  );
  assert.equal(
    checkArrival(
      { ...route, id: "different" },
      location(40),
      first,
      time + 40000,
    ).stop,
    undefined,
  );
});
test("한 곳에서 자동 완료 후 같은 위치의 다음 배송지를 연쇄 완료하지 않는다", () => {
  const state = afterAutomaticDelivery(route.id, stop, location(30).recordedAt);
  const next = {
    ...route,
    stops: [
      { ...stop, status: "delivered" },
      { ...stop, id: "same-building", sequence: 2 },
    ],
  };
  assert.equal(
    checkArrival(next, location(90), state, time + 90000).reason,
    "waiting_for_departure",
  );
});
test("출발 전·회사 복귀 중·복귀 완료 코스는 자동 배송 완료하지 않는다", () => {
  for (const status of ["planned", "returning", "completed"])
    assert.equal(
      checkArrival({ ...route, status }, location(0), {}, time).reason,
      "inactive",
    );
});
