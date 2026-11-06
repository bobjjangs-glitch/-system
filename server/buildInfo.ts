import { readFileSync } from "node:fs";
const config = JSON.parse(
  readFileSync(new URL("../app.json", import.meta.url), "utf8"),
);
export const APP_VERSION: string = config.expo.version;
const value = process.env.RENDER_GIT_COMMIT ?? process.env.APP_REVISION ?? "";
export const APP_REVISION = /^[a-f0-9]{7,40}$/i.test(value)
  ? value.slice(0, 7)
  : null;
