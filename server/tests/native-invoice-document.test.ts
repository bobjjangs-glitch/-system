import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { normalizeSalesDocument } from "../salesDocuments.ts";
import { dispatchBlockReason, documentShipment, invoiceLineTotal, invoiceMoney, invoiceStatus } from "../../src/salesDocuments.ts";
const source = "https://company.example.test/tire/erp/dispatch_api.php", instance = "b".repeat(32), date = "2026-11-06";
const native = () => ({
  id: "129470", reference: "26/11/06-49", saleDate: date, status: "imported", sourceSystem: "native-archive",
  sourceReference: "20261106-49", nativeVersionId: 92301, nativeRevision: 17,
  nativeHeader: { partner_code: "C00001", partner_name: "가상 정비점", staff: "가상 담당자", warehouse: "대전 창고", trade_type: "미확인", currency: "KRW", ceo: "가상 대표", phone: "010-0000-0000", business_no: "0000000000", account: "가상 입금계좌", receivable: "전잔 0 / 후잔 736,000", delivery: "대전광역시 시험로 1", note: "원본 기재 사항" },
  editUrl: "native_trade_edit.php?id=129470", statementUrl: "native_document.php?id=129470&version=92301&print=statement",
  recipient: "가상 정비점", address: "대전광역시 시험로 1", phone: "010-0000-0000", notes: "원본 기재 사항",
  supplyAmount: null as number | null, vatAmount: null as number | null, amount: 736000 as number | null,
  buyer: { name: "가상 정비점", businessNumber: "0000000000" }, supplier: { name: "가상 공급자" },
  items: [{ name: "가상 타이어", code: "TEST-101", quantity: 2 as number | null, unitPrice: null as number | null,
    supplyAmount: null as number | null, vatAmount: null as number | null, totalAmount: 736000 as number | null,
    factoryPrice: 451000, discountRate: null as number | null, discountRateRaw: "48%", vatRate: null as number | null,
    brand: "가상 브랜드", dot: "DOT-TEST", remarks: "행사", nativeFields: { "품명 및 규격": "가상 타이어", "배송메모": "상차 전 연락", "원본 단가": "368,000", "부가세": "" } }],
});
const normalize = (row: unknown, selectedDate = date) => normalizeSalesDocument(row, source, instance, selectedDate);
const invalid = (fn: () => unknown) => assert.throws(fn, (error: any) => error.code === "INVOICE_FORMAT");

