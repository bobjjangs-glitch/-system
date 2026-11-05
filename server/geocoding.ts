import type { Store } from "./database.ts";
import type { Point } from "./types.ts";

export class GeocodingError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.name = "GeocodingError";
    this.code = code;
    this.status = status;
  }
}
type Provider =
  | { name: "naver"; keyId: string; secret: string }
  | { name: "kakao"; key: string }
  | { name: "nominatim" };
export type GeocoderOptions = {
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  requestTimeoutMs?: number;
  queueTimeoutMs?: number;
  maxPending?: number;
};
function provider(env: NodeJS.ProcessEnv): Provider {
  for (const prefix of ["NAVER_GEOCODING", "NAVER_DIRECTIONS"]) {
    const keyId = env[prefix + "_KEY_ID"]?.trim() ?? "";
    const secret = env[prefix + "_KEY_SECRET"]?.trim() ?? "";
    if (!keyId && !secret) continue;
    if (!keyId || !secret)
      throw new GeocodingError(
        "CONFIGURATION",
        "네이버 주소 검색의 서버 인증 정보가 빠져 있습니다. 관리자에게 Key ID와 Key Secret 등록을 요청해 주세요.",
        422,
      );
    return { name: "naver", keyId, secret };
  }
  const key = env.KAKAO_REST_API_KEY?.trim();
  return key ? { name: "kakao", key } : { name: "nominatim" };
}
export function normalizeGeocodingAddress(address: string): string {
  return address
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:배송\s*주소|주소)\s*[:：]\s*/, "")
    .replace(
      /^(?:(?:우편번호|\(우\)|우)\s*[:：]?\s*)?(?:\(\s*\d{5}\s*\)|\[\s*\d{5}\s*\]|\d{3}-\d{3}|\d{5})(?=\s|[가-힣])\s*/,
      "",
    )
    .replace(/(대로|로|길)(?=\d+(?:-\d+)?(?:\s|$|[,;(]))/g, "$1 ")
    .trim();
}
function simplerAddress(address: string): string {
  const plain = address
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Keep the building/parcel number. A street-only result is not a delivery point.
  const road = plain.match(
    /^(.*?(?:대로|로|길)\s*\d+(?:-\d+)?)(?=\s|$|[,;])(?!\s*(?:번\s*)?길)/,
  );
  if (road) return road[1];
  const parcel = plain.match(
    /^(.*?(?:동|읍|면|리)\s*(?:산\s*)?\d+(?:-\d+)?)(?=\s|$|[,;])/,
  );
  return parcel?.[1] ?? plain;
}
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (
    typeof value !== "string" ||
    !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())
  )
    return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function koreanPoint(lat: unknown, lng: unknown): Point | null {
  const latitude = numeric(lat),
    longitude = numeric(lng);
  return latitude !== null &&
    longitude !== null &&
    latitude >= 31.43 &&
    latitude <= 44.35 &&
    longitude >= 122.37 &&
    longitude <= 132
    ? { lat: latitude, lng: longitude }
    : null;
}
const invalidResponse = () =>
  new GeocodingError(
    "INVALID_RESPONSE",
    "주소 검색 결과의 위치 정보를 확인하지 못했습니다. 잠시 후 다시 검색해 주세요.",
  );
