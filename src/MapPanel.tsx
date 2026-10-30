import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
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
        source={{ html: mapHtml, baseUrl: API_URL + "/" }}
        onMessage={update}
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
