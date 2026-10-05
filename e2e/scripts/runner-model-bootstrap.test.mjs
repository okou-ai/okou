import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mockCurl = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith("https://preview.example/"));
const methodIndex = args.indexOf("-X");
const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
const dataIndex = args.indexOf("-d");
const body = dataIndex < 0 ? null : JSON.parse(args[dataIndex + 1]);
const path = new URL(url).pathname;
fs.appendFileSync(process.env.REQUESTS, JSON.stringify({path, method, body, args}) + "\\n");
let response;
if (path === "/api/run-models" && method === "GET") {
  const models = [{model: "okou-1.0", defaultProviderType: "built-in", credentialScope: "org", modelProviderId: null}];
  if (process.env.PERSONAL === "true") {
    models.push({model: "claude-sonnet-5", defaultProviderType: "claude-code-oauth-token", credentialScope: "member"},
      {model: "gpt-6-astra", defaultProviderType: "codex-oauth-token", credentialScope: "member"});
  }
  response = {defaultModel: process.env.INVALID_AUTO === "true" ? "retired-model" : "okou-1.0", models};
} else if (path === "/api/feature-switches" && method === "POST") {
  response = {effectiveSwitches: body.switches};
} else if (path === "/api/user-model-preference" && method === "PUT") {
  response = body;
} else if (path === "/api/me/model-providers" && method === "POST") {
  response = {provider: {type: body.type}};
} else {
  process.stderr.write("Unsupported bootstrap request: " + method + " " + path);
  process.exit(1);
}
process.stdout.write(JSON.stringify(response));
`;

async function runBootstrap(context, script, args, environment = {}) {
  const directory = await mkdtemp(join(tmpdir(), "runner-model-bootstrap-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = join(directory, "credentials.json");
  const requests = join(directory, "requests.jsonl");
  await writeFile(
    credentials,
    JSON.stringify({
      token: "synthetic-e2e-token",
      apiUrl: "https://preview.example",
    }),
  );
  await writeFile(join(directory, "curl"), mockCurl, { mode: 0o755 });
  const path = fileURLToPath(
    new URL(`../playwright/${script}`, import.meta.url),
  );
  const result = spawnSync("bash", [path, credentials, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      REQUESTS: requests,
      VERCEL_AUTOMATION_BYPASS_SECRET: "synthetic-preview-bypass",
      ...environment,
    },
  });
  const calls = (await readFile(requests, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const call of calls) {
    assert(call.args.includes("Authorization: Bearer synthetic-e2e-token"));
    assert(
      call.args.includes(
        "x-vercel-protection-bypass: synthetic-preview-bypass",
      ),
    );
  }
  return { result, calls };
}

for (const realAgent of ["true", "false"]) {
  test(`Auto bootstrap selects the preset model with real runtime ${realAgent}`, async (context) => {
    const { result, calls } = await runBootstrap(
      context,
      "runner-auto-bootstrap.bash",
      [realAgent],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      calls.map(({ path, method, body }) => ({ path, method, body })),
      [
        { path: "/api/run-models", method: "GET", body: null },
        {
          path: "/api/user-model-preference",
          method: "PUT",
          body: { selectedModel: "okou-1.0", serviceTier: null },
        },
        {
          path: "/api/feature-switches",
          method: "POST",
          body: { switches: { _realAgentInPreview: realAgent === "true" } },
        },
      ],
    );
  });
}

test("Auto bootstrap rejects an unexpected default before writing preferences", async (context) => {
  const { result, calls } = await runBootstrap(
    context,
    "runner-auto-bootstrap.bash",
    ["true"],
    { INVALID_AUTO: "true" },
  );
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    calls.map(({ method, path }) => ({ method, path })),
    [{ method: "GET", path: "/api/run-models" }],
  );
});

test("mock bootstrap provisions both personal subscriptions without organization APIs", async (context) => {
  const { result, calls } = await runBootstrap(
    context,
    "runner-mock-claude-bootstrap.bash",
    [],
    { PERSONAL: "true" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls.map(({ method, path }) => ({ method, path })),
    [
      { method: "POST", path: "/api/feature-switches" },
      { method: "POST", path: "/api/me/model-providers" },
      { method: "POST", path: "/api/me/model-providers" },
      { method: "GET", path: "/api/run-models" },
    ],
  );
  assert.deepEqual(calls[0].body, { switches: { _realAgentInPreview: false } });
  assert.deepEqual(calls[1].body, {
    type: "claude-code-oauth-token",
    secret: "mock-oauth-token-for-e2e",
  });
  assert.equal(calls[2].body.type, "codex-oauth-token");
  assert.equal(calls[2].body.authMethod, "auth_json");
  const auth = JSON.parse(calls[2].body.secrets.CODEX_AUTH_JSON);
  assert.equal(auth.OPENAI_API_KEY, null);
  assert.equal(auth.tokens.account_id, "e2e-mock-codex");
  const claims = JSON.parse(
    Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString(),
  );
  assert.equal(
    claims["https://api.openai.com/auth"].chatgpt_account_id,
    "e2e-mock-codex",
  );
  assert.equal(claims["https://api.openai.com/auth"].chatgpt_plan_type, "plus");
});
