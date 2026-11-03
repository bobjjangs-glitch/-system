import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReceipt,
  parseReceipt,
  type ReceiptLayout,
  type ReceiptLayoutLine,
} from "../../src/receiptText.ts";

test("콜론 유무와 줄바꿈·OCR 한글 띄어쓰기와 관계없이 입력란을 채운다", () => {
  const row = parseReceipt(
    "거 래 처\n예시 상사\n배송 주소 대전광역시 동구 예시로 123\n연 락 처\n010-0000-0000\n품 목\n생수\n수 량\n2",
  );
  assert.equal(row.recipient, "예시상사");
  assert.equal(row.address, "대전광역시 동구 예시로 123");
  assert.equal(row.phone, "010-0000-0000");
  assert.deepEqual(row.items, [{ name: "생수", quantity: 2 }]);
  assert.equal(parseReceipt("알 수 없는 전표").address, "");
});

// Synthetic customer, address, account and phone values; the OCR ordering and
// tire specification/amount structure reproduce a printed trade invoice.
const scatteredInvoice = `반품시 공급가액의 10%가 공제됩니다.
▶배송지
기타
결제는 당일 입니다.
전잔: / 후잔 :574,000
입금 계 좌|예시은행
111111-11-111111
(주)예시공급타이어
수량
5
오늘 금액
574,000
서명
인
11/02195/75R 16,12L,113/111M [DH15]
11/02 | 195/70R 15 ,8L,104/102R_CN [밴트라 트랜짓 - RA58C]
134,000
2
171,600
86,000
402,000
172,000행사
135,300
월/일
품명및 규격
수량
단가
합계
적요
O공장도가
금액 :오십칠만사천원 정
(# 574,000)
a 041-000-0000 / 010-0000-0000
203)
주소
(예시동 378)
32910 충청 남도 논산시 연산면 예시로 123 (예시리
급 자
대전광역시 동구 공급로14번길 13
예시카인 테리어(논산연 산)를
상호
(주)예시공급 타이어
거래명세서
공
등록번호
사업자
000-00-00000
일련번호 |2026/11/02 -4
성명
TEL
예시인
1577-0000`;
const supplier = {
  supplierName: "예시공급타이어",
  supplierAddress: "대전 동구 공급로14번길 13",
};

test("블록 순서가 섞인 거래명세서에서 공급자 대신 거래처와 주소·물품을 채운다", () => {
  const result = extractReceipt(scatteredInvoice, undefined, supplier);
  assert.equal(result.draft.recipient, "예시카인테리어(논산연산)");
  assert.equal(
    result.draft.address,
    "충청남도 논산시 연산면 예시로 123 (예시리 203)",
  );
  assert.equal(result.draft.phone, "010-0000-0000");
  assert.deepEqual(result.draft.items, [
    { name: "195/75R16,12L,113/111M[DH15]", quantity: 3 },
    { name: "195/70R15,8L,104/102R_CN[밴트라 트랜짓 - RA58C]", quantity: 2 },
  ]);
  assert.deepEqual(result.filledFields, [
    "recipient",
    "address",
    "phone",
    "items",
  ]);
  assert.match(result.warnings.join(" "), /계산/);
  assert.doesNotMatch(result.draft.address, /공급로|예시동/);
});

test("단가·공장도가를 수량으로 쓰지 않고 금액·총수량 검산 실패 시 수량 확인을 요청한다", () => {
  const result = extractReceipt(
    scatteredInvoice.replace("수량\n5", "수량\n6"),
    undefined,
    supplier,
  );
  assert.equal(result.draft.items.length, 2);
  assert.deepEqual(
    result.draft.items.map((item) => item.quantity),
    [0, 0],
  );
  assert.match(result.warnings.join(" "), /수량을 입력/);
  assert.deepEqual(parseReceipt("품목: 검증모델 R16").items, [
    { name: "검증모델 R16", quantity: 0 },
  ]);
});

test("텍스트 표의 복수 품목을 읽고 열 제목과 합계는 물품으로 넣지 않는다", () => {
  const row = parseReceipt(
    "품명 수량 단가 금액\n생수 2 1,500 3,000\n쌀 3 10,000 30,000\n합계 5 33,000",
  );
  assert.deepEqual(row.items, [
    { name: "생수", quantity: 2 },
    { name: "쌀", quantity: 3 },
  ]);
});

test("같은 규격의 서로 다른 전표 행을 보존하고 라벨 다음 행을 중복 인식하지 않는다", () => {
  const row = parseReceipt(
    "품명 수량 단가 금액\n195/75R16 2 134,000 268,000\n195/75R16 3 134,000 402,000",
  );
  assert.deepEqual(row.items, [
    { name: "195/75R16", quantity: 2 },
    { name: "195/75R16", quantity: 3 },
  ]);
  assert.deepEqual(parseReceipt("품목\n195/75R16 2본").items, [
    { name: "195/75R16", quantity: 2 },
  ]);
  assert.equal(
    parseReceipt("품목: 검증타이어 2\n품목: 검증타이어 3").recipient,
    "",
  );
});

test("모델·타이어 규격 끝의 숫자와 무관한 잔액은 수량으로 추측하지 않는다", () => {
  assert.deepEqual(parseReceipt("품목: 검증모델 16").items, [
    { name: "검증모델 16", quantity: 0 },
  ]);
  assert.deepEqual(parseReceipt("품목: 195/75R 16").items, [
    { name: "195/75R16", quantity: 0 },
  ]);
  const unrelated =
    "품목: 검증상품A\n품목: 검증상품B\n총수량: 5\n오늘금액: 110000\n전잔 10000\n반품금액 20000\n공장도가 30000\n외상 90000";
  assert.deepEqual(
    parseReceipt(unrelated).items.map((item) => item.quantity),
    [0, 0],
  );
});

