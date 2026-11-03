import { Platform } from "react-native";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import type { Session } from "../server/types";

const browserLocation = typeof window !== "undefined" ? window.location : null;
const devHost = Constants.expoConfig?.hostUri?.split(":")[0] ?? "127.0.0.1";
export const API_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  (Platform.OS === "web" && browserLocation
    ? ["8081", "19006"].includes(browserLocation.port)
      ? `${browserLocation.protocol}//${browserLocation.hostname}:4000`
      : browserLocation.origin
    : `http://${devHost}:4000`)
).replace(/\/$/, "");
export const SESSION_KEY = "bareun-dispatch-session";
export type SavedSession = { token: string; user: Session };
let current: SavedSession | null = null;
let unauthorized = () => {};
export function onUnauthorized(fn: () => void) {
  unauthorized = fn;
}
export function getSession() {
  return current;
}
export async function saveSession(value: SavedSession | null) {
  current = value;
  const text = JSON.stringify(value);
  if (Platform.OS === "web") {
    if (value) sessionStorage.setItem(SESSION_KEY, text);
    else sessionStorage.removeItem(SESSION_KEY);
  } else if (value)
    await SecureStore.setItemAsync(
      SESSION_KEY,
      JSON.stringify({ ...value, apiUrl: API_URL }),
    );
  else await SecureStore.deleteItemAsync(SESSION_KEY);
}
export async function restoreSession(): Promise<SavedSession | null> {
  try {
    const value =
      Platform.OS === "web"
        ? sessionStorage.getItem(SESSION_KEY)
        : await SecureStore.getItemAsync(SESSION_KEY);
    current = value ? JSON.parse(value) : null;
    return current;
  } catch {
    return null;
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(current ? { Authorization: `Bearer ${current.token}` } : {}),
  };
  if (options.body && !(options.body instanceof FormData))
    headers["Content-Type"] = "application/json";
  let response: Response;
  const signal = options.signal ?? AbortSignal.timeout(120000);
  const requestFailure = () => {
    if (!signal.aborted)
      return new Error("서버에 연결할 수 없습니다. 연결 상태를 확인해 주세요.");
    return new Error(
      signal.reason?.name === "TimeoutError"
        ? path === "/api/imports"
          ? "전표 처리 시간이 초과됐습니다. 업로드 내역을 확인한 뒤 다시 시도해 주세요."
          : "서버 응답 시간이 초과됐습니다. 잠시 후 다시 시도해 주세요."
        : "요청이 취소됐습니다. 다시 시도해 주세요.",
    );
  };
  try {
    response = await fetch(API_URL + path, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal,
    });
  } catch {
    throw requestFailure();
  }
  let value;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw requestFailure();
    if (response.ok)
      throw new Error(
        "서버 응답을 읽지 못했습니다. 잠시 후 다시 시도해 주세요.",
      );
    value = {
      error: "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
    };
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") {
      await saveSession(null);
      unauthorized();
    }
    throw new Error(value.error ?? "요청을 처리하지 못했습니다.");
  }
  return value;
}
export const post = <T = any>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T = any>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export function koreanDate() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(
    new Date(),
  );
}
export function connectLive(callback: (event: any) => void) {
  let socket: WebSocket | undefined,
    timer: ReturnType<typeof setTimeout>,
    stopped = false;
  const connect = () => {
    if (!current || stopped) return;
    socket = new WebSocket(API_URL.replace(/^http/, "ws") + "/live");
    socket.onopen = () =>
      socket?.send(JSON.stringify({ type: "auth", token: current?.token }));
    socket.onmessage = (e) => {
      try {
        callback(JSON.parse(e.data));
      } catch {}
    };
    socket.onclose = () => {
      if (!stopped) timer = setTimeout(connect, 4000);
    };
    socket.onerror = () => socket?.close();
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    socket?.close();
  };
}
