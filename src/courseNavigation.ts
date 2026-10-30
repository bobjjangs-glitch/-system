import type { Point, Route, Shipment } from "../server/types.ts";

// Naver's documented /navigation URL supports v1..v5 plus a destination.
// https://guide.ncloud-docs.com/docs/en/maps-url-scheme
export const NAVER_MAX_WAYPOINTS = 5;
function coordinate(point: {
  lat?: number | null;
  lng?: number | null;
}): point is Point {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat! >= 31.43 &&
    point.lat! <= 44.35 &&
    point.lng! >= 122.37 &&
    point.lng! <= 132
  );
}
export function buildCourseNavigation(route: Route, origin?: Point) {
  const remaining = route.stops.filter((stop) => stop.status === "assigned");
  const returnsToCompany = remaining.length <= NAVER_MAX_WAYPOINTS;
  const stops = remaining.slice(0, NAVER_MAX_WAYPOINTS + 1);
  const destination = returnsToCompany ? route.company : stops.at(-1)!;
  const waypoints = returnsToCompany ? stops : stops.slice(0, -1);
  for (const stop of [...stops, destination])
    if (!coordinate(stop))
      throw new Error(
        "배송지 좌표를 확인해 주세요. 네이버 길안내는 국내 좌표가 필요합니다.",
      );
  const parameters: [string, string][] = [
    ["appname", "com.bobjjang.bareundispatch"],
  ];
  const addPoint = (prefix: string, point: Point, name: string) => {
    parameters.push(
      [prefix + "lat", point.lat.toFixed(7)],
      [prefix + "lng", point.lng.toFixed(7)],
      [prefix + "name", name],
    );
  };
  if (origin && coordinate(origin)) addPoint("s", origin, "현재 위치");
  addPoint(
    "d",
    destination as Point,
    returnsToCompany ? route.company.name : (destination as Shipment).recipient,
  );
  waypoints.forEach((stop, index) =>
    addPoint(
      "v" + (index + 1),
      stop as Point,
      `${stop.sequence}번 ${stop.recipient}`,
    ),
  );
  return {
    url:
      "nmap://navigation?" +
      parameters
        .map(([name, value]) => name + "=" + encodeURIComponent(value))
        .join("&"),
    stops,
    returnsToCompany,
    remainingAfterSegment: Math.max(0, remaining.length - stops.length),
    segmentEndStopId: returnsToCompany ? null : stops.at(-1)!.id,
  };
}
