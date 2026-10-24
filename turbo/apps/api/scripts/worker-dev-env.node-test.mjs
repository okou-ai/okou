import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { serializeWorkerDevVars } from "./worker-dev-env.mjs";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { parse: parseWranglerDotenv } = wranglerRequire("dotenv");

for (const [name, parse] of [
  ["Wrangler dotenv", parseWranglerDotenv],
  ["Node parseEnv", parseEnv],
]) {
  test(`${name} preserves packed API settings with literal secret characters`, () => {
    const environment = {
      ENV: "development",
      DATABASE_URL: "postgresql://local:test@127.0.0.1:5432/local",
      EMPTY: "",
      QUOTES: `apostrophe ' and double quote " and backtick \``,
      LINES: "first\nsecond\r\nthird",
      LITERALS: "\\n\\r\\u0027\\u2028\\\\",
      SHELL: `\${HOME} $value $(echo unused) # comment ; & |`,
      UNICODE: "中文 — 🚀",
      PADDING: " before and after ",
    };
    const encoded = serializeWorkerDevVars(environment);
    const parsed = parse(encoded);
    assert.equal(parsed.API_ENV_JSON_PARTS, "1");
    assert.deepEqual(JSON.parse(parsed.API_ENV_JSON_0), environment);
    assert.equal(encoded.split("\n").length, 3);
    assert.deepEqual(Object.keys(parsed).sort(), [
      "API_ENV_JSON_0",
      "API_ENV_JSON_PARTS",
    ]);
  });
}
