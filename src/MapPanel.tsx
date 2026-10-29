import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { API_URL } from "./api";
export default function MapPanel({
  data,
  height = 280,
}: {
  data: any;
  height?: number;
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
    <View style={[styles.box, { height }]}>
      <WebView
        ref={ref}
        source={{ uri: API_URL + "/map" }}
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
