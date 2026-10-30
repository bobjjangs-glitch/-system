import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import { API_URL, getSession, SESSION_KEY } from "./api";
import { afterAutomaticDelivery, checkArrival } from "./arrival";
import type { ArrivalLocation, ArrivalState } from "./arrival";
import type { Point, Route } from "../server/types";

const KEY = "bareun-dispatch-driver-automation-v2";
export type DriverAutomation = {
  routeId: string;
  enabled: boolean;
  continuous: boolean;
  segmentEndStopId: string | null;
  notifiedSegment?: string;
  arrival?: ArrivalState;
  lastCompletion?: { sequence: number | null; at: string };
  pendingCompletion?: { stopId: string; point: Point; at: string };
};
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
function serial<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action, action);
  queue = next.catch(() => {});
  return next;
}
export async function getDriverAutomation(): Promise<DriverAutomation | null> {
  try {
    const text =
      Platform.OS === "web"
        ? sessionStorage.getItem(KEY)
        : await SecureStore.getItemAsync(KEY);
    const value = text ? JSON.parse(text) : null;
    return value &&
      typeof value.routeId === "string" &&
      typeof value.enabled === "boolean"
      ? value
      : null;
  } catch {
    return null;
  }
}
async function save(value: DriverAutomation | null) {
  if (Platform.OS === "web") {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } else if (value) await SecureStore.setItemAsync(KEY, JSON.stringify(value));
  else await SecureStore.deleteItemAsync(KEY);
}
export function configureDriverAutomation(
  routeId: string,
  enabled: boolean,
  segment?: { segmentEndStopId: string | null; continuous?: boolean },
) {
  generation++;
  return serial(async () => {
    const old = await getDriverAutomation();
    const value: DriverAutomation = {
      ...(old?.routeId === routeId ? old : {}),
      routeId,
      enabled,
      continuous: segment
        ? (segment.continuous ?? true)
        : old?.routeId === routeId && !!old.continuous,
      segmentEndStopId: segment
        ? segment.segmentEndStopId
        : old?.routeId === routeId
          ? old.segmentEndStopId
          : null,
    };
    if (!enabled) delete value.arrival;
    if (segment) delete value.notifiedSegment;
    await save(value);
    return value;
  });
}
export function recordHandledStop(
  routeId: string,
  stop: import("../server/types").Shipment,
) {
  generation++;
  return serial(async () => {
    const value = await getDriverAutomation();
    if (value?.routeId === routeId) {
      delete value.pendingCompletion;
      value.arrival = afterAutomaticDelivery(
        routeId,
        stop,
        new Date().toISOString(),
      );
      await save(value);
    }
  });
}
export function clearDriverAutomation() {
  generation++;
  return serial(() => save(null));
}

