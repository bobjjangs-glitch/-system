import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { recognizeReceipt, shutdownReceiptOcrPool } from "../imports.ts";

after(() => shutdownReceiptOcrPool());

test(
  "손상 사진과 과도한 해상도를 거절해도 OCR·API 프로세스가 살아 있고 다음 전표를 처리한다",
  { timeout: 30_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "bareun-ocr-regression-"));
    const appUrl = new URL("../app.ts", import.meta.url).href;
    const fixtureUrl = new URL("./fixtures/receipt.png", import.meta.url).href;
    const blankFixtureUrl = new URL(
      "./fixtures/blank-receipt.png",
      import.meta.url,
    ).href;
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
      const blank = await upload(await readFile(new URL(${JSON.stringify(blankFixtureUrl)})));
      assert.equal(blank.status, 422);
      assert.match(blank.data.error, /전표의 글자를 읽지 못했습니다/);
      assert.match(blank.data.error, /직접 입력/);
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
      assert.deepEqual(parallel.map(result => result.status), [201, 201]);
      assert.equal((await fetch(base + '/api/health')).status, 200);
      const imports = await fetch(base + '/api/imports', {
        headers: { Authorization: 'Bearer ' + session.token }
      }).then(response => response.json());
      assert.equal(imports.length, 3);
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
           process.on('message', (message) => {
             if (message.type === 'initialize') process.send({ type: 'ready' });
             if (message.type === 'recognize') {
               writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
               setInterval(() => {}, 1000);
             }
           });`,
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

function workerPid() {
  const children = execFileSync(
    "ps",
    ["--ppid", String(process.pid), "-o", "pid=,args="],
    { encoding: "utf8" },
  );
  const worker = children
    .split("\n")
    .find((line) => line.includes("/server/receiptOcrWorker.ts"));
  assert.ok(worker, "A warm OCR child should exist");
  return Number(worker.trim().split(/\s+/)[0]);
}

test(
  "연속 사진은 같은 OCR 엔진을 사용하고 세 장까지 FIFO로 처리한다",
  { timeout: 30_000 },
  async () => {
    await shutdownReceiptOcrPool();
    const image = await readFile(
      new URL("./fixtures/receipt.png", import.meta.url),
    );
    assert.match(await recognizeReceipt(image), /대전상사/);
    const pid = workerPid();
    assert.match(await recognizeReceipt(image), /생수/);
    assert.equal(
      workerPid(),
      pid,
      "Second photo must reuse its initialized model",
    );
    const order: number[] = [];
    const jobs = [1, 2, 3].map((index) =>
      recognizeReceipt(image).then((text) => {
        order.push(index);
        return text;
      }),
    );
    await assert.rejects(
      recognizeReceipt(image),
      (error: any) =>
        error.status === 429 && /대기 중인 전표/.test(error.message),
    );
    for (const text of await Promise.all(jobs)) assert.match(text, /DELIVERY/);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(workerPid(), pid);
  },
);

test(
  "대기 취소는 진행 중 전표를 방해하지 않고 진행 중 취소는 종료 후 다음 전표를 처리한다",
  { timeout: 30_000 },
  async () => {
    const image = await readFile(
      new URL("./fixtures/receipt.png", import.meta.url),
    );
    const originalPid = workerPid();
    const first = recognizeReceipt(image);
    const queuedAbort = new AbortController();
    const queued = recognizeReceipt(image, { signal: queuedAbort.signal });
    queuedAbort.abort();
    await assert.rejects(queued, (error: any) => error.status === 499);
    assert.match(await first, /DELIVERY/);
    assert.equal(workerPid(), originalPid);
    const activeAbort = new AbortController();
    const active = recognizeReceipt(image, { signal: activeAbort.signal });
    activeAbort.abort();
    await assert.rejects(active, (error: any) => error.status === 499);
    assert.throws(() => process.kill(originalPid, 0), { code: "ESRCH" });
    assert.match(await recognizeReceipt(image), /대전상사/);
    assert.notEqual(workerPid(), originalPid);
  },
);

test(
  "대기 시간이 지나면 무한 로딩 없이 해당 전표만 실패하고 다음 촬영을 허용한다",
  { timeout: 30_000 },
  async () => {
    const image = await readFile(
      new URL("./fixtures/receipt.png", import.meta.url),
    );
    const first = recognizeReceipt(image);
    const expired = recognizeReceipt(image, { queueTimeoutMs: 1 });
    await assert.rejects(
      expired,
      (error: any) => error.status === 408 && /앞선 전표/.test(error.message),
    );
    assert.match(await first, /DELIVERY/);
    assert.match(await recognizeReceipt(image), /생수/);
  },
);
