import React from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import type { Route } from "../server/types";
import MapPanel from "./MapPanel";
import { Button, C, s } from "./ui";

export default function RouteOverview({
  route,
  visible,
  onClose,
}: {
  route: Route;
  visible: boolean;
  onClose: () => void;
}) {
  const next = route.stops.find((stop) => stop.status === "assigned");
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ padding: 18, gap: 10 }}>
          <View style={s.between}>
            <Text style={s.h2}>전체 경로 · 회사 왕복</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="전체 경로 닫기"
              onPress={onClose}
              style={{ padding: 11 }}
            >
              <X size={22} color={C.ink} />
            </Pressable>
          </View>
          <Text style={s.h3}>
            회사 출발 → 배송지 {route.stops.length}곳 → 회사 복귀
          </Text>
          <Text style={s.muted}>
            {route.distanceKm}km · 약 {Math.round(route.durationMinutes)}분 ·
            지도 번호는 배송 순서예요.
          </Text>
        </View>
        <View style={{ flex: 1, paddingHorizontal: 14 }}>
          {visible && (
            <MapPanel
              fill
              data={{
                company: route.company,
                routes: [route],
                drivers: [],
                nextStopId: next?.id,
              }}
            />
          )}
        </View>
        <View style={{ padding: 18, gap: 12 }}>
          <View style={[s.row, { flexWrap: "wrap", gap: 14 }]}>
            {[
              ["#faad65", "출발 / 복귀"],
              ["#2563eb", "다음 배송지"],
              ["#73867e", "배송 완료"],
              ["#b95242", "미배송"],
            ].map(([color, label]) => (
              <View key={label} style={[s.row, { gap: 5 }]}>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: color,
                  }}
                />
                <Text style={[s.muted, { fontSize: 11 }]}>{label}</Text>
              </View>
            ))}
          </View>
          <Text style={[s.muted, { fontSize: 11 }]}>
            {route.estimateSource === "approximate"
              ? "점선은 배송 순서이며 실제 도로 경로가 아니에요."
              : "도로 기준 예상 경로이며 실시간 교통은 반영하지 않아요."}{" "}
            완료한 배송지도 전체 경로에 표시해요.
          </Text>
          <Button title="배송 화면으로 돌아가기" secondary onPress={onClose} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
