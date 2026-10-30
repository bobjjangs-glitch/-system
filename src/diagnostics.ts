import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

export async function consumeLocationRecovery() {
  if (Platform.OS === "web") return false;
  const marker = new File(Paths.document, "dispatch-location-recovery.txt");
  if (!marker.exists) return false;
  marker.delete();
  return true;
}
export async function shareNativeCrash() {
  if (Platform.OS === "web")
    throw new Error("오류 정보는 설치한 휴대폰 앱에서 공유할 수 있어요.");
  const source = new File(Paths.document, "dispatch-native-crash.txt");
  if (!source.exists) throw new Error("저장된 앱 종료 정보가 없습니다.");
  const exported = new File(Paths.cache, "bareun-dispatch-diagnostics.txt");
  if (exported.exists) exported.delete();
  exported.create();
  exported.write(await source.text());
  await Sharing.shareAsync(exported.uri, {
    mimeType: "text/plain",
    dialogTitle: "앱 오류 정보 공유",
  });
}
