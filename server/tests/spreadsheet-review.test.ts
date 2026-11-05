import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { createRequire } from "node:module";
import {
  parseSpreadsheetPreview,
  isSalesSpreadsheet,
  validateShipments,
} from "../imports.ts";
import { parseSalesExport } from "../erpCatalog.ts";
import { Store } from "../database.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
async function file(rows: unknown[][], cover = false) {
  const book = new ExcelJS.Workbook();
  if (cover) book.addWorksheet("표지").addRow(["내보낸 자료"]);
  const sheet = book.addWorksheet("출고");
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await book.xlsx.writeBuffer());
}
test("기본 엑셀은 표지·제목줄을 건너뛰고 배송주소를 공급자 주소보다 우선하며 전표번호를 나눈다", async () => {
  const data = await file(
    [
      ["출고 전표 목록"],
      [],
      [
        "전표번호",
        "거래처명",
        "배송주소",
        "주소",
        "품명 및 규격",
        "수량",
        "합계금액",
      ],
      [
        "26/11/05-47",
        "예시 거래처",
        "대전 동구 검증로 1",
        "공급자 주소",
        "타이어 A",
        2,
        20000,
      ],
      [
        "26/11/05-48",
        "예시 거래처",
        "대전 동구 검증로 1",
        "공급자 주소",
        "타이어 B",
        3,
        30000,
      ],
      [
        "26/11/05-48",
        "예시 거래처",
        "대전 동구 검증로 1",
        "공급자 주소",
        "타이어 C",
        1,
        10000,
      ],
      ["", "합 계", "", "", "", 6, 60000],
    ],
    true,
  );
  const result = await parseSpreadsheetPreview(data, "delivery.xlsx");
  assert.equal(result.drafts.length, 2);
  assert.equal(result.drafts[0].address, "대전 동구 검증로 1");
  assert.equal(result.drafts[0].items[0].name, "타이어 A");
  assert.equal(result.drafts[1].items.length, 2);
  assert.equal(result.drafts[1].amount, 40000);
  assert.ok(result.warnings.some((v) => v.includes("3행")));
});
test("기본 CSV의 CP949·UTF16·BOM과 품목코드·규격·단위 붙은 수량을 읽는다", async () => {
  const text =
      "수령인,배송주소,품목명,규격,품목코드,수량\r\n예시 거래처,대전 동구 검증로 1,타이어,205/55R16,T-1,2개\r\n",
    iconv = createRequire(import.meta.url)("iconv-lite");
  for (const data of [
    iconv.encode(text, "cp949"),
    Buffer.from("\uFEFF" + text, "utf16le"),
    Buffer.from("\uFEFF" + text),
  ]) {
    const r = await parseSpreadsheetPreview(data, "delivery.csv");
    assert.equal(r.drafts[0].items[0].quantity, 2);
    assert.equal(r.drafts[0].items[0].name, "타이어 205/55R16");
    assert.equal(r.drafts[0].items[0].code, "T-1");
  }
});
test("기본 엑셀의 없는 수량·품목·거래처는 임의로 만들어 저장하지 않는다", async () => {
  const r = await parseSpreadsheetPreview(
    await file([
      ["거래처명", "배송주소", "품목명", "수량"],
      ["", "대전 동구 검증로 1", "", ""],
    ]),
    "delivery.xlsx",
  );
  assert.equal(r.drafts[0].items[0].quantity, 0);
  assert.equal(r.drafts[0].recipient, "");
  assert.ok(r.warnings.length >= 3);
  assert.throws(() => validateShipments(r.drafts));
});
test("구분 없는 중복 주소 열은 거절하고 판매조회 양식을 감지해 표지 다음 시트를 읽는다", async (t) => {
  await assert.rejects(
    parseSpreadsheetPreview(
      await file([
        ["거래처명", "주소", "주소", "품목", "수량"],
        ["예시", "A", "B", "물품", 1],
      ]),
      "delivery.xlsx",
    ),
    /여러 개/,
  );
  const data = await file(
    [
      ["판매번호", "거래처명", "배송주소", "품목명", "수량"],
      ["26/11/05-47", "예시", "대전 동구 검증로 1", "물품", 1],
    ],
    true,
  );
  assert.equal(await isSalesSpreadsheet(data, "sales.xlsx"), true);
  const dir = await mkdtemp(join(tmpdir(), "spreadsheet-cover-")),
    store = new Store(dir);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(
    (
      await parseSalesExport(store, data, "sales.xlsx", {
        salesDate: "2026-11-05",
      })
    ).drafts.length,
    1,
  );
});
