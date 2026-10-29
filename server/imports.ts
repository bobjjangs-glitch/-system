import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker } from "tesseract.js";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
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
let ocrQueue: Promise<unknown> = Promise.resolve();
export async function recognizeReceipt(buffer: Buffer): Promise<string> {
  const run = async () => {
    const require = createRequire(import.meta.url);
    const kor = dirname(require.resolve("@tesseract.js-data/kor/package.json"));
    const eng = dirname(require.resolve("@tesseract.js-data/eng/package.json"));
    const langDir = await mkdtemp(join(tmpdir(), "bareun-ocr-"));
    let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
    try {
      await Promise.all(
        ["kor", "eng"].map((code) =>
          copyFile(
            join(
              code === "kor" ? kor : eng,
              "4.0.0_best_int",
              code + ".traineddata.gz",
            ),
            join(langDir, code + ".traineddata.gz"),
          ),
        ),
      );
      worker = await createWorker("kor+eng", 1, {
        langPath: langDir,
        cacheMethod: "none",
        gzip: true,
      });
      return (await worker.recognize(buffer)).data.text;
    } finally {
      await worker?.terminate();
      await rm(langDir, { recursive: true, force: true });
    }
  };
  const result = ocrQueue.then(run, run);
  ocrQueue = result.catch(() => {});
  return result;
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
