import { Platform } from "react-native";
import { File } from "expo-file-system";

export type ImportUploadKind = "camera" | "photo" | "excel";
export type ImportUploadAsset = {
  uri: string;
  name?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  fileSize?: number | null;
  size?: number | null;
  width?: number;
  height?: number;
  file?: Blob;
};

const maxUploadBytes = 15 * 1024 * 1024;
const unreadableFile = () =>
  new Error(
    "선택한 파일을 읽을 수 없습니다. 사진을 다시 촬영하거나 선택해 주세요.",
  );

function validateSize(size: number) {
  if (!Number.isFinite(size) || size <= 0)
    throw new Error(
      "비어 있는 파일입니다. 사진이나 엑셀 파일을 다시 선택해 주세요.",
    );
  if (size > maxUploadBytes)
    throw new Error(
      "파일은 15MB 이하로 올려 주세요. 사진 크기를 줄이거나 다시 촬영해 주세요.",
    );
}

function imageFormat(header: Uint8Array): { extension: string; type: string } {
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff)
    return { extension: "jpg", type: "image/jpeg" };
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte))
    return { extension: "png", type: "image/png" };
  const text = String.fromCharCode(...header);
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP")
    return { extension: "webp", type: "image/webp" };
  throw new Error(
    "사진은 JPG·PNG·WEBP 형식으로 올려 주세요. HEIC 사진은 JPG로 변환한 뒤 선택해 주세요.",
  );
}

function spreadsheetFormat(name: string, mimeType?: string | null) {
  const extension = name.match(/\.([^.]+)$/)?.[1].toLowerCase();
  if (
    extension === "csv" ||
    (!extension && mimeType?.toLowerCase().includes("csv"))
  )
    return { extension: "csv", type: "text/csv" };
  if (
    extension === "xlsx" ||
    (!extension &&
      mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
  )
    return {
      extension: "xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  throw new Error("엑셀(.xlsx) 또는 CSV 파일을 선택해 주세요.");
}

export async function createImportForm(
  asset: ImportUploadAsset,
  kind: ImportUploadKind,
  serviceDate: string,
): Promise<FormData> {
  if (!asset || typeof asset.uri !== "string" || !asset.uri)
    throw unreadableFile();
  if (
    kind !== "excel" &&
    Number.isFinite(asset.width) &&
    Number.isFinite(asset.height) &&
    asset.width! * asset.height! > 20_000_000
  )
    throw new Error(
      "사진 해상도가 너무 큽니다. 카메라의 50MP·고해상도 설정을 끄고 일반 해상도로 다시 촬영해 주세요.",
    );
  let blob: Blob | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let header: Uint8Array;
  if (Platform.OS === "web") {
    try {
      blob = asset.file;
      if (!blob) {
        const response = await fetch(asset.uri);
        if (!response.ok) throw unreadableFile();
        blob = await response.blob();
      }
    } catch {
      throw unreadableFile();
    }
    validateSize(blob.size);
    try {
      header = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    } catch {
      throw unreadableFile();
    }
  } else {
    let file: File;
    let size: number;
    try {
      file = new File(asset.uri);
      if (!file.exists) throw unreadableFile();
      size = file.size;
    } catch {
      throw unreadableFile();
    }
    validateSize(size);
    try {
      bytes = await file.bytes();
    } catch {
      throw unreadableFile();
    }
    validateSize(bytes.byteLength);
    header = bytes.subarray(0, 16);
  }

  const originalName = (
    asset.name ||
    asset.fileName ||
    asset.uri.split(/[?#]/)[0].split("/").pop() ||
    "receipt"
  )
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "");
  const format =
    kind === "excel"
      ? spreadsheetFormat(originalName, asset.mimeType)
      : imageFormat(header);
  const base =
    originalName.replace(/\.[^.]+$/, "") ||
    (kind === "excel" ? "deliveries" : "receipt");
  const name = `${base}.${format.extension}`;
  const form = new FormData();
  if (blob) {
    // Rewrap only to correct a stale picker MIME type (e.g. converted HEIC).
    form.append(
      "file",
      blob.type === format.type ? blob : blob.slice(0, blob.size, format.type),
      name,
    );
  } else {
    // Expo 57's default fetch accepts Blob/File bytes(), but rejects RN's
    // proprietary { uri, name, type } parts before sending a network request.
    // Explicit metadata also preserves the original name for Expo File objects.
    const filePart = { name, type: format.type, bytes: async () => bytes! };
    form.append("file", filePart as unknown as Blob, name);
  }
  form.append("serviceDate", serviceDate);
  return form;
}
