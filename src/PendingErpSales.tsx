import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, C, s } from "./ui";
export default function PendingErpSales({
  refreshKey,
  onResume,
}: {
  refreshKey: string;
  onResume: (id: string) => void;
}) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<any[]>("/api/company-erp/sale-requests")
        .then((v) => {
          if (active) setRows(v);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refreshKey]);
  if (!rows.length) return null;
  return (
    <Card>
      <Text style={s.h3}>마무리할 ERP 판매 저장 {rows.length}건</Text>
      <Text style={[s.muted, { marginVertical: 10 }]}>
        연결이 끊겼던 저장 건입니다. 같은 전표로 이어서 처리해 중복을 막습니다.
      </Text>
      {rows.map((row) => (
        <View key={row.id} style={{ gap: 8, marginBottom: 14 }}>
          <Text style={s.h3}>
            {row.recipient} {row.reference ?? ""}
          </Text>
          {!!row.error && <Text style={{ color: C.amber }}>{row.error}</Text>}
          <Button
            title="이 전표 저장 마무리"
            secondary
            onPress={() => onResume(row.id)}
          />
        </View>
      ))}
    </Card>
  );
}
