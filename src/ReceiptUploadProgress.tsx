import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Button, C, s } from "./ui";

export default function ReceiptUploadProgress({
  phase,
  startedAt,
  onCancel,
}: {
  phase: string;
  startedAt: number;
  onCancel: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const update = () =>
      setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`전표 처리: ${phase}`}
      style={{
        padding: 14,
        backgroundColor: "#eaf4e8",
        borderBottomWidth: 1,
        borderBottomColor: C.line,
      }}
    >
      <View style={s.row}>
        <ActivityIndicator size="small" color={C.green} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.green, fontWeight: "700", fontSize: 14 }}>
            {phase}
          </Text>
          <Text style={[s.muted, { fontSize: 11, marginTop: 4 }]}>
            경과 {seconds}초 · 완료되면 확인 화면이 열려요
          </Text>
        </View>
        <Button title="전표 처리 취소" secondary small onPress={onCancel} />
      </View>
    </View>
  );
}
