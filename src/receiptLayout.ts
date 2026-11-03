import type {
  ReceiptLayout,
  ReceiptLayoutElement,
  ReceiptLayoutLine,
} from "./receiptText.ts";

const invalid = () =>
  new Error(
    "전표의 글자 위치 정보를 확인할 수 없습니다. 사진을 다시 촬영하거나 선택해 주세요.",
  );
const round = (value: number) => Math.round(value * 10_000) / 10_000;

// Keep OCR geometry bounded and portable before it enters device storage or a
// multipart request. Only these documented fields may be serialized.
export function normalizeReceiptLayout(value: unknown): ReceiptLayout {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  const input = value as Record<string, unknown>;
  const width = input.width;
  const height = input.height;
  if (
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Array.isArray(input.lines) ||
    input.lines.length > 1000
  )
    throw invalid();

  let characters = 0;
  let words = 0;
  const element = (value: unknown): ReceiptLayoutElement => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalid();
    const item = value as Record<string, unknown>;
    if (typeof item.text !== "string") throw invalid();
    characters += item.text.length;
    if (characters > 50_000) throw invalid();
    const text = item.text.trim();
    if (!text) throw invalid();
    const { x, y, width, height } = item;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number" ||
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      x > 1 ||
      y > 1 ||
      width <= 0 ||
      height <= 0 ||
      width > 1 ||
      height > 1 ||
      x + width > 1.000001 ||
      y + height > 1.000001
    )
      throw invalid();
    // Round endpoints together so accumulated floating-point error cannot put a
    // right/bottom edge beyond 1. Retain a tiny positive box after rounding.
    const left = Math.min(0.9999, round(x));
    const top = Math.min(0.9999, round(y));
    const right = Math.min(1, Math.max(left + 0.0001, round(x + width)));
    const bottom = Math.min(1, Math.max(top + 0.0001, round(y + height)));
    return {
      text,
      x: left,
      y: top,
      width: round(right - left),
      height: round(bottom - top),
    };
  };

  const lines = input.lines.map((value): ReceiptLayoutLine => {
    const box = element(value);
    const input = value as Record<string, unknown>;
    const line: ReceiptLayoutLine = { ...box };
    for (const key of ["blockId", "order"] as const) {
      const value = input[key];
      if (value !== undefined) {
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0
        )
          throw invalid();
        line[key] = value;
      }
    }
    if (input.elements !== undefined) {
      if (!Array.isArray(input.elements) || input.elements.length > 30)
        throw invalid();
      words += input.elements.length;
      if (words > 4000) throw invalid();
      line.elements = input.elements.map(element);
    }
    return line;
  });
  return { width, height, lines };
}
