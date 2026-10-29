import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomInt, createHmac, timingSafeEqual } from "node:crypto";
import ExcelJS from "exceljs";
import { Store, id, today } from "./database.ts";
import type { Session, Shipment, Company, Route } from "./types.ts";
import { isPoint } from "./types.ts";
import { optimizeAssignments, estimateRoute, orderStops } from "./routing.ts";
import {
  parseReceipt,
  parseSpreadsheet,
  recognizeReceipt,
  validateShipments,
} from "./imports.ts";
import { geocode } from "./geocoding.ts";
import { seedDemo } from "./demo.ts";

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
const sourceDir = dirname(fileURLToPath(import.meta.url));

export function createDispatchApp(
  options: { dataDir?: string; roadRouting?: boolean; test?: boolean } = {},
) {
  const dataDir = resolve(
    options.dataDir ?? process.env.APP_DATA_DIR ?? ".local",
  );
  const store = new Store(dataDir);
  mkdirSync(join(dataDir, "uploads"), { recursive: true, mode: 0o700 });
  const app = express(),
    server = createServer(app),
    wss = new WebSocketServer({ server, path: "/live", maxPayload: 4096 });
  const connections = new Map<WebSocket, Session>();
  const socketTokens = new Map<WebSocket, string>();
  let routingBusy = false;
  const notify = (event: string, payload: any = {}, driverId?: string) => {
    for (const [ws, user] of connections)
      if (
        ws.readyState === WebSocket.OPEN &&
        (user.role === "admin" || user.userId === driverId)
      )
        ws.send(JSON.stringify({ event, ...payload }));
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
    res.json({ ok: true, service: "bareun-dispatch" }),
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
    res.json({ user: req.user, company: store.company(), route });
  });
  app.get("/api/company", (req, res) => res.json(store.company()));
  app.put("/api/company", admin, (req, res) => {
    assert(
      !store.one(
        "SELECT id FROM routes WHERE status IN ('active','returning') LIMIT 1",
      ),
      "운행 중에는 출발지를 변경할 수 없습니다. 회사 복귀 후 변경해 주세요.",
      409,
    );
    const c = req.body as Company;
    assert(
      typeof c.name === "string" &&
        c.name.trim() &&
        typeof c.address === "string" &&
        c.address.trim() &&
        isPoint(c),
      "회사명·주소·좌표를 확인해 주세요.",
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
    store.transaction(() => {
      store.run(
        "UPDATE settings SET value=? WHERE key=?",
        JSON.stringify({
          name: c.name.slice(0, 100),
          address: c.address.slice(0, 500),
          lat: c.lat,
          lng: c.lng,
          serviceMinutes: c.serviceMinutes,
          navigation: c.navigation,
        }),
        "company",
      );
      store.run(
        "UPDATE shipments SET routeId=NULL,sequence=NULL,status='pending' WHERE routeId IN (SELECT id FROM routes WHERE status='planned')",
      );
      store.run("DELETE FROM routes WHERE status='planned'");
    });
    notify("changed");
    res.json(store.company());
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
    res.set("Cache-Control", "no-store").status(201).json({ ...created, pin });
  });
  app.patch("/api/drivers/:id", admin, (req, res) => {
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
    res.set("Cache-Control", "no-store").status(201).json({ drivers, count: 25 });
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
      typeof req.body.address === "string" && req.body.address.trim(),
      "주소를 입력해 주세요.",
    );
    try {
      res.json(await geocode(store, req.body.address.trim()));
    } catch (error) {
      throw new AppError((error as Error).message, 503);
    }
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  });
  app.get("/api/imports", admin, (req, res) => {
    const date = req.query.date ? dateValue(req.query.date) : null;
    res.json(
      store.all(
        `SELECT id,fileName,mime,status,serviceDate,createdAt,count FROM imports ${date ? "WHERE serviceDate=?" : ""} ORDER BY createdAt DESC LIMIT 200`,
        ...(date ? [date] : []),
      ),
    );
  });
  app.get("/api/imports/:id", admin, (req, res) => {
    const row = store.one("SELECT * FROM imports WHERE id=?", req.params.id);
    assert(row, "업로드를 찾을 수 없습니다.", 404);
    res.json({ ...row, drafts: JSON.parse(row.drafts), storedName: undefined });
  });
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
    if ([".xlsx", ".csv"].includes(extension))
      drafts = await parseSpreadsheet(file.buffer, file.originalname);
    else {
      rawText = await recognizeReceipt(file.buffer);
      drafts = [parseReceipt(rawText)];
    }
    const importId = id(),
      storedName = importId + extension,
      fileName = Buffer.from(file.originalname, "latin1").toString("utf8");
    writeFileSync(join(dataDir, "uploads", storedName), file.buffer, {
      mode: 0o600,
      flag: "wx",
    });
    store.run(
      "INSERT INTO imports(id,fileName,storedName,mime,rawText,drafts,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?,?)",
      importId,
      fileName,
      storedName,
      file.mimetype,
      rawText,
      JSON.stringify(drafts),
      date,
      new Date().toISOString(),
    );
    notify("changed");
    res.status(201).json({
      id: importId,
      fileName,
      rawText,
      drafts,
      serviceDate: date,
      status: "review",
    });
  });
  const insertShipment = (
    s: any,
    date: string,
    importId: string | null = null,
  ) =>
    store.run(
      "INSERT INTO shipments(id,importId,recipient,address,phone,items,notes,lat,lng,serviceDate,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
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
    );
  app.post("/api/imports/:id/commit", admin, (req, res) => {
    const batch = store.one("SELECT * FROM imports WHERE id=?", req.params.id);
    assert(batch, "업로드를 찾을 수 없습니다.", 404);
    assert(batch.status === "review", "이미 등록한 전표입니다.", 409);
    const rows = validateShipments(req.body.rows);
    store.transaction(() => {
      for (const row of rows) insertShipment(row, batch.serviceDate, batch.id);
      store.run(
        "UPDATE imports SET status=?,count=?,drafts=? WHERE id=?",
        "committed",
        rows.length,
        JSON.stringify(rows),
        batch.id,
      );
    });
    notify("changed");
    res.status(201).json({ count: rows.length });
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
      ["위도", 18],
      ["경도", 18],
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
      36.3326,
      127.4347,
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
    const date = dateValue(req.body.serviceDate);
    store.transaction(() => {
      for (const row of rows) insertShipment(row, date);
    });
    notify("changed");
    res.status(201).json({ count: rows.length });
  });
  app.patch("/api/shipments/:id", admin, (req, res) => {
    const old = store.one("SELECT * FROM shipments WHERE id=?", req.params.id);
    assert(old, "배송지를 찾을 수 없습니다.", 404);
    assert(
      old.status === "pending",
      "이미 배차된 배송지는 새 배차를 만들기 전에 변경해 주세요.",
      409,
    );
    const row = validateShipments([{ ...store.shipment(old), ...req.body }])[0];
    store.run(
      "UPDATE shipments SET recipient=?,address=?,phone=?,items=?,notes=?,lat=?,lng=? WHERE id=?",
      row.recipient,
      row.address,
      row.phone ?? "",
      JSON.stringify(row.items),
      row.notes ?? "",
      row.lat ?? null,
      row.lng ?? null,
      old.id,
    );
    notify("changed");
    res.json({ ok: true });
  });
  app.delete("/api/shipments/:id", admin, (req, res) => {
    const row = store.one(
      "SELECT status FROM shipments WHERE id=?",
      req.params.id,
    );
    assert(row, "배송지를 찾을 수 없습니다.", 404);
    assert(
      row.status === "pending",
      "미배차 배송지만 삭제할 수 있습니다.",
      409,
    );
    store.run("DELETE FROM shipments WHERE id=?", req.params.id);
    notify("changed");
    res.json({ ok: true });
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
      company: store.company(),
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
      const shipments = store
        .shipments(date)
        .filter((s) => ["pending", "assigned"].includes(s.status));
      assert(shipments.length, "배차할 배송지가 없습니다.");
      const company = store.company();
      let drivers = store
        .drivers()
        .filter(
          (d) =>
            d.active &&
            !store.one(
              "SELECT id FROM routes WHERE driverId=? AND status IN ('active','returning')",
              d.id,
            ),
        );
      if (Array.isArray(req.body.driverIds))
        drivers = drivers.filter((d) => req.body.driverIds.includes(d.id));
      const groups = optimizeAssignments(company, shipments, drivers),
        estimated = await Promise.all(
          groups.map(async (group) => ({
            ...group,
            estimate: await estimateRoute(
              company,
              group.stops,
              options.roadRouting !== false,
            ),
          })),
        );
      store.transaction(() => {
        assert(
          !store.one(
            "SELECT id FROM routes WHERE serviceDate=? AND status IN ('active','returning')",
            date,
          ),
          "운행이 시작되어 배차를 중단했습니다.",
          409,
        );
        store.run(
          "UPDATE shipments SET routeId=NULL,sequence=NULL,status='pending' WHERE serviceDate=? AND status='assigned'",
          date,
        );
        store.run(
          "DELETE FROM routes WHERE serviceDate=? AND status='planned'",
          date,
        );
        for (const { driver, stops, estimate } of estimated) {
          const routeId = id();
          store.run(
            "INSERT INTO routes(id,driverId,serviceDate,distanceKm,durationMinutes,estimateSource,geometry,company) VALUES(?,?,?,?,?,?,?,?)",
            routeId,
            driver.id,
            date,
            estimate.distanceKm,
            estimate.durationMinutes,
            estimate.estimateSource,
            JSON.stringify(estimate.geometry),
            JSON.stringify(company),
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
          "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=? WHERE id=?",
          estimate.distanceKm,
          estimate.durationMinutes,
          estimate.estimateSource,
          JSON.stringify(estimate.geometry),
          row.id,
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
          store.run(
            "UPDATE routes SET distanceKm=?,durationMinutes=?,estimateSource=?,geometry=? WHERE id=?",
            r.estimate.distanceKm,
            r.estimate.durationMinutes,
            r.estimate.estimateSource,
            JSON.stringify(r.estimate.geometry),
            r.id,
          );
          if (!r.stops.length) store.run("DELETE FROM routes WHERE id=?", r.id);
        }
      });
      notify("changed");
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
    res.json(store.route(store.one("SELECT * FROM routes WHERE id=?", row.id)));
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
      store.route(store.one("SELECT * FROM routes WHERE id=?", route.id)),
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
  app.get("/map", (_req, res) => res.sendFile(join(sourceDir, "map.html")));
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
      if (error instanceof multer.MulterError)
        return res
          .status(400)
          .json({ error: "파일은 15MB 이하로 한 개씩 업로드해 주세요." });
      if (error.code?.includes("SQLITE_CONSTRAINT"))
        return res.status(409).json({
          error:
            "이미 사용 중인 값이거나 다른 배차 작업과 충돌했습니다. 새로고침 후 확인해 주세요.",
        });
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
      clearInterval(liveTimer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      if (server.listening)
        await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}
