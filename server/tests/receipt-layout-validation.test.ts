import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReceiptLayout } from "../../src/receiptLayout.ts";

const box = { text: "  생수  ", x: 0.123456, y: 0.2, width: 0.3, height: 0.1 };
const layout = () => ({
  width: 2200,
  height: 1650,
  lines: [{ ...box, elements: [{ ...box }], blockId: 1, order: 0 }],
});

test("기기 OCR 위치 정보는 정규화·필드 제한 후 같은 값으로 다시 저장된다", () => {
  const input = layout();
  const result = normalizeReceiptLayout({
    ...input,
    session: "never-save",
    lines: [
      {
        ...input.lines[0],
        token: "never-save",
        elements: [{ ...box, private: "never-save" }],
      },
    ],
  });
  assert.equal(result.lines[0].text, "생수");
  assert.equal(result.lines[0].x, 0.1235);
  assert.equal(result.lines[0].elements?.[0].text, "생수");
  assert.equal(result.lines[0].blockId, 1);
  assert.equal(result.lines[0].order, 0);
  assert.ok(!JSON.stringify(result).includes("never-save"));
  assert.deepEqual(normalizeReceiptLayout(result), result);
});

test("이미지 크기·줄·단어 위치가 올바르지 않으면 기기 OCR 메타데이터를 거절한다", () => {
  for (const value of [
    null,
    {},
    { ...layout(), width: 0 },
    { ...layout(), height: Infinity },
    { ...layout(), width: "2200" },
    { ...layout(), lines: {} },
  ])
    assert.throws(() => normalizeReceiptLayout(value), /위치 정보/);
  for (const changes of [
    { x: -0.1 },
    { y: NaN },
    { width: 0 },
    { height: Infinity },
    { x: 0.9, width: 0.2 },
    { y: 0.95, height: 0.2 },
    { blockId: -1 },
    { order: 1.5 },
    { text: "   " },
  ]) {
    assert.throws(
      () =>
        normalizeReceiptLayout({
          ...layout(),
          lines: [{ ...box, ...changes }],
        }),
      /위치 정보/,
    );
  }
  assert.throws(
    () =>
      normalizeReceiptLayout({
        ...layout(),
        lines: [{ ...box, elements: [{ ...box, width: 2 }] }],
      }),
    /위치 정보/,
  );
  const boundary = normalizeReceiptLayout({
    width: 2200,
    height: 1650,
    lines: [
      { text: "끝", x: 0.99999, y: 0.99999, width: 0.00001, height: 0.00001 },
    ],
  }).lines[0];
  assert.ok(boundary.width > 0 && boundary.height > 0);
  assert.ok(
    boundary.x + boundary.width <= 1 && boundary.y + boundary.height <= 1,
  );
});

test("OCR 위치 메타데이터의 줄·단어·글자 수를 제한하고 경계 크기는 보존한다", () => {
  const token = { text: "가", x: 0, y: 0, width: 1, height: 1 };
  const max = {
    width: 2200,
    height: 1650,
    lines: Array.from({ length: 1000 }, () => ({
      ...token,
      elements: Array.from({ length: 4 }, () => ({ ...token })),
    })),
  };
  const normalized = normalizeReceiptLayout(max);
  assert.equal(normalized.lines.length, 1000);
  assert.equal(
    normalized.lines.reduce(
      (sum, line) => sum + (line.elements?.length ?? 0),
      0,
    ),
    4000,
  );
  assert.throws(
    () => normalizeReceiptLayout({ ...max, lines: [...max.lines, token] }),
    /위치 정보/,
  );
  assert.throws(
    () =>
      normalizeReceiptLayout({
        width: 1,
        height: 1,
        lines: [
          { ...token, elements: Array.from({ length: 31 }, () => token) },
        ],
      }),
    /위치 정보/,
  );
  assert.throws(
    () =>
      normalizeReceiptLayout({
        ...max,
        lines: max.lines.map((line, index) =>
          index === 0 ? { ...line, elements: [...line.elements, token] } : line,
        ),
      }),
    /위치 정보/,
  );
  assert.equal(
    normalizeReceiptLayout({
      width: 1,
      height: 1,
      lines: [{ ...token, text: "가".repeat(50_000) }],
    }).lines[0].text.length,
    50_000,
  );
  assert.throws(
    () =>
      normalizeReceiptLayout({
        width: 1,
        height: 1,
        lines: [{ ...token, text: "가".repeat(50_001) }],
      }),
    /위치 정보/,
  );
});
