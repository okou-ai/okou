import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";

import { build } from "esbuild";

const apiRoot = resolve(import.meta.dirname, "..");
const { outputFiles } = await build({
  stdin: {
    contents: `const pg = require("pg"); const email = require("@react-email/render"); module.exports = { pg, email };`,
    resolveDir: apiRoot,
  },
  platform: "node",
  format: "cjs",
  bundle: true,
  write: false,
  alias: {
    "pg-native": resolve(apiRoot, "src/worker-unsupported-pg-native.ts"),
    "@react-email/render": resolve(
      apiRoot,
      "src/worker-unsupported-react-email.ts",
    ),
  },
});
const runtimeRequire = createRequire(import.meta.url);
function load(forceNative = false) {
  const module = { exports: {} };
  // Isolate pg's native-selection input without changing the test process env.
  const runtimeProcess = {
    ...process,
    env: { ...process.env, NODE_PG_FORCE_NATIVE: forceNative ? "1" : "" },
  };
  new Function("require", "module", "exports", "process", outputFiles[0].text)(
    runtimeRequire,
    module,
    module.exports,
    runtimeProcess,
  );
  return module.exports;
}

test("Worker pg shim preserves real JS client initialization without connecting", () => {
  const { pg } = load();
  const client = new pg.Client();
  assert.equal(typeof client.query, "function");
  assert.ok(client.connection);
  assert.equal(client._connected, false);
  // Reading the lazy branch is also safe; only native construction fails.
  assert.throws(() => {
    return new pg.native.Client();
  }, /pg-native\/libpq is unsupported.*JavaScript.*NODE_PG_FORCE_NATIVE/);
});

test("forced native selection fails actionably on client construction, not startup", () => {
  const { pg } = load(true);
  assert.throws(() => {
    return new pg.Client();
  }, /pg-native\/libpq is unsupported/);
});

test("optional React renderer initializes safely and never fabricates email HTML", () => {
  const { email } = load();
  assert.throws(() => {
    return email.render();
  }, /Supply pre-rendered html\/text to Resend/);
});
