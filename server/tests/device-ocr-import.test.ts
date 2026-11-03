import { test, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchApp } from "../app.ts";
import { recognizeReceipt, shutdownReceiptOcrPool } from "../imports.ts";
import { parseReceipt } from "../../src/receiptText.ts";

after(() => shutdownReceiptOcrPool());

const recognizedText =
  "거래처: 대전상사\n배송주소: 대전광역시 동구 중앙로 215\n전화: 010-1234-5678\n품목: 생수 2\n품목: 타이어 4";

function ocrPids(): string[] {
  try {
    return execFileSync(
      "ps",
      ["--ppid", String(process.pid), "-o", "pid=,args="],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line.includes("/server/receiptOcrWorker.ts"))
      .map((line) => line.trim().split(/\s+/)[0]);
  } catch {
    return [];
  }
}

test(
  "기기에서 읽은 전표는 서버 OCR 없이 즉시 검토로 저장하고 원본·텍스트·내역을 보존한다",
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bareun-device-ocr-"));
    const runtime = createDispatchApp({
      dataDir: dir,
      roadRouting: false,
      test: true,
    });
    const adminPin = String(randomInt(10000000, 99999999));
    const driverPin = String(randomInt(10000000, 99999999));
    runtime.store.createUser("admin", "기기 인식 검증 관리자", adminPin);
    runtime.store.createUser("driver", "권한 검증 기사", driverPin);
    const admin = runtime.store.login(adminPin)!;
    const driver = runtime.store.login(driverPin)!;
    const image = await readFile(
      new URL("./fixtures/receipt.png", import.meta.url),
    );
    runtime.server.listen(0, "127.0.0.1");
    await once(runtime.server, "listening");
    const base =
      "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
    async function upload(
      fields: Record<string, string | string[]> = {
        recognitionSource: "android-device",
        recognizedText,
      },
      options: { token?: string; bytes?: Buffer; name?: string } = {},
    ) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([Uint8Array.from(options.bytes ?? image)], {
          type: "image/png",
        }),
        options.name ?? "receipt.png",
      );
      form.append("serviceDate", "2026-11-03");
      for (const [key, value] of Object.entries(fields)) {
        for (const part of Array.isArray(value) ? value : [value])
          form.append(key, part);
      }
      const token = options.token ?? admin.token;
      const response = await fetch(base + "/api/imports", {
        method: "POST",
        body: form,
        headers: token ? { Authorization: "Bearer " + token } : {},
      });
      return { status: response.status, data: await response.json() };
    }
    const read = async (path: string) => {
      const response = await fetch(base + path, {
        headers: { Authorization: "Bearer " + admin.token },
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    try {
      await shutdownReceiptOcrPool();
    const dashboard = await read("/api/dashboard?date=2026-11-03");
    assert.deepEqual(dashboard.receiptCapabilities, {
      deviceText: true,
      maxTextLength: 50_000,
    });
      assert.deepEqual(ocrPids(), []);
      const result = await upload();
      assert.equal(result.status, 201);
      assert.deepEqual(
        ocrPids(),
        [],
        "Device text must not start a server OCR process",
      );
      assert.equal(result.data.rawText, recognizedText);
      assert.deepEqual(result.data.drafts, [parseReceipt(recognizedText)]);
      assert.equal(result.data.status, "review");
      assert.equal(
        runtime.store.shipments("2026-11-03").length,
        0,
        "Recognition never commits shipments automatically",
      );
      const stored = await read("/api/imports/" + result.data.id);
      assert.equal(stored.rawText, recognizedText);
      assert.deepEqual(stored.drafts, result.data.drafts);
      const original = await read(
        "/api/imports/" + result.data.id + "/original",
      );
      const downloaded = await fetch(base + original.path);
      assert.equal(downloaded.status, 200);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), image);
      assert.equal((await read("/api/imports?date=2026-11-03")).length, 1);

      // Fill the ordinary server OCR worker and both waiting slots. A device OCR
      // upload must still bypass that queue and succeed instead of returning 429.
      const ordinaryJobs = [
        recognizeReceipt(image),
        recognizeReceipt(image),
        recognizeReceipt(image),
      ];
      const activePid = ocrPids();
      assert.equal(activePid.length, 1);
      try {
        const bypass = await upload();
        assert.equal(bypass.status, 201);
        assert.equal(bypass.data.rawText, recognizedText);
        assert.deepEqual(ocrPids(), activePid);
      } finally {
        await Promise.all(ordinaryJobs);
      }

      // Legacy clients without device text retain the existing real OCR path.
      const legacy = await upload({});
      assert.equal(legacy.status, 201);
      assert.match(legacy.data.rawText, /DELIVERY/i);
      assert.match(legacy.data.rawText, /생수/);

      const count = (await read("/api/imports")).length;
      const invalidFields: Record<string, string | string[]>[] = [
        { recognitionSource: "android-device" },
        { recognizedText },
        { recognitionSource: "unknown", recognizedText },
        { recognitionSource: "android-device", recognizedText: "   \n" },
        {
          recognitionSource: "android-device",
          recognizedText: "가".repeat(50_001),
        },
        {
          recognitionSource: "android-device",
          recognizedText: [recognizedText, recognizedText],
        },
      ];
      for (const fields of invalidFields)
        assert.equal((await upload(fields)).status, 422);
      assert.equal(
        (await upload(undefined, { bytes: Buffer.from("not an image") }))
          .status,
        422,
      );
      const tooLarge = Buffer.from(image);
      tooLarge.writeUInt32BE(8176, 16);
      tooLarge.writeUInt32BE(6144, 20);
      assert.equal((await upload(undefined, { bytes: tooLarge })).status, 413);
      assert.equal(
        (
          await upload(undefined, {
            name: "deliveries.csv",
            bytes: Buffer.from(
              "수령인,주소,품목,수량\n가게,대전 동구 중앙로 215,생수,2",
            ),
          })
        ).status,
        422,
      );
      const csv = await upload(
        {},
        {
          name: "deliveries.csv",
          bytes: Buffer.from(
            "수령인,주소,품목,수량\n가게,대전 동구 중앙로 215,생수,2",
          ),
        },
      );
      assert.equal(csv.status, 201);
      assert.equal(csv.data.drafts[0].items[0].quantity, 2);
      assert.equal((await upload(undefined, { token: "" })).status, 401);
      assert.equal(
        (await upload(undefined, { token: driver.token })).status,
        403,
      );
      assert.equal((await read("/api/imports")).length, count + 1);
      assert.equal((await fetch(base + "/api/health")).status, 200);
    } finally {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
