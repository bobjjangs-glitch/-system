import type { Item } from "../server/types.ts";
import type { ReceiptLayoutElement } from "./receiptText.ts";
const key = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
/** Won amounts only. Correct OCR letter/digit confusion only inside a known numeric cell. */
export function receiptWon(text: string): number | null {
  let value = key(text).replace(/^[₩￦\\]|원$/g, "");
  if (!/[0-9]/.test(value)) return null;
  value = value.replace(/[oO]/g, "0").replace(/[Il|]/g, "1");
  if (!/^(?:\d+|\d{1,3}(?:[,，.]\d{3})+)$/.test(value)) return null;
  const n = Number(value.replace(/[,，.]/g, ""));
  return Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000 ? n : null;
}
export function receiptMoneyColumn(text: string): keyof Item | null {
  const name = key(text).replace(/[:：|⊙◎○◉]/g, "");
  return /^(판매)?단가$/.test(name) ? "unitPrice"
    : /^(공급가액|금액)$/.test(name) ? "supplyAmount"
    : /^(합계|합계금액|총액)$/.test(name) ? "totalAmount"
    : /^공장도(?:가)?$/.test(name) ? "factoryPrice" : null;
}
export function receiptRowMoney(item: Item, cells: ReceiptLayoutElement[], headers: ReceiptLayoutElement[]): Item {
  const sorted = [...headers].sort((a, b) => a.x + a.width / 2 - b.x - b.width / 2);
  const center = (c: ReceiptLayoutElement) => c.x + c.width / 2;
  const values: Partial<Item> = {};
  for (let i = 0; i < sorted.length; i++) {
    const header = sorted[i], column = receiptMoneyColumn(header.text);
    if (!column) continue;
    const left = i ? (center(sorted[i - 1]) + center(header)) / 2 : header.x - .03;
    const right = i + 1 < sorted.length ? (center(header) + center(sorted[i + 1])) / 2 : 1;
    const group = cells.filter((c) => center(c) >= left && center(c) < right).sort((a,b) => a.x-b.x);
    if (!group.length) continue;
    const number = receiptWon(group.map((c) => c.text).join(""));
    if (number != null) (values as Record<string, number>)[column] = number;
  }
  return Object.keys(values).length ? { ...item, ...values, priceOrigin: "ocr" } : item;
}
export function receiptTextRowMoney(item: Item, price: string, amount: string, total?: string): Item {
  const unitPrice = receiptWon(price), supplyAmount = receiptWon(amount), totalAmount = total ? receiptWon(total) : null;
  return { ...item, ...(unitPrice != null ? { unitPrice } : {}), ...(supplyAmount != null ? { supplyAmount } : {}),
    ...(totalAmount != null ? { totalAmount } : {}), priceOrigin: "ocr" };
}
/** Use explicit document-total labels. Account numbers/balances and table headers are never totals. */
export function receiptTotal(lines: string[], cells: ReceiptLayoutElement[], warnings: string[]): number | undefined {
  const found: number[] = [], fallback: number[] = [];
  const label = /^(?:오늘금액|총금액|총합계|합계금액|청구금액|총계)[:：|]?/;
  for (let i = 0; i < lines.length; i++) {
    const text = key(lines[i]), match = text.match(label);
    if (!match || /잔액|전잔|후잔|입금|계좌/.test(text)) continue;
    const tail = text.slice(match[0].length);
    const number = receiptWon(tail || lines[i + 1] || "");
    if (number != null) (tail ? found : fallback).push(number);
  }
  for (const cell of cells) {
    const text = key(cell.text), match = text.match(label);
    if (!match) continue;
    const own = receiptWon(text.slice(match[0].length));
    if (own != null) { found.push(own); continue; }
    const cy = cell.y + cell.height / 2;
    const adjacent = cells.filter((c) => c !== cell && c.x >= cell.x + cell.width - .01 && Math.abs(c.y + c.height / 2 - cy) <= Math.max(.008, cell.height * .7));
    const numbers = adjacent.map(c => receiptWon(c.text)).filter((n): n is number => n != null);
    if (numbers.length === 1) found.push(numbers[0]);
  }
  // Korean statements also print an amount-in-words confirmation with a currency-marked number.
  for (const line of lines) {
    const match = line.match(/[(（]\s*[#₩￦] *([\d,，.]+)\s*[)）]/);
    if (match) { const n = receiptWon(match[1]); if (n != null) found.push(n); }
  }
  const unique = [...new Set(found.length ? found : fallback)];
  if (unique.length > 1) { warnings.push("전표 총합계가 서로 다르게 인식됐습니다. 원본 금액을 확인해 주세요."); return; }
  return unique[0];
}
export function checkReceiptMoney(items: Item[], amount: number | undefined, warnings: string[]) {
  for (const item of items) {
    if (item.unitPrice == null || item.quantity <= 0) continue;
    const base = Math.round(item.unitPrice * item.quantity), net = item.supplyAmount, total = item.totalAmount;
    const close = (a: number, b: number) => Math.abs(a-b) <= 1;
    const observed = net ?? total;
    if (observed != null && !close(base, observed) && !close(Math.round(base*1.1), observed))
      warnings.push(`${item.name}: 수량×단가와 인쇄 금액이 다릅니다. 금액을 확인해 주세요.`);
    if (net != null && total != null && !close(net, total) && !close(net+Math.round(net*.1), total))
      warnings.push(`${item.name}: 금액과 합계의 차이가 부가세 계산과 다릅니다. 원본을 확인해 주세요.`);
  }
  if (amount != null && items.length && items.every(i => i.totalAmount != null)) {
    if (Math.abs(items.reduce((sum,i) => sum + i.totalAmount!,0)-amount) > 1)
      warnings.push("품목 합계와 전표 총합계가 다릅니다. 인쇄된 값을 임의로 바꾸지 않았으니 원본을 확인해 주세요.");
  }
  if (items.some(i => i.priceOrigin === "ocr"))
    warnings.push("사진에 인쇄된 금액을 채웠습니다. 부가세 포함 여부와 단가·금액·합계를 원본과 확인해 주세요.");
}
