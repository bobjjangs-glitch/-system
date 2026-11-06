import { basename, join } from "node:path";
import { unlinkSync } from "node:fs";
import type { Store } from "./database.ts";
import { estimateRoute } from "./routing.ts";
import { isPoint, type Shipment, type Point } from "./types.ts";
export const ADMIN_DELETE_KINDS = ["imports", "shipments", "routes", "drivers"] as const;
export type AdminDeleteKind = typeof ADMIN_DELETE_KINDS[number];
const fail = (message: string, status = 404): never => { throw Object.assign(new Error(message), { status }); };
/** Explicit administrator action; only app-owned data, never a company ERP write. */
export async function deleteAdminRecord(store: Store, dataDir: string, kind: AdminDeleteKind, id: string, deleteLinked = false) {
  const table = { imports: "imports", shipments: "shipments", routes: "routes", drivers: "users" }[kind];
  const record = store.one(`SELECT * FROM ${table} WHERE id=?`, id);
  if (!record || (kind === "drivers" && record.role !== "driver")) fail("삭제할 앱 기록을 찾을 수 없습니다.");
  const routeIds = new Set<string>(kind === "routes" ? [id] : kind === "drivers"
    ? store.all("SELECT id FROM routes WHERE driverId=?", id).map(r => r.id) : []);
  const targets: any[] = kind === "shipments" ? [record] : kind === "imports" && deleteLinked
    ? store.all("SELECT * FROM shipments WHERE importId=?", id) : [];
  for (const row of targets) if (row.routeId) routeIds.add(row.routeId);
  const deletedIds = new Set(targets.map(s => s.id));
  const signature = () => JSON.stringify({ record: store.one(`SELECT * FROM ${table} WHERE id=?`, id),
    routes: [...routeIds].map(r => [store.one("SELECT * FROM routes WHERE id=?",r), store.all("SELECT * FROM shipments WHERE routeId=? ORDER BY id",r)]),
    imports: kind === "imports" ? store.all("SELECT * FROM shipments WHERE importId=? ORDER BY id",id) : [] });
  const original = signature();
  const plans = await Promise.all([...routeIds].map(async routeId => {
    const raw = store.one("SELECT * FROM routes WHERE id=?", routeId);
    const route = raw ? store.route(raw) : null; if (!route) return { routeId, remove: true, stops: [] as Shipment[] };
    const stops = route.stops.filter(s => !deletedIds.has(s.id));
    const remove = kind === "routes" || kind === "drivers" || !stops.length;
    const estimate = remove ? null : await estimateRoute(route.company, stops.filter((s): s is Shipment & Point => isPoint(s)), false, { trafficRequired: false });
    return { routeId, remove, stops, estimate };
  }));
  let keptShipments = 0;
  store.transaction(() => {
    if (signature() !== original) fail("기록이 변경되어 삭제를 중단했습니다. 최신 내용을 확인하고 다시 삭제해 주세요.",409);
    for (const target of targets) store.run("DELETE FROM shipments WHERE id=?",target.id);
    for (const plan of plans) {
      if (plan.remove) {
        store.run("UPDATE shipments SET routeId=NULL,sequence=NULL,status=CASE WHEN status='assigned' THEN 'pending' ELSE status END WHERE routeId=?",plan.routeId);
        store.run("DELETE FROM positions WHERE routeId=?",plan.routeId);
        store.run("DELETE FROM position_history WHERE routeId=?",plan.routeId);
        store.run("DELETE FROM settings WHERE key=?", "manual-route:"+plan.routeId);
        store.run("DELETE FROM routes WHERE id=?",plan.routeId);
      } else if (plan.estimate) {
        plan.stops.forEach((s,i) => store.run("UPDATE shipments SET sequence=? WHERE id=?",i+1,s.id));
        const e=plan.estimate;
        store.run("UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=?,planning=NULL WHERE id=?",e.distanceKm,e.durationMinutes,e.estimateSource,JSON.stringify(e.geometry),plan.routeId);
      }
    }
    if (kind === "imports") {
      keptShipments = Number(store.run("UPDATE shipments SET importId=NULL WHERE importId=?",id).changes);
      store.run("DELETE FROM imports WHERE id=?",id);
      for (const setting of store.all("SELECT key,value FROM settings WHERE key GLOB 'device-receipt:*'")) {
        try { if (JSON.parse(setting.value)?.importId === id) store.run("DELETE FROM settings WHERE key=?",setting.key); } catch {}
      }
    } else if (kind === "drivers") {
      store.run("DELETE FROM positions WHERE driverId=?",id);
      store.run("DELETE FROM position_history WHERE driverId=?",id);
      store.run("DELETE FROM sessions WHERE userId=?",id);
      store.run("DELETE FROM users WHERE id=?",id);
    }
  });
  if (kind === "imports") {
    try { unlinkSync(join(dataDir,"uploads",basename(record.storedName))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("삭제한 앱 기록의 원본 파일 정리가 필요합니다."); }
  }
  return { ok: true, deletedShipments: targets.length, keptShipments, deletedRoutes: plans.filter(p=>p.remove).length };
}
