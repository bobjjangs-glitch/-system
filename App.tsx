import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  Switch,
  Image,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import * as Notifications from "expo-notifications";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Building2,
  Camera,
  Check,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LocateFixed,
  LogOut,
  MapPin,
  Navigation,
  Package,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Settings2,
  ShieldCheck,
  Trash2,
  Truck,
  Upload,
  Users,
  X,
} from "lucide-react-native";
import type {
  Company,
  Driver,
  Route,
  Session,
  Shipment,
  ShipmentInput,
} from "./server/types";
import {
  API_URL,
  api,
  connectLive,
  getSession,
  koreanDate,
  onUnauthorized,
  patch,
  post,
  restoreSession,
  saveSession,
} from "./src/api";
import {
  navigate,
  startTracking,
  stopTracking,
  trackingMode,
  restoreTrackingMode,
  navigateCourse,
  resumeCourseNotification,
} from "./src/tracking";
import {
  configureDriverAutomation,
  getDriverAutomation,
  recordHandledStop,
} from "./src/driverAutomation";
import type { DriverAutomation } from "./src/driverAutomation";
import { consumeLocationRecovery, shareNativeCrash } from "./src/diagnostics";
import MapPanel from "./src/MapPanel";
import RouteOverview from "./src/RouteOverview";
import DeliveryItems, { CargoSummary } from "./src/DeliveryItems";
import {
  Badge,
  Button,
  Card,
  C,
  Empty,
  Field,
  Loading,
  s,
  Sheet,
} from "./src/ui";

type Run = (fn: () => Promise<unknown>) => void;
if (Platform.OS !== "web") {
  SplashScreen.setOptions({ duration: 400, fade: true });
  SplashScreen.preventAutoHideAsync().catch(() => {});
}
type SetupState = { required: boolean; bootstrapCodeRequired: boolean };
const setupRequiredMessage =
  "현재 서버에 관리자 계정이 없습니다. 첫 관리자 등록을 진행해 주세요.";
type Position = {
  lat: number;
  lng: number;
  recordedAt: string;
  accuracy?: number;
  routeId: string;
};
type DriverState = Driver & { position: Position | null };
type Dashboard = {
  date: string;
  company: Company;
  demo: boolean;
  shipments: Shipment[];
  routes: Route[];
  drivers: DriverState[];
  stats: {
    total: number;
    delivered: number;
    failed: number;
    pending: number;
    active: number;
  };
};
type ImportBatch = {
  id?: string;
  fileName: string;
  rawText?: string;
  drafts: ShipmentInput[];
  serviceDate: string;
  status?: string;
  createdAt?: string;
  count?: number;
};
const statusName: Record<string, string> = {
  pending: "미배차",
  assigned: "배송 대기",
  delivered: "배송 완료",
  failed: "미배송",
  planned: "출발 대기",
  active: "배송 중",
  returning: "회사 복귀 중",
  completed: "복귀 완료",
};
const formatTime = (minutes: number) =>
  minutes >= 60
    ? `${Math.floor(minutes / 60)}시간 ${Math.round(minutes % 60)}분`
    : `${Math.round(minutes)}분`;
