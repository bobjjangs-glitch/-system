import React, { useEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { API_URL } from "./api";
import { createMapDocument } from "./mapDocument";
export default function MapPanel({
  data,
  height = 280,
  fill = false,
  onConfigure,
}: {
  data: any;
  height?: number;
  fill?: boolean;
  onConfigure?: () => void;
}) {
  const provider = data?.map?.provider;
  const keyId = data?.map?.naverKeyId ?? "";
  const mapHtml = useMemo(() => createMapDocument(API_URL, { provider, naverKeyId: keyId }), [provider, keyId]);
  const hosted = provider === "naver" && /^[A-Za-z0-9_-]{5,128}$/.test(keyId);
  const frameOrigin = hosted ? new URL(API_URL).origin : window.location.origin;
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef(data);
  latest.current = data;
  const send = () =>
    ref.current?.contentWindow?.postMessage(
      { type: "dispatch-map", payload: latest.current },
      frameOrigin,
    );
  useEffect(send, [data]);
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.source === ref.current?.contentWindow &&
        e.origin === frameOrigin
      )
        if (e.data === "dispatch-map-ready") send();
        else if (e.data === "dispatch-map-settings") onConfigure?.();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [frameOrigin, onConfigure]);
  return (
    <View
      style={{
        ...(fill ? { flex: 1 } : { height }),
        borderRadius: 20,
        overflow: "hidden",
        backgroundColor: "#e8efed",
      }}
    >
      <iframe
        title={provider === "naver" ? "네이버 배송 경로와 기사 위치" : "배송 경로와 기사 위치"}
        ref={ref}
        src={hosted ? API_URL + "/map?provider=naver&keyId=" + encodeURIComponent(keyId) : undefined}
        srcDoc={hosted ? undefined : mapHtml}
        onLoad={send}
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    </View>
  );
}
