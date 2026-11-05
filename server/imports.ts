import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ShipmentInput } from "./types.ts";

const aliases: Record<string, string[]> = {
  recipient: [
    "받는분",
    "수령인",
    "수취인",
    "거래처",
    "거래처명",
    "배송지명",
    "고객명",
    "상호",
    "recipient",
    "name",
  ],
  address: ["배송지", "배송주소", "주소", "도착지", "address"],
  phone: ["전화", "전화번호", "연락처", "휴대폰", "phone"],
  item: [
    "품목",
    "품목명",
    "상품",
    "상품명",
    "물품",
    "물품명",
    "제품",
    "제품명",
    "item",
  ],
  quantity: ["수량", "개수", "quantity", "qty"],
  notes: ["비고", "메모", "요청사항", "notes"],
  lat: ["위도", "lat", "latitude"],
  lng: ["경도", "lng", "longitude"],
};
const normal = (s: string) => s.replace(/[\s_()]/g, "").toLowerCase();
function text(value: any): string {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.result != null) return text(value.result);
    if (value.richText) return value.richText.map((v: any) => v.text).join("");
    return value.text ?? "";
  }
  return String(value).trim();
}
export async function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
): Promise<ShipmentInput[]> {
  const book = new ExcelJS.Workbook();
  if (fileName.toLowerCase().endsWith(".csv"))
    await book.csv.read(Readable.from(buffer));
  else await book.xlsx.load(buffer as any);
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error("엑셀에 워크시트가 없습니다.");
  if (sheet.rowCount > 2001)
    throw new Error("한 번에 최대 2,000행까지 업로드할 수 있습니다.");
  const header = sheet.getRow(1),
    columns: Record<string, number> = {};
  header.eachCell((cell, i) => {
    const value = normal(text(cell.value));
    for (const [key, names] of Object.entries(aliases))
      if (names.some((n) => normal(n) === value)) columns[key] = i;
  });
  if (!columns.address)
    throw new Error(
      "첫 행에 ‘주소’ 또는 ‘배송주소’ 열이 필요합니다. 샘플 엑셀 형식을 확인해 주세요.",
    );
  const grouped = new Map<string, ShipmentInput>();
  for (let i = 2; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i);
    const read = (key: string) =>
      columns[key] ? text(row.getCell(columns[key]).value) : "";
    const address = read("address");
    if (!address && !read("recipient") && !read("item")) continue;
    if (!address) throw new Error(`${i}행의 배송주소를 입력해 주세요.`);
    const recipient = read("recipient") || "수령인 확인 필요",
      phone = read("phone"),
      key = JSON.stringify([recipient, address, phone]);
    let target = grouped.get(key);
    if (!target) {
      const lat = read("lat"),
        lng = read("lng");
      target = {
        recipient,
        address,
        phone,
        notes: read("notes"),
        lat: lat ? Number(lat) : null,
        lng: lng ? Number(lng) : null,
        items: [],
      };
      grouped.set(key, target);
    }
    const quantity = read("quantity")
      ? Number(read("quantity").replaceAll(",", ""))
      : 1;
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new Error(`${i}행의 수량은 0보다 큰 숫자로 입력해 주세요.`);
    target.items.push({ name: read("item") || "물품 확인 필요", quantity });
  }
  if (!grouped.size) throw new Error("업로드할 배송 데이터가 없습니다.");
  return [...grouped.values()];
}
export { parseReceipt } from "../src/receiptText.ts";

export class ReceiptOcrError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "ReceiptOcrError";
    this.status = status;
  }
}
const unreadablePhoto = () =>
  new ReceiptOcrError(
    "전표 사진을 읽지 못했습니다. JPG·PNG·WEBP 사진으로 다시 촬영하거나 업로드해 주세요.",
  );
const recognitionTimeout = () =>
  new ReceiptOcrError(
    "전표 사진 인식 시간이 초과되었습니다. 사진 크기를 줄이거나 글자가 선명하게 나오도록 다시 촬영해 주세요.",
    408,
  );

