import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { api } from "./api";
import { Button, Card, Field, C, s } from "./ui";
import { InvoiceContents } from "./SalesInvoiceStatement";
import { readTime, type ErpStatus } from "./ecountTypes";
import { validSalesDate } from "./salesReference";
import type { SalesDocument, SalesList } from "./salesDocuments";
export default function InvoiceLookupPanel({
  date,
  onSalesList,
}: {
  date: string;
  onSalesList: (id: string) => void;
}) {
  const [reference, setReference] = useState(""),
    [queryDate, setQueryDate] = useState(date),
    [status, setStatus] = useState<ErpStatus | null>(null),
    [doc, setDoc] = useState<SalesDocument | null>(null),
    [readAt, setReadAt] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [last, setLast] = useState<SalesList | null>(null);
  const active = useRef(true),
    guard = useRef(false);
  useEffect(() => {
    active.current = true;
    api<ErpStatus>("/api/erp/status")
      .then((v) => {
        if (active.current) setStatus(v);
      })
      .catch((e) => {
        if (active.current) setError(e.message);
      });
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => setQueryDate(date), [date]);
  useEffect(() => {
    let current = true;
    setLast(null);
    if (validSalesDate(queryDate) && status?.invoiceReferenceLookup)
      api<SalesList | null>(
        "/api/company-erp/sales/lists/latest?salesDate=" + queryDate,
      )
        .then((v) => {
          if (current) setLast(v);
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [queryDate, status?.invoiceReferenceLookup]);
  const run = async (kind: "reference" | "date" | "connection" | "select") => {
    if (guard.current) return;
    guard.current = true;
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      if (kind === "reference") {
        setDoc(null);
        const result = await api<{
          document: SalesDocument;
          sourceReadAt: string;
        }>(
          "/api/company-erp/invoices?reference=" +
            encodeURIComponent(reference.trim()),
        );
        if (!active.current) return;
        setDoc(result.document);
        setReadAt(result.sourceReadAt);
        setMessage(
          `${result.document.reference} 명세서를 ERP에서 가져왔습니다.`,
        );
      } else if (kind === "connection") {
        const result = await api<{
          version: string;
          bridgeVersion: string;
          matchedSales: number;
          totalSales: number;
        }>("/api/company-erp/connection?date=" + queryDate);
        if (active.current)
          setMessage(
            `ERP 연결 확인 완료 · 서버 ${result.version} / ERP 연동 ${result.bridgeVersion} · ${queryDate} 조회 ${result.matchedSales}건 / ERP 판매 전체 ${result.totalSales}건`,
          );
      } else {
        const result = await api<SalesList>(
          kind === "select"
            ? "/api/company-erp/sales/reference-list"
            : "/api/company-erp/sales/lists",
          {
            method: "POST",
            body: JSON.stringify(
              kind === "select"
                ? { reference: doc!.reference, serviceDate: date }
                : { salesDate: queryDate, serviceDate: date },
            ),
          },
        );
        if (active.current) {
          setLast(result);
          onSalesList(result.id);
        }
      }
      const latest = await api<ErpStatus>("/api/erp/status");
      if (active.current) setStatus(latest);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      guard.current = false;
      if (active.current) setBusy("");
    }
  };
  const ready =
    !!status?.company?.configured && !!status.invoiceReferenceLookup;
  return (
    <View style={{ gap: 14 }}>
      <Card>
        <Text style={s.h2}>명세서 조회</Text>
        <Text style={[s.muted, { marginVertical: 12 }]}>
          ERP 판매조회에서 누르는 전표번호를 입력하세요. 판매일자 필터와 별도로
          해당 전표를 직접 찾아 공급자·거래처·배송지·품목·금액 전체를
          보여줍니다.
        </Text>
        {status && !status.invoiceReferenceLookup && (
          <Text style={{ color: C.amber, marginBottom: 12 }}>
            전표번호 직접 조회를 사용하려면 Node 서버와 ERP PHP 연동 파일을 최신
            버전으로 갱신해 주세요.
          </Text>
        )}
        <Field
          label="조회할 ERP 전표번호"
          value={reference}
          onChangeText={setReference}
          placeholder="20261106-49"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          returnKeyType="search"
          onSubmitEditing={() => {
            if (ready && reference.trim()) run("reference");
          }}
        />
        <Button
          title={
            busy === "reference"
              ? "명세서 가져오는 중…"
              : "전표번호로 명세서 조회"
          }
          disabled={!!busy || !ready || !reference.trim()}
          onPress={() => run("reference")}
        />
        <View style={{ marginTop: 18, gap: 10 }}>
          <Field
            label="명세서 조회일자"
            value={queryDate}
            onChangeText={setQueryDate}
            placeholder="YYYY-MM-DD"
            editable={!busy}
          />
          <Button
            title="조회일자의 판매목록 보기"
            secondary
            disabled={!!busy || !ready || !validSalesDate(queryDate)}
            onPress={() => run("date")}
          />
          {last && (
            <Button
              title={`최근 조회한 판매목록 · ${last.documents.length}건`}
              secondary
              disabled={!!busy}
              onPress={() => onSalesList(last.id)}
            />
          )}
          <Button
            title="ERP 연결 확인"
            secondary
            disabled={
              !!busy ||
              !status?.company?.configured ||
              !validSalesDate(queryDate)
            }
            onPress={() => run("connection")}
          />
        </View>
        {!!error && (
          <Text
            accessibilityRole="alert"
            style={{ color: C.red, marginTop: 14 }}
          >
            {error}
          </Text>
        )}
        {!!message && (
          <Text
            accessibilityLiveRegion="polite"
            style={{ color: C.green, marginTop: 14 }}
          >
            {message}
          </Text>
        )}
        {!!status?.company?.failures?.sales && !error && (
          <Text style={{ color: C.red, marginTop: 14 }}>
            마지막 판매조회 실패 · {status.company.failures.sales.message}
          </Text>
        )}
      </Card>
      {doc && (
        <Card>
          <Text style={[s.muted, { marginBottom: 12 }]}>
            ERP 조회 · {readTime(readAt)}
          </Text>
          <InvoiceContents doc={doc} />
          <View style={{ marginTop: 18 }}>
            <Button
              title="이 명세서를 배차 목록에 넣기"
              disabled={!!busy || !doc.eligible}
              onPress={() => run("select")}
            />
          </View>
        </Card>
      )}
    </View>
  );
}
