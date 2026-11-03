import type {
  ReceiptContext,
  ReceiptLayout,
  ReceiptLayoutElement,
  ReceiptLayoutLine,
} from "./receiptText.ts";

type Buyer = { recipient: string; address: string; phone: string };
type PreparedStatement = {
  rawText: string;
  layout?: ReceiptLayout;
  buyer?: Buyer;
  warnings: string[];
};
type Box = ReceiptLayoutElement;
type Header = { name: Box; quantity: Box; unit: Box; slope: number };
type Copy = {
  buyer: Buyer;
  rawText: string;
  layout?: ReceiptLayout;
  signature: string;
  invoiceId: string;
  quantities: string;
  reliableBuyer: boolean;
  uncertain: boolean;
  score: number;
};
const tidy = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim();
const key = (text: string) => tidy(text).replace(/\s+/g, "");
const cx = (box: Box) => box.x + box.width / 2;
const cy = (box: Box) => box.y + box.height / 2;
const titleText = (text: string) => /^거래명세서$/.test(key(text));
const phone = /0(?:1[016789]|\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}/g;
const region =
  /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충\s*청\s*[남북]\s*도|충\s*[남북]|전라[남북]도|전[남북]|경상[남북]도|경[남북]|제주)/;
const hasAddress = (text: string) =>
  region.test(text) && /(?:로|길|동|리)\s*\d/.test(text);
const stripHonorific = (text: string) =>
  tidy(text)
    .replace(/(?:貴\s*中|귀\s*중)\s*$/, "")
    .trim();
