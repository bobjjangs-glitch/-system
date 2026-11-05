import { id } from "./database.ts";
import type { Store } from "./database.ts";
import { geocode as resolveAddress, GeocodingError } from "./geocoding.ts";
import {
  estimateRoute as defaultEstimate,
  orderStops,
  resolveDeparture,
  routePlanning,
} from "./routing.ts";
import type { Company, Point, Route, Shipment } from "./types.ts";
import { isPoint } from "./types.ts";

export class PlannedShipmentMutationError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
    this.name = "PlannedShipmentMutationError";
  }
}

export type PlannedShipmentMutationDeps = {
  roadRouting?: boolean;
  geocode?: typeof resolveAddress;
  estimateRoute?: typeof defaultEstimate;
};

function requireValue(
  value: unknown,
  message: string,
  status = 409,
): asserts value {
  if (!value) throw new PlannedShipmentMutationError(message, status);
}

function shipmentRow(store: Store, shipmentId: string) {
  return store.one("SELECT * FROM shipments WHERE id=?", shipmentId);
}

function driverRoutes(store: Store, driverId: string, serviceDate: string) {
  return store.all(
    "SELECT * FROM routes WHERE driverId=? AND (status IN ('active','returning') OR (serviceDate=? AND status='planned')) ORDER BY id",
    driverId,
    serviceDate,
  );
}

function routeStops(store: Store, routeId?: string) {
  return routeId
    ? store.all(
        "SELECT * FROM shipments WHERE routeId=? ORDER BY sequence,id",
        routeId,
      )
    : [];
}

function snapshotReader(
  store: Store,
  shipmentId: string,
  driverId: string,
  serviceDate: string,
  routeId?: string,
) {
  return () => ({
    shipment: shipmentRow(store, shipmentId),
    driver: store.one(
      "SELECT id,role,name,phone,capacity,active FROM users WHERE id=?",
      driverId,
    ),
    routes: driverRoutes(store, driverId, serviceDate),
    route: routeId
      ? store.one("SELECT * FROM routes WHERE id=?", routeId)
      : undefined,
    stops: routeStops(store, routeId),
    company: store.company(),
    marker: routeId
      ? store.one(
          "SELECT value FROM settings WHERE key=?",
          "manual-route:" + routeId,
        )
      : undefined,
  });
}

function assertUnchanged(read: () => unknown, original: unknown) {
  requireValue(
    JSON.stringify(read()) === JSON.stringify(original),
    "배송지·기사 또는 코스 정보가 변경되어 작업을 중단했습니다. 새로고침 후 다시 시도해 주세요.",
  );
}

function hasLocation(value: { lat?: unknown; lng?: unknown }): value is Point {
  return isPoint(value) && (value.lat !== 0 || value.lng !== 0);
}

async function locateStops(
  store: Store,
  stops: Shipment[],
  deps: PlannedShipmentMutationDeps,
): Promise<(Shipment & Point)[]> {
  const result: (Shipment & Point)[] = [];
  for (const stop of stops) {
    if (hasLocation(stop)) {
      result.push({ ...stop, lat: stop.lat, lng: stop.lng });
      continue;
    }
    let point: Point;
    try {
      point = await (deps.geocode ?? resolveAddress)(store, stop.address);
    } catch (error) {
      if (error instanceof GeocodingError)
        throw new PlannedShipmentMutationError(error.message, error.status);
      throw new PlannedShipmentMutationError(
        "배송지 주소를 확인하지 못했습니다. 도로명과 건물번호를 확인한 뒤 다시 시도해 주세요.",
        422,
      );
    }
    requireValue(
      hasLocation(point),
      "배송지 주소를 확인하지 못했습니다. 주소를 확인한 뒤 다시 시도해 주세요.",
      422,
    );
    result.push({ ...stop, ...point });
  }
  return result;
}

