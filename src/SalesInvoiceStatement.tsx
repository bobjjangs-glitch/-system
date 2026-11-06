import InvoiceLineCards, { NativeLineDetails } from "./InvoiceLineCards";
import React from "react";
import { Alert, Linking, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Button, Sheet, C, s } from "./ui";
import {
  invoiceMoney,
  invoiceStatus,
  invoiceLineTotal,
  type SalesDocument,
  type InvoiceParty,
} from "./salesDocuments";
export function InvoicePartyCard({
  title,
  party,
}: {
  title: string;
  party: InvoiceParty;
}) {
  const narrow = useWindowDimensions().width < 720;
  return (
    <View
      style={{
        flex: 1,
        minWidth: narrow ? 0 : 240,
        ...(narrow
          ? { width: "100%" as const, flexBasis: "100%" as const }
          : {}),
        padding: 14,
        borderWidth: 1,
        borderColor: C.line,
        gap: 5,
      }}
    >
      <Text style={s.h3}>{title}</Text>
      {(
        [
          ["상호", party.name],
          ["사업자등록번호", party.businessNumber],
          ["대표자", party.representative],
          ["주소", party.address],
          ["연락처", party.phone],
        ] as const
      ).map(([label, value]) => (
        <Text key={label} selectable style={s.muted}>
          {label} · {value || "ERP 미등록"}
        </Text>
      ))}
    </View>
  );
}
export function InvoiceContents({ doc }: { doc: SalesDocument }) {
  const narrow = useWindowDimensions().width < 720;
  const native = doc.sourceSystem === "native-archive";
  const money = (value: unknown) => invoiceMoney(value, native ? "확인 필요" : "미등록");
  const openSource = (url: string) => Linking.openURL(url).catch(() => {
    Alert.alert("ERP 화면 열기", "브라우저에서 ERP 화면을 열지 못했습니다. 연결 상태와 기본 브라우저를 확인해 주세요.");
  });
  const widths = [46, 75, 120, 230, 130, 80, 110, 120, 120, 150, 120, 80];
  const headings = [
    "No.",
    "월/일",
    "품목코드",
    "품명 및 규격",
    "패턴",
    "수량",
    "단가",
    "금액",
    "합계",
    "적요",
    "공장도가",
    "DC율",
  ];
  const channel =
    doc.channel === "retail"
      ? "소매"
      : doc.channel === "wholesale"
        ? "도매"
        : doc.channel || "미등록";
  const pay =
    (
      {
        cash: "현금",
        card: "카드",
        transfer: "계좌이체",
        credit: "외상",
      } as Record<string, string>
    )[doc.paymentMethod] ?? doc.paymentMethod;
  const computed = doc.items.some(
    (i) => i.priceOrigin !== "native-erp" && i.totalAmount == null && i.supplyAmount != null,
  );
  return (
    <View style={{ gap: 14 }}>
      <Text
        style={[
          s.h2,
          { textAlign: "center", letterSpacing: 3, paddingVertical: 12 },
        ]}
      >
        거래명세서
      </Text>
      <Text selectable style={s.h3}>
        {doc.reference}
      </Text>
      <Text style={s.muted}>
        {doc.saleDate} · {invoiceStatus(doc.status)} · {native ? "자체 ERP 판매" : `판매(${channel})`}
        {pay ? " · " + pay : ""}
      </Text>
      {!!doc.paymentAccount?.id && <Text selectable style={s.muted}>결제 계좌 · {doc.paymentAccount.name || `ERP 계좌 #${doc.paymentAccount.id}`} {doc.paymentAccount.kind ? `(${doc.paymentAccount.kind})` : ""}</Text>}
      {doc.saleDateInferred && (
        <Text style={{ color: C.amber }}>
          ERP 판매일자가 미등록되어 전표번호의 날짜를 표시합니다.
        </Text>
      )}
      {doc.referenceDate && (
        <Text style={{ color: C.amber }}>
          전표번호 날짜 · {doc.referenceDate} / ERP 판매일자 · {doc.saleDate}{" "}
          (ERP 원본 기준)
        </Text>
      )}
      {doc.sourceReferenceDate && doc.sourceReferenceDate !== doc.referenceDate && <Text style={{ color: C.amber }}>
        보관 식별번호 날짜 · {doc.sourceReferenceDate} / ERP 원본 판매일자 · {doc.saleDate}
      </Text>}
      {native && <View style={{ backgroundColor: "#f5f7f5", padding: 14, gap: 7, borderRadius: 12 }}>
        <Text style={s.h3}>ERP 판매 기본 정보</Text>
        <Text selectable style={s.muted}>원본 문서 ID · {doc.sourceId} · 원본 버전 {doc.nativeVersionId} · 수정본 {doc.nativeRevision}</Text>
        <Text selectable style={s.muted}>보관 식별번호 · {doc.sourceReference || "미기재"}</Text>
        {([
          ["partner_code", "거래처코드"], ["partner_name", "판매처 · 고객"], ["staff", "담당자"],
          ["warehouse", "출하창고"], ["trade_type", "거래유형"], ["currency", "통화"], ["ceo", "대표자"],
          ["phone", "전화"], ["business_no", "사업자번호"], ["account", "입금계좌번호"],
          ["receivable", "전잔·후잔"], ["delivery", "배송지"], ["note", "기재 사항"],
        ] as const).map(([key, label]) => <Text key={key} selectable style={[s.muted, { flexShrink: 1 }]}>
          {label} · {doc.nativeHeader?.[key] === "" || doc.nativeHeader?.[key] == null ? "미기재" : doc.nativeHeader[key]}
        </Text>)}
        <Text style={s.muted}>단가·금액·부가세는 ERP 수정 화면의 값을 유지합니다. 확인되지 않은 값은 자동으로 계산하지 않습니다.</Text>
        {!!doc.editUrl && <Button title="ERP 판매 수정 화면 열기" secondary onPress={() => { void openSource(doc.editUrl!); }} />}
        {!!doc.statementUrl && <Button title="ERP 원본 명세서 열기" secondary onPress={() => { void openSource(doc.statementUrl!); }} />}
      </View>}
      {doc.status === "draft" && (
        <Text style={{ color: C.amber }}>
          작성중 전표입니다. ERP 판매 확정·재고 반영은 아직 진행되지 않았습니다.
        </Text>
      )}
      {doc.status === "canceled" && (
        <Text style={{ color: C.red }}>
          취소된 전표 · {doc.cancelReason || "사유 미등록"}
        </Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <InvoicePartyCard title="공급자" party={doc.supplier} />
        <InvoicePartyCard title="공급받는자" party={doc.buyer} />
      </View>
      <View
        style={{
          backgroundColor: "#edf5ef",
          padding: 14,
          gap: 6,
          borderRadius: 12,
        }}
      >
        <Text style={s.h3}>
          배송 나갈 거래처 · {doc.recipient || doc.buyer.name}
        </Text>
        <Text selectable style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
          배송주소 · {(doc.deliveryAddress ?? doc.address) || "미등록"}
        </Text>
        <Text selectable style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
          연락처 · {(doc.deliveryPhone ?? doc.phone) || "미등록"}
        </Text>
        {!!doc.customerCode && (
          <Text style={s.muted}>거래처코드 · {doc.customerCode}</Text>
        )}
        {!!doc.customerName && (
          <Text style={s.muted}>고객명 · {doc.customerName}</Text>
        )}
        {!!doc.vehicleNo && (
          <Text style={s.muted}>차량번호 · {doc.vehicleNo}</Text>
        )}
      </View>
      <Text style={s.muted}>
        {narrow
          ? "품목별 모든 항목을 아래에서 확인하세요."
          : "품목표는 좌우로 밀어 확인하세요."}{" "}
        금액은 공급가액이며 합계는 부가세 포함입니다.
      </Text>
      {narrow ? (
        <InvoiceLineCards items={doc.items} />
      ) : (
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
        >
          <View style={{ borderWidth: 1, borderColor: C.line }}>
            <View style={{ flexDirection: "row", backgroundColor: "#f1f4f6" }}>
              {headings.map((h, i) => (
                <View
                  key={h}
                  style={{
                    width: widths[i],
                    padding: 10,
                    borderRightWidth: 1,
                    borderColor: C.line,
                  }}
                >
                  <Text
                    style={{ fontWeight: "700", fontSize: 12, color: C.ink }}
                  >
                    {h}
                  </Text>
                </View>
              ))}
            </View>
            {doc.items.map((item, i) => {
              const gross = invoiceLineTotal(item);
              const cells = [
                String(i + 1),
                doc.saleDate.slice(5).replace("-", "/"),
                item.code || "—",
                item.name +
                  (item.specification && !item.name.includes(item.specification)
                    ? " " + item.specification
                    : ""),
                item.pattern || "—",
                item.quantityUnknown ? "확인 필요" : item.quantity.toLocaleString("ko-KR", {
                  maximumFractionDigits: native ? 10 : 3,
                }),
                money(item.unitPrice),
                money(item.supplyAmount),
                money(gross),
                item.remarks || "—",
                money(item.factoryPrice),
                item.priceOrigin === "native-erp" && item.discountRateRaw ? item.discountRateRaw : item.discountRate == null ? "미등록" : item.discountRate + "%",
              ];
              return (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    borderTopWidth: 1,
                    borderColor: C.line,
                  }}
                >
                  {cells.map((cell, j) => (
                    <View
                      key={j}
                      style={{
                        width: widths[j],
                        padding: 10,
                        borderRightWidth: 1,
                        borderColor: C.line,
                        justifyContent: "center",
                      }}
                    >
                      <Text
                        selectable
                        accessibilityLabel={`${headings[j]} ${i + 1}`}
                        style={{
                          fontSize: 13,
                          color: C.ink,
                          textAlign: [5, 6, 7, 8, 10, 11].includes(j)
                            ? "right"
                            : "left",
                        }}
                      >
                        {cell}
                      </Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
      {native && !narrow && <View style={{ gap: 12 }}>{doc.items.map((item, i) =>
        <View key={i} style={{ borderWidth: 1, borderColor: C.line, padding: 12, gap: 7 }}>
          <Text style={s.h3}>품목 {i + 1} · ERP 추가 항목</Text><NativeLineDetails item={item} />
        </View>)}</View>}
      {computed && (
        <Text style={s.muted}>
          행 합계는 저장된 공급가액과 과세 구분으로 계산한 참고값입니다. 아래
          전표 합계는 ERP 원본 금액입니다.
        </Text>
      )}
      <View
        style={{ borderWidth: 1, borderColor: C.line, padding: 16, gap: 8 }}
      >
        <Text style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
          총 수량 ·{" "}
          {doc.items.some(i => i.quantityUnknown) ? "확인 필요" : doc.items
            .reduce((n, i) => n + i.quantity, 0)
            .toLocaleString("ko-KR", { maximumFractionDigits: native ? 10 : 3 })}
          {doc.items.some(i => i.quantityUnknown) ? "" : "개"}
        </Text>
        <Text style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
          공급가액 · {money(doc.supplyAmount)}{doc.supplyAmount == null && native ? "" : "원"}
        </Text>
        <Text style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
          부가세 · {money(doc.vatAmount)}{doc.vatAmount == null && native ? "" : "원"}
        </Text>
        <Text accessibilityLabel="명세서 총 합계" style={s.h2}>
          합계 · {money(doc.amount)}{doc.amount == null && native ? "" : "원"}
        </Text>
      </View>
      <Text selectable style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
        전표 적요 · {doc.notes || "없음"}
      </Text>
    </View>
  );
}
export default function SalesInvoiceStatement({
  doc,
  onClose,
  children,
  title = "거래명세서 보기",
}: {
  title?: string;
  doc: SalesDocument | null;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Sheet visible={!!doc} title={title} onClose={onClose}>
      {doc && (
        <>
          <InvoiceContents doc={doc} />
          {children}
        </>
      )}
    </Sheet>
  );
}
