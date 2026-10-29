import React, { useEffect, useRef } from "react";
import { View } from "react-native";
import { API_URL } from "./api";
export default function MapPanel({
  data,
  height = 280,
}: {
  data: any;
  height?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef(data);
  latest.current = data;
  const send = () =>
    ref.current?.contentWindow?.postMessage(
      { type: "dispatch-map", payload: latest.current },
      new URL(API_URL).origin,
    );
  useEffect(send, [data]);
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.origin === new URL(API_URL).origin &&
        e.data === "dispatch-map-ready"
      )
        send();
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);
  return (
    <View
      style={{
        height,
        borderRadius: 20,
        overflow: "hidden",
        backgroundColor: "#e8efed",
      }}
    >
      <iframe
        title="배송 경로와 기사 위치"
        ref={ref}
        src={API_URL + "/map"}
        onLoad={send}
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    </View>
  );
}
