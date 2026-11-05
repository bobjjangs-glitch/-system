import { createHash } from "node:crypto";
import { id, type Store } from "./database.ts";
import { geocode, GeocodingError } from "./geocoding.ts";
import { estimateRoute, resolveDeparture, routePlanning } from "./routing.ts";
import { isPoint, type Route, type Shipment, type Point } from "./types.ts";
import {
  PlannedShipmentMutationError,
  type PlannedShipmentMutationDeps,
} from "./manualAssignment.ts";

function check(value: unknown, message: string, status = 409): asserts value {
  if (!value) throw new PlannedShipmentMutationError(message, status);
}
/** Only structural inputs; background address resolution and live positions do not invalidate a gesture. */
export function dispatchRevision(store: Store, date: string) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        company: store.company(),
        shipments: store.all(
          "SELECT id,recipient,address,phone,items,notes,status,routeId,sequence,amount FROM shipments WHERE serviceDate=? ORDER BY id",
          date,
        ),
        drivers: store.all(
          "SELECT id,name,capacity,active FROM users WHERE role='driver' ORDER BY id",
        ),
        routes: store.all(
          "SELECT id,driverId,serviceDate,status,company,planning FROM routes WHERE serviceDate=? OR status IN ('active','returning') ORDER BY id",
          date,
        ),
      }),
    )
    .digest("hex");
}
export type DispatchDrop = {
  shipmentId: string;
  targetDriverId: string | null;
  beforeShipmentId?: string | null;
  serviceDate: string;
  revision: string;
};

