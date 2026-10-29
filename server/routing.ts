import type { Company, Driver, Point, Shipment } from "./types.ts";
import { isPoint } from "./types.ts";

export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad,
    dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function loopDistance(depot: Point, stops: Point[]): number {
  return [depot, ...stops, depot].reduce(
    (sum, p, i, all) => (i ? sum + distanceKm(all[i - 1], p) : 0),
    0,
  );
}
type LocatedShipment = Shipment & Point;
export function orderStops<T extends Point>(depot: Point, points: T[]): T[] {
  const remaining = [...points],
    ordered: T[] = [];
  let current = depot;
  while (remaining.length) {
    let next = 0;
    remaining.forEach((p, i) => {
      if (distanceKm(current, p) < distanceKm(current, remaining[next]))
        next = i;
    });
    const [p] = remaining.splice(next, 1);
    ordered.push(p);
    current = p;
  }
  // 2-opt includes both the company departure and the return leg.
  for (let pass = 0; pass < 30; pass++) {
    let improved = false;
    for (let i = 0; i < ordered.length - 1; i++)
      for (let j = i + 1; j < ordered.length; j++) {
        const a = i ? ordered[i - 1] : depot,
          b = ordered[i],
          c = ordered[j],
          d = ordered[j + 1] ?? depot;
        if (
          distanceKm(a, c) + distanceKm(b, d) + 0.000001 <
          distanceKm(a, b) + distanceKm(c, d)
        ) {
          ordered.splice(i, j - i + 1, ...ordered.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    if (!improved) break;
  }
  return ordered;
}
export function optimizeAssignments(
  depot: Point,
  shipments: Shipment[],
  drivers: Driver[],
): { driver: Driver; stops: LocatedShipment[] }[] {
  const available = drivers.filter((d) => d.active && d.capacity > 0);
  if (!available.length)
    throw new Error("배차 가능한 기사를 먼저 추가해 주세요.");
  if (shipments.some((s) => !isPoint(s)))
    throw new Error(
      "좌표가 없는 배송지가 있습니다. 주소 확인을 먼저 완료해 주세요.",
    );
  if (available.reduce((n, d) => n + d.capacity, 0) < shipments.length)
    throw new Error(
      "기사별 최대 배송지 수가 부족합니다. 기사 추가 또는 최대 배송지 수 변경 후 다시 배차해 주세요.",
    );
  // Sweep nearby destinations together, then balance using per-driver capacity.
  const sorted = (shipments as LocatedShipment[])
    .slice()
    .sort(
      (a, b) =>
        Math.atan2(a.lat - depot.lat, a.lng - depot.lng) -
        Math.atan2(b.lat - depot.lat, b.lng - depot.lng),
    );
  const groups: { driver: Driver; stops: LocatedShipment[] }[] = [];
  let index = 0;
  for (let i = 0; i < available.length && index < sorted.length; i++) {
    const capacityAfter = available
      .slice(i + 1)
      .reduce((n, d) => n + d.capacity, 0);
    const count = Math.min(
      available[i].capacity,
      Math.max(
        Math.ceil((sorted.length - index) / (available.length - i)),
        sorted.length - index - capacityAfter,
      ),
    );
    const stops = orderStops(depot, sorted.slice(index, index + count));
    index += count;
    groups.push({ driver: available[i], stops });
  }
  return groups;
}
export async function estimateRoute(
  company: Company,
  stops: Point[],
  roadRouting = true,
): Promise<{
  distanceKm: number;
  durationMinutes: number;
  estimateSource: string;
  geometry: Point[];
}> {
  const points = [company, ...stops, company];
  if (roadRouting && stops.length) {
    try {
      const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
      const response = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`,
        { signal: AbortSignal.timeout(7000) },
      );
      if (!response.ok) throw new Error("routing unavailable");
      const data = (await response.json()) as {
        routes?: {
          distance: number;
          duration: number;
          geometry: { coordinates: number[][] };
        }[];
      };
      const route = data.routes?.[0];
      if (route)
        return {
          distanceKm: Math.round(route.distance / 100) / 10,
          durationMinutes: Math.ceil(
            route.duration / 60 + stops.length * company.serviceMinutes,
          ),
          estimateSource: "road",
          geometry: route.geometry.coordinates.map(([lng, lat]) => ({
            lat,
            lng,
          })),
        };
    } catch {
      /* Keep the estimate explicit when the routing provider is unavailable. */
    }
  }
  const km = loopDistance(company, stops) * 1.35;
  return {
    distanceKm: Math.round(km * 10) / 10,
    durationMinutes: Math.ceil(
      (km / 25) * 60 + stops.length * company.serviceMinutes,
    ),
    estimateSource: "approximate",
    geometry: points,
  };
}
