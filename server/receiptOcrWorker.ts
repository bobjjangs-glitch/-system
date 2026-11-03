// Retain one OCR engine across photos; no API/Excel module is loaded here.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { copyFile } from "node:fs/promises";
import { createWorker } from "tesseract.js";

let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
let initializing = false;
let busy = false;
process.once("disconnect", () => process.exit(0));
process.on("message", async (message: unknown) => {
  const input = message as {
    type?: string;
    id?: number;
    image?: Buffer;
    langDir?: string;
  } | null;
  if (input?.type === "initialize" && !initializing) {
    initializing = true;
    try {
      if (typeof input.langDir !== "string")
        throw new Error("Invalid OCR initialization");
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
        errorHandler: () => {},
      });
      process.send?.({ type: "ready" });
    } catch {
      process.send?.({ type: "failed" }, () => process.exit(1));
    }
  } else if (input?.type === "recognize") {
    const id = input.id;
    try {
      if (
        !worker ||
        busy ||
        !Buffer.isBuffer(input.image) ||
        !Number.isInteger(id)
      )
        throw new Error("Invalid OCR job");
      busy = true;
      const text = (await worker.recognize(input.image)).data.text;
      busy = false;
      process.send?.({ type: "result", id, text });
    } catch {
      // A bad decoder/job may corrupt its engine. Parent retires this child and
      // waits for its exit before sending the next queued photo to a fresh one.
      process.send?.({ type: "failed", id }, () => process.exit(1));
    }
  }
});
