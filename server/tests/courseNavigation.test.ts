import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCourseNavigation } from "../../src/courseNavigation.ts";
import { defaultCompany } from "../database.ts";
import type { Route, Shipment } from "../types.ts";
function route(count: number) {
  return {
    id: "route",
    status: "active",
    company: defaultCompany,
    stops: Array.from(
      { length: count },
      (_, index) =>
        ({
          id: "stop-" + index,
          sequence: index + 1,
          status: "assigned",
          lat: 36.34 + index * 0.001,
          lng: 127.38,
          recipient: "거래처 " + (index + 1),
        }) as Shipment,
    ),
  } as Route;
}
test("배송지 5곳과 회사 복귀를 하나의 내비 경로에 순서대로 넣는다", () => {
  const result = buildCourseNavigation(route(5));
  const url = new URL(result.url);
  assert.equal(url.protocol, "nmap:");
  assert.equal(url.hostname, "navigation");
  assert.equal(url.searchParams.get("dlat"), defaultCompany.lat.toFixed(7));
  for (let index = 1; index <= 5; index++)
    assert.equal(
      url.searchParams.get(`v${index}name`),
      `${index}번 거래처 ${index}`,
    );
  assert.equal(url.searchParams.has("v6lat"), false);
  assert.equal(result.returnsToCompany, true);
  assert.equal(result.remainingAfterSegment, 0);
});
test("긴 코스는 공식 경유지 한도 안에서 구간으로 나누고 누락 없이 회사로 복귀한다", () => {
  const original = route(10),
    first = buildCourseNavigation(original);
  assert.equal(first.stops.length, 6);
  assert.equal(first.remainingAfterSegment, 4);
  assert.equal(first.segmentEndStopId, "stop-5");
  const next = buildCourseNavigation({
    ...original,
    stops: original.stops.map((s, i) =>
      i < 6 ? { ...s, status: "delivered" } : s,
    ),
  });
  assert.equal(next.stops.length, 4);
  assert.equal(next.returnsToCompany, true);
  assert.deepEqual(
    [...first.stops, ...next.stops].map((s) => s.id),
    original.stops.map((s) => s.id),
  );
});
test("배송지 15곳을 세 구간으로 이어 안내하고 중복·누락 없이 모두 완료한 뒤 회사로 복귀한다", () => {
  const current = route(15);
  const originalIds = current.stops.map((stop) => stop.id);
  const completedIds: string[] = [];
  const expectedSegments = [
    [1, 2, 3, 4, 5, 6],
    [7, 8, 9, 10, 11, 12],
    [13, 14, 15],
  ];
  const plans: ReturnType<typeof buildCourseNavigation>[] = [];
  while (current.stops.some((stop) => stop.status === "assigned")) {
    const segmentIndex = plans.length;
    const sequences = expectedSegments[segmentIndex];
    assert.ok(
      sequences,
      "예상한 세 구간 이후 추가 안내가 필요하지 않아야 합니다.",
    );
    const plan = buildCourseNavigation(current);
    const url = new URL(plan.url);
    const final = segmentIndex === expectedSegments.length - 1;
    assert.deepEqual(
      plan.stops.map((stop) => stop.sequence),
      sequences,
    );
    assert.equal(plan.returnsToCompany, final);
    assert.equal(plan.remainingAfterSegment, [9, 3, 0][segmentIndex]);
    assert.equal(plan.segmentEndStopId, final ? null : plan.stops.at(-1)!.id);
    assert.equal(url.searchParams.has("v6lat"), false);
    const viaStops = final ? plan.stops : plan.stops.slice(0, -1);
    assert.equal(
      [...url.searchParams.keys()].filter((key) => /^v\d+lat$/.test(key))
        .length,
      viaStops.length,
    );
    viaStops.forEach((stop, index) => {
      assert.equal(
        url.searchParams.get(`v${index + 1}lat`),
        stop.lat!.toFixed(7),
      );
      assert.equal(
        url.searchParams.get(`v${index + 1}name`),
        `${stop.sequence}번 ${stop.recipient}`,
      );
    });
    const destination = final ? current.company : plan.stops.at(-1)!;
    assert.equal(url.searchParams.get("dlat"), destination.lat!.toFixed(7));
    assert.equal(url.searchParams.get("dlng"), destination.lng!.toFixed(7));
    assert.equal(
      url.searchParams.get("dname"),
      final ? current.company.name : plan.stops.at(-1)!.recipient,
    );
    for (const stop of plan.stops) {
      assert.equal(stop.status, "assigned");
      assert.equal(completedIds.includes(stop.id), false);
      current.stops.find((candidate) => candidate.id === stop.id)!.status =
        "delivered";
      completedIds.push(stop.id);
    }
    plans.push(plan);
  }
  assert.equal(plans.length, 3);
  assert.deepEqual(completedIds, originalIds);
  assert.equal(new Set(completedIds).size, 15);
  assert.ok(current.stops.every((stop) => stop.status === "delivered"));
});
test("완료·미배송 지점을 제외하며 남은 배송지가 없으면 회사만 안내한다", () => {
  const original = route(3);
  const result = buildCourseNavigation({
    ...original,
    stops: original.stops.map((s) => ({ ...s, status: "delivered" })),
  });
  assert.equal(result.stops.length, 0);
  assert.equal(result.returnsToCompany, true);
  assert.equal(new URL(result.url).searchParams.has("v1lat"), false);
});
test("잘못된 좌표는 잘못된 외부 내비 URL을 열기 전에 거부한다", () => {
  const original = route(1);
  original.stops[0].lat = null;
  assert.throws(() => buildCourseNavigation(original), /좌표/);
});
