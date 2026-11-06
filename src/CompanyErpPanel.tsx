import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, Field, C, s } from "./ui";
import { readTime, type ErpStatus } from "./ecountTypes";
import { validSalesDate } from "./salesReference";
import type { SalesList } from "./salesDocuments";
export default function CompanyErpPanel({
  date,
  disabled,
  onSalesList,
  onOpenInvoices,
}: {
  date: string;
  disabled: boolean;
  onReview?: unknown;
  onSalesList: (id: string) => void;
  onOpenInvoices: () => void;
}) {
  const [status, setStatus] = useState<ErpStatus | null>(null),
    [salesDate, setSalesDate] = useState(date),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [help, setHelp] = useState(false),
    [lastList, setLastList] = useState<{ id: string; count: number } | null>(
      null,
    );
  const active = useRef(true),
    guard = useRef(false);
  const refresh = async () => {
    const value = await api<ErpStatus>("/api/erp/status");
    if (active.current) setStatus(value);
  };
  useEffect(() => {
    active.current = true;
    refresh().catch((e) => {
      if (active.current) setError(e.message);
    });
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => setSalesDate(date), [date]);
  useEffect(() => {
    let current = true;
    setLastList(null);
    if (validSalesDate(salesDate))
      api<SalesList | null>(
        "/api/company-erp/sales/lists/latest?salesDate=" + salesDate,
      )
        .then((v) => {
          if (current && v)
            setLastList({ id: v.id, count: v.documents.length });
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [salesDate]);
  const run = async (kind: "customers" | "products" | "sales" | "status") => {
    if (guard.current || disabled) return;
    guard.current = true;
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      if (kind === "status") {
        await refresh();
        return;
      }
      if (kind === "sales") {
        if (!validSalesDate(salesDate))
          throw new Error(
            "판매 조회 일자를 YYYY-MM-DD 형식으로 입력해 주세요.",
          );
        const result = await api<SalesList>("/api/company-erp/sales/lists", {
          method: "POST",
          body: JSON.stringify({ salesDate, serviceDate: date }),
        });
        if (!active.current) return;
        setLastList({ id: result.id, count: result.documents.length });
        setMessage(
          `ERP 판매전표 ${result.documents.length}건 조회 · ${readTime(result.sourceReadAt)}`,
        );
        onSalesList(result.id);
      } else {
        const result = await api<{ count: number; updatedAt: string }>(
          "/api/company-erp/catalog/" + kind + "/sync",
          { method: "POST" },
        );
        if (active.current)
          setMessage(
            `회사 ERP에서 ${kind === "customers" ? "거래처" : "품목"} ${result.count}개를 새로 조회했습니다. 조회 시각: ${readTime(result.updatedAt)}`,
          );
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      try {
        await refresh();
      } catch {}
      guard.current = false;
      if (active.current) setBusy("");
    }
  };
  const company = status?.company,
    locked = disabled || !!busy || !company?.configured;
  return (
    <Card>
      <Text style={s.h3}>회사 ERP 실시간 가져오기</Text>
      <Text style={[s.muted, { marginVertical: 10 }]}>
        닷홈 ERP의 거래처·품목과 날짜별 판매전표를 바로 조회합니다. 파일 선택
        없이 버튼을 눌러 가져오세요.
      </Text>
      <Text
        style={{
          marginBottom: 12,
          color: company?.state === "last-read-succeeded" ? C.green : C.amber,
        }}
      >
        {!status
          ? error
            ? "연결 설정 확인 실패"
            : "연결 설정 확인 중…"
          : !company
            ? "서버 업데이트 필요"
            : !company.configured
              ? "ERP 연동 파일 설치 · 연결키 등록 필요"
              : company.state === "last-read-succeeded"
                ? "회사 ERP 마지막 조회 성공"
                : company.state === "last-read-failed"
                  ? "회사 ERP 마지막 조회 실패"
                  : "연결키 등록됨 · 첫 조회로 연결 확인 필요"}
      </Text>
      <View style={{ gap: 10, marginBottom: 18 }}>
        <Button
          title={
            busy === "customers" ? "거래처 조회 중…" : "거래처 목록 가져오기"
          }
          onPress={() => run("customers")}
          disabled={locked}
        />
        <Button
          title={busy === "products" ? "품목 조회 중…" : "품목 목록 가져오기"}
          onPress={() => run("products")}
          secondary
          disabled={locked}
        />
      </View>
      {status &&
        (!status.salesInvoiceBrowser || !status.invoiceReferenceLookup) && (
          <Text style={{ color: C.amber, marginBottom: 12 }}>
            전표번호·날짜 조회를 사용하려면 Render 서버를 1.11.0 이상으로 배포해
            주세요. 이전 서버에서는 조회를 진행하지 않습니다.
          </Text>
        )}
      <Field
        label="판매 조회 일자"
        value={salesDate}
        onChangeText={setSalesDate}
        placeholder="YYYY-MM-DD"
        editable={!busy}
      />
      <Text style={[s.muted, { marginBottom: 12 }]}>
        선택한 날짜의 작성중·확정·취소 판매전표를 목록으로 확인합니다.
        전표번호를 눌러 명세서를 보고, 배송할 전표만 선택하세요. 배송 예정일은{" "}
        {date}입니다.
      </Text>
      <Button
        title={
          busy === "sales" ? "최신 판매전표 조회 중…" : "판매조회 내역 가져오기"
        }
        onPress={() => run("sales")}
        disabled={
          locked ||
          !validSalesDate(salesDate) ||
          !status?.salesInvoiceBrowser ||
          !status.invoiceReferenceLookup
        }
      />
      {lastList && (
        <View style={{ marginTop: 10 }}>
          <Button
            title={`마지막 판매조회 목록 보기 · ${lastList.count}건`}
            secondary
            onPress={() => onSalesList(lastList.id)}
            disabled={disabled || !!busy || !status?.invoiceReferenceLookup}
          />
        </View>
      )}
      <View style={{ marginTop: 10 }}>
        <Button
          title="전표번호로 명세서 찾기"
          secondary
          onPress={onOpenInvoices}
          disabled={!!busy || disabled}
        />
      </View>
      <Text style={[s.muted, { marginTop: 12 }]}>
        거래처 · {readTime(company?.reads.customers?.at)}
        {"\n"}품목 · {readTime(company?.reads.products?.at)}
        {"\n"}판매전표 ·{" "}
        {company?.failures?.sales
          ? "마지막 조회 실패"
          : company?.reads.sales
            ? `${company.reads.sales.count}건 · ${readTime(company.reads.sales.at)}`
            : "아직 조회하지 않았습니다"}
      </Text>
      {!!message && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: C.green, marginTop: 12 }}
        >
          {message}
        </Text>
      )}
      {!!company?.failures?.sales && !error && (
        <Text accessibilityRole="alert" style={{ color: C.red, marginTop: 12 }}>
          {company.failures.sales.message}
        </Text>
      )}
      {!!company?.lastError && !company?.failures?.sales && !error && (
        <Text style={{ color: C.red, marginTop: 12 }}>{company.lastError}</Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: C.red, marginTop: 12 }}>
          {error}
        </Text>
      )}
      <View style={{ gap: 10, marginTop: 18 }}>
        <Button
          title={
            busy === "status" ? "연결 상태 확인 중…" : "연결 상태 새로고침"
          }
          secondary
          onPress={() => run("status")}
          disabled={disabled || !!busy}
        />
        <Button
          title={help ? "설치 안내 접기" : "회사 ERP 설치·연결 안내"}
          secondary
          onPress={() => setHelp(!help)}
        />
      </View>
      {help && (
        <View style={{ gap: 8, marginTop: 12 }}>
          <Text selectable style={s.muted}>
            1. 제공된 닷홈 연동 ZIP의 tire/erp 안 파일을 FTP의 같은 폴더에
            추가합니다. 기존 DB 설정 파일은 덮어쓰지 않습니다.
          </Text>
          <Text selectable style={s.muted}>
            2. 기존 연결키는 그대로 사용합니다. 처음 설치할 때 ERP 관리자
            계정으로 dispatch_setup.php에서 발급합니다. Render → Environment의
            COMPANY_ERP_TOKEN에만 저장하세요.
          </Text>
          <Text selectable style={s.muted}>
            3. COMPANY_ERP_API_URL을 회사 ERP의 dispatch_api.php HTTPS 주소로
            설정하고, 최신 커밋을 배포합니다. 연결 상태를 새로고침한 뒤 목록
            조회로 확인하세요.
          </Text>
          <Text style={s.muted}>
            확인 전에는 전표가 배송지로 저장되지 않습니다. 가져올 때마다 새로
            조회하며, 앱을 닫은 동안 자동으로 전표를 등록하지는 않습니다.
          </Text>
        </View>
      )}
    </Card>
  );
}
