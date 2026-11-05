import React, { useEffect, useMemo, useRef } from "react";
import { createDispatchBoardDocument } from "./dispatchBoardDocument";
import type { DispatchBoardProps } from "./dispatchBoardTypes";
export default function DispatchBoard({ data, onDrop }: DispatchBoardProps) {
  const ref = useRef<HTMLIFrameElement>(null),
    latest = useRef(data);
  latest.current = data;
  const html = useMemo(createDispatchBoardDocument, []),
    origin = window.location.origin;
  const send = () =>
    ref.current?.contentWindow?.postMessage(
      { type: "dispatch-board-data", payload: latest.current },
      origin,
    );
  useEffect(send, [data]);
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || e.origin !== origin)
        return;
      if (e.data?.type === "dispatch-board-ready") send();
      else if (e.data?.type === "dispatch-board-drop") onDrop(e.data.payload);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [origin, onDrop]);
  return (
    <iframe
      title="기사별 터치 배차"
      ref={ref}
      srcDoc={html}
      onLoad={send}
      style={{ border: 0, width: "100%", height: "100%", flex: 1 }}
    />
  );
}
