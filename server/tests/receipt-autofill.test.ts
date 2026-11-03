import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeReceiptAutofill } from "../../src/receiptAutofill.ts";
import type { ShipmentInput } from "../types.ts";

const blank = (): ShipmentInput => ({
  recipient: "",
  address: "",
  phone: "",
  notes: "",
  items: [{ name: "", quantity: 1 }],
  lat: null,
  lng: null,
});
const recognized = (): ShipmentInput => ({
  recipient: "예시 거래처",
  address: "대전광역시 동구 예시로 10",
  phone: "010-0000-0000",
  notes: "원문 대조",
  items: [{ name: "예시 상품", quantity: 8 }],
  lat: 36.3,
  lng: 127.4,
});

test("기본 수량 1인 빈 물품도 OCR 물품·수량으로 채우고 주소가 바뀌면 좌표를 비운다", () => {
  const rows = [{ ...blank(), address: "   ", lat: 36.1, lng: 127.1 }];
  const from = recognized();
  const snapshot = structuredClone(rows),
    extractedSnapshot = structuredClone(from);
  const result = mergeReceiptAutofill(rows, from);
  assert.deepEqual(result[0], { ...from, lat: null, lng: null });
  assert.notEqual(result, rows);
  assert.notEqual(result[0].items, from.items);
  assert.deepEqual(rows, snapshot);
  assert.deepEqual(from, extractedSnapshot);
});

test("수동으로 입력한 거래처·주소·연락처·메모와 양수 수량·좌표를 덮어쓰지 않는다", () => {
  const rows = [
    {
      ...recognized(),
      recipient: " 수동 거래처 ",
      address: "수동 주소",
      phone: "수동 연락처",
      notes: "수동 메모",
      items: [{ name: "예시 상품", quantity: 3 }],
      lat: 36.2,
      lng: 127.2,
    },
  ];
  const snapshot = structuredClone(rows);
  assert.equal(mergeReceiptAutofill(rows, recognized()), rows);
  assert.deepEqual(rows, snapshot);
});

test("빈 전화·메모만 채울 때 수동 주소와 좌표·기존 물품 목록은 유지한다", () => {
  const rows = [
    {
      ...blank(),
      recipient: "수동 거래처",
      address: "수동 주소",
      lat: 36.2,
      lng: 127.2,
      items: [{ name: "수동 상품", quantity: 2 }],
    },
  ];
  const [result] = mergeReceiptAutofill(rows, recognized());
  assert.equal(result.phone, recognized().phone);
  assert.equal(result.notes, recognized().notes);
  assert.equal(result.address, rows[0].address);
  assert.equal(result.lat, 36.2);
  assert.equal(result.lng, 127.2);
  assert.equal(result.items, rows[0].items);
});

test("수동 물품의 잘못된 수량만 유일하게 일치하는 OCR 상품명으로 채운다", () => {
  const rows = [
    {
      ...blank(),
      items: [
        { name: "예시 상 품", quantity: 0 },
        { name: "ＡＢＣ-10", quantity: NaN },
        { name: "기존 상품", quantity: 6 },
        { name: "", quantity: 1 },
      ],
    },
  ];
  const extracted = {
    ...blank(),
    items: [
      { name: "예시상품", quantity: 4 },
      { name: "abc-10", quantity: 0.5 },
      { name: "기존 상품", quantity: 99 },
      { name: "새 상품", quantity: 3 },
    ],
  };
  const result = mergeReceiptAutofill(rows, extracted);
  assert.deepEqual(result[0].items, [
    { name: "예시 상 품", quantity: 4 },
    { name: "ＡＢＣ-10", quantity: 0.5 },
    { name: "기존 상품", quantity: 6 },
    { name: "", quantity: 1 },
  ]);
  assert.equal(rows[0].items[0].quantity, 0);
  assert.ok(Number.isNaN(rows[0].items[1].quantity));
});

test("같은 이름이 여러 줄이거나 OCR 수량이 유효하지 않으면 수동 수량을 추측하지 않는다", () => {
  const rows = [
    {
      ...blank(),
      items: [
        { name: "예시상품", quantity: 0 },
        { name: "다른 상품", quantity: -1 },
        { name: "SKU-10", quantity: 0 },
      ],
    },
  ];
  const extracted = {
    ...blank(),
    items: [
      { name: "예시 상품", quantity: 2 },
      { name: "예시상품", quantity: 4 },
      { name: "다른 상품", quantity: Infinity },
      { name: "SKU10", quantity: 5 },
    ],
  };
  assert.equal(mergeReceiptAutofill(rows, extracted), rows);
});

test("배송지가 여러 개이면 OCR 한 장을 임의의 배송지에 적용하지 않는다", () => {
  const rows = [blank(), blank()];
  assert.equal(mergeReceiptAutofill(rows, recognized()), rows);
  const empty: ShipmentInput[] = [];
  assert.equal(mergeReceiptAutofill(empty, recognized()), empty);
});

test("OCR에서 주소를 찾지 못하면 기존 좌표를 그대로 두고 빈 정보로 입력 내용을 지우지 않는다", () => {
  const rows = [{ ...blank(), lat: 36.4, lng: 127.4 }];
  assert.equal(mergeReceiptAutofill(rows, blank()), rows);
  assert.equal(rows[0].lat, 36.4);
  assert.equal(rows[0].lng, 127.4);
});

test("빈 OCR 물품은 제외하고 인식한 물품의 잘못된 수량을 임의로 1로 바꾸지 않는다", () => {
  const extracted = {
    ...blank(),
    items: [
      { name: "  ", quantity: 2 },
      { name: " 예시 상품 ", quantity: 0 },
    ],
  };
  const [result] = mergeReceiptAutofill([blank()], extracted);
  assert.deepEqual(result.items, [{ name: "예시 상품", quantity: 0 }]);
});
