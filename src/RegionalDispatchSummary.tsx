import React from "react";
import { Pressable, Text, View } from "react-native";
import type { Shipment } from "../server/types";
import { deliveryRegionGroups } from "./deliveryRegion";
import { Card, C, s } from "./ui";
export default function RegionalDispatchSummary({
  shipments,
  selected,
  onSelect,
}: {
  shipments: Shipment[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const groups = deliveryRegionGroups(
    shipments.filter((row) => row.status === "pending"),
  );
  if (!groups.length) return null;
  return (
    <Card>
      <Text style={s.h3}>지역별 미배차 배송지</Text>
      <Text style={[s.muted, { marginTop: 6, marginBottom: 12 }]}>
        배송주소의 구·시·군 기준입니다. 지역을 눌러 배송지를 확인하세요.
      </Text>
      <View style={[s.row, { flexWrap: "wrap" }]}>
        {[
          {
            key: "all",
            label: "전체",
            count: groups.reduce((n, g) => n + g.shipments.length, 0),
          },
          ...groups.map((g) => ({ ...g, count: g.shipments.length })),
        ].map((g) => (
          <Pressable
            key={g.key}
            accessibilityRole="button"
            accessibilityLabel={`${g.label} 미배차 ${g.count}곳`}
            accessibilityState={{ selected: selected === g.key }}
            onPress={() => onSelect(g.key)}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 10,
              borderRadius: 12,
              backgroundColor: selected === g.key ? C.green : "#edf3e8",
              marginBottom: 5,
            }}
          >
            <Text
              style={{
                fontSize: 12,
                fontWeight: "700",
                color: selected === g.key ? "white" : C.green,
              }}
            >
              {g.label} {g.count}곳
            </Text>
          </Pressable>
        ))}
      </View>
      {groups.some((g) => g.key === "unknown") && (
        <Text style={[s.muted, { marginTop: 8 }]}>
          지역 확인 필요 항목은 시·도와 구·시·군을 포함한 주소인지 확인해
          주세요.
        </Text>
      )}
    </Card>
  );
}
