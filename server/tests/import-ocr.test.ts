import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { recognizeReceipt } from "../imports.ts";

test(
  "손상 사진과 과도한 해상도를 거절해도 OCR·API 프로세스가 살아 있고 다음 전표를 처리한다",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bareun-ocr-regression-"));
    const appUrl = new URL("../app.ts", import.meta.url).href;
    const fixtureUrl = new URL("./fixtures/receipt.png", import.meta.url).href;
    const script = `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    import { once } from 'node:events';
    import { randomInt } from 'node:crypto';
    import { createDispatchApp } from ${JSON.stringify(appUrl)};
    const runtime = createDispatchApp({ dataDir: ${JSON.stringify(dir)}, roadRouting: false, test: true });
    const pin = String(randomInt(10000000, 99999999));
    runtime.store.createUser('admin', 'OCR 검증 관리자', pin);
    const session = runtime.store.login(pin);
    const image = await readFile(new URL(${JSON.stringify(fixtureUrl)}));
    try {
      runtime.server.listen(0, '127.0.0.1');
      await once(runtime.server, 'listening');
      const base = 'http://127.0.0.1:' + runtime.server.address().port;
      async function upload(bytes, name = 'receipt.png') {
        const form = new FormData();
        form.append('file', new Blob([bytes], { type: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }), name);
        const response = await fetch(base + '/api/imports', {
          method: 'POST', body: form, headers: { Authorization: 'Bearer ' + session.token }
        });
        return { status: response.status, data: await response.json() };
      }
      // Keep a valid PNG/IHDR so the corrupt image reaches the real OCR decoder.
      // Previously its rejected worker message threw outside Express and killed Node.
      const corrupt = await upload(image.subarray(0, 40));
      assert.equal(corrupt.status, 422);
      assert.match(corrupt.data.error, /전표 사진을 읽지 못했습니다/);
      assert.equal((await fetch(base + '/api/health')).status, 200);
      const oversized = Buffer.from(image);
      oversized.writeUInt32BE(8176, 16);
      oversized.writeUInt32BE(6144, 20);
      const rejected = await upload(oversized);
      assert.equal(rejected.status, 413);
      assert.match(rejected.data.error, /해상도/);
      const largeJpeg = Buffer.from([255,216,255,192,0,17,8,24,0,31,240,3,1,17,0,2,17,0,3,17,0]);
      assert.equal((await upload(largeJpeg, 'camera.jpg')).status, 413);
      const valid = await upload(image);
      assert.equal(valid.status, 201);
      assert.match(valid.data.rawText, /DELIVERY/i);
      assert.equal(valid.data.drafts[0].items[0].quantity, 2);
      const parallel = await Promise.all([upload(image), upload(image)]);
      assert.deepEqual(parallel.map(result => result.status).sort(), [201, 429]);
      assert.match(parallel.find(result => result.status === 429).data.error, /다른 전표/);
      assert.equal((await fetch(base + '/api/health')).status, 200);
      const imports = await fetch(base + '/api/imports', {
        headers: { Authorization: 'Bearer ' + session.token }
      }).then(response => response.json());
      assert.equal(imports.length, 2);
      console.log('PROCESS_SURVIVED_OCR_ERROR_AND_RECOVERED');
    } finally {
      await runtime.close();
    }
  `;
    try {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        { timeout: 25_000, maxBuffer: 1024 * 1024 },
      );
      assert.match(stdout, /PROCESS_SURVIVED_OCR_ERROR_AND_RECOVERED/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "OCR 초기화 또는 인식이 멈추면 자식 프로세스를 종료하고 다음 전표를 처리한다",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bareun-ocr-deadline-"));
    const image = await readFile(
      new URL("./fixtures/receipt.png", import.meta.url),
    );
    try {
      for (const phase of ["startup", "recognition"]) {
        const script = join(dir, phase + ".mjs");
        const pidFile = join(dir, phase + ".pid");
        await writeFile(
          script,
          phase === "startup"
            ? "setInterval(() => {}, 1000);"
            : `import { writeFileSync } from 'node:fs';
           process.once('message', () => {
             writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
             setInterval(() => {}, 1000);
           });
           process.send({ type: 'ready' });`,
        );
        const start = performance.now();
        await assert.rejects(
          recognizeReceipt(image, {
            workerUrl: pathToFileURL(script),
            timeoutMs: 1000,
          }),
          (error: any) =>
            error.status === 408 && /인식 시간이 초과/.test(error.message),
        );
        assert.ok(performance.now() - start < 10_000);
        if (phase === "recognition") {
          const childPid = Number(await readFile(pidFile, "utf8"));
          assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
        }
        // Completion of the deadline must release the admission lock and memory.
        assert.match(await recognizeReceipt(image), /DELIVERY/i);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
