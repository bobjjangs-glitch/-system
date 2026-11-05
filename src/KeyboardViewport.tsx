import React, { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  View,
  type KeyboardEvent,
} from "react-native";
export type KeyboardViewportProps = {
  enabled: boolean;
  children: React.ReactNode;
  onKeyboardShow?: () => void;
  onKeyboardHide?: () => void;
};
export default function KeyboardViewport({
  enabled,
  children,
  onKeyboardShow,
  onKeyboardHide,
}: KeyboardViewportProps) {
  const ref = useRef<View>(null),
    frame = useRef<number | null>(null),
    [height, setHeight] = useState<number | undefined>();
  const show = useRef(onKeyboardShow),
    hide = useRef(onKeyboardHide);
  show.current = onKeyboardShow;
  hide.current = onKeyboardHide;
  const measure = () => {
    if (Platform.OS !== "android") return;
    ref.current?.measureInWindow((_x, top, _w, h) =>
      setHeight(
        frame.current === null
          ? undefined
          : Math.max(100, Math.min(h, frame.current - top - 8)),
      ),
    );
  };
  useEffect(() => {
    if (!enabled) return;
    const a = Keyboard.addListener(
      "keyboardDidShow",
      (event: KeyboardEvent) => {
        frame.current = event.endCoordinates.screenY;
        show.current?.();
        measure();
      },
    );
    const b = Keyboard.addListener("keyboardDidHide", () => {
      frame.current = null;
      setHeight(undefined);
      hide.current?.();
    });
    return () => {
      a.remove();
      b.remove();
    };
  }, [enabled]);
  // Android adjustResize already shrinks the window. Clamp to the keyboard top
  // only when it still overlaps; a second height subtraction hides the PIN field.
  if (!enabled)
    return <View style={{ flex: 1, minHeight: 0 }}>{children}</View>;
  if (Platform.OS === "ios")
    return (
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, minHeight: 0 }}
      >
        {children}
      </KeyboardAvoidingView>
    );
  return (
    <View ref={ref} onLayout={measure} style={{ flex: 1, minHeight: 0 }}>
      <View
        style={
          height === undefined
            ? { flex: 1, minHeight: 0 }
            : { height, minHeight: 0 }
        }
      >
        {children}
      </View>
    </View>
  );
}
