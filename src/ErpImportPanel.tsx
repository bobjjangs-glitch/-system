import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { api } from "./api";
import { createImportForm } from "./importUpload";
import { Button, Card, C, s, Field } from "./ui";
import { validSalesDate } from "./salesReference";
import type { ShipmentInput } from "../server/types";
type SalesBatch = {
  id: string;
  fileName: string;
  drafts: ShipmentInput[];
  serviceDate: string;
  recognitionWarnings?: string[];
};
export default function ErpImportPanel({
  date,
  disabled,
  onReview,
}: {
  date: string;
  disabled: boolean;
  onReview: (batch: SalesBatch) => void;
}) {
  const [counts, setCounts] = useState<{
      customers: number;
      products: number;
      salesDateFilter?: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [salesDate, setSalesDate] = useState(date),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const guard = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api("/api/erp/status")
      .then((v) => {
        if (mounted.current) setCounts(v);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setSalesDate(date), [date]);
  const load = async (kind: "sales" | "customers" | "products") => {
    if (guard.current || disabled) return;
    guard.current = true;
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "text/csv",
          "application/csv",
        ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const form = await createImportForm(result.assets[0], "excel", date);
      if (kind === "sales") {
        if (!validSalesDate(salesDate))
          throw new Error("판매조회 일자를 YYYY-MM-DD 형식으로 입력해 주세요.");
        form.append("salesDate", salesDate);
      }
      const response = await api<any>(
        kind === "sales"
          ? "/api/erp/sales/import"
          : "/api/erp/catalog/" + kind + "/import",
        { method: "POST", body: form, signal: AbortSignal.timeout(120000) },
      );
      if (!mounted.current) return;
      if (kind === "sales") onReview(response);
      else {
        setMessage(
          `${response.count}개 ${kind === "customers" ? "거래처를" : "품목을"} 가져왔습니다. 검색에서 선택할 수 있어요.`,
        );
        setCounts(await api("/api/erp/status"));
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Card>
      <Text style={s.h3}>E카운트 자료 가져오기</Text>
      <Text style={[s.muted, { marginTop: 8, marginBottom: 16 }]}>
        E카운트에서 조회 결과를 .xlsx 또는 .csv로 저장한 뒤 선택해 주세요.
        선택한 일자의 판매전표별 품목·거래처·금액을 채우고, 거래처 목록에서
        주소·연락처를 연결합니다.
      </Text>
      <Field
        label="가져올 판매일자 / 출고일"
        value={salesDate}
        onChangeText={setSalesDate}
        placeholder="2026-11-05"
      />
      <Text style={[s.muted, { marginBottom: 12 }]}>
        26/11/05-47은 2026년 11월 5일의 47번 전표입니다. 선택한 날짜만 가져오며
        배송 예정일은 {date}입니다.
      </Text>
      {counts && !counts.salesDateFilter && (
        <Text style={{ color: C.amber, marginBottom: 12 }}>
          서버를 최신 버전으로 배포한 뒤 날짜별 판매조회를 이용해 주세요.
        </Text>
      )}
      <Button
        title={busy ? "자료를 읽는 중…" : "판매조회 내역 가져오기"}
        onPress={() => load("sales")}
        disabled={
          busy ||
          disabled ||
          !validSalesDate(salesDate) ||
          !counts?.salesDateFilter
        }
      />
      <View style={{ gap: 10, marginTop: 12 }}>
        <Button
          title="거래처 목록 가져오기"
          secondary
          onPress={() => load("customers")}
          disabled={busy || disabled}
        />
        <Button
          title="품목 목록 가져오기"
          secondary
          onPress={() => load("products")}
          disabled={busy || disabled}
        />
      </View>
      {counts && (
        <Text style={[s.muted, { marginTop: 12 }]}>
          검색 자료 · 거래처 {counts.customers}개 · 품목 {counts.products}개
        </Text>
      )}
      <Text style={[s.muted, { marginTop: 12 }]}>
        처음에는 거래처·품목 목록을 먼저 가져오세요. 판매조회에 일자-No.,
        거래처명/코드, 품목명/코드, 수량, 합계금액을 포함해 주세요. 누락된
        주소·연락처는 저장 전 확인할 수 있습니다.
      </Text>
      <Text style={[s.muted, { marginTop: 8 }]}>
        현재 연결 방식: 엑셀 가져오기. E카운트 계정에 직접 로그인하거나 실시간
        조회하지 않습니다.
      </Text>
      {!!message && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ marginTop: 12, color: C.green }}
        >
          {message}
        </Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={{ marginTop: 12, color: C.red }}>
          {error}
        </Text>
      )}
    </Card>
  );
}
