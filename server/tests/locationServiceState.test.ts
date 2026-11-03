import test from "node:test";
import assert from "node:assert/strict";
import { waitForLocationService } from "../../src/locationServiceState.ts";

test("waits for actual foreground promotion instead of task registration", async () => {
  const states = ["stopped", "starting", "running"];
  let waits = 0;
  await waitForLocationService(
    async () => states.shift()!,
    () => {},
    async () => { waits++; },
  );
  assert.equal(waits, 2);
});

test("Android service rejection becomes a recoverable startup error", async () => {
  await assert.rejects(
    waitForLocationService(
      async () => "failed:SecurityException",
      () => {},
      async () => { throw new Error("must not keep waiting"); },
    ),
    /Android가/,
  );
});

test("a stalled service times out without reporting successful sharing", async () => {
  let attempts = 0;
  await assert.rejects(
    waitForLocationService(
      async () => { attempts++; return "starting"; },
      () => {},
      async () => {},
    ),
    /시작하지 못했습니다/,
  );
  assert.equal(attempts, 32);
});

test("logout while a native probe resolves cannot mark sharing as running", async () => {
  let cancelled = false;
  await assert.rejects(
    waitForLocationService(
      async () => { cancelled = true; return "running"; },
      () => { if (cancelled) throw new Error("cancelled"); },
      async () => {},
    ),
    /cancelled/,
  );
});
