import React, { useEffect, useRef } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, View } from "react-native";

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
  const showCallback = useRef(onKeyboardShow);
  showCallback.current = onKeyboardShow;
  const hideCallback = useRef(onKeyboardHide);
  hideCallback.current = onKeyboardHide;

  useEffect(() => {
    if (!enabled) return;
    const showSubscription = Keyboard.addListener("keyboardDidShow", () => {
      showCallback.current?.();
    });
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => {
      hideCallback.current?.();
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [enabled]);

  if (!enabled)
    return <View style={{ flex: 1, minHeight: 0 }}>{children}</View>;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, minHeight: 0 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
