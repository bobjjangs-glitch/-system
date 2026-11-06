import { Directory, File, Paths } from "expo-file-system";
import type { ShipmentInput } from "../server/types";
import { API_URL } from "./api";
import type { ImportUploadAsset } from "./importUpload";
import type { ReceiptLayout } from "./receiptText";
import { normalizeReceiptLayout } from "./receiptLayout";

export type DeviceReceiptDraft = {
  localId: string;
  userId: string;
  serviceDate: string;
  fileName: string;
  rawText: string;
  layout?: ReceiptLayout;
  drafts: ShipmentInput[];
  asset: ImportUploadAsset;
  remoteId?: string;
  createdAt: string;
};

const folderName = "device-receipt-drafts-v1";
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const draftPattern = /^ocr-[a-z0-9]+-[a-f0-9]{16}$/;
const queues = new Map<string, Promise<unknown>>();
const invalidDraft = () =>
  new Error("기기에 저장된 전표 정보를 확인할 수 없습니다.");
const storageFailure = () =>
  new Error(
    "전표를 기기에 저장하지 못했습니다. 저장 공간을 확인한 뒤 다시 시도해 주세요.",
  );

// This is a directory shard, never an authentication identifier. Every metadata
// record also checks the full server URL and owner before returning any data.
function serverFolder() {
  let a = 2166136261,
    b = 3339675911;
  for (const character of API_URL) {
    a = Math.imul(a ^ character.charCodeAt(0), 16777619);
    b = Math.imul(b ^ character.charCodeAt(0), 2246822519);
  }
  return (
    (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 0).toString(16).padStart(8, "0")
  );
}

function ownerDirectory(userId: string, create = false) {
  if (typeof userId !== "string" || !idPattern.test(userId))
    throw invalidDraft();
  const directory = new Directory(
    Paths.document,
    folderName,
    serverFolder(),
    userId,
  );
  if (create) directory.create({ intermediates: true, idempotent: true });
  return directory;
}

function files(userId: string, localId: string, create = false) {
  if (typeof localId !== "string" || !draftPattern.test(localId))
    throw invalidDraft();
  const directory = ownerDirectory(userId, create);
  return {
    directory,
    image: new File(directory, localId + ".jpg"),
    metadata: new File(directory, localId + ".json"),
  };
}

function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  queues.set(key, current);
  void current
    .finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    })
    .catch(() => {});
  return current;
}

// Incomplete edits (for example an invalid numeric quantity) must survive
// closing the sheet too. JSON otherwise silently changes NaN into null.
function encode(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "number" && !Number.isFinite(item)
      ? { __receiptNumber: String(item) }
      : item,
  );
}

function decode(text: string): any {
  return JSON.parse(text, (_key, item) => {
    if (item && typeof item === "object" && Object.keys(item).length === 1) {
      if (item.__receiptNumber === "NaN") return NaN;
      if (item.__receiptNumber === "Infinity") return Infinity;
      if (item.__receiptNumber === "-Infinity") return -Infinity;
    }
    return item;
  });
}

function validRows(value: unknown): value is ShipmentInput[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 2000 &&
    value.every(
      (row) =>
        row &&
        typeof row.recipient === "string" &&
        typeof row.address === "string" &&
        Array.isArray(row.items) &&
        row.items.every(
          (item: any) =>
            item &&
            typeof item.name === "string" &&
            typeof item.quantity === "number",
        ),
    )
  );
}

function validated(
  value: unknown,
  userId: string,
  localId: string,
): DeviceReceiptDraft {
  const draft = value as DeviceReceiptDraft | null;
  const expected = files(userId, localId).image.uri;
  if (
    !draft ||
    draft.userId !== userId ||
    draft.localId !== localId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(draft.serviceDate) ||
    typeof draft.fileName !== "string" ||
    !draft.fileName ||
    draft.fileName.length > 240 ||
    typeof draft.rawText !== "string" ||
    !draft.rawText.trim() ||
    draft.rawText.length > 50_000 ||
    !validRows(draft.drafts) ||
    !draft.asset ||
    draft.asset.uri !== expected ||
    (draft.remoteId !== undefined &&
      (typeof draft.remoteId !== "string" ||
        !idPattern.test(draft.remoteId))) ||
    typeof draft.createdAt !== "string" ||
    !Number.isFinite(Date.parse(draft.createdAt))
  )
    throw invalidDraft();
  return draft.layout === undefined
    ? draft
    : { ...draft, layout: normalizeReceiptLayout(draft.layout) };
}

async function readDraft(
  userId: string,
  localId: string,
): Promise<DeviceReceiptDraft | null> {
  const { metadata } = files(userId, localId);
  if (!metadata.exists) return null;
  if (metadata.size > 2_000_000) throw invalidDraft();
  const envelope = decode(await metadata.text());
  if (envelope?.version !== 1 || envelope?.serverUrl !== API_URL)
    throw invalidDraft();
  return validated(envelope.draft, userId, localId);
}

