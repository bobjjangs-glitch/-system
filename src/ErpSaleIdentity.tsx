import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { api, koreanDate } from "./api";
import { Button, Field, C, s } from "./ui";
export default function ErpSaleIdentity({
  requestId,
  locked,
  onReady,
}: {
  requestId: string;
  locked: boolean;
  onReady: (ready: boolean) => void;
}) {
  const [context, setContext] = useState<{
      serverDate: string;
      nextReference: string;
      writeEnabled: boolean;
    } | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const cb = useRef(onReady);
  cb.current = onReady;
  useEffect(() => {
    let active = true;
    setError("");
    api<any>("/api/company-erp/sale-context")
      .then((v) => {
        if (active) {
          setContext(v);
          cb.current(v.writeEnabled);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          cb.current(false);
        }
      });
    return () => {
      active = false;
    };
  }, [requestId, refresh]);
  return (
    <View style={{ gap: 6, marginBottom: 14 }}>
      <Field
        label="판매일자 · 오늘 고정"
        value={context?.serverDate ?? koreanDate()}
        onChangeText={() => {}}
        editable={false}
      />
      <Field
        label="판매번호 · ERP 자동 발급"
        value={context?.nextReference ?? "ERP 번호 확인 중"}
        onChangeText={() => {}}
        editable={false}
      />
      <Text style={s.muted}>
        표시된 번호는 예상값입니다. 저장할 때 ERP의 당일 입력 순서로 최종
        발급합니다. 전표는 ERP에 작성중 상태로 저장됩니다.
      </Text>
      {context && !context.writeEnabled && (
        <Text style={{ color: C.amber }}>
          ERP 관리자 연결 설정에서 ‘앱 판매 작성 허용 · 저장소 준비’를 먼저 켜
          주세요.
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: C.red }}>
          {error}
        </Text>
      )}
      {locked && (
        <Text style={{ color: C.amber }}>
          저장을 요청한 전표입니다. 같은 내용으로 저장을 다시 누르면 진행 중인
          저장을 마무리합니다.
        </Text>
      )}
      <Button
        title="판매번호 다시 확인"
        small
        secondary
        onPress={() => setRefresh((x) => x + 1)}
      />
    </View>
  );
}
