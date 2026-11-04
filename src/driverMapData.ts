import type { MapSettings, Route } from "../server/types.ts";
import { DEFAULT_NAVER_MAP_KEY_ID } from "./mapConfig.ts";

export function createDriverMapData(route: Route, mapSettings?: MapSettings) {
  return {
    company: route.company,
    routes: [route],
    drivers: [],
    nextStopId: route.stops.find((stop) => stop.status === "assigned")?.id,
    map: {
      provider: "naver" as const,
      // Older servers omit mapSettings; an explicitly cleared key stays cleared.
      naverKeyId: mapSettings?.naverKeyId ?? DEFAULT_NAVER_MAP_KEY_ID,
    },
  };
}
