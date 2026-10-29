import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";

const [rawOrigin, rawSharedDir] = process.argv.slice(2);
if (!rawOrigin) {
  console.error(
    "사용법: node deploy/cafe24/prepare-env.mjs https://실제접속도메인 [데이터상위폴더]",
  );
  process.exit(1);
}
const url = new URL(rawOrigin);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
) {
  throw new Error("경로·계정정보가 없는 실제 HTTPS 접속 주소를 입력해 주세요.");
}
const sharedDir = resolve(rawSharedDir || "/opt/bareun_dispatch/shared");
const envFile = join(sharedDir, "server.env");
mkdirSync(sharedDir, { recursive: true, mode: 0o700 });
mkdirSync(join(sharedDir, "data"), { recursive: true, mode: 0o700 });
if (existsSync(envFile)) {
  console.log(`기존 환경 파일을 유지했습니다: ${envFile}`);
  process.exit(0);
}
const token = randomBytes(32).toString("hex");
const contents = [
  "NODE_ENV=production",
  "HOST=127.0.0.1",
  "PORT=4000",
  `APP_DATA_DIR=${JSON.stringify(join(sharedDir, "data"))}`,
  `CORS_ORIGINS=${url.origin}`,
  "TRUST_PROXY=loopback",
  `DISPATCH_BOOTSTRAP_TOKEN=${token}`,
  "KAKAO_REST_API_KEY=",
  "",
].join("\n");
writeFileSync(envFile, contents, { mode: 0o600, flag: "wx" });
console.log(`운영 환경 파일을 준비했습니다: ${envFile}`);
console.log(
  "최초 관리자 등록 코드는 위 비공개 파일에서 서버 소유자가 확인하세요. 코드 값은 로그에 출력하지 않았습니다.",
);
