import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { api } from "./api";
import { Sheet, Field, Button, C, s } from "./ui";
import { readTime } from "./erpTypes";
import type { CatalogEntry } from "./catalogTypes";
function CatalogRow({
  row,
  kind,
  onSelect,
}: {
  row: CatalogEntry;
  kind: "customers" | "products";
  onSelect: (row: CatalogEntry) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => onSelect(row)}
      style={{
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: C.line,
      }}
    >
      <Text style={s.h3}>{row.name}</Text>
      <Text style={[s.muted, { marginTop: 5 }]}>
        {row.code ? row.code + " · " : ""}
        {row.source === "company-erp-live"
          ? `회사 ERP 실시간 조회 · ${readTime(row.updatedAt)}`
          : row.source === "company-erp"
            ? `회사 ERP 저장 자료 · ${readTime(row.updatedAt)}`
            : row.source === "ecount-api"
              ? `API 조회 자료 · ${readTime(row.updatedAt)}`
              : row.source === "ecount"
                ? "이전에 가져온 엑셀 자료"
                : "저장한 배송 내역"}
      </Text>
      {kind === "customers" ? (
        <>
          <Text style={[s.muted, { marginTop: 8 }]}>
            {row.address || "주소 미등록 · 선택 후 입력해 주세요"}
          </Text>
          <Text style={s.muted}>{row.phone || "연락처 미등록"}</Text>
        </>
      ) : (
        <>
          <Text style={s.muted}>{row.specification}</Text>
          {row.retailPrice != null && (
            <Text style={s.muted}>
              소매 단가 {row.retailPrice.toLocaleString()}원
            </Text>
          )}
          {row.wholesalePrice != null && (
            <Text style={s.muted}>
              도매 단가 {row.wholesalePrice.toLocaleString()}원
            </Text>
          )}
          {row.factoryPrice != null && (
            <Text style={s.muted}>
              공장도가 {row.factoryPrice.toLocaleString()}원
            </Text>
          )}
          {row.retailPrice == null &&
            row.wholesalePrice == null &&
            row.unitPrice != null && (
              <Text style={s.muted}>
                단가 {row.unitPrice.toLocaleString()}원
              </Text>
            )}
          {row.priceBasis === "catalog-reference" && <>
            {row.referenceRetailPrice != null && <Text style={s.muted}>ERP 참고 소매가 {row.referenceRetailPrice.toLocaleString()}원</Text>}
            {row.referenceWholesalePrice != null && <Text style={s.muted}>ERP 참고 도매가 {row.referenceWholesalePrice.toLocaleString()}원</Text>}
            {row.referenceGrossPrice != null && <Text style={s.muted}>ERP 참고 VAT 포함 단가 {row.referenceGrossPrice.toLocaleString()}원</Text>}
          </>}
          <Text style={s.muted}>{row.priceBasis === "catalog-reference"
            ? "ERP와 같이 품목 정보를 채우고 입력된 전표 가격은 유지합니다. 참고가격의 과세 기준은 원본을 확인해 주세요."
            : "선택하면 수량에 맞춰 단가·금액·합계를 자동 입력합니다."}</Text>
        </>
      )}
    </Pressable>
  );
}
export default function CatalogPicker({
  kind,
  onClose,
  onSelect,
}: {
  kind: "customers" | "products" | null;
  onClose: () => void;
  onSelect: (value: CatalogEntry) => void;
}) {
  const [query, setQuery] = useState(""),
    [rows, setRows] = useState<CatalogEntry[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    setQuery("");
    setRows([]);
    setError("");
  }, [kind]);
  useEffect(() => {
    const seq = ++generation.current,
      controller = new AbortController();
    if (!kind) return;
    setLoading(true);
    setError("");
    setRows([]);
    const timer = setTimeout(() => {
      api<CatalogEntry[]>(
        "/api/catalog/" + kind + "?q=" + encodeURIComponent(query),
        { signal: controller.signal },
      )
        .then((result) => {
          if (seq === generation.current) setRows(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted && seq === generation.current)
            setError(e.message);
        })
        .finally(() => {
          if (seq === generation.current) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [kind, query, revision]);
  return (
    <Sheet
      visible={!!kind}
      title={kind === "customers" ? "거래처 검색" : "품목 검색"}
      onClose={onClose}
    >
      <Text style={[s.h3, { marginBottom: 12 }]}>
        회사 ERP에서 바로 검색
      </Text>
      <Field
        label={
          kind === "customers"
            ? "거래처명 · 코드 · 주소"
            : "품목명 · 코드 · 규격"
        }
        value={query}
        onChangeText={setQuery}
        placeholder="검색어를 입력해 주세요"
      />
      <Text style={[s.muted, { marginBottom: 16 }]}>
        검색창을 열면 자동으로 목록을 불러옵니다. 검색할 때마다 회사 ERP의 최신 자료를 조회합니다.{' '}
        최대 30개를 표시해요.
      </Text>
      {loading && <ActivityIndicator color={C.green} />}
      {!!error && (
<View style={{ gap: 8 }}><Text accessibilityRole="alert" style={{ color: C.red }}>{error}</Text><Button title="다시 연결" secondary onPress={() => setRevision((v) => v + 1)} /></View>
      )}
      {!loading && !error && !rows.length && (
        <Text style={s.muted}>
          회사 ERP에서 일치하는 자료가 없습니다. 검색어를 바꾸거나 ERP 등록 상태를 확인해 주세요.
        </Text>
      )}
      {kind &&
        rows.map((row) => (
          <CatalogRow key={row.id} row={row} kind={kind} onSelect={onSelect} />
        ))}
    </Sheet>
  );
}
