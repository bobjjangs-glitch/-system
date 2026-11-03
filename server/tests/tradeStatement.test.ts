import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReceipt,
  parseReceipt,
  type ReceiptLayout,
  type ReceiptLayoutElement,
  type ReceiptLayoutLine,
} from "../../src/receiptText.ts";
import { prepareTradeStatement } from "../../src/tradeStatement.ts";

// Every name, address, phone and serial below is synthetic. No customer PDF
// or OCR output is stored in the repository.
function line(
  text: string,
  x: number,
  y: number,
  width: number,
  height = 0.012,
): ReceiptLayoutLine {
  return { text, x, y, width, height };
}
const recipient = "검증자동차공업사(예시)",
  address = "충남 예시군 예시면 예시로 123 (예시리 11-22)";
function copy(
  offset = 0,
  name = recipient,
  serial = "2026/01/01 - 1",
): ReceiptLayoutLine[] {
  return [
    line("거래명세서", 0.21, 0.045 + offset, 0.15, 0.023),
    line(`${name}貴 中`, 0.19, 0.083 + offset, 0.24),
    line(`12345 ${address}`, 0.105, 0.1 + offset, 0.36),
    line("☎ 041-000-0000 / 010-0000-0000", 0.17, 0.116 + offset, 0.28),
    line("공", 0.505, 0.048 + offset, 0.014),
    line("급", 0.505, 0.074 + offset, 0.014),
    line("자", 0.505, 0.1 + offset, 0.014),
    line("일련번호", 0.54, 0.03 + offset, 0.07),
    line(serial, 0.62, 0.03 + offset, 0.16),
    line("상호", 0.55, 0.08 + offset, 0.03),
    line("검증공급주식회사", 0.62, 0.08 + offset, 0.2),
    line("주소", 0.55, 0.107 + offset, 0.03),
    line("대전 동구 공급로 10", 0.62, 0.102 + offset, 0.23),
    line("금액 : 칠십삼만육천원 정", 0.13, 0.14 + offset, 0.3),
    line("월/일", 0.105, 0.18 + offset, 0.03),
    line("품명 및 규격", 0.29, 0.18 + offset, 0.11),
    line("수량", 0.52, 0.18 + offset, 0.03),
    line("단가", 0.58, 0.18 + offset, 0.03),
    line("합계", 0.65, 0.18 + offset, 0.03),
    line("공장도가", 0.84, 0.18 + offset, 0.07),
    line("11/06", 0.105, 0.205 + offset, 0.03),
    line("12R22.5 ,18L,152/149L_CN [AH15]", 0.15, 0.205 + offset, 0.25),
    line("2", 0.53, 0.205 + offset, 0.01),
    line("368,000", 0.57, 0.205 + offset, 0.05),
    line("736,000", 0.65, 0.205 + offset, 0.05),
    line("451,000", 0.84, 0.205 + offset, 0.06),
    line("수량", 0.11, 0.33 + offset, 0.03),
    line("2", 0.2, 0.33 + offset, 0.01),
    line("오늘 금액", 0.27, 0.33 + offset, 0.07),
    line("736,000", 0.4, 0.33 + offset, 0.06),
    line("서명", 0.55, 0.33 + offset, 0.03),
  ];
}
const layout = (lines = copy()): ReceiptLayout => ({
  width: 1000,
  height: 1400,
  lines,
});
const raw = (value: ReceiptLayout) =>
  value.lines
    .map((entry) => entry.text)
    .reverse()
    .join("\n");
function expectBuyer(value: ReceiptLayout) {
  const result = extractReceipt(raw(value), value);
  assert.equal(result.draft.recipient, recipient);
  assert.equal(result.draft.address, address);
  assert.equal(result.draft.phone, "041-000-0000");
  assert.deepEqual(result.draft.items, [
    { name: "12R22.5,18L,152/149L_CN[AH15]", quantity: 2 },
  ]);
  return result;
}

test("거래명세서 바로 아래 왼쪽 고객 상자를 읽고 공급자·공장도가와 반복 사본을 제외한다", () => {
  expectBuyer(layout());
  expectBuyer(layout([...copy(), ...copy(0.49)]));
  const bottom = layout(
    copy(0.49).map((entry) => ({
      ...entry,
      y: (entry.y - 0.49) * 2,
      height: entry.height * 2,
    })),
  );
  expectBuyer(bottom);
});

