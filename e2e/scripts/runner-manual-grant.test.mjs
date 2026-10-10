import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const transport = fileURLToPath(
  new URL("../helpers/runner-chat.bash", import.meta.url),
);
const helper = fileURLToPath(
  new URL("../helpers/runner-api.bash", import.meta.url),
);

async function grant(t, error) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error,
        submittedValues: { apiToken: "private-input-value" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [
        "-c",
        'source "$1"; source "$2"; runner_e2e_connect_manual_connector zendesk api-token agent \'{"apiToken":"private-input-value"}\'',
        "test-grant",
        transport,
        helper,
      ],
      {
        env: {
          ...process.env,
          E2E_API_URL: `http://127.0.0.1:${address.port}`,
          E2E_API_TOKEN: "test-token",
          VERCEL_AUTOMATION_BYPASS_SECRET: "",
        },
        signal: t.signal,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { ...result, requests };
}

test("manual grant failures report public field requirements and keep the original failure", async (t) => {
  const result = await grant(t, {
    code: "BAD_REQUEST",
    message:
      "Unknown manual grant field(s). Expected: apiToken, email, subdomain",
  });
  assert.equal(result.code, 22);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /Manual connector grant failed: BAD_REQUEST: Unknown manual grant field\(s\)\. Expected: apiToken, email, subdomain/,
  );
  assert.equal(result.stderr.includes("private-input-value"), false);
  assert.deepEqual(result.requests, ["/api/connectors/zendesk/manual-grant"]);
});

test("manual grant diagnostics omit arbitrary error text and response values", async (t) => {
  const result = await grant(t, {
    code: "BAD_REQUEST",
    message: "Rejected private-input-value and secret-example",
  });
  assert.equal(result.code, 22);
  assert.match(result.stderr, /Manual connector grant failed: BAD_REQUEST/);
  assert.equal(result.stderr.includes("private-input-value"), false);
  assert.equal(result.stderr.includes("secret-example"), false);
  assert.equal(result.stdout, "");
});

test("manual grant diagnostics do not echo an unknown error code", async (t) => {
  const result = await grant(t, {
    code: "PRIVATE_SECRET",
    message: "Private service response",
  });
  assert.equal(result.code, 22);
  assert.match(result.stderr, /Manual connector grant failed: REQUEST_FAILED/);
  assert.equal(result.stderr.includes("PRIVATE_SECRET"), false);
});