function titles(lines: ReceiptLayoutLine[]): Box[] {
  const result: Box[] = [];
  for (const line of lines) {
    if (titleText(line.text)) result.push(line);
    const words = line.elements?.length
      ? [...line.elements].sort((a, b) => a.x - b.x)
      : [];
    for (let start = 0; start < words.length; start++)
      for (let end = start; end < Math.min(words.length, start + 5); end++) {
        const selected = words.slice(start, end + 1),
          text = selected.map((word) => key(word.text)).join("");
        if (!/^(?:거|[A-Za-z]{1,2})래명세서$/.test(text)) continue;
        if (
          selected.some(
            (word, index) =>
              index > 0 &&
              word.x - (selected[index - 1].x + selected[index - 1].width) >
                Math.max(word.height * 2, 0.03),
          )
        )
          continue;
        const x = Math.min(...selected.map((word) => word.x)),
          y = Math.min(...selected.map((word) => word.y));
        const box = {
          text: "거래명세서",
          x,
          y,
          width: Math.max(...selected.map((word) => word.x + word.width)) - x,
          height: Math.max(...selected.map((word) => word.y + word.height)) - y,
        };
        if (
          !result.some(
            (other) =>
              Math.abs(cx(other) - cx(box)) < 0.02 &&
              Math.abs(cy(other) - cy(box)) < 0.02,
          )
        )
          result.push(box);
      }
  }
  return result;
}
function customerName(text: string): string {
  const value = stripHonorific(text).replace(/^[|Iil]\s+(?=[가-힣])/, ""),
    end = value.lastIndexOf(")"),
    start = value.lastIndexOf("(");
  // In this form a short honourific/decorative mark follows the final branch
  // parenthesis. OCR can turn those marks into Korean letters or punctuation.
  const tail = value.slice(end + 1).trim();
  return start > 1 &&
    end > start &&
    key(tail).length <= 8 &&
    !/^(?:지점|본점|센터|공장|창고|사무소)$/.test(tail) &&
    /^[가-힣\u4e00-\u9fff\p{P}\p{S}\s]*$/u.test(tail)
    ? value.slice(0, end + 1)
    : value;
}
function sourceSpacing(value: string, rawText: string): string {
  const characters = [...key(value)];
  if (!characters.length || characters.length > 300) return value;
  const expression = characters
    .map((character) => character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  return rawText.normalize("NFKC").match(new RegExp(expression))?.[0] || value;
}
function supplierMatch(buyer: Buyer, context: ReceiptContext): boolean {
  const normalize = (text: string) =>
    key(text).replace(/\(주\)|주식회사|광역시|특별시|[()[\],.]/g, "");
  const name = normalize(context.supplierName || ""),
    address = normalize(context.supplierAddress || "");
  return Boolean(
    (name.length > 2 && normalize(buyer.recipient).includes(name)) ||
      (address.length > 8 && normalize(buyer.address).includes(address)),
  );
}
function invoiceId(text: string): string {
  return (
    text.match(
      /20\d{2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{1,2}\s*[-–]\s*\d{1,6}/,
    )?.[0] || ""
  ).replace(/\s+/g, "");
}

function rotate(box: Box, turn: number): Box {
  if (turn === 1)
    return {
      ...box,
      x: box.y,
      y: 1 - box.x - box.width,
      width: box.height,
      height: box.width,
    };
  if (turn === 2)
    return { ...box, x: 1 - box.x - box.width, y: 1 - box.y - box.height };
  if (turn === 3)
    return {
      ...box,
      x: 1 - box.y - box.height,
      y: box.x,
      width: box.height,
      height: box.width,
    };
  return { ...box };
}
function normalized(layout: ReceiptLayout): ReceiptLayoutLine[] {
  const absolute = layout.lines.some(
    (line) => line.x > 1 || line.y > 1 || line.width > 1 || line.height > 1,
  );
  const w = absolute ? layout.width || 1 : 1,
    h = absolute ? layout.height || 1 : 1;
  const normalize = (box: Box): Box => ({
    text: tidy(box.text),
    x: box.x / w,
    y: box.y / h,
    width: box.width / w,
    height: box.height / h,
  });
  return layout.lines
    .slice(0, 1000)
    .filter((line) =>
      [line.x, line.y, line.width, line.height].every(Number.isFinite),
    )
    .map((line) => ({
      ...normalize(line),
      elements: line.elements?.slice(0, 30).map(normalize),
    }));
}
function atoms(lines: ReceiptLayoutLine[]): Box[] {
  return lines
    .flatMap((line) => (line.elements?.length ? line.elements : [line]))
    .slice(0, 4000);
}
function rows(boxes: Box[]): Box[][] {
  const groups: Box[][] = [];
  for (const box of [...boxes].sort((a, b) => cy(a) - cy(b) || a.x - b.x)) {
    let group = groups.at(-1);
    if (
      !group ||
      Math.abs(cy(group[0]) - cy(box)) >
        Math.max(0.003, Math.min(group[0].height, box.height) * 0.7)
    ) {
      group = [];
      groups.push(group);
    }
    group.push(box);
  }
  return groups.map((group) => group.sort((a, b) => a.x - b.x));
}
function rowText(boxes: Box[]): string[] {
  return rows(boxes).map((row) => row.map((box) => box.text).join(" "));
}
function headers(boxes: Box[]): Header[] {
  const names = boxes.filter((box) =>
    /^(?:품명(?:및규격|규격|및)?|품목|상품명)$/.test(key(box.text)),
  );
  const units = boxes.filter((box) =>
    /^(?:단가|공급단가)$/.test(key(box.text)),
  );
  return boxes
    .filter((box) => /^(?:수량|QTY)$/i.test(key(box.text)))
    .flatMap((quantity) => {
      const name = names
        .filter(
          (box) =>
            cx(box) < cx(quantity) && Math.abs(cy(box) - cy(quantity)) < 0.13,
        )
        .sort(
          (a, b) =>
            Math.abs(cy(a) - cy(quantity)) - Math.abs(cy(b) - cy(quantity)),
        )[0];
      const unit = units
        .filter(
          (box) =>
            cx(box) > cx(quantity) && Math.abs(cy(box) - cy(quantity)) < 0.06,
        )
        .sort(
          (a, b) =>
            Math.abs(cy(a) - cy(quantity)) - Math.abs(cy(b) - cy(quantity)),
        )[0];
      if (!name || !unit || cx(unit) - cx(name) < 0.08) return [];
      const slope = (cy(unit) - cy(name)) / (cx(unit) - cx(name));
      return Math.abs(slope) < 0.3 ? [{ name, quantity, unit, slope }] : [];
    });
}
function deskew(box: Box, header: Header): Box {
  return { ...box, y: box.y - header.slope * (cx(box) - cx(header.quantity)) };
}
function buyerFromRows(textRows: string[]): Buyer {
  const addressIndex = textRows.findIndex(hasAddress);
  const address =
    addressIndex >= 0
      ? textRows[addressIndex]
          .replace(/^\s*\d{5,6}\s+/, "")
          .replace(/\)\s*[^)]*$/, ")")
      : "";
  const phoneRows = textRows.flatMap((line) => line.match(phone) || []);
  const recipient =
    textRows
      .slice(0, addressIndex >= 0 ? addressIndex : textRows.length)
      .map(customerName)
      .find(
        (line) =>
          /[가-힣A-Za-z]/.test(line) &&
          !hasAddress(line) &&
          !line.match(phone) &&
          !/거래명세서|사업자|등록번호|일련번호|금액|성명|상호|주소|공급자/.test(
            key(line),
          ) &&
          !/^[공급자]$/.test(key(line)),
      ) || "";
  return { recipient, address, phone: phoneRows[0] || "" };
}
function copySignature(
  buyer: Buyer,
  tableBoxes: Box[],
  header: Header,
): string {
  const qx = cx(header.quantity),
    ux = cx(header.unit),
    left = (cx(header.name) + qx) / 2,
    right = (qx + ux) / 2;
  const goods = rows(tableBoxes).flatMap((row) => {
    const names = row
      .filter((box) => cx(box) < left)
      .map((box) => box.text)
      .join(" ")
      .replace(/^\d{1,2}[/.-]\d{1,2}\s*/, "");
    const quantities = row
      .filter((box) => cx(box) >= left && cx(box) <= right)
      .map((box) => key(box.text))
      .filter((text) => /^\d+(?:\.\d+)?$/.test(text));
    return /[A-Za-z가-힣]/.test(names) && quantities.length === 1
      ? [`${key(names)}:${quantities[0]}`]
      : [];
  });
  return goods.length && buyer.recipient && buyer.address
    ? `${key(buyer.recipient)}|${key(buyer.address)}|${goods.join(";")}`
    : "";
}
function spatialCopies(
  rawText: string,
  layout: ReceiptLayout,
  context: ReceiptContext,
): Copy[] {
  const original = normalized(layout);
  let oriented = original,
    best = -1;
  for (let turn = 0; turn < 4; turn++) {
    const trial = original.map((line) => ({
      ...rotate(line, turn),
      elements: line.elements?.map((word) => rotate(word, turn)),
    }));
    const words = atoms(trial),
      head = headers(words);
    const anchors = titles(trial);
    const score = head.filter((entry) =>
      anchors.some(
        (title) =>
          cy(title) < cy(entry.quantity) &&
          cy(entry.quantity) - cy(title) < 0.65 &&
          cx(title) < cx(entry.quantity),
      ),
    ).length;
    if (score > best) {
      best = score;
      oriented = trial;
    }
  }
  if (best <= 0) return [];
  const allWords = atoms(oriented),
    allHeaders = headers(allWords),
    result: Copy[] = [];
  for (const header of allHeaders.slice(0, 4)) {
    const adjusted = oriented.map((line) => ({
      ...deskew(line, header),
      elements: line.elements?.map((word) => deskew(word, header)),
    }));
    const words = atoms(adjusted),
      h = deskew(header.quantity, header);
    const anchors = titles(adjusted);
    const title = anchors
      .filter(
        (line) =>
          cy(line) < cy(h) && cy(h) - cy(line) < 0.65 && cx(line) < cx(h),
      )
      .sort((a, b) => cy(b) - cy(a))[0];
    if (!title) continue;
    const nextTitle = anchors
      .filter((line) => cy(line) > cy(h))
      .sort((a, b) => cy(a) - cy(b))[0];
    const footer = words
      .filter(
        (box) =>
          cy(box) > cy(h) + h.height &&
          cy(box) < (nextTitle ? cy(nextTitle) : 2) &&
          /^(?:오늘금액|서명|입금계좌|잔액)$/.test(key(box.text)),
      )
      .sort((a, b) => cy(a) - cy(b))[0];
    const bottom = footer
      ? cy(footer) - footer.height * 0.6
      : nextTitle
        ? nextTitle.y - 0.02
        : 1;
    const top = Math.max(0, title.y - (cy(h) - cy(title)) * 0.5);
    const left = Math.min(
      ...words
        .filter((box) => Math.abs(cy(box) - cy(h)) < Math.max(0.015, h.height))
        .map((box) => box.x),
    );
    const supplierLabels = words.filter(
      (box) =>
        cy(box) > title.y &&
        cy(box) < cy(h) &&
        box.x > cx(title) &&
        /^(?:공|급|자|공급자|상호|사업자|등록번호|TEL|주소)$/.test(
          key(box.text),
        ),
    );
    const boxRight =
      Math.min(h.x, ...supplierLabels.map((box) => box.x)) - 0.005;
    const amountBar = words
      .filter(
        (box) =>
          cy(box) > cy(title) &&
          cy(box) < cy(h) &&
          /^(?:금액[:：]?|금액[:：].*)$/.test(key(box.text)),
      )
      .sort((a, b) => cy(a) - cy(b))[0];
    const buyerBottom = amountBar ? amountBar.y : h.y - h.height;
    const buyerWords = words.filter(
      (box) =>
        cy(box) > title.y + title.height * 0.9 &&
        cy(box) < buyerBottom &&
        cx(box) >= left - 0.015 &&
        cx(box) < boxRight,
    );
    if (
      buyerWords.some((box) =>
        /^(?:공급자|판매자|보내는분)$/.test(key(box.text)),
      ) ||
      words.some(
        (box) =>
          cy(box) > title.y &&
          cy(box) < cy(h) &&
          cx(box) > boxRight &&
          /^(?:공급받는자|구매자|수취인)$/.test(key(box.text)),
      )
    )
      continue;
    const clippedLines = adjusted
      .flatMap((line) => {
        const selected = (
          line.elements?.length ? line.elements : [line]
        ).filter((box) => buyerWords.some((word) => word === box));
        return selected.length
          ? [
              {
                y: cy(line),
                text: selected
                  .sort((a, b) => a.x - b.x)
                  .map((word) => word.text)
                  .join(" "),
              },
            ]
          : [];
      })
      .sort((a, b) => a.y - b.y)
      .map((line) => line.text);
    const buyer = buyerFromRows(clippedLines);
    buyer.recipient = sourceSpacing(buyer.recipient, rawText);
    buyer.address = sourceSpacing(buyer.address, rawText);
    if (!buyer.recipient || !buyer.address || supplierMatch(buyer, context))
      continue;
    const noise = adjusted.filter(
      (line) =>
        cy(line) > cy(h) + h.height &&
        cy(line) < bottom &&
        line.width > 0.4 &&
        line.x < h.x &&
        line.x + line.width > header.unit.x &&
        (line.text.match(/\d{1,3}(?:,\d{3})+|\b\d{4,}\b/g) || []).length < 2,
    );
    const noiseWords = new Set(
      noise.flatMap((line) => (line.elements?.length ? line.elements : [line])),
    );
    const tableWords = words.filter(
      (box) =>
        cy(box) > cy(h) + h.height * 0.7 &&
        cy(box) < bottom &&
        !noiseWords.has(box),
    );
    const scoped = adjusted.filter(
      (line) => cy(line) >= top && cy(line) < bottom && !noise.includes(line),
    );
    const scopedWords = atoms(scoped);
    const signature = copySignature(buyer, tableWords, {
      ...header,
      name: deskew(header.name, header),
      quantity: h,
      unit: deskew(header.unit, header),
    });
    const invoice = invoiceId(
      rowText(words.filter((box) => cy(box) >= top && cy(box) < cy(h))).join(
        "\n",
      ),
    );
    const reliableBuyer =
      (buyer.recipient.match(/[가-힣]/g) || []).length >= 2 &&
      !/[A-Za-z]{8,}/.test(buyer.recipient);
    const quantities = rows(tableWords)
      .flatMap((row) =>
        row
          .filter(
            (box) =>
              Math.abs(cx(box) - cx(h)) < Math.abs(cx(header.unit) - cx(h)) / 2,
          )
          .map((box) => key(box.text))
          .filter((text) => /^\d+[.]?$/.test(text)),
      )
      .join(",");
    const spec = rowText(tableWords).join(" ");
    const uncertain =
      noise.length > 0 ||
      (/\d{3}\s*\/\s*\d{3}/.test(spec) &&
        !/(?:\d{3}\s*\/\s*\d{2,3}\s*R\s*\d{2}|\d{1,2}(?:\.\d+)?\s*R\s*\d{2}(?:\.\d+)?)(?!\d)/i.test(
          spec,
        ));
    result.push({
      buyer,
      rawText: rowText(scopedWords).join("\n"),
      layout: { lines: scoped, width: 1, height: 1 },
      signature,
      invoiceId: invoice,
      quantities,
      reliableBuyer,
      uncertain,
      score:
        Number(Boolean(buyer.recipient)) * 10 +
        Number(Boolean(buyer.address)) * 10 +
        Number(Boolean(buyer.phone)) * 3 +
        Number(Boolean(signature)) * 10 +
        Number(reliableBuyer) * 10,
    });
  }
  return result;
}

