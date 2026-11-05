import ExcelJS from "exceljs";
import { loadSpreadsheet, spreadsheetText } from "./spreadsheet.ts";
import { parseSalesReference } from "../src/salesReference.ts";
import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ShipmentInput } from "./types.ts";

const aliases: Record<string, string[]> = {
  recipient: [
    "배송지명",
    "받는분",
    "수령인",
    "수취인",
    "거래처명",
    "거래처",
    "고객명",
    "상호",
    "recipient",
    "name",
  ],
  address: [
    "배송지주소",
    "배송주소",
    "납품주소",
    "도로명주소",
    "배송지",
    "주소",
    "도착지",
    "address",
  ],
  phone: ["배송연락처", "휴대폰", "연락처", "전화번호", "전화", "phone"],
  item: [
    "품명및규격",
    "품목명",
    "품명",
    "물품명",
    "상품명",
    "제품명",
    "품목",
    "상품",
    "물품",
    "제품",
    "item",
  ],
  specification: ["규격", "품목규격", "spec"],
  code: ["품목코드", "상품코드", "prod_cd"],
  customerCode: ["거래처코드", "고객코드", "cust_cd"],
  quantity: ["수량", "판매수량", "출고수량", "개수", "quantity", "qty"],
  notes: ["배송요청사항", "요청사항", "비고", "메모", "notes"],
  document: ["판매번호", "일자no", "판매일자no", "전표번호", "일련번호"],
  amount: ["합계금액", "총금액", "판매금액", "금액"],
  net: ["공급가액", "공급금액"],
  vat: ["부가세", "세액"],
  lat: ["위도", "lat", "latitude"],
  lng: ["경도", "lng", "longitude"],
};
const normal = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\s_()[\]:：.\-/]/g, "")
    .toLowerCase();
