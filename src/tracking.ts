import { Platform, Linking } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import * as SecureStore from "expo-secure-store";
import { api, SESSION_KEY } from "./api";
import type { Company, Point } from "../server/types";

const TASK = "bareun-dispatch-background-location";
let foreground: Location.LocationSubscription | undefined;
export let trackingMode: "off" | "foreground" | "background" = "off";
export async function restoreTrackingMode() {
  if (Platform.OS !== "web")
    try {
      if (await Location.hasStartedLocationUpdatesAsync(TASK))
        trackingMode = "background";
    } catch {}
  return trackingMode;
}
if (Platform.OS !== "web" && !TaskManager.isTaskDefined(TASK))
  TaskManager.defineTask(TASK, async ({ data, error }) => {
    if (error) return;
    const locations = (
      data as { locations: Location.LocationObject[] } | undefined
    )?.locations;
    const location = locations?.at(-1);
    if (!location) return;
    const saved = await SecureStore.getItemAsync(SESSION_KEY);
    if (!saved) return;
    const session = JSON.parse(saved);
    if (!session.token || !session.apiUrl) return;
    try {
      const response = await fetch(session.apiUrl + "/api/driver/location", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(locationPayload(location)),
      });
      if ([401, 409].includes(response.status))
        await Location.stopLocationUpdatesAsync(TASK);
    } catch {
      /* A later location update retries after connectivity resumes. */
    }
  });
function locationPayload(location: Location.LocationObject) {
  return {
    lat: location.coords.latitude,
    lng: location.coords.longitude,
    accuracy: location.coords.accuracy,
    speed: location.coords.speed,
    recordedAt: new Date(location.timestamp).toISOString(),
  };
}
export async function startTracking(
  onError: (message: string) => void,
): Promise<"foreground" | "background"> {
  await stopTracking();
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== "granted")
    throw new Error(
      "위치 권한을 허용하면 배송 중 위치를 공유할 수 있습니다. 설정에서 위치 권한을 확인해 주세요.",
    );
  const first = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
  await api("/api/driver/location", {
    method: "POST",
    body: JSON.stringify(locationPayload(first)),
  });
  if (Platform.OS !== "web" && (await TaskManager.isAvailableAsync())) {
    try {
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (bg.status === "granted") {
        await Location.startLocationUpdatesAsync(TASK, {
          accuracy: Location.Accuracy.High,
          distanceInterval: 20,
          timeInterval: 10000,
          showsBackgroundLocationIndicator: true,
          pausesUpdatesAutomatically: false,
          activityType: Location.ActivityType.AutomotiveNavigation,
          foregroundService: {
            notificationTitle: "바른배차 · 배송 중",
            notificationBody: "관리자에게 배송 위치를 공유하고 있습니다.",
            notificationColor: "#153b36",
          },
        });
        trackingMode = "background";
        return trackingMode;
      }
    } catch {
      /* Expo Go and denied background permission use foreground tracking. */
    }
  }
  foreground = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      distanceInterval: 15,
      timeInterval: 10000,
    },
    (location) => {
      api("/api/driver/location", {
        method: "POST",
        body: JSON.stringify(locationPayload(location)),
      }).catch((error) => onError(error.message));
    },
  );
  trackingMode = "foreground";
  return trackingMode;
}
export async function stopTracking() {
  foreground?.remove();
  foreground = undefined;
  if (Platform.OS !== "web") {
    try {
      if (await Location.hasStartedLocationUpdatesAsync(TASK))
        await Location.stopLocationUpdatesAsync(TASK);
    } catch {}
  }
  trackingMode = "off";
}
export async function navigate(
  destination: Point & { recipient?: string; name?: string },
  company: Company,
) {
  const label = encodeURIComponent(
      destination.recipient ?? destination.name ?? "배송지",
    ),
    lat = destination.lat,
    lng = destination.lng;
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
    url = `https://map.kakao.com/link/to/${label},${lat},${lng}`;
  }
  if (company.navigation === "naver") {
    const native = `nmap://route/car?dlat=${lat}&dlng=${lng}&dname=${label}&appname=com.bobjjang.bareundispatch`;
    if (Platform.OS !== "web")
      try {
        await Linking.openURL(native);
        return;
      } catch {}
    url = `https://map.naver.com/p/directions/-/${lng},${lat},${label}/-/car`;
  }
  await Linking.openURL(url);
}