test("공급자 휴대폰이 앞에 있어도 배송받는 거래처 가까이의 유선 연락처를 채운다", () => {
  const row = parseReceipt(
    "상호: 예시공급타이어\n주소: 대전 동구 공급로 10\n전화: 010-0000-1111\n상호: 예시고객카센터\n주소: 충청남도 논산시 고객로 99\n전화: 041-000-2222\n품목: 타이어 2",
    undefined,
    { supplierName: "예시공급타이어", supplierAddress: "대전 동구 공급로 10" },
  );
  assert.equal(row.recipient, "예시고객카센터");
  assert.equal(row.phone, "041-000-2222");
});

test("숫자가 지나치게 많은 OCR은 수량 계산을 중단하고 확인을 요청한다", () => {
  const crowded = scatteredInvoice.replace(
    "\n134,000\n",
    `\n${Array.from({ length: 200 }, (_, index) => 1000 + index * 100).join("\n")}\n134,000\n`,
  );
  const result = extractReceipt(crowded, undefined, supplier);
  assert.deepEqual(
    result.draft.items.map((item) => item.quantity),
    [0, 0],
  );
  assert.match(result.warnings.join(" "), /수량을 입력/);
});

function cell(
  text: string,
  x: number,
  y: number,
  width = 0.09,
): ReceiptLayoutLine {
  return { text, x, y, width, height: 0.02 };
}
function tableLayout(): ReceiptLayout {
  return {
    width: 1000,
    height: 1400,
    lines: [
      cell("품명", 0.05, 0.35, 0.24),
      cell("규격", 0.4, 0.35),
      cell("수량", 0.65, 0.35, 0.04),
      cell("단가", 0.78, 0.35, 0.06),
      cell("금액", 0.9, 0.35, 0.07),
      cell("검증타이어", 0.05, 0.42, 0.24),
      cell("215/55R17", 0.4, 0.42, 0.16),
      cell("4", 0.65, 0.42, 0.03),
      cell("90,000", 0.78, 0.42),
      cell("360,000", 0.9, 0.42),
      cell("겨울타이어", 0.05, 0.46, 0.24),
      cell("195/65R15", 0.4, 0.46, 0.16),
      cell("2", 0.65, 0.46, 0.03),
      cell("80,000", 0.78, 0.46),
      cell("160,000", 0.9, 0.46),
      cell("총수량", 0.05, 0.52, 0.12),
      cell("6", 0.65, 0.52, 0.03),
    ],
  };
}
test("위치 좌표로 품명·규격·수량 열을 묶고 가격과 합계를 제외한다", () => {
  const row = parseReceipt(
    "215/55R17\n검증타이어\n90,000\n360,000\n4",
    tableLayout(),
  );
  assert.deepEqual(row.items, [
    { name: "검증타이어 215/55R17", quantity: 4 },
    { name: "겨울타이어 195/65R15", quantity: 2 },
  ]);
  const absolute = tableLayout();
  absolute.lines = absolute.lines.map((line) => ({
    ...line,
    x: line.x * 1000,
    width: line.width * 1000,
    y: line.y * 1400,
    height: line.height * 1400,
  }));
  assert.deepEqual(parseReceipt("", absolute).items, row.items);
});

test("같은 줄에 나란히 인쇄된 공급자와 공급받는자의 이름·주소·전화는 열 위치로 구별한다", () => {
  const layout: ReceiptLayout = {
    lines: [
      cell("공급자", 0.04, 0.05, 0.1),
      cell("공급받는자", 0.53, 0.05, 0.14),
      cell("상호", 0.04, 0.1, 0.06),
      cell("예시공급사", 0.12, 0.1, 0.2),
      cell("상호", 0.53, 0.1, 0.06),
      cell("예시구매상사", 0.61, 0.1, 0.28),
      cell("주소", 0.04, 0.14, 0.06),
      cell("대전 동구 공급로 10", 0.12, 0.14, 0.33),
      cell("주소", 0.53, 0.14, 0.06),
      cell("충청남도 논산시 예시로 123", 0.61, 0.14, 0.38),
      cell("전화", 0.04, 0.18, 0.06),
      cell("042-000-0000", 0.12, 0.18, 0.22),
      cell("전화", 0.53, 0.18, 0.06),
      cell("041-000-0000", 0.61, 0.18, 0.22),
    ],
  };
  const row = parseReceipt("상호\n예시공급사\n상호\n예시구매상사", layout);
  assert.equal(row.recipient, "예시구매상사");
  assert.equal(row.address, "충청남도 논산시 예시로 123");
  assert.equal(row.phone, "041-000-0000");
});

test("네이티브 단어 좌표가 제공되면 한 줄 안에서도 수량 열을 읽는다", () => {
  const layout: ReceiptLayout = {
    lines: [
      {
        ...cell("품명 규격 수량 단가 금액", 0.05, 0.35, 0.9),
        elements: tableLayout().lines.slice(0, 5),
      },
      {
        ...cell("검증타이어 215/55R17 4 90,000 360,000", 0.05, 0.42, 0.9),
        elements: tableLayout().lines.slice(5, 10),
      },
    ],
  };
  assert.deepEqual(parseReceipt("", layout).items, [
    { name: "검증타이어 215/55R17", quantity: 4 },
  ]);
});
