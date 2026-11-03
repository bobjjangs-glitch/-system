import type { Point } from "./types.ts";

export class TrafficRoutingError extends Error {
  status = 422;
  constructor(message: string) {
    super(message);
    this.name = "TrafficRoutingError";
  }
}
export type TrafficConfig = { keyId: string; keySecret: string };
export function trafficConfig(): TrafficConfig | null {
  const keyId = process.env.NAVER_DIRECTIONS_KEY_ID?.trim();
  const keySecret = process.env.NAVER_DIRECTIONS_KEY_SECRET?.trim();
  return keyId && keySecret ? { keyId, keySecret } : null;
}
export function trafficRoutingStatus() {
  return {
    configured: !!trafficConfig(),
    provider: "naver-directions15",
    authenticationVerified: false,
    requiredEnvironment: [
      "NAVER_DIRECTIONS_KEY_ID",
      "NAVER_DIRECTIONS_KEY_SECRET",
    ],
    note: "출발 예정 시각과 관계없이 조회 시점의 실시간 교통을 사용합니다. 미래 교통 예측은 제공하지 않습니다.",
  };
}
export type TrafficRoute = {
  distanceKm: number;
  drivingMinutes: number;
  geometry: Point[];
  legMinutes: number[];
  legTimesEstimated: boolean;
  checkedAt: string;
};
type Segment = TrafficRoute & { expires: number };
const cache = new Map<string, Segment>();
const same = (a: Point, b: Point) =>
  Math.abs(a.lat - b.lat) < 0.000001 && Math.abs(a.lng - b.lng) < 0.000001;
