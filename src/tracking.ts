import { Platform, Linking, AppState, Alert } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { requireOptionalNativeModule } from "expo";
import { api, getSession, restoreSession } from "./api";
import type { Company, Point, Route } from "../server/types";
import { buildCourseNavigation } from "./courseNavigation";
import { waitForLocationService } from "./locationServiceState";
import {
  addressDirectionsUrl,
  addressSearchFallback,
  hasNavigationPoint,
  navigationAddress,
  navigationAddressLabel,
} from "./addressNavigation";
import type { NavigationDestination } from "./addressNavigation";
import {
  clearDriverAutomation,
  configureDriverAutomation,
  getDriverAutomation,
  handleDriverLocation,
  prepareDrivingNotifications,
} from "./driverAutomation";

const TASK = "bareun-dispatch-background-location-v2";
const LEGACY_TASK = "bareun-dispatch-background-location";
let foreground: Location.LocationSubscription | undefined;
let starting: Promise<"foreground" | "background"> | undefined;
let trackingGeneration = 0;
export let trackingMode: "off" | "foreground" | "background" = "off";
function androidService() {
  if (Platform.OS !== "android" || Number(Platform.Version) < 26) return null;
  const module = requireOptionalNativeModule<{
    getForegroundServiceStatusAsync?: (name: string) => Promise<string>;
  }>("ExpoLocation");
  if (!module?.getForegroundServiceStatusAsync)
    throw new Error(
      "위치 공유 안정화 기능이 포함된 최신 APK로 업데이트해 주세요.",
    );
  return () => module.getForegroundServiceStatusAsync!(TASK);
}
export async function restoreTrackingMode() {
  // Returning from a permission dialog must not cancel an in-flight start.
  if (starting) return trackingMode;
  if (Platform.OS !== "web")
    try {
      if (await Location.hasStartedLocationUpdatesAsync(TASK)) {
        const probe = androidService();
        if (probe && (await probe()) !== "running") await stopTracking(false);
        else {
          const options = (await TaskManager.getTaskOptionsAsync(TASK).catch(
            () => null,
          )) as {
            foregroundService?: { killServiceOnDestroy?: boolean };
          } | null;
          if (
            options?.foregroundService?.killServiceOnDestroy === true &&
            AppState.currentState === "active"
          )
            return await startTracking(() => {});
          trackingMode = "background";
        }
      } else if (!foreground) trackingMode = "off";
    } catch {
      if (!foreground) trackingMode = "off";
    }
  return trackingMode;
}
if (Platform.OS !== "web" && !TaskManager.isTaskDefined(LEGACY_TASK))
  TaskManager.defineTask(LEGACY_TASK, async () => {
    await TaskManager.unregisterTaskAsync(LEGACY_TASK).catch(() => {});
  });
if (Platform.OS !== "web" && !TaskManager.isTaskDefined(TASK))
  TaskManager.defineTask(TASK, async ({ data, error }) => {
    if (error) {
      // A temporary provider failure must not permanently disable the route.
      if (/permission|unauthori[sz]ed|denied/i.test(String(error.code)))
        await stopTracking(false);
      return;
    }
    const locations = (
      data as { locations: Location.LocationObject[] } | undefined
    )?.locations;
    const location = Array.isArray(locations) ? locations.at(-1) : null;
    if (!location) return;
    try {
      const expectedGeneration = trackingGeneration;
      const point = locationPayload(location);
      if (
        point &&
        (await handleDriverLocation(point, true)).stop &&
        expectedGeneration === trackingGeneration
      )
        await stopTracking();
    } catch {
      /* A later location update retries after connectivity resumes. */
    }
  });
