import { NativeModules, Platform } from "react-native";
import { File, Paths } from "expo-file-system";

export type DeviceReceiptResult = {
  text: string;
  durationMs: number;
  imageUri: string;
  width: number;
  height: number;
};
type OcrBridge = {
  recognize: (uri: string) => Promise<DeviceReceiptResult>;
  cancel: () => Promise<void>;
  warmUp: () => Promise<boolean>;
};
function bridge(): OcrBridge | undefined {
  return NativeModules.DispatchReceiptOcr as OcrBridge | undefined;
}
export async function warmUpDeviceReceiptOcr() {
  if (Platform.OS !== "android") return;
  try {
    await bridge()?.warmUp();
  } catch {}
}
export async function removeDeviceOcrCache(uri: string) {
  try {
    const file = new File(uri);
    const cache = new File(Paths.cache, "dispatch-ocr-").uri;
    if (file.uri.startsWith(cache) && file.exists) file.delete();
  } catch {}
}
export async function recognizeDeviceReceipt(
  uri: string,
  signal: AbortSignal,
): Promise<DeviceReceiptResult> {
  const module = bridge();
  if (!module?.recognize)
    throw new Error("휴대폰 전표 인식이 포함된 최신 APK로 업데이트해 주세요.");
  if (signal.aborted) throw signal.reason;
  let aborted = false;
  const result = await new Promise<DeviceReceiptResult>((resolve, reject) => {
    const abort = () => {
      aborted = true;
      void module.cancel().catch(() => {});
      reject(signal.reason ?? new Error("전표 인식을 취소했습니다."));
    };
    signal.addEventListener("abort", abort, { once: true });
    module.recognize(uri).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (aborted) {
          void removeDeviceOcrCache(value.imageUri);
          return;
        }
        resolve(value);
      },
      (error: { code?: string }) => {
        signal.removeEventListener("abort", abort);
        if (aborted) return;
        const messages: Record<string, string> = {
          E_OCR_TIMEOUT:
            "휴대폰 글자 인식이 5초 안에 끝나지 않았습니다. 잠시 후 다시 시도해 주세요.",
          E_OCR_CANCELLED: "전표 인식을 취소했습니다.",
          E_OCR_BUSY:
            "이전 전표 인식을 정리하고 있습니다. 잠시 후 다시 촬영해 주세요.",
          E_OCR_IMAGE:
            "선택한 사진을 열지 못했습니다. 사진을 다시 선택해 주세요.",
          E_OCR_EMPTY:
            "전표에서 글자를 찾지 못했습니다. 인쇄된 글자가 보이는 사진을 선택해 주세요.",
        };
        reject(
          new Error(
            messages[error?.code ?? ""] ??
              "휴대폰에서 전표를 읽지 못했습니다. 다시 시도해 주세요.",
          ),
        );
      },
    );
  });
  if (!result || typeof result.text !== "string" || !result.text.trim()) {
    if (result?.imageUri) await removeDeviceOcrCache(result.imageUri);
    throw new Error(
      "전표에서 글자를 찾지 못했습니다. 인쇄된 글자가 보이는 사진을 선택해 주세요.",
    );
  }
  if (
    result.text.length > 50_000 ||
    !result.imageUri ||
    !Number.isFinite(result.width) ||
    !Number.isFinite(result.height) ||
    result.width <= 0 ||
    result.height <= 0
  ) {
    if (result.imageUri) await removeDeviceOcrCache(result.imageUri);
    throw new Error("전표 인식 결과를 읽지 못했습니다. 다시 촬영해 주세요.");
  }
  return result;
}