if (Platform.OS !== "web")
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
export async function prepareDrivingNotifications() {
  if (Platform.OS === "web") return true;
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("dispatch-driving", {
      name: "배송 자동 완료와 다음 구간",
      importance: Notifications.AndroidImportance.HIGH,
      sound: null,
      vibrationPattern: [0, 150],
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted
    ? current
    : await Notifications.requestPermissionsAsync();
  return permission.granted;
}
async function notify(
  route: Route,
  stopSequence: number | null,
  continueCourse: boolean,
) {
  if (Platform.OS === "web") return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: continueCourse
        ? "다음 경로 구간을 이어서 안내할 수 있어요"
        : `${stopSequence ?? "현재"}번 배송지 자동 완료`,
      body: continueCourse
        ? "이 알림을 누르면 네이버 내비로 다음 구간을 엽니다."
        : "도착 위치를 확인해 배송 완료로 기록했습니다.",
      sound: false,
      data: continueCourse
        ? { dispatchAction: "continue-course", routeId: route.id }
        : { dispatchAction: "delivery-completed" },
    },
    trigger: { channelId: "dispatch-driving" },
  });
}
async function session(background: boolean) {
  if (!background) {
    const current = getSession();
    return current ? { token: current.token, apiUrl: API_URL } : null;
  }
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value.token === "string" && value.apiUrl === API_URL
      ? value
      : null;
  } catch {
    return null;
  }
}
async function request(
  auth: { token: string; apiUrl: string },
  path: string,
  body?: unknown,
) {
  const controller = new AbortController(),
    timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(auth.apiUrl + path, {
      method: body === undefined ? "GET" : "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + auth.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      json: async () => JSON.parse(text),
    };
  } finally {
    clearTimeout(timeout);
  }
}
export function handleDriverLocation(
  location: ArrivalLocation,
  background = false,
): Promise<{ stop: boolean }> {
  const expectedGeneration = generation;
  return serial(async () => {
    const auth = await session(background);
    if (!auth) return { stop: true };
    const shared = await request(auth, "/api/driver/location", location);
    if ([401, 403, 409].includes(shared.status)) return { stop: true };
    if (!shared.ok) return { stop: false };
    const settings = await getDriverAutomation();
    if (!settings?.enabled) return { stop: false };
    const response = await request(auth, "/api/me");
    if (!response.ok) return { stop: [401, 403].includes(response.status) };
    const { route } = (await response.json()) as { route: Route | null };
    if (!route || !["active", "returning"].includes(route.status))
      return { stop: true };
    if (settings.routeId !== route.id || generation !== expectedGeneration)
      return { stop: false };
    // Reconcile a server update whose HTTP response was lost before evaluating
    // the next stop, so one stationary location cannot complete another order.
    if (settings.pendingCompletion) {
      const pending = settings.pendingCompletion;
      const handled = route.stops.find((stop) => stop.id === pending.stopId);
      if (handled && ["delivered", "failed"].includes(handled.status)) {
        settings.arrival = afterAutomaticDelivery(
          route.id,
          handled,
          pending.at,
          pending.point,
        );
        if (handled.status === "delivered") {
          settings.lastCompletion = {
            sequence: handled.sequence,
            at: pending.at,
          };
          const continueCourse =
            settings.continuous &&
            settings.segmentEndStopId === handled.id &&
            settings.notifiedSegment !== handled.id;
          if (continueCourse) {
            settings.notifiedSegment = handled.id;
            await notify(route, handled.sequence, true).catch(() => {});
          }
        }
        delete settings.pendingCompletion;
      }
    }
    const result = checkArrival(route, location, settings.arrival);
    settings.arrival = result.state;
    if (result.stop && generation === expectedGeneration) {
      settings.pendingCompletion = {
        stopId: result.stop.id,
        point: { lat: location.lat, lng: location.lng },
        at: location.recordedAt,
      };
      await save(settings);
      if (generation !== expectedGeneration) return { stop: false };
      const completed = await request(
        auth,
        "/api/driver/stops/" + result.stop.id + "/complete",
        { status: "delivered" },
      );
      if (completed.ok) {
        const updated = (await completed.json()) as Route;
        settings.arrival = afterAutomaticDelivery(
          route.id,
          result.stop,
          location.recordedAt,
          location,
        );
        settings.lastCompletion = {
          sequence: result.stop.sequence,
          at: location.recordedAt,
        };
        delete settings.pendingCompletion;
        const continueCourse =
          settings.continuous &&
          settings.segmentEndStopId === result.stop.id &&
          settings.notifiedSegment !== result.stop.id;
        if (continueCourse) settings.notifiedSegment = result.stop.id;
        await save(settings);
        await notify(updated, result.stop.sequence, continueCourse).catch(
          () => {},
        );
        return { stop: false };
      }
      if (completed.status === 401 || completed.status === 403)
        return { stop: true };
      if (completed.status === 409) {
        const fresh = await request(auth, "/api/me");
        if (fresh.ok) {
          const current = (await fresh.json()) as { route: Route | null };
          if (
            current.route?.stops.some(
              (stop) =>
                stop.id === result.stop!.id && stop.status === "delivered",
            )
          )
            settings.arrival = afterAutomaticDelivery(
              route.id,
              result.stop,
              location.recordedAt,
              location,
            );
        }
      }
    }
    if (generation === expectedGeneration) await save(settings);
    return { stop: false };
  });
}