function locationPayload(location: Location.LocationObject) {
  if (
    !location?.coords ||
    !Number.isFinite(location.timestamp) ||
    !Number.isFinite(location.coords.latitude) ||
    !Number.isFinite(location.coords.longitude) ||
    Math.abs(location.coords.latitude) > 90 ||
    Math.abs(location.coords.longitude) > 180 ||
    !Number.isFinite(new Date(location.timestamp).getTime())
  )
    return null;
  return {
    lat: location.coords.latitude,
    lng: location.coords.longitude,
    accuracy: location.coords.accuracy,
    speed: location.coords.speed,
    recordedAt: new Date(location.timestamp).toISOString(),
  };
}
export function startTracking(
  onError: (message: string) => void,
): Promise<"foreground" | "background"> {
  if (!starting)
    starting = startTrackingInternal(onError).finally(() => {
      starting = undefined;
    });
  return starting;
}
async function foregroundReady() {
  if (Platform.OS === "web") return;
  if (AppState.currentState !== "active")
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        subscription.remove();
        reject(new Error("앱으로 돌아온 뒤 위치 공유를 다시 켜 주세요."));
      }, 12000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") {
          clearTimeout(timer);
          subscription.remove();
          resolve();
        }
      });
    });
  // Permission settings can resolve before Android has made the activity visible.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  if (AppState.currentState !== "active")
    throw new Error("위치 공유를 준비하는 동안 앱을 열어 두세요.");
}
async function startTrackingInternal(
  onError: (message: string) => void,
): Promise<"foreground" | "background"> {
  await stopTracking(false);
  const expectedGeneration = trackingGeneration;
  const assertCurrent = () => {
    if (
      trackingGeneration !== expectedGeneration ||
      getSession()?.user.role !== "driver"
    )
      throw new Error(
        "위치 공유 시작이 취소되었습니다. 다시 로그인해 확인해 주세요.",
      );
  };
  await foregroundReady();
  if (!(await Location.hasServicesEnabledAsync()))
    throw new Error("휴대폰 설정에서 위치 기능을 켠 뒤 다시 눌러 주세요.");
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== "granted")
    throw new Error(
      "위치 권한을 허용하면 배송 중 위치를 공유할 수 있습니다. 설정에서 위치 권한을 확인해 주세요.",
    );
  assertCurrent();
  const watcher = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      distanceInterval: 0,
      timeInterval: 10000,
      mayShowUserSettingsDialog: false,
    },
    (location) => {
      if (trackingGeneration !== expectedGeneration) return;
      const point = locationPayload(location);
      if (!point) return;
      handleDriverLocation(point)
        .then((result) => {
          if (result.stop && trackingGeneration === expectedGeneration)
            return stopTracking();
        })
        .catch((error) => onError(error.message));
    },
    (reason) => onError("위치를 확인하지 못했습니다. " + reason),
  );
  try {
    assertCurrent();
  } catch (error) {
    watcher.remove();
    throw error;
  }
  foreground = watcher;
  trackingMode = "foreground";
  if (Platform.OS !== "web" && (await TaskManager.isAvailableAsync())) {
    try {
      const notificationsAllowed = await prepareDrivingNotifications();
      if (Platform.OS === "android" && !notificationsAllowed) {
        onError(
          "외부 내비 사용 중 위치 공유와 다음 구간 안내를 받으려면 알림 권한을 허용해 주세요.",
        );
        return "foreground";
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (bg.status === "granted") {
        await foregroundReady();
        assertCurrent();
        await Location.startLocationUpdatesAsync(TASK, {
          accuracy: Location.Accuracy.High,
          distanceInterval: 0,
          timeInterval: 10000,
          showsBackgroundLocationIndicator: true,
          pausesUpdatesAutomatically: false,
          activityType: Location.ActivityType.AutomotiveNavigation,
          foregroundService: {
            notificationTitle: "바른배차 · 배송 중",
            notificationBody: "관리자에게 배송 위치를 공유하고 있습니다.",
            notificationColor: "#153b36",
            killServiceOnDestroy: false,
          },
        });
        const probe = androidService();
        if (probe) await waitForLocationService(probe, assertCurrent);
        assertCurrent();
        if (!(await Location.hasStartedLocationUpdatesAsync(TASK)))
          throw new Error("백그라운드 위치 공유를 시작하지 못했습니다.");
        foreground?.remove();
        foreground = undefined;
        trackingMode = "background";
        return trackingMode;
      }
    } catch (error) {
      if (trackingGeneration !== expectedGeneration) throw error;
      await TaskManager.unregisterTaskAsync(TASK).catch(() => {});
      onError(
        "백그라운드 위치 공유를 준비하지 못해 앱을 열어 둔 동안만 공유합니다. " +
          (error as Error).message,
      );
    }
  }
  assertCurrent();
  trackingMode = "foreground";
  return trackingMode;
}
export async function stopTracking(clearAutomation = true) {
  trackingGeneration++;
  foreground?.remove();
  foreground = undefined;
  if (Platform.OS !== "web") {
    try {
      if (await TaskManager.isTaskRegisteredAsync(TASK))
        await TaskManager.unregisterTaskAsync(TASK);
      if (await TaskManager.isTaskRegisteredAsync(LEGACY_TASK))
        await TaskManager.unregisterTaskAsync(LEGACY_TASK);
    } catch {}
  }
  trackingMode = "off";
  if (clearAutomation) await clearDriverAutomation().catch(() => {});
}
export async function navigateCourse(route: Route) {
  if (Platform.OS === "web")
    throw new Error(
      "연속 내비 안내는 설치한 Android·iPhone 앱에서 사용해 주세요.",
    );
  const plan = buildCourseNavigation(route);
  await foregroundReady();
  const old = await getDriverAutomation();
  const enabled = old?.routeId === route.id && old.enabled;
  await configureDriverAutomation(route.id, enabled, plan);
  try {
    await Linking.openURL(plan.url);
  } catch {
    await configureDriverAutomation(route.id, enabled, {
      segmentEndStopId: old?.segmentEndStopId ?? null,
      continuous: old?.continuous ?? false,
    });
    throw new Error(
      "연속 코스 안내에는 네이버 지도 앱이 필요합니다. 네이버 지도를 설치한 뒤 다시 눌러 주세요.",
    );
  }
  return plan;
}
export async function resumeCourseNotification(routeId: string) {
  if (!getSession()) await restoreSession();
  if (getSession()?.user.role !== "driver")
    throw new Error("기사 PIN으로 로그인한 뒤 코스 안내를 이어 주세요.");
  const { route } = await api<{ route: Route | null }>("/api/me");
  if (!route || route.id !== routeId || route.status === "completed")
    throw new Error("현재 운행 중인 코스를 확인해 주세요.");
  await navigateCourse(route);
}
async function offerAddressNavigation(address: string, company: Company) {
  const directions = addressDirectionsUrl(address);
  const search = addressSearchFallback(company.navigation, address);
  const message =
    "배송지 주소의 위치를 자동으로 확인하지 못했습니다. " +
    "Google 지도에서 주소로 길안내를 시작하거나 지도에서 주소를 검색할 수 있어요.";
  if (Platform.OS === "web") {
    // React Native Web's Alert is a no-op. Keep this alternate provider opt-in.
    if (
      typeof window !== "undefined" &&
      window.confirm(
        message + "\n\nGoogle 지도에서 주소로 길안내를 시작할까요?",
      )
    )
      await Linking.openURL(directions);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let selected = false;
    const open = (url: string) => {
      selected = true;
      Linking.openURL(url).then(
        () => resolve(),
        () => {
          reject(
            new Error(
              "지도를 열지 못했습니다. 휴대폰의 지도 앱이나 인터넷 연결을 확인해 주세요.",
            ),
          );
        },
      );
    };
    Alert.alert(
      "주소로 길안내",
      message,
      [
        {
          text: "취소",
          style: "cancel",
          onPress: () => {
            selected = true;
            resolve();
          },
        },
        { text: search.title, onPress: () => open(search.url) },
        { text: "Google 지도 길안내", onPress: () => open(directions) },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          if (!selected) resolve();
        },
      },
    );
  });
}

