import { createDispatchApp } from "./app.ts";
const runtime = createDispatchApp();
const port = Number(process.env.PORT ?? 4000);
runtime.server.listen(port, process.env.HOST ?? "0.0.0.0", () =>
  console.log(`바른배차 서버가 ${port} 포트에서 실행 중입니다.`),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
