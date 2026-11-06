import React from "react";
import { Text, View } from "react-native";
import type { Item } from "../server/types";
import { invoiceMoney } from "./salesDocuments";
import { C, s } from "./ui";
export default function InvoiceLineCards({ items }: { items: Item[] }) {
  return (
    <View style={{ gap: 12 }}>
      {items.map((item, index) => {
        const total =
          item.totalAmount ??
          (item.supplyAmount == null
            ? null
            : item.supplyAmount +
              (item.taxType === "exempt"
                ? 0
                : Math.round(item.supplyAmount / 10)));
        const fields = [
          ["품목코드", item.code || "미등록"],
          ["패턴", item.pattern || "미등록"],
          ["과세 구분", item.taxType === "taxable" ? "과세" : item.taxType === "exempt" ? "면세" : "미등록"],
          [
            "수량",
            item.quantity.toLocaleString("ko-KR", {
              maximumFractionDigits: 3,
            }) + "개",
          ],
          ["단가", invoiceMoney(item.unitPrice) + "원"],
          ["금액", invoiceMoney(item.supplyAmount) + "원"],
          ["합계", invoiceMoney(total) + "원"],
          ["공장도가", invoiceMoney(item.factoryPrice) + "원"],
          [
            "DC율",
            item.discountRate == null ? "미등록" : item.discountRate + "%",
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
          </View>
        );
      })}
    </View>
  );
}
