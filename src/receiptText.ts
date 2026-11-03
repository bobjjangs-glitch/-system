import type { ShipmentInput } from "../server/types.ts";

// Portable text parsing shared by the device preview and stored server review.
// Missing fields stay empty so the administrator can verify them before save.
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