const unavailable = () =>
  new GeocodingError(
    "UNAVAILABLE",
    "주소 검색 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  );
const timedOut = () =>
  new GeocodingError(
    "TIMEOUT",
    "주소 검색 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.",
    408,
  );
const queueBusy = () =>
  new GeocodingError(
    "BUSY",
    "주소 검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
    429,
  );

export function createGeocoder(options: GeocoderOptions = {}) {
  const fetcher =
    options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const inFlight = new WeakMap<Store, Map<string, Promise<Point>>>();
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let previousPublicRequest = -Infinity;

  async function lookup(
    selected: Provider,
    query: string,
  ): Promise<Point | null> {
    if (selected.name === "nominatim") {
      const wait = 1100 - (now() - previousPublicRequest);
      if (wait > 0) await sleep(wait);
      previousPublicRequest = now();
    }
    const url = new URL(
      selected.name === "naver"
        ? "https://maps.apigw.ntruss.com/map-geocode/v2/geocode"
        : selected.name === "kakao"
          ? "https://dapi.kakao.com/v2/local/search/address.json"
          : "https://nominatim.openstreetmap.org/search",
    );
    url.searchParams.set(selected.name === "nominatim" ? "q" : "query", query);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (selected.name === "naver") {
      headers["x-ncp-apigw-api-key-id"] = selected.keyId;
      headers["x-ncp-apigw-api-key"] = selected.secret;
      url.searchParams.set("count", "1");
    } else if (selected.name === "kakao") {
      headers.Authorization = "KakaoAK " + selected.key;
    } else {
      headers["User-Agent"] =
        "BareunDispatch/1.0 (small delivery dispatch; address lookup)";
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("countrycodes", "kr");
      url.searchParams.set("addressdetails", "1");
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(timedOut());
      }, options.requestTimeoutMs ?? 12_000);
    });
    try {
      const response = await Promise.race([
        fetcher(url, { headers, signal: controller.signal }),
        deadline,
      ]);
      if (response.status === 401 || response.status === 403)
        throw new GeocodingError(
          "AUTHENTICATION",
          selected.name === "naver"
            ? "네이버 주소 검색 인증을 확인해 주세요. Geocoding 사용 설정과 서버의 Key ID·Key Secret 등록이 필요합니다."
            : "주소 검색 인증을 확인해 주세요. 관리자에게 서버 인증 설정 확인을 요청해 주세요.",
          422,
        );
      if (response.status === 429)
        throw new GeocodingError(
          "RATE_LIMIT",
          "주소 검색 사용 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
          429,
        );
      if (response.status === 400)
        throw new GeocodingError(
          "INVALID_ADDRESS",
          "주소 형식을 확인해 주세요. 도로명과 건물번호를 입력해 주세요.",
          422,
        );
      if (!response.ok) throw unavailable();
      let body: any;
      try {
        body = await Promise.race([response.json(), deadline]);
      } catch (error) {
        if (error instanceof GeocodingError) throw error;
        throw invalidResponse();
      }
      let found: any;
      if (selected.name === "naver") {
        if (body?.status !== "OK" || !Array.isArray(body?.addresses))
          throw invalidResponse();
        found = body.addresses[0];
      } else if (selected.name === "kakao") {
        if (!Array.isArray(body?.documents)) throw invalidResponse();
        found = body.documents[0];
      } else {
        if (!Array.isArray(body)) throw invalidResponse();
        found = body[0];
      }
      if (found === undefined) return null;
      if (!found || typeof found !== "object") throw invalidResponse();
      if (
        selected.name === "nominatim" &&
        /(?:대로|로|길)\s*\d/.test(query) &&
        (found.class === "highway" ||
          found.category === "highway" ||
          [
            "road",
            "street",
            "city",
            "town",
            "village",
            "suburb",
            "quarter",
            "neighbourhood",
            "county",
            "state",
            "country",
            "postcode",
          ].includes(found.addresstype))
      )
        return null;
      const point =
        selected.name === "nominatim"
          ? koreanPoint(found.lat, found.lon)
          : koreanPoint(found.y, found.x);
      if (!point) throw invalidResponse();
      return point;
    } catch (error) {
      if (error instanceof GeocodingError) throw error;
      if (controller.signal.aborted) throw timedOut();
      throw unavailable();
    } finally {
      clearTimeout(timer!);
    }
  }

  return async function geocodeAddress(
    store: Store,
    address: string,
  ): Promise<Point> {
    if (typeof address !== "string" || !address.trim() || address.length > 500)
      throw new GeocodingError(
        "INVALID_ADDRESS",
        "배송주소를 입력해 주세요. 도로명과 건물번호를 확인해 주세요.",
        422,
      );
    const cached = () => {
      const found = store.one<Point>(
        "SELECT lat,lng FROM geocodes WHERE address=?",
        address,
      );
      return found ? koreanPoint(found.lat, found.lng) : null;
    };
    const hit = cached();
    if (hit) return hit;
    const selected = provider(options.env ?? process.env);
    const query = normalizeGeocodingAddress(address);
    if (!query)
      throw new GeocodingError(
        "INVALID_ADDRESS",
        "배송주소의 도로명과 건물번호를 확인해 주세요.",
        422,
      );
    let requests = inFlight.get(store);
    if (!requests) {
      requests = new Map();
      inFlight.set(store, requests);
    }
    const key =
      selected.name +
      ":" +
      (selected.name === "naver" ? selected.keyId : "") +
      ":" +
      query;
    const save = (point: Point) => {
      store.run(
        "INSERT OR REPLACE INTO geocodes(address,lat,lng) VALUES(?,?,?)",
        address,
        point.lat,
        point.lng,
      );
      return point;
    };
    const existing = requests.get(key);
    if (existing) return existing.then(save);
    if (pending >= (options.maxPending ?? 64)) throw queueBusy();
    pending++;
    let started = false,
      cancelled = false;
    let waitTimer: ReturnType<typeof setTimeout>;
    const waitDeadline = new Promise<never>((_resolve, reject) => {
      waitTimer = setTimeout(() => {
        if (!started) {
          cancelled = true;
          reject(queueBusy());
        }
      }, options.queueTimeoutMs ?? 55_000);
    });
    const task = queue
      .then(async () => {
        if (cancelled) throw queueBusy();
        started = true;
        clearTimeout(waitTimer);
        const fresh = cached();
        if (fresh) return fresh;
        const first = await lookup(selected, query);
        if (first) return first;
        const fallback = simplerAddress(query);
        if (fallback && fallback !== query) {
          const second = await lookup(selected, fallback);
          if (second) return second;
        }
        throw new GeocodingError(
          "NOT_FOUND",
          "주소를 찾지 못했습니다. 도로명과 건물번호, 상세주소를 확인해 주세요.",
          404,
        );
      })
      .finally(() => {
        pending--;
      });
    queue = task.catch(() => {});
    const result = Promise.race([task, waitDeadline])
      .then(save)
      .finally(() => {
        clearTimeout(waitTimer);
        requests!.delete(key);
      });
    requests.set(key, result);
    return result;
  };
}

export const geocode = createGeocoder();
