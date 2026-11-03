import React, { useEffect, useMemo, useRef } from "react";
import { View, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
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
  const ref = useRef<WebView>(null);
  const latest = useRef(data);
  latest.current = data;
  const update = () =>
    ref.current?.injectJavaScript(
      `window.updateDispatchMap&&window.updateDispatchMap(${JSON.stringify(latest.current)});true;`,
    );
  useEffect(update, [data]);
  return (
    <View style={[styles.box, fill ? { flex: 1 } : { height }]}>
      <WebView
        ref={ref}
        source={hosted ? { uri: API_URL + "/map?provider=naver&keyId=" + encodeURIComponent(keyId) } : { html: mapHtml, baseUrl: API_URL + "/" }}
        onMessage={(event) => event.nativeEvent.data === "dispatch-map-settings" ? onConfigure?.() : update()}
        onLoadEnd={update}
        javaScriptEnabled
        originWhitelist={["http://*", "https://*"]}
        scrollEnabled={false}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  box: { overflow: "hidden", borderRadius: 20, backgroundColor: "#e8efed" },
});
