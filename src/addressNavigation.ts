import { isPoint } from "../server/types.ts";
import type { Point } from "../server/types.ts";

export type NavigationDestination = {
  lat?: number | null;
  lng?: number | null;
  id?: string;
  address?: string;
  recipient?: string;
  name?: string;
};

export function navigationAddress(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function navigationAddressLabel(
  destination: NavigationDestination,
): string {
  return (
    navigationAddress(destination.address) ||
    destination.recipient ||
    destination.name ||
    "배송지"
  );
}

export function hasNavigationPoint(
  destination: NavigationDestination,
): destination is NavigationDestination & Point {
  const address = navigationAddress(destination.address);
  if (!isPoint(destination)) return false;
  // Older address-only imports sometimes stored zero instead of an empty field.
  return !(destination.lat === 0 && destination.lng === 0 && address);
}

export function addressDirectionsUrl(address: string): string {
  const value = navigationAddress(address);
  if (!value) throw new Error("배송지 주소를 입력해 주세요.");
  // Google's documented Directions URL accepts an address as destination.
  // It uses the current location as origin and opens navigation where possible.
  const url =
    "https://www.google.com/maps/dir/?api=1&destination=" +
    encodeURIComponent(value) +
    "&travelmode=driving&dir_action=navigate";
  if (url.length > 2048)
    throw new Error("주소가 너무 깁니다. 배송지 주소를 확인해 주세요.");
  return url;
}

export function addressSearchFallback(
  navigation: "naver" | "kakao" | "default",
  address: string,
): { title: string; url: string } {
  const value = navigationAddress(address);
  if (!value) throw new Error("배송지 주소를 입력해 주세요.");
  if (navigation === "kakao")
    return {
      title: "카카오 주소 검색",
      url: "https://map.kakao.com/link/search/" + encodeURIComponent(value),
    };
  return {
    title: "네이버 주소 검색",
    url: "https://map.naver.com/p/search/" + encodeURIComponent(value),
  };
}
