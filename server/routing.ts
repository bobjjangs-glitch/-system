import type {
  Company,
  Driver,
  Point,
  Shipment,
  RoutePlanning,
} from "./types.ts";
import {
  NaverDirections,
  trafficConfig,
  TrafficRoutingError,
} from "./naverDirections.ts";
import type { TrafficConfig, TrafficRoute } from "./naverDirections.ts";
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
  const minimums = available.map((driver) => Math.min(5, driver.capacity));
  const reserveMinimums =
    minimums.reduce((sum, n) => sum + n, 0) <= sorted.length;
  let index = 0;
  for (let i = 0; i < available.length && index < sorted.length; i++) {
    const capacityAfter = available
      .slice(i + 1)
      .reduce((n, d) => n + d.capacity, 0);
    const minimumAfter = reserveMinimums
      ? minimums.slice(i + 1).reduce((sum, n) => sum + n, 0)
      : Math.min(sorted.length - index - 1, available.length - i - 1);
    const count = Math.min(
      available[i].capacity,
      sorted.length - index - minimumAfter,
      Math.max(
        reserveMinimums ? minimums[i] : 1,
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
async function staticEstimateRoute(
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

export type RouteEstimate = {
  distanceKm: number;
  durationMinutes: number;
  estimateSource: string;
  geometry: Point[];
  legMinutes?: number[];
  trafficCheckedAt?: string | null;
  legTimesEstimated?: boolean;
};
export type PlanningOptions = {
  roadRouting?: boolean;
  trafficRequired?: boolean;
  departureAt?: string;
  serviceDate?: string;
  config?: TrafficConfig | null;
  fetcher?: typeof fetch;
  now?: () => number;
  cache?: boolean;
};
function trafficEstimate(
  company: Company,
  stops: Point[],
  value: TrafficRoute,
): RouteEstimate {
  return {
    distanceKm: Math.round(value.distanceKm * 10) / 10,
    durationMinutes: Math.ceil(
      value.drivingMinutes + stops.length * company.serviceMinutes,
    ),
    estimateSource: value.checkedAt ? "naver-traffic" : "road",
    geometry: value.geometry,
    legMinutes: value.legMinutes,
    trafficCheckedAt: value.checkedAt || null,
    legTimesEstimated: value.legTimesEstimated,
  };
}
function provider(options: PlanningOptions): NaverDirections | null {
  // Explicit false is the administrator's ordinary (non-traffic) mode.
  // Omitted preserves automatic provider selection for existing app versions.
  if (options.trafficRequired === false) return null;
  const config =
    options.config === undefined ? trafficConfig() : options.config;
  if (options.trafficRequired && (options.roadRouting === false || !config))
    throw new TrafficRoutingError(
      "실시간 교통 배차를 사용하려면 서버에 NAVER_DIRECTIONS_KEY_ID·NAVER_DIRECTIONS_KEY_SECRET을 등록하고 Directions 15를 활성화해 주세요.",
    );
  if (!config || options.roadRouting === false) return null;
  return new NaverDirections(config, {
    fetcher: options.fetcher,
    now: options.now,
    cache: options.cache,
  });
}
export function resolveDeparture(options: PlanningOptions): string {
  const now = options.now?.() ?? Date.now();
  if (options.departureAt !== undefined) {
    const parsed = Date.parse(options.departureAt);
    if (
      !Number.isFinite(parsed) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        options.departureAt,
      )
    )
      throw new TrafficRoutingError(
        "출발 예정 시각을 시간대가 포함된 날짜·시간으로 입력해 주세요.",
      );
    if (
      options.serviceDate &&
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(
        parsed,
      ) !== options.serviceDate
    )
      throw new TrafficRoutingError(
        "출발 예정 시각은 선택한 배송일과 같아야 합니다.",
      );
    return new Date(parsed).toISOString();
  }
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
  }).format(now);
  return options.serviceDate && options.serviceDate !== today
    ? new Date(options.serviceDate + "T09:00:00+09:00").toISOString()
    : new Date(Math.ceil(now / 60000) * 60000).toISOString();
}
export function routePlanning(
  company: Company,
  stops: (Point & { id: string })[],
  estimate: RouteEstimate,
  departureAt: string,
): RoutePlanning {
  const points = [company, ...stops, company];
  const driving = Math.max(
    0,
    estimate.durationMinutes - stops.length * company.serviceMinutes,
  );
  const weights = points.slice(1).map((p, i) => distanceKm(points[i], p));
  const sum = weights.reduce((a, b) => a + b, 0);
  const legs =
    estimate.legMinutes?.length === points.length - 1
      ? estimate.legMinutes
      : weights.map((v) => (sum ? (driving * v) / sum : 0));
  let time = Date.parse(departureAt);
  const rows = stops.map((stop, i) => {
    time += legs[i] * 60000;
    const arrivalAt = new Date(time).toISOString();
    time += company.serviceMinutes * 60000;
    return {
      shipmentId: stop.id,
      arrivalAt,
      departureAt: new Date(time).toISOString(),
      travelMinutes: Math.round(legs[i] * 10) / 10,
    };
  });
  time += (legs.at(-1) ?? 0) * 60000;
  return {
    departureAt,
    returnAt: new Date(time).toISOString(),
    trafficCheckedAt: estimate.trafficCheckedAt ?? null,
    basis:
      estimate.estimateSource === "naver-traffic"
        ? "current-traffic"
        : "static",
    legTimesEstimated: estimate.legTimesEstimated ?? true,
    stops: rows,
  };
}
export async function estimateRoute(
  company: Company,
  stops: Point[],
  roadRouting = true,
  options: PlanningOptions = {},
): Promise<RouteEstimate> {
  const client = provider({ ...options, roadRouting });
  if (client && stops.length)
    return trafficEstimate(
      company,
      stops,
      await client.route([company, ...stops, company]),
    );
  return staticEstimateRoute(company, stops, roadRouting);
}
type PlannedGroup = {
  driver: Driver;
  stops: LocatedShipment[];
  estimate: RouteEstimate;
  planning: RoutePlanning;
};
function objective(groups: { estimate: RouteEstimate }[]) {
  const times = groups.map((g) => g.estimate.durationMinutes);
  return times.reduce((a, b) => a + b, 0) + Math.max(0, ...times) * 2;
}
export async function planDispatch(
  company: Company,
  shipments: Shipment[],
  drivers: Driver[],
  options: PlanningOptions = {},
): Promise<PlannedGroup[]> {
  const initial = optimizeAssignments(company, shipments, drivers);
  const client = provider(options);
  const departure = resolveDeparture(options);
  const evaluate = async (group: {
    driver: Driver;
    stops: LocatedShipment[];
  }): Promise<PlannedGroup> => {
    const estimate = client
      ? trafficEstimate(
          company,
          group.stops,
          await client.route([company, ...group.stops, company]),
        )
      : await staticEstimateRoute(
          company,
          group.stops,
          options.roadRouting !== false,
        );
    return {
      ...group,
      estimate,
      planning: routePlanning(company, group.stops, estimate, departure),
    };
  };
  if (
    client &&
    !client.canEvaluateMany(initial.map((g) => [company, ...g.stops, company]))
  )
    throw new TrafficRoutingError(
      "한 번에 조회할 실시간 경로가 너무 많습니다. 기사 또는 배송지 수를 줄여 배차해 주세요.",
    );
  // Geographic grouping keeps the initial search bounded. Actual current road
  // times compare both directions of each loop and a bounded workload exchange.
  let groups = await Promise.all(initial.map(evaluate));
  if (client) {
    const alternatives = await Promise.all(
      groups.map(async (group) => {
        const stops = group.stops.slice().reverse();
        if (
          stops.length < 2 ||
          !client.canEvaluate([company, ...stops, company])
        )
          return group;
        const candidate = await evaluate({ ...group, stops });
        return candidate.estimate.durationMinutes <
          group.estimate.durationMinutes
          ? candidate
          : group;
      }),
    );
    groups = alternatives;
  }
  // Equal stop counts do not imply equal shift lengths. Keep a five-stop floor
  // whenever capacity and the total number of destinations make it feasible.
  const floor =
    shipments.length >=
    groups.reduce((n, g) => n + Math.min(5, g.driver.capacity), 0)
      ? (g: PlannedGroup) => Math.min(5, g.driver.capacity)
      : (_g: PlannedGroup) => 1;
  for (let pass = 0; pass < 2 && groups.length > 1; pass++) {
    const ranked = groups
      .map((g, index) => ({ g, index }))
      .sort(
        (a, b) => b.g.estimate.durationMinutes - a.g.estimate.durationMinutes,
      );
    const high = ranked[0],
      low = ranked.at(-1)!;
    const center = (stops: Point[]) => ({
      lat: stops.reduce((n, p) => n + p.lat, 0) / stops.length,
      lng: stops.reduce((n, p) => n + p.lng, 0) / stops.length,
    });
    const highCenter = center(high.g.stops),
      lowCenter = center(low.g.stops);
    const outgoing = high.g.stops
      .slice()
      .sort(
        (a, b) =>
          distanceKm(a, lowCenter) -
          distanceKm(a, highCenter) -
          (distanceKm(b, lowCenter) - distanceKm(b, highCenter)),
      )[0];
    let highStops: LocatedShipment[], lowStops: LocatedShipment[];
    if (
      high.g.stops.length > floor(high.g) &&
      low.g.stops.length < low.g.driver.capacity
    ) {
      highStops = high.g.stops.filter((s) => s.id !== outgoing.id);
      lowStops = [...low.g.stops, outgoing];
    } else {
      const incoming = low.g.stops
        .slice()
        .sort(
          (a, b) =>
            distanceKm(a, highCenter) -
            distanceKm(a, lowCenter) -
            (distanceKm(b, highCenter) - distanceKm(b, lowCenter)),
        )[0];
      highStops = high.g.stops.map((s) =>
        s.id === outgoing.id ? incoming : s,
      );
      lowStops = low.g.stops.map((s) => (s.id === incoming.id ? outgoing : s));
    }
    highStops = orderStops(company, highStops);
    lowStops = orderStops(company, lowStops);
    const required = [highStops, lowStops].map((s) => [company, ...s, company]);
    if (client && !client.canEvaluateMany(required)) break;
    const changed = await Promise.all([
      evaluate({ driver: high.g.driver, stops: highStops }),
      evaluate({ driver: low.g.driver, stops: lowStops }),
    ]);
    const next = groups.slice();
    next[high.index] = changed[0];
    next[low.index] = changed[1];
    if (objective(next) + 0.5 >= objective(groups)) break;
    groups = next;
  }
  return groups;
}