async function plan(
  company: Company,
  stops: (Shipment & Point)[],
  route: Route | undefined,
  deps: PlannedShipmentMutationDeps,
) {
  requireValue(isPoint(company), "회사 주소를 먼저 확인해 주세요.", 422);
  const departureAt = resolveDeparture({
    departureAt: route?.planning?.departureAt,
    serviceDate: route?.serviceDate ?? stops[0].serviceDate,
  });
  const estimate = await (deps.estimateRoute ?? defaultEstimate)(
    company,
    stops,
    deps.roadRouting !== false,
    {
      trafficRequired:
        route?.estimateSource === "naver-traffic" ? true : undefined,
    },
  );
  return {
    estimate,
    planning: routePlanning(company, stops, estimate, departureAt),
  };
}

/** The caller holds the shared routing lock; all provider work precedes the transaction. */
export async function assignPendingShipment(
  store: Store,
  input: { shipmentId: string; driverId: string },
  deps: PlannedShipmentMutationDeps = {},
): Promise<Route> {
  requireValue(
    typeof input.shipmentId === "string" && input.shipmentId,
    "배송지를 확인해 주세요.",
    400,
  );
  requireValue(
    typeof input.driverId === "string" && input.driverId,
    "배정할 기사를 선택해 주세요.",
    400,
  );
  const pending = shipmentRow(store, input.shipmentId);
  requireValue(pending, "배송지를 찾을 수 없습니다.", 404);
  requireValue(
    pending.status === "pending" && pending.routeId === null,
    "미배차 배송지만 기사에게 배정할 수 있습니다.",
  );
  const driver = store.one(
    "SELECT id,role,active,capacity FROM users WHERE id=?",
    input.driverId,
  );
  requireValue(driver?.role === "driver", "기사를 찾을 수 없습니다.", 404);
  requireValue(driver.active, "비활성 기사는 배송지를 배정할 수 없습니다.");
  const routes = driverRoutes(store, input.driverId, pending.serviceDate);
  requireValue(
    !routes.some((route) => ["active", "returning"].includes(route.status)),
    "운행 중인 기사는 회사 복귀 후 배송지를 배정해 주세요.",
  );
  requireValue(
    routes.length <= 1,
    "같은 배송일의 코스가 여러 개입니다. 코스를 먼저 확인해 주세요.",
  );
  const target = routes[0];
  const read = snapshotReader(
    store,
    input.shipmentId,
    input.driverId,
    pending.serviceDate,
    target?.id,
  );
  const original = read();
  requireValue(
    original.stops.every(
      (stop) =>
        stop.status === "assigned" && stop.serviceDate === pending.serviceDate,
    ),
    "같은 배송일의 출발 전 배송 대기 코스만 변경할 수 있습니다.",
  );
  requireValue(
    original.stops.length + 1 <= driver.capacity,
    "기사의 최대 배송지 수를 초과합니다. 다른 기사를 선택하거나 최대 배송지 수를 변경해 주세요.",
  );
  const route = target ? store.route(target) : undefined;
  const company = route?.company ?? original.company;
  const located = await locateStops(
    store,
    [
      ...original.stops.map((row) => store.shipment(row)),
      store.shipment(pending),
    ],
    deps,
  );
  const stops = orderStops(company, located);
  const { estimate, planning } = await plan(company, stops, route, deps);
  const routeId = target?.id ?? id();
  return store.transaction(() => {
    assertUnchanged(read, original);
    if (target) {
      store.run(
        "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=?,planning=? WHERE id=?",
        estimate.distanceKm,
        estimate.durationMinutes,
        estimate.estimateSource,
        JSON.stringify(estimate.geometry),
        JSON.stringify(planning),
        routeId,
      );
    } else {
      store.run(
        "INSERT INTO routes(id,driverId,serviceDate,distanceKm,durationMinutes,estimateSource,geometry,company,planning) VALUES(?,?,?,?,?,?,?,?,?)",
        routeId,
        input.driverId,
        pending.serviceDate,
        estimate.distanceKm,
        estimate.durationMinutes,
        estimate.estimateSource,
        JSON.stringify(estimate.geometry),
        JSON.stringify(company),
        JSON.stringify(planning),
      );
    }
    stops.forEach((stop, index) =>
      store.run(
        "UPDATE shipments SET lat=?,lng=?,routeId=?,sequence=?,status='assigned' WHERE id=?",
        stop.lat,
        stop.lng,
        routeId,
        index + 1,
        stop.id,
      ),
    );
    store.run(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      "manual-route:" + routeId,
      "true",
    );
    return store.route(store.one("SELECT * FROM routes WHERE id=?", routeId));
  });
}

