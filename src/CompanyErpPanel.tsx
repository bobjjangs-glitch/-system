import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, Field, C, s } from "./ui";
import { readTime, type ErpStatus } from "./erpTypes";
import { validSalesDate } from "./salesReference";
import type { SalesList } from "./salesDocuments";
type CatalogState = { count: number | null; updatedAt: string | null; error?: string };
type Catalogs = Partial<Record<"customers" | "products", CatalogState>>;
export default function CompanyErpPanel({ date, disabled, onSalesList, onOpenInvoices }: {
  date: string; disabled: boolean; onSalesList: (id: string) => void; onOpenInvoices: () => void;
}) {
  const [status, setStatus] = useState<ErpStatus | null>(null),
    [salesDate, setSalesDate] = useState(date),
    [catalogs, setCatalogs] = useState<Catalogs>({}),
    [catalogBusy, setCatalogBusy] = useState(false),
    [salesBusy, setSalesBusy] = useState(false),
    [error, setError] = useState(""),
    [catalogError, setCatalogError] = useState(""),
    [help, setHelp] = useState(false);
  const active = useRef(true), catalogGuard = useRef(false), salesGuard = useRef(false),
    generation = useRef(0), query = useRef<AbortController | null>(null),
    currentDate = useRef(salesDate);
  currentDate.current = salesDate;
  useEffect(() => setSalesDate(date), [date]);
  useEffect(() => {
    generation.current++;
    query.current?.abort();
    salesGuard.current = false;
    setSalesBusy(false);
    setError("");
  }, [salesDate]);
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
      if (!value.automaticCompanyCatalogs) {
        setCatalogError("자동 조회를 사용하려면 Render 서버를 1.12.0 이상으로 배포해 주세요.");
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
  useEffect(() => {
    active.current = true;
    void loadCatalogs();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void loadCatalogs();
    }, 60000);
    const focus = AppState.addEventListener("change", (state) => {
      if (state === "active") void loadCatalogs();
    });
    return () => {
      active.current = false;
      generation.current++;
      query.current?.abort();
      clearInterval(timer);
      focus.remove();
    };
  }, []);
  const readSales = async () => {
    if (salesGuard.current || disabled || !validSalesDate(salesDate)) return;
    salesGuard.current = true;
    const seq = ++generation.current, selectedDate = salesDate;
    const controller = new AbortController();
    query.current?.abort(); query.current = controller;
    setSalesBusy(true); setError("");
    try {
      const result = await api<SalesList>("/api/company-erp/sales/lists", {
        method: "POST", body: JSON.stringify({ salesDate: selectedDate, serviceDate: date }),
        signal: controller.signal,
      });
      if (active.current && seq === generation.current && currentDate.current === selectedDate)
        onSalesList(result.id);
    } catch (e) {
      if (active.current && seq === generation.current && !controller.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (seq === generation.current) {
        salesGuard.current = false;
        if (active.current) setSalesBusy(false);
      }
    }
  };
  return <Card>
    <Text style={s.h3}>회사 ERP 자동 조회</Text>
    <Text style={[s.muted, { marginVertical: 10 }]}>
      거래처와 품목은 이 화면을 열면 자동으로 불러오고, 검색할 때도 ERP의 최신 자료를 조회합니다.
    </Text>
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
      <Button title="연결 다시 시도" secondary onPress={() => void loadCatalogs()} disabled={catalogBusy} />
    </View>}
    <Field label="판매 조회 일자" value={salesDate} onChangeText={setSalesDate}
      placeholder="YYYY-MM-DD" onSubmitEditing={() => void readSales()} returnKeyType="search" />
    <Text style={[s.muted, { marginBottom: 12 }]}>
      일자를 입력하고 조회하면 해당 날짜의 판매내역 전체를 ERP에서 새로 가져옵니다.
      전표번호를 눌러 명세서를 보고, 배송할 전표를 선택하세요.
    </Text>
    {status && (!status.salesInvoiceBrowser || !status.invoiceReferenceLookup) &&
      <Text style={{ color: C.amber, marginBottom: 12 }}>전표 조회를 사용하려면 Render 서버를 최신 버전으로 배포해 주세요.</Text>}
    <Button title={salesBusy ? "해당 일자 전체 조회 중…" : "일자 조회"} onPress={() => void readSales()}
      disabled={disabled || salesBusy || !validSalesDate(salesDate) || !status?.company?.configured || !status?.invoiceReferenceLookup || !status?.automaticCompanyCatalogs} />
    {!!error && <Text accessibilityRole="alert" style={{ color: C.red, marginTop: 12 }}>{error}</Text>}
    <View style={{ marginTop: 10 }}><Button title="전표번호로 명세서 찾기" secondary onPress={onOpenInvoices} disabled={disabled || salesBusy} /></View>
    <View style={{ marginTop: 14 }}><Button title={help ? "설치 안내 접기" : "회사 ERP 설치·연결 안내"} secondary onPress={() => setHelp(!help)} /></View>
    {help && <View style={{ gap: 8, marginTop: 12 }}>
      <Text selectable style={s.muted}>닷홈 ERP의 tire/erp 폴더에 최신 연동 파일을 함께 적용하세요. 기존 DB 설정과 연결키는 유지합니다.</Text>
      <Text selectable style={s.muted}>Render의 COMPANY_ERP_API_URL은 dispatch_api.php HTTPS 주소, COMPANY_ERP_TOKEN은 기존 연결키입니다. 서버와 앱을 함께 최신 버전으로 업데이트하세요.</Text>
      <Text style={s.muted}>조회만으로 배송지·판매·재고를 변경하지 않습니다. 목록에서 배송할 전표를 선택해 배차에 넣습니다.</Text>
    </View>}
  </Card>;
}
