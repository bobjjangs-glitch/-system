import type { Store } from "./database.ts";
import type { Point } from "./types.ts";
let geocodeQueue: Promise<unknown> = Promise.resolve();
let previousRequest = 0;
export async function geocode(store: Store, address: string): Promise<Point> {
  const cached = store.one<Point>(
    "SELECT lat,lng FROM geocodes WHERE address=?",
    address,
  );
  if (cached) return cached;
  const run = async () => {
    const key = process.env.KAKAO_REST_API_KEY;
    if (!key) {
      const wait = 1100 - (Date.now() - previousRequest);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      previousRequest = Date.now();
    }
    const url = key
      ? `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`
      : `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=kr&q=${encodeURIComponent(address)}`;
    const response = await fetch(url, {
      headers: key
        ? { Authorization: `KakaoAK ${key}` }
        : {
            "User-Agent":
              "BareunDispatch/1.0 (small delivery dispatch; address lookup)",
          },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok)
      throw new Error(
        "주소 검색 서비스에 연결할 수 없습니다. 잠시 후 다시 시도하거나 위도·경도를 직접 입력해 주세요.",
      );
    const body: any = await response.json();
    const found = key ? body.documents?.[0] : body[0];
    if (!found)
      throw new Error(
        "주소를 찾지 못했습니다. 도로명과 건물번호를 확인해 주세요.",
      );
    const point = {
      lat: Number(key ? found.y : found.lat),
      lng: Number(key ? found.x : found.lon),
    };
    store.run(
      "INSERT OR REPLACE INTO geocodes(address,lat,lng) VALUES(?,?,?)",
      address,
      point.lat,
      point.lng,
    );
    return point;
  };
  const result = geocodeQueue.then(run, run);
  geocodeQueue = result.catch(() => {});
  return result;
}