function textCopies(rawText: string, context: ReceiptContext): Copy[] {
  const source = rawText.slice(0, 50000).split(/\r?\n/);
  const titleRows = source.flatMap((line, index) =>
    /거\s*래\s*명\s*세\s*서/.test(line) ? [index] : [],
  );
  const result: Copy[] = [];
  for (const [position, start] of titleRows.slice(0, 4).entries()) {
    const end = titleRows[position + 1] ?? source.length;
    const copy = source.slice(start, end);
    const table = copy.findIndex((line) =>
      /품\s*명.*수\s*량.*단\s*가/.test(line),
    );
    if (table < 0) continue;
    const before = copy.slice(1, table);
    const box = before
      .slice(
        0,
        before.findIndex((line) => /^\s*금\s*액\s*[:：]/.test(line)) >= 0
          ? before.findIndex((line) => /^\s*금\s*액\s*[:：]/.test(line))
          : before.length,
      )
      .map((line) => line.trim().split(/\s{2,}/)[0])
      .filter(Boolean);
    const buyer = buyerFromRows(box);
    if (!buyer.recipient || !buyer.address || supplierMatch(buyer, context))
      continue;
    const footer = copy.findIndex(
      (line, index) =>
        index > table && /오늘\s*금액|입금\s*계좌|전잔|후잔/.test(line),
    );
    const goods = copy
      .slice(table + 1, footer < 0 ? copy.length : footer)
      .map((line) => tidy(line))
      .filter(Boolean);
    const itemRows = goods.filter((line) =>
      /\s\d+(?:\.\d+)?\s+[\d,]+\s+[\d,]+/.test(line),
    );
    const signature = itemRows.length
      ? `${key(buyer.recipient)}|${key(buyer.address)}|${itemRows.map(key).join(";")}`
      : "";
    result.push({
      buyer,
      rawText: copy.slice(0, footer < 0 ? copy.length : footer).join("\n"),
      signature,
      invoiceId: invoiceId(
        source.slice(Math.max(0, start - 3), end).join("\n"),
      ),
      quantities: "",
      reliableBuyer: true,
      uncertain: false,
      score:
        20 + Number(Boolean(buyer.phone)) * 3 + Number(Boolean(signature)) * 10,
    });
  }
  return result;
}

