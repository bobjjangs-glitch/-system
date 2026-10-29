const path = require("node:path");

const appDir = path.resolve(__dirname, "../..");
const sharedDir =
  process.env.DISPATCH_SHARED_DIR || "/opt/bareun_dispatch/shared";

module.exports = {
  apps: [
    {
      name: "bareun-dispatch",
      cwd: appDir,
      script: process.execPath,
      interpreter: "none",
      args: [
        `--env-file=${path.join(sharedDir, "server.env")}`,
        "--use-env-proxy",
        "--experimental-strip-types",
        "server/index.ts",
      ],
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      restart_delay: 3000,
      min_uptime: "10s",
      max_restarts: 10,
      kill_timeout: 10000,
      time: true,
      env: { TZ: "Asia/Seoul" },
    },
  ],
};
