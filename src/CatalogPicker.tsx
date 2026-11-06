import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { api } from "./api";
import { Sheet, Field, Button, C, s } from "./ui";
import { readTime, type ErpStatus } from "./ecountTypes";
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
                ? "E카운트 엑셀 자료"
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
          {row.unitPrice != null && (
            <Text style={s.muted}>
              참고 단가 {row.unitPrice.toLocaleString()}원 · 전표 금액은 별도
              확인
            </Text>
          )}
        </>
      )}
    </Pressable>
  );
}
function ProductLookup({
  onSelect,
}: {
  onSelect: (row: CatalogEntry) => void;
}) {
  const [code, setCode] = useState(""),
    [rows, setRows] = useState<CatalogEntry[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const active = useRef(true),
    guard = useRef(false),
    request = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);
  const lookup = async () => {
    if (guard.current || !code.trim()) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setRows(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<{ items: CatalogEntry[] }>(
        "/api/erp/products/lookup?code=" + encodeURIComponent(code.trim()),
        { signal: controller.signal },
      );
      if (active.current) setRows(result.items);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      guard.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8, marginBottom: 24 }}>
      <Text style={s.h3}>E카운트 품목 직접 조회</Text>
      <Field
        label="정확한 품목코드"
        value={code}
        onChangeText={(value) => {
          setCode(value);
          setRows(null);
          setError("");
        }}
        placeholder="E카운트 품목코드"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        onSubmitEditing={lookup}
        returnKeyType="search"
      />
      <Button
        title={busy ? "E카운트 조회 중…" : "품목코드로 직접 조회"}
        onPress={lookup}
        disabled={busy || !code.trim()}
      />
      <Text style={s.muted}>
        서버 인증 설정이 필요합니다. 조회한 품목을 선택하면 입력됩니다.
      </Text>
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: C.red }}>
          {error}
        </Text>
      )}
      {rows?.length === 0 && (
        <Text style={s.muted}>해당 코드의 품목이 없습니다.</Text>
      )}
      {rows?.map((row) => (
        <CatalogRow
          key={row.id}
          row={row}
          kind="products"
          onSelect={onSelect}
        />
      ))}
    </View>
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
    [live, setLive] = useState<boolean | null>(null),
    [legacyLookup, setLegacyLookup] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    if (!kind) return;
    let active = true;
    api<ErpStatus>("/api/erp/status")
      .then((value) => {
        if (active) setLive(!!value.company?.configured);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [kind]);
  useEffect(() => {
    setQuery("");
    setLegacyLookup(false);
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
  }, [kind, query]);
  return (
    <Sheet
      visible={!!kind}
      title={kind === "customers" ? "거래처 검색" : "품목 검색"}
      onClose={onClose}
    >
      {kind === "products" && live === false && (
        <View style={{ gap: 12, marginBottom: 16 }}>
          <Button
            title={
              legacyLookup ? "E카운트 조회 접기" : "E카운트 품목조회(별도)"
            }
            secondary
            onPress={() => setLegacyLookup(!legacyLookup)}
          />
          {legacyLookup && <ProductLookup onSelect={onSelect} />}
        </View>
      )}
      <Text style={[s.h3, { marginBottom: 12 }]}>
        {live ? "회사 ERP에서 바로 검색" : "저장 자료 검색"}
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
        {live
          ? "검색할 때마다 회사 ERP의 현재 자료를 조회합니다. 조회 실패 시 이전 자료로 바꾸어 표시하지 않습니다."
          : kind === "customers"
            ? "저장된 엑셀 자료와 배송 내역에서 검색합니다. 회사 ERP 연결 후에는 바로 조회할 수 있습니다."
            : "마지막 API 조회 목록·엑셀 자료·저장한 배송 내역에서 검색합니다. 실시간 조회는 위의 품목코드 조회를 이용하세요."}{" "}
        최대 30개를 표시해요.
      </Text>
      {loading && <ActivityIndicator color={C.green} />}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: C.red }}>
          {error}
        </Text>
      )}
      {!loading && !error && !rows.length && (
        <Text style={s.muted}>
          {live
            ? "회사 ERP에서 일치하는 자료가 없습니다. 검색어를 바꾸거나 ERP에 등록되어 있는지 확인해 주세요."
            : "저장된 검색 결과가 없습니다. 직접 입력하거나 전표 화면에서 자료를 가져와 주세요."}
        </Text>
      )}
      {kind &&
        rows.map((row) => (
          <CatalogRow key={row.id} row={row} kind={kind} onSelect={onSelect} />
        ))}
    </Sheet>
  );
}