/** Recognize the title/left customer box/right supplier/table structure.
 * All regions are relative to detected content, not a particular A4 pixel size.
 * Selecting a copy never deduplicates repeated goods rows inside that copy.
 */
export function prepareTradeStatement(
  rawText: string,
  layout?: ReceiptLayout,
  context: ReceiptContext = {},
): PreparedStatement {
  const copies = layout?.lines?.length
    ? spatialCopies(rawText.slice(0, 50000), layout, context)
    : textCopies(rawText, context);
  if (!copies.length) return { rawText, layout, warnings: [] };
  const complete = copies.filter((copy) => copy.signature);
  const buyerKeys = new Set(
    copies
      .filter((copy) => copy.reliableBuyer)
      .map((copy) => `${key(copy.buyer.recipient)}|${key(copy.buyer.address)}`),
  );
  const signatures = new Set(complete.map((copy) => copy.signature));
  const invoices = new Set(
    copies.map((copy) => copy.invoiceId).filter(Boolean),
  );
  const sameInvoice =
    copies.length > 1 &&
    copies.every((copy) => copy.invoiceId) &&
    invoices.size === 1;
  const quantitySets = new Set(
    copies.map((copy) => copy.quantities).filter(Boolean),
  );
  if (
    buyerKeys.size > 1 ||
    invoices.size > 1 ||
    quantitySets.size > 1 ||
    (signatures.size > 1 && !sameInvoice)
  )
    return {
      rawText: "",
      layout: { lines: [] },
      buyer: { recipient: "", address: "", phone: "" },
      warnings: [
        "서로 다른 거래명세서가 함께 보입니다. 전표를 한 장씩 촬영해 주세요.",
      ],
    };
  const chosen = copies.sort((a, b) => b.score - a.score)[0];
  return {
    rawText: chosen.rawText,
    layout: chosen.layout,
    buyer: chosen.buyer,
    warnings:
      signatures.size > 1
        ? [
            "복사본의 인식 결과가 일부 달라 더 선명한 전표를 사용했습니다. 물품 규격을 확인해 주세요.",
          ]
        : chosen.uncertain
          ? ["물품 규격에 불분명한 문자가 있습니다. 원본 전표와 확인해 주세요."]
          : [],
  };
}