// Compressed file size does not bound decoded image memory (a 50MP JPEG can be 1MB).
function receiptImageSize(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length >= 24 &&
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    buffer.toString("ascii", 12, 16) === "IHDR"
  )
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216) {
    let offset = 2;
    while (offset + 3 < buffer.length) {
      if (buffer[offset++] !== 255) break;
      while (buffer[offset] === 255) offset++;
      const marker = buffer[offset++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (
        marker >= 192 &&
        marker <= 207 &&
        ![196, 200, 204].includes(marker) &&
        length >= 7
      )
        return {
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3),
        };
      offset += length;
    }
  }
  if (
    buffer.length >= 20 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    for (let offset = 12; offset + 8 <= buffer.length; ) {
      const chunk = buffer.toString("ascii", offset, offset + 4);
      const length = buffer.readUInt32LE(offset + 4);
      const data = offset + 8;
      if (data + length > buffer.length) break;
      if (chunk === "VP8X" && length >= 10)
        return {
          width: 1 + buffer.readUIntLE(data + 4, 3),
          height: 1 + buffer.readUIntLE(data + 7, 3),
        };
      if (chunk === "VP8L" && length >= 5 && buffer[data] === 47) {
        const bits = buffer.readUInt32LE(data + 1);
        return {
          width: 1 + (bits & 16383),
          height: 1 + ((bits >>> 14) & 16383),
        };
      }
      if (
        chunk === "VP8 " &&
        length >= 10 &&
        buffer.readUIntBE(data + 3, 3) === 0x9d012a
      )
        return {
          width: buffer.readUInt16LE(data + 6) & 16383,
          height: buffer.readUInt16LE(data + 8) & 16383,
        };
      offset = data + length + (length % 2);
    }
  }
  throw unreadablePhoto();
}

type OcrOptions = {
  workerUrl?: URL;
  timeoutMs?: number;
  queueTimeoutMs?: number;
  signal?: AbortSignal;
};
type OcrJob = {
  id: number;
  buffer: Buffer;
  options: OcrOptions;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  queuedTimer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
  cancelActive?: () => void;
};
type WarmWorker = {
  child: ChildProcess;
  langDir: string;
  ready: Promise<void>;
  closed: Promise<void>;
  closing: boolean;
  uses: number;
  pending?: {
    id: number;
    resolve: (text: string) => void;
    reject: (error: Error) => void;
  };
};
const cancelledPhoto = () =>
  new ReceiptOcrError("전표 사진 읽기를 취소했습니다.", 499);
const queueExpired = () =>
  new ReceiptOcrError(
    "앞선 전표 처리가 지연되고 있습니다. 잠시 후 다시 촬영해 주세요.",
    408,
  );

class ReceiptOcrPool {
  private queue: OcrJob[] = [];
  private active?: OcrJob;
  private worker?: WarmWorker;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private nextId = 0;
  private stopping = false;

  private readonly workerUrl: URL;
  constructor(workerUrl = new URL("./receiptOcrWorker.ts", import.meta.url)) {
    this.workerUrl = workerUrl;
  }

  recognize(buffer: Buffer, options: OcrOptions): Promise<string> {
    if (options.signal?.aborted) return Promise.reject(cancelledPhoto());
    if (this.stopping) return Promise.reject(cancelledPhoto());
    // Keep at most one active and two waiting images in memory. Ordinary next
    // photos wait briefly instead of receiving the old global "busy" error.
    if (this.queue.length >= 2)
      return Promise.reject(
        new ReceiptOcrError(
          "대기 중인 전표가 많습니다. 앞선 전표 결과를 확인한 뒤 다시 촬영해 주세요.",
          429,
        ),
      );
    return new Promise((resolve, reject) => {
      const job: OcrJob = {
        id: ++this.nextId,
        buffer,
        options,
        resolve,
        reject,
      };
      const abort = () => {
        if (this.active === job) job.cancelActive?.();
        else {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.release(job);
          reject(cancelledPhoto());
        }
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      job.removeAbort = () =>
        options.signal?.removeEventListener("abort", abort);
      job.queuedTimer = setTimeout(() => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.release(job);
        reject(queueExpired());
      }, options.queueTimeoutMs ?? 12_000);
      job.queuedTimer.unref();
      this.queue.push(job);
      void this.pump();
    });
  }