test("회전·기울어짐·여백 크기와 관계없이 제목과 열 위치를 기준으로 읽는다", () => {
  const transform = (
    box: ReceiptLayoutElement,
    turn: number,
  ): ReceiptLayoutElement =>
    turn === 1
      ? {
          ...box,
          x: box.y,
          y: 1 - box.x - box.width,
          width: box.height,
          height: box.width,
        }
      : turn === 2
        ? { ...box, x: 1 - box.x - box.width, y: 1 - box.y - box.height }
        : {
            ...box,
            x: 1 - box.y - box.height,
            y: box.x,
            width: box.height,
            height: box.width,
          };
  for (const turn of [1, 2, 3])
    expectBuyer(layout(copy().map((entry) => transform(entry, turn))));
  expectBuyer(
    layout(
      copy().map((entry) => ({
        ...entry,
        y: entry.y + 0.12 * (entry.x + entry.width / 2 - 0.5),
      })),
    ),
  );
  expectBuyer(
    layout(
      copy().map((entry) => ({
        ...entry,
        x: (entry.x - 0.08) / 0.85,
        width: entry.width / 0.85,
        y: (entry.y - 0.025) / 0.4,
        height: entry.height / 0.4,
      })),
    ),
  );
});

test("서로 다른 거래처·일련번호·수량의 전표 두 장은 합치지 않고 다시 촬영하도록 알린다", () => {
  for (const second of [
    copy(0.49, "다른검증고객(예시)"),
    copy(0.49, recipient, "2025/01/01 - 1"),
    copy(0.49).map((entry) =>
      entry.text === "2" && entry.x === 0.53 ? { ...entry, text: "3" } : entry,
    ),
  ]) {
    const result = extractReceipt("", layout([...copy(), ...second]));
    assert.equal(result.draft.recipient, "");
    assert.equal(result.draft.items[0].name, "");
    assert.match(result.warnings.join(" "), /한 장씩/);
  }
});

test("한 전표 안에 같은 규격이 두 행 있어도 각 행의 수량을 보존한다", () => {
  const additional = copy()
    .filter((entry) => entry.y === 0.205)
    .map((entry) => ({ ...entry, y: 0.23 }));
  const result = extractReceipt("", layout([...copy(), ...additional]));
  assert.deepEqual(
    result.draft.items.map((entry) => entry.quantity),
    [2, 2],
  );
});

test("왼쪽이 공급자이고 오른쪽이 공급받는자인 다른 양식은 왼쪽 상자로 강제 해석하지 않는다", () => {
  const other = copy().concat(
    line("공급자", 0.15, 0.075, 0.07),
    line("공급받는자", 0.64, 0.065, 0.12),
  );
  assert.equal(prepareTradeStatement("", layout(other)).buyer, undefined);
  assert.equal(
    prepareTradeStatement("", layout(), { supplierName: recipient }).buyer,
    undefined,
  );
});

test("OCR에서 제목이 여러 단어와 공급자 줄로 합쳐져도 제목 단어의 영역만 사용한다", () => {
  const source = copy(),
    title = source[0];
  source[0] = {
    ...title,
    text: "거 래 명세 서 사업자 등록번호",
    width: 0.65,
    elements: [
      line("거", 0.21, title.y, 0.025),
      line("래", 0.245, title.y, 0.025),
      line("명세", 0.28, title.y, 0.05),
      line("서", 0.34, title.y, 0.025),
      line("사업자", 0.55, title.y, 0.05),
    ],
  };
  expectBuyer(layout(source));
});

test("트럭 규격의 소수점을 날짜로 지우지 않고 OCR가 불확실한 규격은 확인을 요청한다", () => {
  assert.deepEqual(parseReceipt("품목: 12.00R20 2").items, [
    { name: "12.00R20", quantity: 2 },
  ]);
  assert.deepEqual(parseReceipt("품목: 3.50R10 2").items, [
    { name: "3.50R10", quantity: 2 },
  ]);
  const damaged = layout(
    copy().map((entry) =>
      entry.text.startsWith("12R22.5")
        ? { ...entry, text: entry.text.replace("12R22.5", "128225") }
        : entry,
    ),
  );
  const result = extractReceipt("", damaged);
  assert.equal(result.draft.items[0].quantity, 2);
  assert.match(result.warnings.join(" "), /규격/);
});
