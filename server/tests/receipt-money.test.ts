import test from "node:test";
import assert from "node:assert/strict";
import { extractReceipt, type ReceiptLayout } from "../../src/receiptText.ts";
import { receiptWon } from "../../src/receiptMoney.ts";
import { mergeReceiptAutofill } from "../../src/receiptAutofill.ts";
import { calculateInvoiceLine, changeInvoiceNumber, invoiceDisplayTotals } from "../../src/invoiceMath.ts";
const cell=(text:string,x:number,y:number,width=.06)=>({text,x,y,width,height:.02});
const layout = (): ReceiptLayout => ({ width:1000,height:1400,lines:[
 cell("품명",.05,.30,.20),cell("수량",.37,.30),cell("단가",.47,.30),cell("금액",.61,.30),cell("합계",.75,.30),cell("⊙공장도가",.88,.30,.10),
 cell("가상 타이어 235/45R18",.05,.36,.26),cell("2",.38,.36,.02),cell("4O,9O9",.46,.36,.09),cell("81,818",.60,.36,.10),cell("90,000",.74,.36,.10),cell("100,000",.88,.36,.10),
 cell("오늘 금액",.10,.50,.20),cell("90,000",.43,.50,.12),cell("후잔: 9,999,999",.10,.57,.40)
]});
test("OCR 수량·단가·금액·합계·공장도가를 열 위치로 읽고 잔액은 총합계로 쓰지 않는다",()=>{
 const v=layout(),r=extractReceipt(v.lines.map(c=>c.text).reverse().join("\n"),v);
 assert.equal(r.draft.items.length,1);
 assert.deepEqual(r.draft.items[0],{name:"가상 타이어 235/45R18",quantity:2,unitPrice:40909,supplyAmount:81818,totalAmount:90000,factoryPrice:100000,priceOrigin:"ocr"});
 assert.equal(r.draft.amount,90000);assert.ok(!r.warnings.some(s=>/총합계가 다릅니다/.test(s)));
});
test("OCR 금액 불일치는 원본 숫자를 보존해 알리고 계산으로 덮어쓰지 않는다",()=>{
 const v=layout();v.lines.find(c=>c.text==="90,000")!.text="99,000";
 const r=extractReceipt("",v);assert.equal(r.draft.items[0].totalAmount,99000);
 assert.equal(calculateInvoiceLine(r.draft.items[0]).totalAmount,99000);
 assert.ok(r.warnings.some(s=>/금액과 합계/.test(s)));assert.ok(r.warnings.some(s=>/품목 합계/.test(s)));
});
test("인쇄된 단가·합계는 부가세를 임의로 더하지 않으며 운영자가 수정한 뒤에만 재계산한다",()=>{
 const item={name:"검증 타이어",quantity:2,unitPrice:368000,totalAmount:736000,priceOrigin:"ocr" as const};
 assert.deepEqual(calculateInvoiceLine(item),item);
 const changed=changeInvoiceNumber(item,"unitPrice",10000);
 assert.equal(changed.priceOrigin,"manual");assert.equal(changed.supplyAmount,20000);assert.equal(changed.totalAmount,22000);
});
test("사진 자동 채우기·동일 품목 재인식도 금액을 유지하고 수동 입력은 덮어쓰지 않는다",()=>{
 const v=layout(),from=extractReceipt("",v).draft;
 const blank={recipient:"",address:"",items:[{name:"",quantity:1}]};
 const saved=mergeReceiptAutofill([blank],from)[0];assert.deepEqual(saved.items,from.items);assert.equal(saved.amount,90000);
 const entered={...from,amount:123,items:[{...from.items[0],unitPrice:777,supplyAmount:null,totalAmount:333}]};
 const r=mergeReceiptAutofill([entered],from)[0];assert.equal(r.items[0].unitPrice,777);assert.equal(r.items[0].totalAmount,333);assert.equal(r.items[0].supplyAmount,81818);assert.equal(r.amount,123);
});
test("원화 숫자 보정은 숫자 칸에 한정하고 애매한 소수·전화·계좌·문장은 금액으로 만들지 않는다",()=>{
 for(const v of ["40,909","４０，９０９","40.909","4O,9O9"])assert.equal(receiptWon(v),40909);
 for(const v of ["042-123-4567","465501-04-000000","가격 문의","1.5","90,000 80,000","-1000","OIOO"])assert.equal(receiptWon(v),null,v);
});

test("단가·인쇄 합계만 있는 전표도 화면 총합계는 736,000원을 유지하고 미확인 공급가액·부가세를 0원으로 표시하지 않는다",()=>{
 const item={name:"가상 타이어",quantity:2,unitPrice:368000,totalAmount:736000,priceOrigin:"ocr" as const};
 assert.deepEqual(invoiceDisplayTotals([item]),{supply:null,vat:null,total:736000});
 assert.deepEqual(invoiceDisplayTotals([{...item,unitPrice:40909,supplyAmount:81818,totalAmount:90000,taxType:"taxable"}]),{supply:81818,vat:8182,total:90000});
});