/** Delete only unstarted work, keeping remaining stops in their current order. */
export async function removePlannedShipment(
  store: Store,
  input: { shipmentId: string },
  deps: PlannedShipmentMutationDeps = {},
): Promise<{
  driverId: string | null;
  routeId: string | null;
  deletedRoute: boolean;
}> {
  requireValue(
    typeof input.shipmentId === "string" && input.shipmentId,
    "배송지를 확인해 주세요.",
    400,
  );
  const selected = shipmentRow(store, input.shipmentId);
  requireValue(selected, "배송지를 찾을 수 없습니다.", 404);
  if (selected.status === "pending" && selected.routeId === null) {
    return store.transaction(() => {
      assertUnchanged(() => shipmentRow(store, input.shipmentId), selected);
      store.run("DELETE FROM shipments WHERE id=?", input.shipmentId);
      return { driverId: null, routeId: null, deletedRoute: false };
    });
  }
  requireValue(
    selected.status === "assigned" && selected.routeId,
    "운행 전 미배차·배송 대기 배송지만 삭제할 수 있습니다.",
  );
  const row = store.one("SELECT * FROM routes WHERE id=?", selected.routeId);
  requireValue(
    row?.status === "planned",
    "운행을 시작한 코스의 배송지는 삭제할 수 없습니다.",
  );
  const route = store.route(row);
  requireValue(
    route.serviceDate === selected.serviceDate,
    "배송일과 코스 정보를 먼저 확인해 주세요.",
  );
  const read = snapshotReader(
    store,
    input.shipmentId,
    row.driverId,
    selected.serviceDate,
    row.id,
  );
  const original = read();
  requireValue(
    original.stops.every(
      (stop) =>
        stop.status === "assigned" && stop.serviceDate === route.serviceDate,
    ),
    "같은 배송일의 출발 전 배송 대기 코스만 변경할 수 있습니다.",
  );
  const remaining = original.stops
    .filter((stop) => stop.id !== input.shipmentId)
    .map((stop) => store.shipment(stop));
  const stops = await locateStops(store, remaining, deps);
  const planned = stops.length
    ? await plan(route.company, stops, route, deps)
    : undefined;
  return store.transaction(() => {
    assertUnchanged(read, original);
    store.run("DELETE FROM shipments WHERE id=?", input.shipmentId);
    if (planned) {
      stops.forEach((stop, index) =>
        store.run(
          "UPDATE shipments SET lat=?,lng=?,sequence=? WHERE id=?",
          stop.lat,
          stop.lng,
          index + 1,
          stop.id,
        ),
      );
      store.run(
        "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=?,planning=? WHERE id=?",
        planned.estimate.distanceKm,
        planned.estimate.durationMinutes,
        planned.estimate.estimateSource,
        JSON.stringify(planned.estimate.geometry),
        JSON.stringify(planned.planning),
        row.id,
      );
    } else {
      store.run("DELETE FROM routes WHERE id=?", row.id);
      store.run("DELETE FROM settings WHERE key=?", "manual-route:" + row.id);
    }
    return { driverId: row.driverId, routeId: row.id, deletedRoute: !planned };
  });
}
