import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Driver, Route, Shipment } from "../server/types";
import { Button, Badge, Card, Field, C, s } from "./ui";
export default function DriverDeliveryHistory({
  shipments,
  routes,
  drivers,
  onSelect,
}: {
  shipments: Shipment[];
  routes: Route[];
  drivers: Driver[];
  onSelect: (stop: Shipment) => void;
}) {
  const [selected, setSelected] = useState("all"),
    [status, setStatus] = useState("all"),
    [query, setQuery] = useState(""),
    [expanded, setExpanded] = useState<string[]>([]);
  const groups = new Map<
    string,
    { id: string; name: string; stops: Shipment[] }
  >();
  for (const driver of drivers)
    groups.set(driver.id, { id: driver.id, name: driver.name, stops: [] });
  const owners = new Map(
    routes.map((route) => [
      route.id,
      { id: route.driverId, name: route.driverName },
    ]),
  );
  for (const stop of shipments) {
    const owner = stop.routeId ? owners.get(stop.routeId) : undefined;
    const id = owner?.id ?? (stop.routeId ? "unknown" : "pending"),
      name = owner?.name ?? (stop.routeId ? "기사 확인 필요" : "미배차");
    if (!groups.has(id)) groups.set(id, { id, name, stops: [] });
    groups.get(id)!.stops.push(stop);
  }
  const list = [...groups.values()].sort((a, b) =>
    a.id === "pending"
      ? 1
      : b.id === "pending"
        ? -1
        : a.name.localeCompare(b.name, "ko"),
  );
  const labels: Record<string, string> = {
    delivered: "배송 완료",
    failed: "미배송",
    assigned: "배송 대기",
    pending: "미배차",
  };
  const match = (stop: Shipment) =>
    (status === "all" ||
      (status === "waiting"
        ? ["assigned", "pending"].includes(stop.status)
        : stop.status === status)) &&
    (!query ||
      [
        stop.recipient,
        stop.address,
        stop.phone,
        stop.salesReference,
        ...stop.items.map((i) => i.name),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()));
  return (
    <>
      <Text style={s.section}>기사별 배송 내역</Text>
      <View style={[s.row, { flexWrap: "wrap", marginBottom: 14 }]}>
        {[{ id: "all", name: "전체 기사" }, ...list].map((group) => (
          <Button
            key={group.id}
            title={group.name}
            small
            secondary={selected !== group.id}
            onPress={() => {
              setSelected(group.id);
              setExpanded(group.id === "all" ? [] : [group.id]);
            }}
          />
        ))}
      </View>
      <Field
        label="배송 내역 검색"
        value={query}
        onChangeText={setQuery}
        placeholder="거래처 · 주소 · 물품 · 판매번호"
      />
      <View style={[s.row, { flexWrap: "wrap", marginBottom: 16 }]}>
        {[
          ["all", "전체 상태"],
          ["delivered", "배송 완료"],
          ["failed", "미배송"],
          ["waiting", "배송 대기"],
        ].map(([key, label]) => (
          <Button
            key={key}
            title={label}
            small
            secondary={status !== key}
            onPress={() => setStatus(key)}
          />
        ))}
      </View>
      {list
        .filter((group) => selected === "all" || selected === group.id)
        .map((group) => {
          const stops = group.stops.filter(match),
            completed = group.stops.filter(
              (s) => s.status === "delivered",
            ).length,
            failed = group.stops.filter((s) => s.status === "failed").length,
            open = expanded.includes(group.id) || !!query || status !== "all";
          return (
            <Card key={group.id}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${group.name} 배송내역 ${open ? "접기" : "펼치기"}`}
                onPress={() =>
                  setExpanded((old) =>
                    old.includes(group.id)
                      ? old.filter((id) => id !== group.id)
                      : [...old, group.id],
                  )
                }
              >
                <View style={s.between}>
                  <Text style={s.h2}>{group.name}</Text>
                  <Text style={s.muted}>{open ? "접기" : "상세 보기"}</Text>
                </View>
                <Text style={[s.muted, { marginTop: 8 }]}>
                  전체 {group.stops.length}곳 · 완료 {completed} · 미배송{" "}
                  {failed} · 대기 {group.stops.length - completed - failed}
                </Text>
                <Text style={[s.muted, { marginTop: 5 }]}>
                  물품 총{" "}
                  {group.stops
                    .reduce(
                      (n, stop) =>
                        n + stop.items.reduce((v, i) => v + i.quantity, 0),
                      0,
                    )
                    .toLocaleString()}
                  개
                </Text>
              </Pressable>
              {open && (
                <View style={{ marginTop: 12 }}>
                  {!stops.length && (
                    <Text style={s.muted}>
                      조건에 맞는 배송 내역이 없습니다.
                    </Text>
                  )}
                  {stops.map((stop) => (
                    <Pressable
                      key={stop.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${group.name} ${stop.recipient} 배송 상세`}
                      onPress={() => onSelect(stop)}
                      style={{
                        paddingVertical: 15,
                        borderTopWidth: 1,
                        borderTopColor: C.line,
                      }}
                    >
                      <View style={s.between}>
                        <Text style={[s.h3, { flex: 1 }]}>
                          {stop.sequence ? `${stop.sequence}. ` : ""}
                          {stop.recipient}
                        </Text>
                        <Badge
                          text={labels[stop.status] ?? stop.status}
                          tone={
                            stop.status === "failed"
                              ? "red"
                              : stop.status === "delivered"
                                ? "green"
                                : "grey"
                          }
                        />
                      </View>
                      <Text style={[s.muted, { marginTop: 6 }]}>
                        {stop.address}
                      </Text>
                      <Text style={[s.muted, { color: C.green, marginTop: 5 }]}>
                        {stop.items
                          .map((i) => `${i.name} ${i.quantity}개`)
                          .join(" · ")}
                      </Text>
                      {!!stop.salesReference && (
                        <Text style={s.muted}>
                          판매전표 {stop.salesReference}
                        </Text>
                      )}
                      {!!stop.failureReason && (
                        <Text style={{ color: C.red, marginTop: 5 }}>
                          미배송 사유 · {stop.failureReason}
                        </Text>
                      )}
                      {!!stop.deliveredAt && (
                        <Text style={[s.muted, { marginTop: 5 }]}>
                          {new Date(stop.deliveredAt).toLocaleString("ko-KR", {
                            timeZone: "Asia/Seoul",
                          })}{" "}
                          처리
                        </Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              )}
            </Card>
          );
        })}
      {!shipments.length && (
        <Text style={s.muted}>이 날짜에는 배송 내역이 없습니다.</Text>
      )}
    </>
  );
}
