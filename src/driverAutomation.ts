import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import { API_URL, getSession, SESSION_KEY } from "./api";
import { afterAutomaticDelivery, checkArrival } from "./arrival";
import type { ArrivalLocation, ArrivalState } from "./arrival";
import type { Point, Route, Shipment } from "../server/types";

const KEY = "bareun-dispatch-driver-automation-v2";
export type DriverAutomation = {
  routeId: string;
  enabled: boolean;
  continuous: boolean;
  segmentEndStopId: string | null;
  arrival?: ArrivalState;
  lastCompletion?: { sequence: number | null; at: string; status?: string };
  pendingCompletion?: { stopId: string; point: Point; at: string };
  pendingArrival?: {
    stopId: string;
    point: Point;
    at: string;
    notified?: boolean;
  };
  pendingNavigation?: { completedStopId: string; at: string };
  dismissedUntil?: number;
};
let queue: Promise<unknown> = Promise.resolve(),
  generation = 0;
const listeners = new Set<() => void>();
export function subscribeDriverArrival(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function signalDriverArrival() {
  for (const listener of listeners) listener();
}
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
          : await SecureStore.getItemAsync(KEY),
      value = text ? JSON.parse(text) : null;
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
function dismissNotice(stopId?: string) {
  if (Platform.OS !== "web" && stopId)
    void Notifications.dismissNotificationAsync(
      "dispatch-arrival-" + stopId,
    ).catch(() => {});
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
    if (!enabled) {
      dismissNotice(value.pendingArrival?.stopId);
      delete value.arrival;
      delete value.pendingArrival;
    }
    await save(value);
    signalDriverArrival();
    return value;
  });
}
export function recordHandledStop(routeId: string, stop: Shipment) {
  generation++;
  return serial(async () => {
    let value = await getDriverAutomation();
    if (value?.routeId !== routeId)
      value = {
        routeId,
        enabled: true,
        continuous: false,
        segmentEndStopId: null,
      };
    dismissNotice(value.pendingArrival?.stopId);
    delete value.pendingCompletion;
    delete value.pendingArrival;
    delete value.dismissedUntil;
    const at = new Date().toISOString();
    value.arrival = afterAutomaticDelivery(routeId, stop, at);
    value.lastCompletion = { sequence: stop.sequence, at, status: stop.status };
    value.pendingNavigation = { completedStopId: stop.id, at };
    await save(value);
    signalDriverArrival();
  });
}
export function dismissDriverArrival(routeId: string, stopId: string) {
  generation++;
  return serial(async () => {
    const value = await getDriverAutomation();
    if (value?.routeId === routeId && value.pendingArrival?.stopId === stopId) {
      delete value.pendingArrival;
      value.dismissedUntil = Date.now() + 120000;
      await save(value);
      dismissNotice(stopId);
      signalDriverArrival();
    }
  });
}
export function clearPendingNavigation(routeId: string) {
  return serial(async () => {
    const value = await getDriverAutomation();
    if (value?.routeId === routeId) {
      delete value.pendingNavigation;
      await save(value);
      signalDriverArrival();
    }
  });
}
export function clearDriverAutomation() {
  generation++;
  return serial(async () => {
    const value = await getDriverAutomation();
    dismissNotice(value?.pendingArrival?.stopId);
    await save(null);
    signalDriverArrival();
  });
}

