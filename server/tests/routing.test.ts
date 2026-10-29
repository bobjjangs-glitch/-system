import { test } from "node:test";
import assert from "node:assert/strict";
import {
  optimizeAssignments,
  orderStops,
  loopDistance,
  estimateRoute,
} from "../routing.ts";
import { defaultCompany } from "../database.ts";
import type { Shipment, Driver } from "../types.ts";
const drivers: Driver[] = Array.from({ length: 7 }, (_, i) => ({
  id: String(i),
  name: `기사 ${i + 1}`,
  phone: "",
  capacity: i === 0 ? 3 : 10,
  active: true,
}));
const shipments: Shipment[] = Array.from({ length: 53 }, (_, i) => ({
  id: String(i),
  recipient: "배송지",
  address: "대전 예시 주소",
  items: [{ name: "물품", quantity: 2 }],
  serviceDate: "2026-10-28",
  status: "pending",
  routeId: null,
  sequence: null,
  deliveredAt: null,
  failureReason: null,
  importId: null,
  lat: 36.3 + Math.sin(i) * 0.06,
  lng: 127.4 + Math.cos(i) * 0.06,
}));
test("기사 7명·배송지 53곳을 중복이나 누락 없이 각 기사 제한 안에서 배정한다", () => {
  const result = optimizeAssignments(defaultCompany, shipments, drivers);
  assert.equal(result.length, 7);
  assert.equal(
    new Set(result.flatMap((r) => r.stops.map((s) => s.id))).size,
    53,
  );
  assert.equal(
    result.reduce((n, r) => n + r.stops.length, 0),
    53,
  );
  for (const r of result) assert.ok(r.stops.length <= r.driver.capacity);
});
test("좌표 누락과 기사 수용량 부족은 배차를 막는다", () => {
  assert.throws(
    () =>
      optimizeAssignments(
        defaultCompany,
        [{ ...shipments[0], lat: null }],
        drivers,
      ),
    /좌표/,
  );
  assert.throws(
    () => optimizeAssignments(defaultCompany, shipments, [drivers[0]]),
    /최대 배송지/,
  );
});
test("경로 순서 개선은 회사 왕복 거리를 늘리지 않으며 모든 배송지를 보존한다", () => {
  const points = shipments.slice(0, 12) as (Shipment & {
    lat: number;
    lng: number;
  })[];
  const result = orderStops(defaultCompany, points);
  assert.ok(
    loopDistance(defaultCompany, result) <=
      loopDistance(defaultCompany, points),
  );
  assert.deepEqual(
    new Set(result.map((s) => s.id)),
    new Set(points.map((s) => s.id)),
  );
});
test("외부 도로 서비스 없이도 복귀와 배송지 체류 시간을 포함한 추정임을 표시한다", async () => {
  const result = await estimateRoute(
    defaultCompany,
    [{ lat: 36.35, lng: 127.42 }],
    false,
  );
  assert.equal(result.estimateSource, "approximate");
  assert.equal(result.geometry.length, 3);
  assert.deepEqual(result.geometry[0], result.geometry.at(-1));
  assert.ok(result.durationMinutes >= defaultCompany.serviceMinutes);
});
