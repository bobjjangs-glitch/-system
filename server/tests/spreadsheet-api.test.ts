import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createDispatchApp } from "../app.ts";
test("기본 업로드 API가 전표별 매핑과 판매조회 자동 감지·검토 경고·중복 방지를 유지한다", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-xlsx-api-")),
    runtime = createDispatchApp({
      dataDir: dir,
      roadRouting: false,
      test: true,
    });
  t.after(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const base = "http://127.0.0.1:" + (runtime.server.address() as any).port;
  let token = "";
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
    });
    return { status: res.status, data: await res.json() };
  };
  token = (await call("/api/setup", { name: "검증 관리자", pin: "952713" }))
    .data.token;
  async function upload(rows: unknown[][]) {
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("배송");
    rows.forEach((row) => sheet.addRow(row));
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(await book.xlsx.writeBuffer())]),
      "delivery.xlsx",
    );
    form.append("serviceDate", "2026-11-05");
    return call("/api/imports", form);
  }
  const first = await upload([
    ["전표 목록"],
    [],
    ["전표번호", "거래처명", "배송주소", "주소", "품목명", "규격", "수량"],
    [
      "26/11/05-47",
      "예시 거래처",
      "대전 동구 검증로 1",
      "공급자 주소",
      "타이어",
      "205/55R16",
      2,
    ],
    [
      "26/11/05-48",
      "예시 거래처",
      "대전 동구 검증로 1",
      "공급자 주소",
      "다른 타이어",
      "205/55R16",
      3,
    ],
  ]);
  assert.equal(first.status, 201);
  assert.equal(first.data.drafts.length, 2);
  assert.equal(first.data.drafts[0].address, "대전 동구 검증로 1");
  assert.equal(first.data.drafts[0].items[0].name, "타이어 205/55R16");
  assert.ok(
    first.data.recognitionWarnings.some((w: string) => w.includes("3행")),
  );
  assert.equal(
    (
      await call("/api/imports/" + first.data.id + "/commit", {
        rows: first.data.drafts,
      })
    ).status,
    201,
  );
  const sales = await upload([
    ["판매번호", "거래처명", "배송주소", "품목명", "수량"],
    ["26/11/05-57", "판매조회 예시", "대전 서구 검증로 2", "물품", 1],
    ["26/11/06-58", "다른날", "대전 서구 검증로 2", "물품", 1],
  ]);
  assert.equal(sales.status, 201);
  assert.equal(sales.data.drafts.length, 1);
  assert.ok(sales.data.drafts[0].erpSourceKey);
  assert.ok(
    sales.data.recognitionWarnings.some((s: string) =>
      s.includes("판매조회 형식"),
    ),
  );
  assert.equal(
    (
      await call("/api/imports/" + sales.data.id + "/commit", {
        rows: sales.data.drafts,
      })
    ).status,
    201,
  );
  const dashboard = (await call("/api/dashboard?date=2026-11-05")).data;
  assert.equal(dashboard.shipments.length, 3);
  assert.ok(
    dashboard.shipments.every((s: any) => !s.address.includes("공급자")),
  );
  assert.equal(
    (
      await upload([
        ["판매번호", "거래처명", "배송주소", "품목명", "수량"],
        ["2026/11/05-57", "판매조회 예시", "대전 서구 검증로 2", "물품", 1],
      ])
    ).status,
    422,
  );
});
