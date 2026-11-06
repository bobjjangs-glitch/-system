import React, { useEffect, useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  Pressable,
  View,
  useWindowDimensions,
} from "react-native";
import { Plus, Search, Trash2 } from "lucide-react-native";
import type { Item } from "../server/types";
import {
  calculateInvoiceLine,
  changeInvoiceNumber,
  numberInput,
  invoiceDisplayTotals,
} from "./invoiceMath";
import { Button, C, s } from "./ui";
const columns = [36, 44, 118, 240, 145, 76, 100, 110, 110, 130, 110, 78];
function Cell({
  label,
  value,
  onChange,
  numeric = false,
  readOnly = false,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  numeric?: boolean;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(value),
    [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(value);
  }, [value, focus]);
  return (
    <TextInput
      accessibilityLabel={label}
      value={focus ? text : value}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChangeText={(v) => {
        setText(v);
        onChange(v);
      }}
      editable={!readOnly}
      inputMode={numeric ? "decimal" : "text"}
      autoCorrect={false}
      autoCapitalize="none"
      selectTextOnFocus
      style={{
        minHeight: 54,
        paddingHorizontal: 8,
        paddingVertical: 8,
        color: C.ink,
        fontSize: 13,
        textAlign: numeric ? "right" : "left",
        backgroundColor: readOnly ? "#f8faf9" : "white",
      }}
    />
  );
}
const money = (x: unknown) =>
  typeof x === "number" && Number.isFinite(x)
    ? x.toLocaleString("ko-KR", { maximumFractionDigits: 0 })
    : "";
const val = (x: unknown) =>
  typeof x === "number" && !Number.isFinite(x)
    ? ""
    : x == null
      ? ""
      : String(x);
