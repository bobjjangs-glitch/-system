import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { KeyboardViewportProps } from "./KeyboardViewport";

type VisibleViewport = { height: number; top: number };

export default function KeyboardViewport({
  enabled,
  children,
  onKeyboardShow,
  onKeyboardHide,
}: KeyboardViewportProps) {
  const container = useRef<View>(null);
  const showCallback = useRef(onKeyboardShow);
  showCallback.current = onKeyboardShow;
  const hideCallback = useRef(onKeyboardHide);
  hideCallback.current = onKeyboardHide;
  const [visible, setVisible] = useState<VisibleViewport | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const viewport = window.visualViewport;
    let frame = 0;
    let width = window.innerWidth;
    let fullHeight = Math.max(window.innerHeight, viewport?.height ?? 0);
    let keyboardVisible = false;

    const revealInput = () => {
      const focused = document.activeElement;
      const element = container.current as unknown as HTMLElement | null;
      if (
        focused instanceof HTMLElement &&
        element?.contains(focused) &&
        focused.matches("input,textarea,[contenteditable='true']")
      ) {
        focused.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };

    const update = () => {
      // Pinch zoom changes visualViewport too; keep the last unzoomed layout.
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height ?? window.innerHeight;
      if (Math.abs(window.innerWidth - width) > 80) {
        width = window.innerWidth;
        fullHeight = Math.max(window.innerHeight, height);
      } else {
        fullHeight = Math.max(fullHeight, window.innerHeight, height);
      }
      const top = Math.max(0, viewport?.offsetTop ?? 0);
      setVisible((current) =>
        current?.height === height && current.top === top
          ? current
          : { height, top },
      );

      const hiddenHeight = fullHeight - height;
      const focused = document.activeElement;
      if (
        hiddenHeight > 120 &&
        focused instanceof HTMLElement &&
        focused.matches("input,textarea,[contenteditable='true']")
      ) {
        if (!keyboardVisible) showCallback.current?.();
        keyboardVisible = true;
      } else if (keyboardVisible && hiddenHeight < 100) {
        keyboardVisible = false;
        hideCallback.current?.();
      }

      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(revealInput);
      });
    };

    update();
    const element = container.current as unknown as HTMLElement | null;
    element?.addEventListener("focusin", update, true);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      element?.removeEventListener("focusin", update, true);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return (
    <View
      ref={container}
      style={
        enabled && visible
          ? {
              position: "absolute",
              left: 0,
              right: 0,
              top: visible.top,
              height: visible.height,
              minHeight: 0,
              overflow: "hidden",
            }
          : { flex: 1, minHeight: 0 }
      }
    >
      {children}
    </View>
  );
}
