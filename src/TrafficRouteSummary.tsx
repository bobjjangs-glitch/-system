import React, { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import type { Route } from "../server/types";
import { api } from "./api";
import { Badge, Button, C, Field, s } from "./ui";

function clock(value: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function RoutePlanningSummary({ route }: { route: Route }) {
  const planning = route.planning;
  if (!planning) return null;
  return (
    <View
      style={{
        marginVertical: 12,
        padding: 12,
        backgroundColor: "#edf5ea",
        borderRadius: 10,
      }}
    >
      <Text style={{ color: C.green, fontWeight: "700", fontSize: 13 }}>
        출발 예정 {clock(planning.departureAt)} · 복귀 예상{" "}
        {clock(planning.returnAt)}
      </Text>
      <Text style={[s.muted, { fontSize: 11, marginTop: 5 }]}>
        배송지마다 {route.company.serviceMinutes}분 체류 포함
        {planning.trafficCheckedAt
          ? ` · 교통 조회 ${clock(planning.trafficCheckedAt)}`
          : " · 실시간 교통 미반영"}
      </Text>
      {planning.legTimesEstimated && (
        <Text style={[s.muted, { fontSize: 11, marginTop: 4 }]}>
          배송지별 도착 시각은 구간별 추정이며 실제 상황에 따라 달라져요.
        </Text>
      )}
    </View>
  );
}

export function StopArrival({
  route,
  shipmentId,
}: {
  route: Route;
  shipmentId: string;
}) {
  const stop = route.planning?.stops.find(
    (item) => item.shipmentId === shipmentId,
  );
  if (!stop) return null;
  return (
    <Text style={{ color: C.green, fontSize: 11, marginTop: 5 }}>
      도착 예상 {clock(stop.arrivalAt)} · 출발 {clock(stop.departureAt)}
    </Text>
  );
}

export function TrafficPlannerControls({
  busy,
  active,
  count,
  date,
  onGenerate,
}: {
  busy: boolean;
  active: boolean;
  count: number;
  date: string;
  onGenerate: (options: {
    departureAt: string;
    trafficRequired: boolean;
    groupByRegion: boolean;
  }) => void;
}) {
  const [regional, setRegional] = useState(true);
  const [live, setLive] = useState(true);
  const [status, setStatus] = useState<{ configured: boolean } | null>(null);
  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState("");
  const [time, setTime] = useState(() =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Seoul",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date()),
  );
  const check = async () => {
    setChecking(true);
    try {
      setStatus(await api("/api/routing-status"));
      setMessage("");
    } catch {
      setStatus(null);
      setMessage(
        "교통 연동 상태를 확인하지 못했습니다. 서버 업데이트·설정 후 다시 확인해 주세요.",
      );
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void check();
  }, []);
  const validTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return (
    <View>
      <Text style={[s.muted, { marginVertical: 13 }]}>
        회사 왕복과 체류 시간을 포함해 기사별 소요 시간을 맞추고, 배송지 방문
        순서를 비교합니다.
      </Text>
      <View style={[s.between, { marginBottom: 12 }]}>
        <Text style={s.h3}>구·시·군별 우선 배차</Text>
        <Switch
          accessibilityLabel="구·시·군별 우선 배차"
          value={regional}
          onValueChange={setRegional}
          disabled={busy}
        />
      </View>
      {regional && (
        <Text style={[s.muted, { marginBottom: 12 }]}>
          같은 지역을 우선 묶고 기사별 최대 배송지 수 안에서 나눕니다. 지역
          물량과 기사 수에 따라 한 코스에 인근 지역이 함께 포함될 수 있어요.
        </Text>
      )}
      <View style={[s.between, { marginBottom: 12 }]}>
        <Text style={s.h3}>실시간 교통 반영</Text>
        <Switch
          accessibilityLabel="실시간 교통 반영"
          value={live}
          onValueChange={setLive}
          disabled={busy}
        />
      </View>
      <View style={{ marginBottom: 12 }}>
        <Badge
          text={
            checking
              ? "교통 연동 확인 중"
              : status?.configured
                ? "네이버 교통 연동 설정됨"
                : "교통 연동 설정 필요"
          }
          tone={status?.configured ? "green" : "amber"}
        />
        {message ? (
          <Text style={[s.muted, { marginTop: 7 }]}>{message}</Text>
        ) : !status?.configured && !checking ? (
          <Text style={[s.muted, { marginTop: 7 }]}>
            관리자 서버에 Directions 15 Key ID·Key Secret을 등록하면 사용할 수
            있어요.
          </Text>
        ) : null}
        <View style={{ marginTop: 8, alignSelf: "flex-start" }}>
          <Button
            title="교통 연동 상태 확인"
            secondary
            small
            disabled={checking || busy}
            onPress={() => {
              void check();
            }}
          />
        </View>
      </View>
      <Field
        label="회사 출발 예정 시각 (한국 시간)"
        value={time}
        onChangeText={setTime}
        placeholder="09:00"
        inputStyle={{ fontSize: 16 }}
      />
      <Text style={[s.muted, { fontSize: 11, marginBottom: 12 }]}>
        현재 교통을 기준으로 계산합니다. 미래 시각의 교통을 예측하는 기능은
        아닙니다.
      </Text>
      {!live && (
        <Text style={{ color: C.amber, fontSize: 12, marginBottom: 12 }}>
          실시간 교통을 끄면 거리·도로 기준으로 추천합니다.
        </Text>
      )}
      {!validTime && (
        <Text style={{ color: C.red, marginBottom: 10 }}>
          출발 시각을 09:00 형식으로 입력해 주세요.
        </Text>
      )}
      <Button
        title={`${live ? "교통 반영" : "일반"} 추천 배차 생성 · ${count}곳`}
        disabled={
          busy ||
          active ||
          !validTime ||
          (live && (checking || !status?.configured))
        }
        onPress={() =>
          onGenerate({
            trafficRequired: live,
            groupByRegion: regional,
            departureAt: `${date}T${time}:00+09:00`,
          })
        }
      />
    </View>
  );
}
