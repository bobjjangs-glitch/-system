import { File } from "expo-file-system";
import {
  ImageManipulator,
  SaveFormat,
  type ImageRef,
} from "expo-image-manipulator";
import type { ImportUploadAsset } from "./importUpload";

const longestEdge = 2200;
const photoError = () =>
  new Error(
    "전표 사진을 준비하지 못했습니다. 사진이 정상적으로 열리는지 확인하고 다시 촬영하거나 선택해 주세요.",
  );

function resizeFor(width?: number, height?: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width! <= 0 ||
    height! <= 0 ||
    Math.max(width!, height!) <= longestEdge
  )
    return null;
  // Let the decoder preserve the actual image ratio, including EXIF rotation.
  return width! >= height! ? { width: longestEdge } : { height: longestEdge };
}

function jpegName(asset: ImportUploadAsset) {
  const original = (asset.name || asset.fileName || "receipt")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "");
  return (original.replace(/\.[^.]+$/, "") || "receipt") + ".jpg";
}

async function removeGenerated(uri: string, original: string) {
  if (!uri || uri === original) return;
  try {
    const file = new File(uri);
    // File resolves its URI consistently; never remove a picked source file.
    if (file.uri !== new File(original).uri && file.exists) file.delete();
  } catch {
    // A cache cleanup error must not hide a successful upload or its real error.
  }
}

export async function prepareReceiptImage(asset: ImportUploadAsset): Promise<{
  asset: ImportUploadAsset;
  dispose: () => Promise<void>;
}> {
  if (!asset || typeof asset.uri !== "string" || !asset.uri) throw photoError();

  let context: ReturnType<typeof ImageManipulator.manipulate> | undefined;
  const references: ImageRef[] = [];
  let savedUri: string | undefined;
  try {
    context = ImageManipulator.manipulate(asset.uri);
    // Rendering a native reference obtains the decoder's dimensions without
    // encoding/copying an original-sized upload. Picker metadata can be stale.
    let image = await context.renderAsync();
    references.push(image);

    // Use decoded dimensions so small images never enlarge and EXIF-rotated
    // photos retain their actual aspect ratio.
    const actualSize = resizeFor(image.width, image.height);
    if (actualSize) {
      context.resize(actualSize);
      image = await context.renderAsync();
      references.push(image);
    }
    if (
      !Number.isFinite(image.width) ||
      !Number.isFinite(image.height) ||
      image.width <= 0 ||
      image.height <= 0 ||
      Math.max(image.width, image.height) > longestEdge
    )
      throw photoError();

    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: 0.85,
    });
    savedUri = saved.uri;
    if (!saved.uri || saved.width <= 0 || saved.height <= 0) throw photoError();
    const name = jpegName(asset);
    // The old Web File points at the original camera photo. Only the processed
    // URI may be used by createImportForm, otherwise resizing has no effect.
    const {
      file: _originalFile,
      size: _originalSize,
      fileSize: _originalFileSize,
      ...rest
    } = asset;
    const prepared: ImportUploadAsset = {
      ...rest,
      uri: saved.uri,
      width: saved.width,
      height: saved.height,
      name,
      fileName: name,
      mimeType: "image/jpeg",
    };
    let disposed = false;
    return {
      asset: prepared,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await removeGenerated(saved.uri, asset.uri);
      },
    };
  } catch {
    if (savedUri) await removeGenerated(savedUri, asset.uri);
    throw photoError();
  } finally {
    for (const reference of references) {
      try {
        reference.release();
      } catch {}
    }
    try {
      context?.release();
    } catch {}
  }
}
