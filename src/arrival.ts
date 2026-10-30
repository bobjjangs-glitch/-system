import type { Point, Route, Shipment } from "../server/types.ts";

export type ArrivalLocation = Point & {
  recordedAt: string;
  accuracy?: number | null;
  speed?: number | null;
};
export type ArrivalState = {
  routeId?: string;
  stopId?: string;
  enteredAt?: number;
  lastTimestamp?: number;
  samples?: number;
  departure?: Point;
};
export const ARRIVAL_RULES = {
  radiusMeters: 80,
  dwellSeconds: 30,
  maxAccuracyMeters: 50,
  maxSpeedMetersPerSecond: 2,
  maxSampleGapSeconds: 35,
  departureMeters: 60,
};
export function metersBetween(a: Point, b: Point) {
  const radians = Math.PI / 180;
  const latitude = (b.lat - a.lat) * radians;
  const longitude = (b.lng - a.lng) * radians;
  const h =
    Math.sin(latitude / 2) ** 2 +
    Math.cos(a.lat * radians) *
      Math.cos(b.lat * radians) *
      Math.sin(longitude / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function point(value: {
  lat?: number | null;
  lng?: number | null;
}): value is Point {
  return (
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lng) &&
    Math.abs(value.lat!) <= 90 &&
    Math.abs(value.lng!) <= 180
  );
}
export function checkArrival(
  route: Route | null,
  location: ArrivalLocation,
  previous: ArrivalState = {},
  now = Date.now(),
): { state: ArrivalState; stop?: Shipment; reason: string } {
  if (!route || route.status !== "active")
    return { state: {}, reason: "inactive" };
  const next = route.stops.find((stop) => stop.status === "assigned");
  if (!next || !point(next)) return { state: {}, reason: "no_destination" };
  let state: ArrivalState =
    previous.routeId === route.id ? { ...previous } : { routeId: route.id };
  const timestamp = Date.parse(location.recordedAt);
  if (state.lastTimestamp != null && timestamp <= state.lastTimestamp)
    return { state, reason: "old_sample" };
  const reset = (reason: string) => ({
    state: {
      routeId: route.id,
      stopId: next.id,
      departure: state.departure,
      lastTimestamp: Number.isFinite(timestamp)
        ? timestamp
        : state.lastTimestamp,
    },
    reason,
  });
  if (
    !point(location) ||
    !Number.isFinite(timestamp) ||
    now - timestamp > 120000 ||
    timestamp > now + 15000
  )
    return reset("stale_location");
  if (
    location.accuracy == null ||
    !Number.isFinite(location.accuracy) ||
    location.accuracy < 0 ||
    location.accuracy > ARRIVAL_RULES.maxAccuracyMeters
  )
    return reset("poor_accuracy");
  if (
    location.speed != null &&
    (!Number.isFinite(location.speed) ||
      location.speed > ARRIVAL_RULES.maxSpeedMetersPerSecond)
  )
    return reset("moving");
  if (state.departure) {
    if (
      metersBetween(state.departure, location) <= ARRIVAL_RULES.departureMeters
    )
      return reset("waiting_for_departure");
    delete state.departure;
  }
  if (metersBetween(location, next) > ARRIVAL_RULES.radiusMeters)
    return reset("outside");
  const continuous =
    state.stopId === next.id &&
    state.enteredAt != null &&
    state.lastTimestamp != null &&
    timestamp - state.lastTimestamp <= ARRIVAL_RULES.maxSampleGapSeconds * 1000;
  state = {
    routeId: route.id,
    stopId: next.id,
    enteredAt: continuous ? state.enteredAt : timestamp,
    samples: continuous ? (state.samples ?? 0) + 1 : 1,
    lastTimestamp: timestamp,
  };
  if (
    timestamp - state.enteredAt! >= ARRIVAL_RULES.dwellSeconds * 1000 &&
    state.samples! >= 3
  )
    return { state, stop: next, reason: "arrived" };
  return { state, reason: "dwelling" };
}
export function afterAutomaticDelivery(
  routeId: string,
  stop: Shipment,
  recordedAt: string,
  observed?: Point,
): ArrivalState {
  return {
    routeId,
    lastTimestamp: Date.parse(recordedAt),
    departure:
      observed && point(observed)
        ? observed
        : point(stop)
          ? { lat: stop.lat, lng: stop.lng }
          : undefined,
  };
}
