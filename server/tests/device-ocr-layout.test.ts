import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchApp } from "../app.ts";
import type { ReceiptLayout, ReceiptLayoutLine } from "../../src/receiptText.ts";

// Synthetic table: raw block order places the specification before the name,
// while coordinates retain the correct quantity column beside the two prices.
const cell = (text: string, x: number, y: number, width: number): ReceiptLayoutLine => ({
  text, x, y, width, height: 0.025,
});
const layout: ReceiptLayout = {
  width: 1000,
  height: 1400,
  lines: [
    cell("거래처", 0.05, 0.08, 0.12),
    cell("가상정비소", 0.25, 0.08, 0.25),
    cell("배송주소", 0.05, 0.13, 0.12),
    cell("대전광역시 서구 배송예시로 99", 0.25, 0.13, 0.65),
    cell("전화", 0.05, 0.18, 0.12),
    cell("042-000-1234", 0.25, 0.18, 0.25),
    cell("품명", 0.05, 0.35, 0.2),
    cell("규격", 0.4, 0.35, 0.14),
    cell("수량", 0.65, 0.35, 0.05),
    cell("단가", 0.78, 0.35, 0.07),
    cell("금액", 0.9, 0.35, 0.08),
    cell("215/55R17", 0.4, 0.42, 0.15),
    cell("검증타이어", 0.05, 0.42, 0.25),
    cell("4", 0.65, 0.42, 0.04),
    cell("90000", 0.78, 0.42, 0.07),
    cell("360000", 0.9, 0.42, 0.08),
  ],
};
const rawText = layout.lines.map((line) => line.text).join("\n");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bareun-layout-api-"));
  const runtime = createDispatchApp({ dataDir: dir, roadRouting: false, test: true });
  const pin = String(randomInt(10000000, 99999999));
  runtime.store.createUser("admin", "위치 인식 검증 관리자", pin);
  const token = runtime.store.login(pin)!.token;
  const company = runtime.store.company();
  runtime.store.run("UPDATE settings SET value=? WHERE key='company'", JSON.stringify({
    ...company,
    name: "검증공급회사",
    address: "대전광역시 동구 공급예시로 1",
  }));
  const image = await readFile(new URL("./fixtures/receipt.png", import.meta.url));
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
  async function upload(receiptId: string, options: {
    layout?: unknown;
    encodedLayout?: string | string[];
    text?: string;
    source?: string | null;
  } = {}) {
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(image)], { type: "image/png" }), "receipt.png");
    if (options.source !== null) form.append("recognitionSource", options.source ?? "android-device");
    form.append("recognizedText", options.text ?? rawText);
    form.append("deviceReceiptId", receiptId);
    form.append("serviceDate", "2026-11-03");
    const encoded = options.encodedLayout ?? (options.layout === undefined ? undefined : JSON.stringify(options.layout));
    if (encoded !== undefined) for (const value of Array.isArray(encoded) ? encoded : [encoded])
      form.append("recognizedLayout", value);
    const response = await fetch(base + "/api/imports", {
      method: "POST", body: form, headers: { Authorization: "Bearer " + token },
    });
    return { status: response.status, data: await response.json() };
  }
  const counts = async () => ({
    imports: runtime.store.one("SELECT COUNT(*) AS count FROM imports").count,
    originals: (await readdir(join(dir, "uploads"))).length,
    shipments: runtime.store.one("SELECT COUNT(*) AS count FROM shipments").count,
  });
  return { runtime, dir, upload, counts, close: async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  } };
}