export async function navigate(
  destination: NavigationDestination,
  company: Company,
) {
  let point: Point;
  if (hasNavigationPoint(destination)) point = destination;
  else {
    const address = navigationAddress(destination.address);
    if (!address) throw new Error("배송지 주소를 입력해 주세요.");
    try {
      const resolved = await api<Point>("/api/navigation/resolve", {
        method: "POST",
        body: JSON.stringify({
          ...(destination.id ? { shipmentId: destination.id } : {}),
          address,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!hasNavigationPoint({ ...resolved, address }))
        throw new Error("배송지 주소의 위치를 확인하지 못했습니다.");
      point = resolved;
    } catch {
      await offerAddressNavigation(address, company);
      return;
    }
  }
  const label = encodeURIComponent(
      destination.recipient ?? destination.name ?? "배송지",
    ),
    addressLabel = encodeURIComponent(navigationAddressLabel(destination)),
    lat = point.lat,
    lng = point.lng;
  let url =
    Platform.OS === "ios"
      ? `http://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`
      : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
  if (company.navigation === "kakao") {
    if (Platform.OS !== "web") {
      let start = "";
      try {
        const point = await Location.getLastKnownPositionAsync({
          maxAge: 120000,
        });
        if (point)
          start = `sp=${point.coords.latitude},${point.coords.longitude}&`;
      } catch {}
      try {
        await Linking.openURL(
          `kakaomap://route?${start}ep=${lat},${lng}&by=CAR`,
        );
        return;
      } catch {}
    }
    url = `https://map.kakao.com/link/to/${addressLabel},${lat},${lng}`;
  }
  if (company.navigation === "naver") {
    const native = `nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${label}&appname=com.bobjjang.bareundispatch`;
    if (Platform.OS !== "web")
      try {
        await Linking.openURL(native);
        return;
      } catch {
        throw new Error(
          "네이버 지도 앱을 설치한 뒤 길안내를 다시 눌러 주세요.",
        );
      }
    // Naver's supported browser fallback is address search, not turn-by-turn
    // navigation. Recipient names can be ambiguous even after address resolution.
    url = `https://map.naver.com/p/search/${addressLabel}`;
  }
  await Linking.openURL(url);
}