/** Caller owns the shared routing lock. No business data changes until all routing calls have succeeded. */
export async function dropShipment(
  store: Store,
  input: DispatchDrop,
  deps: PlannedShipmentMutationDeps = {},
) {
  check(
    typeof input.shipmentId === "string" &&
      typeof input.revision === "string" &&
      (input.targetDriverId === null ||
        typeof input.targetDriverId === "string"),
    "배송지와 이동할 코스를 확인해 주세요.",
    400,
  );
  check(
    input.revision === dispatchRevision(store, input.serviceDate),
    "배차 정보가 변경되었습니다. 새로고침 후 다시 옮겨 주세요.",
  );
  const selected = store.one(
    "SELECT * FROM shipments WHERE id=? AND serviceDate=?",
    input.shipmentId,
    input.serviceDate,
  );
  check(selected, "배송지를 찾을 수 없습니다.", 404);
  check(
    (selected.status === "pending" && !selected.routeId) ||
      (selected.status === "assigned" && selected.routeId),
    "출발 전 배송지만 이동할 수 있습니다.",
  );
  const source = selected.routeId
    ? store.one("SELECT * FROM routes WHERE id=?", selected.routeId)
    : undefined;
  check(
    !selected.routeId ||
      (source?.status === "planned" &&
        source.serviceDate === input.serviceDate),
    "운행을 시작한 코스는 이동할 수 없습니다.",
  );
  let target: any;
  if (input.targetDriverId !== null) {
    const driver = store.one(
      "SELECT * FROM users WHERE id=? AND role='driver'",
      input.targetDriverId,
    );
    check(driver?.active, "활성 기사에게만 배송지를 배정할 수 있습니다.");
    const routes = store.all(
      "SELECT * FROM routes WHERE driverId=? AND (status IN ('active','returning') OR (serviceDate=? AND status='planned'))",
      driver.id,
      input.serviceDate,
    );
    check(
      routes.every((r) => r.status === "planned") && routes.length <= 1,
      "운행 중이거나 코스 확인이 필요한 기사입니다. 복귀 후 다시 배정해 주세요.",
    );
    target = routes[0];
    const count = target
      ? Number(
          store.one(
            "SELECT COUNT(*) AS n FROM shipments WHERE routeId=?",
            target.id,
          ).n,
        )
      : 0;
    check(
      count + (target && source && target.id === source.id ? 0 : 1) <=
        driver.capacity,
      "기사의 최대 배송지 수를 초과합니다. 다른 기사로 옮기거나 최대 배송지 수를 늘려 주세요.",
    );
  }
  const stopsFor = (routeId?: string): Shipment[] =>
    routeId
      ? store
          .all(
            "SELECT * FROM shipments WHERE routeId=? ORDER BY sequence,id",
            routeId,
          )
          .map((r) => store.shipment(r))
      : [];
  const sourceStops = stopsFor(source?.id).filter((s) => s.id !== selected.id);
  const targetStops =
    target?.id === source?.id && source
      ? sourceStops
      : stopsFor(target?.id).filter((s) => s.id !== selected.id);
  if (input.targetDriverId !== null) {
    const before =
      input.beforeShipmentId == null
        ? targetStops.length
        : targetStops.findIndex((s) => s.id === input.beforeShipmentId);
    check(before >= 0, "옮길 위치가 변경되었습니다. 다시 선택해 주세요.");
    targetStops.splice(before, 0, store.shipment(selected));
  }
  check(
    input.targetDriverId !== null || !input.beforeShipmentId,
    "미배차 목록의 순서는 자동으로 정해집니다.",
    400,
  );
  const plans: {
    row: any;
    routeId: string;
    driverId: string;
    stops: (Shipment & Point)[];
    result?: Awaited<ReturnType<typeof estimateRoute>>;
    planning?: ReturnType<typeof routePlanning>;
    company: Route["company"];
  }[] = [];
  const add = async (row: any, driverId: string, stops: Shipment[]) => {
    check(
      stops.every(
        (s) =>
          s.serviceDate === input.serviceDate &&
          (s.status === "assigned" ||
            (s.id === selected.id && s.status === "pending")),
      ),
      "배송 처리가 시작된 코스는 바꿀 수 없습니다.",
    );
    const route = row ? store.route(row) : undefined,
      company = route?.company ?? store.company();
    const located: (Shipment & Point)[] = [];
    for (const s of stops) {
      let p: Point;
      if (isPoint(s) && (s.lat !== 0 || s.lng !== 0))
        p = { lat: s.lat, lng: s.lng };
      else
        try {
          p = await (deps.geocode ?? geocode)(store, s.address);
        } catch (error) {
          throw new PlannedShipmentMutationError(
            error instanceof GeocodingError
              ? error.message
              : "배송주소를 확인하지 못했습니다. 주소를 확인한 뒤 다시 옮겨 주세요.",
            422,
          );
        }
      check(
        isPoint(p) && (p.lat !== 0 || p.lng !== 0),
        "배송주소를 확인해 주세요.",
        422,
      );
      located.push({ ...s, ...p });
    }
    const result = located.length
      ? await (deps.estimateRoute ?? estimateRoute)(
          company,
          located,
          deps.roadRouting !== false,
          {
            trafficRequired:
              route?.estimateSource === "naver-traffic" ? true : undefined,
          },
        )
      : undefined;
    plans.push({
      row,
      routeId: row?.id ?? id(),
      driverId,
      stops: located,
      result,
      company,
      planning: result
        ? routePlanning(
            company,
            located,
            result,
            resolveDeparture({
              departureAt: route?.planning?.departureAt,
              serviceDate: input.serviceDate,
            }),
          )
        : undefined,
    });
  };
  if (source && source.id !== target?.id)
    await add(source, source.driverId, sourceStops);
  if (input.targetDriverId !== null)
    await add(target, input.targetDriverId, targetStops);
  return store.transaction(() => {
    check(
      input.revision === dispatchRevision(store, input.serviceDate),
      "배차 정보가 변경되어 이동하지 않았습니다. 새로고침 후 다시 시도해 주세요.",
    );
    store.run(
      "UPDATE shipments SET routeId=NULL,sequence=NULL,status='pending' WHERE id=?",
      selected.id,
    );
    for (const plan of plans) {
      if (!plan.result) {
        store.run("DELETE FROM routes WHERE id=?", plan.routeId);
        store.run(
          "DELETE FROM settings WHERE key=?",
          "manual-route:" + plan.routeId,
        );
        continue;
      }
      const e = plan.result;
      if (plan.row)
        store.run(
          "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=?,planning=? WHERE id=?",
          e.distanceKm,
          e.durationMinutes,
          e.estimateSource,
          JSON.stringify(e.geometry),
          JSON.stringify(plan.planning),
          plan.routeId,
        );
      else
        store.run(
          "INSERT INTO routes(id,driverId,serviceDate,distanceKm,durationMinutes,estimateSource,geometry,company,planning) VALUES(?,?,?,?,?,?,?,?,?)",
          plan.routeId,
          plan.driverId,
          input.serviceDate,
          e.distanceKm,
          e.durationMinutes,
          e.estimateSource,
          JSON.stringify(e.geometry),
          JSON.stringify(plan.company),
          JSON.stringify(plan.planning),
        );
      plan.stops.forEach((s, i) =>
        store.run(
          "UPDATE shipments SET routeId=?,sequence=?,status='assigned',lat=?,lng=? WHERE id=?",
          plan.routeId,
          i + 1,
          s.lat,
          s.lng,
          s.id,
        ),
      );
      store.run(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        "manual-route:" + plan.routeId,
        "true",
      );
    }
    return {
      revision: dispatchRevision(store, input.serviceDate),
      driverIds: [
        ...new Set([source?.driverId, input.targetDriverId].filter(Boolean)),
      ] as string[],
    };
  });
}