const coordinates = (p: Point) => p.lng.toFixed(6) + "," + p.lat.toFixed(6);
function distance(a: Point, b: Point) {
  return Math.hypot(
    (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180),
    a.lat - b.lat,
  );
}
function allocate(duration: number, points: Point[]): number[] {
  const distances = points.slice(1).map((p, i) => distance(points[i], p));
  const total = distances.reduce((a, b) => a + b, 0);
  return distances.map((d) => (total ? (duration * d) / total : 0));
}
function validPoint(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}
export function trafficChunks(points: Point[]): Point[][] {
  const result: Point[][] = [];
  let index = 0;
  while (index < points.length - 1) {
    let end = Math.min(index + 16, points.length - 1);
    // Naver rejects identical start/goal. Split company round trips before
    // the final delivery; do not move the actual company coordinate.
    while (end > index + 1 && same(points[index], points[end])) end--;
    result.push(points.slice(index, end + 1));
    index = end;
  }
  return result;
}
export class NaverDirections {
  calls = 0;
  private allocated = 0;
  private running = 0;
  private waiting: (() => void)[] = [];
  private deadline: number;
  private config: TrafficConfig;
  private options: {
    fetcher?: typeof fetch;
    now?: () => number;
    maxCalls?: number;
    cache?: boolean;
  };
  constructor(
    config: TrafficConfig,
    options: {
      fetcher?: typeof fetch;
      now?: () => number;
      maxCalls?: number;
      cache?: boolean;
    } = {},
  ) {
    this.config = config;
    this.options = options;
    this.deadline = this.now() + 45_000;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  canEvaluate(points: Point[]) {
    return (
      this.allocated +
        trafficChunks(points).filter((p) => !p.every((x) => same(x, p[0])))
          .length <=
        (this.options.maxCalls ?? 40) && this.now() < this.deadline
    );
  }
  canEvaluateMany(routes: Point[][]) {
    return (
      this.allocated +
        routes.reduce(
          (n, points) =>
            n +
            trafficChunks(points).filter((p) => !p.every((x) => same(x, p[0])))
              .length,
          0,
        ) <=
        (this.options.maxCalls ?? 40) && this.now() < this.deadline
    );
  }
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= 4)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }
  private async segment(points: Point[]): Promise<TrafficRoute> {
    if (points.every((p) => same(p, points[0]))) {
      return {
        distanceKm: 0,
        drivingMinutes: 0,
        geometry: points,
        legMinutes: points.slice(1).map(() => 0),
        legTimesEstimated: false,
        checkedAt: "",
      };
    }
    const key = this.config.keyId + ":" + points.map(coordinates).join("|");
    for (const [cachedKey, value] of cache)
      if (value.expires <= this.now()) cache.delete(cachedKey);
    const hit = this.options.cache !== false ? cache.get(key) : undefined;
    if (hit && hit.expires > this.now()) return hit;
    if (
      this.calls >= (this.options.maxCalls ?? 40) ||
      this.now() >= this.deadline
    )
      throw new TrafficRoutingError(
        "교통 경로 조회 한도를 넘었습니다. 배송지나 기사 수를 줄여 다시 배차해 주세요.",
      );
    this.calls++;
    return this.slot(async () => {
      const url = new URL(
        "https://maps.apigw.ntruss.com/map-direction-15/v1/driving",
      );
      url.searchParams.set("start", coordinates(points[0]));
      url.searchParams.set("goal", coordinates(points.at(-1)!));
      if (points.length > 2)
        url.searchParams.set(
          "waypoints",
          points.slice(1, -1).map(coordinates).join("|"),
        );
      url.searchParams.set("option", "traoptimal");
      let response: Response;
      let body: any;
      try {
        response = await (this.options.fetcher ?? fetch)(url, {
          headers: {
            "x-ncp-apigw-api-key-id": this.config.keyId,
            "x-ncp-apigw-api-key": this.config.keySecret,
          },
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(7000, this.deadline - this.now())),
          ),
        });
        if (response.status === 401 || response.status === 403)
          throw new TrafficRoutingError(
            "네이버 실시간 교통 인증을 확인해 주세요. Directions 15 사용 설정과 서버의 Key ID·Key Secret이 필요합니다.",
          );
        if (response.status === 429)
          throw new TrafficRoutingError(
            "네이버 교통 조회 한도를 초과했습니다. 잠시 후 다시 배차해 주세요.",
          );
        if (!response.ok) throw new Error("provider unavailable");
        body = await response.json();
      } catch (error) {
        if (error instanceof TrafficRoutingError) throw error;
        throw new TrafficRoutingError(
          "실시간 교통 경로를 불러오지 못했습니다. 연결 상태를 확인하고 다시 배차해 주세요.",
        );
      }
      const route = body?.route?.traoptimal?.[0];
      const summary = route?.summary;
      if (
        body.code !== 0 ||
        !summary ||
        !Number.isFinite(summary.distance) ||
        summary.distance < 0 ||
        !Number.isFinite(summary.duration) ||
        summary.duration < 0 ||
        !Array.isArray(route.path) ||
        route.path.length < 2 ||
        !route.path.every(validPoint)
      )
        throw new TrafficRoutingError(
          "네이버에서 배송지 경로를 찾지 못했습니다. 배송지 좌표가 도로 주변인지 확인해 주세요.",
        );
      const minutes = summary.duration / 60000;
      const legs: number[] = [];
      let elapsed = 0;
      for (const guide of Array.isArray(route.guide) ? route.guide : []) {
        if (!Number.isFinite(guide.duration) || guide.duration < 0) continue;
        elapsed += guide.duration / 60000;
        if (guide.type === 87 || guide.type === 88) {
          legs.push(elapsed);
          elapsed = 0;
        }
      }
      const sum = legs.reduce((a, b) => a + b, 0);
      const providerLegs =
        legs.length === points.length - 1 &&
        sum > 0 &&
        Math.abs(sum - minutes) <= 0.01;
      const value: Segment = {
        distanceKm: summary.distance / 1000,
        drivingMinutes: minutes,
        geometry: route.path.map(([lng, lat]: number[]) => ({ lat, lng })),
        legMinutes: providerLegs ? legs : allocate(minutes, points),
        legTimesEstimated: !providerLegs,
        checkedAt: new Date(this.now()).toISOString(),
        expires: this.now() + 30_000,
      };
      if (this.options.cache !== false) {
        for (const [cachedKey, value] of cache)
          if (value.expires <= this.now()) cache.delete(cachedKey);
        if (cache.size >= 64) cache.delete(cache.keys().next().value!);
        cache.set(key, value);
      }
      return value;
    });
  }
  async route(points: Point[]): Promise<TrafficRoute> {
    if (!this.canEvaluate(points))
      throw new TrafficRoutingError(
        "교통 경로 조회 한도를 넘었습니다. 배송지나 기사 수를 줄여 다시 배차해 주세요.",
      );
    this.allocated += trafficChunks(points).filter(
      (p) => !p.every((x) => same(x, p[0])),
    ).length;
    const parts: TrafficRoute[] = [];
    for (const chunk of trafficChunks(points))
      parts.push(await this.segment(chunk));
    return {
      distanceKm: parts.reduce((n, p) => n + p.distanceKm, 0),
      drivingMinutes: parts.reduce((n, p) => n + p.drivingMinutes, 0),
      geometry: parts.flatMap((p, i) => (i ? p.geometry.slice(1) : p.geometry)),
      legMinutes: parts.flatMap((p) => p.legMinutes),
      legTimesEstimated: parts.some((p) => p.legTimesEstimated),
      checkedAt:
        parts
          .map((p) => p.checkedAt)
          .filter(Boolean)
          .sort()[0] ?? "",
    };
  }
}