function columnsFor(row: ExcelJS.Row) {
  const cells = new Map<string, number[]>();
  row.eachCell((cell, i) => {
    const text = normal(spreadsheetText(cell.value));
    cells.set(text, [...(cells.get(text) ?? []), i]);
  });
  const columns: Record<string, number> = {},
    ambiguous: string[] = [];
  for (const [key, names] of Object.entries(aliases))
    for (const alias of names) {
      const matches = cells.get(normal(alias));
      if (matches?.length) {
        if (matches.length > 1) ambiguous.push(alias);
        columns[key] = matches[0];
        break;
      }
    }
  if (
    columns.address &&
    (columns.recipient || columns.item) &&
    ambiguous.length
  )
    throw new Error(
      `‘${ambiguous[0]}’ 열이 여러 개입니다. 공급자 열과 배송지 열을 구분해 주세요.`,
    );
  return columns;
}
export async function isSalesSpreadsheet(buffer: Buffer, fileName: string) {
  const book = await loadSpreadsheet(buffer, fileName);
  for (const sheet of book.worksheets)
    for (let row = 1; row <= Math.min(sheet.rowCount, 30); row++) {
      const headers: string[] = [];
      sheet.getRow(row).eachCell((cell) => {
        headers.push(normal(spreadsheetText(cell.value)));
      });
      if (
        headers.some((v) => ["판매번호", "일자no", "판매일자no"].includes(v)) &&
        headers.some((v) => ["거래처", "거래처명", "거래처코드"].includes(v)) &&
        headers.includes("수량")
      )
        return true;
    }
  return false;
}
export async function parseSpreadsheetPreview(
  buffer: Buffer,
  fileName: string,
): Promise<{ drafts: ShipmentInput[]; warnings: string[] }> {
  const book = await loadSpreadsheet(buffer, fileName);
  let source:
    | {
        sheet: ExcelJS.Worksheet;
        header: number;
        columns: Record<string, number>;
      }
    | undefined;
  for (const sheet of book.worksheets) {
    for (let i = 1; i <= Math.min(sheet.rowCount, 30); i++) {
      const columns = columnsFor(sheet.getRow(i));
      if (columns.address && (columns.recipient || columns.item)) {
        source = { sheet, header: i, columns };
        break;
      }
    }
    if (source) break;
  }
  if (!source)
    throw new Error(
      "처음 30행 안에 배송주소·거래처(수령인)·품목 제목 열이 필요합니다. 공급자 주소와 배송주소를 구분해 주세요.",
    );
  const { sheet, header, columns } = source;
  if (sheet.rowCount - header > 2000)
    throw new Error("한 번에 최대 2,000행까지 업로드할 수 있습니다.");
  const warnings = new Set<string>(),
    grouped = new Map<string, ShipmentInput>();
  if (header !== 1)
    warnings.add(
      `${sheet.name} 시트 ${header}행의 제목을 기준으로 읽었습니다.`,
    );
  for (let i = header + 1; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i),
      read = (key: string, unique = false) => {
        if (!columns[key]) return "";
        const cell = row.getCell(columns[key]);
        if (unique && cell.isMerged && Number(cell.master.row) !== i) return "";
        return spreadsheetText(cell.value);
      };
    const recipient = read("recipient"),
      itemName = read("item"),
      address = read("address"),
      doc = read("document");
    if (!address && !recipient && !itemName) continue;
    if (
      [recipient, itemName, address].some((value) =>
        /^(총합계|합계|소계|총계)$/.test(normal(value)),
      )
    )
      continue;
    if (!address)
      throw new Error(
        `${i}행의 배송주소를 입력해 주세요. 공급자 주소가 아닌 배송주소 열을 확인해 주세요.`,
      );
    const phone = read("phone"),
      identity = JSON.stringify([
        parseSalesReference(doc)?.canonical ?? doc,
        recipient,
        address,
        phone,
      ]);
    let target = grouped.get(identity);
    if (!target) {
      target = {
        recipient: recipient || "",
        address,
        phone,
        notes: read("notes"),
        lat: read("lat") ? Number(read("lat")) : null,
        lng: read("lng") ? Number(read("lng")) : null,
        items: [],
        ...(doc ? { salesReference: doc } : {}),
        ...(read("customerCode") ? { customerCode: read("customerCode") } : {}),
      };
      grouped.set(identity, target);
    }
    const value = read("quantity")
      .replace(/,/g, "")
      .replace(/\s*(개|본|짝|ea)$/i, "");
    const quantity = value ? Number(value) : 0;
    if (value && (!Number.isFinite(quantity) || quantity <= 0))
      throw new Error(`${i}행의 수량은 0보다 큰 숫자로 입력해 주세요.`);
    if (!value)
      warnings.add(
        "수량이 없는 항목은 0으로 표시했습니다. 원본과 확인해 수량을 입력한 뒤 저장해 주세요.",
      );
    if (!recipient)
      warnings.add("거래처가 없는 배송지는 저장 전 입력해 주세요.");
    if (!itemName) warnings.add("품목명이 없는 항목은 저장 전 입력해 주세요.");
    const spec = read("specification"),
      name = itemName + (spec && !itemName.includes(spec) ? " " + spec : "");
    target.items.push({
      name,
      quantity,
      ...(read("code") ? { code: read("code") } : {}),
    });
    const parseMoney = (value: string) => {
      if (!value) return null;
      const amount = Number(value.replace(/[,₩￦원\s]/g, ""));
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e14)
        throw new Error(`${i}행 금액을 확인해 주세요.`);
      return amount;
    };
    let money = columns.amount ? parseMoney(read("amount", true)) : null;
    if (!columns.amount && columns.net) {
      const net = parseMoney(read("net", true)),
        vat = parseMoney(read("vat", true));
      if (net !== null) {
        money = net + (vat ?? 0);
        if (!columns.vat)
          warnings.add(
            "부가세 열이 없어 공급가액 기준 금액입니다. 원본과 확인해 주세요.",
          );
      }
    }
    if (money !== null)
      target.amount = Math.round(((target.amount ?? 0) + money) * 100) / 100;
  }
  if (!grouped.size) throw new Error("업로드할 배송 데이터가 없습니다.");
  return { drafts: [...grouped.values()], warnings: [...warnings] };
}
export async function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
): Promise<ShipmentInput[]> {
  return (await parseSpreadsheetPreview(buffer, fileName)).drafts;
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
    const amount =
      row.amount == null || row.amount === "" ? null : Number(row.amount);
    if (
      amount !== null &&
      (!Number.isFinite(amount) || amount < 0 || amount > 1e14)
    )
      throw new Error(`${i + 1}번 금액을 확인해 주세요.`);
    if (
      row.erpSourceKey &&
      !/^ecount-sale-[a-f0-9]{64}$/.test(row.erpSourceKey)
    )
      throw new Error("판매전표 번호를 확인해 주세요.");
    return {
      recipient: row.recipient.trim(),
      address: row.address.trim(),
      phone: String(row.phone ?? "").slice(0, 40),
      notes: String(row.notes ?? "").slice(0, 2000),
      items: row.items.map((v: any) => ({
        name: v.name.trim().slice(0, 200),
        quantity: Number(v.quantity),
        ...(v.code ? { code: String(v.code).slice(0, 100) } : {}),
      })),
      lat,
      lng,
      ...(amount !== null ? { amount } : {}),
      ...(row.customerCode
        ? { customerCode: String(row.customerCode).slice(0, 100) }
        : {}),
      ...(row.salesReference
        ? { salesReference: String(row.salesReference).slice(0, 200) }
        : {}),
      ...(row.erpSourceKey ? { erpSourceKey: row.erpSourceKey } : {}),
    };
  });
}