export default function InvoiceItemsEditor({
  items,
  onChange,
  onSearch,
  disabled = false,
}: {
  items: Item[];
  onChange: (items: Item[]) => void;
  onSearch: (index: number) => void;
  disabled?: boolean;
}) {
  const compact = useWindowDimensions().width < 720;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const shown = items.map(calculateInvoiceLine);
  const total = invoiceDisplayTotals(shown),
    set = (i: number, item: Item) =>
      onChange(items.map((x, j) => (j === i ? item : x)));
  const numeric = (
    i: number,
    key:
      | "quantity"
      | "unitPrice"
      | "supplyAmount"
      | "totalAmount"
      | "discountRate"
      | "factoryPrice",
    text: string,
  ) => set(i, changeInvoiceNumber(items[i], key, numberInput(text)));
  const headers = [
    "선택",
    "추가",
    "품목코드",
    "품목명",
    "패턴",
    "수량",
    "단가",
    "금액",
    "합계",
    "적요",
    "공장도가",
    "DC율",
  ];
  return (
    <View style={{ gap: 12, marginVertical: 14 }}>
      <Text style={s.h3}>판매 품목</Text>
      <Text style={s.muted}>
        {compact
          ? "품목별로 아래 항목을 입력하세요. 옆으로 넘기지 않아도 모든 항목이 보입니다."
          : "표를 좌우로 밀어 입력하세요. 행의 +로 ERP 품목을 검색합니다."}{" "}
        {items.some(item => item.priceOrigin === "ocr")
          ? "사진의 인쇄값을 그대로 표시합니다. 부가세 포함 여부와 빈 금액은 원본을 확인해 주세요."
          : "금액은 공급가액, 합계는 부가세 포함 금액입니다."}
      </Text>
      {compact ? (
        <View style={{ gap: 14 }}>
          {shown.map((item, i) => (
            <View
              key={i}
              style={{
                borderWidth: 1,
                borderColor: C.line,
                borderRadius: 14,
                padding: 12,
                gap: 10,
                backgroundColor: "white",
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={`${i + 1}행 선택`}
                  accessibilityState={{ checked: selected.has(i) }}
                  disabled={disabled}
                  onPress={() =>
                    setSelected((old) => {
                      const n = new Set(old);
                      n.has(i) ? n.delete(i) : n.add(i);
                      return n;
                    })
                  }
                  style={{ padding: 8 }}
                >
                  <Text style={s.h3}>
                    {selected.has(i) ? "☑" : "☐"} 품목 {i + 1}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${i + 1}행 품목 검색`}
                  disabled={disabled}
                  onPress={() => onSearch(i)}
                  style={{
                    padding: 10,
                    backgroundColor: "#edf5ef",
                    borderRadius: 10,
                  }}
                >
                  <Text style={{ fontWeight: "700", color: C.green }}>
                    품목 검색
                  </Text>
                </Pressable>
              </View>
              {(
                [
                  { label: "품목코드", key: "code" },
                  { label: "품목명", key: "name" },
                  { label: "패턴", key: "pattern" },
                ] as const
              ).map((f) => (
                <View key={f.key} style={{ gap: 4 }}>
                  <Text style={s.label}>{f.label}</Text>
                  <View
                    style={{
                      borderWidth: 1,
                      borderColor: C.line,
                      borderRadius: 8,
                      overflow: "hidden",
                    }}
                  >
                    <Cell
                      label={`${f.label} ${i + 1}`}
                      value={item[f.key] ?? ""}
                      onChange={(value) =>
                        set(i, {
                          ...item,
                          [f.key]: value,
                          ...(f.key === "code" ? { erpItemId: undefined } : {}),
                        })
                      }
                      readOnly={disabled}
                    />
                  </View>
                </View>
              ))}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                {(
                  [
                    { label: "수량", key: "quantity" },
                    { label: "단가", key: "unitPrice" },
                    { label: "금액", key: "supplyAmount" },
                    { label: "합계", key: "totalAmount" },
                    { label: "공장도가", key: "factoryPrice" },
                    { label: "DC율", key: "discountRate" },
                  ] as const
                ).map((f) => (
                  <View
                    key={f.key}
                    style={{ width: "48%", flexGrow: 1, minWidth: 0, gap: 4 }}
                  >
                    <Text style={s.label}>{f.label}</Text>
                    <View
                      style={{
                        borderWidth: 1,
                        borderColor: C.line,
                        borderRadius: 8,
                        overflow: "hidden",
                      }}
                    >
                      <Cell
                        label={`${f.label} ${i + 1}`}
                        value={
                          f.key === "quantity"
                            ? val(item.quantity)
                            : f.key === "discountRate"
                              ? item.discountRate == null
                                ? ""
                                : val(item.discountRate) + "%"
                              : money(item[f.key])
                        }
                        onChange={(value) => numeric(i, f.key, value)}
                        numeric
                        readOnly={disabled}
                      />
                    </View>
                  </View>
                ))}
              </View>
              <View style={{ gap: 4 }}>
                <Text style={s.label}>적요</Text>
                <View
                  style={{
                    borderWidth: 1,
                    borderColor: C.line,
                    borderRadius: 8,
                    overflow: "hidden",
                  }}
                >
                  <Cell
                    label={`비고 ${i + 1}`}
                    value={item.remarks ?? ""}
                    onChange={(remarks) => set(i, { ...item, remarks })}
                    readOnly={disabled}
                  />
                </View>
              </View>
              {items.length > 1 && (
                <Button
                  title={`${i + 1}번 품목 삭제`}
                  small
                  secondary
                  danger
                  disabled={disabled}
                  onPress={() => {
                    onChange(items.filter((_, j) => i !== j));
                    setSelected(new Set());
                  }}
                />
              )}
            </View>
          ))}
        </View>
      ) : (
        <ScrollView
          horizontal
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator
        >
          <View
            style={{
              borderWidth: 1,
              borderColor: C.line,
              minWidth: columns.reduce((a, b) => a + b, 0),
            }}
          >
            <View
              style={{
                flexDirection: "row",
                backgroundColor: "#f4f6f8",
                borderBottomWidth: 1,
                borderColor: C.line,
              }}
            >
              {headers.map((h, i) => (
                <View
                  key={h}
                  style={{
                    width: columns[i],
                    minHeight: 42,
                    justifyContent: "center",
                    alignItems: "center",
                    borderRightWidth: 1,
                    borderColor: C.line,
                  }}
                >
                  {i === 0 ? (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{
                        checked: selected.size === items.length,
                      }}
                      accessibilityLabel="전체 품목 선택"
                      disabled={disabled}
                      onPress={() =>
                        setSelected(
                          selected.size === items.length
                            ? new Set()
                            : new Set(items.map((_, j) => j)),
                        )
                      }
                    >
                      <Text>{selected.size === items.length ? "☑" : "☐"}</Text>
                    </Pressable>
                  ) : i === 1 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="빈 품목 행 추가"
                      disabled={disabled}
                      onPress={() =>
                        onChange([
                          ...items,
                          {
                            name: "",
                            quantity: 1,
                            unitPrice: null,
                            amountBasis: "unit",
                          },
                        ])
                      }
                    >
                      <Plus size={19} color={C.green} />
                    </Pressable>
                  ) : (
                    <Text
                      style={{ fontSize: 12, fontWeight: "700", color: C.ink }}
                    >
                      {h}
                    </Text>
                  )}
                </View>
              ))}
            </View>
            {shown.map((item, i) => {
              const cells = [
                <Pressable
                  key="check"
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected.has(i) }}
                  accessibilityLabel={`${i + 1}행 선택`}
                  disabled={disabled}
                  onPress={() =>
                    setSelected((old) => {
                      const n = new Set(old);
                      n.has(i) ? n.delete(i) : n.add(i);
                      return n;
                    })
                  }
                  style={{
                    alignItems: "center",
                    justifyContent: "center",
                    minHeight: 54,
                  }}
                >
                  <Text style={{ color: C.green }}>
                    {selected.has(i) ? "☑" : i + 1}
                  </Text>
                </Pressable>,
                <Pressable
                  key="search"
                  accessibilityRole="button"
                  accessibilityLabel={`${i + 1}행 품목 검색`}
                  disabled={disabled}
                  onPress={() => onSearch(i)}
                  style={{
                    minHeight: 54,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Plus size={18} color={C.green} />
                </Pressable>,
                <Cell
                  key="code"
                  label={`품목코드 ${i + 1}`}
                  value={item.code ?? ""}
                  onChange={(code) =>
                    set(i, { ...item, code, erpItemId: undefined })
                  }
                  readOnly={disabled}
                />,
                <Cell
                  key="name"
                  label={`품목명 ${i + 1}`}
                  value={item.name}
                  onChange={(name) => set(i, { ...item, name })}
                  readOnly={disabled}
                />,
                <Cell
                  key="pattern"
                  label={`패턴 ${i + 1}`}
                  value={item.pattern ?? ""}
                  onChange={(pattern) => set(i, { ...item, pattern })}
                  readOnly={disabled}
                />,
                <Cell
                  key="quantity"
                  label={`수량 ${i + 1}`}
                  value={val(item.quantity)}
                  onChange={(v) => numeric(i, "quantity", v)}
                  numeric
                  readOnly={disabled}
                />,
                <Cell
                  key="price"
                  label={`단가 ${i + 1}`}
                  value={money(item.unitPrice)}
                  onChange={(v) => numeric(i, "unitPrice", v)}
                  numeric
                  readOnly={disabled}
                />,
                <Cell
                  key="net"
                  label={`금액 ${i + 1}`}
                  value={money(item.supplyAmount)}
                  onChange={(v) => numeric(i, "supplyAmount", v)}
                  numeric
                  readOnly={disabled}
                />,
                <Cell
                  key="total"
                  label={`합계 ${i + 1}`}
                  value={money(item.totalAmount)}
                  onChange={(v) => numeric(i, "totalAmount", v)}
                  numeric
                  readOnly={disabled}
                />,
                <Cell
                  key="remarks"
                  label={`비고 ${i + 1}`}
                  value={item.remarks ?? ""}
                  onChange={(remarks) => set(i, { ...item, remarks })}
                  readOnly={disabled}
                />,
                <Cell
                  key="factory"
                  label={`공장도가 ${i + 1}`}
                  value={money(item.factoryPrice)}
                  onChange={(v) => numeric(i, "factoryPrice", v)}
                  numeric
                  readOnly={disabled}
                />,
                <Cell
                  key="dc"
                  label={`DC율 ${i + 1}`}
                  value={
                    item.discountRate == null
                      ? ""
                      : val(item.discountRate) + "%"
                  }
                  onChange={(v) => numeric(i, "discountRate", v)}
                  numeric
                  readOnly={disabled}
                />,
              ];
              return (
                <View
                  key={i}
                  style={{
                    flexDirection: "row",
                    borderBottomWidth: 1,
                    borderColor: C.line,
                  }}
                >
                  {cells.map((cell, j) => (
                    <View
                      key={j}
                      style={{
                        width: columns[j],
                        borderRightWidth: 1,
                        borderColor: C.line,
                      }}
                    >
                      {cell}
                    </View>
                  ))}
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button
          title="품목 행 추가"
          small
          secondary
          icon={Plus}
          disabled={disabled}
          onPress={() =>
            onChange([
              ...items,
              { name: "", quantity: 1, unitPrice: null, amountBasis: "unit" },
            ])
          }
        />
        <Button
          title="선택 품목 삭제"
          small
          secondary
          icon={Trash2}
          disabled={disabled || !selected.size}
          onPress={() => {
            const remaining = items.filter((_, i) => !selected.has(i));
            onChange(
              remaining.length
                ? remaining
                : [
                    {
                      name: "",
                      quantity: 1,
                      unitPrice: null,
                      amountBasis: "unit",
                    },
                  ],
            );
            setSelected(new Set());
          }}
        />
      </View>
      <Text style={s.muted}>
        품목 선택 시 ERP 거래처의 소매·도매 구분에 맞는 단가와 금액을 채웁니다.
        DC율은 공장도가가 있으면 공장도가, 없으면 ERP 기준가(소매가)에
        적용합니다. 공장도가가 없는 품목은 입력할 수 있습니다.
      </Text>
      <View
        style={{
          padding: 12,
          borderRadius: 12,
          backgroundColor: "#edf5ef",
          gap: 4,
        }}
      >
        <Text style={s.muted}>
          {items.some(item => item.priceOrigin === "ocr") ? "금액(인쇄값)" : "공급가액"} {total.supply == null ? "확인 필요" : total.supply.toLocaleString()+"원"} · 부가세{" "}
          {total.vat == null ? "확인 필요" : total.vat.toLocaleString()+"원"}
        </Text>
        <Text style={s.h3}>
          합계 {total.total == null ? "확인 필요" : total.total.toLocaleString()+"원"}
        </Text>
      </View>
    </View>
  );
}