test("기기 OCR 표의 위치로 품명·규격·수량을 채워 검토 내역에 그대로 저장한다", async () => {
  const f = await fixture();
  try {
    const result = await f.upload("position-receipt", { layout });
    assert.equal(result.status, 201);
    assert.equal(result.data.rawText, rawText);
    const draft = result.data.drafts[0];
    assert.equal(draft.recipient, "가상정비소");
    assert.equal(draft.address, "대전광역시 서구 배송예시로 99");
    assert.equal(draft.phone, "042-000-1234");
    assert.equal(draft.items.length, 1);
    assert.match(draft.items[0].name, /검증타이어/);
    assert.match(draft.items[0].name, /215\/55R17/);
    assert.equal(draft.items[0].quantity, 4);
    assert.doesNotMatch(draft.items[0].name, /90000|360000/);
    const stored = f.runtime.store.one("SELECT rawText,drafts FROM imports WHERE id=?", result.data.id);
    assert.equal(stored.rawText, rawText);
    assert.deepEqual(JSON.parse(stored.drafts), result.data.drafts);
    assert.deepEqual(await f.counts(), { imports: 1, originals: 1, shipments: 0 });
  } finally { await f.close(); }
});

test("잘못된 위치 정보는 OCR 재시도 없이 거절하고 같은 요청의 정상 재전송은 허용한다", async () => {
  const f = await fixture();
  try {
    const malformed = [
      "{",
      "null",
      JSON.stringify({ ...layout, lines: [{ ...layout.lines[0], x: -0.1 }] }),
      JSON.stringify({ ...layout, lines: [{ ...layout.lines[0], width: 2 }] }),
      JSON.stringify({ ...layout, lines: Array.from({ length: 1001 }, () => layout.lines[0]) }),
      [JSON.stringify(layout), JSON.stringify(layout)],
    ];
    for (const encodedLayout of malformed) {
      const rejected = await f.upload("after-malformed", { encodedLayout });
      assert.equal(rejected.status, 422);
      assert.match(rejected.data.error, /전표 인식 위치 정보/);
    }
    assert.equal((await f.upload("missing-source", { layout, source: null })).status, 422);
    assert.deepEqual(await f.counts(), { imports: 0, originals: 0, shipments: 0 });
    const recovered = await f.upload("after-malformed", { layout });
    assert.equal(recovered.status, 201);
    assert.equal(recovered.data.drafts[0].items[0].quantity, 4);
    assert.deepEqual(await f.counts(), { imports: 1, originals: 1, shipments: 0 });
  } finally { await f.close(); }
});

test("같은 전표 요청은 정규화된 위치가 같을 때만 재사용하고 기존 위치 없는 요청도 유지한다", async () => {
  const f = await fixture();
  try {
    const first = await f.upload("layout-retry", { layout });
    assert.equal(first.status, 201);
    const reordered = { lines: layout.lines.map(({ text, x, y, width, height }) => ({ height, width, y, x, text })), height: 1400, width: 1000 };
    const retry = await f.upload("layout-retry", { layout: reordered });
    assert.equal(retry.status, 201);
    assert.equal(retry.data.id, first.data.id);
    const movedQuantity = { ...layout, lines: layout.lines.map((line) => line.text === "4" ? { ...line, x: 0.75 } : line) };
    assert.equal((await f.upload("layout-retry", { layout: movedQuantity })).status, 409);
    assert.equal((await f.upload("layout-retry")).status, 409);

    const textOnly = await f.upload("legacy-retry");
    const textRetry = await f.upload("legacy-retry");
    assert.equal(textOnly.status, 201);
    assert.equal(textRetry.data.id, textOnly.data.id);
    assert.equal((await f.upload("legacy-retry", { layout })).status, 409);
    assert.deepEqual(await f.counts(), { imports: 2, originals: 2, shipments: 0 });
  } finally { await f.close(); }
});

test("기기 OCR는 설정된 공급 회사 대신 배송받는 거래처와 주소를 선택한다", async () => {
  const f = await fixture();
  try {
    const result = await f.upload("supplier-context", { text: [
      "상호: 검증공급회사",
      "주소: 대전광역시 동구 공급예시로 1",
      "상호: 가상정비소",
      "주소: 대전광역시 서구 배송예시로 99",
      "품목: 검증타이어 4",
    ].join("\n") });
    assert.equal(result.status, 201);
    assert.equal(result.data.drafts[0].recipient, "가상정비소");
    assert.equal(result.data.drafts[0].address, "대전광역시 서구 배송예시로 99");
  } finally { await f.close(); }
});
