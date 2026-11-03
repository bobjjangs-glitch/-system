import type { Item, ShipmentInput } from "../server/types.ts";

export type ReceiptLayoutElement = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type ReceiptLayoutLine = ReceiptLayoutElement & {
  elements?: ReceiptLayoutElement[];
  blockId?: number;
  order?: number;
};
export type ReceiptLayout = {
  width?: number;
  height?: number;
  lines: ReceiptLayoutLine[];
};
export type ReceiptContext = {
  supplierName?: string;
  supplierAddress?: string;
};
export type ReceiptExtraction = {
  draft: ShipmentInput;
  warnings: string[];
  filledFields: string[];
};

type Cell = ReceiptLayoutElement & { index: number };
type Role = "supplier" | "buyer" | "unknown";
type Candidate = {
  value: string;
  index: number;
  score: number;
  role: Role;
  cell?: Cell;
};
type Field = "recipient" | "address" | "phone";

const aliases: Record<Field, string[]> = {
  recipient: [
    "배송거래처",
    "거래처명",
    "수령인",
    "수취인",
    "받는분",
    "받는사람",
    "납품처",
    "배송처",
    "거래처",
    "고객명",
    "업체명",
    "상호명",
    "상호",
  ],
  address: [
    "배송지주소",
    "배송주소",
    "납품주소",
    "배달주소",
    "도착지주소",
    "사업장소재지",
    "소재지",
    "배송지",
    "도착지",
    "주소",
  ],
  phone: [
    "배송연락처",
    "휴대전화",
    "휴대폰",
    "연락처",
    "전화번호",
    "전화",
    "TEL",
    "HP",
  ],
};
const itemAliases = [
  "품명및규격",
  "품명규격",
  "상품명",
  "제품명",
  "물품명",
  "품목",
  "상품",
  "물품",
  "제품",
  "품명",
];
const quantityAliases = ["수량", "QTY"];
const note = "사진 인식 결과를 원본 전표와 대조해 주세요.";
const tirePattern = /\d{3}\s*\/\s*\d{2,3}\s*R\s*\d{2}/i;
const phonePattern =
  /(?<!\d)0(?:1[016789]|\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;
const regionPattern =
  /(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기도?|강원(?:특별자치도|도)?|충청남도|충청북도|충남|충북|전라남도|전라북도|전북특별자치도|전남|전북|경상남도|경상북도|경남|경북|제주(?:특별자치도|도)?)/;

function clean(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function compact(value: string): string {
  return clean(value).replace(/\s+/g, "");
}
function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function labelPattern(names: string[]): RegExp {
  return new RegExp(
    `^[▶▷●•|\\s]*(?:${names.map((name) => [...name].map(escaped).join("\\s*")).join("|")})(?:\\s*[:：|=]\\s*|\\s+|$)`,
    "i",
  );
}
const fieldLabels = Object.fromEntries(
  Object.entries(aliases).map(([key, names]) => [key, labelPattern(names)]),
) as Record<Field, RegExp>;
const itemLabel = labelPattern(itemAliases);
function roleMarker(value: string): Role {
  const text = compact(value).replace(/[|:：()<>]/g, "");
  if (
    /^(?:공급받는자|공급받는사람|공급받는|수신처|수신자|받는분|매입처|구매자)$/.test(
      text,
    )
  )
    return "buyer";
  if (/^(?:공급자|급자|보내는분|발신자|매출처|판매자)$/.test(text))
    return "supplier";
  return "unknown";
}
function isLabel(value: string): boolean {
  const text = compact(value).replace(/[:：|]/g, "");
  return (
    Object.values(aliases)
      .flat()
      .concat(itemAliases, quantityAliases, [
        "단가",
        "금액",
        "합계",
        "공급가액",
        "규격",
        "성명",
        "사업자",
        "등록번호",
        "사업자등록번호",
        "월/일",
        "적요",
        "공장도가",
      ])
      .some((name) => text.toUpperCase() === name.toUpperCase()) ||
    roleMarker(text) !== "unknown"
  );
}
function rawRole(lines: string[], index: number): Role {
  for (let i = index; i >= Math.max(0, index - 10); i--) {
    // An isolated fragment is useful with page geometry, but not as a section
    // boundary in ML Kit's potentially interleaved text block order.
    if (compact(lines[i]) === "급자") {
      if (i === index - 1) return "supplier";
      continue;
    }
    const role = roleMarker(lines[i]);
    if (role !== "unknown") return role;
  }
  return "unknown";
}
function normalizedLayout(layout?: ReceiptLayout): {
  lines: Cell[];
  atoms: Cell[];
} {
  if (!layout?.lines?.length) return { lines: [], atoms: [] };
  const lines: Cell[] = [],
    atoms: Cell[] = [];
  const normalize = (
    value: ReceiptLayoutElement,
    index: number,
  ): Cell | null => {
    if (![value.x, value.y, value.width, value.height].every(Number.isFinite))
      return null;
    const absolute =
      value.x > 1 || value.y > 1 || value.width > 1 || value.height > 1;
    const width = absolute ? layout.width || 1 : 1,
      height = absolute ? layout.height || 1 : 1;
    const cell = {
      text: clean(value.text),
      x: value.x / width,
      y: value.y / height,
      width: value.width / width,
      height: value.height / height,
      index,
    };
    return cell.text && cell.width >= 0 && cell.height >= 0 ? cell : null;
  };
  for (const [index, line] of layout.lines.slice(0, 1000).entries()) {
    const cell = normalize(line, index);
    if (!cell) continue;
    lines.push(cell);
    const elements = line.elements?.slice(0, 30) || [];
    if (!elements.length) atoms.push(cell);
    else
      for (const element of elements) {
        const atom = normalize(element, index);
        if (atom) atoms.push(atom);
      }
  }
  return { lines, atoms: atoms.slice(0, 4000) };
}
function centerX(cell: ReceiptLayoutElement): number {
  return cell.x + cell.width / 2;
}
function centerY(cell: ReceiptLayoutElement): number {
  return cell.y + cell.height / 2;
}
function layoutRole(cell: Cell, anchors: Cell[]): Role {
  const near = anchors.filter(
    (anchor) =>
      centerY(anchor) <= centerY(cell) + 0.04 &&
      centerY(cell) - centerY(anchor) < 0.6,
  );
  near.sort(
    (a, b) =>
      Math.abs(centerX(a) - centerX(cell)) +
      Math.abs(centerY(a) - centerY(cell)) * 0.08 -
      Math.abs(centerX(b) - centerX(cell)) -
      Math.abs(centerY(b) - centerY(cell)) * 0.08,
  );
  return near.length ? roleMarker(near[0].text) : "unknown";
}
function companyKey(value: string): string {
  return compact(value)
    .replace(/\(주\)|주식회사|유한회사|[()[\].,]/g, "")
    .toLowerCase();
}
function sameSupplierName(value: string, context: ReceiptContext): boolean {
  const key = companyKey(value),
    supplier = companyKey(context.supplierName || "");
  return Boolean(
    supplier.length >= 2 && (key === supplier || key.includes(supplier)),
  );
}
function normalizeAddress(value: string): string {
  let result = clean(value).replace(
    /^[\s|:：\d-]*(?=(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충|전|경상|제주))/,
    "",
  );
  for (const name of [
    "충청남도",
    "충청북도",
    "전라남도",
    "전라북도",
    "경상남도",
    "경상북도",
    "대전광역시",
    "서울특별시",
    "전북특별자치도",
    "강원특별자치도",
    "세종특별자치시",
    "제주특별자치도",
  ])
    result = result.replace(new RegExp([...name].join("\\s*"), "g"), name);
  return result
    .replace(/(\d)\s*번\s*길/g, "$1번길")
    .replace(/\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}
function addressKey(value: string): string {
  return compact(normalizeAddress(value)).replace(
    /광역시|특별시|특별자치시|특별자치도|[()[\],.]/g,
    "",
  );
}
function sameSupplierAddress(value: string, context: ReceiptContext): boolean {
  const key = addressKey(value),
    supplier = addressKey(context.supplierAddress || "");
  return Boolean(
    supplier.length >= 8 && (key.includes(supplier) || supplier.includes(key)),
  );
}
function hasAddress(value: string): boolean {
  const text = normalizeAddress(value);
  return regionPattern.test(text) && /(?:로|길|동|리|읍|면)\s*\d/.test(text);
}
function cleanRecipient(value: string): string {
  return clean(value)
    .replace(/^[|:：▶▷\s]+/, "")
    .replace(/(?<=[가-힣])\s+(?=[가-힣])/g, "")
    .replace(/\)\s*[을를]$/, ")")
    .trim();
}
function isRecipient(value: string): boolean {
  const text = cleanRecipient(value);
  if (
    itemLabel.test(clean(value)) ||
    labelPattern(quantityAliases).test(clean(value))
  )
    return false;
  return (
    text.length >= 2 &&
    text.length <= 70 &&
    /[가-힣A-Za-z]/.test(text) &&
    !isLabel(text) &&
    !hasAddress(text) &&
    !tirePattern.test(text) &&
    !/거래명세서|세금계산서|입금|계좌|은행|반품|납품후|배송지당|오늘금액|공장도가|잔액|서명|수량|공급가액|결제|사업자등록|등록번호/.test(
      compact(text),
    ) &&
    !/\d{3,}[-/]\d{2,}/.test(text)
  );
}
function cleanPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("02"))
    return digits.replace(/^(02)(\d{3,4})(\d{4})$/, "$1-$2-$3");
  return digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, "$1-$2-$3");
}
function textCandidates(lines: string[], field: Field): Candidate[] {
  const result: Candidate[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index],
      match = line.match(fieldLabels[field]);
    if (match) {
      const own = line.slice(match[0].length).trim(),
        next = lines[index + 1] || "",
        previous = lines[index - 1] || "";
      const specific = /배송|납품|수령|수취|받는|거래처|고객/.test(
        compact(match[0]),
      );
      if (own && !isLabel(own))
        result.push({
          value: own,
          index,
          score: specific ? 120 : 90,
          role: rawRole(lines, index),
        });
      if (!own && next && !isLabel(next))
        result.push({
          value: next,
          index: index + 1,
          score: specific ? 105 : 70,
          role: rawRole(lines, index),
        });
      // Block-based OCR sometimes emits a value before its printed label.
      if (!own && previous && !isLabel(previous))
        result.push({
          value: previous,
          index: index - 1,
          score: specific ? 80 : 55,
          role: rawRole(lines, index - 1),
        });
    }
    if (field === "address" && hasAddress(line))
      result.push({
        value: line,
        index,
        score: 50,
        role: rawRole(lines, index),
      });
    if (field === "phone")
      for (const phone of line.match(phonePattern) || [])
        result.push({
          value: phone,
          index,
          score: 45,
          role: rawRole(lines, index),
        });
    if (
      field === "recipient" &&
      /카인테리어|카센터|상사|타이어|자동차|정비|공업사|물류|유통|마트|식당|약국|병원|어린이집|주식회사|\(주\)/.test(
        compact(line),
      ) &&
      isRecipient(line)
    ) {
      const bankNearby = lines
        .slice(Math.max(0, index - 3), index)
        .some((item) => /입금\s*계\s*좌|은행/.test(item));
      result.push({
        value: line,
        index,
        score: bankNearby ? -100 : 45,
        role: bankNearby ? "supplier" : rawRole(lines, index),
      });
    }
  }
  return result;
}
function layoutCandidates(
  cells: Cell[],
  atoms: Cell[],
  field: Field,
): Candidate[] {
  const result: Candidate[] = [],
    anchors = cells
      .concat(atoms)
      .filter((cell) => roleMarker(cell.text) !== "unknown");
  for (const label of cells.concat(atoms)) {
    const match = label.text.match(fieldLabels[field]);
    if (!match) continue;
    const role = layoutRole(label, anchors),
      own = label.text.slice(match[0].length).trim();
    const specific = /배송|납품|수령|수취|받는|거래처|고객/.test(
      compact(match[0]),
    );
    if (own && !isLabel(own))
      result.push({
        value: own,
        index: label.index,
        score: specific ? 160 : 130,
        role,
        cell: label,
      });
    if (own) continue;
    const sameRow = atoms.filter(
      (cell) =>
        cell !== label &&
        cell.x >= label.x + label.width - 0.003 &&
        Math.abs(centerY(cell) - centerY(label)) <
          Math.max(0.012, label.height * 0.65),
    );
    const nextLabel = sameRow
      .filter((cell) => isLabel(cell.text))
      .sort((a, b) => a.x - b.x)[0];
    const regionLimit =
      anchors
        .filter((anchor) => anchor.x > label.x + 0.1)
        .sort((a, b) => a.x - b.x)[0]?.x ?? 1;
    const rowValue = sameRow
      .filter(
        (cell) =>
          !isLabel(cell.text) &&
          cell.x < Math.min(nextLabel?.x ?? 1, regionLimit),
      )
      .sort((a, b) => a.x - b.x);
    if (rowValue.length)
      result.push({
        value: rowValue.map((cell) => cell.text).join(" "),
        index: rowValue[0].index,
        score: specific ? 155 : 125,
        role,
        cell: label,
      });
    const below = cells
      .filter(
        (cell) =>
          cell.index !== label.index &&
          cell.y >= label.y + label.height - 0.003 &&
          cell.y - label.y < 0.07 &&
          Math.abs(cell.x - label.x) < 0.12 &&
          !isLabel(cell.text),
      )
      .sort((a, b) => a.y - b.y);
    if (below.length)
      result.push({
        value: below[0].text,
        index: below[0].index,
        score: specific ? 120 : 90,
        role,
        cell: label,
      });
  }
  for (const cell of cells) {
    if (field === "address" && hasAddress(cell.text))
      result.push({
        value: cell.text,
        index: cell.index,
        score: 65,
        role: layoutRole(cell, anchors),
        cell,
      });
    if (field === "phone")
      for (const phone of cell.text.match(phonePattern) || [])
        result.push({
          value: phone,
          index: cell.index,
          score: 65,
          role: layoutRole(cell, anchors),
          cell,
        });
  }
  return result;
}
function normalizeItemName(value: string): string {
  return clean(value)
    .replace(
      /^\d{1,2}\s*[/.-]\s*\d{1,2}\s*[|:]?\s*(?=\d{3}\s*\/|[가-힣A-Za-z])/,
      "",
    )
    .replace(/(\d{3})\s*\/\s*(\d{2,3})\s*R\s*(\d{2})/gi, "$1/$2R$3")
    .replace(/\s*([,[\]])\s*/g, "$1")
    .replace(/\s*([|])\s*$/g, "")
    .trim();
}
function quantity(value: string): number | null {
  const match = clean(value).match(
    /^(\d+(?:\.\d+)?)\s*(?:개|본|박스|상자|EA|BOX|SET|묶음|포|대|장)?$/i,
  );
  if (!match) return null;
  const number = Number(match[1]);
  return number > 0 && number <= 10000 ? number : null;
}
function itemName(value: string): boolean {
  const text = clean(value);
  if (
    /^(?:품명(?:및)?|품목|규격|수량|단가|금액|합계|공급가액|월\/일|적요|QTY)+$/i.test(
      compact(text).replace(/[|:：]/g, ""),
    )
  )
    return false;
  return Boolean(
    text &&
      /[가-힣A-Za-z]/.test(text) &&
      !isLabel(text) &&
      !hasAddress(text) &&
      !/합계|총수량|금액|잔액|입금|은행|공급가액|사업자|등록번호|거래명세서|반품|결제|서명|납품후/.test(
        compact(text),
      ) &&
      !/^\(?\d{1,3}(?:,\d{3})+/.test(text),
  );
}
function tableItems(atoms: Cell[]): Item[] {
  const headers = atoms.map((cell) => ({
    ...cell,
    key: compact(cell.text).replace(/[|:：]/g, ""),
  }));
  const tables = headers
    .filter((cell) => /^(수량|QTY)$/i.test(cell.key))
    .flatMap((qtyHeader) => {
      const sameRow = headers.filter(
        (cell) =>
          Math.abs(centerY(cell) - centerY(qtyHeader)) <=
          Math.max(0.018, qtyHeader.height),
      );
      const name = sameRow.find((cell) =>
        /^(품명(?:및규격|규격|및)?|품목|상품명|제품명|물품명)$/i.test(cell.key),
      );
      return name ? [{ qtyHeader, name, sameRow }] : [];
    });
  if (!tables.length) return [];
  const table = tables.sort((a, b) => a.qtyHeader.y - b.qtyHeader.y)[0];
  const columnHeaders = table.sameRow
    .filter((cell) =>
      /품명|품목|상품명|제품명|물품명|규격|수량|QTY|단가|금액|합계|공급가액|공장도|월\/일|일자|날짜|적요/i.test(
        cell.key,
      ),
    )
    .sort((a, b) => centerX(a) - centerX(b));
  const qtyCenter = centerX(table.qtyHeader),
    nameCenter = centerX(table.name);
  const previous = columnHeaders
      .filter((cell) => centerX(cell) < qtyCenter - 0.005)
      .at(-1),
    next = columnHeaders.find((cell) => centerX(cell) > qtyCenter + 0.005);
  const qtyLeft = previous
    ? (centerX(previous) + qtyCenter) / 2
    : table.qtyHeader.x - 0.02;
  const qtyRight = next
    ? (centerX(next) + qtyCenter) / 2
    : table.qtyHeader.x + table.qtyHeader.width + 0.03;
  const date = columnHeaders
    .filter(
      (cell) => centerX(cell) < nameCenter && /月|월|일자|날짜/.test(cell.key),
    )
    .at(-1);
  const nameLeft = date
    ? (centerX(date) + nameCenter) / 2
    : Math.max(0, table.name.x - 0.06);
  const data = atoms.filter(
    (cell) =>
      cell.y > table.qtyHeader.y + table.qtyHeader.height * 0.65 &&
      centerX(cell) >= nameLeft &&
      centerX(cell) <= qtyRight,
  );
  const rows: Cell[][] = [];
  for (const cell of data.sort(
    (a, b) => centerY(a) - centerY(b) || a.x - b.x,
  )) {
    let row = rows.find(
      (group) =>
        Math.abs(centerY(group[0]) - centerY(cell)) <=
        Math.max(0.007, Math.min(group[0].height, cell.height) * 0.55),
    );
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(cell);
  }
  const result: Item[] = [];
  for (const row of rows) {
    const allText = row.map((cell) => cell.text).join(" ");
    if (
      /오늘\s*금액|총\s*수량|총\s*합계|입금\s*계좌|전잔|후잔|서명|^\s*(?:합계|총계|공급가액|부가세)(?:\s|$)/.test(
        allText,
      )
    )
      break;
    const nameCells = row
      .filter((cell) => centerX(cell) < qtyLeft && centerX(cell) >= nameLeft)
      .sort((a, b) => a.x - b.x);
    const qtyCells = row.filter(
      (cell) => centerX(cell) >= qtyLeft && centerX(cell) <= qtyRight,
    );
    const name = normalizeItemName(
      nameCells.map((cell) => cell.text).join(" "),
    );
    const quantities = qtyCells
      .map((cell) => quantity(cell.text))
      .filter((value): value is number => value !== null);
    if (!itemName(name)) continue;
    result.push({
      name,
      quantity: quantities.length === 1 ? quantities[0] : 0,
    });
  }
  return result;
}
function textItems(lines: string[]): Item[] {
  const result: Item[] = [];
  const consumedRows = new Set<number>();
  const hasTable =
    lines.some((line) => /품\s*명|품\s*목|상\s*품\s*명/.test(line)) &&
    lines.some((line) => /수\s*량|QTY/i.test(line));
  for (let index = 0; index < lines.length; index++) {
    if (consumedRows.has(index)) continue;
    const line = lines[index],
      label = line.match(itemLabel);
    let sourceIndex = index;
    let value = label ? line.slice(label[0].length).trim() : "";
    if (label && !value && lines[index + 1] && !isLabel(lines[index + 1])) {
      value = lines[index + 1];
      sourceIndex = index + 1;
    }
    const tire = tirePattern.test(line);
    if (tire && !value) value = line;
    if (!value && hasTable) {
      const columns = line.match(
        /^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d[\d,]*)\s+(\d[\d,]*)(?:\s+.*)?$/,
      );
      if (
        columns &&
        itemName(columns[1]) &&
        Number(columns[2]) > 0 &&
        Number(columns[2]) <= 10000
      )
        result.push({
          name: normalizeItemName(columns[1]),
          quantity: Number(columns[2]),
        });
      continue;
    }
    if (!value || !itemName(value)) continue;
    consumedRows.add(sourceIndex);
    const tableRow = value.match(
      /^(.+?)\s+(\d+(?:\.\d+)?)\s+(\d[\d,]*)\s+(\d[\d,]*)(?:\s+.*)?$/,
    );
    if (tableRow && hasTable) {
      result.push({
        name: normalizeItemName(tableRow[1]),
        quantity: Number(tableRow[2]) <= 10000 ? Number(tableRow[2]) : 0,
      });
      continue;
    }
    const trailing = value.match(
      /^(.+?)\s+(\d+(?:\.\d+)?)\s*(개|본|박스|상자|EA|BOX|SET|묶음|포|대|장)?$/i,
    );
    // A bare model number in an unstructured product name is not a quantity.
    const bareSpecification =
      trailing &&
      !trailing[3] &&
      (/모델$|규격$|model$|size$/i.test(trailing[1]) ||
        (tire && !tirePattern.test(trailing[1])));
    if (trailing && !bareSpecification && (label || trailing[3])) {
      result.push({
        name: normalizeItemName(trailing[1]),
        quantity: quantity(trailing[2]) || 0,
      });
      continue;
    }
    let qty = 0;
    if (label && !tire)
      for (let offset = 1; offset <= 3; offset++) {
        const next = lines[index + offset] || "",
          match = next.match(labelPattern(quantityAliases));
        if (match) {
          qty =
            quantity(
              next.slice(match[0].length) || lines[index + offset + 1] || "",
            ) || 0;
          break;
        }
      }
    result.push({ name: normalizeItemName(value), quantity: qty });
  }
  return result;
}
// Infer lost table quantities only when a unique ordered unit-price/amount
// solution satisfies BOTH the receipt's total quantity and its total amount.
function inferQuantities(items: Item[], lines: string[]): boolean {
  if (
    !items.length ||
    items.length > 10 ||
    items.every((item) => item.quantity > 0)
  )
    return false;
  // Unrelated balances, credits and return fees may accidentally satisfy the
  // same arithmetic. Only standalone amounts in a recognizable item table
  // are eligible; arithmetic alone does not establish a column's meaning.
  if (
    !lines.some((line) =>
      /^(?:단가|단가금액|품명.*수량.*단가.*금액)$/.test(compact(line)),
    )
  )
    return false;
  const itemRows = lines.flatMap((line, index) =>
    items.some((item) =>
      compact(normalizeItemName(line.replace(itemLabel, ""))).includes(
        compact(item.name),
      ),
    )
      ? [index]
      : [],
  );
  if (!itemRows.length) return false;
  const firstItem = Math.min(...itemRows),
    lastItem = Math.max(...itemRows);
  const endOffset = lines
    .slice(lastItem + 1)
    .findIndex((line) =>
      /^(?:오늘금액|총금액|총수량|입금계좌|전잔|후잔|잔액|서명|주소|상호|공급자|공급받는자|금액[:：])/.test(
        compact(line),
      ),
    );
  const tableEnd = endOffset < 0 ? lines.length : lastItem + 1 + endOffset;
  const totalQuantities = new Set<number>(),
    totalAmounts = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const key = compact(lines[index]);
    const q = key.match(
      /^(?:총수량|수량합계|합계수량|수량)[:：|]?(\d+(?:\.\d+)?)?$/,
    );
    if (q) {
      const number = quantity(q[1] || lines[index + 1] || "");
      if (number) totalQuantities.add(number);
    }
    if (
      /^(?:오늘금액|총금액|총합계|합계금액|청구금액|합계)[:：|]?$/.test(key)
    ) {
      const money = (lines[index + 1] || "").match(
        /^\s*(\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:원)?$/,
      );
      if (money) totalAmounts.add(Number(money[1].replace(/,/g, "")));
    }
    const inline = key.match(
      /^(?:오늘금액|총금액|총합계|합계금액|청구금액)[:：|]?(\d[\d,]*)원?$/,
    );
    if (inline) totalAmounts.add(Number(inline[1].replace(/,/g, "")));
  }
  if (totalQuantities.size !== 1 || totalAmounts.size !== 1) return false;
  const totalQuantity = [...totalQuantities][0],
    totalAmount = [...totalAmounts][0];
  if (
    !Number.isInteger(totalQuantity) ||
    totalQuantity < items.length ||
    totalQuantity > 1000
  )
    return false;
  const values = lines
    .flatMap((line, index) => {
      if (index <= firstItem || index >= tableEnd || tirePattern.test(line))
        return [];
      const money = line.match(
        /^(\d{1,3}(?:,\d{3})+|\d{4,})\s*(?:원|행사|정)?$/,
      );
      return money
        ? [{ amount: Number(money[1].replace(/,/g, "")), index }]
        : [];
    })
    .filter((entry) => entry.amount > 0 && entry.amount < totalAmount);
  // Receipt text is untrusted and can contain thousands of numbers. These
  // bounds preserve offline responsiveness without accepting a partial search.
  if (values.length > 120) return false;
  const pairs: {
    unit: number;
    amount: number;
    quantity: number;
    unitIndex: number;
    amountIndex: number;
  }[] = [];
  for (const unit of values)
    for (const amount of values) {
      const qty = amount.amount / unit.amount;
      if (
        unit.index !== amount.index &&
        Number.isInteger(qty) &&
        qty >= 1 &&
        qty <= totalQuantity &&
        unit.index < amount.index &&
        !pairs.some(
          (pair) => pair.unit === unit.amount && pair.amount === amount.amount,
        )
      )
        pairs.push({
          unit: unit.amount,
          amount: amount.amount,
          quantity: qty,
          unitIndex: unit.index,
          amountIndex: amount.index,
        });
      if (pairs.length > 120) return false;
    }
  const solutions: (typeof pairs)[] = [];
  let visited = 0,
    exhausted = false;
  function visit(selected: typeof pairs, start: number): void {
    if (solutions.length > 1 || exhausted) return;
    if (++visited > 5000) {
      exhausted = true;
      return;
    }
    if (selected.length === items.length) {
      if (
        selected.reduce((sum, pair) => sum + pair.quantity, 0) ===
          totalQuantity &&
        selected.reduce((sum, pair) => sum + pair.amount, 0) === totalAmount &&
        selected.every(
          (pair, index) =>
            !items[index].quantity || items[index].quantity === pair.quantity,
        )
      )
        solutions.push(selected);
      return;
    }
    for (let i = start; i < pairs.length; i++) {
      const pair = pairs[i],
        last = selected.at(-1);
      if (
        last &&
        (pair.unitIndex <= last.unitIndex ||
          pair.amountIndex <= last.amountIndex)
      )
        continue;
      if (
        selected.some(
          (entry) =>
            entry.unitIndex === pair.amountIndex ||
            entry.amountIndex === pair.unitIndex,
        )
      )
        continue;
      if (
        selected.reduce((sum, entry) => sum + entry.quantity, pair.quantity) >
          totalQuantity ||
        selected.reduce((sum, entry) => sum + entry.amount, pair.amount) >
          totalAmount
      )
        continue;
      visit([...selected, pair], i + 1);
    }
  }
  pairs.sort(
    (a, b) => a.unitIndex - b.unitIndex || a.amountIndex - b.amountIndex,
  );
  visit([], 0);
  if (exhausted || solutions.length !== 1) return false;
  items.forEach((item, index) => {
    if (!item.quantity) item.quantity = solutions[0][index].quantity;
  });
  return true;
}
/** Shared, offline extraction for device previews and server review. */
export function extractReceipt(
  rawText: string,
  layout?: ReceiptLayout,
  context: ReceiptContext = {},
): ReceiptExtraction {
  const lines = rawText
    .slice(0, 50000)
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
  const positions = normalizedLayout(layout);
  const warnings: string[] = [];
  const candidates = (field: Field) =>
    textCandidates(lines, field).concat(
      layoutCandidates(positions.lines, positions.atoms, field),
    );
  const allowed = (entry: Candidate) => entry.role !== "supplier";
  const recipientCandidates = candidates("recipient");
  const supplierNames = new Set(
    recipientCandidates
      .filter((entry) => entry.role === "supplier" && isRecipient(entry.value))
      .map((entry) => companyKey(entry.value)),
  );
  const recipients = recipientCandidates
    .filter(
      (entry) =>
        allowed(entry) &&
        isRecipient(entry.value) &&
        !sameSupplierName(entry.value, context) &&
        !supplierNames.has(companyKey(entry.value)),
    )
    .map((entry) => ({
      ...entry,
      value: cleanRecipient(entry.value),
      score: entry.score + (entry.role === "buyer" ? 50 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  const recipient = recipients[0];
  const addressCandidates = candidates("address");
  const addresses = addressCandidates
    .filter(
      (entry) =>
        allowed(entry) &&
        hasAddress(entry.value) &&
        !sameSupplierAddress(entry.value, context),
    )
    .map((entry) => ({
      ...entry,
      value: normalizeAddress(entry.value),
      score: entry.score + (entry.role === "buyer" ? 50 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  let address = addresses[0]?.value || "";
  // Join a detached numeric tail only when it uniquely closes this address.
  if (address.includes("(") && !address.includes(")")) {
    const tails = lines.filter((line) => /^\d+(?:-\d+)?\)$/.test(line));
    if (
      tails.length === 1 &&
      new Set(
        addresses
          .filter(
            (entry) => entry.value.includes("(") && !entry.value.includes(")"),
          )
          .map((entry) => entry.value),
      ).size === 1
    )
      address += ` ${tails[0]}`;
  }
  const supplierReferences = recipientCandidates
    .filter(
      (entry) =>
        entry.role === "supplier" || sameSupplierName(entry.value, context),
    )
    .concat(
      addressCandidates.filter(
        (entry) =>
          entry.role === "supplier" ||
          sameSupplierAddress(entry.value, context),
      ),
    );
  const buyerReferences = [recipient, addresses[0]].filter(
    (entry): entry is Candidate => Boolean(entry),
  );
  const distance = (phone: Candidate, reference: Candidate) =>
    phone.cell && reference.cell
      ? Math.abs(centerX(phone.cell) - centerX(reference.cell)) * 4 +
        Math.abs(centerY(phone.cell) - centerY(reference.cell))
      : Math.abs(phone.index - reference.index) *
        (reference.index <= phone.index ? 0.65 : 1);
  const phoneCandidates = candidates("phone");
  const phones = phoneCandidates
    .filter(allowed)
    .flatMap((entry) => {
      const buyerDistance = buyerReferences.length
        ? Math.min(
            ...buyerReferences.map((reference) => distance(entry, reference)),
          )
        : Infinity;
      const supplierDistance = supplierReferences.length
        ? Math.min(
            ...supplierReferences.map((reference) =>
              distance(entry, reference),
            ),
          )
        : Infinity;
      if (
        entry.role !== "buyer" &&
        supplierDistance <= buyerDistance &&
        Number.isFinite(supplierDistance)
      )
        return [];
      return (entry.value.match(phonePattern) || []).map((phone) => ({
        ...entry,
        value: cleanPhone(phone),
        score:
          entry.score +
          (entry.role === "buyer" ? 50 : 0) +
          (/^01/.test(phone) ? 5 : 0) +
          (Number.isFinite(buyerDistance)
            ? Math.max(0, 20 - buyerDistance * 2)
            : 0),
      }));
    })
    .sort((a, b) => b.score - a.score);
  const distinctPhones = phones.filter(
    (entry, index) =>
      phones.findIndex((other) => other.value === entry.value) === index,
  );
  const ambiguousPhone =
    distinctPhones.length > 1 &&
    distinctPhones[0].index !== distinctPhones[1].index &&
    Math.abs(distinctPhones[0].score - distinctPhones[1].score) < 1;
  const phone = ambiguousPhone ? "" : phones[0]?.value || "";
  if (
    !phone &&
    phoneCandidates.some((entry) => Boolean(entry.value.match(phonePattern)))
  )
    warnings.push("배송받는 연락처를 확인해 주세요.");
  let items = tableItems(positions.atoms);
  if (!items.length) items = textItems(lines);
  if (inferQuantities(items, lines))
    warnings.push(
      "일부 수량은 단가·금액·총수량이 일치하는 계산으로 채웠습니다. 전표와 확인해 주세요.",
    );
  if (items.some((item) => !item.quantity))
    warnings.push("확인되지 않은 품목 수량을 입력해 주세요.");
  if (!recipient) warnings.push("배송받는 거래처를 확인해 주세요.");
  if (!address) warnings.push("배송받는 주소를 확인해 주세요.");
  if (!items.length) warnings.push("배송 물품을 확인해 주세요.");
  const draft: ShipmentInput = {
    recipient: recipient?.value || "",
    address,
    phone,
    items: items.length ? items : [{ name: "", quantity: 1 }],
    notes: note,
    lat: null,
    lng: null,
  };
  const filledFields: string[] = [];
  if (draft.recipient) filledFields.push("recipient");
  if (draft.address) filledFields.push("address");
  if (draft.phone) filledFields.push("phone");
  if (items.length) filledFields.push("items");
  return { draft, warnings, filledFields };
}
export function parseReceipt(
  rawText: string,
  layout?: ReceiptLayout,
  context?: ReceiptContext,
): ShipmentInput {
  return extractReceipt(rawText, layout, context).draft;
}
