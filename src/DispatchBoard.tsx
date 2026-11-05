import React, { useEffect, useMemo, useRef } from "react";
import { WebView } from "react-native-webview";
import { API_URL } from "./api";
import { createDispatchBoardDocument } from "./dispatchBoardDocument";
import type { DispatchBoardProps } from "./dispatchBoardTypes";
export default function DispatchBoard({ data, onDrop }: DispatchBoardProps) {
  const ref = useRef<WebView>(null),
    latest = useRef(data);
  latest.current = data;
  const html = useMemo(createDispatchBoardDocument, []);
  const send = () =>
    ref.current?.injectJavaScript(
      `window.updateDispatchBoard&&window.updateDispatchBoard(${JSON.stringify(latest.current).replace(/</g, "\\u003c")});true;`,
    );
  useEffect(send, [data]);
  return (
    <WebView
      ref={ref}
      source={{ html, baseUrl: API_URL + "/" }}
      style={{ flex: 1, backgroundColor: "#f4f7f3" }}
      originWhitelist={["http://*", "https://*"]}
      scrollEnabled={false}
      onLoadEnd={send}
      onMessage={(event) => {
        try {
          const m = JSON.parse(event.nativeEvent.data);
          if (m.type === "dispatch-board-ready") send();
          else if (m.type === "dispatch-board-drop") onDrop(m.payload);
        } catch {}
      }}
      onShouldStartLoadWithRequest={(request) =>
        request.url === "about:blank" || request.url === API_URL + "/"
      }
    />
  );
}