  private release(job: OcrJob) {
    clearTimeout(job.queuedTimer);
    job.removeAbort?.();
  }

  private startWorker(): WarmWorker {
    const langDir = mkdtempSync(join(tmpdir(), "bareun-ocr-"));
    let child: ChildProcess;
    try {
      child = fork(this.workerUrl, [], {
        execArgv: ["--use-env-proxy", "--experimental-strip-types"],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      void rm(langDir, { recursive: true, force: true });
      throw error;
    }
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    let closeResolve!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A failed child can emit before pump attaches its await continuation.
    void ready.catch(() => {});
    const closed = new Promise<void>((resolve) => {
      closeResolve = resolve;
    });
    const state: WarmWorker = {
      child,
      langDir,
      ready,
      closed,
      closing: false,
      uses: 0,
    };
    this.worker = state;
    child.on("message", (message: unknown) => {
      const value = message as {
        type?: string;
        id?: number;
        text?: unknown;
      } | null;
      if (value?.type === "ready") readyResolve();
      else if (value?.type === "failed" && value.id === undefined)
        readyReject(unreadablePhoto());
      else if (value?.id === state.pending?.id) {
        if (value?.type === "result" && typeof value.text === "string")
          state.pending?.resolve(value.text);
        else if (value?.type === "failed")
          state.pending?.reject(unreadablePhoto());
      }
    });
    child.once("error", () => {
      readyReject(unreadablePhoto());
      state.pending?.reject(unreadablePhoto());
    });
    child.once("close", () => {
      readyReject(unreadablePhoto());
      state.pending?.reject(unreadablePhoto());
      if (this.worker === state) this.worker = undefined;
      void rm(langDir, { recursive: true, force: true })
        .catch(() => {})
        .finally(closeResolve);
    });
    child.send({ type: "initialize", langDir }, (error) => {
      if (error) {
        readyReject(unreadablePhoto());
        child.kill("SIGKILL");
      }
    });
    return state;
  }

  private async stopWorker() {
    clearTimeout(this.idleTimer);
    const state = this.worker;
    if (!state) return;
    if (!state.closing) {
      state.closing = true;
      // Retain the exit event until memory/temp files are released, including
      // shutdown called while the warm process/channel were idle and unref'ed.
      state.child.ref();
      state.child.channel?.ref();
      state.child.kill("SIGKILL");
    }
    await state.closed;
  }

  private async run(job: OcrJob): Promise<string> {
    clearTimeout(this.idleTimer);
    let fail!: (error: Error) => void;
    let stopping: Promise<void> | undefined;
    let interruptionError: Error | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const interrupt = (error: Error) => {
      if (stopping) return;
      interruptionError = error;
      stopping = this.stopWorker().then(() => {
        fail(error);
      });
    };
    job.cancelActive = () => interrupt(cancelledPhoto());
    const deadline = setTimeout(
      () => interrupt(recognitionTimeout()),
      job.options.timeoutMs ?? 25_000,
    );
    deadline.unref();
    try {
      if (job.options.signal?.aborted) throw cancelledPhoto();
      if (this.worker?.closing)
        await Promise.race([this.worker.closed, interrupted]);
      const state = this.worker ?? this.startWorker();
      state.child.ref();
      state.child.channel?.ref();
      await Promise.race([state.ready, interrupted]);
      const recognition = new Promise<string>((resolve, reject) => {
        state.pending = { id: job.id, resolve, reject };
        state.child.send(
          { type: "recognize", id: job.id, image: job.buffer },
          (error) => {
            if (error) reject(unreadablePhoto());
          },
        );
      });
      const text = await Promise.race([recognition, interrupted]);
      state.pending = undefined;
      state.uses++;
      if (state.uses >= 15) await this.stopWorker();
      return text;
    } catch (error) {
      await this.stopWorker();
      if (stopping) await stopping;
      throw (
        interruptionError ??
        (error instanceof ReceiptOcrError ? error : unreadablePhoto())
      );
    } finally {
      clearTimeout(deadline);
      job.cancelActive = undefined;
    }
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        clearTimeout(job.queuedTimer);
        this.active = job;
        try {
          job.resolve(await this.run(job));
        } catch (error) {
          job.reject(error as Error);
        } finally {
          this.release(job);
          this.active = undefined;
        }
      }
    } finally {
      this.pumping = false;
      const state = this.worker;
      if (state) {
        // Keep models ready without keeping a stopped API/test process alive.
        state.child.unref();
        state.child.channel?.unref();
        this.idleTimer = setTimeout(() => {
          void this.stopWorker();
        }, 90_000);
        this.idleTimer.unref();
      }
    }
  }

