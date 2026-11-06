import AdminDeleteButton from "./src/AdminDeleteButton";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
  Keyboard,
  TextInput,
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
  ArrowLeft,
  ArrowRight,
  Building2,
  Camera,
  Check,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileSpreadsheet,
  FileText,
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
  MapSettings,
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
} from "./src/tracking";
import {
  configureDriverAutomation,
  getDriverAutomation,
  recordHandledStop,
  subscribeDriverArrival,
  signalDriverArrival,
  dismissDriverArrival,
  clearPendingNavigation,
} from "./src/driverAutomation";
import type { DriverAutomation } from "./src/driverAutomation";
import { consumeLocationRecovery, shareNativeCrash } from "./src/diagnostics";
import MapPanel from "./src/MapPanel";
import { hasNavigationPoint } from "./src/addressNavigation";
import { createDriverMapData } from "./src/driverMapData";
import DriverDeliveryHistory from "./src/DriverDeliveryHistory";
import RegionalDispatchSummary from "./src/RegionalDispatchSummary";
import { deliveryRegion, deliveryRegionGroups } from "./src/deliveryRegion";
import { parseSalesReference } from "./src/salesReference";
import CatalogPicker from "./src/CatalogPicker";
import { invoiceProduct, invoiceCustomer } from "./src/invoiceCatalog";
import InvoiceItemsEditor from "./src/InvoiceItemsEditor";
import InvoiceLookupPanel from "./src/InvoiceLookupPanel";
import CompanySalesBrowser from "./src/CompanySalesBrowser";
import SalesInvoiceStatement from "./src/SalesInvoiceStatement";
import type { SalesDocument } from "./src/salesDocuments";
import ErpSaleIdentity from "./src/ErpSaleIdentity";
import PendingErpSales from "./src/PendingErpSales";
import { invoiceTotals } from "./src/invoiceMath";
import ErpImportPanel from "./src/ErpImportPanel";
import DispatchBoardScreen from "./src/DispatchBoardScreen";
import type { BoardDrop } from "./src/dispatchBoardTypes";
import KeyboardViewport from "./src/KeyboardViewport";
import {
  TrafficPlannerControls,
  RoutePlanningSummary,
  StopArrival,
} from "./src/TrafficRouteSummary";
import { createImportForm } from "./src/importUpload";
import {
  recognizeDeviceReceipt,
  removeDeviceOcrCache,
  warmUpDeviceReceiptOcr,
} from "./src/deviceReceiptOcr";
import { extractReceipt } from "./src/receiptText";
import type { ReceiptLayout } from "./src/receiptText";
import { mergeReceiptAutofill } from "./src/receiptAutofill";
import {
  createDeviceReceiptDraft,
  listDeviceReceiptDrafts,
  saveDeviceReceiptDraft,
  removeDeviceReceiptDraft,
} from "./src/deviceReceiptDrafts";
import type { DeviceReceiptDraft } from "./src/deviceReceiptDrafts";
import { prepareReceiptImage } from "./src/receiptImage";
import ReceiptUploadProgress from "./src/ReceiptUploadProgress";
import RouteOverview from "./src/RouteOverview";
import AdminMapOverview, { MAP_ROUTE_COLORS } from "./src/AdminMapOverview";
import DeliveryConfirmations from "./src/DeliveryConfirmations";
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
type DriverRouteData = {
  route: Route | null;
  company: Company;
  mapSettings?: MapSettings;
};
type Dashboard = {
  dispatchRevision?: string;
  date: string;
  company: Company;
  mapSettings?: MapSettings;
  receiptCapabilities?: { deviceText: boolean; maxTextLength: number };
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
  source?: string;
  documents?: SalesDocument[];
  erpSaleRequestId?: string;
  erpSaleLocked?: boolean;
  erpWriteReady?: boolean;
  id?: string;
  deviceLocalId?: string;
  deviceRecognitionMs?: number;
  recognitionWarnings?: string[];
  filledFields?: string[];
  fileName: string;
  rawText?: string;
  drafts: ShipmentInput[];
  serviceDate: string;
  status?: string;
  createdAt?: string;
  count?: number;
};
type ReceiptDeleteTarget = ImportBatch & { shipment?: Shipment };
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
    [busy, setBusy] = useState(false),
    [loginEditing, setLoginEditing] = useState(false);
  const pendingOperations = useRef(0);
  const run: Run = async (fn) => {
    pendingOperations.current++;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      pendingOperations.current--;
      setBusy(pendingOperations.current > 0);
    }
  };
  const refreshSetup = async () => {
    const data = await api<SetupState>("/api/setup");
    setSetup(data.required);
    setBootstrap(data.bootstrapCodeRequired);
    return data;
  };
  useEffect(() => {
    void warmUpDeviceReceiptOcr();
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
      if (handled.has(identifier)) return;
      if (
        content.data?.dispatchAction === "confirm-arrival" ||
        content.data?.dispatchAction === "continue-course"
      ) {
        handled.add(identifier);
        signalDriverArrival();
        Notifications.clearLastNotificationResponseAsync().catch(() => {});
      }
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
      stopTracking().catch(() => {});
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
        setLoginEditing(false);
      }
    });
  if (loading) return <Loading />;
  return (
    <KeyboardViewport
      enabled={!user}
      onKeyboardShow={() => setLoginEditing(true)}
      onKeyboardHide={() => setLoginEditing(false)}
    >
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
            <Text
              style={{ color: C.red, fontSize: 13, flex: 1, lineHeight: 20 }}
            >
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
            editing={loginEditing}
            onInputFocus={() => setLoginEditing(true)}
            onDismissKeyboard={() => {
              Keyboard.dismiss();
              setLoginEditing(false);
            }}
            setup={setup}
            bootstrap={bootstrap}
            run={run}
            busy={busy}
            refreshSetup={refreshSetup}
            onLogin={async (session) => {
              await saveSession(session);
              setUser(session.user);
              setSetup(false);
              setLoginEditing(false);
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
    </KeyboardViewport>
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
  editing,
  onInputFocus,
  onDismissKeyboard,
  setup,
  bootstrap,
  run,
  busy,
  onLogin,
  refreshSetup,
}: {
  editing: boolean;
  onInputFocus: () => void;
  onDismissKeyboard: () => void;
  setup: boolean;
  bootstrap: boolean;
  run: Run;
  busy: boolean;
  onLogin: (session: any) => Promise<void>;
  refreshSetup: () => Promise<SetupState>;
}) {
  const loginScroll = useRef<ScrollView>(null),
    loginScrollY = useRef(0);
  const revealLoginInput = () => {
    if (Platform.OS === "web") return;
    setTimeout(() => {
      const input = TextInput.State.currentlyFocusedInput();
      if (!input) return;
      input.measureInWindow((_x, top, _w, h) => {
        loginScroll.current
          ?.getNativeScrollRef()
          ?.measureInWindow((_sx, scrollTop, _sw, scrollHeight) => {
            const overflow = top + h + 20 - scrollTop - scrollHeight;
            if (overflow > 0)
              loginScroll.current?.scrollTo({
                y: loginScrollY.current + overflow,
                animated: true,
              });
            else if (top < scrollTop)
              loginScroll.current?.scrollTo({
                y: Math.max(0, loginScrollY.current + top - scrollTop - 12),
                animated: true,
              });
          });
      });
    }, 120);
  };
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", revealLoginInput);
    return () => sub.remove();
  }, []);
  const focusLogin = () => {
    onInputFocus();
    revealLoginInput();
  };
  const [pin, setPin] = useState(""),
    [name, setName] = useState(""),
    [code, setCode] = useState("");
  const submitLogin = () =>
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
      Keyboard.dismiss();
      await onLogin(session);
      setPin("");
    });
  return (
    <ScrollView
      ref={loginScroll}
      onLayout={revealLoginInput}
      onContentSizeChange={revealLoginInput}
      onScroll={(event) => {
        loginScrollY.current = event.nativeEvent.contentOffset.y;
      }}
      scrollEventThrottle={16}
      style={{ flex: 1 }}
      contentContainerStyle={[st.login, editing && st.loginEditing]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
    >
      <View style={{ width: "100%", maxWidth: 430 }}>
        <View style={[s.row, editing && { marginBottom: 16 }]}>
          <Image
            source={require("./assets/icon.png")}
            accessibilityLabel="바른배차 로고"
            style={
              editing
                ? { width: 38, height: 38, borderRadius: 11 }
                : { width: 78, height: 78, borderRadius: 22 }
            }
          />
          {editing && (
            <>
              <Text style={[s.h2, { flex: 1 }]}>바른배차</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="키보드 닫기"
                onPress={onDismissKeyboard}
                style={{ padding: 10 }}
              >
                <Text style={{ color: C.green, fontSize: 13 }}>
                  키보드 닫기
                </Text>
              </Pressable>
            </>
          )}
        </View>
        {!editing && (
          <>
            <Text style={[s.section, { marginTop: 25, color: C.green }]}>
              BAREUN DISPATCH
            </Text>
            <Text
              style={[s.h1, { fontSize: 37, lineHeight: 47, marginBottom: 13 }]}
            >
              하루의 배송을,{`\n`}바른 순서로.
            </Text>
            <Text
              style={[
                s.muted,
                { fontSize: 14, lineHeight: 23, marginBottom: 33 },
              ]}
            >
              전표부터 배차, 배송과 회사 복귀까지{`\n`}모두 한 곳에서 간편하게
              관리하세요.
            </Text>
          </>
        )}
        <Card style={editing ? { padding: 16 } : undefined}>
          <View style={[s.row, { marginBottom: editing ? 12 : 22 }]}>
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
              onFocus={focusLogin}
              inputStyle={{ fontSize: 16 }}
            />
          )}
          <Field
            label={setup ? "사용할 관리자 PIN (6~12자리)" : "배정받은 PIN"}
            returnKeyType="done"
            onSubmitEditing={() => {
              if (!setup && !busy && pin.length >= 6) submitLogin();
              else Keyboard.dismiss();
            }}
            value={pin}
            onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 12))}
            placeholder="숫자 6~12자리"
            numeric
            secure
            onFocus={focusLogin}
            inputStyle={{ fontSize: 16 }}
          />
          {setup && bootstrap && (
            <Field
              label="최초 관리자 등록 코드"
              value={code}
              onChangeText={setCode}
              secure
              onFocus={focusLogin}
              inputStyle={{ fontSize: 16 }}
            />
          )}
          <Button
            title={setup ? "관리자 등록하고 시작" : "로그인"}
            icon={ArrowRight}
            disabled={busy || pin.length < 6 || (setup && !name.trim())}
            onPress={submitLogin}
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
  { id: "invoices", label: "명세서", icon: FileText },
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
    [mapSettings, setMapSettings] = useState<MapSettings | null>(null),
    [mapOverview, setMapOverview] = useState(false),
    [driverEdit, setDriverEdit] = useState<
      (Partial<Driver> & { pin?: string }) | null
    >(null),
    [pins, setPins] = useState<{ name: string; pin: string }[] | null>(null),
    [detail, setDetail] = useState<Shipment | null>(null),
    [assignment, setAssignment] = useState<Shipment | null>(null),
    [confirmClear, setConfirmClear] = useState(false);
  const [regionFilter, setRegionFilter] = useState("all");
  useEffect(() => setRegionFilter("all"), [date]);
  const [boardOpen, setBoardOpen] = useState(false);
  const [boardSaving, setBoardSaving] = useState(false);
  const [boardMessage, setBoardMessage] = useState("");
  const boardSavingRef = useRef(false);
  const [catalogTarget, setCatalogTarget] = useState<{
    kind: "customers" | "products";
    row: number;
    item?: number;
  } | null>(null);
  const [assignmentError, setAssignmentError] = useState("");
  const [assignmentSaving, setAssignmentSaving] = useState(false);
  const assignmentRef = useRef<Shipment | null>(null);
  const assignmentSavingRef = useRef(false);
  const [companyError, setCompanyError] = useState("");
  const [addressLookupMessage, setAddressLookupMessage] = useState("");
  const [detailError, setDetailError] = useState("");
  useEffect(() => setDetailError(""), [detail?.id]);
  const [uploadProgress, setUploadProgress] = useState<{
    phase: string;
    startedAt: number;
  } | null>(null);
  const [salesBrowserId, setSalesBrowserId] = useState<string | null>(null);
  const [invoiceStatement, setInvoiceStatement] =
    useState<SalesDocument | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [receiptDelete, setReceiptDelete] =
    useState<ReceiptDeleteTarget | null>(null);
  const [receiptDeleting, setReceiptDeleting] = useState(false);
  const [receiptDeleteError, setReceiptDeleteError] = useState("");
  const receiptDeleteRef = useRef<ReceiptDeleteTarget | null>(null);
  const receiptDeletingRef = useRef(false);
  const [showReceiptText, setShowReceiptText] = useState(false);
  const [deviceDrafts, setDeviceDrafts] = useState<DeviceReceiptDraft[]>([]);
  const deviceDraftsRef = useRef<DeviceReceiptDraft[]>([]);
  const reviewSaving = useRef(false);
  const rememberDeviceDraft = (draft: DeviceReceiptDraft) => {
    const all = [
      draft,
      ...deviceDraftsRef.current.filter(
        (item) => item.localId !== draft.localId,
      ),
    ];
    deviceDraftsRef.current = all;
    if (mounted.current) setDeviceDrafts(all);
  };
  const withReceiptRecognition = (batch: ImportBatch): ImportBatch => {
    if (!batch.rawText || !/\.(?:jpe?g|png|webp)$/i.test(batch.fileName))
      return batch;
    const extraction = extractReceipt(batch.rawText, undefined, {
      supplierName: data?.company.name,
      supplierAddress: data?.company.address,
    });
    return {
      ...batch,
      recognitionWarnings: extraction.warnings,
      filledFields: extraction.filledFields,
    };
  };
  const openDeviceDraft = (
    draft: DeviceReceiptDraft,
    recognitionMs?: number,
  ) => {
    const extraction = extractReceipt(draft.rawText, draft.layout, {
      supplierName: data?.company.name,
      supplierAddress: data?.company.address,
    });
    const batch: ImportBatch = {
      id: draft.remoteId,
      deviceLocalId: draft.localId,
      deviceRecognitionMs: recognitionMs,
      recognitionWarnings: extraction.warnings,
      filledFields: extraction.filledFields,
      fileName: draft.fileName,
      rawText: draft.rawText,
      drafts: draft.drafts,
      serviceDate: draft.serviceDate,
      status: "device-local",
      createdAt: draft.createdAt,
    };
    reviewRef.current = batch;
    setReview(batch);
  };
  const uploadRef = useRef<{ controller: AbortController } | null>(null);
  const reviewRef = useRef(review);
  const mounted = useRef(true);
  const currentDate = useRef(date);
  reviewRef.current = review;
  currentDate.current = date;
  useEffect(() => {
    mounted.current = true;
    if (Platform.OS === "android") {
      listDeviceReceiptDrafts(user.userId)
        .then((loaded) => {
          if (!mounted.current) return;
          const combined = new Map(
            loaded.map((draft) => [draft.localId, draft]),
          );
          for (const draft of deviceDraftsRef.current)
            combined.set(draft.localId, draft);
          deviceDraftsRef.current = [...combined.values()];
          setDeviceDrafts(deviceDraftsRef.current);
        })
        .catch((error) => {
          if (mounted.current) tell((error as Error).message);
        });
    }
    return () => {
      mounted.current = false;
      uploadRef.current?.controller.abort();
    };
  }, []);
  useEffect(() => setReviewError(""), [review?.id, review?.fileName]);
  useEffect(
    () => setShowReceiptText(false),
    [review?.deviceLocalId, review?.id, review?.fileName],
  );
  const { width } = useWindowDimensions();
  const refresh = useCallback(async () => {
    const [board, batches] = await Promise.all([
      api<Dashboard>("/api/dashboard?date=" + date),
      api<ImportBatch[]>("/api/imports?date=" + date),
    ]);
    if (mounted.current && currentDate.current === date) {
      setData(board);
      setImports(batches);
    }
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
  const dropOnBoard = async (drop: BoardDrop) => {
    if (boardSavingRef.current) return;
    boardSavingRef.current = true;
    setBoardSaving(true);
    setBoardMessage("");
    try {
      await post("/api/dispatch/drop", drop);
      await refresh();
      if (mounted.current)
        setBoardMessage(
          "이동을 저장했습니다. 회사 왕복 경로와 예상 시간을 갱신했어요.",
        );
    } catch (error) {
      if (mounted.current) setBoardMessage((error as Error).message);
      await refresh().catch(() => {});
    } finally {
      boardSavingRef.current = false;
      if (mounted.current) setBoardSaving(false);
    }
  };
  const addDemo = () =>
    run(async () => {
      const result = await post("/api/demo");
      setPins(result.drivers);
      await refresh();
    });
  const updateReview = (
    i: number,
    changes: Partial<ShipmentInput>,
    expectedAddress?: string,
  ) => {
    if (reviewSaving.current) return;
    setReview((old) =>
      old
        ? {
            ...old,
            drafts: old.drafts.map((r, index) =>
              index === i &&
              (expectedAddress === undefined || r.address === expectedAddress)
                ? { ...r, ...changes }
                : r,
            ),
          }
        : null,
    );
  };
  const locateRow = (i: number) =>
    run(async () => {
      if (!review) return;
      const address = review.drafts[i].address;
      setReviewError("");
      try {
        const point = await post("/api/geocode", {
          address,
        });
        updateReview(i, { lat: point.lat, lng: point.lng }, address);
      } catch (error) {
        setReviewError((error as Error).message);
      }
    });
  const openAssignment = (shipment: Shipment) => {
    if (
      busy ||
      uploadRef.current ||
      reviewSaving.current ||
      receiptDeleteRef.current ||
      assignmentSavingRef.current ||
      shipment.status !== "pending" ||
      shipment.routeId
    )
      return;
    Keyboard.dismiss();
    assignmentRef.current = shipment;
    setAssignmentError("");
    setDetail(null);
    setAssignment(shipment);
  };
  const closeAssignment = () => {
    if (assignmentSavingRef.current) return;
    assignmentRef.current = null;
    setAssignment(null);
    setAssignmentError("");
  };
  const assignShipment = async (driverId: string) => {
    const shipment = assignmentRef.current;
    if (
      !shipment ||
      assignmentSavingRef.current ||
      uploadRef.current ||
      reviewSaving.current ||
      receiptDeleteRef.current
    )
      return;
    assignmentSavingRef.current = true;
    reviewSaving.current = true;
    setAssignmentSaving(true);
    setAssignmentError("");
    try {
      const route = await post<Route>(
        "/api/shipments/" + shipment.id + "/assign",
        {
          driverId,
        },
      );
      assignmentRef.current = null;
      if (mounted.current) {
        setAssignment(null);
        tell(`${route.driverName} 기사에게 배송지를 배정했습니다.`);
        refresh().catch((error) => tell((error as Error).message));
      }
    } catch (error) {
      if (mounted.current) setAssignmentError((error as Error).message);
    } finally {
      assignmentSavingRef.current = false;
      reviewSaving.current = false;
      if (mounted.current) setAssignmentSaving(false);
    }
  };
  const pickUpload = async (kind: "camera" | "photo" | "excel") => {
    // State-based button disabling is not a lock: refreshes and rapid taps can
    // otherwise admit another photo before the first operation has finished.
    if (uploadRef.current || reviewSaving.current || receiptDeleteRef.current)
      return;
    if (reviewRef.current) {
      tell("열려 있는 전표를 먼저 확인하거나 닫아 주세요.");
      return;
    }
    const operation = { controller: new AbortController() };
    uploadRef.current = operation;
    function waitForStep<T>(work: Promise<T>): Promise<T> {
      const signal = operation.controller.signal;
      return new Promise((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(signal.reason);
        };
        work.then(
          (result) => {
            signal.removeEventListener("abort", abort);
            resolve(result);
          },
          (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }
    const phase = (value: string) => {
      if (mounted.current && uploadRef.current === operation)
        setUploadProgress({ phase: value, startedAt: Date.now() });
    };
    let prepared: Awaited<ReturnType<typeof prepareReceiptImage>> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    tell("");
    phase(
      kind === "camera" ? "사진을 촬영하고 있어요" : "파일을 선택하고 있어요",
    );
    try {
      let asset: any;
      if (kind === "excel") {
        const result = await waitForStep(
          DocumentPicker.getDocumentAsync({
            type: [
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "text/csv",
              "application/csv",
            ],
            copyToCacheDirectory: true,
          }),
        );
        if (result.canceled) return;
        asset = result.assets[0];
      } else {
        const permission = await waitForStep(
          kind === "camera"
            ? ImagePicker.requestCameraPermissionsAsync()
            : ImagePicker.requestMediaLibraryPermissionsAsync(),
        );
        if (!permission.granted)
          throw new Error("카메라 또는 사진 접근 권한을 허용해 주세요.");
        const result = await waitForStep(
          kind === "camera"
            ? ImagePicker.launchCameraAsync({
                mediaTypes: ["images"],
                quality: 1,
              })
            : ImagePicker.launchImageLibraryAsync({
                mediaTypes: ["images"],
                quality: 1,
                preferredAssetRepresentationMode:
                  ImagePicker.UIImagePickerPreferredAssetRepresentationMode
                    .Compatible,
              }),
        );
        if (result.canceled) return;
        asset = result.assets[0];
      }
      if (operation.controller.signal.aborted)
        throw operation.controller.signal.reason;
      if (kind !== "excel" && Platform.OS === "android") {
        phase("휴대폰에서 글자를 읽고 있어요");
        timeout = setTimeout(() => {
          const error = new Error("Device receipt preview timed out");
          error.name = "TimeoutError";
          operation.controller.abort(error);
        }, 5000);
        const result = await waitForStep(
          recognizeDeviceReceipt(asset.uri, operation.controller.signal),
        );
        try {
          const layout: ReceiptLayout | undefined = result.lines
            ? {
                width: result.width,
                height: result.height,
                lines: result.lines,
              }
            : undefined;
          const extraction = extractReceipt(result.text, layout, {
            supplierName: data?.company.name,
            supplierAddress: data?.company.address,
          });
          const processed = {
            ...asset,
            uri: result.imageUri,
            file: undefined,
            width: result.width,
            height: result.height,
            name: "receipt.jpg",
            fileName: "receipt.jpg",
            mimeType: "image/jpeg",
          };
          const draft = await waitForStep(
            createDeviceReceiptDraft(
              user.userId,
              processed,
              date,
              result.text,
              [extraction.draft],
              layout,
            ).then((saved) => {
              if (operation.controller.signal.aborted)
                void removeDeviceReceiptDraft(user.userId, saved.localId).catch(
                  () => {},
                );
              return saved;
            }),
          );
          if (operation.controller.signal.aborted)
            throw operation.controller.signal.reason;
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          rememberDeviceDraft(draft);
          if (mounted.current) openDeviceDraft(draft, result.durationMs);
          return;
        } finally {
          await removeDeviceOcrCache(result.imageUri);
        }
      }
      if (kind !== "excel") {
        phase("사진 크기를 맞추고 있어요");
        const processed = await waitForStep(
          prepareReceiptImage(asset).then((result) => {
            // A native image operation may finish after cancellation. Clean its
            // temporary file even though this upload has already been released.
            if (operation.controller.signal.aborted)
              void result.dispose().catch(() => {});
            return result;
          }),
        );
        prepared = processed;
        asset = processed.asset;
      }
      if (operation.controller.signal.aborted)
        throw operation.controller.signal.reason;
      const form = await waitForStep(createImportForm(asset, kind, date));
      if (operation.controller.signal.aborted)
        throw operation.controller.signal.reason;
      phase(
        kind === "excel"
          ? "엑셀 파일을 읽고 있어요"
          : "전송하고 글자를 읽고 있어요",
      );
      timeout = setTimeout(() => {
        const error = new Error("Receipt processing timed out");
        error.name = "TimeoutError";
        operation.controller.abort(error);
      }, 45_000);
      const batch = await api<ImportBatch>("/api/imports", {
        method: "POST",
        body: form,
        signal: operation.controller.signal,
      });
      if (!batch || !Array.isArray(batch.drafts))
        throw new Error(
          "전표 결과를 읽지 못했습니다. 업로드 내역에서 확인해 주세요.",
        );
      if (!operation.controller.signal.aborted && mounted.current) {
        if (
          batch.source === "company-erp-selection" ||
          batch.documents?.length
        ) {
          setSalesBrowserId(batch.id!);
          return;
        }
        const recognized = withReceiptRecognition(batch);
        reviewRef.current = recognized;
        setReview(recognized);
        // The result is ready. Unrelated dashboard refresh must not keep the
        // review and next-photo controls blocked for another network round trip.
        refresh().catch((error) => {
          if (mounted.current) tell((error as Error).message);
        });
      }
    } catch (error) {
      if (mounted.current) {
        tell(
          operation.controller.signal.aborted
            ? operation.controller.signal.reason?.name === "TimeoutError"
              ? Platform.OS === "android" && kind !== "excel"
                ? "휴대폰 글자 인식이 5초 안에 끝나지 않았습니다. 잠시 후 다시 시도해 주세요."
                : "전표 처리 시간이 초과됐습니다. 업로드 내역을 확인한 뒤 다시 촬영해 주세요."
              : "전표 처리를 취소했습니다. 이미 완료된 전표는 업로드 내역에서 확인할 수 있어요."
            : (error as Error)?.message ||
                "전표를 읽지 못했습니다. 다시 촬영해 주세요.",
        );
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      await prepared?.dispose().catch(() => {});
      if (uploadRef.current === operation) {
        uploadRef.current = null;
        if (mounted.current) setUploadProgress(null);
      }
    }
  };
  const openStoredReview = async (id: string) => {
    if (uploadRef.current || reviewSaving.current || receiptDeleteRef.current)
      return;
    const local = deviceDraftsRef.current.find(
      (draft) => draft.remoteId === id,
    );
    if (local) {
      openDeviceDraft(local);
      return;
    }
    const batch = await api<ImportBatch>("/api/imports/" + id);
    if (batch.source === "company-erp" && !batch.documents?.length) {
      const salesDate = parseSalesReference(
        batch.drafts[0]?.salesReference,
      )?.date;
      if (salesDate) {
        const result = await post("/api/company-erp/sales/lists", {
          salesDate,
          serviceDate: batch.serviceDate,
        });
        setSalesBrowserId(result.id);
        return;
      }
    }
    if (
      mounted.current &&
      !uploadRef.current &&
      !reviewSaving.current &&
      !receiptDeleteRef.current
    ) {
      if (batch.source === "company-erp-selection" || batch.documents?.length) {
        setSalesBrowserId(batch.id!);
        return;
      }
      const recognized = withReceiptRecognition(batch);
      reviewRef.current = recognized;
      setReview(recognized);
    }
  };
  const closeReview = async () => {
    if (reviewSaving.current) return;
    const batch = reviewRef.current;
    if (batch?.deviceLocalId) {
      const local = deviceDraftsRef.current.find(
        (draft) => draft.localId === batch.deviceLocalId,
      );
      if (local) {
        try {
          const updated = {
            ...local,
            drafts: batch.drafts,
            rawText: batch.rawText ?? local.rawText,
            remoteId: batch.id ?? local.remoteId,
          };
          await saveDeviceReceiptDraft(updated);
          rememberDeviceDraft(updated);
        } catch (error) {
          setReviewError((error as Error).message);
          return;
        }
      }
    }
    reviewRef.current = null;
    setReview(null);
  };
  const reapplyReceiptAutofill = async () => {
    const batch = reviewRef.current;
    if (
      !batch?.rawText ||
      batch.drafts.length !== 1 ||
      reviewSaving.current ||
      uploadRef.current
    )
      return;
    const local = deviceDraftsRef.current.find(
      (draft) => draft.localId === batch.deviceLocalId,
    );
    const extraction = extractReceipt(batch.rawText, local?.layout, {
      supplierName: data?.company.name,
      supplierAddress: data?.company.address,
    });
    const updated: ImportBatch = {
      ...batch,
      drafts: mergeReceiptAutofill(batch.drafts, extraction.draft),
      recognitionWarnings: extraction.warnings,
      filledFields: extraction.filledFields,
    };
    reviewRef.current = updated;
    setReview(updated);
    if (local) {
      reviewSaving.current = true;
      try {
        const saved = { ...local, drafts: updated.drafts };
        await saveDeviceReceiptDraft(saved);
        rememberDeviceDraft(saved);
      } finally {
        reviewSaving.current = false;
      }
    }
  };
  const saveReview = async (nextPhoto = false) => {
    const batch = reviewRef.current;
    if (!batch || uploadRef.current || reviewSaving.current) return;
    reviewSaving.current = true;
    Keyboard.dismiss();
    setReviewError("");
    try {
      if (
        batch.drafts.some(
          (row) =>
            row.amount != null &&
            (!Number.isFinite(row.amount) || row.amount < 0),
        )
      )
        throw new Error("전표 금액을 숫자로 확인해 주세요.");
      if (batch.erpSaleRequestId) {
        const locked = { ...batch, erpSaleLocked: true };
        reviewRef.current = locked;
        setReview(locked);
        const result = await post(
          "/api/company-erp/sale-requests/" +
            batch.erpSaleRequestId +
            "/commit",
          { row: batch.drafts[0] },
        );
        const saleDate = parseSalesReference(result.salesReference)?.date;
        if (saleDate) setDate(saleDate);
        tell(`ERP 판매전표 ${result.salesReference} · 배송지 저장 완료`);
      } else if (batch.deviceLocalId) {
        let local = deviceDraftsRef.current.find(
          (draft) => draft.localId === batch.deviceLocalId,
        );
        if (!local) throw new Error("기기에 저장된 전표를 다시 열어 주세요.");
        local = {
          ...local,
          drafts: batch.drafts,
          rawText: batch.rawText ?? local.rawText,
        };
        await saveDeviceReceiptDraft(local);
        rememberDeviceDraft(local);
        if (!data?.receiptCapabilities?.deviceText)
          throw new Error(
            "서버를 최신 버전으로 업데이트한 뒤 저장해 주세요. 읽은 전표는 기기에 보관되어 있습니다.",
          );
        let remoteId = local.remoteId;
        if (!remoteId) {
          const form = await createImportForm(
            local.asset,
            "photo",
            local.serviceDate,
          );
          form.append("recognitionSource", "android-device");
          form.append("recognizedText", local.rawText);
          if (local.layout)
            form.append("recognizedLayout", JSON.stringify(local.layout));
          form.append("deviceReceiptId", local.localId);
          const uploaded = await api<ImportBatch>("/api/imports", {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(20000),
          });
          if (!uploaded.id)
            throw new Error(
              "전표 저장 결과를 확인하지 못했습니다. 업로드 내역을 확인해 주세요.",
            );
          remoteId = uploaded.id;
          local = { ...local, remoteId };
          // Preserve the accepted import ID before committing edited fields.
          // A failed validation retry must not upload a second original photo.
          rememberDeviceDraft(local);
          const updated = { ...batch, id: remoteId };
          reviewRef.current = updated;
          if (mounted.current) setReview(updated);
          await saveDeviceReceiptDraft(local);
        }
        await post("/api/imports/" + remoteId + "/commit", {
          rows: batch.drafts,
          deviceReceiptId: local.localId,
        });
        await removeDeviceReceiptDraft(user.userId, batch.deviceLocalId);
        deviceDraftsRef.current = deviceDraftsRef.current.filter(
          (draft) => draft.localId !== batch.deviceLocalId,
        );
        if (mounted.current) setDeviceDrafts(deviceDraftsRef.current);
      } else if (batch.status === "edit") {
        const row = batch.drafts[0] as Shipment;
        await patch("/api/shipments/" + row.id, row);
      } else if (batch.id) {
        await post("/api/imports/" + batch.id + "/commit", {
          rows: batch.drafts,
        });
      } else {
        await post("/api/shipments", {
          serviceDate: batch.serviceDate,
          rows: batch.drafts,
        });
      }
    } catch (error) {
      if (batch.erpSaleRequestId) {
        try {
          const op = await api<any>(
            "/api/company-erp/sale-requests/" + batch.erpSaleRequestId,
          );
          if (op.status === "draft" && mounted.current) {
            const editable = { ...batch, erpSaleLocked: false };
            reviewRef.current = editable;
            setReview(editable);
          }
        } catch {}
      }
      if (mounted.current) setReviewError((error as Error).message);
      throw error;
    } finally {
      reviewSaving.current = false;
    }
    if (!mounted.current) return;
    reviewRef.current = null;
    setReview(null);
    refresh().catch((error) => {
      if (mounted.current) tell((error as Error).message);
    });
    if (nextPhoto) {
      setTab("upload");
      // Finish the sheet's native closing animation before presenting a camera.
      await new Promise((resolve) =>
        setTimeout(resolve, batch.deviceLocalId ? 100 : 400),
      );
      if (!mounted.current) return;
      if (
        Platform.OS === "web" &&
        typeof navigator !== "undefined" &&
        navigator.userActivation?.isActive === false
      ) {
        // Browsers can expire the tap gesture during a slow save request.
        // Give the next capture a fresh tap instead of a blocked file dialog.
        tell(
          "전표를 저장했습니다. ‘전표 촬영’을 눌러 다음 사진을 촬영해 주세요.",
        );
        return;
      }
      void pickUpload("camera");
    }
  };
  const requestReceiptDelete = (batch: ReceiptDeleteTarget) => {
    if (
      busy ||
      uploadRef.current ||
      reviewSaving.current ||
      receiptDeleteRef.current
    )
      return;
    Keyboard.dismiss();
    // Hold the same lock as saving until the confirmation is dismissed. A save
    // must never recreate an upload while its original is being removed.
    reviewSaving.current = true;
    receiptDeleteRef.current = batch;
    setReceiptDeleteError("");
    if (batch.shipment) setDetail(null);
    setReceiptDelete(batch);
  };
  const cancelReceiptDelete = () => {
    if (receiptDeletingRef.current) return;
    receiptDeleteRef.current = null;
    reviewSaving.current = false;
    setReceiptDelete(null);
    setReceiptDeleteError("");
  };
  const deleteReceipt = async () => {
    const batch = receiptDeleteRef.current;
    if (!batch || receiptDeletingRef.current || uploadRef.current) return;
    receiptDeletingRef.current = true;
    setReceiptDeleting(true);
    setReceiptDeleteError("");
    try {
      if (batch.shipment) {
        const shipment = batch.shipment;
        const route = data?.routes.find((item) => item.id === shipment.routeId);
        await api("/api/admin/records/shipments/" + shipment.id, { method: "DELETE" });
        receiptDeleteRef.current = null;
        reviewSaving.current = false;
        if (mounted.current) {
          setDetail((current) =>
            current?.id === shipment.id ? null : current,
          );
          setReceiptDelete(null);
          tell(
            shipment.routeId
              ? "배송지 1곳을 삭제하고 남은 코스를 다시 계산했습니다."
              : "미배차 배송지 1곳을 삭제했습니다.",
          );
          refresh().catch(() => {});
        }
        return;
      }
      const locals = deviceDraftsRef.current.filter(
        (draft) =>
          draft.localId === batch.deviceLocalId ||
          (!!batch.id && draft.remoteId === batch.id),
      );
      const remoteId = batch.id ?? locals[0]?.remoteId;
      let deletedShipments = 0;
      if (remoteId) {
        try {
          const result = await api<{ ok: boolean; deletedShipments: number }>(
            "/api/admin/records/imports/" + remoteId,
            { method: "DELETE", body: JSON.stringify({ deleteLinked: batch.status === "committed" }) },
          );
          deletedShipments = result.deletedShipments;
        } catch (error) {
          // A lost successful response or an earlier cleanup failure can leave
          // an owned local draft referring to an already deleted server upload.
          if (!["업로드를 찾을 수 없습니다.", "삭제할 앱 기록을 찾을 수 없습니다."].includes((error as Error).message))
            throw error;
        }
      }
      // Remote deletion must succeed before removing the recoverable local copy.
      for (const draft of locals)
        await removeDeviceReceiptDraft(user.userId, draft.localId);
      const removedIds = new Set(locals.map((draft) => draft.localId));
      deviceDraftsRef.current = deviceDraftsRef.current.filter(
        (draft) => !removedIds.has(draft.localId),
      );
      const current = reviewRef.current;
      if (
        current &&
        ((remoteId && current.id === remoteId) ||
          (current.deviceLocalId && removedIds.has(current.deviceLocalId)))
      ) {
        reviewRef.current = null;
        if (mounted.current) setReview(null);
      }
      receiptDeleteRef.current = null;
      reviewSaving.current = false;
      if (!mounted.current) return;
      setDeviceDrafts(deviceDraftsRef.current);
      setImports((previous) => previous.filter((item) => item.id !== remoteId));
      setReceiptDelete(null);
      setReviewError("");
      tell(
        deletedShipments
          ? `전표 1건과 연결된 배송지 ${deletedShipments}곳을 삭제했습니다.`
          : "전표 1건을 삭제했습니다.",
      );
      refresh().catch(() => {});
    } catch (error) {
      if (mounted.current) setReceiptDeleteError((error as Error).message);
    } finally {
      receiptDeletingRef.current = false;
      if (mounted.current) setReceiptDeleting(false);
    }
  };
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
  const coloredRoutes = data.routes.map((route, index) => ({
    ...route,
    color: MAP_ROUTE_COLORS[index % MAP_ROUTE_COLORS.length],
  }));
  const shownRoutes = selectedDriver
    ? coloredRoutes.filter((r) => r.driverId === selectedDriver)
    : coloredRoutes;
  const shownDrivers = selectedDriver
    ? data.drivers.filter((d) => d.id === selectedDriver)
    : data.drivers;
  const adminMapData = {
    company: data.company,
    routes: shownRoutes,
    drivers: shownDrivers,
    map: { provider: "naver", naverKeyId: data.mapSettings?.naverKeyId ?? "" },
  };
  const openMapSettings = () => {
    setMapOverview(false);
    setMapSettings({ naverKeyId: data.mapSettings?.naverKeyId ?? "" });
  };
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
            disabled={busy || !!uploadProgress}
            onPress={() => {
              setCompany({ ...data.company });
              setCompanyError("");
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
      {uploadProgress && (
        <ReceiptUploadProgress
          phase={uploadProgress.phase}
          startedAt={uploadProgress.startedAt}
          onCancel={() => uploadRef.current?.controller.abort()}
        />
      )}
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={false}
            enabled={!uploadProgress}
            onRefresh={() => {
              if (!uploadRef.current) run(refresh);
            }}
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
                    : tab === "invoices"
                      ? "거래명세서 조회"
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
                공개 장소·예시 주소입니다. 실제 배송 전 회사 설정에서 지워
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
              <Text style={s.h2}>네이버 실시간 운행 지도</Text>
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
              data={adminMapData}
              onConfigure={openMapSettings}
              height={width > 650 ? 350 : 290}
            />
            <View style={[s.row, { marginTop: 12, flexWrap: "wrap" }]}>
              <Button
                title="전체 운행 지도 크게 보기"
                secondary
                small
                icon={Navigation}
                onPress={() => setMapOverview(true)}
              />
              <Button
                title="네이버 지도 설정"
                secondary
                small
                icon={Settings2}
                onPress={openMapSettings}
              />
            </View>
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
                disabled={busy || !!uploadProgress}
                accessibilityLabel="전표 촬영"
                onPress={() => pickUpload("camera")}
                style={st.uploadCard}
              >
                <Camera size={29} color={C.green} />
                <Text style={s.h3}>전표 촬영</Text>
                <Text style={s.muted}>인쇄된 전표를 사진으로</Text>
              </Pressable>
              <Pressable
                disabled={busy || !!uploadProgress}
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
                  disabled={busy || !!uploadProgress}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title="배송지 직접 입력"
                  secondary
                  icon={Plus}
                  disabled={busy || !!uploadProgress}
                  onPress={() =>
                    run(async () => {
                      if (uploadRef.current) return;
                      const status = await api<any>("/api/erp/status");
                      if (status.company?.configured) {
                        const op = await post("/api/company-erp/sale-requests");
                        const today = koreanDate();
                        setDate(today);
                        setReview({
                          fileName: "ERP 판매전표 작성",
                          drafts: [blankShipment()],
                          serviceDate: today,
                          erpSaleRequestId: op.requestId,
                          erpWriteReady: false,
                        });
                      } else
                        setReview({
                          fileName: "직접 입력",
                          drafts: [blankShipment()],
                          serviceDate: date,
                        });
                    })
                  }
                />
              </View>
            </View>
            <Text style={[s.muted, { marginBottom: 16 }]}>
              거래명세서 제목 아래의 거래처·주소·연락처와 품목표가 함께 보이게
              촬영해 주세요.
            </Text>
            <PendingErpSales
              refreshKey={review?.erpSaleRequestId ?? "closed"}
              onResume={(id) =>
                run(async () => {
                  const op = await api<any>(
                    "/api/company-erp/sale-requests/" + id,
                  );
                  if (!op.row) throw new Error("저장 내용을 찾을 수 없습니다.");
                  setReview({
                    fileName: "ERP 판매 저장 마무리",
                    drafts: [op.row],
                    serviceDate: op.sale?.saleDate ?? koreanDate(),
                    erpSaleRequestId: id,
                    erpSaleLocked: op.status !== "draft",
                    erpWriteReady: true,
                  });
                })
              }
            />
            <ErpImportPanel
              onOpenInvoices={() => setTab("invoices")}
              onSalesList={setSalesBrowserId}
              date={date}
              disabled={busy || !!uploadProgress || !!review}

            />
            {deviceDrafts.length > 0 && (
              <>
                <Text style={[s.section, { marginTop: 12 }]}>
                  기기에 저장된 전표
                </Text>
                <Text style={[s.muted, { marginBottom: 12 }]}>
                  읽은 내용은 보관되어 있어요. 확인 후 저장하면 배송지와 서버
                  내역에 등록됩니다.
                </Text>
                {deviceDrafts.map((draft) => (
                  <Card key={draft.localId}>
                    <Pressable
                      disabled={busy || !!uploadProgress || !!receiptDelete}
                      onPress={() => {
                        if (!uploadRef.current) openDeviceDraft(draft);
                      }}
                    >
                      <View style={s.between}>
                        <View style={{ flex: 1 }}>
                          <Text style={s.h3}>
                            {draft.drafts[0]?.recipient || draft.fileName}
                          </Text>
                          <Text style={s.muted}>
                            {draft.serviceDate} · 확인·저장 대기
                          </Text>
                        </View>
                        <ChevronRight size={20} color={C.muted} />
                      </View>
                    </Pressable>
                    <View style={{ marginTop: 12 }}>
                      <Button
                        title="전표 삭제"
                        danger
                        secondary
                        small
                        icon={Trash2}
                        disabled={busy || !!uploadProgress || !!receiptDelete}
                        onPress={() =>
                          requestReceiptDelete({
                            id: draft.remoteId,
                            deviceLocalId: draft.localId,
                            fileName: draft.fileName,
                            drafts: draft.drafts,
                            serviceDate: draft.serviceDate,
                            status: "device-local",
                          })
                        }
                      />
                    </View>
                  </Card>
                ))}
              </>
            )}
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
            {imports.filter(
              (i) =>
                i.status === "review" &&
                !deviceDrafts.some((draft) => draft.remoteId === i.id),
            ).length ? (
              imports
                .filter(
                  (i) =>
                    i.status === "review" &&
                    !deviceDrafts.some((draft) => draft.remoteId === i.id),
                )
                .map((batch) => (
                  <Card key={batch.id}>
                    <Pressable
                      disabled={busy || !!uploadProgress || !!receiptDelete}
                      onPress={() => run(() => openStoredReview(batch.id!))}
                    >
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
                    </Pressable>
                    <View style={{ marginTop: 12 }}>
                      <Button
                        title="전표 삭제"
                        danger
                        secondary
                        small
                        icon={Trash2}
                        disabled={busy || !!uploadProgress || !!receiptDelete}
                        onPress={() => requestReceiptDelete(batch)}
                      />
                    </View>
                  </Card>
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
              <View style={{ marginBottom: 16 }}>
                <Button
                  title="터치로 배차하기"
                  icon={Truck}
                  disabled={busy || !!uploadProgress}
                  onPress={() => {
                    if (!data.dispatchRevision) {
                      tell(
                        "서버를 최신 버전으로 배포한 뒤 터치 배차를 이용해 주세요.",
                      );
                      return;
                    }
                    setBoardMessage("");
                    setBoardOpen(true);
                  }}
                />
              </View>
              <TrafficPlannerControls
                busy={busy || !!uploadProgress}
                active={!!data.stats.active}
                count={
                  data.shipments.filter((shipment) =>
                    ["pending", "assigned"].includes(shipment.status),
                  ).length
                }
                date={date}
                onGenerate={(options) =>
                  run(async () => {
                    await post("/api/routes/optimize", {
                      serviceDate: date,
                      ...options,
                    });
                    await refresh();
                  })
                }
              />
              <Text style={[s.muted, { marginTop: 12 }]}>
                배송지의 ≡를 길게 눌러 기사 사이로 옮기거나 위아래로 순서를 바꿔
                보세요. 주소 위치와 회사 왕복 시간을 자동 확인해요.
              </Text>
              {data.shipments.some(
                (shipment) =>
                  shipment.status === "pending" &&
                  !hasNavigationPoint(shipment),
              ) && (
                <View style={{ marginTop: 12 }}>
                  <Button
                    title="등록한 배송지 주소 확인"
                    secondary
                    icon={MapPin}
                    disabled={busy || !!uploadProgress}
                    onPress={() =>
                      run(async () => {
                        setAddressLookupMessage("");
                        try {
                          const result = await post<{
                            resolved: number;
                            unresolved: {
                              id: string;
                              address: string;
                              message: string;
                            }[];
                            remaining: number;
                          }>("/api/shipments/geocode", { serviceDate: date });
                          setAddressLookupMessage(
                            `${result.resolved}곳 주소 확인 완료` +
                              (result.unresolved.length
                                ? ` · ${result.unresolved.length}곳은 주소를 수정해 주세요.`
                                : "") +
                              (result.remaining
                                ? ` · ${result.remaining}곳은 한 번 더 눌러 확인해 주세요.`
                                : ""),
                          );
                          await refresh();
                        } catch (error) {
                          setAddressLookupMessage((error as Error).message);
                        }
                      })
                    }
                  />
                </View>
              )}
              {addressLookupMessage ? (
                <Text
                  accessibilityRole="alert"
                  style={[s.muted, { marginTop: 10 }]}
                >
                  {addressLookupMessage}
                </Text>
              ) : null}
              {data.stats.active > 0 && (
                <Text style={[s.muted, { color: C.amber, marginTop: 10 }]}>
                  운행 중인 코스는 회사 복귀 후 재배차할 수 있어요.
                </Text>
              )}
            </Card>
            <DateControls date={date} setDate={setDate} />
            <RegionalDispatchSummary
              shipments={data.shipments}
              selected={regionFilter}
              onSelect={setRegionFilter}
            />
            {!data.routes.length && (
              <Empty
                title="아직 배차된 코스가 없어요"
                description="배송지를 등록한 뒤 기사를 직접 배정하거나 추천 배차를 생성해 주세요."
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
                  <AdminDeleteButton kind="routes" id={route.id} name={`${route.driverName} 코스`} disabled={busy} onDeleted={() => { refresh().catch((e) => tell(e.message)); }} />
                </View>
                <View style={[s.row, { marginTop: 12, marginBottom: 16 }]}>
                  <Badge text="회사 왕복 포함" />
                  {route.manualAssigned && <Badge text="개별 배차" />}
                  <Badge
                    text={
                      route.estimateSource === "naver-traffic"
                        ? "실시간 교통 반영"
                        : route.estimateSource === "road"
                          ? "도로 기준 예상"
                          : "대략적 예상"
                    }
                    tone={
                      route.estimateSource === "naver-traffic"
                        ? "green"
                        : route.estimateSource === "road"
                          ? "grey"
                          : "amber"
                    }
                  />
                </View>
                {route.manualAssigned && route.status === "planned" && (
                  <Text style={[s.muted, { marginBottom: 12 }]}>
                    추천 배차에서도 기사 배정을 유지해요. 배송지를 개별 배정하면
                    이 코스에 추가됩니다.
                  </Text>
                )}
                <View style={[s.row, { flexWrap: "wrap", marginBottom: 10 }]}>
                  {deliveryRegionGroups(route.stops).map((g) => (
                    <Badge
                      key={g.key}
                      text={`${g.label} ${g.shipments.length}곳`}
                    />
                  ))}
                </View>
                <RoutePlanningSummary route={route} />
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
                        <StopArrival route={route} shipmentId={stop.id} />
                        <Text
                          style={{ color: C.green, fontSize: 10, marginTop: 4 }}
                        >
                          {stop.items
                            .map((item) => `${item.name} ${item.quantity}`)
                            .join(" · ")}
                        </Text>
                      </View>
                    </Pressable>
                  </View>
                ))}
                <TimelineCompany name={route.company.name} label="복귀" />
              </Card>
            ))}
            {data.shipments
              .filter(
                (s) =>
                  s.status === "pending" &&
                  (regionFilter === "all" ||
                    deliveryRegion(s.address).key === regionFilter),
              )
              .map((shipment) => (
                <Pressable
                  key={shipment.id}
                  disabled={!!uploadProgress}
                  onPress={() => !uploadRef.current && setDetail(shipment)}
                >
                  <Card>
                    <View style={s.between}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.h3}>{shipment.recipient}</Text>
                        <Text style={s.muted}>{shipment.address}</Text>
                        <Text
                          style={[s.muted, { color: C.green, marginTop: 5 }]}
                        >
                          {deliveryRegion(shipment.address).label}
                          {shipment.salesReference
                            ? " · 전표 " + shipment.salesReference
                            : ""}
                        </Text>
                      </View>
                      <Badge
                        text={
                          hasNavigationPoint(shipment)
                            ? "미배차"
                            : "주소 자동 확인 예정"
                        }
                        tone="grey"
                      />
                    </View>
                    <Text style={[s.muted, { marginTop: 10 }]}>
                      눌러서 기사 배정 · 수정 · 삭제 · 주소 길찾기
                    </Text>
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
                <View style={{ marginVertical: 10 }}><AdminDeleteButton kind="drivers" id={driver.id} name={driver.name} disabled={busy} onDeleted={() => { refresh().catch((e) => tell(e.message)); }} /></View>
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
        {tab === "invoices" && (
          <InvoiceLookupPanel date={date} onSalesList={setSalesBrowserId} />
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
            <DriverDeliveryHistory
              key={date}
              shipments={data.shipments}
              routes={data.routes}
              drivers={data.drivers}
              onSelect={setDetail}
            />
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
                      {batch.status === "sales-list"
                        ? `${batch.count}건 판매조회 목록`
                        : batch.status === "committed"
                          ? `${batch.count}곳 등록`
                          : "검토 대기"}
                    </Text>
                  </View>
                  <Badge
                    text={
                      batch.status === "sales-list"
                        ? "판매조회 목록"
                        : batch.status === "committed"
                          ? "등록 완료"
                          : "확인 필요"
                    }
                    tone={batch.status === "committed" ? "green" : "amber"}
                  />
                </View>
                <View style={[s.row, { marginTop: 13, flexWrap: "wrap" }]}>
                  {(batch.status === "sales-list" ||
                    batch.source?.startsWith("company-erp")) && (
                    <Button
                      title="판매전표·명세서 보기"
                      small
                      secondary
                      onPress={() =>
                        run(async () => {
                          const row = await api<ImportBatch>(
                            "/api/imports/" + batch.id,
                          );
                          if (
                            row.documents?.length ||
                            row.source === "company-erp-selection"
                          )
                            setSalesBrowserId(batch.id!);
                          else {
                            const shipment = data.shipments.find(
                              (s) => s.importId === batch.id,
                            );
                            if (!shipment)
                              throw new Error(
                                "배송지 상세에서 명세서를 확인해 주세요.",
                              );
                            setInvoiceStatement(
                              await api<SalesDocument>(
                                "/api/shipments/" + shipment.id + "/invoice",
                              ),
                            );
                          }
                        })
                      }
                    />
                  )}
                  {batch.status === "review" && (
                    <Button
                      title="내용 확인"
                      secondary
                      small
                      disabled={!!uploadProgress}
                      onPress={() => run(() => openStoredReview(batch.id!))}
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
                  <Button
                    title="전표 삭제"
                    danger
                    secondary
                    small
                    icon={Trash2}
                    disabled={busy || !!uploadProgress || !!receiptDelete}
                    onPress={() => requestReceiptDelete(batch)}
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
        animationType={review?.deviceLocalId ? "none" : "slide"}
        onClose={() => {
          void closeReview();
        }}
      >
        {review && (
          <>
            {review.deviceLocalId && (
              <View style={{ marginBottom: 14 }}>
                <Badge
                  text={
                    Number.isFinite(review.deviceRecognitionMs)
                      ? `휴대폰 글자 인식 ${(review.deviceRecognitionMs! / 1000).toFixed(1)}초`
                      : "휴대폰에서 글자 인식 완료"
                  }
                />
                <Text style={[s.muted, { marginTop: 8 }]}>
                  배송일 {review.serviceDate} · 서버 연결을 기다리지 않고 읽은
                  내용입니다. 확인 후 저장해 주세요.
                </Text>
              </View>
            )}
            <View style={st.demoBanner}>
              <ShieldCheck color={C.green} size={19} />
              <Text style={[s.muted, { flex: 1, color: C.green }]}>
                수령인·주소·물품을 원본과 대조해 주세요. 확인하기 전에는
                배송지로 등록되지 않아요.
              </Text>
            </View>
            {!!review.filledFields?.length && (
              <Text style={[s.muted, { marginBottom: 12, color: C.green }]}>
                자동 입력:{" "}
                {review.filledFields
                  .map(
                    (field) =>
                      ({
                        recipient: "거래처",
                        address: "배송주소",
                        phone: "연락처",
                        items: "물품·수량",
                      })[field] ?? field,
                  )
                  .join(" · ")}
              </Text>
            )}
            {review.recognitionWarnings?.map((warning) => (
              <Text
                key={warning}
                style={[s.muted, { marginBottom: 8, color: C.red }]}
              >
                {warning}
              </Text>
            ))}
            {!!review.rawText &&
              review.drafts.length === 1 &&
              review.status !== "edit" && (
                <View style={{ marginBottom: 12 }}>
                  <Button
                    title="빈 항목 자동 채우기"
                    secondary
                    icon={RefreshCw}
                    disabled={busy || !!uploadProgress}
                    onPress={() => run(reapplyReceiptAutofill)}
                  />
                  <Text style={[s.muted, { marginTop: 6 }]}>
                    이미 입력한 내용은 유지하고 인식 원문에서 빈칸만 채워요.
                  </Text>
                </View>
              )}
            <View style={{ marginBottom: 16 }}>
              <Button
                title="주소 전체 확인"
                secondary
                icon={MapPin}
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    setReviewError("");
                    let failures = 0;
                    for (let i = 0; i < review.drafts.length; i++) {
                      const row = review.drafts[i];
                      if (hasNavigationPoint(row)) continue;
                      try {
                        const point = await post("/api/geocode", {
                          address: row.address,
                        });
                        updateReview(
                          i,
                          { lat: point.lat, lng: point.lng },
                          row.address,
                        );
                      } catch {
                        failures++;
                      }
                    }
                    if (failures)
                      setReviewError(
                        `${failures}곳의 주소를 찾지 못했어요. 도로명·건물번호를 확인해 주세요. 주소만으로 먼저 저장할 수도 있어요.`,
                      );
                  })
                }
              />
            </View>
            {review.drafts.map((row, index) => (
              <Card key={index}>
                <View style={[s.between, { marginBottom: 17 }]}>
                  <Text style={s.h3}>배송지 {index + 1}</Text>
                  {review.drafts.length > 1 && (
                    <Pressable
                      accessibilityLabel="이 배송지 제외"
                      disabled={busy || !!receiptDelete}
                      onPress={() => {
                        if (reviewSaving.current) return;
                        setReview({
                          ...review,
                          drafts: review.drafts.filter((_, i) => i !== index),
                        });
                      }}
                    >
                      <Trash2 size={17} color={C.red} />
                    </Pressable>
                  )}
                </View>
                {review.erpSaleRequestId && (
                  <ErpSaleIdentity
                    requestId={review.erpSaleRequestId}
                    locked={!!review.erpSaleLocked}
                    onReady={(ready) =>
                      setReview((old) =>
                        old ? { ...old, erpWriteReady: ready } : old,
                      )
                    }
                  />
                )}
                {!row.erpSourceKey && !review.erpSaleRequestId && (
                  <Field
                    label="판매번호 (선택)"
                    value={row.salesReference ?? ""}
                    placeholder="20261106-48"
                    onChangeText={(salesReference) =>
                      updateReview(index, { salesReference })
                    }
                  />
                )}
                {parseSalesReference(row.salesReference) && (
                  <Text style={[s.muted, { marginBottom: 10 }]}>
                    전표일 {parseSalesReference(row.salesReference)!.date} ·{" "}
                    {parseSalesReference(row.salesReference)!.sequence}번 · 배송
                    예정일 {review.serviceDate}
                  </Text>
                )}
                {!!row.salesReference && (
                  <Text style={[s.muted, { marginBottom: 12 }]}>
                    판매전표 {row.salesReference}
                  </Text>
                )}
                {review.erpSaleRequestId && (
                  <>
                    <Text style={[s.muted, { marginBottom: 12 }]}>
                      판매구분 ·{" "}
                      {row.erpPriceChannel === "retail"
                        ? "소매"
                        : row.erpPriceChannel === "wholesale"
                          ? "도매"
                          : "거래처 선택 후 확인"}{" "}
                      (ERP 거래처 기본 구분)
                    </Text>
                  </>
                )}
                <View style={{ marginBottom: 12 }}>
                  <Button
                    title="거래처 검색"
                    secondary
                    small
                    disabled={busy || !!review.erpSaleLocked}
                    onPress={() =>
                      setCatalogTarget({ kind: "customers", row: index })
                    }
                  />
                </View>
                <Field
                  label="수령인 / 거래처"
                  editable={!review.erpSaleLocked}
                  value={row.recipient}
                  onChangeText={(recipient) =>
                    updateReview(index, {
                      recipient,
                      customerCode: undefined,
                      erpCustomerId: undefined,
                    })
                  }
                />
                <Field
                  label="배송주소"
                  editable={!review.erpSaleLocked}
                  value={row.address}
                  onChangeText={(address) =>
                    updateReview(index, { address, lat: null, lng: null })
                  }
                  multiline
                />
                <Text style={[s.muted, { marginBottom: 10 }]}>
                  지역 · {deliveryRegion(row.address).label}
                </Text>
                <Field
                  label="연락처"
                  editable={!review.erpSaleLocked}
                  value={row.phone ?? ""}
                  onChangeText={(phone) => updateReview(index, { phone })}
                />
                <InvoiceItemsEditor
                  items={row.items}
                  disabled={
                    busy ||
                    !!review.erpSaleLocked ||
                    (review.status === "edit" && !!row.erpSourceKey)
                  }
                  onSearch={(item) =>
                    setCatalogTarget({ kind: "products", row: index, item })
                  }
                  onChange={(items) => {
                    const totals = invoiceTotals(items);
                    updateReview(index, {
                      items,
                      ...(totals.complete ? { amount: totals.total } : {}),
                    });
                  }}
                />
                {!review.erpSaleRequestId && row.amount != null && (
                  <Text style={[s.muted, { marginBottom: 12 }]}>
                    전표 합계 {row.amount.toLocaleString()}원
                  </Text>
                )}
                <Field
                  label="요청사항"
                  editable={!review.erpSaleLocked}
                  value={row.notes ?? ""}
                  onChangeText={(notes) => updateReview(index, { notes })}
                />
                <Text style={[s.muted, { marginBottom: 12 }]}>
                  {hasNavigationPoint(row)
                    ? "주소 확인 완료"
                    : "주소만 입력하면 배차할 때 위치를 자동 확인해요."}
                </Text>
                <Button
                  title={
                    hasNavigationPoint(row) ? "주소 다시 확인" : "주소 확인"
                  }
                  secondary
                  icon={MapPin}
                  disabled={busy || !row.address}
                  onPress={() => locateRow(index)}
                />
              </Card>
            ))}
            {!!review.rawText && (
              <Card>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    showReceiptText ? "인식 원문 접기" : "인식 원문 보기"
                  }
                  onPress={() => setShowReceiptText((shown) => !shown)}
                  style={s.between}
                >
                  <Text style={s.h3}>
                    {showReceiptText ? "인식 원문 접기" : "인식 원문 보기"}
                  </Text>
                  <ChevronRight color={C.muted} size={18} />
                </Pressable>
                {showReceiptText && (
                  <Text selectable style={[s.muted, { marginTop: 12 }]}>
                    {review.rawText}
                  </Text>
                )}
              </Card>
            )}
            <Text style={[s.muted, { marginBottom: 15 }]}>
              주소만 입력해 저장하면 돼요. 기사 배정·추천 배차 때 위치를 자동
              확인합니다.
            </Text>
            <Button
              title={
                review.erpSaleRequestId
                  ? "ERP 판매·배송지 함께 저장"
                  : `${review.drafts.length}곳 확인하고 ${review.status === "edit" ? "저장" : "배송지 등록"}`
              }
              icon={Check}
              disabled={
                busy ||
                !!uploadProgress ||
                (!!review.erpSaleRequestId &&
                  !review.erpWriteReady &&
                  !review.erpSaleLocked)
              }
              onPress={() => run(() => saveReview())}
            />
            {reviewError ? (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginTop: 12 }}
              >
                {reviewError}
              </Text>
            ) : null}
            {(review.id || review.deviceLocalId) &&
              review.status !== "edit" &&
              review.status !== "committed" && (
                <View style={{ marginTop: 10 }}>
                  <Button
                    title="저장하고 다음 전표 촬영"
                    secondary
                    icon={Camera}
                    disabled={busy || !!uploadProgress}
                    onPress={() => run(() => saveReview(true))}
                  />
                </View>
              )}
            {review.status !== "edit" &&
              !review.erpSaleRequestId &&
              !review.drafts.some((row) => row.erpSourceKey) && (
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
            {review.status !== "edit" &&
              (review.id || review.deviceLocalId) && (
                <View style={{ marginTop: 18 }}>
                  <Button
                    title="이 전표 삭제"
                    danger
                    secondary
                    icon={Trash2}
                    disabled={busy || !!uploadProgress || !!receiptDelete}
                    onPress={() => requestReceiptDelete(review)}
                  />
                </View>
              )}
          </>
        )}
      </Sheet>
      <CompanySalesBrowser
        onRecommend={(value) => { setSalesBrowserId(null); setDate(value); setTab("routes"); void run(async () => { await post("/api/routes/optimize", { serviceDate: value, groupByRegion: true }); await refresh(); }); }}
        batchId={salesBrowserId}
        onClose={() => setSalesBrowserId(null)}
        onFindInvoice={() => {
          setSalesBrowserId(null);
          setTab("invoices");
        }}
        onSaved={(value) => {
          setDate(value);
          refresh().catch((e) => tell(e.message));
        }}
      />
      <SalesInvoiceStatement
        doc={invoiceStatement}
        onClose={() => setInvoiceStatement(null)}
      />
      <CatalogPicker
        kind={catalogTarget?.kind ?? null}
        onClose={() => setCatalogTarget(null)}
        onSelect={(entry) => {
          if (!catalogTarget || !reviewRef.current) return;
          const row = reviewRef.current.drafts[catalogTarget.row];
          if (!row) return;
          if (catalogTarget.kind === "customers")
            updateReview(catalogTarget.row, invoiceCustomer(row, entry));
          else {
            const items = row.items.map((item, i) =>
              i === catalogTarget.item
                ? invoiceProduct(item, entry, row.erpPriceChannel)
                : item,
            );
            const totals = invoiceTotals(items);
            updateReview(catalogTarget.row, {
              items,
              ...(totals.complete ? { amount: totals.total } : {}),
            });
          }
          Keyboard.dismiss();
          setCatalogTarget(null);
        }}
      />
      {boardOpen && (
        <DispatchBoardScreen
          visible
          data={{
            drivers: data.drivers,
            routes: data.routes.map((route) => ({
              ...route,
              stops: route.stops.map((stop) => ({
                ...stop,
                region: deliveryRegion(stop.address).label,
              })),
            })),
            shipments: data.shipments.map((stop) => ({
              ...stop,
              region: deliveryRegion(stop.address).label,
            })),
            serviceDate: date,
            revision: data.dispatchRevision ?? "",
            busy: boardSaving,
            message: boardMessage,
          }}
          onDrop={dropOnBoard}
          onClose={() => {
            if (!boardSavingRef.current) setBoardOpen(false);
          }}
        />
      )}
      <AdminMapOverview
        visible={mapOverview}
        data={adminMapData}
        onClose={() => setMapOverview(false)}
        onConfigure={openMapSettings}
        onAllDrivers={
          selectedDriver ? () => setSelectedDriver(null) : undefined
        }
      />
      <Sheet
        title="네이버 지도 설정"
        visible={!!mapSettings}
        onClose={() => setMapSettings(null)}
      >
        {mapSettings && (
          <>
            <Field
              label="네이버 지도 Key ID"
              value={mapSettings.naverKeyId}
              placeholder="웹 지도용 Key ID"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(naverKeyId) => setMapSettings({ naverKeyId })}
            />
            <Text style={[s.muted, { marginBottom: 15 }]}>
              네이버 Cloud Maps Application의 웹 지도용 Key ID를 입력해 주세요.
              Dynamic Map을 활성화하고 Web 서비스 URL에 현재 서버 주소를
              등록해야 합니다.
            </Text>
            <Text selectable style={[s.muted, { marginBottom: 15 }]}>
              {API_URL}
            </Text>
            <Button
              title="네이버 Cloud Application 열기"
              secondary
              onPress={() =>
                Linking.openURL("https://console.ncloud.com/maps/application")
              }
            />
            <Text style={[s.muted, { marginVertical: 15 }]}>
              지도 설정은 운행 중에도 변경할 수 있으며 배차와 배송 내역은
              유지됩니다.
            </Text>
            {!data.mapSettings && (
              <Text style={[s.muted, { marginBottom: 15 }]}>
                현재 서버에는 지도 설정 기능이 없습니다. 최신 서버 버전을 배포한
                뒤 저장해 주세요.
              </Text>
            )}
            <Button
              title="지도 설정 저장"
              icon={Check}
              disabled={busy || !data.mapSettings}
              onPress={() =>
                run(async () => {
                  await api("/api/map-settings", {
                    method: "PUT",
                    body: JSON.stringify(mapSettings),
                  });
                  setMapSettings(null);
                  await refresh();
                })
              }
            />
          </>
        )}
      </Sheet>
      <Sheet
        title="회사 · 배송 설정"
        visible={!!company}
        onClose={() => {
          if (!busy) setCompany(null);
        }}
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
              onChangeText={(address) => {
                setCompany({ ...company, address, lat: NaN, lng: NaN });
                setCompanyError("");
              }}
              multiline
            />
            <Button
              title="회사 주소 확인"
              secondary
              icon={MapPin}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  setCompanyError("");
                  try {
                    const point = await post("/api/geocode", {
                      address: company.address,
                    });
                    setCompany((current) =>
                      current?.address === company.address
                        ? { ...current, lat: point.lat, lng: point.lng }
                        : current,
                    );
                  } catch (error) {
                    setCompanyError((error as Error).message);
                  }
                })
              }
            />
            <Text style={[s.muted, { marginTop: 10, marginBottom: 20 }]}>
              {hasNavigationPoint(company)
                ? "회사 주소 확인 완료"
                : "주소만 입력하면 저장할 때 회사 출발·복귀 위치를 자동 확인해요."}
            </Text>
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
              예상 시간은 배송지 체류와 회사 복귀를 포함합니다. 배차할 때 실시간
              교통 반영 여부를 선택할 수 있어요.
            </Text>
            {companyError ? (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginBottom: 16 }}
              >
                {companyError}
              </Text>
            ) : null}
            <Button
              title="회사 설정 저장"
              icon={Check}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  setCompanyError("");
                  try {
                    await api("/api/company", {
                      method: "PUT",
                      body: JSON.stringify(company),
                    });
                    setCompany(null);
                    await refresh();
                  } catch (error) {
                    setCompanyError((error as Error).message);
                  }
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
        title="기사에게 개별 배정"
        visible={!!assignment}
        onClose={closeAssignment}
      >
        {assignment && (
          <>
            <Text style={[s.h2, { marginBottom: 10 }]}>
              {assignment.recipient}
            </Text>
            <Text style={[s.muted, { marginBottom: 16 }]}>
              {assignment.address}
            </Text>
            <Text style={[s.muted, { marginBottom: 18 }]}>
              추천 배차 없이 기사에게 바로 배정해요. 선택한 기사 코스에 추가하고
              배송 순서·회사 복귀 시간을 다시 계산합니다.
            </Text>
            {data.drivers
              .filter((driver) => driver.active)
              .map((driver) => {
                const planned = data.routes.find(
                  (route) =>
                    route.driverId === driver.id && route.status === "planned",
                );
                const driving = data.routes.some(
                  (route) =>
                    route.driverId === driver.id &&
                    ["active", "returning"].includes(route.status),
                );
                const count = planned?.stops.length ?? 0;
                const full = count >= driver.capacity;
                return (
                  <Card key={driver.id}>
                    <Text style={s.h3}>{driver.name}</Text>
                    <Text style={[s.muted, { marginTop: 8, marginBottom: 14 }]}>
                      {driving
                        ? "배송·복귀 중에는 추가 배정할 수 없어요."
                        : full
                          ? `현재 ${count}곳 · 최대 ${driver.capacity}곳으로 가득 찼어요.`
                          : planned
                            ? `출발 전 코스 ${count}곳 → ${count + 1}곳 · 최대 ${driver.capacity}곳`
                            : `새 코스로 배정 · 최대 ${driver.capacity}곳`}
                    </Text>
                    <Button
                      title={
                        assignmentSaving
                          ? "배정 중…"
                          : `${driver.name} 기사에게 배정`
                      }
                      icon={Truck}
                      disabled={
                        busy ||
                        assignmentSaving ||
                        driving ||
                        full ||
                        !!uploadProgress
                      }
                      onPress={() => run(() => assignShipment(driver.id))}
                    />
                  </Card>
                );
              })}
            {!data.drivers.some((driver) => driver.active) && (
              <Text style={[s.muted, { marginBottom: 20 }]}>
                등록된 활동 기사가 없어요. 기사 메뉴에서 기사를 추가해 주세요.
              </Text>
            )}
            {assignmentError ? (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginBottom: 16 }}
              >
                {assignmentError}
              </Text>
            ) : null}
            <Button
              title="닫기"
              secondary
              disabled={assignmentSaving}
              onPress={closeAssignment}
            />
          </>
        )}
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
            {detail.salesReference && (
              <View style={{ marginVertical: 12 }}>
                <Button
                  title="거래명세서 보기"
                  secondary
                  onPress={() =>
                    run(async () =>
                      setInvoiceStatement(
                        await api<SalesDocument>(
                          "/api/shipments/" + detail.id + "/invoice",
                        ),
                      ),
                    )
                  }
                />
              </View>
            )}
            <Text style={[s.h3, { marginBottom: 15 }]}>배송 물품</Text>
            {detail.amount != null && (
              <Text style={[s.h3, { marginVertical: 12 }]}>
                전표 금액 {detail.amount.toLocaleString()}원
              </Text>
            )}
            {!!detail.salesReference && (
              <Text style={s.muted}>판매전표 {detail.salesReference}</Text>
            )}
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
            <View style={{ marginTop: 20 }}>
              <Button
                title="주소로 길찾기"
                secondary
                icon={Navigation}
                disabled={busy || !detail.address.trim()}
                onPress={() =>
                  run(async () => {
                    setDetailError("");
                    try {
                      await navigate(detail, data.company);
                    } catch (error) {
                      setDetailError((error as Error).message);
                    }
                  })
                }
              />
            </View>
            {detailError ? (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginTop: 12 }}
              >
                {detailError}
              </Text>
            ) : null}
            {detail.status === "pending" && !detail.routeId && (
              <>
                <View style={{ marginTop: 10 }}>
                  <Button
                    title="기사 배정"
                    icon={Truck}
                    disabled={busy || !!uploadProgress || !!receiptDelete}
                    onPress={() => openAssignment(detail)}
                  />
                </View>
                <View style={{ marginTop: 10 }}>
                  <Button
                    title="배송지 수정"
                    secondary
                    icon={ClipboardList}
                    disabled={busy || !!uploadProgress || !!receiptDelete}
                    onPress={() => {
                      if (
                        uploadRef.current ||
                        reviewSaving.current ||
                        receiptDeleteRef.current
                      )
                        return;
                      const batch: ImportBatch = {
                        fileName: "배송지 수정",
                        drafts: [detail],
                        serviceDate: detail.serviceDate,
                        status: "edit",
                      };
                      reviewRef.current = batch;
                      setReviewError("");
                      setDetail(null);
                      setReview(batch);
                    }}
                  />
                </View>
              </>
            )}
            {(
              <View style={{ marginTop: 20 }}>
                <Button
                  title="이 배송지 삭제"
                  danger
                  secondary
                  icon={Trash2}
                  disabled={busy || !!uploadProgress || !!receiptDelete}
                  onPress={() =>
                    requestReceiptDelete({
                      fileName: detail.recipient,
                      drafts: [detail],
                      serviceDate: detail.serviceDate,
                      shipment: detail,
                    })
                  }
                />
              </View>
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
      <Sheet
        title={receiptDelete?.shipment ? "배송지 삭제 확인" : "전표 삭제 확인"}
        visible={!!receiptDelete}
        animationType="fade"
        onClose={cancelReceiptDelete}
      >
        {receiptDelete && (
          <>
            <Text style={[s.h3, { marginBottom: 12 }]}>
              {receiptDelete.fileName}
            </Text>
            <Text style={[s.muted, { marginBottom: 14 }]}>
              {receiptDelete.shipment
                ? receiptDelete.shipment.routeId
                  ? "배송지 1곳을 삭제하고 남은 코스를 갱신합니다. 운행 중인 기사 화면에도 반영됩니다. 업로드한 원본과 다른 배송지는 보관됩니다."
                  : "미배차 배송지 1곳을 삭제합니다. 업로드한 전표 원본과 다른 배송지는 보관됩니다."
                : receiptDelete.status === "committed"
                  ? `전표 1건과 연결된 배송지 최대 ${receiptDelete.count ?? receiptDelete.drafts.length}곳을 함께 삭제합니다. 배차·완료 내역에도 반영됩니다.`
                  : receiptDelete.id
                    ? "이 조회 기록의 JSON·사진 원본과 검토 내역을 삭제합니다. ERP 원본은 유지됩니다."
                    : "기기에 보관한 전표 1건과 앱 전용 사진 복사본을 삭제합니다. 휴대폰 갤러리의 원본은 보관됩니다."}
            </Text>
            {(receiptDelete.id || receiptDelete.shipment) && (
              <Text style={[s.muted, { marginBottom: 14 }]}>
                관리자 권한으로 앱 기록을 삭제합니다. ERP 원본 판매전표와 재고는 변경하지 않습니다.
              </Text>
            )}
            <Text style={{ color: C.red, marginBottom: 18 }}>
              삭제한 내용은 되돌릴 수 없습니다.
            </Text>
            {receiptDeleteError ? (
              <Text
                accessibilityRole="alert"
                style={{ color: C.red, marginBottom: 18 }}
              >
                {receiptDeleteError}
              </Text>
            ) : null}
            <Button
              title={receiptDeleting ? "삭제 중…" : "삭제하기"}
              danger
              icon={Trash2}
              disabled={receiptDeleting}
              onPress={() => {
                void deleteReceipt();
              }}
            />
            <View style={{ marginTop: 10 }}>
              <Button
                title="취소"
                secondary
                disabled={receiptDeleting}
                onPress={cancelReceiptDelete}
              />
            </View>
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
  const driverRefreshEpoch = useRef(0);
  const [confirmation, setConfirmation] = useState<Shipment | null>(null);
  const [navigationPrompt, setNavigationPrompt] = useState<Route | null>(null);
  const [completionError, setCompletionError] = useState("");
  const completionLock = useRef(false);
  const [completing, setCompleting] = useState(false);
  const [data, setData] = useState<DriverRouteData | null>(null),
    [mode, setMode] = useState<string>(trackingMode),
    [failed, setFailed] = useState<Shipment | null>(null),
    [overview, setOverview] = useState(false),
    [automation, setAutomation] = useState<DriverAutomation | null>(null),
    [reason, setReason] = useState("");
  const refresh = useCallback(async () => {
    const epoch = ++driverRefreshEpoch.current;
    const [current, settings] = await Promise.all([
      api<DriverRouteData>("/api/me"),
      getDriverAutomation(),
    ]);
    if (epoch === driverRefreshEpoch.current) {
      setData(current);
      setAutomation(settings);
    }
  }, []);
  useEffect(() => {
    restoreTrackingMode()
      .then(setMode)
      .catch(() => {});
    refresh().catch((e) => tell(e.message));
    const interval = setInterval(() => refresh().catch(() => {}), 15000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        refresh().catch(() => {});
        restoreTrackingMode()
          .then(setMode)
          .catch(() => {});
      }
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
  useEffect(
    () =>
      subscribeDriverArrival(() => {
        refresh().catch(() => {});
      }),
    [refresh],
  );
  useEffect(() => {
    const current = data?.route;
    if (!current || !["active", "returning"].includes(current.status)) {
      setConfirmation(null);
      setNavigationPrompt(null);
      return;
    }
    if (automation?.routeId !== current.id) return;
    const candidate = current.stops.find((stop) => stop.status === "assigned");
    if (automation.pendingArrival?.stopId === candidate?.id && candidate) {
      setConfirmation(candidate);
    } else
      setConfirmation((old) =>
        old &&
        current.stops.find((stop) => stop.id === old.id)?.status === "assigned"
          ? old
          : null,
      );
    if (
      automation.pendingNavigation &&
      current.stops.some(
        (stop) =>
          stop.id === automation.pendingNavigation!.completedStopId &&
          ["delivered", "failed"].includes(stop.status),
      )
    )
      setNavigationPrompt(current);
  }, [
    data?.route,
    automation?.pendingArrival?.stopId,
    automation?.pendingNavigation?.completedStopId,
  ]);
  if (!data) return <Loading />;
  const route = data.route,
    company = route?.company ?? data.company,
    remaining = route?.stops.filter((s) => s.status === "assigned") ?? [],
    next = remaining[0],
    completed =
      route?.stops.filter((s) => s.status === "delivered").length ?? 0,
    active = !!route && ["active", "returning"].includes(route.status);
  const requestMapSettings = () => {
    setOverview(false);
    tell("네이버 지도 연결 설정은 관리자에게 확인해 주세요.");
  };
  const share = async () => {
    try {
      if (route && automation?.routeId !== route.id)
        setAutomation(await configureDriverAutomation(route.id, true));
      return await startTracking(tell);
    } finally {
      setMode(trackingMode);
    }
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
    const actualMode = await restoreTrackingMode();
    const sharing = actualMode === "background" ? actualMode : await share();
    if (Platform.OS !== "web" && sharing !== "background")
      throw new Error(
        "내비를 사용하는 동안 도착 확인을 받으려면 위치 권한을 항상 허용하고 알림 권한을 켜 주세요.",
      );
    await navigateCourse(current);
    setAutomation(await getDriverAutomation());
  };
  const performComplete = async (
    stop: Shipment,
    status = "delivered",
    failureReason?: string,
  ) => {
    if (completionLock.current || !route) return;
    completionLock.current = true;
    Keyboard.dismiss();
    driverRefreshEpoch.current++;
    setCompleting(true);
    setCompletionError("");
    try {
      let updated: Route;
      try {
        updated = await post<Route>(
          "/api/driver/stops/" + stop.id + "/complete",
          { status, reason: failureReason, expectedRouteId: route.id },
        );
      } catch (error) {
        const fresh = await api<DriverRouteData>("/api/me").catch(() => null);
        if (
          fresh?.route?.id === route.id &&
          fresh.route.stops.some(
            (item) => item.id === stop.id && item.status === status,
          )
        )
          updated = fresh.route;
        else throw error;
      }
      driverRefreshEpoch.current++;
      setData((previous) =>
        previous ? { ...previous, route: updated } : previous,
      );
      setConfirmation(null);
      setFailed(null);
      setReason("");
      await recordHandledStop(
        updated.id,
        updated.stops.find((item) => item.id === stop.id) ?? {
          ...stop,
          status,
        },
      );
      setAutomation(await getDriverAutomation());
      setNavigationPrompt(updated);
    } catch (error) {
      setCompletionError((error as Error).message);
      throw error;
    } finally {
      completionLock.current = false;
      setCompleting(false);
    }
  };
  const complete = (
    stop: Shipment,
    status = "delivered",
    failureReason?: string,
  ) => {
    if (status === "delivered") {
      setCompletionError("");
      setConfirmation(stop);
    } else run(() => performComplete(stop, status, failureReason));
  };
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
                {route.estimateSource === "naver-traffic"
                  ? "네이버 실시간 교통 반영 · 배차 계산 시점 기준, 배송지 체류·회사 복귀 포함"
                  : route.estimateSource === "approximate"
                    ? "대략적 예상 · 도로 정보를 가져오지 못해 거리로 추정했어요."
                    : "도로 기준 예상 · 배송지 체류 포함, 실시간 교통 미반영"}
              </Text>
            </Card>
            <RoutePlanningSummary route={route} />
            <CargoSummary stops={route.stops} />
            <Text style={[s.h3, { marginBottom: 10 }]}>전체 경로 미리보기</Text>
            <MapPanel
              data={createDriverMapData(route, data.mapSettings)}
              height={280}
              onConfigure={requestMapSettings}
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
                    ? "길안내·화면 잠금·최근 앱 목록에서 닫은 뒤에도 운행 중 위치를 공유합니다. 휴대폰 배터리 설정에 따라 중단될 수 있어요."
                    : "위치 ‘항상 허용’과 알림 권한을 확인해 주세요. 현재는 앱을 보고 있는 동안에만 위치를 공유합니다."}
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
                <Text style={[s.muted, { marginTop: 10 }]}>
                  Android 설정에서 위치를 ‘항상 허용’, 정확한 위치·알림을 켜고
                  배터리를 ‘제한 없음’으로 설정해 주세요. 강제 중지·휴대폰
                  재부팅 후에는 앱에서 위치 공유를 다시 켜야 합니다.
                </Text>
                <View style={{ marginTop: 10 }}>
                  <Button
                    title="휴대폰 앱 설정 열기"
                    secondary
                    small
                    onPress={() => run(() => Linking.openSettings())}
                  />
                </View>
                <View style={{ marginTop: 14, gap: 10 }}>
                  <Button
                    title="네이버로 남은 코스 연속 안내"
                    icon={Navigation}
                    disabled={busy}
                    onPress={() => run(() => openCourse(route, true))}
                  />
                  <View style={s.between}>
                    <Text style={[s.h3, { flex: 1 }]}>
                      GPS 도착 시 배송 확인 알림
                    </Text>
                    <Switch
                      accessibilityLabel="GPS 도착 확인 알림"
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
                    정확한 위치로 배송지 80m 이내에서 30초 이상 정차하면 배송
                    완료 확인창을 표시합니다. 외부 내비나 화면 잠금 중에는 도착
                    알림을 눌러 확인해 주세요.
                  </Text>
                  <Text style={[s.muted, { fontSize: 11 }]}>
                    네이버 내비는 경유지 5곳까지 지원합니다. 긴 코스는 다음 구간
                    알림을 눌러 이어서 안내합니다.
                  </Text>
                  {automation?.lastCompletion && (
                    <Text style={[s.muted, { color: C.green }]}>
                      {automation.lastCompletion.status === "failed"
                        ? "최근 미배송 기록"
                        : "최근 배송 완료"}
                      : {automation.lastCompletion.sequence}번 배송지
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
                  네이버 지도에 경유지를 묶어 전달하고 도착 시 배송 완료를
                  확인합니다. 위치를 항상 허용하고 알림 권한을 켜 주세요. 5곳
                  이내 코스는 회사 복귀까지 한 번에 안내합니다.
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
                <StopArrival route={route} shipmentId={next.id} />
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
                    title={"배송 완료 확인"}
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
                    <StopArrival route={route} shipmentId={stop.id} />
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
          mapSettings={data.mapSettings}
          visible={overview}
          onClose={() => setOverview(false)}
          onConfigure={requestMapSettings}
        />
      )}
      <DeliveryConfirmations
        stop={confirmation}
        route={navigationPrompt}
        busy={busy || completing}
        error={completionError}
        onConfirm={() =>
          confirmation && run(() => performComplete(confirmation))
        }
        onDefer={() => {
          if (completionLock.current) return;
          const stop = confirmation;
          setConfirmation(null);
          setCompletionError("");
          if (stop && route) void dismissDriverArrival(route.id, stop.id);
        }}
        onWait={() => {
          if (completionLock.current) return;
          const current = navigationPrompt;
          setNavigationPrompt(null);
          setCompletionError("");
          if (current) void clearPendingNavigation(current.id);
        }}
        onNavigate={() =>
          run(async () => {
            if (!navigationPrompt) return;
            setCompletionError("");
            try {
              const fresh = await api<DriverRouteData>("/api/me");
              if (
                !fresh.route ||
                fresh.route.id !== navigationPrompt.id ||
                !["active", "returning"].includes(fresh.route.status)
              )
                throw new Error("현재 코스를 다시 확인해 주세요.");
              const destination =
                fresh.route.stops.find((stop) => stop.status === "assigned") ??
                fresh.route.company;
              if (Platform.OS !== "web") await navigateCourse(fresh.route);
              else
                await navigate(destination, {
                  ...fresh.route.company,
                  navigation: "naver",
                });
              await clearPendingNavigation(fresh.route.id);
              setNavigationPrompt(null);
            } catch (error) {
              setCompletionError((error as Error).message);
              throw error;
            }
          })
        }
      />
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
          관리자에게 사유를 저장한 뒤 다음 코스 이동 여부를 확인합니다.
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
  loginEditing: {
    justifyContent: "flex-start",
    paddingTop: 16,
    paddingBottom: 24,
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
