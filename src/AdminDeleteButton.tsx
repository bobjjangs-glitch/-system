import React, { useState } from "react";
import { Text, View } from "react-native";
import { api } from "./api";
import { Button, Sheet, C, s } from "./ui";
/** Rendered only inside the administrator application. Server enforces the role again. */
export default function AdminDeleteButton({ kind, id, name, disabled, onDeleted }: {
  kind: "routes" | "drivers" | "imports"; id: string; name: string; disabled?: boolean; onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <>
    <Button title={kind === "routes" ? "코스 삭제" : kind === "imports" ? "조회 목록 삭제" : "기사 삭제"} small secondary danger disabled={disabled || busy}
      onPress={() => { setError(""); setOpen(true); }} />
    <Sheet title="관리자 삭제 확인" visible={open} onClose={() => { if (!busy) setOpen(false); }}>
      <Text style={s.h3}>{name}</Text>
      <Text style={[s.muted, { marginVertical: 16 }]}>{kind === "imports" ? "이 판매조회 목록의 JSON 기록만 삭제합니다. 이미 등록한 배송지와 회사 ERP 원본 전표는 유지됩니다." : kind === "routes"
        ? "이 코스와 위치 기록을 삭제합니다. 남은 배송지는 보관하고, 배송 대기 건은 미배차로 돌립니다. 운행 중인 기사 화면에도 반영됩니다."
        : "이 기사 계정·로그인 PIN·위치 기록과 연결된 코스를 삭제합니다. 배송지는 보관하고 배송 대기 건은 미배차로 돌립니다."}</Text>
      <Text style={{ color: C.red, marginBottom: 16 }}>앱에서 삭제한 기록은 복구할 수 없습니다. 회사 ERP 원본 판매전표와 재고는 유지됩니다.</Text>
      {!!error && <Text accessibilityRole="alert" style={{ color: C.red, marginBottom: 16 }}>{error}</Text>}
      <Button title={busy ? "삭제 중…" : "삭제하기"} danger disabled={busy} onPress={async () => {
        if (busy) return; setBusy(true); setError("");
        try { await api("/api/admin/records/"+kind+"/"+id, { method:"DELETE" }); setOpen(false); onDeleted(); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }} />
      <View style={{ marginTop: 10 }}><Button title="취소" secondary disabled={busy} onPress={() => setOpen(false)} /></View>
    </Sheet>
  </>;
}