if (Platform.OS !== "web")
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
export async function prepareDrivingNotifications() {
  if (Platform.OS === "web") return true;
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("dispatch-arrival-v1", {
      name: "배송지 도착 확인",
      importance: Notifications.AndroidImportance.HIGH,
      sound: "default",
      vibrationPattern: [0, 200, 100, 200],
    });
  await Notifications.setNotificationCategoryAsync("dispatch-arrival-review", [
    {
      identifier: "review-arrival",
      buttonTitle: "배송 완료 확인",
      options: { opensAppToForeground: true },
    },
  ]);
  const current = await Notifications.getPermissionsAsync();
  return (
    current.granted ? current : await Notifications.requestPermissionsAsync()
  ).granted;
}
async function notifyArrival(route: Route, stop: Shipment) {
  if (Platform.OS === "web" || AppState.currentState === "active") return false;
  if (!(await Notifications.getPermissionsAsync()).granted) return false;
  await Notifications.scheduleNotificationAsync({
    identifier: "dispatch-arrival-" + stop.id,
    content: {
      title: "배송지에 도착했습니다",
      body:
        stop.recipient + " · 배송완료하겠습니까? 알림을 눌러 확인해 주세요.",
      sound: "default",
      categoryIdentifier: "dispatch-arrival-review",
      data: {
        dispatchAction: "confirm-arrival",
        routeId: route.id,
        stopId: stop.id,
      },
    },
    trigger: { channelId: "dispatch-arrival-v1" },
  });
  return true;
}
async function session(background: boolean) {
  if (!background) {
    const current = getSession();
    return current ? { token: current.token, apiUrl: API_URL } : null;
  }
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY),
      value = raw ? JSON.parse(raw) : null;
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
    timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(auth.apiUrl + path, {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + auth.token,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      json: async () => JSON.parse(text),
    };
  } finally {
    clearTimeout(timer);
  }
}
/** Location uploads and arrival detection never mark a delivery completed. Only the driver's confirmation does. */
function processDriverLocation(
  location: ArrivalLocation,
  background = false,
): Promise<{ stop: boolean }> {
  const expected = generation;
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
    if (settings.routeId !== route.id || generation !== expected)
      return { stop: false };
    // A legacy request may have reached the server before an upgrade. Reconcile its
    // recorded result, but never replay an unconfirmed completion request.
    if (settings.pendingCompletion) {
      const pending = settings.pendingCompletion,
        handled = route.stops.find((s) => s.id === pending.stopId);
      if (handled && ["delivered", "failed"].includes(handled.status))
        settings.arrival = afterAutomaticDelivery(
          route.id,
          handled,
          pending.at,
          pending.point,
        );
      delete settings.pendingCompletion;
    }
    const next = route.stops.find((s) => s.status === "assigned");
    if (
      settings.pendingArrival &&
      settings.pendingArrival.stopId !== next?.id
    ) {
      dismissNotice(settings.pendingArrival.stopId);
      delete settings.pendingArrival;
    }
    const result = checkArrival(route, location, settings.arrival);
    settings.arrival = result.state;
    if (
      result.stop &&
      !settings.pendingArrival &&
      Date.now() >= (settings.dismissedUntil ?? 0) &&
      generation === expected
    ) {
      settings.pendingArrival = {
        stopId: result.stop.id,
        point: { lat: location.lat, lng: location.lng },
        at: location.recordedAt,
      };
      await save(settings);
      signalDriverArrival();
    }
    if (settings.pendingArrival && !settings.pendingArrival.notified) {
      const pending = settings.pendingArrival,
        stop = route.stops.find(
          (item) => item.id === pending.stopId && item.status === "assigned",
        );
      if (stop && (await notifyArrival(route, stop).catch(() => false))) {
        if (generation !== expected) {
          dismissNotice(stop.id);
          return { stop: false };
        }
        pending.notified = true;
      }
    }
    if (generation === expected) await save(settings);
    return { stop: false };
  });
}

// A weak mobile connection must not queue minutes of old GPS samples. Retain
// only the newest pending sample while one upload is running.
let locationFlight: Promise<{ stop: boolean }> | null = null;
let latestLocation: { location: ArrivalLocation; background: boolean } | null =
  null;
export function handleDriverLocation(
  location: ArrivalLocation,
  background = false,
): Promise<{ stop: boolean }> {
  if (locationFlight) {
    if (
      !latestLocation ||
      Date.parse(location.recordedAt) >
        Date.parse(latestLocation.location.recordedAt)
    )
      latestLocation = { location, background };
    return locationFlight;
  }
  locationFlight = (async () => {
    let sample = { location, background },
      result: { stop: boolean } = { stop: false };
    do {
      latestLocation = null;
      result = await processDriverLocation(sample.location, sample.background);
      if (result.stop) {
        latestLocation = null;
        break;
      }
      const next = latestLocation as {
        location: ArrivalLocation;
        background: boolean;
      } | null;
      if (!next) break;
      sample = next;
    } while (true);
    return result;
  })().finally(() => {
    locationFlight = null;
  });
  return locationFlight;
}
