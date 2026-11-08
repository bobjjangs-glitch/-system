import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Pressable, Text, View } from "react-native";
import { api, koreanDate } from "./api";
import { Button, Card, Field, C, s } from "./ui";
import { readTime, type ErpStatus } from "./erpTypes";
import { matchesSalesDocumentQuery, validSalesDate } from "./salesReference";
import { invoiceMoney, invoiceStatus, type SalesList } from "./salesDocuments";
type CatalogState = { count: number | null; updatedAt: string | null; error?: string };
type Catalogs = Partial<Record<"customers" | "products", CatalogState>>;
function companyAddress(value?: string) {
  if (!value) return "회사 ERP 주소 확인 필요";
  try { const url = new URL(value); return url.origin + url.pathname; }
  catch { return "회사 ERP 주소 확인 필요"; }
}
function foreground() {
  return AppState.currentState !== "background" && AppState.currentState !== "inactive" &&
    (Platform.OS !== "web" || typeof document === "undefined" || document.visibilityState !== "hidden");
}
export default function CompanyErpPanel({ date, disabled, onSalesList, onOpenInvoices, onSalesDocument, refreshKey = 0 }: {
  date: string;
  disabled: boolean;
  onSalesList: (id: string) => void;
  onOpenInvoices: () => void;
  onSalesDocument?: (list: SalesList, sourceKey: string) => void;
  refreshKey?: number;
}) {
  const [status, setStatus] = useState<ErpStatus | null>(null),
    [salesDate, setSalesDate] = useState(koreanDate),
    [followToday, setFollowToday] = useState(true),
    [snapshot, setSnapshot] = useState<SalesList | null>(null),
    [filter, setFilter] = useState(""),
    [catalogs, setCatalogs] = useState<Catalogs>({}),
    [catalogBusy, setCatalogBusy] = useState(false),
    [salesBusy, setSalesBusy] = useState(false),
    [error, setError] = useState(""),
    [catalogError, setCatalogError] = useState(""),
    [help, setHelp] = useState(false);
  const active = useRef(true), catalogGuard = useRef(false), salesGuard = useRef(false),
    generation = useRef(0), query = useRef<AbortController | null>(null),
    snapshotSource = useRef(""),
    latest = useRef({ salesDate, serviceDate: date, disabled, followToday, status });
  latest.current = { salesDate, serviceDate: date, disabled, followToday, status };
  const catalogLoader = useRef<() => Promise<void>>(async () => {}),
    salesLoader = useRef<() => Promise<void>>(async () => {});
  const ready = !!status?.company?.configured && !!status.automaticDailySales &&
    !!status.salesInvoiceBrowser && !!status.invoiceReferenceLookup && !!status.nativeArchiveInvoices;

  const loadCatalogs = async () => {
    if (catalogGuard.current || !active.current) return;
    catalogGuard.current = true;
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const value = await api<ErpStatus>("/api/erp/status");
      if (!active.current) return;
      setStatus(value);
      if (!value.company?.configured) {
        setCatalogError("회사 ERP 연결 설정이 필요합니다. 아래 설치·연결 안내를 확인해 주세요.");
        return;
      }
      if (!value.automaticCompanyCatalogs || !value.nativeArchiveInvoices) {
        setCatalogError("자동 조회를 사용하려면 Render 서버를 1.14.0 이상으로 배포해 주세요.");
        return;
      }
      const rows = await api<Catalogs>("/api/company-erp/catalog/refresh", { method: "POST" });
      if (active.current) setCatalogs(rows);
    } catch (e) {
      if (active.current) setCatalogError((e as Error).message);
    } finally {
      catalogGuard.current = false;
      if (active.current) setCatalogBusy(false);
    }
  };
  const readSales = async () => {
    const current = latest.current, selectedDate = current.salesDate, serviceDate = current.serviceDate;
    if (salesGuard.current || current.disabled || !active.current || !validSalesDate(selectedDate) ||
      !current.status?.company?.configured || !current.status.automaticDailySales) return;
    salesGuard.current = true;
    const seq = ++generation.current, controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 65000);
    query.current?.abort(); query.current = controller;
    setSalesBusy(true); setError("");
    try {
      const result = await api<SalesList>("/api/company-erp/sales/preview?" +
        new URLSearchParams({ salesDate: selectedDate, serviceDate }).toString(), { signal: controller.signal });
      if (active.current && seq === generation.current && latest.current.salesDate === selectedDate && latest.current.serviceDate === serviceDate)
        setSnapshot(result);
    } catch (e) {
      if (active.current && seq === generation.current && (!controller.signal.aborted || timedOut))
        setError(timedOut ? "회사 ERP 판매내역 조회 시간이 초과됐습니다. 연결 상태를 확인한 뒤 다시 조회해 주세요." : (e as Error).message);
    } finally {
      clearTimeout(timeout);
      if (seq === generation.current) {
        salesGuard.current = false;
        if (active.current) setSalesBusy(false);
      }
    }
  };
  catalogLoader.current = loadCatalogs;
  salesLoader.current = readSales;
  useEffect(() => {
    active.current = true;
    const refresh = () => {
      if (!active.current || !foreground()) return;
      const current = latest.current, today = koreanDate();
      if (current.followToday && current.salesDate !== today) setSalesDate(today);
      else void salesLoader.current();
      void catalogLoader.current();
    };
    void catalogLoader.current();
    const timer = setInterval(refresh, 60000);
    const focus = AppState.addEventListener("change", (state) => { if (state === "active") refresh(); });
    const webFocus = () => refresh();
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.addEventListener("focus", webFocus);
      document.addEventListener("visibilitychange", webFocus);
    }
    return () => {
      active.current = false;
      generation.current++;
      query.current?.abort();
      clearInterval(timer); focus.remove();
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.removeEventListener("focus", webFocus);
        document.removeEventListener("visibilitychange", webFocus);
      }
    };
  }, []);
  useEffect(() => {
    generation.current++;
    query.current?.abort(); salesGuard.current = false;
    setSalesBusy(false); setError("");
    const source = status?.company?.apiUrl ?? "", changedSource = snapshotSource.current !== source;
    snapshotSource.current = source;
    setSnapshot(old => !changedSource && old?.salesDate === salesDate && old.serviceDate === date ? old : null);
    if (ready && !disabled) void salesLoader.current();
  }, [salesDate, date, ready, disabled, refreshKey, status?.company?.apiUrl]);
  useEffect(() => setFilter(""), [salesDate]);
  const documents = snapshot?.documents.filter(doc => matchesSalesDocumentQuery(doc, filter)) ?? [];
  const currentSnapshot = snapshot?.salesDate === salesDate && snapshot.serviceDate === date;
  return <Card>
    <Text style={s.h3}>회사 ERP 자동 조회</Text>
    <Text style={[s.muted, { marginVertical: 10 }]}>거래처·품목과 오늘의 판매전표를 자동으로 불러옵니다. 판매전표를 누르면 최신 내용이 작성 화면에 채워집니다.</Text>
    <View style={{ padding: 12, marginBottom: 12, borderRadius: 12, backgroundColor: C.bg, gap: 5 }}>
      <Text style={{ color: C.green, fontWeight: "700" }}>조회 대상 · {status?.company?.providerLabel ?? "회사 자체 ERP"}</Text>
      <Text selectable style={[s.muted, { overflow: "hidden" }]}>{companyAddress(status?.company?.apiUrl)}</Text>
    </View>
    {catalogBusy && <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
      <ActivityIndicator color={C.green} /><Text style={s.muted}>거래처·품목 자동 조회 중…</Text>
    </View>}
    {(["customers", "products"] as const).map((kind) => <View key={kind} style={{ marginBottom: 10 }}>
      <Text style={s.muted}>{kind === "customers" ? "거래처" : "품목"} · {catalogs[kind]?.count != null
        ? `${catalogs[kind]!.count}개 · ${readTime(catalogs[kind]!.updatedAt)}`
        : catalogBusy ? "불러오는 중" : "조회 대기"}</Text>
      {!!catalogs[kind]?.error && <Text accessibilityRole="alert" style={{ color: C.red }}>{catalogs[kind]!.error}</Text>}
    </View>)}
    {!!catalogError && <View style={{ gap: 8, marginBottom: 14 }}>
      <Text accessibilityRole="alert" style={{ color: C.red }}>{catalogError}</Text>
      <Button title="연결 다시 시도" secondary onPress={() => { void loadCatalogs(); void readSales(); }} disabled={catalogBusy} />
    </View>}
    <View style={{ marginTop: 10, marginBottom: 10, gap: 8 }}>
      <Text style={s.h3}>{followToday ? "오늘 판매조회" : "일자별 판매조회"}</Text>
      <Text style={s.muted}>한국 날짜 기준으로 전체 전표를 조회합니다. 새 판매내역은 1분마다 자동 갱신됩니다.</Text>
    </View>
    <Field label="판매 조회 일자" value={salesDate} onChangeText={value => { setFollowToday(false); setSalesDate(value); }}
      placeholder="YYYY-MM-DD" onSubmitEditing={() => void readSales()} returnKeyType="search" />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
      <Button title="오늘 판매내역" small secondary onPress={() => {
        const today = koreanDate(); setFollowToday(true); setSalesDate(today);
        if (today === salesDate) void readSales();
      }} disabled={disabled} />
      <Button title={salesBusy ? "판매내역 조회 중…" : "판매내역 새로고침"} small onPress={() => void readSales()}
        disabled={disabled || salesBusy || !validSalesDate(salesDate) || !ready} />
    </View>
    {status && !status.automaticDailySales && <Text accessibilityRole="alert" style={{ color: C.amber, marginBottom: 12 }}>오늘 판매내역 자동 조회에는 서버와 앱 1.14.0 이상이 필요합니다.</Text>}
    {salesBusy && <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}><ActivityIndicator color={C.green} /><Text style={s.muted}>{salesDate} 판매전표 전체를 확인하고 있어요.</Text></View>}
    {!!error && <View style={{ gap: 5, marginBottom: 12 }}>
      <Text accessibilityRole="alert" style={{ color: C.red }}>{error}</Text>
      {currentSnapshot && <Text style={s.muted}>아래는 마지막으로 읽은 목록입니다. 전표를 누르면 최신 내용을 다시 확인합니다.</Text>}
    </View>}
    {currentSnapshot && <View style={{ gap: 10 }}>
      <Text style={{ color: C.ink, fontWeight: "800" }}>{salesDate} 판매전표 · {snapshot!.documents.length}건 전체 조회</Text>
      <Text style={s.muted}>최종 조회 · {readTime(snapshot!.sourceReadAt)}</Text>
      {snapshot!.source?.provider === "company-erp" && <Text style={{ color: C.green }}>회사 ERP 원본 판매내역 연결 확인 · 연동 {snapshot!.source.bridgeVersion}</Text>}
      {!!snapshot!.documents.length && <Field label="판매전표 검색" value={filter} onChangeText={setFilter}
        placeholder="20261106-72 · 거래처 · 품목" autoCapitalize="none" autoCorrect={false} />}
      {!!filter.trim() && <Text style={s.muted}>검색 결과 {documents.length}건 / 전체 {snapshot!.documents.length}건</Text>}
      {!snapshot!.documents.length && <Text style={[s.muted, { paddingVertical: 12 }]}>해당 날짜에 등록된 회사 ERP 판매전표가 없습니다.</Text>}
      {!!snapshot!.documents.length && !documents.length && <Text style={[s.muted, { paddingVertical: 12 }]}>입력한 번호·거래처와 일치하는 전표가 없습니다. 날짜를 확인하거나 전표번호로 직접 조회해 주세요.</Text>}
      {documents.map(doc => <Pressable key={doc.sourceKey} accessibilityRole="button"
        accessibilityLabel={`${doc.reference} 판매전표 작성`} disabled={disabled}
        onPress={() => {
          if (onSalesDocument) onSalesDocument(snapshot!, doc.sourceKey);
          else if (!snapshot!.live) onSalesList(snapshot!.id);
          else onOpenInvoices();
        }}
        style={({ pressed }) => ({ padding: 14, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: pressed ? C.bg : C.white, gap: 7, opacity: disabled ? .5 : 1 })}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7, alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: C.green, fontWeight: "800" }}>{doc.reference}</Text>
          <Text style={s.muted}>{doc.registered ? "등록 완료" : invoiceStatus(doc.status)}</Text>
        </View>
        <Text style={{ color: C.ink, fontWeight: "700" }}>{doc.recipient || "거래처 확인 필요"}</Text>
        <Text numberOfLines={2} style={s.muted}>{doc.address || "배송주소 확인 필요"}</Text>
        <Text style={s.muted}>품목 {doc.items.length}개 · 합계 {invoiceMoney(doc.amount, "확인 필요")}{doc.amount == null ? "" : "원"}</Text>
        {doc.items.slice(0, 2).map((item, index) => <View key={index} style={{ padding: 10, borderRadius: 8, backgroundColor: C.bg, gap: 5 }}>
          <Text style={{ color: C.ink, fontWeight: "600" }}>{item.name || "품목명 확인 필요"} · 수량 {item.quantityUnknown ? "확인 필요" : invoiceMoney(item.quantity, "확인 필요")}</Text>
          <Text style={s.muted}>단가 {invoiceMoney(item.unitPrice, "확인 필요")}{item.unitPrice == null ? "" : "원"} · 금액 {invoiceMoney(item.supplyAmount, "확인 필요")}{item.supplyAmount == null ? "" : "원"} · DC율 {item.discountRateRaw?.trim() || (item.discountRate == null ? "확인 필요" : `${item.discountRate}%`)}</Text>
        </View>)}
        {doc.items.length > 2 && <Text style={s.muted}>외 {doc.items.length - 2}개 품목 · 누르면 전체 내용을 볼 수 있습니다.</Text>}
        <Text style={{ color: C.green, fontWeight: "700" }}>판매전표 작성 · 전체 내용 확인 →</Text>
      </Pressable>)}
    </View>}
    <View style={{ marginTop: 14 }}><Button title="전표번호로 명세서 찾기" secondary onPress={onOpenInvoices} disabled={disabled} /></View>
    <View style={{ marginTop: 14 }}><Button title={help ? "설치 안내 접기" : "회사 ERP 설치·연결 안내"} secondary onPress={() => setHelp(!help)} /></View>
    {help && <View style={{ gap: 8, marginTop: 12 }}>
      <Text selectable style={s.muted}>닷홈 ERP의 tire/erp 폴더에 최신 연동 파일을 함께 적용하세요. 기존 DB 설정과 연결키는 유지합니다.</Text>
      <Text selectable style={s.muted}>Render의 COMPANY_ERP_API_URL은 dispatch_api.php HTTPS 주소, COMPANY_ERP_TOKEN은 기존 연결키입니다. 서버와 앱을 함께 최신 버전으로 업데이트하세요.</Text>
      <Text style={s.muted}>목록에서 배송할 전표를 눌러 거래처·주소·연락처·품목·금액을 확인하고 전표로 등록하세요.</Text>
    </View>}
  </Card>;
}