async function writeDraft(draft: DeviceReceiptDraft) {
  const { directory, metadata } = files(draft.userId, draft.localId, true);
  const previous = await readDraft(draft.userId, draft.localId);
  // A close/edit snapshot taken before upload completed must not erase a known
  // import ID and accidentally upload the same photo again on the next save.
  // Only receipt data belongs in this file. Do not serialize extra fields from
  // a caller's object (for example a session, a Blob or picker EXIF metadata).
  const next: DeviceReceiptDraft = {
    localId: draft.localId,
    userId: draft.userId,
    serviceDate: draft.serviceDate,
    fileName: draft.fileName,
    rawText: draft.rawText,
    layout:
      draft.layout === undefined && previous?.layout === undefined
        ? undefined
        : normalizeReceiptLayout(draft.layout ?? previous?.layout),
    createdAt: draft.createdAt,
    remoteId: draft.remoteId ?? previous?.remoteId,
    asset: {
      uri: draft.asset.uri,
      name: draft.fileName,
      fileName: draft.fileName,
      mimeType: "image/jpeg",
      width: draft.asset.width,
      height: draft.asset.height,
      size: draft.asset.size,
      fileSize: draft.asset.fileSize,
    },
    drafts: draft.drafts.map((row) => ({
      recipient: row.recipient,
      address: row.address,
      phone: row.phone,
      items: row.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        ...(item.code ? { code: item.code } : {}),
        ...Object.fromEntries(
          [
            "brand",
            "dot",
            "vatAmount",
            "vatRate",
            "discountRateRaw",
            "nativeFields",
            "specification",
            "pattern",
            "erpItemId",
            "unitPrice",
            "supplyAmount",
            "totalAmount",
            "discountRate",
            "listPrice",
            "factoryPrice",
            "retailPrice",
            "wholesalePrice",
            "priceOrigin",
            "taxType",
            "amountBasis",
            "remarks",
          ]
            .filter((key) => (item as any)[key] !== undefined)
            .map((key) => [key, (item as any)[key]]),
        ),
      })),
      notes: row.notes,
      lat: row.lat,
      lng: row.lng,
      ...(row.amount !== undefined ? { amount: row.amount } : {}),
      ...(row.customerCode ? { customerCode: row.customerCode } : {}),
      ...(row.erpCustomerId ? { erpCustomerId: row.erpCustomerId } : {}),
      ...(row.salesReference ? { salesReference: row.salesReference } : {}),
      ...(row.erpSourceKey ? { erpSourceKey: row.erpSourceKey } : {}),
    })),
  };
  const payload = encode({ version: 1, serverUrl: API_URL, draft: next });
  if (new TextEncoder().encode(payload).byteLength > 2_000_000)
    throw invalidDraft();
  const temporary = new File(
    directory,
    draft.localId + ".tmp-" + Date.now().toString(36) + ".json",
  );
  try {
    temporary.create({ overwrite: true });
    temporary.write(payload);
    await temporary.move(metadata, { overwrite: true });
  } finally {
    try {
      if (temporary.exists && temporary.uri !== metadata.uri)
        temporary.delete();
    } catch {}
  }
}

export async function createDeviceReceiptDraft(
  userId: string,
  asset: ImportUploadAsset,
  serviceDate: string,
  rawText: string,
  drafts: ShipmentInput[],
  layout?: ReceiptLayout,
): Promise<DeviceReceiptDraft> {
  const normalizedLayout =
    layout === undefined ? undefined : normalizeReceiptLayout(layout);
  const random = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 65536)
      .toString(16)
      .padStart(4, "0"),
  ).join("");
  const localId = "ocr-" + Date.now().toString(36) + "-" + random;
  const { image, metadata } = files(userId, localId, true);
  try {
    const source = new File(asset.uri);
    if (!source.exists || source.size <= 0 || source.size > 15 * 1024 * 1024)
      throw storageFailure();
    await source.copy(image);
    const fileName =
      (asset.name || asset.fileName || "전표.jpg")
        .split(/[\\/]/)
        .pop()!
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .slice(0, 240) || "전표.jpg";
    const result: DeviceReceiptDraft = {
      localId,
      userId,
      serviceDate,
      fileName,
      rawText,
      layout: normalizedLayout,
      drafts,
      asset: {
        uri: image.uri,
        name: fileName,
        fileName,
        mimeType: "image/jpeg",
        width: asset.width,
        height: asset.height,
        size: image.size,
        fileSize: image.size,
      },
      createdAt: new Date().toISOString(),
    };
    validated(result, userId, localId);
    await serial(userId + ":" + localId, () => writeDraft(result));
    return result;
  } catch (error) {
    // Only files derived from this new local ID belong to this operation.
    // Never remove or move the source picked by the user.
    try {
      if (metadata.exists) metadata.delete();
    } catch {}
    try {
      if (image.exists) image.delete();
    } catch {}
    throw error instanceof Error && error.message === invalidDraft().message
      ? error
      : storageFailure();
  }
}

export async function listDeviceReceiptDrafts(
  userId: string,
): Promise<DeviceReceiptDraft[]> {
  const directory = ownerDirectory(userId);
  if (!directory.exists) return [];
  const records: DeviceReceiptDraft[] = [];
  for (const entry of directory.list()) {
    if (!(entry instanceof File) || !entry.name.endsWith(".json")) continue;
    const localId = entry.name.slice(0, -5);
    if (!draftPattern.test(localId)) continue;
    try {
      const record = await readDraft(userId, localId);
      if (record) records.push(record);
    } catch {
      // Do not let one incomplete/corrupt record hide the other receipts. Keep
      // the owned files in place so this function never destroys user data.
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveDeviceReceiptDraft(
  draft: DeviceReceiptDraft,
): Promise<void> {
  validated(draft, draft.userId, draft.localId);
  try {
    await serial(draft.userId + ":" + draft.localId, () => writeDraft(draft));
  } catch (error) {
    throw error instanceof Error && error.message === invalidDraft().message
      ? error
      : storageFailure();
  }
}

export async function removeDeviceReceiptDraft(
  userId: string,
  localId: string,
): Promise<void> {
  const owned = files(userId, localId);
  await serial(userId + ":" + localId, async () => {
    if (owned.metadata.exists) owned.metadata.delete();
    // An unsuccessful cache cleanup must not turn a completed server commit
    // into an apparent save failure. Only this private derived file is touched.
    try {
      if (owned.image.exists) owned.image.delete();
    } catch {}
  });
}
