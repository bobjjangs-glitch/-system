import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  randomBytes,
  createHmac,
  scryptSync,
  timingSafeEqual,
  randomUUID,
  createHash,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from "node:crypto";
import type { Company, Driver, Route, Session, Shipment } from "./types.ts";

export const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(
    new Date(),
  );
export const id = () => randomUUID();
export const defaultCompany: Company = {
  name: "우리 회사",
  address: "대전광역시 중구 중앙로 101",
  lat: 36.3277,
  lng: 127.4204,
  serviceMinutes: 5,
  navigation: "kakao",
};
export class Store {
  db: DatabaseSync;
  pepper: Buffer;
  private driverPinKey: Buffer;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const keyPath = join(dataDir, "session.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.pepper = readFileSync(keyPath);
    this.driverPinKey = Buffer.from(
      hkdfSync(
        "sha256",
        this.pepper,
        Buffer.alloc(0),
        "bareun-dispatch/driver-pin/v1",
        32,
      ),
    );
    this.db = new DatabaseSync(join(dataDir, "dispatch.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', pinIndex TEXT UNIQUE NOT NULL, pinHash TEXT NOT NULL, salt TEXT NOT NULL, capacity INTEGER NOT NULL DEFAULT 10, active INTEGER NOT NULL DEFAULT 1, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY, userId TEXT REFERENCES users(id), expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, fileName TEXT NOT NULL, storedName TEXT NOT NULL, mime TEXT NOT NULL, rawText TEXT NOT NULL DEFAULT '', drafts TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'review', serviceDate TEXT NOT NULL, createdAt TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS routes(id TEXT PRIMARY KEY,driverId TEXT REFERENCES users(id),serviceDate TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'planned',distanceKm REAL NOT NULL,durationMinutes REAL NOT NULL,estimateSource TEXT NOT NULL,geometry TEXT NOT NULL,company TEXT NOT NULL,startedAt TEXT,completedAt TEXT);
      CREATE TABLE IF NOT EXISTS shipments(id TEXT PRIMARY KEY,importId TEXT REFERENCES imports(id),recipient TEXT NOT NULL,address TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',items TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',lat REAL,lng REAL,serviceDate TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',routeId TEXT REFERENCES routes(id),sequence INTEGER,deliveredAt TEXT,failureReason TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS positions(driverId TEXT PRIMARY KEY REFERENCES users(id),routeId TEXT NOT NULL REFERENCES routes(id),lat REAL NOT NULL,lng REAL NOT NULL,accuracy REAL,speed REAL,recordedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS position_history(id INTEGER PRIMARY KEY,driverId TEXT NOT NULL,routeId TEXT NOT NULL,lat REAL NOT NULL,lng REAL NOT NULL,recordedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS geocodes(address TEXT PRIMARY KEY,lat REAL NOT NULL,lng REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS shipments_date ON shipments(serviceDate);
      CREATE INDEX IF NOT EXISTS shipment_route ON shipments(routeId,sequence);
      CREATE INDEX IF NOT EXISTS routes_date ON routes(serviceDate);
      CREATE INDEX IF NOT EXISTS positions_history_route ON position_history(routeId,recordedAt);
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(users)")
        .all()
        .some((column) => column.name === "pinEncrypted")
    )
      this.db.exec("ALTER TABLE users ADD COLUMN pinEncrypted TEXT");
    this.db
      .prepare("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)")
      .run("company", JSON.stringify(defaultCompany));
  }
  one<T = any>(sql: string, ...args: any[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T = any>(sql: string, ...args: any[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  company(): Company {
    return JSON.parse(
      this.one("SELECT value FROM settings WHERE key=?", "company")!.value,
    );
  }
  pinIndex(pin: string): string {
    return createHmac("sha256", this.pepper).update(pin).digest("hex");
  }
  pinFields(pin: string) {
    const salt = randomBytes(16).toString("hex");
    return {
      salt,
      pinHash: scryptSync(pin, salt, 32).toString("hex"),
      pinIndex: this.pinIndex(pin),
    };
  }
  encryptDriverPin(userId: string, pin: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.driverPinKey, iv);
    cipher.setAAD(Buffer.from(userId));
    const encrypted = Buffer.concat([cipher.update(pin, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(".");
  }
  driverPin(userId: string): string | null {
    const user = this.one<{ pinEncrypted: string | null; pinIndex: string }>(
      "SELECT pinEncrypted,pinIndex FROM users WHERE id=? AND role=?",
      userId,
      "driver",
    );
    if (!user?.pinEncrypted) return null;
    try {
      const parts = user.pinEncrypted.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") throw new Error();
      const iv = Buffer.from(parts[1], "base64"),
        tag = Buffer.from(parts[2], "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.driverPinKey, iv);
      decipher.setAAD(Buffer.from(userId));
      decipher.setAuthTag(tag);
      const pin = Buffer.concat([
        decipher.update(Buffer.from(parts[3], "base64")),
        decipher.final(),
      ]).toString("utf8");
      if (!/^\d{6,12}$/.test(pin) || this.pinIndex(pin) !== user.pinIndex)
        throw new Error();
      return pin;
    } catch {
      throw new Error("PIN 정보를 읽을 수 없습니다. 새 PIN을 발급해 주세요.");
    }
  }
  createUser(
    role: "admin" | "driver",
    name: string,
    pin: string,
    phone = "",
    capacity = 10,
  ): Driver {
    const userId = id(),
      p = this.pinFields(pin);
    this.run(
      "INSERT INTO users(id,role,name,phone,pinIndex,pinHash,salt,capacity,createdAt,pinEncrypted) VALUES (?,?,?,?,?,?,?,?,?,?)",
      userId,
      role,
      name,
      phone,
      p.pinIndex,
      p.pinHash,
      p.salt,
      capacity,
      new Date().toISOString(),
      role === "driver" ? this.encryptDriverPin(userId, pin) : null,
    );
    return { id: userId, name, phone, capacity, active: true };
  }
  login(pin: string): { token: string; user: Session } | null {
    const user = this.one(
      "SELECT * FROM users WHERE pinIndex=? AND active=1",
      this.pinIndex(pin),
    );
    if (
      !user ||
      !timingSafeEqual(
        scryptSync(pin, user.salt, 32),
        Buffer.from(user.pinHash, "hex"),
      )
    )
      return null;
    if (user.role === "driver" && !user.pinEncrypted)
      this.run(
        "UPDATE users SET pinEncrypted=? WHERE id=? AND pinIndex=?",
        this.encryptDriverPin(user.id, pin),
        user.id,
        user.pinIndex,
      );
    const token = randomBytes(32).toString("hex");
    this.run("DELETE FROM sessions WHERE expiresAt < ?", Date.now());
    this.run(
      "INSERT INTO sessions(tokenHash,userId,expiresAt) VALUES(?,?,?)",
      this.hashToken(token),
      user.id,
      Date.now() + 7 * 86400000,
    );
    return {
      token,
      user: { userId: user.id, role: user.role, name: user.name },
    };
  }
  hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  session(token: string): Session | undefined {
    return this.one(
      "SELECT users.id as userId,users.role,users.name FROM sessions JOIN users ON users.id=sessions.userId WHERE tokenHash=? AND expiresAt>? AND users.active=1",
      this.hashToken(token),
      Date.now(),
    );
  }
  drivers(): Driver[] {
    return this.all(
      "SELECT id,name,phone,capacity,active FROM users WHERE role=? ORDER BY createdAt",
      "driver",
    ).map((d) => ({ ...d, active: !!d.active }));
  }
  shipment(row: any): Shipment {
    return { ...row, items: JSON.parse(row.items) };
  }
  shipments(date: string): Shipment[] {
    return this.all(
      "SELECT * FROM shipments WHERE serviceDate=? ORDER BY createdAt,recipient",
      date,
    ).map((row) => this.shipment(row));
  }
  route(row: any): Route {
    const driver = this.one("SELECT name FROM users WHERE id=?", row.driverId);
    return {
      ...row,
      driverName: driver?.name ?? "기사",
      company: JSON.parse(row.company),
      geometry: JSON.parse(row.geometry),
      stops: this.all(
        "SELECT * FROM shipments WHERE routeId=? ORDER BY sequence",
        row.id,
      ).map((s) => this.shipment(s)),
    };
  }
  routes(date: string): Route[] {
    return this.all(
      "SELECT * FROM routes WHERE serviceDate=? ORDER BY rowid",
      date,
    ).map((r) => this.route(r));
  }
  close() {
    this.db.close();
  }
}
