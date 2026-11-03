import type { ImportUploadAsset } from "./importUpload";

const longestEdge = 2200;
const photoError = () =>
  new Error(
    "전표 사진을 준비하지 못했습니다. 사진이 정상적으로 열리는지 확인하고 다시 촬영하거나 선택해 주세요.",
  );

export async function prepareReceiptImage(asset: ImportUploadAsset): Promise<{
  asset: ImportUploadAsset;
  dispose: () => Promise<void>;
}> {
  if (!asset || typeof asset.uri !== "string" || !asset.uri) throw photoError();

  let sourceUrl: string | undefined;
  let savedUrl: string | undefined;
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    // Read the picked File directly; do not fetch a large remote original or
    // leave the original File attached to the eventual multipart upload.
    const source = asset.file
      ? (sourceUrl = URL.createObjectURL(asset.file))
      : asset.uri;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(photoError());
      image.crossOrigin = "anonymous";
      image.src = source;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (width <= 0 || height <= 0) throw photoError();
    const scale = Math.min(1, longestEdge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw photoError();
    // JPEG has no alpha channel. Keep black text readable on transparent PNGs.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(photoError())),
        "image/jpeg",
        0.85,
      );
    });
    if (!blob.size || blob.type !== "image/jpeg") throw photoError();
    savedUrl = URL.createObjectURL(blob);
    const original = (asset.name || asset.fileName || "receipt")
      .split(/[\\/]/)
      .pop()!
      .replace(/[\u0000-\u001f\u007f]/g, "");
    const name = (original.replace(/\.[^.]+$/, "") || "receipt") + ".jpg";
    const { file: _file, ...rest } = asset;
    const prepared = {
      ...rest,
      uri: savedUrl,
      width: canvas.width,
      height: canvas.height,
      name,
      fileName: name,
      mimeType: "image/jpeg",
      fileSize: blob.size,
      size: blob.size,
    };
    const output = savedUrl;
    let disposed = false;
    return {
      asset: prepared,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        if (output !== asset.uri) URL.revokeObjectURL(output);
      },
    };
  } catch {
    if (savedUrl && savedUrl !== asset.uri) URL.revokeObjectURL(savedUrl);
    throw photoError();
  } finally {
    if (sourceUrl && sourceUrl !== asset.uri) URL.revokeObjectURL(sourceUrl);
    image.onload = null;
    image.onerror = null;
    image.src = "";
    canvas.width = 0;
    canvas.height = 0;
  }
}