function blankShipment(): ShipmentInput {
  return {
    recipient: "",
    address: "",
    phone: "",
    items: [{ name: "", quantity: 1 }],
    notes: "",
    lat: null,
    lng: null,
  };
}
function positionText(position: Position | null) {
  if (!position) return "위치 미수신";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(position.recordedAt)) / 1000),
  );
  if (seconds < 60) return `${seconds}초 전 수신`;
  if (seconds < 120) return "1분 전 수신";
  return `${Math.floor(seconds / 60)}분 전 · 마지막 위치`;
}
function AppContent() {
  const [user, setUser] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [setup, setSetup] = useState(false),
    [bootstrap, setBootstrap] = useState(false),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const run: Run = async (fn) => {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const refreshSetup = async () => {
    const data = await api<SetupState>("/api/setup");
    setSetup(data.required);
    setBootstrap(data.bootstrapCodeRequired);
    return data;
  };
  useEffect(() => {
    consumeLocationRecovery()
      .then((recovered) => {
        if (recovered)
          setNotice(
            "이전 위치 공유 상태를 정리했습니다. 로그인과 코스는 유지됩니다. 위치 공유를 다시 켜 주세요.",
          );
      })
      .catch(() => {});
    if (Platform.OS === "web") return;
    const handled = new Set<string>();
    const handle = (response: Notifications.NotificationResponse | null) => {
      if (!response) return;
      const { identifier, content } = response.notification.request;
      if (
        handled.has(identifier) ||
        content.data?.dispatchAction !== "continue-course" ||
        typeof content.data.routeId !== "string"
      )
        return;
      handled.add(identifier);
      resumeCourseNotification(content.data.routeId).catch((error) =>
        setNotice(error.message),
      );
      Notifications.clearLastNotificationResponseAsync().catch(() => {});
    };
    const listener =
      Notifications.addNotificationResponseReceivedListener(handle);
    Notifications.getLastNotificationResponseAsync()
      .then(handle)
      .catch(() => {});
    return () => listener.remove();
  }, []);
  useEffect(() => {
    onUnauthorized(() => {
      setUser(null);
      stopTracking();
      refreshSetup()
        .then((state) => {
          if (state.required) setNotice(setupRequiredMessage);
        })
        .catch((error) => setNotice((error as Error).message));
    });
    (async () => {
      try {
        await restoreSession();
        await refreshSetup();
        if (getSession()) {
          const me = await api("/api/me");
          setUser(me.user);
        }
      } catch (error) {
        setNotice((error as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  const logout = () =>
    run(async () => {
      await stopTracking();
      try {
        await post("/api/logout");
      } finally {
        await saveSession(null);
        setUser(null);
      }
    });
  if (loading) return <Loading />;
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: C.bg }}
      edges={["top", "left", "right"]}
    >
      <StatusBar style="dark" />
      {notice ? (
        <Pressable
          accessibilityLabel="알림 닫기"
          onPress={() => setNotice("")}
          style={st.notice}
        >
          <Text style={{ color: C.red, fontSize: 13, flex: 1, lineHeight: 20 }}>
            {notice}
          </Text>
          <X color={C.red} size={17} />
        </Pressable>
      ) : null}
      {user ? (
        user.role === "admin" ? (
          <Admin
            user={user}
            logout={logout}
            run={run}
            busy={busy}
            tell={setNotice}
          />
        ) : (
          <DriverApp
            user={user}
            logout={logout}
            run={run}
            busy={busy}
            tell={setNotice}
          />
        )
      ) : (
        <Login
          setup={setup}
          bootstrap={bootstrap}
          run={run}
          busy={busy}
          refreshSetup={refreshSetup}
          onLogin={async (session) => {
            await saveSession(session);
            setUser(session.user);
            setSetup(false);
          }}
        />
      )}
      {busy && (
        <View pointerEvents="none" style={st.busy}>
          <ActivityIndicator size="small" color={C.green} />
          <Text style={[s.muted, { color: C.green }]}>처리 중이에요…</Text>
        </View>
      )}
    </SafeAreaView>
  );
}
export default function App() {
  return (
    <SafeAreaProvider>
      <View
        style={{ flex: 1 }}
        onLayout={() => {
          if (Platform.OS !== "web") SplashScreen.hideAsync().catch(() => {});
        }}
      >
        <AppContent />
      </View>
    </SafeAreaProvider>
  );
}

function Login({
  setup,
  bootstrap,
  run,
  busy,
  onLogin,
  refreshSetup,
}: {
  setup: boolean;
  bootstrap: boolean;
  run: Run;
  busy: boolean;
  onLogin: (session: any) => Promise<void>;
  refreshSetup: () => Promise<SetupState>;
}) {
  const [pin, setPin] = useState(""),
    [name, setName] = useState(""),
    [code, setCode] = useState("");
  return (
    <ScrollView
      contentContainerStyle={st.login}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ width: "100%", maxWidth: 430 }}>
        <Image
          source={require("./assets/icon.png")}
          accessibilityLabel="바른배차 로고"
          style={{ width: 78, height: 78, borderRadius: 22 }}
        />
        <Text style={[s.section, { marginTop: 25, color: C.green }]}>
          BAREUN DISPATCH
        </Text>
        <Text
          style={[s.h1, { fontSize: 37, lineHeight: 47, marginBottom: 13 }]}
        >
          하루의 배송을,{`\n`}바른 순서로.
        </Text>
        <Text
          style={[s.muted, { fontSize: 14, lineHeight: 23, marginBottom: 33 }]}
        >
          전표부터 배차, 배송과 회사 복귀까지{`\n`}모두 한 곳에서 간편하게
          관리하세요.
        </Text>
        <Card>
          <View style={[s.row, { marginBottom: 22 }]}>
            <ShieldCheck size={22} color={C.green} />
            <Text style={s.h2}>
              {setup ? "첫 관리자 등록" : "PIN으로 로그인"}
            </Text>
          </View>
          {setup && (
            <Field
              label="관리자 이름"
              value={name}
              onChangeText={setName}
              placeholder="관리자 이름을 입력해 주세요"
            />
          )}
          <Field
            label={setup ? "사용할 관리자 PIN (6~12자리)" : "배정받은 PIN"}
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 12))}
            placeholder="숫자 6~12자리"
            numeric
            secure
          />
          {setup && bootstrap && (
            <Field
              label="최초 관리자 등록 코드"
              value={code}
              onChangeText={setCode}
              secure
            />
          )}
          <Button
            title={setup ? "관리자 등록하고 시작" : "로그인"}
            icon={ArrowRight}
            disabled={busy || pin.length < 6 || (setup && !name.trim())}
            onPress={() =>
              run(async () => {
                let session;
                try {
                  session = await post(setup ? "/api/setup" : "/api/login", {
                    pin,
                    name,
                    bootstrapCode: code,
                  });
                } catch (error) {
                  const state = await refreshSetup().catch(() => null);
                  if (state && state.required !== setup) {
                    setPin("");
                    setCode("");
                    throw new Error(
                      state.required
                        ? setupRequiredMessage
                        : "관리자가 이미 등록되어 있습니다. 등록한 PIN으로 로그인해 주세요.",
                    );
                  }
                  throw error;
                }
                await onLogin(session);
                setPin("");
              })
            }
          />
          <Text
            style={[
              s.muted,
              { marginTop: 16, fontSize: 11, textAlign: "center" },
            ]}
          >
            {setup
              ? "등록한 관리자만 기사를 추가하고 PIN을 발급할 수 있어요."
              : "PIN에 따라 관리자 또는 기사 화면으로 연결돼요."}
          </Text>
        </Card>
        {Platform.OS !== "web" && (
          <View style={{ marginBottom: 10 }}>
            <Button
              title="앱 오류 정보 공유"
              secondary
              small
              onPress={() => run(shareNativeCrash)}
            />
          </View>
        )}
        <Pressable
          onPress={() =>
            run(async () => {
              await refreshSetup();
            })
          }
          style={{ alignSelf: "center", padding: 12 }}
        >
          <Text style={s.muted}>연결 상태 다시 확인</Text>
        </Pressable>
        <View style={[s.row, { justifyContent: "center", marginTop: 20 }]}>
          <MapPin size={13} color={C.muted} />
          <Text style={{ color: C.muted, fontSize: 11 }}>
            배송지 순회 · 실시간 위치 · 회사 복귀
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const tabs = [
  { id: "dashboard", label: "현황", icon: LayoutDashboard },
  { id: "upload", label: "전표", icon: Upload },
  { id: "routes", label: "배차", icon: RouteIcon },
  { id: "drivers", label: "기사", icon: Users },
  { id: "history", label: "내역", icon: History },
] as const;
function Admin({
  user,
  logout,
  run,
  busy,
  tell,
}: {
  user: Session;
  logout: () => void;
  run: Run;
  busy: boolean;
  tell: (s: string) => void;
}) {
  const [tab, setTab] = useState<string>("dashboard"),
    [date, setDate] = useState(koreanDate()),
    [data, setData] = useState<Dashboard | null>(null),
    [imports, setImports] = useState<ImportBatch[]>([]),
    [selectedDriver, setSelectedDriver] = useState<string | null>(null),
    [review, setReview] = useState<ImportBatch | null>(null),
    [company, setCompany] = useState<Company | null>(null),
    [driverEdit, setDriverEdit] = useState<
      (Partial<Driver> & { pin?: string }) | null
    >(null),
    [pins, setPins] = useState<{ name: string; pin: string }[] | null>(null),
    [detail, setDetail] = useState<Shipment | null>(null),
    [confirmClear, setConfirmClear] = useState(false);
  const { width } = useWindowDimensions();
  const refresh = useCallback(async () => {
    const [board, batches] = await Promise.all([
      api<Dashboard>("/api/dashboard?date=" + date),
      api<ImportBatch[]>("/api/imports?date=" + date),
    ]);
    setData(board);
    setImports(batches);
  }, [date]);
  useEffect(() => {
    refresh().catch((e) => tell(e.message));
    const interval = setInterval(() => refresh().catch(() => {}), 15000);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(
    () =>
      connectLive((event) => {
        if (event.event === "position")
          setData((previous) =>
            previous
              ? {
                  ...previous,
                  drivers: previous.drivers.map((d) =>
                    d.id === event.driverId
                      ? { ...d, position: event.position }
                      : d,
                  ),
                }
              : previous,
          );
        else if (event.event === "changed") refresh().catch(() => {});
      }),
    [refresh],
  );
  const addDemo = () =>
    run(async () => {
      const result = await post("/api/demo");
      setPins(result.drivers);
      await refresh();
    });
  const updateReview = (i: number, changes: Partial<ShipmentInput>) =>
    setReview((old) =>
      old
        ? {
            ...old,
            drafts: old.drafts.map((r, index) =>
              index === i ? { ...r, ...changes } : r,
            ),
          }
        : null,
    );
  const locateRow = (i: number) =>
    run(async () => {
      if (!review) return;
      const point = await post("/api/geocode", {
        address: review.drafts[i].address,
      });
      updateReview(i, point);
    });
  const pickUpload = (kind: "camera" | "photo" | "excel") =>
    run(async () => {
      let asset: any;
      if (kind === "excel") {
        const result = await DocumentPicker.getDocumentAsync({
          type: [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "text/csv",
            "application/csv",
          ],
          copyToCacheDirectory: true,
        });
        if (result.canceled) return;
        asset = result.assets[0];
      } else {
        const permission =
          kind === "camera"
            ? await ImagePicker.requestCameraPermissionsAsync()
            : await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!permission.granted)
          throw new Error("카메라 또는 사진 접근 권한을 허용해 주세요.");
        const result =
          kind === "camera"
            ? await ImagePicker.launchCameraAsync({
                mediaTypes: ["images"],
                quality: 0.9,
              })
            : await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images"],
                quality: 0.9,
                preferredAssetRepresentationMode:
                  ImagePicker.UIImagePickerPreferredAssetRepresentationMode
                    .Compatible,
              });
        if (result.canceled) return;
        asset = result.assets[0];
      }
      const form = new FormData();
      let name = asset.name ?? asset.fileName ?? "receipt.jpg";
      if (kind !== "excel") {
        // iPhone may retain the original HEIC name after exporting a compatible JPEG.
        const extension = asset.uri
          .split("?")[0]
          .match(/\.(jpe?g|png|webp)$/i)?.[1];
        if (extension) name = name.replace(/\.[^.]+$/, "") + "." + extension;
      }
      if (Platform.OS === "web") {
        const blob =
          asset.file ?? (await fetch(asset.uri).then((r) => r.blob()));
        form.append("file", blob, name);
      } else
        form.append("file", {
          uri: asset.uri,
          name,
          type:
            asset.mimeType ??
            (kind === "excel"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "image/jpeg"),
        } as any);
      form.append("serviceDate", date);
      setReview(await api("/api/imports", { method: "POST", body: form }));
      await refresh();
    });
  const download = async (path: string, name: string) => {
    const response = await fetch(API_URL + path, {
      headers: { Authorization: `Bearer ${getSession()?.token}` },
    });
    if (!response.ok) throw new Error("파일을 다운로드하지 못했습니다.");
    const bytes = await response.arrayBuffer();
    if (Platform.OS === "web") {
      const url = URL.createObjectURL(new Blob([bytes]));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const file = new File(
        Paths.cache,
        name.replace(/[^가-힣a-zA-Z0-9._-]/g, "_"),
      );
      file.create({ overwrite: true });
      file.write(new Uint8Array(bytes));
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri);
      else throw new Error("이 기기에서 파일 공유를 사용할 수 없습니다.");
    }
  };
  if (!data) return <Loading />;
  const shownRoutes = selectedDriver
    ? data.routes.filter((r) => r.driverId === selectedDriver)
    : data.routes;
  const shownDrivers = selectedDriver
    ? data.drivers.filter((d) => d.id === selectedDriver)
    : data.drivers;
  const routeStatus = (route: Route) => (
    <Badge
      text={statusName[route.status]}
      tone={
        route.status === "active"
          ? "green"
          : route.status === "returning"
            ? "amber"
            : "grey"
      }
    />
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={st.top}>
        <View style={s.row}>
          <View style={st.logoSmall}>
            <Truck color={C.green} size={22} />
          </View>
          <View>
            <Text style={{ color: C.ink, fontWeight: "800", fontSize: 19 }}>
              바른배차
            </Text>
            <Text style={{ color: C.muted, fontSize: 9, letterSpacing: 1.4 }}>
              DELIVERY WORKSPACE
            </Text>
          </View>
        </View>
        <View style={s.row}>
          <Badge text="관리자" />
          <Pressable
            accessibilityLabel="회사 설정"
            onPress={() => {
              setCompany({ ...data.company });
              setConfirmClear(false);
            }}
            style={st.iconButton}
          >
            <Settings2 size={21} color={C.ink} />
          </Pressable>
          <Pressable
            accessibilityLabel="로그아웃"
            onPress={logout}
            style={st.iconButton}
          >
            <LogOut size={20} color={C.muted} />
          </Pressable>
        </View>
      </View>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => run(refresh)}
            tintColor={C.green}
          />
        }
        contentContainerStyle={[st.content, { maxWidth: 1100 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[s.between, { marginBottom: 23 }]}>
          <View>
            <Text style={[s.muted, { marginBottom: 5 }]}>
              {user.name}님, 오늘도 안전한 배송을.
            </Text>
            <Text style={s.h1}>
              {tabs.find((t) => t.id === tab)?.label === "현황"
                ? "오늘의 배송 현황"
                : tab === "upload"
                  ? "전표를 배송으로"
                  : tab === "routes"
                    ? "가장 편한 배송 코스"
                    : tab === "drivers"
                      ? "함께 달리는 기사님"
                      : "지난 배송도 한눈에"}
            </Text>
          </View>
          {width > 520 && (
            <View style={st.datePill}>
              <Clock3 size={15} color={C.green} />
              <Text style={{ fontSize: 12, color: C.green, fontWeight: "700" }}>
                {date}
              </Text>
            </View>
          )}
        </View>
        {data.demo && (
          <View style={st.demoBanner}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: C.green }}>
                대전 지역 예시 데이터
              </Text>
              <Text style={[s.muted, { fontSize: 10 }]}>
                공개 장소·예시 좌표입니다. 실제 배송 전 회사 설정에서 지워
                주세요.
              </Text>
            </View>
            <Badge text="DEMO" />
          </View>
        )}
        {tab === "dashboard" && (
          <>
            <View style={st.stats}>
              <Stat
                label="전체 배송지"
                value={data.stats.total}
                icon={Package}
              />
              <Stat
                label="배송 완료"
                value={data.stats.delivered}
                icon={CheckCheck}
                accent
              />
              <Stat label="운행 중" value={data.stats.active} icon={Truck} />
              <Stat
                label="미배차"
                value={data.stats.pending}
                icon={ClipboardList}
              />
            </View>
            <View style={[s.between, { marginVertical: 15 }]}>
              <Text style={s.h2}>실시간 운행 지도</Text>
              <View style={s.row}>
                <View style={st.dot} />
                <Text style={s.muted}>실제 수신 위치 표시</Text>
              </View>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 12 }}
            >
              <View style={s.row}>
                <Chip
                  label="전체 기사"
                  selected={!selectedDriver}
                  onPress={() => setSelectedDriver(null)}
                />
                {data.drivers
                  .filter((d) => d.active)
                  .map((d) => (
                    <Chip
                      key={d.id}
                      label={d.name}
                      selected={selectedDriver === d.id}
                      onPress={() => setSelectedDriver(d.id)}
                    />
                  ))}
              </View>
            </ScrollView>
            <MapPanel
              data={{
                company: data.company,
                routes: shownRoutes,
                drivers: shownDrivers,
              }}
              height={width > 650 ? 350 : 290}
            />
            <Text
              style={[
                s.muted,
                { fontSize: 10, marginTop: 9, marginBottom: 19 },
              ]}
            >
              점선은 대략적인 순서 표시이며 실제 주행 경로가 아닙니다. 2분 이상
              미수신한 위치는 마지막 수신 위치로 표시합니다.
            </Text>
            <View style={[s.between, { marginBottom: 13 }]}>
              <Text style={s.h2}>기사별 진행 상황</Text>
              <Pressable onPress={() => setTab("routes")}>
                <Text
                  style={{ color: C.green, fontSize: 12, fontWeight: "700" }}
                >
                  배차 보기 →
                </Text>
              </Pressable>
            </View>
            {!data.drivers.length ? (
              <Empty
                title="첫 배송을 준비해 볼까요?"
                description="기사를 등록하고 전표를 올리면 회사 복귀까지 포함한 코스를 추천해 드려요."
                action={
                  <View style={{ gap: 8, marginTop: 12 }}>
                    <Button
                      title="대전 예시 데이터로 둘러보기"
                      onPress={addDemo}
                      disabled={busy}
                    />
                    <Button
                      title="기사 직접 등록"
                      secondary
                      onPress={() => {
                        setTab("drivers");
                        setDriverEdit({ name: "", phone: "", capacity: 10 });
                      }}
                    />
                  </View>
                }
              />
            ) : (
              shownDrivers.map((d) => {
                const routes = data.routes.filter((r) => r.driverId === d.id),
                  route =
                    routes.find((r) =>
                      ["active", "returning", "planned"].includes(r.status),
                    ) ?? routes.at(-1);
                const completed =
                  route?.stops.filter((s) => s.status === "delivered").length ??
                  0;
                const fresh =
                  d.position &&
                  Date.now() - Date.parse(d.position.recordedAt) < 120000;
                return (
                  <Card key={d.id}>
                    <View style={s.between}>
                      <View style={s.row}>
                        <Avatar name={d.name} />
                        <View>
                          <Text style={s.h3}>{d.name}</Text>
                          <Text style={s.muted}>
                            {positionText(d.position)}
                            {d.position?.accuracy
                              ? ` · 정확도 약 ${Math.round(d.position.accuracy)}m`
                              : ""}
                          </Text>
                        </View>
                      </View>
                      {route ? (
                        routeStatus(route)
                      ) : (
                        <Badge
                          text={d.active ? "배차 대기" : "비활성"}
                          tone="grey"
                        />
                      )}
                    </View>
                    {route && (
                      <>
                        <View
                          style={[
                            s.between,
                            { marginTop: 18, marginBottom: 9 },
                          ]}
                        >
                          <Text style={s.muted}>
                            배송 {completed} / {route.stops.length}곳
                          </Text>
                          <Text
                            style={{
                              color: C.green,
                              fontWeight: "700",
                              fontSize: 12,
                            }}
                          >
                            {formatTime(route.durationMinutes)} · 복귀 포함
                          </Text>
                        </View>
                        <View style={st.progress}>
                          <View
                            style={[
                              st.progressFill,
                              {
                                width: `${route.stops.length ? (completed / route.stops.length) * 100 : 0}%`,
                              },
                            ]}
                          />
                        </View>
                      </>
                    )}
                    {route &&
                      ["active", "returning"].includes(route.status) &&
                      !fresh && (
                        <Text
                          style={[s.muted, { color: C.amber, marginTop: 10 }]}
                        >
                          위치 수신을 기다리고 있어요. 기사 앱의 위치 공유
                          상태를 확인해 주세요.
                        </Text>
                      )}
                  </Card>
                );
              })
            )}
          </>
        )}
        {tab === "upload" && (
          <>
            <Card
              style={{
                backgroundColor: C.ink,
                borderColor: C.ink,
                padding: 26,
              }}
            >
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      fontSize: 23,
                      color: C.white,
                      fontWeight: "800",
                      lineHeight: 32,
                    }}
                  >
                    종이 전표도, 엑셀도.{`\n`}한 번에 배송 준비
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: "#aec0bc",
                      lineHeight: 20,
                      marginTop: 10,
                    }}
                  >
                    업로드 → 인식 내용 확인 → 주소 확인 → 배차
                  </Text>
                </View>
                <View style={st.uploadIllustration}>
                  <ClipboardList color={C.lime} size={43} />
                </View>
              </View>
            </Card>
            <Field
              label="배송 예정일"
              value={date}
              onChangeText={(v) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setDate(v);
              }}
              placeholder="YYYY-MM-DD"
            />
            <View style={[s.row, { alignItems: "stretch", marginBottom: 12 }]}>
              <Pressable
                disabled={busy}
                accessibilityLabel="전표 촬영"
                onPress={() => pickUpload("camera")}
                style={st.uploadCard}
              >
                <Camera size={29} color={C.green} />
                <Text style={s.h3}>전표 촬영</Text>
                <Text style={s.muted}>인쇄된 전표를 사진으로</Text>
              </Pressable>
              <Pressable
                disabled={busy}
                accessibilityLabel="엑셀 업로드"
                onPress={() => pickUpload("excel")}
                style={st.uploadCard}
              >
                <FileSpreadsheet size={29} color={C.green} />
                <Text style={s.h3}>엑셀 업로드</Text>
                <Text style={s.muted}>.xlsx 또는 .csv</Text>
              </Pressable>
            </View>
            <View style={[s.row, { marginBottom: 21 }]}>
              <View style={{ flex: 1 }}>
                <Button
                  title="사진에서 선택"
                  secondary
                  icon={Upload}
                  onPress={() => pickUpload("photo")}
                  disabled={busy}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="배송지 직접 입력"
                  secondary
                  icon={Plus}
                  onPress={() =>
                    setReview({
                      fileName: "직접 입력",
                      drafts: [blankShipment()],
                      serviceDate: date,
                    })
                  }
                />
              </View>
            </View>
            <Card>
              <View style={s.row}>
                <FileSpreadsheet color={C.green} size={22} />
                <View style={{ flex: 1 }}>
                  <Text style={s.h3}>엑셀 양식이 필요하신가요?</Text>
                  <Text style={s.muted}>
                    수령인·주소·품목·수량을 한 행씩 입력해 주세요.
                  </Text>
                </View>
              </View>
              <View style={{ marginTop: 15 }}>
                <Button
                  title="엑셀 양식 받기"
                  secondary
                  small
                  onPress={() =>
                    run(() => download("/api/template", "배송지_양식.xlsx"))
                  }
                />
              </View>
            </Card>
            <Text style={[s.section, { marginTop: 13 }]}>
              확인을 기다리는 업로드
            </Text>
            {imports.filter((i) => i.status === "review").length ? (
              imports
                .filter((i) => i.status === "review")
                .map((batch) => (
                  <Pressable
                    key={batch.id}
                    onPress={() =>
                      run(async () =>
                        setReview(await api("/api/imports/" + batch.id)),
                      )
                    }
                  >
                    <Card>
                      <View style={s.between}>
                        <View style={s.row}>
                          <ClipboardList size={20} color={C.green} />
                          <View>
                            <Text style={s.h3}>{batch.fileName}</Text>
                            <Text style={s.muted}>
                              {batch.serviceDate} 배송 · 내용 확인 필요
                            </Text>
                          </View>
                        </View>
                        <ChevronRight size={20} color={C.muted} />
                      </View>
                    </Card>
                  </Pressable>
                ))
            ) : (
              <Text style={s.muted}>새 전표를 업로드하면 여기에 표시돼요.</Text>
            )}
          </>
        )}
        {tab === "routes" && (
          <>
            <Card>
              <View style={[s.between, { marginBottom: 16 }]}>
                <View>
                  <Text style={s.h3}>
                    회사에서 출발해, 회사로 돌아오는 코스
                  </Text>
                  <Text style={[s.muted, { marginTop: 6 }]}>
                    {data.company.address}
                  </Text>
                </View>
                <Building2 size={25} color={C.green} />
              </View>
              <View style={st.miniRoute}>
                <Text
                  style={{ fontSize: 11, color: C.green, fontWeight: "700" }}
                >
                  회사 출발
                </Text>
                <ArrowRight size={15} color={C.green} />
                <Text
                  style={{ fontSize: 11, color: C.green, fontWeight: "700" }}
                >
                  배송지 순회
                </Text>
                <ArrowRight size={15} color={C.green} />
                <Text
                  style={{ fontSize: 11, color: C.green, fontWeight: "700" }}
                >
                  회사 복귀
                </Text>
              </View>
              <Text style={[s.muted, { marginVertical: 13 }]}>
                기사별 최대 배송지 수 안에서 가까운 배송지를 묶고 순서를
                개선합니다. 전역 최적해나 실시간 교통을 보장하지 않습니다.
              </Text>
              <Button
                title={`추천 배차 생성 · ${data.stats.pending}곳 미배차`}
                icon={RouteIcon}
                disabled={busy || !!data.stats.active}
                onPress={() =>
                  run(async () => {
                    await post("/api/routes/optimize", { serviceDate: date });
                    await refresh();
                  })
                }
              />
              {data.stats.active > 0 && (
                <Text style={[s.muted, { color: C.amber, marginTop: 10 }]}>
                  운행 중인 코스는 회사 복귀 후 재배차할 수 있어요.
                </Text>
              )}
            </Card>
            <DateControls date={date} setDate={setDate} />
            {!data.routes.length && (
              <Empty
                title="아직 배차된 코스가 없어요"
                description="전표를 등록하고 좌표 확인을 마친 뒤 추천 배차를 생성해 주세요."
                action={
                  <Button
                    title="전표 등록하기"
                    secondary
                    onPress={() => setTab("upload")}
                  />
                }
              />
            )}
            {data.routes.map((route, i) => (
              <Card key={route.id}>
                <View style={s.between}>
                  <View style={s.row}>
                    <View
                      style={[
                        st.routeNumber,
                        {
                          backgroundColor: [
                            "#edf5ea",
                            "#eef0fa",
                            "#fff4e4",
                            "#f5edf5",
                            "#e9f4f8",
                          ][i % 5],
                        },
                      ]}
                    >
                      <Text
                        style={{
                          fontSize: 19,
                          color: C.green,
                          fontWeight: "800",
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </Text>
                    </View>
                    <View>
                      <Text style={s.h3}>{route.driverName} 코스</Text>
                      <Text style={s.muted}>
                        {route.stops.length}곳 · {route.distanceKm}km ·{" "}
                        {formatTime(route.durationMinutes)}
                      </Text>
                    </View>
                  </View>
                  {routeStatus(route)}
                </View>
                <View style={[s.row, { marginTop: 12, marginBottom: 16 }]}>
                  <Badge text="회사 왕복 포함" />
                  <Badge
                    text={
                      route.estimateSource === "road"
                        ? "도로 기준 예상"
                        : "대략적 예상"
                    }
                    tone={route.estimateSource === "road" ? "grey" : "amber"}
                  />
                </View>
                <TimelineCompany name={route.company.name} label="출발" />
                {route.stops.map((stop, index) => (
                  <View key={stop.id} style={st.stopRow}>
                    <Pressable
                      onPress={() => setDetail(stop)}
                      style={[s.row, { flex: 1, alignItems: "flex-start" }]}
                    >
                      <View
                        style={[
                          st.stopIndex,
                          stop.status === "delivered" && {
                            backgroundColor: C.green,
                          },
                        ]}
                      >
                        {stop.status === "delivered" ? (
                          <Check size={13} color="white" />
                        ) : (
                          <Text
                            style={{
                              color: C.green,
                              fontSize: 11,
                              fontWeight: "700",
                            }}
                          >
                            {index + 1}
                          </Text>
                        )}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[s.h3, { fontSize: 13 }]}>
                          {stop.recipient}
                        </Text>
                        <Text style={s.muted}>{stop.address}</Text>
                        <Text
                          style={{ color: C.green, fontSize: 10, marginTop: 4 }}
                        >
                          {stop.items
                            .map((item) => `${item.name} ${item.quantity}`)
                            .join(" · ")}
                        </Text>
                      </View>
                    </Pressable>
                    {route.status === "planned" && (
                      <View style={{ gap: 5 }}>
                        <Pressable
                          accessibilityLabel={`${stop.recipient} 순서 올리기`}
                          disabled={index === 0 || busy}
                          onPress={() =>
                            run(async () => {
                              const ids = route.stops.map((s) => s.id);
                              [ids[index - 1], ids[index]] = [
                                ids[index],
                                ids[index - 1],
                              ];
                              await post(
                                "/api/routes/" + route.id + "/reorder",
                                { stopIds: ids },
                              );
                              await refresh();
                            })
                          }
                          style={[
                            st.orderButton,
                            index === 0 && { opacity: 0.25 },
                          ]}
                        >
                          <ArrowUp size={14} color={C.green} />
                        </Pressable>
                        <Pressable
                          accessibilityLabel={`${stop.recipient} 순서 내리기`}
                          disabled={index === route.stops.length - 1 || busy}
                          onPress={() =>
                            run(async () => {
                              const ids = route.stops.map((s) => s.id);
                              [ids[index], ids[index + 1]] = [
                                ids[index + 1],
                                ids[index],
                              ];
                              await post(
                                "/api/routes/" + route.id + "/reorder",
                                { stopIds: ids },
                              );
                              await refresh();
                            })
                          }
                          style={[
                            st.orderButton,
                            index === route.stops.length - 1 && {
                              opacity: 0.25,
                            },
                          ]}
                        >
                          <ArrowDown size={14} color={C.green} />
                        </Pressable>
                      </View>
                    )}
                  </View>
                ))}
                <TimelineCompany name={route.company.name} label="복귀" />
              </Card>
            ))}
            {data.shipments
              .filter((s) => s.status === "pending")
              .map((shipment) => (
                <Pressable
                  key={shipment.id}
                  onPress={() =>
                    setReview({
                      fileName: "배송지 수정",
                      id: undefined,
                      drafts: [shipment],
                      serviceDate: date,
                      status: "edit",
                    })
                  }
                >
                  <Card>
                    <View style={s.between}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.h3}>{shipment.recipient}</Text>
                        <Text style={s.muted}>{shipment.address}</Text>
                      </View>
                      <Badge
                        text={
                          shipment.lat == null ? "주소 확인 필요" : "미배차"
                        }
                        tone={shipment.lat == null ? "amber" : "grey"}
                      />
                    </View>
                  </Card>
                </Pressable>
              ))}
          </>
        )}
        {tab === "drivers" && (
          <>
            <Card>
              <View style={s.between}>
                <View>
                  <Text style={s.h2}>
                    {data.drivers.filter((d) => d.active).length}명의 기사님
                  </Text>
                  <Text style={[s.muted, { marginTop: 7 }]}>
                    기사와 최대 배송지 수를 자유롭게 늘릴 수 있어요.
                  </Text>
                </View>
                <View style={st.logoSmall}>
                  <Users size={24} color={C.green} />
                </View>
              </View>
              <View style={{ marginTop: 19 }}>
                <Button
                  title="기사 추가 · PIN 발급"
                  icon={Plus}
                  onPress={() =>
                    setDriverEdit({ name: "", phone: "", capacity: 10 })
                  }
                />
              </View>
            </Card>
            {data.drivers.map((driver) => (
              <Card key={driver.id}>
                <View style={s.between}>
                  <View style={s.row}>
                    <Avatar name={driver.name} />
                    <View>
                      <Text style={s.h3}>{driver.name}</Text>
                      <Text style={s.muted}>
                        {driver.phone || "연락처 미등록"}
                      </Text>
                    </View>
                  </View>
                  <Badge
                    text={driver.active ? "사용 중" : "비활성"}
                    tone={driver.active ? "green" : "grey"}
                  />
                </View>
                <View style={[s.row, { marginTop: 18, marginBottom: 16 }]}>
                  <Package size={15} color={C.muted} />
                  <Text style={s.muted}>
                    한 코스 최대 {driver.capacity}곳 · PIN은 안전하게 보관 중
                  </Text>
                </View>
                <View style={{ marginBottom: 10 }}>
                  <Button
                    title="PIN 보기"
                    secondary
                    small
                    disabled={busy}
                    onPress={() =>
                      run(async () => {
                        const result = await api<{ pin: string | null }>(
                          "/api/drivers/" + driver.id + "/pin",
                        );
                        if (!result.pin)
                          throw new Error(
                            "아직 확인할 PIN 정보가 없습니다. 기사가 한 번 로그인한 뒤 다시 확인하거나 새 PIN을 발급해 주세요.",
                          );
                        setPins([{ name: driver.name, pin: result.pin }]);
                      })
                    }
                  />
                </View>
                <View style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="기사 정보 수정"
                      secondary
                      small
                      onPress={() => setDriverEdit(driver)}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button
                      title="새 PIN 발급"
                      secondary
                      small
                      disabled={busy}
                      onPress={() =>
                        run(async () => {
                          const result = await post(
                            "/api/drivers/" + driver.id + "/pin",
                          );
                          setPins([{ name: driver.name, pin: result.pin }]);
                        })
                      }
                    />
                  </View>
                </View>
              </Card>
            ))}
          </>
        )}
        {tab === "history" && (
          <>
            <DateControls date={date} setDate={setDate} />
            <View style={[s.row, { marginBottom: 20 }]}>
              <Badge text={`완료 ${data.stats.delivered}곳`} />
              <Badge
                text={`미배송 ${data.stats.failed}곳`}
                tone={data.stats.failed ? "red" : "grey"}
              />
              <Badge text={`전체 ${data.stats.total}곳`} tone="grey" />
            </View>
            <Text style={s.section}>배송 내역 · {date}</Text>
            {!data.shipments.length && (
              <Empty
                title="이 날짜에는 배송 내역이 없어요"
                description="이전 날짜를 선택하거나 전표를 등록해 주세요."
              />
            )}
            {data.shipments.map((stop) => (
              <Pressable key={stop.id} onPress={() => setDetail(stop)}>
                <Card>
                  <View style={s.between}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.h3}>{stop.recipient}</Text>
                      <Text style={s.muted}>{stop.address}</Text>
                      <Text style={[s.muted, { marginTop: 5, color: C.green }]}>
                        {stop.items
                          .map((item) => `${item.name} ${item.quantity}`)
                          .join(" · ")}
                      </Text>
                    </View>
                    <Badge
                      text={statusName[stop.status]}
                      tone={
                        stop.status === "failed"
                          ? "red"
                          : stop.status === "delivered"
                            ? "green"
                            : "grey"
                      }
                    />
                  </View>
                  {stop.deliveredAt && (
                    <Text style={[s.muted, { marginTop: 10, fontSize: 10 }]}>
                      {new Date(stop.deliveredAt).toLocaleString("ko-KR", {
                        timeZone: "Asia/Seoul",
                      })}{" "}
                      처리
                    </Text>
                  )}
                </Card>
              </Pressable>
            ))}
            <Text style={[s.section, { marginTop: 20 }]}>
              업로드 내역 · {date}
            </Text>
            {imports.map((batch) => (
              <Card key={batch.id}>
                <View style={s.between}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.h3}>{batch.fileName}</Text>
                    <Text style={s.muted}>
                      {batch.serviceDate} ·{" "}
                      {batch.status === "committed"
                        ? `${batch.count}곳 등록`
                        : "검토 대기"}
                    </Text>
                  </View>
                  <Badge
                    text={
                      batch.status === "committed" ? "등록 완료" : "확인 필요"
                    }
                    tone={batch.status === "committed" ? "green" : "amber"}
                  />
                </View>
                <View style={[s.row, { marginTop: 13 }]}>
                  {batch.status === "review" && (
                    <Button
                      title="내용 확인"
                      secondary
                      small
                      onPress={() =>
                        run(async () =>
                          setReview(await api("/api/imports/" + batch.id)),
                        )
                      }
                    />
                  )}
                  <Button
                    title="원본 받기"
                    secondary
                    small
                    onPress={() =>
                      run(async () => {
                        const result = await api(
                          "/api/imports/" + batch.id + "/original",
                        );
                        await download(result.path, batch.fileName);
                      })
                    }
                  />
                </View>
              </Card>
            ))}
          </>
        )}
        <View style={{ height: 30 }} />
      </ScrollView>
      <SafeAreaView edges={["bottom"]} style={st.tabBar}>
        <View
          style={{
            flexDirection: "row",
            width: "100%",
            maxWidth: 780,
            alignSelf: "center",
          }}
        >
          {tabs.map(({ id, label, icon: Icon }) => (
            <Pressable
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === id }}
              accessibilityLabel={label}
              key={id}
              onPress={() => setTab(id)}
              style={st.tab}
            >
              <View
                style={[
                  st.tabIcon,
                  tab === id && { backgroundColor: "#e8f0df" },
                ]}
              >
                <Icon size={21} color={tab === id ? C.green : "#87958f"} />
              </View>
              <Text
                style={{
                  fontSize: 10,
                  fontWeight: tab === id ? "800" : "500",
                  color: tab === id ? C.green : C.muted,
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>
      <Sheet
        title={review?.fileName ?? "전표 확인"}
        visible={!!review}
        onClose={() => setReview(null)}
      >
        {review && (
          <>
            <View style={st.demoBanner}>
              <ShieldCheck color={C.green} size={19} />
              <Text style={[s.muted, { flex: 1, color: C.green }]}>
                수령인·주소·물품을 원본과 대조해 주세요. 확인하기 전에는
                배송지로 등록되지 않아요.
              </Text>
            </View>
            <View style={{ marginBottom: 16 }}>
              <Button
                title="좌표 없는 주소 전체 확인"
                secondary
                icon={MapPin}
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    let failures = 0;
                    for (let i = 0; i < review.drafts.length; i++) {
                      const row = review.drafts[i];
                      if (row.lat != null && row.lng != null) continue;
                      try {
                        const point = await post("/api/geocode", {
                          address: row.address,
                        });
                        updateReview(i, point);
                      } catch {
                        failures++;
                      }
                    }
                    if (failures)
                      tell(
                        `${failures}곳의 주소를 찾지 못했어요. 주소를 수정하거나 위도·경도를 직접 입력해 주세요.`,
                      );
                  })
                }
              />
            </View>
            {review.rawText ? (
              <Card>
                <Text style={[s.h3, { marginBottom: 9 }]}>
                  사진에서 인식한 원문
                </Text>
                <Text selectable style={s.muted}>
                  {review.rawText}
                </Text>
              </Card>
            ) : null}
            {review.drafts.map((row, index) => (
              <Card key={index}>
                <View style={[s.between, { marginBottom: 17 }]}>
                  <Text style={s.h3}>배송지 {index + 1}</Text>
                  {review.drafts.length > 1 && (
                    <Pressable
                      accessibilityLabel="이 배송지 제외"
                      onPress={() =>
                        setReview({
                          ...review,
                          drafts: review.drafts.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 size={17} color={C.red} />
                    </Pressable>
                  )}
                </View>
                <Field
                  label="수령인 / 거래처"
                  value={row.recipient}
                  onChangeText={(recipient) =>
                    updateReview(index, { recipient })
                  }
                />
                <Field
                  label="배송주소"
                  value={row.address}
                  onChangeText={(address) =>
                    updateReview(index, { address, lat: null, lng: null })
                  }
                  multiline
                />
                <Field
                  label="연락처"
                  value={row.phone ?? ""}
                  onChangeText={(phone) => updateReview(index, { phone })}
                />
                {row.items.map((item, i) => (
                  <View key={i} style={[s.row, { alignItems: "flex-start" }]}>
                    <View style={{ flex: 1 }}>
                      <Field
                        label={`물품 ${i + 1}`}
                        value={item.name}
                        onChangeText={(name) =>
                          updateReview(index, {
                            items: row.items.map((v, j) =>
                              j === i ? { ...v, name } : v,
                            ),
                          })
                        }
                      />
                    </View>
                    <View style={{ width: 75 }}>
                      <Field
                        label="수량"
                        value={String(item.quantity)}
                        numeric
                        onChangeText={(quantity) =>
                          updateReview(index, {
                            items: row.items.map((v, j) =>
                              j === i
                                ? { ...v, quantity: Number(quantity) }
                                : v,
                            ),
                          })
                        }
                      />
                    </View>
                    {row.items.length > 1 && (
                      <Pressable
                        accessibilityLabel="물품 삭제"
                        onPress={() =>
                          updateReview(index, {
                            items: row.items.filter((_, j) => j !== i),
                          })
                        }
                        style={{ paddingTop: 34 }}
                      >
                        <X size={17} color={C.muted} />
                      </Pressable>
                    )}
                  </View>
                ))}
                <Button
                  title="물품 추가"
                  secondary
                  small
                  icon={Plus}
                  onPress={() =>
                    updateReview(index, {
                      items: [...row.items, { name: "", quantity: 1 }],
                    })
                  }
                />
                <View style={s.divider} />
                <Field
                  label="요청사항"
                  value={row.notes ?? ""}
                  onChangeText={(notes) => updateReview(index, { notes })}
                />
                <View style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="위도 (직접 입력 가능)"
                      value={row.lat == null ? "" : String(row.lat)}
                      onChangeText={(lat) =>
                        updateReview(index, {
                          lat: lat === "" ? null : Number(lat),
                        })
                      }
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Field
                      label="경도"
                      value={row.lng == null ? "" : String(row.lng)}
                      onChangeText={(lng) =>
                        updateReview(index, {
                          lng: lng === "" ? null : Number(lng),
                        })
                      }
                    />
                  </View>
                </View>
                <Button
                  title={
                    row.lat != null ? "주소 좌표 다시 확인" : "주소로 좌표 찾기"
                  }
                  secondary
                  icon={MapPin}
                  disabled={busy || !row.address}
                  onPress={() => locateRow(index)}
                />
              </Card>
            ))}
            <Text style={[s.muted, { marginBottom: 15 }]}>
              좌표가 없는 배송지도 저장할 수 있어요. 추천 배차 전에는 모든
              주소의 좌표 확인이 필요합니다.
            </Text>
            <Button
              title={`${review.drafts.length}곳 확인하고 ${review.status === "edit" ? "저장" : "배송지 등록"}`}
              icon={Check}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  if (review.status === "edit") {
                    const row = review.drafts[0] as Shipment;
                    await patch("/api/shipments/" + row.id, row);
                  } else if (review.id)
                    await post("/api/imports/" + review.id + "/commit", {
                      rows: review.drafts,
                    });
                  else
                    await post("/api/shipments", {
                      serviceDate: review.serviceDate,
                      rows: review.drafts,
                    });
                  setReview(null);
                  await refresh();
                })
              }
            />
            {review.status !== "edit" && (
              <View style={{ marginTop: 10 }}>
                <Button
                  title="배송지 더 추가"
                  secondary
                  icon={Plus}
                  onPress={() =>
                    setReview({
                      ...review,
                      drafts: [...review.drafts, blankShipment()],
                    })
                  }
                />
              </View>
            )}
          </>
        )}
      </Sheet>
      <Sheet
        title="회사 · 배송 설정"
        visible={!!company}
        onClose={() => setCompany(null)}
      >
        {company && (
          <>
            <Field
              label="회사명"
              value={company.name}
              onChangeText={(name) => setCompany({ ...company, name })}
            />
            <Field
              label="회사 출발·복귀 주소"
              value={company.address}
              onChangeText={(address) =>
                setCompany({ ...company, address, lat: NaN, lng: NaN })
              }
              multiline
            />
            <Button
              title="회사 주소로 좌표 확인"
              secondary
              icon={MapPin}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  const point = await post("/api/geocode", {
                    address: company.address,
                  });
                  setCompany({ ...company, ...point });
                })
              }
            />
            <View style={[s.row, { marginTop: 15 }]}>
              <View style={{ flex: 1 }}>
                <Field
                  label="출발지 위도"
                  value={
                    Number.isFinite(company.lat) ? String(company.lat) : ""
                  }
                  onChangeText={(lat) =>
                    setCompany({
                      ...company,
                      lat: lat === "" ? NaN : Number(lat),
                    })
                  }
                />
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label="출발지 경도"
                  value={
                    Number.isFinite(company.lng) ? String(company.lng) : ""
                  }
                  onChangeText={(lng) =>
                    setCompany({
                      ...company,
                      lng: lng === "" ? NaN : Number(lng),
                    })
                  }
                />
              </View>
            </View>
            <Field
              label="배송지당 예상 체류 시간 (분)"
              numeric
              value={String(company.serviceMinutes)}
              onChangeText={(v) =>
                setCompany({ ...company, serviceMinutes: Number(v) })
              }
            />
            <Text style={[s.label, { marginBottom: 10 }]}>길안내 앱</Text>
            <View style={[s.row, { marginBottom: 24, flexWrap: "wrap" }]}>
              {[
                ["kakao", "카카오맵"],
                ["naver", "네이버지도"],
                ["default", "기본 지도"],
              ].map(([id, label]) => (
                <Chip
                  key={id}
                  label={label}
                  selected={company.navigation === id}
                  onPress={() =>
                    setCompany({ ...company, navigation: id as any })
                  }
                />
              ))}
            </View>
            <Text style={[s.muted, { marginBottom: 20 }]}>
              모든 코스는 이 회사에서 출발하고 복귀합니다. 출발 전 배차는 설정
              변경 후 다시 생성해 주세요. 운행 중에는 출발지를 변경할 수 없어요.
              예상 시간은 배송지 체류와 회사 복귀를 포함하며 실시간 교통은
              반영하지 않습니다.
            </Text>
            <Button
              title="회사 설정 저장"
              icon={Check}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await api("/api/company", {
                    method: "PUT",
                    body: JSON.stringify(company),
                  });
                  setCompany(null);
                  await refresh();
                })
              }
            />
            {data.demo && (
              <View style={{ marginTop: 24 }}>
                <Text style={[s.muted, { marginBottom: 12 }]}>
                  실제 배송 전 예시 기사와 예시 배송지를 지워 주세요. 실제
                  전표가 업로드된 후에는 데이터 보호를 위해 전체 예시 삭제가
                  제한됩니다.
                </Text>
                <Button
                  title={
                    confirmClear
                      ? "한 번 더 눌러 예시 데이터 삭제"
                      : "예시 데이터 전체 삭제"
                  }
                  danger
                  secondary
                  disabled={busy}
                  onPress={() => {
                    if (!confirmClear) {
                      setConfirmClear(true);
                      return;
                    }
                    run(async () => {
                      await post("/api/demo/clear");
                      setCompany(null);
                      await refresh();
                    });
                  }}
                />
              </View>
            )}
          </>
        )}
      </Sheet>
      <Sheet
        title={driverEdit?.id ? "기사 정보 수정" : "새 기사 추가"}
        visible={!!driverEdit}
        onClose={() => setDriverEdit(null)}
      >
        {driverEdit && (
          <>
            <Field
              label="기사 이름"
              value={driverEdit.name ?? ""}
              onChangeText={(name) => setDriverEdit({ ...driverEdit, name })}
            />
            <Field
              label="연락처"
              value={driverEdit.phone ?? ""}
              onChangeText={(phone) => setDriverEdit({ ...driverEdit, phone })}
            />
            <Field
              label="한 코스 최대 배송지 수"
              value={String(driverEdit.capacity ?? 10)}
              numeric
              onChangeText={(v) =>
                setDriverEdit({ ...driverEdit, capacity: Number(v) })
              }
            />
            {!driverEdit.id && (
              <Field
                label="기사 PIN (비워 두면 자동 발급)"
                value={driverEdit.pin ?? ""}
                numeric
                onChangeText={(v) =>
                  setDriverEdit({
                    ...driverEdit,
                    pin: v.replace(/\D/g, "").slice(0, 12),
                  })
                }
              />
            )}
            <Text style={[s.muted, { marginBottom: 20 }]}>
              처음에는 최대 10곳을 권장합니다. 배송지가 늘어나면 이 수를
              변경하거나 새 기사를 추가해 주세요.
            </Text>
            {driverEdit.id && (
              <View style={[s.between, { marginBottom: 23 }]}>
                <Text style={s.h3}>기사 계정 사용</Text>
                <Switch
                  value={driverEdit.active ?? true}
                  onValueChange={(active) =>
                    setDriverEdit({ ...driverEdit, active })
                  }
                  trackColor={{ true: C.green }}
                />
              </View>
            )}
            <Button
              title={
                driverEdit.id ? "기사 정보 저장" : "기사 등록하고 PIN 발급"
              }
              icon={Check}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  if (driverEdit.id)
                    await patch("/api/drivers/" + driverEdit.id, driverEdit);
                  else {
                    const result = await post("/api/drivers", {
                      ...driverEdit,
                      pin: driverEdit.pin || undefined,
                    });
                    setPins([{ name: result.name, pin: result.pin }]);
                  }
                  setDriverEdit(null);
                  await refresh();
                })
              }
            />
          </>
        )}
      </Sheet>
      <Sheet
        title="기사 PIN 확인"
        visible={!!pins}
        onClose={() => setPins(null)}
      >
        <Text style={[s.muted, { marginBottom: 20 }]}>
          관리자만 기사 메뉴의 PIN 보기에서 다시 확인할 수 있어요. 해당 기사에게
          개별 전달해 주세요. PIN 재발급 시 이전 로그인이 해제됩니다.
        </Text>
        {pins?.map((pin, i) => (
          <Card key={i}>
            <Text style={s.h3}>{pin.name}</Text>
            <Text
              selectable
              style={{
                marginTop: 10,
                fontSize: 25,
                fontWeight: "800",
                letterSpacing: 2,
                color: C.green,
              }}
            >
              {pin.pin}
            </Text>
          </Card>
        ))}
        <Button title="확인했어요" onPress={() => setPins(null)} />
      </Sheet>
      <Sheet
        title="배송 상세"
        visible={!!detail}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <Badge
              text={statusName[detail.status]}
              tone={detail.status === "failed" ? "red" : "green"}
            />
            <Text style={[s.h2, { marginTop: 15, marginBottom: 10 }]}>
              {detail.recipient}
            </Text>
            <Text style={{ color: C.ink, fontSize: 14, lineHeight: 23 }}>
              {detail.address}
            </Text>
            {detail.phone && (
              <Text style={[s.muted, { marginTop: 8 }]}>{detail.phone}</Text>
            )}
            <View style={s.divider} />
            <Text style={[s.h3, { marginBottom: 15 }]}>배송 물품</Text>
            {detail.items.map((item, i) => (
              <View key={i} style={[s.between, { paddingVertical: 8 }]}>
                <Text style={{ color: C.ink }}>{item.name}</Text>
                <Text style={{ color: C.green, fontWeight: "700" }}>
                  {item.quantity}개
                </Text>
              </View>
            ))}
            {detail.notes ? (
              <Text style={[s.muted, { marginTop: 17 }]}>{detail.notes}</Text>
            ) : null}
            {detail.failureReason && (
              <Text style={{ color: C.red, marginTop: 18 }}>
                미배송 사유: {detail.failureReason}
              </Text>
            )}
            {detail.status === "assigned" &&
              data.routes.find((r) => r.id === detail.routeId)?.status ===
                "planned" && (
                <>
                  <View style={s.divider} />
                  <Text style={[s.h3, { marginBottom: 13 }]}>
                    다른 기사 코스로 옮기기
                  </Text>
                  {data.routes
                    .filter(
                      (r) => r.id !== detail.routeId && r.status === "planned",
                    )
                    .map((r) => (
                      <View key={r.id} style={{ marginBottom: 8 }}>
                        <Button
                          title={`${r.driverName} · 현재 ${r.stops.length}곳`}
                          secondary
                          disabled={busy}
                          onPress={() =>
                            run(async () => {
                              await post("/api/routes/move-stop", {
                                shipmentId: detail.id,
                                targetRouteId: r.id,
                              });
                              setDetail(null);
                              await refresh();
                            })
                          }
                        />
                      </View>
                    ))}
                </>
              )}
          </>
        )}
      </Sheet>
    </View>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: number;
  icon: any;
  accent?: boolean;
}) {
  return (
    <View
      style={[
        st.stat,
        accent && { backgroundColor: "#eaf3df", borderColor: "#dfe9d3" },
      ]}
    >
      <Icon size={17} color={accent ? C.green : C.muted} />
      <Text style={[s.num, accent && { color: C.green }]}>
        {String(value).padStart(2, "0")}
      </Text>
      <Text style={{ fontSize: 11, color: C.muted }}>{label}</Text>
    </View>
  );
}
function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[
        st.chip,
        selected && { backgroundColor: C.green, borderColor: C.green },
      ]}
    >
      <Text
        style={{
          fontSize: 11,
          fontWeight: "700",
          color: selected ? C.white : C.muted,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function Avatar({ name }: { name: string }) {
  return (
    <View style={st.avatar}>
      <Text style={{ color: C.green, fontSize: 15, fontWeight: "800" }}>
        {name.replace(/\s/g, "").slice(-2)}
      </Text>
    </View>
  );
}
function TimelineCompany({ name, label }: { name: string; label: string }) {
  return (
    <View style={[s.row, { paddingVertical: 11 }]}>
      <View style={st.companyPin}>
        <Building2 size={14} color={C.green} />
      </View>
      <Text style={{ fontSize: 12, color: C.ink, fontWeight: "700" }}>
        {name}
      </Text>
      <Text style={s.muted}>{label}</Text>
    </View>
  );
}
function DateControls({
  date,
  setDate,
}: {
  date: string;
  setDate: (s: string) => void;
}) {
  const shift = (offset: number) => {
    const next = new Date(date + "T12:00:00+09:00");
    next.setUTCDate(next.getUTCDate() + offset);
    setDate(
      new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(next),
    );
  };
  return (
    <View style={[s.between, { marginVertical: 15 }]}>
      <Pressable
        accessibilityLabel="이전 날짜"
        onPress={() => shift(-1)}
        style={st.iconButton}
      >
        <ArrowLeft color={C.green} size={19} />
      </Pressable>
      <Pressable onPress={() => setDate(koreanDate())}>
        <Text style={{ color: C.ink, fontSize: 14, fontWeight: "700" }}>
          {date} {date === koreanDate() ? "· 오늘" : ""}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel="다음 날짜"
        onPress={() => shift(1)}
        style={st.iconButton}
      >
        <ArrowRight color={C.green} size={19} />
      </Pressable>
    </View>
  );
}

function DriverApp({
  user,
  logout,
  run,
  busy,
  tell,
}: {
  user: Session;
  logout: () => void;
  run: Run;
  busy: boolean;
  tell: (s: string) => void;
}) {
  const [data, setData] = useState<{
      route: Route | null;
      company: Company;
    } | null>(null),
    [mode, setMode] = useState<string>(trackingMode),
    [failed, setFailed] = useState<Shipment | null>(null),
    [overview, setOverview] = useState(false),
    [automation, setAutomation] = useState<DriverAutomation | null>(null),
    [reason, setReason] = useState("");
  const refresh = useCallback(async () => {
    const [current, settings] = await Promise.all([
      api<{ route: Route | null; company: Company }>("/api/me"),
      getDriverAutomation(),
    ]);
    setData(current);
    setAutomation(settings);
  }, []);
  useEffect(() => {
    restoreTrackingMode()
      .then(setMode)
      .catch(() => {});
    refresh().catch((e) => tell(e.message));
    const interval = setInterval(() => refresh().catch(() => {}), 15000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh().catch(() => {});
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [refresh]);
  useEffect(
    () =>
      connectLive((event) => {
        if (event.event === "changed") refresh().catch(() => {});
      }),
    [refresh],
  );
  useEffect(() => {
    if (
      data &&
      !["active", "returning"].includes(data.route?.status ?? "") &&
      mode !== "off"
    )
      stopTracking()
        .then(() => setMode("off"))
        .catch(() => {});
  }, [!!data, data?.route?.status, mode]);
  if (!data) return <Loading />;
  const route = data.route,
    company = route?.company ?? data.company,
    remaining = route?.stops.filter((s) => s.status === "assigned") ?? [],
    next = remaining[0],
    completed =
      route?.stops.filter((s) => s.status === "delivered").length ?? 0,
    active = !!route && ["active", "returning"].includes(route.status);
  const share = async () => {
    const result = await startTracking(tell);
    setMode(result);
    return result;
  };
  const continuous =
    !!automation && automation.routeId === route?.id && automation.continuous;
  const automatic =
    !!automation && automation.routeId === route?.id && automation.enabled;
  const openCourse = async (current: Route, enableAutomatic = true) => {
    const settings = await configureDriverAutomation(
      current.id,
      enableAutomatic,
    );
    setAutomation(settings);
    const sharing = mode === "background" ? mode : await share();
    if (Platform.OS !== "web" && sharing !== "background")
      throw new Error(
        "내비를 사용하는 동안 자동 완료하려면 위치 권한을 항상 허용하고 알림 권한을 켜 주세요.",
      );
    await navigateCourse(current);
    setAutomation(await getDriverAutomation());
  };
  const openNext = async (current: Route) => {
    const upcoming = current.stops.find((s) => s.status === "assigned");
    await navigate((upcoming as any) ?? current.company, current.company);
  };
  const complete = (
    stop: Shipment,
    status = "delivered",
    failureReason?: string,
  ) =>
    run(async () => {
      const updated = await post<Route>(
        "/api/driver/stops/" + stop.id + "/complete",
        { status, reason: failureReason },
      );
      setData({ ...data, route: updated });
      setFailed(null);
      setReason("");
      await recordHandledStop(updated.id, stop);
      if (continuous) {
        if (status === "failed" || automation?.segmentEndStopId === stop.id)
          await navigateCourse(updated);
      } else await openNext(updated);
    });
  return (
    <View style={{ flex: 1 }}>
      <View style={st.top}>
        <View style={s.row}>
          <View style={st.logoSmall}>
            <Truck size={23} color={C.green} />
          </View>
          <View>
            <Text style={s.h3}>바른배차</Text>
            <Text style={s.muted}>{user.name}님, 안전 운전하세요.</Text>
          </View>
        </View>
        <Pressable
          accessibilityLabel="로그아웃"
          onPress={logout}
          style={st.iconButton}
        >
          <LogOut size={20} color={C.muted} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={[
          st.content,
          { maxWidth: 700, paddingBottom: 45 },
        ]}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => run(refresh)} />
        }
      >
        <View style={[s.between, { marginBottom: 21 }]}>
          <Text style={s.h1}>나의 배송 코스</Text>
          {route && (
            <Badge
              text={statusName[route.status]}
              tone={route.status === "returning" ? "amber" : "green"}
            />
          )}
        </View>
        {!route ? (
          <Empty
            title="아직 배정된 코스가 없어요"
            description="관리자가 배차하면 이곳에서 배송지와 물품을 확인할 수 있어요."
            action={
              <Button
                title="새로고침"
                secondary
                icon={RefreshCw}
                onPress={() => run(refresh)}
              />
            }
          />
        ) : (
          <>
            <Card
              style={{
                backgroundColor: C.ink,
                borderColor: C.ink,
                padding: 25,
              }}
            >
              <Text
                style={{ color: "#b6c7bf", fontSize: 11, letterSpacing: 1 }}
              >
                TODAY'S JOURNEY · {route.serviceDate}
              </Text>
              <Text
                style={{
                  fontSize: 30,
                  fontWeight: "800",
                  color: C.white,
                  marginVertical: 13,
                }}
              >
                {route.status === "returning"
                  ? "이제 회사로 돌아가요"
                  : route.status === "completed"
                    ? "오늘도 수고하셨어요"
                    : `${route.stops.length}곳의 배송을 함께해요`}
              </Text>
              <View style={s.row}>
                <Text
                  style={{ fontSize: 13, color: C.lime, fontWeight: "700" }}
                >
                  {route.distanceKm}km
                </Text>
                <Text style={{ fontSize: 13, color: C.lime }}>·</Text>
                <Text
                  style={{ fontSize: 13, color: C.lime, fontWeight: "700" }}
                >
                  {formatTime(route.durationMinutes)}
                </Text>
                <Text style={{ fontSize: 11, color: "#b6c7bf" }}>
                  회사 복귀 포함
                </Text>
              </View>
              <Text
                style={{
                  fontSize: 10,
                  color: "#9eb2ab",
                  lineHeight: 17,
                  marginTop: 12,
                }}
              >
                {route.estimateSource === "approximate"
                  ? "대략적 예상 · 도로 정보를 가져오지 못해 거리로 추정했어요."
                  : "도로 기준 예상 · 배송지 체류 포함, 실시간 교통 미반영"}
              </Text>
            </Card>
            <CargoSummary stops={route.stops} />
            <Text style={[s.h3, { marginBottom: 10 }]}>전체 경로 미리보기</Text>
            <MapPanel
              data={{
                company,
                routes: [route],
                drivers: [],
                nextStopId: next?.id,
              }}
              height={280}
            />
            <View style={{ marginTop: 10 }}>
              <Button
                title="전체 경로 크게 보기"
                secondary
                icon={RouteIcon}
                onPress={() => setOverview(true)}
              />
            </View>
            <View style={[s.between, { marginTop: 17, marginBottom: 9 }]}>
              <Text style={s.h3}>
                완료 {completed} / {route.stops.length}곳
              </Text>
              <Text style={s.muted}>{remaining.length}곳 남음</Text>
            </View>
            <View style={[st.progress, { marginBottom: 20 }]}>
              <View
                style={[
                  st.progressFill,
                  {
                    width: `${route.stops.length ? (completed / route.stops.length) * 100 : 0}%`,
                  },
                ]}
              />
            </View>
            {active && (
              <Card>
                <View style={[s.row, { marginBottom: 11 }]}>
                  <LocateFixed
                    size={19}
                    color={mode === "off" ? C.amber : C.green}
                  />
                  <Text style={s.h3}>
                    {mode === "background"
                      ? "배송 위치 공유 중"
                      : mode === "foreground"
                        ? "앱을 열어 둔 동안 위치 공유 중"
                        : "위치 공유가 꺼져 있어요"}
                  </Text>
                </View>
                <Text style={[s.muted, { marginBottom: 13 }]}>
                  {mode === "background"
                    ? "길안내 앱을 사용하는 동안에도 관리자에게 위치를 공유합니다."
                    : "백그라운드 권한과 별도 앱 빌드가 없으면 길안내 앱으로 전환할 때 위치 수신이 멈출 수 있어요."}
                </Text>
                <Button
                  title={
                    mode === "off"
                      ? "위치 공유 켜기"
                      : "위치 권한 · 공유 다시 확인"
                  }
                  secondary
                  icon={LocateFixed}
                  disabled={busy}
                  onPress={() => run(share)}
                />
                <View style={{ marginTop: 14, gap: 10 }}>
                  <Button
                    title="네이버로 남은 코스 연속 안내"
                    icon={Navigation}
                    disabled={busy}
                    onPress={() => run(() => openCourse(route, true))}
                  />
                  <View style={s.between}>
                    <Text style={[s.h3, { flex: 1 }]}>
                      GPS 도착 시 자동 배송 완료
                    </Text>
                    <Switch
                      accessibilityLabel="GPS 도착 자동 완료"
                      value={!!automatic}
                      disabled={busy}
                      onValueChange={(enabled) =>
                        run(async () => {
                          setAutomation(
                            await configureDriverAutomation(route.id, enabled),
                          );
                          if (enabled && mode === "off") await share();
                        })
                      }
                    />
                  </View>
                  <Text style={s.muted}>
                    정확한 위치로 배송지 80m 이내에서 30초 이상 정차하면 현재
                    배송지만 자동 완료합니다. 같은 장소의 다음 배송지는 확인 후
                    수동 완료해 주세요.
                  </Text>
                  <Text style={[s.muted, { fontSize: 11 }]}>
                    네이버 내비는 경유지 5곳까지 지원합니다. 긴 코스는 다음 구간
                    알림을 눌러 이어서 안내합니다.
                  </Text>
                  {automation?.lastCompletion && (
                    <Text style={[s.muted, { color: C.green }]}>
                      최근 자동 완료: {automation.lastCompletion.sequence}번
                      배송지
                    </Text>
                  )}
                  <Button
                    title="위치 공유 오류 정보 공유"
                    secondary
                    small
                    onPress={() => run(shareNativeCrash)}
                  />
                </View>
              </Card>
            )}
            {route.status === "planned" && (
              <Card>
                <View style={s.row}>
                  <ShieldCheck size={21} color={C.green} />
                  <Text style={[s.h3, { flex: 1 }]}>
                    출발 전 물품을 확인해 주세요
                  </Text>
                </View>
                <Text style={[s.muted, { marginTop: 10, marginBottom: 20 }]}>
                  네이버 지도에 경유지를 묶어 전달하고 도착 시 자동 완료합니다.
                  위치를 항상 허용하고 알림 권한을 켜 주세요. 5곳 이내 코스는
                  회사 복귀까지 한 번에 안내합니다.
                </Text>
                <Button
                  title="코스 출발 · 네이버 연속 안내"
                  icon={Navigation}
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const updated = await post<Route>(
                        "/api/driver/routes/" + route.id + "/start",
                      );
                      setData({ ...data, route: updated });
                      await openCourse(updated, true);
                    })
                  }
                />
              </Card>
            )}
            {route.status === "returning" && (
              <Card style={{ backgroundColor: "#edf4e3" }}>
                <Text style={[s.h2, { marginBottom: 10 }]}>
                  마지막 목적지는 회사예요
                </Text>
                <Text style={[s.muted, { marginBottom: 18 }]}>
                  {company.name}
                  {`\n`}
                  {company.address}
                </Text>
                <Button
                  title="회사로 돌아가는 길안내"
                  icon={Navigation}
                  onPress={() => run(() => navigate(company, company))}
                />
                <View style={{ marginTop: 10 }}>
                  <Button
                    title="회사 도착 · 복귀 완료"
                    secondary
                    icon={CheckCheck}
                    disabled={busy}
                    onPress={() =>
                      run(async () => {
                        await post(
                          "/api/driver/routes/" + route.id + "/return",
                        );
                        await stopTracking();
                        setMode("off");
                        await refresh();
                      })
                    }
                  />
                </View>
              </Card>
            )}
            {next && route.status === "active" && (
              <Card style={{ borderColor: "#8db29d", borderWidth: 1.5 }}>
                <Badge text={`다음 배송지 · ${next.sequence}번째`} />
                <Text style={[s.h2, { marginTop: 16, marginBottom: 7 }]}>
                  {next.recipient}
                </Text>
                <Text style={{ fontSize: 14, color: C.ink, lineHeight: 23 }}>
                  {next.address}
                </Text>
                {next.phone && (
                  <Pressable
                    onPress={() => Linking.openURL("tel:" + next.phone)}
                    style={[s.row, { marginTop: 12 }]}
                  >
                    <Text
                      style={{
                        color: C.green,
                        fontSize: 13,
                        fontWeight: "700",
                      }}
                    >
                      전화하기 · {next.phone}
                    </Text>
                  </Pressable>
                )}
                <View style={s.divider} />
                <DeliveryItems items={next.items} />
                {next.notes && (
                  <Text style={[s.muted, { marginTop: 13 }]}>{next.notes}</Text>
                )}
                <View style={{ gap: 10, marginTop: 20 }}>
                  <Button
                    title="이 배송지 길안내"
                    secondary
                    icon={Navigation}
                    onPress={() => run(() => navigate(next as any, company))}
                  />
                  <Button
                    title={
                      continuous ? "직접 배송 완료" : "배송 완료 · 다음 길안내"
                    }
                    icon={Check}
                    disabled={busy}
                    onPress={() => complete(next)}
                  />
                  <Pressable
                    onPress={() => {
                      setFailed(next);
                      setReason("");
                    }}
                    style={{ padding: 9, alignSelf: "center" }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        color: C.muted,
                        textDecorationLine: "underline",
                      }}
                    >
                      배송하지 못했어요
                    </Text>
                  </Pressable>
                </View>
              </Card>
            )}
            <Text style={[s.section, { marginTop: 11 }]}>
              전체 코스 · 회사 왕복
            </Text>
            <Card>
              <TimelineCompany name={company.name} label="출발" />
              {route.stops.map((stop) => (
                <View
                  key={stop.id}
                  style={[st.stopRow, { alignItems: "flex-start" }]}
                >
                  <View
                    style={[
                      st.stopIndex,
                      stop.status === "delivered" && {
                        backgroundColor: C.green,
                      },
                    ]}
                  >
                    {stop.status === "delivered" ? (
                      <Check size={13} color="white" />
                    ) : (
                      <Text
                        style={{
                          fontSize: 11,
                          color: C.green,
                          fontWeight: "700",
                        }}
                      >
                        {stop.sequence}
                      </Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={s.between}>
                      <Text style={[s.h3, { fontSize: 13, flex: 1 }]}>
                        {stop.recipient}
                      </Text>
                      <Badge
                        text={statusName[stop.status]}
                        tone={
                          stop.status === "failed"
                            ? "red"
                            : stop.status === "delivered"
                              ? "green"
                              : "grey"
                        }
                      />
                    </View>
                    <Text style={[s.muted, { marginTop: 5 }]}>
                      {stop.address}
                    </Text>
                    <View style={{ marginTop: 9 }}>
                      <DeliveryItems items={stop.items} compact />
                    </View>
                  </View>
                </View>
              ))}
              <TimelineCompany
                name={company.name}
                label={route.status === "completed" ? "복귀 완료" : "복귀"}
              />
            </Card>
          </>
        )}
      </ScrollView>
      {route && (
        <RouteOverview
          route={route}
          visible={overview}
          onClose={() => setOverview(false)}
        />
      )}
      <Sheet
        title="미배송 사유 기록"
        visible={!!failed}
        onClose={() => setFailed(null)}
      >
        <Text style={[s.h3, { marginBottom: 16 }]}>{failed?.recipient}</Text>
        <Field
          label="배송하지 못한 사유"
          value={reason}
          onChangeText={setReason}
          placeholder="예: 수령인 부재, 주소 확인 필요"
          multiline
        />
        <Text style={[s.muted, { marginBottom: 20 }]}>
          관리자에게 사유가 전달되고 다음 배송지 길안내가 열려요.
        </Text>
        <Button
          title="미배송 기록 · 다음 길안내"
          danger
          disabled={busy || !reason.trim()}
          onPress={() => failed && complete(failed, "failed", reason)}
        />
      </Sheet>
    </View>
  );
}

