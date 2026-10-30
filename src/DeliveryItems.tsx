import React, { useState } from "react";
import { Text, View } from "react-native";
import { Package } from "lucide-react-native";
import type { Item, Shipment } from "../server/types";
import { Button, C, Card, s } from "./ui";

export default function DeliveryItems({
  items,
  compact = false,
}: {
  items: Item[];
  compact?: boolean;
}) {
  return (
    <View style={{ gap: compact ? 4 : 8 }}>
      {!compact && (
        <Text style={[s.label, { marginBottom: 3 }]}>배송 물품 · 수량</Text>
      )}
      {items.map((item, index) => (
        <View
          key={index}
          style={[
            s.between,
            {
              paddingVertical: compact ? 6 : 10,
              paddingHorizontal: compact ? 9 : 12,
              backgroundColor: "#f1f5ef",
              borderRadius: 10,
              alignItems: "flex-start",
            },
          ]}
        >
          <Text
            style={{
              flex: 1,
              color: C.ink,
              fontSize: compact ? 12 : 15,
              lineHeight: compact ? 18 : 22,
            }}
          >
            {item.name}
          </Text>
          <Text
            style={{
              color: C.green,
              fontSize: compact ? 13 : 17,
              fontWeight: "800",
              flexShrink: 0,
            }}
          >
            {item.quantity.toLocaleString("ko-KR")}개
          </Text>
        </View>
      ))}
    </View>
  );
}

export function CargoSummary({ stops }: { stops: Shipment[] }) {
  const [expanded, setExpanded] = useState(false);
  const quantities = new Map<string, number>();
  for (const stop of stops)
    for (const item of stop.items)
      quantities.set(
        item.name,
        (quantities.get(item.name) ?? 0) + item.quantity,
      );
  const items = Array.from(quantities, ([name, quantity]) => ({
    name,
    quantity,
  }));
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <Card>
      <View style={[s.between, { marginBottom: 10 }]}>
        <View style={[s.row, { flex: 1 }]}>
          <Package size={20} color={C.green} />
          <Text style={s.h3}>오늘의 배송 물품</Text>
        </View>
        <Text style={{ color: C.green, fontSize: 20, fontWeight: "800" }}>
          총 {total.toLocaleString("ko-KR")}개
        </Text>
      </View>
      <Text style={[s.muted, { fontSize: 11, marginBottom: 14 }]}>
        전체 {stops.length}곳 · {items.length}종 · 출발 전 상차할 물품을
        확인하세요.
      </Text>
      <DeliveryItems items={expanded ? items : items.slice(0, 3)} compact />
      {items.length > 3 && (
        <View style={{ marginTop: 10 }}>
          <Button
            title={
              expanded ? "물품 목록 접기" : `전체 ${items.length}종 펼치기`
            }
            small
            secondary
            onPress={() => setExpanded(!expanded)}
          />
        </View>
      )}
    </Card>
  );
}
