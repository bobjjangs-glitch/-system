import AdminDeleteButton from "./AdminDeleteButton";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { api } from "./api";
import { Sheet, Button, Field, Card, C, s } from "./ui";
import { readTime } from "./erpTypes";
import { matchesSalesDocumentQuery, validSalesDate } from "./salesReference";
import { InvoiceContents } from "./SalesInvoiceStatement";
import {
  invoiceMoney,
  invoiceStatus,
  type SalesList,
  type SalesDocument,
} from "./salesDocuments";
type Overrides = Record<
  string,
  { address?: string; phone?: string; notes?: string }
>;
export default function CompanySalesBrowser({
  batchId,
  onClose,
  onSaved,
  onFindInvoice,
  onRecommend,
  preview,
  initialSourceKey,
}: {
  batchId: string | null;
  onClose: () => void;
  onSaved: (date: string) => void;
  onFindInvoice?: () => void;
  onRecommend?: (date: string) => void;
  preview?: SalesList | null;
  initialSourceKey?: string | null;
}) {
  const [list, setList] = useState<SalesList | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [query, setQuery] = useState(""),
    [serviceDate, setServiceDate] = useState(""),
    [detailKey, setDetailKey] = useState<string | null>(null),
    [detail, setDetail] = useState<SalesDocument | null>(null),
    [detailError, setDetailError] = useState(""),
    [overrides, setOverrides] = useState<Overrides>({}),
    [message, setMessage] = useState("");
  const active = useRef(true),
    guard = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setList(null);
    setError("");
    setSelected(new Set());
    setDetailKey(null);
    setOverrides({});
    setMessage("");
    setQuery("");
    if (preview) {
      setList(preview);
      setServiceDate(preview.serviceDate);
      setDetailKey(initialSourceKey ?? null);
    } else if (batchId)
      api<SalesList>("/api/company-erp/sales/lists/" + batchId)
        .then((v) => {
          if (current) {
            setList(v);
            setServiceDate(v.serviceDate);
          }
        })
        .catch((e) => {
          if (current) setError(e.message);
        });
    return () => {
      current = false;
    };
  }, [batchId, preview, initialSourceKey]);
  const filtered =
    list?.documents.filter((d) => matchesSalesDocumentQuery(d, query)) ?? [];
  useEffect(() => {
    const doc = list?.documents.find(d => d.sourceKey === detailKey), controller = new AbortController();
    setDetail(null); setDetailError("");
    if (doc && list?.historical) { setDetail(doc); return () => controller.abort(); }
    if (doc) api<{document: SalesDocument}>("/api/company-erp/invoices?reference="+encodeURIComponent(doc.reference)+"&sourceSystem="+encodeURIComponent(doc.sourceSystem??"legacy")+(doc.sourceSystem === "native-archive" ? "&documentId="+encodeURIComponent(doc.sourceId) : ""), {signal: controller.signal})
      .then(value => { if (!controller.signal.aborted) setDetail({...value.document, registered:doc.registered, eligible:value.document.eligible && !doc.registered}); })
      .catch(e => { if (!controller.signal.aborted) setDetailError(e.message); });
    return () => controller.abort();
  }, [detailKey, list?.id]);
  const picked = list?.documents.filter((d) => selected.has(d.sourceKey)) ?? [];
  const toggle = (key: string) =>
    setSelected((old) => {
      const n = new Set(old);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const submit = async (keys = [...selected]) => {
    if (!list || guard.current || !keys.length) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ count: number; alreadyRegistered: number }>(
        "/api/company-erp/sales/lists/" + list.id + "/dispatch",
        {
          method: "POST",
          body: JSON.stringify({
            sourceKeys: keys,
            serviceDate,
            deliveryOverrides: overrides,
          }),
        },
      );
      if (!active.current) return;
      setSelected(new Set());
      setDetailKey(null);
      setMessage(
        `${result.count}건을 배차 대기에 등록했습니다.${result.alreadyRegistered ? ` 이미 등록된 ${result.alreadyRegistered}건은 중복 등록하지 않았습니다.` : ""}`,
      );
      onSaved(serviceDate);
      setList(await api<SalesList>("/api/company-erp/sales/lists/" + list.id));
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      guard.current = false;
      if (active.current) setBusy(false);
    }
  };
  const confirmDetail = async () => {
    if (!list || !detail || guard.current) return;
    guard.current = true;setBusy(true);setDetailError("");
    try {
      const result = await api<{count:number;alreadyRegistered:number}>("/api/company-erp/sales/confirm-reference", {
        method:"POST",body:JSON.stringify({reference:detail.reference,sourceSystem:detail.sourceSystem??"legacy",...(detail.sourceSystem === "native-archive" ? {documentId:detail.sourceId} : {}),fingerprint:detail.fingerprint,serviceDate,delivery:overrides[detail.sourceKey]}) });
      if (!active.current) return;
      setMessage(`${result.count}건을 전표로 등록했습니다.${result.alreadyRegistered ? " 이미 등록한 전표는 중복 등록하지 않았습니다." : ""}`);
      if (list.live) {
        setDetail({...detail, registered:true, eligible:false});
        setList({...list, documents:list.documents.map(doc => doc.sourceKey === detail.sourceKey ? {...doc,registered:true,eligible:false} : doc)});
      } else {
        setDetailKey(null);
        setList(await api<SalesList>("/api/company-erp/sales/lists/"+list.id));
      }
      onSaved(serviceDate);
    } catch(e) { if(active.current)setDetailError((e as Error).message); }
    finally { guard.current=false;if(active.current)setBusy(false); }
  };
  const reload = async () => {
    if (!list || guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      const value = await api<SalesList>("/api/company-erp/sales/lists", {
        method: "POST",
        body: JSON.stringify({ salesDate: list.salesDate, serviceDate }),
      });
      if (active.current) {
        setList(value);
        setSelected(new Set());
        setOverrides({});
        setMessage("ERP의 최신 판매내역으로 목록을 갱신했습니다.");
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      guard.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <>
      <Sheet
        visible={!!batchId && !preview}
        title="판매조회 목록 · 전표 선택"
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        {!list && !error && <ActivityIndicator color={C.green} />}
        {!!error && (
          <Text
            accessibilityRole="alert"
            style={{ color: C.red, marginBottom: 14 }}
          >
            {error}
          </Text>
        )}
        {list && (
          <>
            <AdminDeleteButton kind="imports" id={list.id} name={`${list.salesDate} 판매조회 목록`} disabled={busy} onDeleted={() => { onClose(); onSaved(list.serviceDate); }} />
            <Text style={s.h3}>
              {list.salesDate} 판매내역 · {list.documents.length}건
            </Text>
            <Text style={[s.muted, { marginVertical: 10 }]}>
              ERP 조회 시각 · {readTime(list.sourceReadAt)}
              {list.historical ? " · 등록 당시 명세서" : ""}
            </Text>
            <Text style={[s.muted, { marginBottom: 14 }]}>
              전표번호를 누르면 거래명세서가 열립니다. 작성중·확정·취소 전표를
              표시하며, 배송할 전표만 선택해 배차 대기에 넣으세요. 작성중 전표를
              선택해도 ERP 판매 확정·재고 차감은 진행하지 않습니다.
            </Text>
            <Field
              label="판매전표 검색"
              value={query}
              onChangeText={setQuery}
              placeholder="전표번호 · 거래처 · 주소 · 품목"
            />
            {!list.historical && (
              <>
                <Field
                  label="선택 전표 배송 예정일"
                  value={serviceDate}
                  onChangeText={setServiceDate}
                  placeholder="YYYY-MM-DD"
                  editable={!busy}
                />
                <Button
                  title="조회 결과 전체 선택 · 해제"
                  secondary
                  small
                  disabled={busy || !filtered.some((d) => d.eligible)}
                  onPress={() => {
                    const keys = filtered
                      .filter((d) => d.eligible)
                      .map((d) => d.sourceKey);
                    setSelected((old) => {
                      const n = new Set(old),
                        all = keys.every((k) => n.has(k));
                      keys.forEach((k) => (all ? n.delete(k) : n.add(k)));
                      return n;
                    });
                  }}
                />
              </>
            )}
            {!filtered.length && (
              <Text style={[s.muted, { marginVertical: 20 }]}>
                {list.documents.length
                  ? "검색 조건과 일치하는 전표가 없습니다."
                  : `${list.salesDate}의 ERP 판매일자·전표번호 날짜로 조회한 결과가 0건입니다. 번호를 알고 있다면 명세서 메뉴에서 직접 조회해 주세요.`}
              </Text>
            )}
            {!list.documents.length && onFindInvoice && (
              <Button
                title="전표번호로 명세서 직접 찾기"
                secondary
                onPress={onFindInvoice}
              />
            )}
            {filtered.map((doc) => (
              <Card key={doc.sourceKey} style={{ marginTop: 12 }}>
                <View
                  style={{
                    flexDirection: "row",
                    gap: 12,
                    alignItems: "flex-start",
                  }}
                >
                  {!list.historical && (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={`${doc.reference} 배차 선택`}
                      accessibilityState={{
                        checked: selected.has(doc.sourceKey),
                        disabled: busy || !doc.eligible,
                      }}
                      disabled={busy || !doc.eligible}
                      onPress={() => toggle(doc.sourceKey)}
                      style={{
                        padding: 12,
                        backgroundColor: "#edf4ef",
                        borderRadius: 8,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 19,
                          color: doc.eligible ? C.green : C.muted,
                        }}
                      >
                        {selected.has(doc.sourceKey) ? "☑" : "☐"}
                      </Text>
                    </Pressable>
                  )}
                  <View style={{ flex: 1, gap: 6 }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${doc.reference} 명세서 보기`}
                      onPress={() => setDetailKey(doc.sourceKey)}
                    >
                      <Text
                        style={[
                          s.h3,
                          { color: C.green, textDecorationLine: "underline" },
                        ]}
                      >
                        {doc.reference}
                      </Text>
                    </Pressable>
                    <Text style={s.h3}>{doc.recipient || doc.buyer.name}</Text>
                    <Text
                      style={{
                        color:
                          doc.status === "canceled"
                            ? C.red
                            : doc.status === "draft"
                              ? C.amber
                              : C.green,
                      }}
                    >
                      {invoiceStatus(doc.status)}
                      {doc.registered ? " · 배차 등록됨" : ""}
                    </Text>
                    <Text selectable style={s.muted}>
                      {(overrides[doc.sourceKey]?.address ?? doc.address) ||
                        "배송주소 미등록"}
                    </Text>
                    <Text style={s.muted}>
                      {doc.items.length}개 품목 ·{" "}
                      {doc.items
                        .reduce((n, i) => n + i.quantity, 0)
                        .toLocaleString()}
                      개 · 합계 {invoiceMoney(doc.amount)}원
                    </Text>
                    <Text numberOfLines={2} style={s.muted}>
                      {doc.items.map((i) => i.name).join(" / ")}
                    </Text>
                    {!!doc.reason && (
                      <Text style={{ color: C.amber, fontSize: 12 }}>
                        {doc.reason}
                      </Text>
                    )}
                  </View>
                </View>
              </Card>
            ))}
            {!list.historical && (
              <View style={{ gap: 12, marginTop: 18 }}>
                <Text style={s.h3}>
                  선택 {picked.length}건 · 합계{" "}
                  {invoiceMoney(
                    picked.reduce((n, d) => n + (d.amount ?? 0), 0),
                  )}
                  원
                </Text>
                <Button
                  title={`선택 ${picked.length}건 배차 대기에 등록`}
                  disabled={
                    busy || !picked.length || !validSalesDate(serviceDate)
                  }
                  onPress={() => void submit()}
                />
                <Button
                  title="ERP에서 판매내역 다시 가져오기"
                  secondary
                  disabled={busy || !validSalesDate(serviceDate)}
                  onPress={reload}
                />
              </View>
            )}
            {!!message && onRecommend && <View style={{ marginTop: 14 }}><Button title="등록한 전표로 지역별 배차 추천" onPress={() => onRecommend(serviceDate)} disabled={busy} /></View>}
            {!!message && (
              <Text
                accessibilityLiveRegion="polite"
                style={{ color: C.green, marginTop: 14 }}
              >
                {message}
              </Text>
            )}
          </>
        )}
      </Sheet>
      <Sheet visible={!!detailKey} title="판매전표 입력 · ERP 내용 확인" onClose={() => { if(!busy){setDetailKey(null);if(preview)onClose();} }}>
        {!detail && !detailError && <><ActivityIndicator color={C.green}/><Text style={s.muted}>ERP 판매 수정 화면의 최신 내용을 불러오는 중…</Text></>}
        {!!detailError && <Text accessibilityRole="alert" style={{color:C.red,marginBottom:14}}>{detailError}</Text>}
        {detail && <InvoiceContents doc={{...detail,...overrides[detail.sourceKey]}} />}
        {detail && list && !list.historical && detail.eligible && (
          <View style={{ marginTop: 24, gap: 10 }}>
            <Text style={s.h3}>배차용 배송정보 확인</Text>
            <Text style={s.muted}>
              아래 수정은 앱 배송지에만 반영합니다. ERP 전표 원본은 유지합니다.
            </Text>
            {(["address", "phone", "notes"] as const).map((key, i) => (
              <Field
                key={key}
                label={["배차 배송주소", "배차 연락처", "배송 요청사항"][i]}
                value={overrides[detail.sourceKey]?.[key] ?? detail[key]}
                onChangeText={(value) =>
                  setOverrides((old) => ({
                    ...old,
                    [detail.sourceKey]: {
                      ...old[detail.sourceKey],
                      [key]: value,
                    },
                  }))
                }
                editable={!busy}
              />
            ))}
            <Text style={s.muted}>ERP 판매 수정 화면의 원본 내용을 자동으로 채웠습니다. 확인하면 이 전표의 품목·수량·단가·금액·합계·적요를 배송 전표로 함께 등록합니다.</Text>
            <Button title={busy ? "전표 등록 중…" : "확인하고 전표 등록"}
              disabled={busy || !validSalesDate(serviceDate)} onPress={() => void confirmDetail()} />
          </View>
        )}
        {list?.live && !!message && <View style={{gap:12,marginTop:16}}>
          <Text accessibilityLiveRegion="polite" style={{color:C.green}}>{message}</Text>
          {onRecommend && <Button title="등록한 전표로 지역별 배차 추천" onPress={() => onRecommend(serviceDate)} disabled={busy} />}
        </View>}
      </Sheet>
    </>
  );
}