const st = StyleSheet.create({
  login: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 25,
    paddingVertical: 45,
  },
  logo: {
    width: 70,
    height: 70,
    borderRadius: 23,
    backgroundColor: C.lime,
    alignItems: "center",
    justifyContent: "center",
  },
  logoSmall: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: "#e7efdd",
    alignItems: "center",
    justifyContent: "center",
  },
  top: {
    height: 81,
    paddingHorizontal: 23,
    backgroundColor: C.white,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  iconButton: {
    width: 33,
    height: 35,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { padding: 22, paddingTop: 26, width: "100%", alignSelf: "center" },
  notice: {
    backgroundColor: "#fff0ee",
    padding: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  busy: {
    position: "absolute",
    top: 9,
    alignSelf: "center",
    backgroundColor: "#eff8e8",
    borderColor: "#dceacb",
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 9,
    flexDirection: "row",
    gap: 9,
    zIndex: 100,
  },
  datePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: C.line,
    padding: 12,
    borderRadius: 12,
    backgroundColor: C.white,
  },
  demoBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    padding: 14,
    backgroundColor: "#eaf2df",
    borderRadius: 13,
    marginBottom: 18,
  },
  stats: { flexDirection: "row", gap: 9, marginBottom: 6 },
  stat: {
    flex: 1,
    minWidth: 62,
    padding: 14,
    gap: 8,
    backgroundColor: C.white,
    borderRadius: 16,
    borderColor: C.line,
    borderWidth: 1,
  },
  dot: { height: 6, width: 6, borderRadius: 3, backgroundColor: C.green },
  chip: {
    borderWidth: 1,
    borderColor: C.line,
    backgroundColor: C.white,
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 20,
  },
  avatar: {
    width: 43,
    height: 43,
    borderRadius: 15,
    backgroundColor: "#edf2e7",
    alignItems: "center",
    justifyContent: "center",
  },
  progress: {
    height: 5,
    backgroundColor: "#e8eeea",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: { height: 5, backgroundColor: C.green, borderRadius: 4 },
  uploadIllustration: {
    width: 78,
    height: 94,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#4b6761",
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "9deg" }],
  },
  uploadCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 18,
    padding: 20,
    gap: 11,
    backgroundColor: C.white,
  },
  miniRoute: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#edf4e7",
    padding: 14,
    borderRadius: 12,
    gap: 5,
  },
  routeNumber: {
    height: 43,
    width: 43,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  stopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f3f1",
  },
  stopIndex: {
    width: 25,
    height: 25,
    borderRadius: 9,
    backgroundColor: "#eaf2e5",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  companyPin: {
    width: 25,
    height: 25,
    borderRadius: 9,
    backgroundColor: "#fff1df",
    alignItems: "center",
    justifyContent: "center",
  },
  orderButton: { padding: 4, borderRadius: 5, backgroundColor: "#eff3ef" },
  tabBar: {
    backgroundColor: C.white,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 9,
    paddingBottom: 9,
    gap: 4,
  },
  tabIcon: {
    width: 47,
    height: 30,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
});
