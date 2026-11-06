import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { readTime, type ErpStatus } from "./ecountTypes";
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
  const [counts, setCounts] = useState<ErpStatus | null>(null),
    [busy, setBusy] = useState(false),
    [salesDate, setSalesDate] = useState(date),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [manual, setManual] = useState(false),
    [help, setHelp] = useState(false);
  const guard = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api("/api/erp/status")
      .then((v) => {
        if (mounted.current) setCounts(v);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setSalesDate(date), [date]);
  const sync = async () => {
    if (guard.current || disabled) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{
        count: number;
        updatedAt: string;
        cached: boolean;
      }>("/api/erp/products/sync", { method: "POST" });
      if (!mounted.current) return;
      setMessage(
        result.cached
          ? `추가 API 호출 없이 마지막 조회 자료 ${result.count}개를 유지합니다. 조회 시각: ${readTime(result.updatedAt)}`
          : `E카운트에서 품목 ${result.count}개를 조회했습니다. 품목 검색에서 선택할 수 있어요.`,
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      try {
        const latest = await api<ErpStatus>("/api/erp/status");
        if (mounted.current) setCounts(latest);
      } catch {}
      guard.current = false;
      if (mounted.current) setBusy(false);
    }
  };
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
      <Text style={s.h3}>E카운트 직접 연결</Text>
      <Text style={[s.muted, { marginTop: 8, marginBottom: 12 }]}>
        품목은 E카운트 Open API로 조회합니다. 거래처·판매내역은 현재 계정에서
        확인한 API에 조회 기능이 없습니다.
      </Text>
      <Text
        style={{
          color: counts?.direct?.configured ? C.green : C.amber,
          marginBottom: 8,
        }}
      >
        {!counts
          ? "연결 설정 확인 중…"
          : !counts.direct
            ? "서버 업데이트 필요"
            : !counts.direct.configured
              ? "서버 인증 설정 필요"
              : counts.direct.products.state === "last-read-succeeded"
                ? "품목 목록 마지막 조회 성공"
                : counts.direct.products.state === "last-read-failed"
                  ? "품목 목록 마지막 조회 실패"
                  : "인증 설정됨 · 첫 조회로 연결 확인 필요"}
      </Text>
      {counts?.direct && (
        <Text style={[s.muted, { marginBottom: 12 }]}>
          {counts.direct.environment === "sandbox"
            ? "테스트 서버"
            : "운영 서버"}{" "}
          · 마지막 성공 조회: {readTime(counts.direct.products.lastReadAt)}
          {"\n"}목록 새로고침은 최소{" "}
          {counts.direct.products.listIntervalSeconds / 60}분 간격입니다. 코드별
          직접 조회는 품목 검색에서 이용하세요.
          {"\n"}다음 목록 조회 가능:{" "}
          {readTime(counts.direct.products.nextListAt)}
        </Text>
      )}
      <Button
        title={busy ? "처리 중…" : "E카운트 품목 목록 조회"}
        onPress={sync}
        disabled={busy || disabled || !counts?.direct?.configured}
      />
      {counts?.direct?.products.lastError && (
        <Text style={{ color: C.red, marginTop: 8 }}>
          {counts.direct.products.lastError}
        </Text>
      )}
      <View style={{ gap: 8, marginVertical: 16 }}>
        <Text style={s.h3}>거래처·판매내역 직접 조회</Text>
        <Text style={s.muted}>
          조회 API 확인 필요 · 등록/판매 입력 API로는 가져올 수 없습니다.
          E카운트에서 별도 조회 방법을 제공하는지 확인해야 합니다.
        </Text>
      </View>
      <Button
        title={help ? "연결 안내 접기" : "연결 설정 · 조회 API 문의 안내"}
        secondary
        onPress={() => setHelp(!help)}
      />
      {help && (
        <View style={{ gap: 8, marginTop: 12 }}>
          <Text selectable style={s.muted}>
            Render 서비스 → Environment에 ECOUNT_COM_CODE(회사코드),
            ECOUNT_USER_ID(API 사용자 ID), ECOUNT_API_CERT_KEY(API 인증키)를
            등록하고 재배포하세요. ECOUNT_ENV는 production(운영) 또는
            sandbox(테스트)입니다. 인증키는 앱이나 채팅에 입력하지 마세요.
          </Text>
          <Text selectable style={s.muted}>
            E카운트 문의: 외부 배송앱에서 거래처명·주소·연락처와 날짜별
            판매전표(전표번호·거래처·품목·수량·금액)를 조회할 공식 API나 승인된
            연동 방법이 있나요? 거래처 등록/판매 입력이 아닌 조회 기능이
            필요합니다.
          </Text>
        </View>
      )}
      {counts && (
        <Text style={[s.muted, { marginVertical: 12 }]}>
          저장된 검색 자료 · 거래처 {counts.customers}개 · 품목{" "}
          {counts.products}개
        </Text>
      )}
      <View style={{ marginTop: 20 }}>
        <Button
          title={
            manual ? "엑셀 파일 가져오기 접기" : "엑셀 파일 가져오기(수동)"
          }
          secondary
          onPress={() => setManual(!manual)}
          disabled={busy}
        />
      </View>
      {manual && (
        <View style={{ marginTop: 16 }}>
          <Text style={[s.muted, { marginBottom: 12 }]}>
            파일 선택을 누르면 휴대폰의 파일 선택 화면(Google Drive 등)이
            열립니다. 이 기능은 실시간 조회가 아닙니다.
          </Text>
          <Field
            label="가져올 판매일자 / 출고일"
            value={salesDate}
            onChangeText={setSalesDate}
            placeholder="2026-11-05"
          />
          <Text style={[s.muted, { marginBottom: 12 }]}>
            26/11/05-47은 2026년 11월 5일의 47번 전표입니다. 선택한 날짜만
            가져오며 배송 예정일은 {date}입니다.
          </Text>
          {counts && !counts.salesDateFilter && (
            <Text style={{ color: C.amber, marginBottom: 12 }}>
              서버를 최신 버전으로 배포한 뒤 날짜별 판매조회를 이용해 주세요.
            </Text>
          )}
          <Button
            title={busy ? "자료를 읽는 중…" : "판매조회 엑셀 파일 선택"}
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
              title="거래처 엑셀 파일 선택"
              secondary
              onPress={() => load("customers")}
              disabled={busy || disabled}
            />
            <Button
              title="품목 엑셀 파일 선택"
              secondary
              onPress={() => load("products")}
              disabled={busy || disabled}
            />
          </View>
          <Text style={[s.muted, { marginTop: 12 }]}>
            판매조회 파일에는 일자-No., 거래처명/코드, 품목명/코드, 수량,
            합계금액을 포함해 주세요. 주소·연락처는 저장 전 확인합니다.
          </Text>
        </View>
      )}
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