  async close() {
    this.stopping = true;
    for (const job of this.queue.splice(0)) {
      this.release(job);
      job.reject(cancelledPhoto());
    }
    this.active?.cancelActive?.();
    await this.stopWorker();
  }
}

let receiptPool: ReceiptOcrPool | undefined;
export async function shutdownReceiptOcrPool() {
  const pool = receiptPool;
  receiptPool = undefined;
  await pool?.close();
}

export function validateReceiptImage(buffer: Buffer): void {
  const { width, height } = receiptImageSize(buffer);
  if (width <= 0 || height <= 0) throw unreadablePhoto();
  if (width * height > 20_000_000)
    throw new ReceiptOcrError(
      "사진 해상도가 너무 큽니다. 일반 화질로 다시 촬영하거나 2,000만 화소 이하로 사진 크기를 줄여 주세요.",
      413,
    );
}

export async function recognizeReceipt(
  buffer: Buffer,
  options: OcrOptions = {},
): Promise<string> {
  validateReceiptImage(buffer);
  // Dedicated workers make deadline/crash injection tests independent of the
  // production warm pool; no request can select this option over HTTP.
  if (options.workerUrl) {
    const pool = new ReceiptOcrPool(options.workerUrl);
    try {
      return await pool.recognize(buffer, options);
    } finally {
      await pool.close();
    }
  }
  receiptPool ??= new ReceiptOcrPool();
  return receiptPool.recognize(buffer, options);
}
export function validateShipments(rows: unknown): ShipmentInput[] {
  if (!Array.isArray(rows) || !rows.length || rows.length > 2000)
    throw new Error("배송지는 1개 이상 2,000개 이하로 입력해 주세요.");
  return rows.map((row, i) => {
    if (
      typeof row.recipient !== "string" ||
      !row.recipient.trim() ||
      row.recipient.length > 200
    )
      throw new Error(`${i + 1}번 수령인을 확인해 주세요.`);
    if (
      typeof row.address !== "string" ||
      !row.address.trim() ||
      row.address.length > 500
    )
      throw new Error(`${i + 1}번 배송주소를 확인해 주세요.`);
    if (
      !Array.isArray(row.items) ||
      !row.items.length ||
      row.items.some(
        (v: any) =>
          typeof v.name !== "string" ||
          !v.name.trim() ||
          !Number.isFinite(Number(v.quantity)) ||
          Number(v.quantity) <= 0,
      )
    )
      throw new Error(`${i + 1}번 물품명과 수량을 확인해 주세요.`);
    let lat = row.lat == null || row.lat === "" ? null : Number(row.lat),
      lng = row.lng == null || row.lng === "" ? null : Number(row.lng);
    if (
      (lat == null) !== (lng == null) ||
      (lat != null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) ||
      (lng != null && (!Number.isFinite(lng) || Math.abs(lng) > 180)) ||
      (lat === 0 && lng === 0)
    ) {
      // Old drafts/files may contain a partial or invalid optional location.
      // Keep the address and let automatic lookup replace it internally.
      lat = null;
      lng = null;
    }
    return {
      recipient: row.recipient.trim(),
      address: row.address.trim(),
      phone: String(row.phone ?? "").slice(0, 40),
      notes: String(row.notes ?? "").slice(0, 2000),
      items: row.items.map((v: any) => ({
        name: v.name.trim().slice(0, 200),
        quantity: Number(v.quantity),
      })),
      lat,
      lng,
    };
  });
}
