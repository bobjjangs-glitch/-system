import React from "react";
import { Text, View } from "react-native";
import type { Route, Shipment } from "../server/types";
import DeliveryItems from "./DeliveryItems";
import { Button, Sheet, C, s } from "./ui";
export default function DeliveryConfirmations({
  stop,
  route,
  busy,
  error,
  onConfirm,
  onDefer,
  onNavigate,
  onWait,
}: {
  stop: Shipment | null;
  route: Route | null;
  busy: boolean;
  error: string;
  onConfirm: () => void;
  onDefer: () => void;
  onNavigate: () => void;
  onWait: () => void;
}) {
  const next =
    route?.stops.find((item) => item.status === "assigned") ?? route?.company;
  return (
    <>
      <Sheet
        title="배송완료하겠습니까?"
        visible={!!stop}
        onClose={() => {
          if (!busy) onDefer();
        }}
      >
        {stop && (
          <>
            <Text style={s.h2}>{stop.recipient}</Text>
            <Text style={[s.muted, { marginVertical: 12 }]}>
              {stop.address}
            </Text>
            <DeliveryItems items={stop.items} />
            <Text style={[s.muted, { marginVertical: 16 }]}>
              ‘배송 완료’를 누르면 서버에 완료 내역을 저장합니다.
            </Text>
            {!!error && (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginBottom: 12 }}
              >
                {error}
              </Text>
            )}
            <Button
              title={busy ? "배송 완료 저장 중…" : "배송 완료"}
              disabled={busy}
              onPress={onConfirm}
            />
            <View style={{ marginTop: 10 }}>
              <Button
                title="아직 배송 중"
                secondary
                disabled={busy}
                onPress={onDefer}
              />
            </View>
          </>
        )}
      </Sheet>
      <Sheet
        title="다음코스로 이동할까요?"
        visible={!!route && !stop}
        onClose={() => {
          if (!busy) onWait();
        }}
      >
        {route && next && (
          <>
            <Text style={s.h3}>배송 처리 내역을 저장했습니다.</Text>
            <Text style={[s.muted, { marginVertical: 16 }]}>
              {"recipient" in next ? next.recipient : next.name} ·{" "}
              {next.address}
            </Text>
            {route.status === "returning" && (
              <Text style={[s.muted, { marginBottom: 14 }]}>
                모든 배송을 마쳐 회사로 복귀합니다.
              </Text>
            )}
            {!!error && (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginBottom: 12 }}
              >
                {error}
              </Text>
            )}
            <Button
              title="네 · 네이버 길안내"
              disabled={busy}
              onPress={onNavigate}
            />
            <View style={{ marginTop: 10 }}>
              <Button
                title="아니오 · 잠시 대기"
                secondary
                disabled={busy}
                onPress={onWait}
              />
            </View>
          </>
        )}
      </Sheet>
    </>
  );
}
