import React, { useEffect, useRef } from "react";
import { View } from "react-native";
import { API_URL } from "./api";
import { createMapDocument } from "./mapDocument";
const mapHtml = createMapDocument(API_URL);
export default function MapPanel({
  data,
  height = 280,
  fill = false,
}: {
  data: any;
  height?: number;
  fill?: boolean;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const latest = useRef(data);
  latest.current = data;
  const send = () =>
    ref.current?.contentWindow?.postMessage(
      { type: "dispatch-map", payload: latest.current },
      window.location.origin,
    );
  useEffect(send, [data]);
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.source === ref.current?.contentWindow &&
        e.origin === window.location.origin &&
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
        ...(fill ? { flex: 1 } : { height }),
        borderRadius: 20,
        overflow: "hidden",
        backgroundColor: "#e8efed",
      }}
    >
      <iframe
        title="배송 경로와 기사 위치"
        ref={ref}
        srcDoc={mapHtml}
        onLoad={send}
        style={{ border: 0, width: "100%", height: "100%" }}
      />
    </View>
  );
}
