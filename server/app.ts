import { deleteAdminRecord, ADMIN_DELETE_KINDS, type AdminDeleteKind } from "./adminDelete.ts";
import {APP_VERSION,APP_REVISION} from "./buildInfo.ts";
import { CompanySalesList } from "./companySalesList.ts";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join, basename, extname } from "node:path";
import {
  randomInt,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import ExcelJS from "exceljs";
import { Store, id, today } from "./database.ts";
import type { Session, Shipment, Company, Route } from "./types.ts";
import { isPoint } from "./types.ts";
import {
  planDispatch,
  estimateRoute,
  orderStops,
  routePlanning,
  resolveDeparture,
} from "./routing.ts";
import { trafficRoutingStatus } from "./naverDirections.ts";
import {
  parseSpreadsheet, parseSpreadsheetPreview, isSalesSpreadsheet,
  recognizeReceipt,
  shutdownReceiptOcrPool,
  validateShipments,
  validateReceiptImage,
} from "./imports.ts";
import { geocode, GeocodingError } from "./geocoding.ts";
import {
  assignPendingShipment,
  removePlannedShipment,
  PlannedShipmentMutationError,
} from "./manualAssignment.ts";
import { dispatchRevision, dropShipment } from "./dragDispatch.ts";
import {
  importCatalog,
  searchCatalog,
  parseSalesExport, salesImportKeys, savedManualSale,
} from "./erpCatalog.ts";

import { CompanySaleService } from "./companySale.ts";
import { CompanyErpClient, CompanyErpError, type CompanyErpDeps } from "./companyErp.ts";
import { seedDemo } from "./demo.ts";
import { createMapDocument } from "../src/mapDocument.ts";
import { extractReceipt } from "../src/receiptText.ts";
import { normalizeReceiptLayout } from "../src/receiptLayout.ts";
import type { ReceiptLayout } from "../src/receiptText.ts";

type AuthRequest = Request & { user: Session; token: string };
class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
function assert(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new AppError(message, status);
}
function dateValue(value: unknown): string {
  const v = typeof value === "string" ? value : today();
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
    "날짜 형식을 확인해 주세요.",
  );
  return v;
}
function pinValue(value: unknown): string {
  assert(
    typeof value === "string" && /^\d{6,12}$/.test(value),
    "PIN은 숫자 6~12자리로 입력해 주세요.",
  );
  return value;
}

