import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { fork } from "node:child_process";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
export function parseReceipt(rawText: string): ShipmentInput {
  const lines = rawText
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const addressLine =
    lines.find((s) => /^(배송\s*주소|주\s*소|도착지)\s*[:：]/.test(s)) ??
    lines.find((s) =>
      /(대전|세종|충남|충북|서울|경기|부산|대구|인천|광주|울산|강원|전남|전북|경남|경북|제주).*(로|길|동|읍|면)/.test(
        s,
      ),
    ) ??
    "";
  const label = (regex: RegExp) =>
    lines
      .find((s) => regex.test(s))
      ?.replace(regex, "")
      .trim() ?? "";
  const phone = rawText.match(/0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/)?.[0] ?? "";
  const items = lines.flatMap((line) => {
    const match = line.match(
      /^(?:품목|상품|물품|제품)\s*[:：]\s*(.+?)(?:\s+(\d+(?:\.\d+)?)\s*(?:개|박스|EA)?)?$/i,
    );
    return match ? [{ name: match[1], quantity: Number(match[2] ?? 1) }] : [];
  });
  return {
    recipient: label(/^(?:거래처|수령인|수취인|상호|받는분)\s*[:：]\s*/),
    address: addressLine.replace(
      /^(?:배송\s*주소|주\s*소|도착지)\s*[:：]\s*/,
      "",
    ),
    phone,
    items: items.length ? items : [{ name: "", quantity: 1 }],
    notes: "사진 인식 결과를 원본 전표와 대조해 주세요.",
    lat: null,
    lng: null,
  };
}
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

let ocrBusy = false;
export async function recognizeReceipt(
  buffer: Buffer,
  options: { workerUrl?: URL; timeoutMs?: number } = {},
): Promise<string> {
  const { width, height } = receiptImageSize(buffer);
  if (width <= 0 || height <= 0) throw unreadablePhoto();
  if (width * height > 20_000_000)
    throw new ReceiptOcrError(
      "사진 해상도가 너무 큽니다. 일반 화질로 다시 촬영하거나 2,000만 화소 이하로 사진 크기를 줄여 주세요.",
      413,
    );
  // One administrator upload at a time; never retain an unbounded queue of images.
  if (ocrBusy)
    throw new ReceiptOcrError(
      "다른 전표 사진을 읽고 있습니다. 잠시 후 다시 업로드해 주세요.",
      429,
    );
  ocrBusy = true;
  let langDir: string | undefined;
  try {
    langDir = await mkdtemp(join(tmpdir(), "bareun-ocr-"));
    return await new Promise<string>((resolve, reject) => {
      // A process boundary also covers startup failures before createWorker()
      // exposes its thread handle. A stuck decoder cannot take down the API.
      const child = fork(
        options.workerUrl ?? new URL("./receiptOcrWorker.ts", import.meta.url),
        [],
        {
          execArgv: ["--use-env-proxy", "--experimental-strip-types"],
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      let text: string | undefined;
      let failure: ReceiptOcrError | undefined;
      let sent = false;
      let settled = false;
      const finish = (error?: ReceiptOcrError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(text!);
      };
      const stop = (error: ReceiptOcrError) => {
        failure = error;
        // Wait for close after killing so the next photo cannot overlap memory.
        if (!child.kill("SIGKILL")) finish(error);
      };
      const timer = setTimeout(
        () => stop(recognitionTimeout()),
        options.timeoutMs ?? 45_000,
      );
      timer.unref();
      child.once("error", () => stop(unreadablePhoto()));
      child.on("message", (message: unknown) => {
        const value = message as { type?: string; text?: unknown } | null;
        if (value?.type === "ready" && !sent) {
          sent = true;
          child.send({ image: buffer, langDir }, (error) => {
            if (error) stop(unreadablePhoto());
          });
        } else if (value?.type === "result" && typeof value.text === "string") {
          text = value.text;
        }
      });
      child.once("close", (code) => {
        finish(
          failure ??
            (code === 0 && text !== undefined ? undefined : unreadablePhoto()),
        );
      });
    });
  } finally {
    try {
      if (langDir) await rm(langDir, { recursive: true, force: true });
    } finally {
      ocrBusy = false;
    }
  }
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
    const lat = row.lat == null || row.lat === "" ? null : Number(row.lat),
      lng = row.lng == null || row.lng === "" ? null : Number(row.lng);
    if (
      (lat == null) !== (lng == null) ||
      (lat != null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) ||
      (lng != null && (!Number.isFinite(lng) || Math.abs(lng) > 180))
    )
      throw new Error(`${i + 1}번 위도·경도를 확인해 주세요.`);
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
