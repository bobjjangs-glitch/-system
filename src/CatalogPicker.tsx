import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { api } from "./api";
import { Sheet, Field, C, s } from "./ui";
import type { CatalogEntry } from "./catalogTypes";
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
    [loading, setLoading] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    setQuery("");
    setRows([]);
    setError("");
  }, [kind]);
  useEffect(() => {
    const request = ++generation.current;
    const controller = new AbortController();
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
          if (request === generation.current) setRows(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted && request === generation.current)
            setError(e.message);
        })
        .finally(() => {
          if (request === generation.current) setLoading(false);
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
        E카운트 엑셀 자료와 저장한 배송 내역에서 검색합니다. 최대 30개를
        표시해요.
      </Text>
      {loading && <ActivityIndicator color={C.green} />}
      {!!error && (
        <Text accessibilityRole="alert" style={{ color: C.red }}>
          {error}
        </Text>
      )}
      {!loading && !error && !rows.length && (
        <Text style={s.muted}>
          검색 결과가 없습니다. 전표 등록 화면에서 거래처·품목 목록 엑셀을 먼저
          가져오거나 직접 입력해 주세요.
        </Text>
      )}
      {rows.map((row) => (
        <Pressable
          key={row.id}
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
            {row.source === "ecount" ? "E카운트 엑셀 자료" : "저장한 배송 내역"}
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
                  참고 단가 {row.unitPrice.toLocaleString()}원 · 전표 금액은
                  별도 확인
                </Text>
              )}
            </>
          )}
        </Pressable>
      ))}
    </Sheet>
  );
}