test("자체 ERP 보관 전표의 최신 버전·헤더·품목 부가정보와 원본 주소를 보존한다", () => {
  const d = normalize(native());
  assert.equal(d.status, "imported"); assert.equal(invoiceStatus(d.status), "ERP 보관 전표");
  assert.equal(d.nativeVersionId, "92301"); assert.equal(d.nativeRevision, "17");
  assert.equal(d.sourceId, "129470"); assert.equal(d.reference, "26/11/06-49"); assert.equal(d.sourceReference, "20261106-49");
  assert.deepEqual(d.nativeHeader, native().nativeHeader); assert.equal(d.items[0].priceOrigin, "native-erp");
  assert.equal(d.items[0].brand, "가상 브랜드"); assert.equal(d.items[0].dot, "DOT-TEST"); assert.equal(d.items[0].discountRateRaw, "48%");
  assert.equal(d.items[0].nativeFields?.["배송메모"], "상차 전 연락");
  assert.equal(d.editUrl, "https://company.example.test/tire/erp/native_trade_edit.php?id=129470");
  assert.equal(d.statementUrl, "https://company.example.test/tire/erp/native_document.php?id=129470&version=92301&print=statement");
});
test("세율 미확인 단가·공급가액·부가세를 0이나 10%로 바꾸지 않고 알려진 합계로 배송 등록을 허용한다", () => {
  const d = normalize(native()), i = d.items[0];
  assert.equal(i.unitPrice, null); assert.equal(i.supplyAmount, null); assert.equal(i.vatAmount, null); assert.equal(i.vatRate, null);
  assert.equal(i.taxType, undefined); assert.equal(d.vatAmount, null); assert.equal(d.supplyAmount, null); assert.equal(d.amount, 736000);
  assert.equal(d.eligible, true); assert.equal(dispatchBlockReason(d), "");
  assert.equal(invoiceLineTotal(i), 736000); assert.equal(invoiceMoney(i.unitPrice, "확인 필요"), "확인 필요");
  const row = documentShipment(d); assert.equal(row.items[0].totalAmount, 736000); assert.equal(row.amount, 736000);
  assert.equal(row.erpSourceKey, d.sourceKey);
  const missing = normalize({ ...native(), amount: null }); assert.equal(missing.eligible, false); assert.match(missing.reason, /합계/);
});
test("알려진 공급가액만으로 보관 전표의 행 합계나 부가세를 새로 계산하지 않는다", () => {
  const row = native(); row.items[0].supplyAmount = 100000; row.items[0].totalAmount = null;
  const d = normalize(row); assert.equal(invoiceLineTotal(d.items[0]), null); assert.equal(d.items[0].vatAmount, null);
});
test("원본의 명시적 0·저장된 빈 헤더·영세율 0%를 보존하고 원 미만 단가도 저장에서 반올림하지 않는다", () => {
  const row: any = native(); row.nativeHeader.delivery = ""; row.nativeHeader.phone = "";
  row.items[0] = { ...row.items[0], unitPrice: 0, supplyAmount: 0, vatAmount: 0, totalAmount: 0, vatRate: 0, taxType: "taxable" };
  row.amount = 0; row.supplyAmount = 0; row.vatAmount = 0; row.nativeHeader.trade_type = "영세율";
  const d = normalize(row); assert.equal(d.items[0].unitPrice, 0); assert.equal(d.items[0].vatRate, 0); assert.equal(d.items[0].taxType, "taxable");
  assert.equal(d.nativeHeader?.delivery, ""); assert.equal(d.nativeHeader?.phone, ""); assert.equal(d.eligible, true);
  row.items[0].unitPrice = 40909.125; assert.equal(normalize(row).items[0].unitPrice, 40909.125);
});
test("없는 수량을 1로 만들지 않고 확인 필요로 보존하며 반품·빈 거래처/품목은 배차하지 않는다", () => {
  const row = native(); row.items[0].quantity = null; const missing = normalize(row);
  assert.equal(missing.items[0].quantity, 0); assert.equal(missing.items[0].quantityUnknown, true); assert.equal(missing.eligible, false);
  const negative = native(); negative.items[0].unitPrice = -100; assert.equal(normalize(negative).eligible, false);
  assert.equal(normalize({ ...native(), recipient: "" }).eligible, false);
  const unnamed = native(); unnamed.items[0].name = ""; assert.equal(normalize(unnamed).eligible, false);
});
test("네이티브 원본과 과거 ERP의 동일 숫자 ID가 다른 중복 키를 쓰며 과거 키 형식은 유지한다", () => {
  const row = native(), n = normalize(row);
  const legacy: any = { ...row, sourceSystem: undefined, status: "draft", supplyAmount: 10000, vatAmount: 1000, amount: 11000,
    items: [{name: "기존 품목", quantity: 1, taxType: "taxable", unitPrice: 10000, supplyAmount: 10000}] };
  const old = normalize(legacy), expected = "company-sale-" + createHash("sha256").update(JSON.stringify([source,instance,row.id])).digest("hex");
  assert.equal(old.sourceKey, expected); assert.notEqual(n.sourceKey, old.sourceKey);
  legacy.items[0].unitPrice = 10000.5; invalid(() => normalize(legacy));
  invalid(() => normalize({ ...row, sourceSystem: undefined })); invalid(() => normalize({ ...row, status: "confirmed" }));
});
test("원본 일자·표시 번호·보관 식별번호 날짜를 구분하고 날짜가 다른 원본을 덮어쓰지 않는다", () => {
  const row = { ...native(), saleDate: "2026-11-04", reference: "26/11/05-49", sourceReference: "20261106-49" };
  const d = normalize(row); assert.equal(d.saleDate, "2026-11-04"); assert.equal(d.referenceDate, "2026-11-05"); assert.equal(d.sourceReferenceDate, "2026-11-06");
  invalid(() => normalize(row, "2026-11-07"));
});
test("원본 ERP 링크는 같은 ERP의 실제 파일·문서 ID·버전만 허용한다", () => {
  for (const editUrl of ["https://other.example/native_trade_edit.php?id=129470", "//other.example/native_trade_edit.php?id=129470", "javascript:alert(1)", "native_trade_edit.php?id=999", "native_trade_edit.php?id=129470&token=secret", "native_trade_edit.php?id=129470&id=129470", "trade_view.php?id=129470"])
    invalid(() => normalize({ ...native(), editUrl }));
  for (const statementUrl of ["native_document.php?id=129470&version=1&print=statement", "native_document.php?id=129470&version=92301&print=delete"])
    invalid(() => normalize({ ...native(), statementUrl }));
});
test("추가 필드는 문자열 데이터로 제한하고 중첩 값·잘못된 원본 식별자·과도한 필드는 거절한다", () => {
  const row: any = native(); row.items[0].nativeFields = {foo:{nested:true}}; invalid(() => normalize(row));
  row.items[0].nativeFields = JSON.parse('{"__proto__":"unsafe"}'); invalid(() => normalize(row));
  row.items[0].nativeFields = Object.fromEntries(Array.from({length:201},(_,i)=>['field'+i,'x'])); invalid(() => normalize(row));
  invalid(() => normalize({ ...native(), nativeRevision: -1 })); invalid(() => normalize({ ...native(), nativeVersionId: 0 }));
  invalid(() => normalize({ ...native(), nativeHeader: { apiSecret: "not-business-data" } }));
});

test("네이티브 금액 문자열은 십진 원본만 허용하고 빈 값을 0으로 해석하지 않는다", () => {
  const row: any = native(); row.items[0].unitPrice = " 40909.125 "; assert.equal(normalize(row).items[0].unitPrice,40909.125);
  row.items[0].unitPrice = " "; assert.equal(normalize(row).items[0].unitPrice,null);
  for (const value of ["0x100", "1e5", "Infinity", "NaN", "40,909", "1.12345678901"]){row.items[0].unitPrice=value;invalid(()=>normalize(row));}
});

test("실제 편집기에서 저장 가능한 긴 품목 비고와 헤더 메모를 기존 짧은 제한으로 거절하지 않는다", () => {
  const row = native(); row.items[0].remarks = "배송 주의사항 ".repeat(200); row.notes = "기재 사항 ".repeat(500);
  row.nativeHeader.note = row.notes;
  const d = normalize(row); assert.equal(d.items[0].remarks,row.items[0].remarks.trim()); assert.equal(d.notes,row.notes.trim());
  assert.equal(d.nativeHeader?.note,row.notes);
});
