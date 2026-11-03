// Keep this process limited to OCR; loading the API/Excel workbook module here
// would duplicate their memory in Render's small test instance.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { copyFile } from "node:fs/promises";
import { createWorker } from "tesseract.js";

let finished = false;
process.once("disconnect", () => {
  if (!finished) process.exit(1);
});
process.once("message", async (message: unknown) => {
  const input = message as { image?: Buffer; langDir?: string } | null;
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let result: { type: "result"; text: string } | { type: "failed" } = {
    type: "failed",
  };
  try {
    if (!Buffer.isBuffer(input?.image) || typeof input?.langDir !== "string")
      throw new Error("Invalid OCR job");
    const require = createRequire(import.meta.url);
    await Promise.all(
      ["kor", "eng"].map((code) => {
        const packageDir = dirname(
          require.resolve("@tesseract.js-data/" + code + "/package.json"),
        );
        return copyFile(
          join(packageDir, "4.0.0_best_int", code + ".traineddata.gz"),
          join(input.langDir!, code + ".traineddata.gz"),
        );
      }),
    );
    worker = await createWorker("kor+eng", 1, {
      langPath: input.langDir,
      cacheMethod: "none",
      gzip: true,
      // Without this handler Tesseract also throws from a message event, even
      // though recognize() rejects. Never log image content or raw OCR output.
      errorHandler: () => {},
    });
    result = {
      type: "result",
      text: (await worker.recognize(input.image)).data.text,
    };
  } catch {
    result = { type: "failed" };
  } finally {
    // Await actual Node thread exit rather than the wrapper's immediate Promise.
    const nativeWorker = (
      worker as unknown as
        | {
            worker?: { terminate?: () => Promise<unknown> };
          }
        | undefined
    )?.worker;
    await nativeWorker?.terminate?.();
    await worker?.terminate();
  }
  process.send?.(result, () => {
    finished = true;
    process.exitCode = result.type === "result" ? 0 : 1;
    if (process.connected) process.disconnect();
  });
});
process.send?.({ type: "ready" });
