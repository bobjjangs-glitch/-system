import ExcelJS from "exceljs";
import { loadSpreadsheet } from "./spreadsheet.ts";
import { createHash } from "node:crypto";
import type { Store } from "./database.ts";
import {
  parseSalesReference,
  readSalesDate,
  validSalesDate,
} from "../src/salesReference.ts";
import type { ShipmentInput } from "./types.ts";

export type CatalogCustomer = {
  id: string;
  code: string;
  name: string;
  address: string;
  phone: string;
  source: string;
};
export type CatalogProduct = {
  id: string;
  code: string;
  name: string;
  specification: string;
  unitPrice: number | null;
  source: string;
};
export class ErpImportError extends Error {
  status = 422;
}
const clean = (value: unknown) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
const key = (value: unknown) =>
  clean(value)
    .replace(/[\s()[\]_:：.\-/]/g, "")
    .toLowerCase();
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const aliases = {
  customerCode: ["거래처코드", "거래처번호", "고객코드", "cust_cd"],
  customer: ["거래처명", "거래처", "상호", "상호명", "고객명", "수령인"],
  address: [
    "배송지주소",
    "배송주소",
    "납품주소",
    "거래처주소",
    "사업장주소",
    "도로명주소",
    "주소1",
    "주소",
  ],
  phone: [
    "배송연락처",
    "휴대전화",
    "휴대폰",
    "전화번호",
    "전화번호1",
    "연락처",
    "전화",
    "tel",
  ],
  productCode: ["품목코드", "품번", "상품코드", "제품코드", "prod_cd"],
  product: ["품목명", "품명", "상품명", "제품명", "품목", "물품명"],
  specification: ["규격", "품목규격", "spec"],
  quantity: ["수량", "판매수량", "출고수량", "qty"],
  unitPrice: ["판매단가", "단가", "기준단가", "unit_price"],
  total: ["합계금액", "판매금액", "총금액", "합계", "총액"],
  net: ["공급가액", "공급금액"],
  vat: ["부가세", "세액", "부가세액"],
  amount: ["금액"],
  document: [
    "일자-no.",
    "일자no",
    "판매일자-no.",
    "전표번호",
    "판매번호",
    "일자-번호",
    "전표일자번호",
  ],
  date: ["판매일자", "전표일자", "일자", "날짜"],
  number: ["no", "번호", "순번"],
  notes: ["배송요청사항", "배송메모", "비고", "적요"],
  currency: ["통화", "통화코드", "currency"],
  state: ["상태", "전표상태"],
};
type Columns = Partial<Record<keyof typeof aliases, number>>;
function cellText(value: any): string {
  if (value && typeof value === "object") {
    if (value.result != null) return cellText(value.result);
    if (value.richText) return value.richText.map((x: any) => x.text).join("");
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return clean(value.text ?? "");
  }
  return clean(value);
}
function number(
  value: string,
  label: string,
  row: number,
  allowBlank = true,
): number | null {
  if (!value && allowBlank) return null;
  const text = value.replace(/[,₩￦원\s]/g, "");
  const result = Number(text);
  if (!text || !Number.isFinite(result) || Math.abs(result) > 1e14)
    throw new ErpImportError(`${row}행 ${label}을 확인해 주세요.`);
  return result;
}
async function table(
  buffer: Buffer,
  fileName: string,
  kind: "customers" | "products" | "sales",
) {
  const book = await loadSpreadsheet(buffer, fileName);
  for (const sheet of book.worksheets) {
    for (let row = 1; row <= Math.min(sheet.rowCount, 30); row++) {
      const cols: Columns = {};
      sheet.getRow(row).eachCell((cell, index) => {
        const header = key(cellText(cell.value));
        for (const [name, names] of Object.entries(aliases))
          if (
            names.some((alias) => key(alias) === header) &&
            cols[name as keyof Columns] === undefined
          )
            cols[name as keyof Columns] = index;
      });
      const found =
        kind === "customers"
          ? cols.customer !== undefined
          : kind === "products"
            ? cols.product !== undefined || cols.productCode !== undefined
            : cols.quantity !== undefined &&
              (cols.product !== undefined || cols.productCode !== undefined) &&
              (cols.customer !== undefined || cols.customerCode !== undefined);
      if (found) return { sheet, cols, header: row };
    }
  }
  throw new ErpImportError(
    kind === "sales"
      ? "판매조회 파일에 거래처(또는 거래처코드), 품목(또는 품목코드), 수량 열이 필요합니다."
      : kind === "customers"
        ? "거래처 목록에 거래처명 열이 필요합니다."
        : "품목 목록에 품목명 또는 품목코드 열이 필요합니다.",
  );
}
function reader(
  sheet: ExcelJS.Worksheet,
  cols: Columns,
  row: number,
  uniqueMoney = false,
) {
  return (name: keyof Columns) => {
    const index = cols[name];
    if (index === undefined) return "";
    const cell = sheet.getCell(row, index);
    if (uniqueMoney && cell.isMerged && Number(cell.master.row) !== row)
      return "";
    return cellText(cell.value);
  };
}
function won(read: ReturnType<typeof reader>, row: number) {
  const cur = read("currency");
  if (cur && !/^(KRW|원|원화|₩|￦)$/i.test(cur))
    throw new ErpImportError(
      `${row}행은 원화가 아닙니다. 원화 금액으로 내보낸 파일을 사용해 주세요.`,
    );
}
export async function importCatalog(
  store: Store,
  buffer: Buffer,
  fileName: string,
  kind: "customers" | "products",
) {
  const { sheet, cols, header } = await table(buffer, fileName, kind);
  const rows: any[] = [];
  for (let i = header + 1; i <= sheet.rowCount; i++) {
    const r = reader(sheet, cols, i);
    const name = r(kind === "customers" ? "customer" : "product");
    const code = r(kind === "customers" ? "customerCode" : "productCode");
    if (!name && !code) continue;
    if (/^(총?합계|소계|계)$/.test(name)) continue;
    if (!name) throw new ErpImportError(`${i}행 이름을 확인해 주세요.`);
    if (name.length > 200 || code.length > 100)
      throw new ErpImportError(`${i}행 코드·이름이 너무 깁니다.`);
    if (kind === "customers") {
      const address = r("address"),
        phone = r("phone");
      if (address.length > 500 || phone.length > 80)
        throw new ErpImportError(`${i}행 주소·연락처를 확인해 주세요.`);
      rows.push({
        id: hash(JSON.stringify(["ecount", code, name, address, phone])),
        code,
        name,
        address,
        phone,
      });
    } else {
      won(r, i);
      const specification = r("specification");
      const unitPrice = number(r("unitPrice"), "단가", i);
      if (unitPrice !== null && unitPrice < 0)
        throw new ErpImportError(`${i}행 단가를 확인해 주세요.`);
      rows.push({
        id: hash(JSON.stringify(["ecount", code, name, specification])),
        code,
        name,
        specification,
        unitPrice,
      });
    }
  }
  if (!rows.length) throw new ErpImportError("가져올 자료가 없습니다.");
  store.transaction(() => {
    // An exported code replaces that code's current catalog entries; existing
    // shipments stay unchanged. Multiple branches in this file remain distinct.
    for (const code of new Set(rows.map((r) => r.code).filter(Boolean)))
      store.run(
        `DELETE FROM ${kind === "customers" ? "catalog_customers" : "catalog_products"} WHERE code=? AND source='ecount'`,
        code,
      );
    for (const r of rows)
      kind === "customers"
        ? store.run(
            "INSERT INTO catalog_customers(id,code,name,address,phone,source,updatedAt) VALUES(?,?,?,?,?,'ecount',?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt",
            r.id,
            r.code,
            r.name,
            r.address,
            r.phone,
            new Date().toISOString(),
          )
        : store.run(
            "INSERT INTO catalog_products(id,code,name,specification,unitPrice,source,updatedAt) VALUES(?,?,?,?,?,'ecount',?) ON CONFLICT(id) DO UPDATE SET unitPrice=excluded.unitPrice,updatedAt=excluded.updatedAt",
            r.id,
            r.code,
            r.name,
            r.specification,
            r.unitPrice,
            new Date().toISOString(),
          );
  });
  return { count: rows.length };
}
export function searchCatalog(
  store: Store,
  kind: "customers" | "products",
  query: string,
) {
  const q = key(query).slice(0, 100);
  const pattern = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
  const tableName =
    kind === "customers" ? "catalog_customers" : "catalog_products";
  let searchExpression = `LOWER(code||name${kind === "products" ? "||specification" : "||address||phone"})`;
  for (const character of [
    " ",
    "(",
    ")",
    "[",
    "]",
    "_",
    ":",
    "：",
    ".",
    "-",
    "/",
    "\t",
    "\n",
  ])
    searchExpression = `REPLACE(${searchExpression},'${character}','')`;
  const rows = store.all(
    `SELECT * FROM ${tableName} AS catalog WHERE ${searchExpression} LIKE ? ESCAPE '\\' ${kind === "products" ? "AND (source!='ecount' OR NOT EXISTS (SELECT 1 FROM catalog_products AS live WHERE live.code=catalog.code AND live.source='ecount-api'))" : ""} ORDER BY (source='ecount-api') DESC,updatedAt DESC LIMIT 50`,
    pattern,
  );
  if (kind === "customers" && rows.length < 30) {
    const recent = store.all(
      "SELECT recipient,address,phone FROM shipments GROUP BY recipient,address,phone ORDER BY MAX(createdAt) DESC LIMIT 1000",
    );
    for (const r of recent) {
      if (!q || key(r.recipient + r.address + r.phone).includes(q)) {
        if (
          !rows.some(
            (x) =>
              x.name === r.recipient &&
              x.address === r.address &&
              x.phone === r.phone,
          )
        )
          rows.push({
            id: "saved-" + hash(JSON.stringify(r)),
            code: "",
            name: r.recipient,
            address: r.address,
            phone: r.phone,
            source: "saved",
          });
      }
      if (rows.length >= 30) break;
    }
  }
  if (kind === "products" && rows.length < 30) {
    for (const r of store.all(
      "SELECT items FROM shipments ORDER BY createdAt DESC LIMIT 300",
    )) {
      for (const item of JSON.parse(r.items)) {
        if (
          (!q || key((item.code ?? "") + item.name).includes(q)) &&
          !rows.some((x) => x.name === item.name)
        )
          rows.push({
            id: "saved-" + hash(item.name),
            code: item.code ?? "",
            name: item.name,
            specification: "",
            unitPrice: null,
            source: "saved",
          });
      }
      if (rows.length >= 30) break;
    }
  }
  return rows.slice(0, 30);
}
/** Include keys used before date normalization so older saved imports still deduplicate. */
export function salesImportKeys(row: ShipmentInput): string[] {
  const parsed = parseSalesReference(row.salesReference),
    customer = row.customerCode || row.recipient;
  const refs = new Set([row.salesReference ?? ""]);
  if (parsed) {
    const [y, m, d] = parsed.date.split("-");
    for (const year of [y, y.slice(2)])
      for (const padded of [true, false])
        for (const sep of ["/", "-", "."])
          refs.add(
            [
              year,
              padded ? m : String(Number(m)),
              padded ? d : String(Number(d)),
            ].join(sep) +
              "-" +
              parsed.sequence,
          );
    refs.add(parsed.canonical);
  }
  return [
    ...new Set([
      ...(row.erpSourceKey ? [row.erpSourceKey] : []),
      ...[...refs]
        .filter(Boolean)
        .map((ref) => "ecount-sale-" + hash(JSON.stringify([ref, customer]))),
    ]),
  ];
}
export function savedManualSale(store: Store, row: ShipmentInput) {
  const parsed = parseSalesReference(row.salesReference);
  if (!parsed) return false;
  return store
    .all(
      "SELECT salesReference,customerCode,recipient FROM shipments WHERE erpSourceKey IS NULL AND salesReference IS NOT NULL",
    )
    .some(
      (previous) =>
        parseSalesReference(previous.salesReference)?.canonical ===
          parsed.canonical &&
        (previous.customerCode && row.customerCode
          ? previous.customerCode === row.customerCode
          : key(previous.recipient) === key(row.recipient)),
    );
}
export async function parseSalesExport(
  store: Store,
  buffer: Buffer,
  fileName: string,
  options: { salesDate?: string } = {},
) {
  if (options.salesDate !== undefined && !validSalesDate(options.salesDate))
    throw new ErpImportError(
      "판매조회 일자를 YYYY-MM-DD 형식으로 확인해 주세요.",
    );
  const { sheet, cols, header } = await table(buffer, fileName, "sales");
  const warnings = new Set<string>();
  const groups = new Map<string, ShipmentInput>();
  const fileHash = hash(buffer.toString("base64"));
  let previousDoc = "",
    previousCustomer = "",
    previousCode = "";
  let skipped = 0,
    otherDateRows = 0,
    undatedRows = 0,
    matchedRows = 0;
  for (let i = header + 1; i <= sheet.rowCount; i++) {
    const r = reader(sheet, cols, i);
    const money = reader(sheet, cols, i, true);
    let name = r("product"),
      code = r("productCode");
    if (!name && !code) continue;
    if (/^(총?합계|소계|계)$/.test(name)) continue;
    let customerCode = r("customerCode"),
      customer = r("customer");
    let doc =
      r("document") ||
      (r("number") ? [r("date"), r("number")].filter(Boolean).join("-") : "");
    if (
      !customer &&
      !customerCode &&
      previousDoc &&
      (!doc ||
        doc === previousDoc ||
        (parseSalesReference(doc)?.canonical ===
          parseSalesReference(previousDoc)?.canonical &&
          !!parseSalesReference(doc)))
    ) {
      customer = previousCustomer;
      customerCode = previousCode;
      doc = previousDoc;
    }

    if (doc) {
      previousDoc = doc;
      previousCustomer = customer;
      previousCode = customerCode;
    } else
      warnings.add(
        "전표번호 열이 없어 동일 파일을 기준으로만 중복을 확인합니다. 판매조회에 일자-No. 또는 전표번호를 포함해 주세요.",
      );
    const dateColumn = readSalesDate(r("date"));
    const documentDate = parseSalesReference(doc);
    if (!documentDate && dateColumn && /^\d{1,12}$/.test(doc))
      doc = dateColumn.replace(/-/g, "/") + "-" + doc;
    const parsedReference = parseSalesReference(doc),
      saleDate = parsedReference?.date ?? dateColumn;
    if (parsedReference) previousDoc = doc;
    if (options.salesDate) {
      if (
        r("document") &&
        /^\d{2,4}[/.\-]\d{1,2}[/.\-]\d{1,2}[-–—]/.test(r("document")) &&
        !parsedReference
      ) {
        undatedRows++;
        continue;
      }
      if (!saleDate) {
        undatedRows++;
        continue;
      }
      if (saleDate !== options.salesDate) {
        otherDateRows++;
        continue;
      }
      if (parsedReference && dateColumn && parsedReference.date !== dateColumn)
        throw new ErpImportError(
          `${i}행 판매번호와 판매일자가 다릅니다. 원본을 확인해 주세요.`,
        );
    }
    matchedRows++;
    if (!customer && !customerCode)
      throw new ErpImportError(`${i}행 거래처를 확인해 주세요.`);
    const q = number(r("quantity"), "수량", i, false)!;
    if (q <= 0 || /취소|반품/.test(r("state"))) {
      skipped++;
      continue;
    }
    won(r, i);
    const matches = customerCode
      ? store.all(
          "SELECT * FROM catalog_customers WHERE code=? AND source='ecount'",
          customerCode,
        )
      : store.all(
          "SELECT * FROM catalog_customers WHERE name=? AND source='ecount'",
          customer,
        );
    const master = matches.length === 1 ? matches[0] : undefined;
    if (!customer && !master?.name)
      warnings.add(
        "거래처명이 없는 전표는 거래처코드를 표시했습니다. 거래처 목록을 가져오거나 이름을 확인해 주세요.",
      );
    customer = customer || master?.name || customerCode;
    const address = r("address") || master?.address || "";
    const phone = r("phone") || master?.phone || "";
    if (!address)
      warnings.add(
        "주소가 없는 전표가 있습니다. 거래처 목록을 불러오거나 검토 화면에서 거래처를 검색해 선택해 주세요.",
      );
    if (!phone)
      warnings.add(
        "연락처가 없는 전표가 있습니다. 거래처 목록 또는 원본과 확인해 주세요.",
      );
    const products = code
      ? store.all(
          "SELECT * FROM catalog_products AS catalog WHERE code=? AND (source='ecount-api' OR (source='ecount' AND NOT EXISTS (SELECT 1 FROM catalog_products AS live WHERE live.code=catalog.code AND live.source='ecount-api')))",
          code,
        )
      : [];
    const product = products.length === 1 ? products[0] : undefined;
    if (!name && !product?.name)
      warnings.add(
        "품목명이 없는 항목은 품목코드를 표시했습니다. 품목 목록을 가져오거나 물품명을 확인해 주세요.",
      );
    name = name || product?.name || code;
    const spec = r("specification") || product?.specification || "";
    if (spec && !name.includes(spec)) name += " " + spec;
    const documentKey = doc
      ? JSON.stringify([
          parseSalesReference(doc)?.canonical ?? doc,
          customerCode || customer,
        ])
      : JSON.stringify([fileHash, i]);
    const sourceKey = "ecount-sale-" + hash(documentKey);
    let draft = groups.get(sourceKey);
    if (!draft) {
      draft = {
        recipient: customer,
        address,
        phone,
        customerCode,
        erpSourceKey: sourceKey,
        salesReference: doc || `파일 ${i}행`,
        items: [],
        amount: null,
        notes: r("notes"),
        lat: null,
        lng: null,
      };
      groups.set(sourceKey, draft);
    }
    if (draft.address && address && draft.address !== address)
      throw new ErpImportError(
        `${i}행은 같은 전표의 배송주소가 다릅니다. 전표를 나눠 확인해 주세요.`,
      );
    if (!draft.address && address) draft.address = address;
    if (!draft.phone && phone) draft.phone = phone;
    draft.items.push({ name, quantity: q, ...(code ? { code } : {}) });
    // Choose one money basis for the entire export. A merged document total
    // must not fall back to a line's net amount on subsequent product rows.
    let amount: number | null = null;
    if (cols.total !== undefined)
      amount = number(money("total"), "합계금액", i);
    else if (cols.amount !== undefined)
      amount = number(money("amount"), "금액", i);
    else {
      const net = number(money("net"), "공급가액", i),
        vat = number(money("vat"), "부가세", i);
      if (net !== null) {
        amount = net + (vat ?? 0);
        if (cols.vat === undefined)
          warnings.add(
            "부가세 열이 없는 금액은 공급가액 기준입니다. 원본과 확인해 주세요.",
          );
      }
    }
    if (amount !== null) {
      if (amount < 0)
        throw new ErpImportError(
          `${i}행 음수 금액은 배송 전표로 가져올 수 없습니다.`,
        );
      draft.amount = Math.round(((draft.amount ?? 0) + amount) * 100) / 100;
    } else if (draft.amount === null)
      warnings.add(
        "금액 열이 없는 전표가 있습니다. 판매조회에 합계금액 열을 포함하거나 검토 화면에서 입력해 주세요.",
      );
  }
  if (skipped)
    warnings.add(
      `취소·반품 또는 수량이 0 이하인 ${skipped}행은 배송 대상에서 제외했습니다.`,
    );
  const drafts = [...groups.values()];
  if (!drafts.length)
    throw new ErpImportError(
      options.salesDate
        ? `${options.salesDate}에 가져올 정상 판매내역이 없습니다. 다른 일자 ${otherDateRows}행·일자 확인 불가 ${undatedRows}행을 제외했습니다. 판매번호 또는 판매일자 열을 확인해 주세요.`
        : "가져올 정상 판매내역이 없습니다.",
    );
  if (options.salesDate)
    warnings.add(
      `판매일자 ${options.salesDate}만 가져왔습니다. 다른 일자 ${otherDateRows}행·일자 확인 불가 ${undatedRows}행은 제외했습니다.`,
    );
  if (drafts.length > 2000)
    throw new ErpImportError(
      "한 번에 최대 2,000개 판매전표를 가져올 수 있습니다.",
    );
  const existing = drafts.filter(
    (row) =>
      salesImportKeys(row).some((key) =>
        store.one(
          "SELECT sourceKey FROM erp_sales_links WHERE sourceKey=?",
          key,
        ),
      ) || savedManualSale(store, row),
  );
  const fresh = drafts.filter((r) => !existing.includes(r));
  if (existing.length)
    warnings.add(`이미 가져온 판매전표 ${existing.length}건은 제외했습니다.`);
  if (!fresh.length)
    throw new ErpImportError(
      "모든 판매전표가 이미 등록되어 있습니다. 중복으로 가져오지 않았습니다.",
    );
  return {
    drafts: fresh,
    warnings: [...warnings],
    salesDate: options.salesDate,
    dateSummary: {
      matchedRows,
      otherDateRows,
      undatedRows,
      duplicateDocuments: existing.length,
    },
  };
}
