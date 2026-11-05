import ExcelJS from "exceljs";
import { Readable } from "node:stream";
export function spreadsheetText(value: any): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if (value.result != null) return spreadsheetText(value.result);
    if (value.richText) return value.richText.map((v: any) => v.text).join("");
    return String(value.text ?? "").trim();
  }
  return String(value).normalize("NFKC").trim();
}
export async function loadSpreadsheet(buffer: Buffer, fileName: string) {
  const book = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName)) {
    let data: string;
    if (buffer[0] === 255 && buffer[1] === 254)
      data = new TextDecoder("utf-16le").decode(buffer);
    else
      try {
        data = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        data = new TextDecoder("euc-kr").decode(buffer);
      }
    await book.csv.read(
      Readable.from(Buffer.from(data.replace(/^\uFEFF/, ""), "utf8")),
    );
  } else if (/\.xlsx$/i.test(fileName)) await book.xlsx.load(buffer as any);
  else
    throw new Error(
      "엑셀(.xlsx) 또는 CSV 파일을 선택해 주세요. .xls 파일은 .xlsx로 다시 저장해 주세요.",
    );
  if (
    book.worksheets.some(
      (sheet) => sheet.rowCount > 10030 || sheet.columnCount > 150,
    )
  )
    throw new Error("자료는 10,000행·150열 이내로 나눠 주세요.");
  return book;
}