export function createDispatchApp(
  options: {
    dataDir?: string;
    roadRouting?: boolean;
    test?: boolean;
    autoGeocode?: boolean;
    companyErp?: CompanyErpDeps;
  } = {},
) {
  const dataDir = resolve(
    options.dataDir ?? process.env.APP_DATA_DIR ?? ".local",
  );
  const store = new Store(dataDir);
  const companyErp = new CompanyErpClient(store, options.companyErp);
  const companySales = new CompanySaleService(store, companyErp, dataDir, (date) => {
    notify("changed");
    scheduleAddressLookup(date);
  });
  const salesLists = new CompanySalesList(store, companyErp, dataDir, (date) => {
    notify("changed");
    scheduleAddressLookup(date);
  });
  mkdirSync(join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
  const app = express(),
    server = createServer(app),
    wss = new WebSocketServer({ server, path: "/live", maxPayload: 4096 });
  const connections = new Map<WebSocket, Session>();
  const socketTokens = new Map<WebSocket, string>();
  let routingBusy = false;
  let closing = false;
  const hasLocation = (row: { lat?: unknown; lng?: unknown }) =>
    isPoint(row) && !(row.lat === 0 && row.lng === 0);
  const notify = (event: string, payload: any = {}, driverId?: string) => {
    for (const [ws, user] of connections)
      if (
        ws.readyState === WebSocket.OPEN &&
        (user.role === "admin" || user.userId === driverId)
      )
        ws.send(JSON.stringify({ event, ...payload }));
  };
  const locateSavedAddresses = async (
    date: string,
    ids?: string[],
    allowRouting = false,
    maximum = 25,
  ) => {
    const candidates = store
      .shipments(date)
      .filter(
        (row) =>
          row.status === "pending" &&
          !row.routeId &&
          !hasLocation(row) &&
          (!ids || ids.includes(row.id)),
      );
    const unresolved: { id: string; address: string; message: string }[] = [];
    const deadline = Date.now() + 25000;
    let resolved = 0;
    for (const row of candidates.slice(0, maximum)) {
      if (closing || Date.now() >= deadline || (routingBusy && !allowRouting)) break;
      try {
        const point = await geocode(store, row.address);
        if (closing || (routingBusy && !allowRouting)) break;
        const current = store.one("SELECT * FROM shipments WHERE id=?", row.id);
        if (
          current?.address !== row.address ||
          current.status !== "pending" ||
          current.routeId ||
          hasLocation(current)
        )
          continue;
        store.run(
          "UPDATE shipments SET lat=?,lng=? WHERE id=? AND address=? AND status='pending' AND routeId IS NULL",
          point.lat,
          point.lng,
          row.id,
          row.address,
        );
        resolved++;
      } catch (error) {
        unresolved.push({
          id: row.id,
          address: row.address,
          message:
            error instanceof GeocodingError
              ? error.message
              : "배송주소를 확인하지 못했습니다. 주소를 확인한 뒤 다시 시도해 주세요.",
        });
        if (error instanceof GeocodingError && error.code !== "NOT_FOUND")
          break;
      }
    }
    const remaining = closing
      ? 0
      : store
          .shipments(date)
          .filter(
            (row) =>
              row.status === "pending" &&
              !row.routeId &&
              !hasLocation(row) &&
              (!ids || ids.includes(row.id)),
          ).length;
    if (resolved && !closing) notify("changed");
    return { resolved, unresolved, remaining };
  };
  const addressJobs = new Set<Promise<unknown>>();
  const queuedAddressDates = new Set<string>();
  const scheduleAddressLookup = (date: string) => {
    if (closing || queuedAddressDates.has(date) || !(options.autoGeocode ?? (!options.test && options.roadRouting !== false))) return;
    queuedAddressDates.add(date);
    const job = Promise.resolve().then(() => locateSavedAddresses(date)).catch(() => {}).finally(() => {
      queuedAddressDates.delete(date);
      addressJobs.delete(job);
    });
    addressJobs.add(job);
  };
  const liveTimer = setInterval(() => {
    for (const [ws, user] of connections) {
      const valid = store.session(socketTokens.get(ws) ?? "");
      if (!valid) {
        connections.delete(ws);
        socketTokens.delete(ws);
        ws.close(1008, "Session expired");
      } else if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30000);
  liveTimer.unref();
  wss.on("connection", (ws) => {
    let token = "";
    const deadline = setTimeout(() => {
      if (!connections.has(ws)) ws.close(1008);
    }, 5000);
    ws.on("message", (buffer) => {
      try {
        const message = JSON.parse(buffer.toString());
        if (message.type !== "auth") return;
        token = String(message.token ?? "");
        const user = store.session(token);
        if (!user) return ws.close(1008);
        connections.set(ws, user);
        socketTokens.set(ws, token);
        clearTimeout(deadline);
        ws.send(JSON.stringify({ event: "connected" }));
      } catch {
        ws.close(1008);
      }
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      connections.delete(ws);
      socketTokens.delete(ws);
    });
  });
  app.disable("x-powered-by");
  // Trust only the local Nginx proxy when deploying behind the Cafe24 VPS.
  if (process.env.TRUST_PROXY === "loopback") {
    app.set("trust proxy", "loopback");
  }
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      strictTransportSecurity: false,
    }),
  );
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(
          null,
          !origin ||
            (!allowedOrigins.length && process.env.NODE_ENV !== "production") ||
            allowedOrigins.includes(origin),
        ),
    }),
  );
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_req, res) =>
    res.json({ ok: true, service: "bareun-dispatch", version:APP_VERSION, revision:APP_REVISION }),
  );
  app.get("/api/setup", (_req, res) =>
    res.json({
      required: !store.one("SELECT id FROM users WHERE role=?", "admin"),
      bootstrapCodeRequired: !!process.env.DISPATCH_BOOTSTRAP_TOKEN,
    }),
  );
  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: options.test ? 100 : 12,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "시도가 너무 많습니다. 10분 후 다시 시도해 주세요." },
  });
  app.post("/api/setup", authLimiter, (req, res) => {
    assert(
      !store.one("SELECT id FROM users WHERE role=?", "admin"),
      "관리자가 이미 등록되어 있습니다.",
      409,
    );
    if (process.env.NODE_ENV === "production")
      assert(
        process.env.DISPATCH_BOOTSTRAP_TOKEN,
        "서버에 최초 관리자 등록 코드가 설정되지 않았습니다.",
        503,
      );
    if (process.env.DISPATCH_BOOTSTRAP_TOKEN) {
      const expected = Buffer.from(process.env.DISPATCH_BOOTSTRAP_TOKEN),
        actual = Buffer.from(String(req.body.bootstrapCode ?? ""));
      assert(
        expected.length === actual.length && timingSafeEqual(expected, actual),
        "등록 코드가 일치하지 않습니다.",
        403,
      );
    }
    const pin = pinValue(req.body.pin);
    assert(
      typeof req.body.name === "string" && req.body.name.trim(),
      "관리자 이름을 입력해 주세요.",
    );
    store.createUser("admin", req.body.name.trim().slice(0, 100), pin);
    res.status(201).json(store.login(pin));
  });
  app.post("/api/login", authLimiter, (req, res) => {
    const pin = pinValue(req.body.pin),
      session = store.login(pin);
    assert(session, "PIN을 확인해 주세요.", 401);
    res.json(session);
  });
  app.use("/api", (request, response, next) => {
    if (request.path.startsWith("/files/")) return next();
    const req = request as AuthRequest;
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const user = token ? store.session(token) : undefined;
    if (!user)
      return response.status(401).json({ error: "다시 로그인해 주세요." });
    req.user = user;
    req.token = token;
    next();
  });
  const admin = (req: Request, _res: Response, next: NextFunction) => {
    assert(
      (req as AuthRequest).user.role === "admin",
      "관리자만 사용할 수 있습니다.",
      403,
    );
    next();
  };
  const driver = (req: Request, _res: Response, next: NextFunction) => {
    assert(
      (req as AuthRequest).user.role === "driver",
      "기사만 사용할 수 있습니다.",
      403,
    );
    next();
  };
  app.post("/api/logout", (request, res) => {
    const req = request as AuthRequest;
    store.run(
      "DELETE FROM sessions WHERE tokenHash=?",
      store.hashToken(req.token),
    );
    for (const [ws, user] of connections)
      if (user.userId === req.user.userId) ws.close(1008);
    res.json({ ok: true });
  });
  const driverRoute = (route: Route | null) =>
    route
      ? {
          ...route,
          stops: route.stops.map(
            ({ amount, customerCode, salesReference, erpSourceKey, erpCustomerId, ...stop }) => ({
              ...stop,
              items: stop.items.map(({ name, quantity, code, specification, pattern }) => ({
                name,
                quantity,
                ...(code ? { code } : {}),
                ...(specification ? { specification } : {}),
                ...(pattern ? { pattern } : {}),
              })),
            }),
          ),
        }
      : null;
  app.get("/api/me", (request, res) => {
    const req = request as AuthRequest;
    let route: Route | null = null;
    if (req.user.role === "driver") {
      const row = store.one(
        "SELECT * FROM routes WHERE driverId=? AND (serviceDate=? OR status IN ('active','returning')) ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'returning' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,rowid DESC LIMIT 1",
        req.user.userId,
        dateValue(req.query.date),
      );
      if (row) route = store.route(row);
    }
    res.json({
      user: req.user,
      company: store.company(),
      route: driverRoute(route),
      mapSettings: { naverKeyId: store.mapSettings().naverKeyId },
    });
  });
  app.get("/api/company", (req, res) => res.json(store.company()));
  app.get("/api/map-settings", admin, (_req, res) =>
    res.json(store.mapSettings()),
  );
  app.put("/api/map-settings", admin, (req, res) => {
    const value = req.body?.naverKeyId;
    assert(typeof value === "string", "네이버 지도 Key ID를 입력해 주세요.");
    const naverKeyId = value.trim();
    assert(
      !naverKeyId || /^[A-Za-z0-9_-]{5,128}$/.test(naverKeyId),
      "네이버 지도 Key ID 형식을 확인해 주세요.",
    );
    store.run(
      "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      "map",
      JSON.stringify({ naverKeyId }),
    );
    // The public browser key applies to every map. Send only a refresh signal.
    for (const ws of connections.keys())
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ event: "changed" }));
    res.json(store.mapSettings());
  });
  app.put("/api/company", admin, async (req, res) => {
    assert(!routingBusy, "배차 작업이 끝난 뒤 회사 설정을 변경해 주세요.", 409);
    const c = req.body as Company;
    assert(
      typeof c.name === "string" &&
        c.name.trim() &&
        typeof c.address === "string" &&
        c.address.trim() &&
        c.address.length <= 500,
      "회사명과 출발·복귀 주소를 입력해 주세요.",
    );
    assert(
      Number.isFinite(c.serviceMinutes) &&
        c.serviceMinutes >= 0 &&
        c.serviceMinutes <= 120,
      "배송지 체류 시간은 0~120분으로 입력해 주세요.",
    );
    assert(
      ["kakao", "naver", "default"].includes(c.navigation),
      "길안내 설정을 확인해 주세요.",
    );
    assert(
      !store.one(
        "SELECT id FROM routes WHERE status IN ('active','returning') LIMIT 1",
      ),
      "운행 중에는 출발지를 변경할 수 없습니다. 회사 복귀 후 변경해 주세요.",
      409,
    );
    routingBusy = true;
    try {
      const before = store.company();
      const point = hasLocation(c) ? { lat: c.lat, lng: c.lng } : c.address.trim() === before.address && hasLocation(before) ? { lat: before.lat, lng: before.lng } : await geocode(store, c.address.trim());
      store.transaction(() => {
        assert(
          JSON.stringify(store.company()) === JSON.stringify(before) &&
            !store.one(
              "SELECT id FROM routes WHERE status IN ('active','returning') LIMIT 1",
            ),
          "회사나 운행 정보가 변경되었습니다. 다시 확인해 주세요.",
          409,
        );
        store.run(
          "UPDATE settings SET value=? WHERE key=?",
          JSON.stringify({
            name: c.name.trim().slice(0, 100),
            address: c.address.trim(),
            ...point,
            serviceMinutes: c.serviceMinutes,
            navigation: c.navigation,
          }),
          "company",
        );
        for (const route of store.all(
          "SELECT id FROM routes WHERE status='planned'",
        ))
          store.run(
            "DELETE FROM settings WHERE key=?",
            "manual-route:" + route.id,
          );
        store.run(
          "UPDATE shipments SET routeId=NULL,sequence=NULL,status='pending' WHERE routeId IN (SELECT id FROM routes WHERE status='planned')",
        );
        store.run("DELETE FROM routes WHERE status='planned'");
      });
      notify("changed");
      res.json(store.company());
    } finally { routingBusy = false; }
  });
  app.get("/api/drivers", admin, (_req, res) => res.json(store.drivers()));
  app.get("/api/drivers/:id/pin", admin, (req, res) => {
    res.set("Cache-Control", "no-store");
    assert(
      store.one(
        "SELECT id FROM users WHERE id=? AND role=?",
        req.params.id,
        "driver",
      ),
      "기사를 찾을 수 없습니다.",
      404,
    );
    res.json({ pin: store.driverPin(String(req.params.id)) });
  });
  app.post("/api/drivers", admin, (req, res) => {
    const pin = pinValue(req.body.pin ?? String(randomInt(100000, 1000000)));
    assert(
      typeof req.body.name === "string" && req.body.name.trim(),
      "기사 이름을 입력해 주세요.",
    );
    const capacity = Number(req.body.capacity ?? 10);
    assert(
      Number.isInteger(capacity) && capacity >= 1 && capacity <= 200,
      "최대 배송지 수는 1~200개로 입력해 주세요.",
    );
    assert(
      !store.one("SELECT id FROM users WHERE pinIndex=?", store.pinIndex(pin)),
      "이미 사용 중인 PIN입니다.",
    );
    const created = store.createUser(
      "driver",
      req.body.name.trim().slice(0, 100),
      pin,
      String(req.body.phone ?? "").slice(0, 40),
      capacity,
    );
    notify("changed");
    res
      .set("Cache-Control", "no-store")
      .status(201)
      .json({ ...created, pin });
  });
  app.patch("/api/drivers/:id", admin, (req, res) => {
    assert(!routingBusy, "배차 작업이 끝난 뒤 기사 정보를 수정해 주세요.", 409);
    const existing = store.one(
      "SELECT * FROM users WHERE id=? AND role=?",
      req.params.id,
      "driver",
    );
    assert(existing, "기사를 찾을 수 없습니다.", 404);
    const capacity = Number(req.body.capacity ?? existing.capacity),
      name = String(req.body.name ?? existing.name).trim(),
      active =
        req.body.active === undefined
          ? existing.active
          : Number(!!req.body.active);
    assert(
      name && Number.isInteger(capacity) && capacity >= 1 && capacity <= 200,
      "기사 이름과 최대 배송지 수를 확인해 주세요.",
    );
    const largestAssigned =
      store.one(
        "SELECT MAX(n) AS n FROM (SELECT COUNT(shipments.id) AS n FROM routes JOIN shipments ON shipments.routeId=routes.id WHERE routes.driverId=? AND routes.status IN ('planned','active','returning') GROUP BY routes.id)",
        existing.id,
      )?.n ?? 0;
    assert(
      capacity >= largestAssigned,
      "이미 배정된 배송지 수보다 한도를 줄일 수 없습니다. 배차를 먼저 조정해 주세요.",
      409,
    );
    if (!active)
      assert(
        !store.one(
          "SELECT id FROM routes WHERE driverId=? AND status IN ('planned','active','returning')",
          existing.id,
        ),
        "배차된 코스가 있습니다. 배차 조정과 복귀 후 비활성화해 주세요.",
        409,
      );
    store.run(
      "UPDATE users SET name=?,phone=?,capacity=?,active=? WHERE id=?",
      name.slice(0, 100),
      String(req.body.phone ?? existing.phone).slice(0, 40),
      capacity,
      active,
      existing.id,
    );
    if (!active) store.run("DELETE FROM sessions WHERE userId=?", existing.id);
    notify("changed", {}, existing.id);
    res.json({ ok: true });
  });
  app.post("/api/drivers/:id/pin", admin, (req, res) => {
    const user = store.one(
      "SELECT * FROM users WHERE id=? AND role=?",
      req.params.id,
      "driver",
    );
    assert(user, "기사를 찾을 수 없습니다.", 404);
    const pin = pinValue(req.body.pin ?? String(randomInt(100000, 1000000))),
      p = store.pinFields(pin);
    assert(
      !store.one(
        "SELECT id FROM users WHERE pinIndex=? AND id<>?",
        p.pinIndex,
        user.id,
      ),
      "이미 사용 중인 PIN입니다.",
    );
    store.transaction(() => {
      store.run(
        "UPDATE users SET pinIndex=?,pinHash=?,salt=?,pinEncrypted=? WHERE id=?",
        p.pinIndex,
        p.pinHash,
        p.salt,
        store.encryptDriverPin(user.id, pin),
        user.id,
      );
      store.run("DELETE FROM sessions WHERE userId=?", user.id);
    });
    for (const [ws, session] of connections)
      if (session.userId === user.id) ws.close(1008);
    res.set("Cache-Control", "no-store").json({ pin });
  });
  app.post("/api/demo", admin, (_req, res) => {
    const drivers = seedDemo(store);
    notify("changed");
    res
      .set("Cache-Control", "no-store")
      .status(201)
      .json({ drivers, count: 25 });
  });
  app.post("/api/demo/clear", admin, (_req, res) => {
    assert(
      store.one("SELECT value FROM settings WHERE key=?", "demo")?.value ===
        "true",
      "삭제할 예시 데이터가 없습니다.",
    );
    assert(
      !store.one(
        "SELECT id FROM routes WHERE status IN ('active','returning')",
      ),
      "운행을 종료한 뒤 예시 데이터를 지워 주세요.",
      409,
    );
    assert(
      !store.one("SELECT id FROM imports LIMIT 1"),
      "실제 업로드가 있어 전체 예시 삭제를 중단했습니다. 데이터 보존을 위해 새 데이터 디렉터리를 사용해 주세요.",
      409,
    );
    const demoIds = JSON.parse(
      store.one("SELECT value FROM settings WHERE key=?", "demoIds")?.value ??
        "{}",
    );
    assert(
      store
        .shipments(today())
        .every((s) => demoIds.shipments?.includes(s.id)) &&
        store
          .all("SELECT id FROM shipments")
          .every((s) => demoIds.shipments?.includes(s.id)) &&
        store.drivers().every((d) => demoIds.drivers?.includes(d.id)),
      "실제 기사나 배송지가 추가되어 전체 예시 삭제를 중단했습니다. 실제 데이터를 보존해 주세요.",
      409,
    );
    store.transaction(() => {
      store.run("DELETE FROM position_history");
      store.run("DELETE FROM positions");
      store.run("DELETE FROM shipments");
      store.run("DELETE FROM routes");
      store.run(
        "DELETE FROM sessions WHERE userId IN (SELECT id FROM users WHERE role='driver')",
      );
      store.run("DELETE FROM users WHERE role='driver'");
      store.run("DELETE FROM settings WHERE key='demo'");
      store.run("DELETE FROM settings WHERE key='demoIds'");
    });
    notify("changed");
    res.json({ ok: true });
  });
  app.post("/api/geocode", admin, async (req, res) => {
    assert(
      typeof req.body.address === "string" && req.body.address.trim() && req.body.address.length <= 500,
      "주소를 입력해 주세요.",
    );
    res.json(await geocode(store, req.body.address.trim()));
  });
  app.post("/api/navigation/resolve", async (request, res) => {
    const req = request as AuthRequest;
    let address: string;
    let row: any;
    if (req.body.shipmentId !== undefined) {
      assert(
        typeof req.body.shipmentId === "string",
        "배송지를 확인해 주세요.",
      );
      row = store.one(
        "SELECT * FROM shipments WHERE id=?",
        req.body.shipmentId,
      );
      assert(row, "배송지를 찾을 수 없습니다.", 404);
      if (req.user.role !== "admin") {
        assert(
          store.one(
            "SELECT id FROM routes WHERE id=? AND driverId=?",
            row.routeId,
            req.user.userId,
          ),
          "배정된 배송지만 길찾기할 수 있습니다.",
          403,
        );
      }
      address = row.address;
    } else {
      assert(req.user.role === "admin", "배정된 배송지를 선택해 주세요.", 403);
      address = req.body.address;
    }
    assert(
      typeof address === "string" && address.trim() && address.length <= 500,
      "배송주소를 입력해 주세요.",
    );
    if (row && hasLocation(row))
      return res.json({ lat: row.lat, lng: row.lng });
    const point = await geocode(store, address.trim());
    if (row && !routingBusy) {
      store.run(
        "UPDATE shipments SET lat=?,lng=? WHERE id=? AND address=? AND status='pending' AND routeId IS NULL",
        point.lat,
        point.lng,
        row.id,
        address,
      );
    }
    res.json(point);
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });
  app.get("/api/imports", admin, (req, res) => {
    const date = req.query.date ? dateValue(req.query.date) : null;
    res.json(
      store.all(
        `SELECT id,fileName,mime,status,serviceDate,createdAt,count,json_extract(meta,'$.source') AS source FROM imports ${date ? "WHERE serviceDate=?" : ""} ORDER BY createdAt DESC LIMIT 200`,
        ...(date ? [date] : []),
      ),
    );
  });
  app.get("/api/imports/:id", admin, (req, res) => {
    const row = store.one("SELECT * FROM imports WHERE id=?", req.params.id);
    assert(row, "업로드를 찾을 수 없습니다.", 404);
    res.json({
      ...row,
      source: JSON.parse(row.meta || "{}").source,
      documents: JSON.parse(row.meta || "{}").documents,
      drafts: JSON.parse(row.drafts),
      recognitionWarnings: JSON.parse(row.meta || "{}").warnings ?? [],
      storedName: undefined,
      meta: undefined,
    });
  });
  app.get("/api/catalog/:kind", admin, async (req, res) => {
    assert(
      ["customers", "products"].includes(String(req.params.kind)),
      "자료 종류를 확인해 주세요.",
    );
    res.json(
      await companyErp.search(req.params.kind as "customers" | "products", typeof req.query.q === "string" ? req.query.q : ""),
    );
  });
  app.get("/api/erp/status", admin, (_req, res) =>
    res.json({
      mode: "company-erp",
      company: companyErp.status(),
      version:APP_VERSION,
      revision:APP_REVISION,
      invoiceReferenceLookup:true,
      salesInvoiceBrowser: true,
      automaticCompanyCatalogs: true,
      administratorDelete: true,
      salesDateFilter: true,
      regionalDispatch: true,
      customers: store.one("SELECT COUNT(*) AS n FROM catalog_customers").n,
      products: store.one("SELECT COUNT(*) AS n FROM catalog_products").n,
    }),
  );
  app.get("/api/company-erp/sale-context", admin, async (_req, res) =>
    res.json(await companySales.context()),
  );
  app.post("/api/company-erp/sale-requests", admin, (req, res) =>
    res.status(201).json(companySales.create((req as AuthRequest).user.userId)),
  );
  app.get("/api/company-erp/sale-requests", admin, (req, res) =>
    res.json(companySales.pending((req as AuthRequest).user.userId)),
  );
  app.get("/api/company-erp/sale-requests/:id", admin, (req, res) =>
    res.json(companySales.detail(String(req.params.id), (req as AuthRequest).user.userId)),
  );
  app.post("/api/company-erp/sale-requests/:id/commit", admin, async (req, res) =>
    res.status(201).json(await companySales.save(
      String(req.params.id), (req as AuthRequest).user.userId, req.body.row,
    )),
  );
  app.post("/api/company-erp/catalog/:kind/sync", admin, async (req, res) => {
    assert(["customers", "products"].includes(String(req.params.kind)), "조회 항목을 확인해 주세요.");
    res.json(await companyErp.sync(req.params.kind as "customers" | "products"));
  });
  app.post("/api/company-erp/catalog/refresh", admin, async (_req, res) =>
    res.json(await companyErp.refreshCatalogs()),
  );
  app.get("/api/company-erp/connection", admin, async (req, res) =>
    res.json({ version: APP_VERSION, ...await companyErp.connection(dateValue(req.query.date)) }),
  );
  app.get("/api/company-erp/invoices", admin, async (req, res) => {
    assert(typeof req.query.reference === "string", "전표번호를 입력해 주세요.", 400);
    res.json(await companyErp.invoice(req.query.reference));
  });
  app.post("/api/company-erp/sales/confirm-reference", admin, async (req, res) => {
    assert(typeof req.body.reference === "string" && typeof req.body.fingerprint === "string", "확인할 ERP 전표를 선택해 주세요.",400);
    res.status(201).json(await salesLists.confirmReference(req.body.reference,req.body.fingerprint,dateValue(req.body.serviceDate),req.body.delivery));
  });
  app.post("/api/company-erp/sales/reference-list", admin, async (req, res) => {
    assert(typeof req.body.reference === "string", "전표번호를 입력해 주세요.", 400);
    res.status(201).json(await salesLists.reference(req.body.reference, dateValue(req.body.serviceDate)));
  });
  app.post("/api/company-erp/sales/lists", admin, async (req, res) =>
    res.status(201).json(await salesLists.fetch(
      dateValue(req.body.salesDate), dateValue(req.body.serviceDate),
    )),
  );
  app.get("/api/company-erp/sales/lists/latest", admin, (req, res) =>
    res.json(salesLists.latest(dateValue(req.query.salesDate))),
  );
  app.get("/api/company-erp/sales/lists/:id", admin, (req, res) =>
    res.json(salesLists.get(String(req.params.id))),
  );
  app.post("/api/company-erp/sales/lists/:id/dispatch", admin, async (req, res) =>
    res.status(201).json(await salesLists.dispatch(String(req.params.id), req.body)),
  );
  app.get("/api/shipments/:id/invoice", admin, async (req, res) =>
    res.json(await salesLists.shipmentInvoice(String(req.params.id))),
  );
  app.post("/api/company-erp/sales/fetch", admin, async (req, res) => {
    assert(typeof req.body.salesDate === "string", "가져올 판매일자를 입력해 주세요.");
    const salesDate = dateValue(req.body.salesDate), date = dateValue(req.body.serviceDate);
    const result = await companyErp.sales(salesDate);
    if (!result.drafts.length) return res.json({
      ...result, empty: true,
      message: result.duplicateDocuments === result.sourceCount && result.sourceCount > 0
        ? "모든 판매전표가 이미 등록되어 있습니다. 중복으로 가져오지 않았습니다."
        : `${salesDate}에 새로 가져올 확정 배송 전표가 없습니다.`,
    });
    const importId = id(), storedName = importId + ".json", fileName = `회사ERP_판매조회_${salesDate}.json`;
    writeFileSync(join(dataDir, "uploads", storedName), JSON.stringify(result), {mode: 0o600, flag: "wx"});
    try {
      store.run("INSERT INTO imports(id,fileName,storedName,mime,drafts,serviceDate,createdAt,meta) VALUES(?,?,?,?,?,?,?,?)",
        importId, fileName, storedName, "application/json", JSON.stringify(result.drafts), date, new Date().toISOString(),
        JSON.stringify({source:"company-erp", warnings:result.recognitionWarnings, salesDate, sourceReadAt:result.sourceReadAt}));
    } catch (e) {try {unlinkSync(join(dataDir,"uploads",storedName));} catch {} throw e;}
    notify("changed");
    res.status(201).json({...result, id:importId, fileName, serviceDate:date, rawText:"", status:"review"});
  });
  // Keep old clients from silently connecting to the removed provider.
  for (const path of ["/api/erp/products/sync", "/api/erp/products/lookup", "/api/erp/live/:kind"]) {
    app.all(path, admin, (_req, res) => res.status(410).json({
      code: "INTEGRATION_REMOVED", error: "이전 ERP 연동은 종료했습니다. 회사 ERP 자동 조회를 사용해 주세요.",
    }));
  }
  app.post(
    "/api/erp/catalog/:kind/import",
    admin,
    upload.single("file"),
    async (req, res) => {
      assert(req.file, "엑셀 파일을 선택해 주세요.");
      assert(
        ["customers", "products"].includes(String(req.params.kind)),
        "자료 종류를 확인해 주세요.",
      );
      const result = await importCatalog(
        store,
        req.file.buffer,
        req.file.originalname,
        req.params.kind as "customers" | "products",
      );
      res.status(201).json(result);
    },
  );
  app.post(
    "/api/erp/sales/import",
    admin,
    upload.single("file"),
    async (req, res) => {
      assert(req.file, "판매조회 엑셀을 선택해 주세요.");
      assert(req.body.salesDate===undefined||typeof req.body.salesDate==="string","판매조회 일자를 확인해 주세요.");
      const date = dateValue(req.body.serviceDate),
        file = req.file;
      const parsed = await parseSalesExport(
        store,
        file.buffer,
        file.originalname,
        { salesDate: req.body.salesDate === undefined ? undefined : dateValue(req.body.salesDate) },
      );
      const importId = id(),
        storedName = importId + extname(file.originalname).toLowerCase(),
        fileName = Buffer.from(file.originalname, "latin1").toString("utf8");
      writeFileSync(join(dataDir, "uploads", storedName), file.buffer, {
        mode: 0o600,
        flag: "wx",
      });
      try {
        store.run(
          "INSERT INTO imports(id,fileName,storedName,mime,drafts,serviceDate,createdAt,meta) VALUES(?,?,?,?,?,?,?,?)",
          importId,
          fileName,
          storedName,
          file.mimetype,
          JSON.stringify(parsed.drafts),
          date,
          new Date().toISOString(),
          JSON.stringify({ source: "ecount-excel", warnings: parsed.warnings, salesDate: parsed.salesDate, dateSummary: parsed.dateSummary }),
        );
      } catch (error) {
        try {
          unlinkSync(join(dataDir, "uploads", storedName));
        } catch {}
        throw error;
      }
      notify("changed");
      res
        .status(201)
        .json({
          id: importId,
          fileName,
          rawText: "",
          drafts: parsed.drafts,
          serviceDate: date,
          status: "review",
          recognitionWarnings: parsed.warnings, salesDate: parsed.salesDate, dateSummary: parsed.dateSummary,
        });
    },
  );
  const deviceReceiptKey = (req: Request, value: unknown) => {
    assert(
      typeof value === "string" && value.trim().length > 0 && value.length <= 128,
      "전표 저장 요청 번호가 올바르지 않습니다. 전표를 다시 확인해 주세요.",
      422,
    );
    return (
      "device-receipt:" +
      createHash("sha256")
        .update((req as AuthRequest).user.userId)
        .update("\0")
        .update(value.trim())
        .digest("hex")
    );
  };
  const mappedDeviceReceipt = (key: string) => {
    const setting = store.one("SELECT value FROM settings WHERE key=?", key);
    if (!setting) return undefined;
    let mapping: { importId?: string; digest?: string };
    try {
      mapping = JSON.parse(setting.value);
    } catch {
      return undefined;
    }
    if (
      !mapping ||
      typeof mapping.importId !== "string" ||
      typeof mapping.digest !== "string"
    )
      return undefined;
    const batch = store.one(
      "SELECT * FROM imports WHERE id=?",
      mapping.importId,
    );
    return batch ? { batch, digest: mapping.digest } : undefined;
  };
  app.post("/api/imports", admin, upload.single("file"), async (req, res) => {
    assert(req.file, "사진 또는 엑셀 파일을 선택해 주세요.");
    const file = req.file,
      date = dateValue(req.body.serviceDate),
      extension = extname(file.originalname).toLowerCase();
    assert(
      [".xlsx", ".csv", ".jpg", ".jpeg", ".png", ".webp"].includes(extension),
      "엑셀(.xlsx·.csv) 또는 사진(.jpg·.png·.webp)을 선택해 주세요.",
    );
    let rawText = "",
      drafts;
    let spreadsheetWarnings:string[]=[];
    let importSource:string|undefined;
    let deviceKey: string | undefined;
    let deviceDigest: string | undefined;
    const deviceRecognition =
      req.body.recognitionSource !== undefined ||
      req.body.recognizedText !== undefined ||
      req.body.recognizedLayout !== undefined ||
      req.body.deviceReceiptId !== undefined;
    const company = store.company();
    const receiptContext = {
      supplierName: company.name,
      supplierAddress: company.address,
    };
    if ([".xlsx", ".csv"].includes(extension)) {
      assert(
        !deviceRecognition,
        "기기 인식 결과는 전표 사진과 함께 보내 주세요.",
        422,
      );
      if(await isSalesSpreadsheet(file.buffer,file.originalname)){
        const result=await parseSalesExport(store,file.buffer,file.originalname,{salesDate:date});drafts=result.drafts;spreadsheetWarnings=["판매조회 형식을 감지해 선택한 배송일의 전표를 읽었습니다.",...result.warnings];importSource="ecount-excel";
      }else{const result=await parseSpreadsheetPreview(file.buffer,file.originalname);drafts=result.drafts;spreadsheetWarnings=result.warnings;}

    } else if (deviceRecognition) {
      const recognizedText = typeof req.body.recognizedText === "string"
        ? req.body.recognizedText.replace(/\r\n?/g, "\n")
        : null;
      assert(
        req.body.recognitionSource === "android-device" &&
          recognizedText !== null &&
          recognizedText.length <= 50_000 &&
          recognizedText.trim().length > 0,
        "전표 인식 결과가 올바르지 않습니다. 사진을 다시 촬영하거나 선택해 주세요.",
        422,
      );
      // The Android app already read this image with its bundled recognizer.
      // Preserve that text and the original photo without waiting for server OCR.
      let layout: ReceiptLayout | undefined;
      if (req.body.recognizedLayout !== undefined) {
        try {
          if (typeof req.body.recognizedLayout !== "string")
            throw new Error("Invalid layout field");
          layout = normalizeReceiptLayout(
            JSON.parse(req.body.recognizedLayout),
          );
        } catch {
          throw new AppError(
            "전표 인식 위치 정보가 올바르지 않습니다. 사진을 다시 촬영하거나 선택해 주세요.",
            422,
          );
        }
      }
      validateReceiptImage(file.buffer);
      rawText = recognizedText.trim();
      drafts = [extractReceipt(rawText, layout, receiptContext).draft];
      if (req.body.deviceReceiptId !== undefined) {
        deviceKey = deviceReceiptKey(req, req.body.deviceReceiptId);
        deviceDigest = createHash("sha256")
          .update(
            JSON.stringify({
              file: createHash("sha256").update(file.buffer).digest("hex"),
              rawText,
              date,
              // Omit absent layout so pending requests from older APKs keep their digest.
              ...(layout ? { layout } : {}),
            }),
          )
          .digest("hex");
      }
    } else {
      const cancellation = new AbortController();
      const cancel = () => {
        if (!res.writableEnded) cancellation.abort();
      };
      // Request "close" also fires after normal multipart parsing. Only an
      // unfinished response closing means the phone actually cancelled/left.
      res.once("close", cancel);
      try {
        rawText = await recognizeReceipt(file.buffer, {
          signal: cancellation.signal,
        });
        if (cancellation.signal.aborted || res.destroyed) return;
        assert(
          rawText.trim(),
          "전표의 글자를 읽지 못했습니다. 글자가 선명하게 나오도록 다시 촬영하거나 배송지를 직접 입력해 주세요.",
          422,
        );
        drafts = [extractReceipt(rawText, undefined, receiptContext).draft];
      } catch (error) {
        if (cancellation.signal.aborted || res.destroyed) return;
        throw error;
      } finally {
        res.off("close", cancel);
      }
    }
    let created = false;
    const result = store.transaction(() => {
      // The lookup and insert share a transaction so lost responses and even
      // another API process cannot create a second import or original file.
      const previous = deviceKey ? mappedDeviceReceipt(deviceKey) : undefined;
      if (previous) {
        assert(
          previous.digest === deviceDigest,
          "같은 전표 저장 요청에 다른 사진이나 인식 내용이 포함되어 있습니다. 새 전표로 다시 확인해 주세요.",
          409,
        );
        return {
          id: previous.batch.id, fileName: previous.batch.fileName,
          rawText: previous.batch.rawText, drafts: JSON.parse(previous.batch.drafts),
          serviceDate: previous.batch.serviceDate, status: previous.batch.status,
        };
      }
      const importId = id(),
        storedName = importId + extension,
        fileName = Buffer.from(file.originalname, "latin1").toString("utf8");
      writeFileSync(join(dataDir, "uploads", storedName), file.buffer, {
        mode: 0o600,
        flag: "wx",
      });
      store.run(
        "INSERT INTO imports(id,fileName,storedName,mime,rawText,drafts,serviceDate,createdAt,meta) VALUES(?,?,?,?,?,?,?,?,?)",
        importId, fileName, storedName, file.mimetype, rawText,
        JSON.stringify(drafts), date, new Date().toISOString(), JSON.stringify({source:importSource,warnings:spreadsheetWarnings}),
      );
      if (deviceKey)
        store.run(
          "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          deviceKey,
          JSON.stringify({ importId, digest: deviceDigest }),
        );
      created = true;
      return {
        id: importId,
        fileName,
        rawText,
        drafts,
        serviceDate: date,
        status: "review", recognitionWarnings: spreadsheetWarnings,
      };
    });
    if (created) notify("changed");
    res.status(201).json(result);
  });
  const insertShipment = (
    s: any,
    date: string,
    importId: string | null = null,
  ) =>
    store.run(
      "INSERT INTO shipments(id,importId,recipient,address,phone,items,notes,lat,lng,serviceDate,createdAt,amount,customerCode,salesReference,erpSourceKey) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id(),
      importId,
      s.recipient,
      s.address,
      s.phone ?? "",
      JSON.stringify(s.items),
      s.notes ?? "",
      s.lat ?? null,
      s.lng ?? null,
      date,
      new Date().toISOString(),
      s.amount ?? null,
      s.customerCode ?? null,
      s.salesReference ?? null,
      s.erpSourceKey ?? null,
    );
  app.post("/api/imports/:id/commit", admin, (req, res) => {
    const batch = store.one("SELECT * FROM imports WHERE id=?", req.params.id);
    assert(batch, "업로드를 찾을 수 없습니다.", 404);
    const commitDeviceKey = req.body.deviceReceiptId !== undefined
      ? deviceReceiptKey(req, req.body.deviceReceiptId)
      : undefined;
    if (!commitDeviceKey) assert(batch.status === "review", "이미 등록한 전표입니다.", 409);
    const rows = validateShipments(req.body.rows);
    let committed = false;
    let count = rows.length;
    store.transaction(() => {
      const current = store.one("SELECT * FROM imports WHERE id=?", batch.id);
      assert(current, "업로드를 찾을 수 없습니다.", 404);
      if (commitDeviceKey) {
        const previous = mappedDeviceReceipt(commitDeviceKey);
        assert(
          previous?.batch.id === batch.id,
          "전표 저장 요청 번호가 해당 전표와 일치하지 않습니다.",
          409,
        );
        if (current.status === "committed") {
          assert(
            JSON.stringify(rows) === JSON.stringify(JSON.parse(current.drafts)),
            "이미 저장한 전표와 수정 내용이 다릅니다. 배송 내역에서 확인해 주세요.",
            409,
          );
          count = current.count;
          return;
        }
      }
      assert(current.status === "review", "이미 등록한 전표입니다.", 409);
      const originals = JSON.parse(current.drafts) as Shipment[];
      const allowed = new Set(
        originals.map((row) => row.erpSourceKey).filter(Boolean),
      );
      const keys = rows
        .map((row) => row.erpSourceKey)
        .filter(Boolean) as string[];
      assert(
        new Set(keys).size === keys.length &&
          keys.every((key) => allowed.has(key)),
        "판매전표 번호가 원본과 일치하지 않습니다.",
        409,
      );
      if (["ecount-excel", "company-erp"].includes(JSON.parse(current.meta || "{}").source))
        assert(
          rows.every(
            (row) => row.erpSourceKey && allowed.has(row.erpSourceKey),
          ),
          "판매내역은 원본의 전표번호를 유지해 주세요.",
          409,
        );
      for (const row of rows.filter(row=>row.erpSourceKey)) {
        const original = originals.find(item=>item.erpSourceKey===row.erpSourceKey)!;
        const aliases = salesImportKeys(original);
        assert(!aliases.some(key=>store.one("SELECT sourceKey FROM erp_sales_links WHERE sourceKey=?",key))&&!savedManualSale(store,original),"이미 등록한 판매전표가 포함되어 있습니다. 중복 내역을 제외하고 다시 가져와 주세요.",409);
        for(const key of aliases)store.run("INSERT INTO erp_sales_links(sourceKey,importId) VALUES(?,?)",key,batch.id);
      }
      for (const row of rows) insertShipment(row, batch.serviceDate, batch.id);
      store.run(
        "UPDATE imports SET status=?,count=?,drafts=? WHERE id=?",
        "committed",
        rows.length,
        JSON.stringify(rows),
        batch.id,
      );
      committed = true;
    });
    if (committed) {
      notify("changed");
      scheduleAddressLookup(batch.serviceDate);
    }
    res.status(201).json({ count });
  });
  app.delete("/api/admin/records/:kind/:id", admin, async (req, res) => {
    assert(ADMIN_DELETE_KINDS.includes(String(req.params.kind) as AdminDeleteKind), "삭제 항목을 확인해 주세요.", 404);
    assert(!routingBusy, "배차 작업이 끝난 뒤 삭제해 주세요.", 409);
    assert(req.body?.deleteLinked === undefined || typeof req.body.deleteLinked === "boolean", "삭제 범위를 확인해 주세요.",400);
    routingBusy = true;
    try {
      const result = await deleteAdminRecord(store, dataDir, req.params.kind as AdminDeleteKind, String(req.params.id), req.body?.deleteLinked === true);
      notify("changed"); res.json(result);
    } finally { routingBusy = false; }
  });
  app.delete("/api/imports/:id", admin, (req, res) => {
    const deleted = store.transaction(() => {
      const batch = store.one(
        "SELECT * FROM imports WHERE id=?",
        req.params.id,
      );
      assert(batch, "업로드를 찾을 수 없습니다.", 404);
      assert(
        !routingBusy,
        "배차를 계산 중입니다. 잠시 후 다시 삭제해 주세요.",
        409,
      );
      assert(
        ["review", "committed", "sales-list"].includes(batch.status) &&
          !store.one(
            "SELECT id FROM shipments WHERE importId=? AND (status<>'pending' OR routeId IS NOT NULL) LIMIT 1",
            batch.id,
          ),
        "이미 배차했거나 운행·배송 처리한 전표는 삭제할 수 없습니다. 미배차 전표만 삭제해 주세요.",
        409,
      );
      const deletedShipments = Number(
        store.run("DELETE FROM shipments WHERE importId=?", batch.id).changes,
      );
      store.run("DELETE FROM imports WHERE id=?", batch.id);
      for (const setting of store.all(
        "SELECT key,value FROM settings WHERE key GLOB 'device-receipt:*'",
      )) {
        let mapping;
        try { mapping = JSON.parse(setting.value); } catch { continue; }
        if (mapping?.importId === batch.id)
          store.run("DELETE FROM settings WHERE key=?", setting.key);
      }
      return { storedName: batch.storedName, deletedShipments };
    });
    // Commit the logical deletion first: a missing or inaccessible original must
    // not leave a deleted receipt visible or make a retry delete another record.
    try {
      unlinkSync(join(dataDir, "uploads", basename(deleted.storedName)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.error("전표 원본 파일을 삭제하지 못했습니다.");
    }
    notify("changed");
    res.json({ ok: true, deletedShipments: deleted.deletedShipments });
  });
  app.get("/api/imports/:id/original", admin, (request, res) => {
    const req = request as AuthRequest,
      batch = store.one("SELECT * FROM imports WHERE id=?", req.params.id);
    assert(batch, "원본을 찾을 수 없습니다.", 404);
    const expires = Date.now() + 60000,
      signature = createHmac("sha256", store.pepper)
        .update(`${batch.id}:${expires}`)
        .digest("hex");
    res.json({
      path: `/api/files/${batch.id}?expires=${expires}&signature=${signature}`,
    });
  });
  app.get("/api/files/:id", (req, res) => {
    const expires = Number(req.query.expires),
      signature = String(req.query.signature ?? "");
    assert(
      Number.isFinite(expires) &&
        expires > Date.now() &&
        expires < Date.now() + 65000,
      "다운로드 링크가 만료되었습니다.",
      403,
    );
    const expected = createHmac("sha256", store.pepper)
      .update(`${req.params.id}:${expires}`)
      .digest("hex");
    assert(
      signature.length === expected.length &&
        timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
      "다운로드 링크를 확인해 주세요.",
      403,
    );
    const batch = store.one("SELECT * FROM imports WHERE id=?", req.params.id);
    assert(batch, "원본을 찾을 수 없습니다.", 404);
    res.download(
      join(dataDir, "uploads", basename(batch.storedName)),
      batch.fileName,
    );
  });
  app.get("/api/template", admin, async (_req, res) => {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("배송지");
    sheet.columns = [
      ["수령인", 20],
      ["배송주소", 48],
      ["전화번호", 18],
      ["품목", 24],
      ["수량", 10],
      ["비고", 30],
    ].map(([header, width]) => ({
      header: String(header),
      width: Number(width),
    }));
    sheet.addRow([
      "대전 예시 거래처",
      "대전광역시 동구 중앙로 215",
      "",
      "생수",
      2,
      "예시 행을 지우고 실제 배송지를 입력하세요.",
    ]);
    sheet.getRow(1).font = { bold: true };
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=delivery-template.xlsx",
    );
    await book.xlsx.write(res);
    res.end();
  });
  app.get("/api/shipments", admin, (req, res) =>
    res.json(store.shipments(dateValue(req.query.date))),
  );
  app.post("/api/shipments", admin, (req, res) => {
    const rows = validateShipments(req.body.rows);
    assert(
      rows.every((row) => !row.erpSourceKey),
      "판매조회 가져오기에서 등록해 주세요.",
    );
    const date = dateValue(req.body.serviceDate);
    store.transaction(() => {
      for (const row of rows) insertShipment(row, date);
    });
    notify("changed");
    scheduleAddressLookup(date);
    res.status(201).json({ count: rows.length });
  });
  app.post("/api/shipments/geocode", admin, async (req, res) => {
    assert(!routingBusy, "배차 작업이 끝난 뒤 주소를 다시 확인해 주세요.", 409);
    const date = dateValue(req.body.serviceDate);
    const ids = req.body.shipmentIds;
    assert(
      ids === undefined ||
        (Array.isArray(ids) &&
          ids.length > 0 &&
          ids.length <= 2000 &&
          ids.every((v: unknown) => typeof v === "string" && v.length <= 128)),
      "확인할 배송지를 선택해 주세요.",
    );
    res.json(await locateSavedAddresses(date, ids));
  });
  app.post("/api/shipments/:id/assign", admin, async (req, res) => {
    assert(
      !routingBusy,
      "다른 배차 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.",
      409,
    );
    assert(
      typeof req.body.driverId === "string" && req.body.driverId.trim(),
      "배정할 기사를 선택해 주세요.",
    );
    routingBusy = true;
    try {
      // A successful assignment response may be lost on a mobile connection.
      // Repeating the same choice returns the existing manual course.
      const assigned = store.one(
        "SELECT * FROM shipments WHERE id=?",
        req.params.id,
      );
      if (assigned?.status === "assigned" && assigned.routeId) {
        const existing = store.one(
          "SELECT * FROM routes WHERE id=? AND driverId=? AND status='planned'",
          assigned.routeId,
          req.body.driverId,
        );
        if (
          existing &&
          store.one(
            "SELECT key FROM settings WHERE key=?",
            "manual-route:" + existing.id,
          )
        )
          return res.json(store.route(existing));
      }
      const route = await assignPendingShipment(
        store,
        { shipmentId: String(req.params.id), driverId: req.body.driverId },
        { roadRouting: options.roadRouting },
      );
      notify("changed", {}, route.driverId);
      res.json(route);
    } finally { routingBusy = false; }
  });
  app.patch("/api/shipments/:id", admin, (req, res) => {
    assert(!routingBusy, "배차 작업이 끝난 뒤 배송주소를 수정해 주세요.", 409);
    const old = store.one("SELECT * FROM shipments WHERE id=?", req.params.id);
    assert(old, "배송지를 찾을 수 없습니다.", 404);
    assert(
      old.status === "pending",
      "이미 배차된 배송지는 새 배차를 만들기 전에 변경해 주세요.",
      409,
    );
    const values = { ...store.shipment(old), ...req.body };
    if (values.address !== old.address && !isPoint(req.body)) { values.lat = null; values.lng = null; }
    const row = validateShipments([values])[0];
    store.run(
      "UPDATE shipments SET recipient=?,address=?,phone=?,items=?,notes=?,lat=?,lng=?,amount=?,customerCode=?,salesReference=? WHERE id=?",
      row.recipient,
      row.address,
      row.phone ?? "",
      JSON.stringify(row.items),
      row.notes ?? "",
      row.lat ?? null,
      row.lng ?? null,
      row.amount ?? null,
      row.customerCode ?? null,
      old.erpSourceKey ? old.salesReference : row.salesReference ?? null,
      old.id,
    );
    notify("changed");
    scheduleAddressLookup(old.serviceDate);
    res.json({ ok: true });
  });
  app.delete("/api/shipments/:id", admin, async (req, res) => {
    assert(
      !routingBusy,
      "배차를 계산 중입니다. 잠시 후 다시 삭제해 주세요.",
      409,
    );
    routingBusy = true;
    try {
      const removed = await removePlannedShipment(
        store,
        { shipmentId: String(req.params.id) },
        { roadRouting: options.roadRouting },
      );
      notify("changed", {}, removed.driverId ?? undefined);
      res.json({ ok: true });
    } finally {
      routingBusy = false;
    }
  });
  app.post("/api/dispatch/drop", admin, async (req, res) => {
    assert(
      !routingBusy,
      "다른 배차 작업이 진행 중입니다. 잠시 후 다시 옮겨 주세요.",
      409,
    );
    const date = dateValue(req.body.serviceDate);
    routingBusy = true;
    try {
      const result = await dropShipment(
        store,
        { ...req.body, serviceDate: date },
        { roadRouting: options.roadRouting },
      );
      for (const driverId of result.driverIds) notify("changed", {}, driverId);
      if (!result.driverIds.length) notify("changed");
      res.json({ ok: true, revision: result.revision });
    } finally {
      routingBusy = false;
    }
  });
  app.get("/api/dashboard", admin, (req, res) => {
    const date = dateValue(req.query.date),
      shipments = store.shipments(date),
      routes = store.routes(date),
      drivers = store.drivers().map((d) => ({
        ...d,
        position:
          store.one("SELECT * FROM positions WHERE driverId=?", d.id) ?? null,
      }));
    res.json({
      date,
      dispatchRevision: dispatchRevision(store, date),
      company: store.company(),
      mapSettings: store.mapSettings(),
      receiptCapabilities: { deviceText: true, maxTextLength: 50_000 },
      demo:
        store.one("SELECT value FROM settings WHERE key=?", "demo")?.value ===
        "true",
      shipments,
      routes,
      drivers,
      stats: {
        total: shipments.length,
        delivered: shipments.filter((s) => s.status === "delivered").length,
        failed: shipments.filter((s) => s.status === "failed").length,
        pending: shipments.filter((s) => s.status === "pending").length,
        active: routes.filter((r) => ["active", "returning"].includes(r.status))
          .length,
      },
    });
  });
  app.get("/api/routes", admin, (req, res) =>
    res.json(store.routes(dateValue(req.query.date))),
  );
  app.get("/api/routing-status", admin, (_req, res) =>
    res.json(trafficRoutingStatus()),
  );
  app.post("/api/routes/optimize", admin, async (req, res) => {
    assert(
      !routingBusy,
      "배차를 계산 중입니다. 잠시 후 다시 시도해 주세요.",
      409,
    );
    routingBusy = true;
    try {
      const date = dateValue(req.body.serviceDate);
      assert(
        !store.one(
          "SELECT id FROM routes WHERE serviceDate=? AND status IN ('active','returning')",
          date,
        ),
        "운행 중인 코스가 있어 재배차할 수 없습니다.",
        409,
      );
      const manualRoutes = store.routes(date).filter((route) => route.status === "planned" && route.manualAssigned);
      const manualRouteIds = new Set(manualRoutes.map((route) => route.id));
      const manualDriverIds = new Set(
        manualRoutes.map((route) => route.driverId),
      );
      const automaticRoutes = store
        .routes(date)
        .filter(
          (route) =>
            route.status === "planned" && !manualRouteIds.has(route.id),
        );
      let shipments = store
        .shipments(date)
        .filter(
          (s) =>
            ["pending", "assigned"].includes(s.status) &&
            !manualRouteIds.has(s.routeId ?? ""),
        );
      if (!shipments.length && manualRoutes.length)
        return res.json(store.routes(date));
      assert(shipments.length, "배차할 배송지가 없습니다.");
      if (shipments.some((row) => !hasLocation(row))) {
        const checked = await locateSavedAddresses(
          date,
          shipments.map((row) => row.id),
          true,
          200,
        );
        shipments = store
          .shipments(date)
          .filter(
            (row) =>
              ["pending", "assigned"].includes(row.status) &&
              !manualRouteIds.has(row.routeId ?? ""),
          );
        const missing = shipments.filter((row) => !hasLocation(row));
        assert(
          !missing.length,
          `${missing.length}곳의 배송주소를 확인하지 못했습니다. ${checked.unresolved[0]?.message ?? "주소 자동 확인을 다시 실행해 주세요."}`,
          422,
        );
      }
      const company = store.company();
      let drivers = store
        .drivers()
        .filter(
          (d) =>
            d.active && !manualDriverIds.has(d.id) &&
            !store.one(
              "SELECT id FROM routes WHERE driverId=? AND status IN ('active','returning')",
              d.id,
            ),
        );
      if (Array.isArray(req.body.driverIds))
        drivers = drivers.filter((d) => req.body.driverIds.includes(d.id));
      assert(
        drivers.length,
        "개별 배차 코스를 유지하고 있습니다. 다른 기사를 선택하거나 미배차 배송지를 기사에게 직접 배정해 주세요.",
        422,
      );
      const snapshot = () =>
        JSON.stringify({
          shipments: store.shipments(date),
          routes: store.routes(date),
          drivers: store.drivers(),
          company: store.company(),
        });
      const original = snapshot();
      assert(req.body.groupByRegion===undefined||typeof req.body.groupByRegion==="boolean","지역별 배차 설정을 확인해 주세요.");
      const estimated = await planDispatch(company, shipments, drivers, {
        groupByRegion: req.body.groupByRegion!==false,
        roadRouting: options.roadRouting !== false,
        trafficRequired: typeof req.body.trafficRequired === "boolean" ? req.body.trafficRequired : undefined,
        departureAt: req.body.departureAt,
        serviceDate: date,
      });
      store.transaction(() => {
        assert(
          snapshot() === original,
          "배송지나 기사 정보가 변경되어 배차를 중단했습니다. 다시 실행해 주세요.",
          409,
        );
        assert(
          !store.one(
            "SELECT id FROM routes WHERE serviceDate=? AND status IN ('active','returning')",
            date,
          ),
          "운행이 시작되어 배차를 중단했습니다.",
          409,
        );
        for (const old of automaticRoutes) {
          store.run(
            "UPDATE shipments SET routeId=NULL,sequence=NULL,status='pending' WHERE routeId=? AND status='assigned'",
            old.id,
          );
          store.run(
            "DELETE FROM routes WHERE id=? AND status='planned'",
            old.id,
          );
        }
        for (const { driver, stops, estimate, planning } of estimated) {
          const routeId = id();
          store.run(
            "INSERT INTO routes(id,driverId,serviceDate,distanceKm,durationMinutes,estimateSource,geometry,company,planning) VALUES(?,?,?,?,?,?,?,?,?)",
            routeId,
            driver.id,
            date,
            estimate.distanceKm,
            estimate.durationMinutes,
            estimate.estimateSource,
            JSON.stringify(estimate.geometry),
            JSON.stringify(company),
            JSON.stringify(planning),
          );
          stops.forEach((s, i) =>
            store.run(
              "UPDATE shipments SET routeId=?,sequence=?,status='assigned' WHERE id=?",
              routeId,
              i + 1,
              s.id,
            ),
          );
        }
      });
      notify("changed");
      res.json(store.routes(date));
    } finally {
      routingBusy = false;
    }
  });
  app.post("/api/routes/:id/reorder", admin, async (req, res) => {
    assert(!routingBusy, "다른 배차 작업이 진행 중입니다.", 409);
    const row = store.one("SELECT * FROM routes WHERE id=?", req.params.id);
    assert(row, "코스를 찾을 수 없습니다.", 404);
    assert(row.status === "planned", "출발 전 코스만 변경할 수 있습니다.", 409);
    const route = store.route(row),
      ids = req.body.stopIds;
    assert(
      Array.isArray(ids) &&
        ids.length === route.stops.length &&
        new Set(ids).size === ids.length &&
        ids.every((v) => route.stops.some((s) => s.id === v)),
      "배송지 목록을 확인해 주세요.",
    );
    routingBusy = true;
    try {
      const stops = ids.map((v) => route.stops.find((s) => s.id === v)!);
      const estimate = await estimateRoute(
        route.company,
        stops as any,
        options.roadRouting !== false,
        {
          trafficRequired:
            typeof req.body.trafficRequired === "boolean"
              ? req.body.trafficRequired
              : route.estimateSource === "naver-traffic"
                ? true
                : undefined,
        },
      );
      const planning = routePlanning(
        route.company,
        stops as (Shipment & { lat: number; lng: number })[],
        estimate,
        resolveDeparture({
          departureAt: req.body.departureAt ?? route.planning?.departureAt,
          serviceDate: route.serviceDate,
        }),
      );
      store.transaction(() => {
        assert(
          store.one("SELECT status FROM routes WHERE id=?", row.id)?.status ===
            "planned",
          "운행이 시작되어 순서를 변경할 수 없습니다.",
          409,
        );
        ids.forEach((v, i) =>
          store.run("UPDATE shipments SET sequence=? WHERE id=?", i + 1, v),
        );
        store.run(
          "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=?,planning=? WHERE id=?",
          estimate.distanceKm,
          estimate.durationMinutes,
          estimate.estimateSource,
          JSON.stringify(estimate.geometry),
          JSON.stringify(planning),
          row.id,
        );
        store.run(
          "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          "manual-route:" + row.id,
          "true",
        );
      });
      notify("changed", {}, row.driverId);
      res.json({ ok: true });
    } finally {
      routingBusy = false;
    }
  });
  app.post("/api/routes/move-stop", admin, async (req, res) => {
    assert(!routingBusy, "다른 배차 작업이 진행 중입니다.", 409);
    const shipment = store.one(
        "SELECT * FROM shipments WHERE id=?",
        req.body.shipmentId,
      ),
      target = store.one(
        "SELECT * FROM routes WHERE id=?",
        req.body.targetRouteId,
      );
    assert(shipment && target, "배송지와 이동할 코스를 확인해 주세요.", 404);
    const source = store.one(
      "SELECT * FROM routes WHERE id=?",
      shipment.routeId,
    );
    assert(
      source &&
        source.id !== target.id &&
        source.status === "planned" &&
        target.status === "planned" &&
        source.serviceDate === target.serviceDate,
      "같은 날짜의 출발 전 코스끼리 이동할 수 있습니다.",
      409,
    );
    const driverRow = store.one(
      "SELECT capacity FROM users WHERE id=?",
      target.driverId,
    );
    assert(
      store.one(
        "SELECT COUNT(*) AS n FROM shipments WHERE routeId=?",
        target.id,
      )!.n < driverRow!.capacity,
      "이 기사의 최대 배송지 수를 초과합니다.",
    );
    routingBusy = true;
    try {
      const routes = [store.route(source), store.route(target)];
      routes[0].stops = routes[0].stops.filter((s) => s.id !== shipment.id);
      routes[1].stops.push(store.shipment(shipment));
      const updated = await Promise.all(
        routes.map(async (r) => {
          const stops = orderStops(
            r.company,
            r.stops as (Shipment & { lat: number; lng: number })[],
          );
          return {
            ...r,
            stops,
            estimate: await estimateRoute(
              r.company,
              stops,
              options.roadRouting !== false,
              {
                trafficRequired:
                  typeof req.body.trafficRequired === "boolean"
                    ? req.body.trafficRequired
                    : r.estimateSource === "naver-traffic"
                      ? true
                      : undefined,
              },
            ),
          };
        }),
      );
      store.transaction(() => {
        for (const r of updated) {
          assert(
            store.one("SELECT status FROM routes WHERE id=?", r.id)?.status ===
              "planned",
            "운행이 시작되어 이동할 수 없습니다.",
            409,
          );
          r.stops.forEach((s, i) =>
            store.run(
              "UPDATE shipments SET routeId=?,sequence=? WHERE id=?",
              r.id,
              i + 1,
              s.id,
            ),
          );
          const planning = routePlanning(
            r.company,
            r.stops as (Shipment & { lat: number; lng: number })[],
            r.estimate,
            resolveDeparture({
              departureAt: req.body.departureAt ?? r.planning?.departureAt,
              serviceDate: r.serviceDate,
            }),
          );
          store.run(
            "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=?,planning=? WHERE id=?",
            r.estimate.distanceKm,
            r.estimate.durationMinutes,
            r.estimate.estimateSource,
            JSON.stringify(r.estimate.geometry),
            JSON.stringify(planning),
            r.id,
          );
          if (!r.stops.length) {
            store.run("DELETE FROM routes WHERE id=?", r.id);
            store.run(
              "DELETE FROM settings WHERE key=?",
              "manual-route:" + r.id,
            );
          } else {
            store.run(
              "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              "manual-route:" + r.id,
              "true",
            );
          }
        }
      });
      notify("changed", {}, source.driverId);
      notify("changed", {}, target.driverId);
      res.json({ ok: true });
    } finally {
      routingBusy = false;
    }
  });
  function ownRoute(req: AuthRequest): any {
    const row = store.one(
      "SELECT * FROM routes WHERE id=? AND driverId=?",
      req.params.id,
      req.user.userId,
    );
    assert(row, "배정된 코스를 찾을 수 없습니다.", 404);
    return row;
  }
  app.post("/api/driver/routes/:id/start", driver, (request, res) => {
    const req = request as AuthRequest,
      row = ownRoute(req);
    assert(!routingBusy, "배차를 편집 중입니다. 잠시 후 출발해 주세요.", 409);
    assert(row.status === "planned", "이미 출발한 코스입니다.", 409);
    assert(
      !store.one(
        "SELECT id FROM routes WHERE driverId=? AND status IN ('active','returning')",
        req.user.userId,
      ),
      "진행 중인 코스를 먼저 복귀 완료해 주세요.",
      409,
    );
    assert(
      store.one("SELECT id FROM shipments WHERE routeId=?", row.id),
      "배송지가 없는 코스입니다.",
    );
    store.run(
      "UPDATE routes SET status='active',startedAt=? WHERE id=?",
      new Date().toISOString(),
      row.id,
    );
    notify("changed", {}, req.user.userId);
    res.json(
      driverRoute(
        store.route(store.one("SELECT * FROM routes WHERE id=?", row.id)),
      ),
    );
  });
  app.post("/api/driver/stops/:id/complete", driver, (request, res) => {
    const req = request as AuthRequest,
      shipment = store.one("SELECT * FROM shipments WHERE id=?", req.params.id);
    assert(shipment, "배송지를 찾을 수 없습니다.", 404);
    const route = store.one(
      "SELECT * FROM routes WHERE id=? AND driverId=?",
      shipment.routeId,
      req.user.userId,
    );
    assert(route, "배정된 배송지만 처리할 수 있습니다.", 403);
    assert(req.body.expectedRouteId===undefined||req.body.expectedRouteId===route.id,"배정 코스가 변경되었습니다. 새로고침 후 확인해 주세요.",409);
    assert(
      route.status === "active" && shipment.status === "assigned",
      "진행 중인 미완료 배송지만 처리할 수 있습니다.",
      409,
    );
    const status = req.body.status ?? "delivered";
    assert(
      ["delivered", "failed"].includes(status),
      "처리 상태를 확인해 주세요.",
    );
    if (status === "failed")
      assert(
        typeof req.body.reason === "string" && req.body.reason.trim(),
        "미배송 사유를 입력해 주세요.",
      );
    store.transaction(() => {
      store.run(
        "UPDATE shipments SET status=?,deliveredAt=?,failureReason=? WHERE id=?",
        status,
        new Date().toISOString(),
        status === "failed" ? req.body.reason.slice(0, 500) : null,
        shipment.id,
      );
      if (
        !store.one(
          "SELECT id FROM shipments WHERE routeId=? AND status='assigned'",
          route.id,
        )
      )
        store.run("UPDATE routes SET status='returning' WHERE id=?", route.id);
    });
    notify("changed", {}, req.user.userId);
    res.json(
      driverRoute(
        store.route(store.one("SELECT * FROM routes WHERE id=?", route.id)),
      ),
    );
  });
  app.post("/api/driver/routes/:id/return", driver, (request, res) => {
    const req = request as AuthRequest,
      row = ownRoute(req);
    assert(
      row.status === "returning",
      "배송 처리를 마친 뒤 회사 복귀를 완료해 주세요.",
      409,
    );
    store.run(
      "UPDATE routes SET status='completed',completedAt=? WHERE id=?",
      new Date().toISOString(),
      row.id,
    );
    notify("changed", {}, req.user.userId);
    res.json({ ok: true });
  });
  app.post("/api/driver/location", driver, (request, res) => {
    const req = request as AuthRequest,
      p = req.body;
    assert(isPoint(p), "위치 정보를 확인해 주세요.");
    const location = p as {
      lat: number;
      lng: number;
      recordedAt: string;
      accuracy?: number;
      speed?: number;
    };
    const route = store.one(
      "SELECT * FROM routes WHERE driverId=? AND status IN ('active','returning') LIMIT 1",
      req.user.userId,
    );
    assert(route, "운행 중에만 위치를 공유할 수 있습니다.", 409);
    const timestamp = Date.parse(location.recordedAt);
    assert(
      Number.isFinite(timestamp) && Math.abs(Date.now() - timestamp) < 120000,
      "위치 정보가 오래되어 다시 수신해야 합니다.",
    );
    const previous = store.one(
      "SELECT recordedAt FROM positions WHERE driverId=?",
      req.user.userId,
    );
    if (previous && Date.parse(previous.recordedAt) > timestamp)
      return res.json({ ok: true, ignored: true });
    const accuracy = Number.isFinite(location.accuracy)
        ? Math.max(0, location.accuracy!)
        : null,
      speed = Number.isFinite(location.speed) ? location.speed : null;
    store.transaction(() => {
      store.run(
        "INSERT OR REPLACE INTO positions(driverId,routeId,lat,lng,accuracy,speed,recordedAt) VALUES(?,?,?,?,?,?,?)",
        req.user.userId,
        route.id,
        p.lat,
        p.lng,
        accuracy,
        speed,
        location.recordedAt,
      );
      store.run(
        "INSERT INTO position_history(driverId,routeId,lat,lng,recordedAt) VALUES(?,?,?,?,?)",
        req.user.userId,
        route.id,
        p.lat,
        p.lng,
        location.recordedAt,
      );
      store.run(
        "DELETE FROM position_history WHERE recordedAt<?",
        new Date(Date.now() - 30 * 86400000).toISOString(),
      );
    });
    notify(
      "position",
      {
        driverId: req.user.userId,
        position: {
          driverId: req.user.userId,
          routeId: route.id,
          lat: p.lat,
          lng: p.lng,
          accuracy,
          speed,
          recordedAt: location.recordedAt,
        },
      },
      req.user.userId,
    );
    res.json({ ok: true });
  });
  app.get("/api/routes/:id/trail", admin, (req, res) =>
    res.json(
      store.all(
        "SELECT lat,lng,recordedAt FROM position_history WHERE routeId=? ORDER BY recordedAt LIMIT 10000",
        req.params.id,
      ),
    ),
  );
  app.use(
    "/leaflet",
    express.static(resolve("node_modules/leaflet/dist"), { maxAge: "1d" }),
  );
  app.get("/map", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.query.provider === "naver") {
      const key =
        typeof req.query.keyId === "string"
          ? req.query.keyId
          : store.mapSettings().naverKeyId;
      return res
        .type("html")
        .send(createMapDocument("", { provider: "naver", naverKeyId: key }));
    }
    return res.type("html").send(createMapDocument());
  });
  if (existsSync(resolve("dist/index.html"))) {
    app.use(express.static(resolve("dist")));
    app.get("/{*path}", (_req, res) =>
      res.sendFile(resolve("dist/index.html")),
    );
  }
  app.use(
    (
      error: Error & { status?: number; code?: string },
      _req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      if (error instanceof CompanyErpError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      if (error instanceof multer.MulterError)
        return res
          .status(400)
          .json({ error: "파일은 15MB 이하로 한 개씩 업로드해 주세요." });
      if (error.code?.includes("SQLITE_CONSTRAINT"))
        return res.status(409).json({
          error:
            "이미 사용 중인 값이거나 다른 배차 작업과 충돌했습니다. 새로고침 후 확인해 주세요.",
        });
      if (error instanceof GeocodingError || error instanceof PlannedShipmentMutationError)
        return res.status(error.status).json({ error: error.message });
      const status = error.status ?? 400;
      res.status(status).json({
        error:
          status >= 500
            ? "요청을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요."
            : error.message,
      });
    },
  );
  return {
    app,
    server,
    store,
    close: async () => {
      closing = true;
      await companySales.close();
      await companyErp.close();
      clearInterval(liveTimer);
      await Promise.allSettled(addressJobs);
      await shutdownReceiptOcrPool();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      if (server.listening)
        await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
