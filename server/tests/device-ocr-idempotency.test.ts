import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchApp } from "../app.ts";

const text =
  "거래처: 대전상사\n배송주소: 대전광역시 동구 중앙로 215\n품목: 생수 2";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bareun-device-retry-"));
  const runtime = createDispatchApp({
    dataDir: dir,
    roadRouting: false,
    test: true,
  });
  const pins = [
    String(randomInt(10000000, 49999999)),
    String(randomInt(50000000, 99999999)),
  ];
  const tokens = pins.map((pin, i) => {
    runtime.store.createUser("admin", "재시도 검증 " + i, pin);
    return runtime.store.login(pin)!.token;
  });
  const image = await readFile(
    new URL("./fixtures/receipt.png", import.meta.url),
  );
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base =
    "http://127.0.0.1:" + (runtime.server.address() as { port: number }).port;
  async function upload(
    who: number,
    receiptId?: string,
    changes: { text?: string; bytes?: Buffer; date?: string } = {},
  ) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(changes.bytes ?? image)], {
        type: "image/png",
      }),
      "receipt.png",
    );
    form.append("recognitionSource", "android-device");
    form.append("recognizedText", changes.text ?? text);
    form.append("serviceDate", changes.date ?? "2026-11-03");
    if (receiptId !== undefined) form.append("deviceReceiptId", receiptId);
    const response = await fetch(base + "/api/imports", {
      method: "POST",
      body: form,
      headers: { Authorization: "Bearer " + tokens[who] },
    });
    return { status: response.status, data: await response.json() };
  }
  async function commit(
    who: number,
    importId: string,
    receiptId: string,
    rows: unknown,
  ) {
    const response = await fetch(
      base + "/api/imports/" + importId + "/commit",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + tokens[who],
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rows, deviceReceiptId: receiptId }),
      },
    );
    return { status: response.status, data: await response.json() };
  }
  const counts = async () => ({
    imports: runtime.store.one("SELECT COUNT(*) AS count FROM imports").count,
    shipments: runtime.store.one("SELECT COUNT(*) AS count FROM shipments")
      .count,
    originals: (await readdir(join(dir, "uploads"))).length,
  });
  return {
    runtime,
    dir,
    image,
    upload,
    commit,
    counts,
    close: async () => {
      await runtime.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("기기 전표 업로드·배송지 저장 응답이 유실되어 다시 보내도 원본·내역·배송지를 중복 생성하지 않는다", async () => {
  const f = await fixture();
  try {
    const first = await f.upload(0, "lost-response-1");
    assert.equal(first.status, 201);
    const retries = await Promise.all([
      f.upload(0, "lost-response-1"),
      f.upload(0, "lost-response-1"),
    ]);
    for (const retry of retries) {
      assert.equal(retry.status, 201);
      assert.equal(retry.data.id, first.data.id);
    }
    assert.deepEqual(await f.counts(), {
      imports: 1,
      originals: 1,
      shipments: 0,
    });
    const rows = first.data.drafts.map((row: any) => ({
      ...row,
      notes: "관리자 확인 후 저장",
    }));
    const commits = await Promise.all([
      f.commit(0, first.data.id, "lost-response-1", rows),
      f.commit(0, first.data.id, "lost-response-1", rows),
    ]);
    for (const result of commits) {
      assert.equal(result.status, 201);
      assert.equal(result.data.count, 1);
    }
    assert.deepEqual(await f.counts(), {
      imports: 1,
      originals: 1,
      shipments: 1,
    });
    const afterCommit = await f.upload(0, "lost-response-1");
    assert.equal(afterCommit.status, 201);
    assert.equal(afterCommit.data.id, first.data.id);
    assert.equal(afterCommit.data.status, "committed");
    assert.equal(afterCommit.data.drafts[0].notes, "관리자 확인 후 저장");
    assert.equal(
      (
        await f.commit(0, first.data.id, "lost-response-1", [
          { ...rows[0], items: [{ name: "생수", quantity: 3 }] },
        ])
      ).status,
      409,
    );
    assert.equal(
      (await f.upload(0, "lost-response-1", { text: text + "\n추가 정보" }))
        .status,
      409,
    );
    assert.equal(
      (await f.upload(0, "lost-response-1", { date: "2026-11-04" })).status,
      409,
    );
    const otherImage = await readFile(
      new URL("./fixtures/blank-receipt.png", import.meta.url),
    );
    assert.equal(
      (await f.upload(0, "lost-response-1", { bytes: otherImage })).status,
      409,
    );
    assert.deepEqual(await f.counts(), {
      imports: 1,
      originals: 1,
      shipments: 1,
    });
  } finally {
    await f.close();
  }
});

test("기기 전표 번호는 관리자별로 구분하고 삭제된 매핑·기존 무번호 요청을 호환한다", async () => {
  const f = await fixture();
  try {
    const first = await f.upload(0, "same-local-id");
    const other = await f.upload(1, "same-local-id");
    assert.equal(first.status, 201);
    assert.equal(other.status, 201);
    assert.notEqual(first.data.id, other.data.id);
    assert.equal(
      (await f.commit(1, first.data.id, "same-local-id", first.data.drafts))
        .status,
      409,
    );
    assert.deepEqual(await f.counts(), {
      imports: 2,
      originals: 2,
      shipments: 0,
    });
    const old = f.runtime.store.one(
      "SELECT storedName FROM imports WHERE id=?",
      first.data.id,
    );
    f.runtime.store.run("DELETE FROM imports WHERE id=?", first.data.id);
    await rm(join(f.dir, "uploads", old.storedName));
    const fresh = await f.upload(0, "same-local-id", {
      text: text + "\n다시 저장",
    });
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.data.id, first.data.id);
    assert.equal(
      (await f.upload(0, "same-local-id", { text: text + "\n다시 저장" })).data
        .id,
      fresh.data.id,
    );
    const unnumberedA = await f.upload(0);
    const unnumberedB = await f.upload(0);
    assert.equal(unnumberedA.status, 201);
    assert.equal(unnumberedB.status, 201);
    assert.notEqual(unnumberedA.data.id, unnumberedB.data.id);
    assert.equal((await f.upload(0, "")).status, 422);
    assert.equal((await f.upload(0, "x".repeat(129))).status, 422);
    assert.deepEqual(await f.counts(), {
      imports: 4,
      originals: 4,
      shipments: 0,
    });
  } finally {
    await f.close();
  }
});
