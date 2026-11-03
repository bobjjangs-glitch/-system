import React from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import MapPanel from "./MapPanel";
import { Button, C, s } from "./ui";

export const MAP_ROUTE_COLORS = ["#165b52", "#5b6bbb", "#d38b38", "#ab65a0", "#348bb8", "#8b8d3b"];

export default function AdminMapOverview({ data, visible, onClose, onConfigure, onAllDrivers }: {
  data: any;
  visible: boolean;
  onClose: () => void;
  onConfigure: () => void;
  onAllDrivers?: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={{ padding: 18, gap: 10 }}>
          <View style={s.between}>
            <Text style={s.h2}>네이버 전체 운행 지도</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="전체 운행 지도 닫기" onPress={onClose} style={{ padding: 11 }}>
              <X size={22} color={C.ink} />
            </Pressable>
          </View>
          <Text style={s.muted}>회사 출발 → 모든 배송지 → 회사 복귀 · 기사 현재 위치</Text>
          {onAllDrivers && <Button title="전체 기사 코스 보기" small secondary onPress={onAllDrivers} />}
        </View>
        <View style={{ flex: 1, paddingHorizontal: 14 }}>
          {visible && <MapPanel fill data={data} onConfigure={onConfigure} />}
        </View>
        <View style={{ padding: 18, gap: 12 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={[s.row, { gap: 15 }]}>
              {data.routes.map((route: any) => (
                <View key={route.id} style={[s.row, { gap: 6 }]}>
                  <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: route.color }} />
                  <Text style={s.muted}>{route.driverName} · {route.stops.length}곳</Text>
                </View>
              ))}
            </View>
          </ScrollView>
          <Text style={[s.muted, { fontSize: 11 }]}>
            번호는 배송 순서예요. 완료한 배송지도 표시합니다. 점선은 도로 경로가 아닌 예상 순서이며, 2분 이상 수신하지 못한 기사 위치는 회색으로 표시합니다.
          </Text>
          <Button title="관리자 화면으로 돌아가기" secondary onPress={onClose} />
        </View>
      </SafeAreaView>
    </Modal>
  );
}
