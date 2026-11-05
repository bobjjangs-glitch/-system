import React from "react";
import { Modal, Text, View, Pressable, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import DispatchBoard from "./DispatchBoard";
import { C, s } from "./ui";
import type { DispatchBoardProps } from "./dispatchBoardTypes";
export default function DispatchBoardScreen({
  visible,
  data,
  onDrop,
  onClose,
}: { visible: boolean; onClose: () => void } & DispatchBoardProps) {
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <View
          style={[
            s.between,
            { padding: 18, borderBottomWidth: 1, borderBottomColor: C.line },
          ]}
        >
          <View>
            <Text style={s.h2}>터치로 배차하기</Text>
            <Text style={s.muted}>
              {data.serviceDate} · 회사 출발·복귀 포함
            </Text>
          </View>
          {data.busy ? (
            <ActivityIndicator color={C.green} />
          ) : (
            <Pressable
              accessibilityLabel="터치 배차 닫기"
              onPress={onClose}
              style={{ padding: 12 }}
            >
              <X color={C.ink} />
            </Pressable>
          )}
        </View>
        <DispatchBoard data={data} onDrop={onDrop} />
      </SafeAreaView>
    </Modal>
  );
}
