import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addressDirectionsUrl,
  addressSearchFallback,
  hasNavigationPoint,
  navigationAddress,
  navigationAddressLabel,
} from "../../src/addressNavigation.ts";

test("주소를 Google 길안내 목적지 하나로 인코딩하고 자동차 내비 모드를 요청한다", () => {
  const address = "대전광역시 동구 물류로14번길 13 & 창고 #2";
  const url = new URL(addressDirectionsUrl("  " + address + "  "));
  assert.equal(url.origin, "https://www.google.com");
  assert.equal(url.pathname, "/maps/dir/");
  assert.equal(url.searchParams.get("api"), "1");
  assert.equal(url.searchParams.get("destination"), address);
  assert.equal(url.searchParams.get("travelmode"), "driving");
  assert.equal(url.searchParams.get("dir_action"), "navigate");
  assert.deepEqual(
    [...url.searchParams.keys()],
    ["api", "destination", "travelmode", "dir_action"],
  );
});

test("네이버와 카카오 주소 검색 대안은 길안내라고 위장하지 않고 주소를 보존한다", () => {
  const address = "대전 동구 중앙로 215, 2층";
  for (const provider of ["naver", "kakao"] as const) {
    const result = addressSearchFallback(provider, address);
    assert.match(result.title, /주소 검색/);
    assert.ok(result.url.endsWith(encodeURIComponent(address)));
    assert.equal(
      new URL(result.url).hostname,
      provider === "naver" ? "map.naver.com" : "map.kakao.com",
    );
  }
});

test("유효한 기존 위치는 그대로 쓰고 주소가 있는 0,0은 빈 위치로 처리한다", () => {
  assert.equal(
    hasNavigationPoint({ lat: 36.2719407, lng: 127.4680343, address: "대전" }),
    true,
  );
  assert.equal(hasNavigationPoint({ lat: 0, lng: 0, address: "대전" }), false);
  assert.equal(hasNavigationPoint({ lat: 0, lng: 0 }), true);
  assert.equal(
    hasNavigationPoint({ lat: 1000, lng: 127, address: "대전" }),
    false,
  );
  assert.equal(
    hasNavigationPoint({ lat: null, lng: null, address: "대전" }),
    false,
  );
  assert.equal(
    hasNavigationPoint({ lat: NaN, lng: 127, address: "대전" }),
    false,
  );
});

test("빈 주소나 URL 제한을 넘는 주소는 엉뚱한 목적지로 자르지 않고 안내한다", () => {
  assert.equal(navigationAddress(undefined), "");
  assert.equal(navigationAddress("  대전 주소  "), "대전 주소");
  assert.throws(() => addressDirectionsUrl("   "), /배송지 주소/);
  assert.throws(() => addressDirectionsUrl("대".repeat(500)), /주소가 너무/);
});

test("브라우저 주소 검색은 수령인 이름보다 실제 배송지 주소를 우선한다", () => {
  assert.equal(
    navigationAddressLabel({
      address: "  대전 동구 중앙로 215  ",
      recipient: "중복될 수 있는 상사명",
    }),
    "대전 동구 중앙로 215",
  );
  assert.equal(navigationAddressLabel({ recipient: "배송지명" }), "배송지명");
  assert.equal(
    navigationAddressLabel({ address: " ", name: "회사명" }),
    "회사명",
  );
});
