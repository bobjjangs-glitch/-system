import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { readFile } from "node:fs/promises";
import {
  parseSpreadsheet,
  parseReceipt,
  recognizeReceipt,
  validateShipments,
} from "../imports.ts";
test("엑셀의 같은 수령인·주소에 여러 물품을 합치고 한글 열을 읽는다", async () => {
  const book = new ExcelJS.Workbook(),
    sheet = book.addWorksheet("배송");
  sheet.addRows([
    ["수령인", "배송주소", "품목", "수량", "위도", "경도"],
    ["가게", "대전 동구 중앙로 215", "생수", 2, 36.33, 127.43],
    ["가게", "대전 동구 중앙로 215", "쌀", 3, 36.33, 127.43],
    ["창고", "대전 중구 중앙로 100", "봉투", 1, 36.32, 127.42],
  ]);
  const rows = await parseSpreadsheet(
    Buffer.from(await book.xlsx.writeBuffer()),
    "배송.xlsx",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].items, [
    { name: "생수", quantity: 2 },
    { name: "쌀", quantity: 3 },
  ]);
  assert.equal(validateShipments(rows)[0].lat, 36.33);
});
test("CSV도 읽고, 수량 오류나 잘못된 좌표는 거절한다", async () => {
  const rows = await parseSpreadsheet(
    Buffer.from("수령인,주소,품목,수량\n가게,대전 동구 중앙로 215,생수,2"),
    "배송.csv",
  );
  assert.equal(rows.length, 1);
  assert.throws(
    () => validateShipments([{ ...rows[0], lat: 123, lng: 127 }]),
    /위도/,
  );
  await assert.rejects(
    () =>
      parseSpreadsheet(
        Buffer.from("수령인,주소,품목,수량\n가게,대전 동구 중앙로 215,생수,0"),
        "배송.csv",
      ),
    /수량/,
  );
});
test("인쇄 전표 텍스트에서 한글 주소·수령인·물품을 추출하고 누락 값은 만들어내지 않는다", () => {
  const row = parseReceipt(
    "거래처: 대전상사\n배송주소: 대전광역시 동구 중앙로 215\n전화: 010-1234-5678\n품목: 생수 2",
  );
  assert.equal(row.recipient, "대전상사");
  assert.equal(row.address, "대전광역시 동구 중앙로 215");
  assert.equal(row.items[0].quantity, 2);
  assert.equal(row.lat, null);
  assert.equal(parseReceipt("잘 알아볼 수 없는 전표").address, "");
});
test(
  "로컬 한글·영문 학습 데이터를 로드해 실제 이미지에서 전표 문자를 인식한다",
  { timeout: 60000 },
  async () => {
    const text = await recognizeReceipt(
      await readFile(new URL("./fixtures/receipt.png", import.meta.url)),
    );
    assert.match(text, /DELIVERY/i);
    assert.match(text, /대전상사/);
    assert.match(text, /생수/);
    assert.equal(parseReceipt(text).items[0].quantity, 2);
    assert.match(text, /215/);
  },
);
