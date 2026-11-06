import React from "react";
import { Text, View } from "react-native";
import type { Item } from "../server/types";
import { invoiceMoney, invoiceLineTotal } from "./salesDocuments";
import { C, s } from "./ui";
const standardNativeFields = new Set([
  "품목코드", "품명및규격", "패턴", "수량", "공급가액단가", "공급가액",
  "vat포함합계", "공장도가", "dc율", "비고", "브랜드", "규격", "부가세", "dot", "dot코드",
]);
export function NativeLineDetails({ item }: { item: Item }) {
  if (item.priceOrigin !== "native-erp") return null;
  const extra = Object.entries(item.nativeFields ?? {}).filter(([key]) =>
    !standardNativeFields.has(key.replace(/\s+/g, "").toLowerCase()));
  return <View style={{ gap: 5 }}>
    {!!item.brand && <Text selectable style={s.muted}>브랜드 · {item.brand}</Text>}
    <Text selectable style={s.muted}>DOT · {item.dot || "미기재"}</Text>
    <Text selectable style={s.muted}>부가세 · {invoiceMoney(item.vatAmount, "확인 필요")}{item.vatAmount == null ? "" : "원"}</Text>
    <Text selectable style={s.muted}>부가세율 · {item.vatRate == null ? "확인 필요" : item.vatRate + "%"}</Text>
    {extra.map(([label, value]) => <Text key={label} selectable style={[s.muted, { flexShrink: 1 }]}>{label} · {value === "" ? "미기재" : value}</Text>)}
  </View>;
}
export default function InvoiceLineCards({ items }: { items: Item[] }) {
  return (
    <View style={{ gap: 12 }}>
      {items.map((item, index) => {
        const total = invoiceLineTotal(item);
        const native = item.priceOrigin === "native-erp";
        const money = (value: unknown) => invoiceMoney(value, native ? "확인 필요" : "미등록") + (value == null && native ? "" : "원");
        const fields = [
          ["품목코드", item.code || "미등록"],
          ["패턴", item.pattern || "미등록"],
          ["과세 구분", item.taxType === "taxable" ? "과세" : item.taxType === "exempt" ? "면세" : native ? "확인 필요" : "미등록"],
          [
            "수량",
            item.quantityUnknown ? "확인 필요" : item.quantity.toLocaleString("ko-KR", {
              maximumFractionDigits: native ? 10 : 3,
            }) + "개",
          ],
          ["단가", money(item.unitPrice)],
          ["금액", money(item.supplyAmount)],
          ["합계", money(total)],
          ["공장도가", money(item.factoryPrice)],
          [
            "DC율",
            native && item.discountRateRaw ? item.discountRateRaw : item.discountRate == null ? "미등록" : item.discountRate + "%",
          ],
        ];
        return (
          <View
            key={index}
            style={{
              backgroundColor: "white",
              borderWidth: 1,
              borderColor: C.line,
              borderRadius: 12,
              padding: 12,
              gap: 10,
            }}
          >
            <Text style={s.h3}>
              품목 {index + 1} · {item.name}
            </Text>
            {!!item.specification &&
              !item.name.includes(item.specification) && (
                <Text selectable style={s.muted}>
                  규격 · {item.specification}
                </Text>
              )}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {fields.map(([label, value]) => (
                <View
                  key={label}
                  style={{
                    width: "48%",
                    flexGrow: 1,
                    minWidth: 0,
                    gap: 4,
                    paddingVertical: 4,
                  }}
                >
                  <Text style={s.muted}>{label}</Text>
                  <Text
                    selectable
                    accessibilityLabel={`${label} ${index + 1}`}
                    style={{ fontSize: 14, color: C.ink, fontWeight: "600" }}
                  >
                    {value}
                  </Text>
                </View>
              ))}
            </View>
            <Text selectable style={{ color: C.ink, fontSize: 14 }}>
              적요 · {item.remarks || "없음"}
            </Text>
            <NativeLineDetails item={item} />
          </View>
        );
      })}
    </View>
  );
}
