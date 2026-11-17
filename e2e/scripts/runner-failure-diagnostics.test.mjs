import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runId = "9963a699-7ec1-4849-b745-0b85cd4286f7";
const secondRunId = "6963a699-7ec1-4849-b745-0b85cd4286f7";

async function fixture(t, scenario) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (/^\/api\/runs\/[0-9a-f-]+\/network\?/u.test(request.url)) {
      if (scenario === "unavailable") {
        response.writeHead(503).end("private-provider-response");
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            hasMore: true,
            networkLogs: [
              {
                type: "http",
                host: "api.replicate.com",
                method: "GET",
                status: 530,
                response_size: 5957,
                response_headers: {
                  "content-type": "text/html",
                  "set-cookie": "private-cookie",
                },
                response_body:
                  "Cloudflare Tunnel error 1033 private-provider-response",
                url: "https://api.replicate.com/v1/models?token=private-query",
                request_headers: { authorization: "Bearer private-credential" },
                error: "private-error-message",
              },
            ],
          }),
        );
      }
    } else if (
      (request.url === "/api/recover" &&
        requests.filter((url) => url === "/api/recover").length === 1) ||
      request.url === "/api/write-timeout"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .write("partial-response");
    } else if (request.url === "/api/recover") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"ok":true}');
    } else if (request.url.startsWith("/api/invalid")) {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<html>not JSON</html>");
    } else if (request.url === "/api/expected-forbidden") {
      response.writeHead(403, { "content-type": "application/json" }).end("{}");
    } else if (request.url.startsWith("/api/exact-body")) {
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end("\nRUNNER_API_CURL_METADATA:body content\n\n");
    } else {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ runId }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const directory = await mkdtemp(join(tmpdir(), "e2e-failure-diagnostics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "diagnostics.bats");
  await writeFile(
    path,
    `
load '${join(root, "helpers/setup")}'
load '${join(root, "helpers/runner-chat")}'
teardown() {
  runner_api_curl /api/cleanup >/dev/null
}
@test "shared failure diagnostics" {
  case "$SCENARIO" in
    expected)
      run runner_api_curl '/api/expected-forbidden#private-fragment'
      assert_failure
      refute_output --partial private-fragment
      ;;
    invalid)
      run runner_api_curl '/api/invalid?token=private-query#private-fragment'
      assert_success
      run jq -e . <<<"$output"
      assert_success
      ;;
    exact)
      # Avoid command substitution so trailing-newline preservation is observable.
      runner_api_curl /api/exact-body > "$BATS_TEST_TMPDIR/body"
      cmp "$BATS_TEST_TMPDIR/body" <(printf '\\nRUNNER_API_CURL_METADATA:body content\\n\\n')
      ;;
    custom-format)
      runner_api_curl /api/exact-body --write-out '\\n%{http_code}' > "$BATS_TEST_TMPDIR/body"
      cmp "$BATS_TEST_TMPDIR/body" <(printf '\\nRUNNER_API_CURL_METADATA:body content\\n\\n\\n200')
      ;;
    recover)
      run runner_api_curl /api/recover
      assert_success
      assert_output '{"ok":true}'
      ;;
    write-timeout)
      run runner_api_curl /api/write-timeout -X POST -d '{"value":"private-input"}'
      assert_equal "$status" 28
      assert_output --partial 'curl_exit":28'
      ;;
    multi)
      run runner_api_curl '/api/runs/${runId}'
      assert_success
      run runner_api_curl '/api/runs/${secondRunId}'
      assert_success
      false
      ;;
    *)
      run runner_api_curl '/api/runs/${runId}?token=private-query#private-fragment'
      assert_success
      false
      ;;
  esac
}
`,
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      join(root, "test/libs/bats/bin/bats"),
      ["--formatter", "tap", path],
      {
        env: {
          ...process.env,
          SCENARIO: scenario,
          E2E_API_URL: `http://127.0.0.1:${address.port}`,
          E2E_API_TOKEN: "private-credential",
          VERCEL_AUTOMATION_BYPASS_SECRET: "private-bypass",
          ...(["recover", "write-timeout"].includes(scenario)
            ? { E2E_CURL_MAX_TIME_SECONDS: "0.3" }
            : {}),
        },
        signal: t.signal,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  return { ...result, requests };
}

test("any Bats assertion failure reports its run's network before cleanup without body or credential leaks", async (t) => {
  const result = await fixture(t, "failure");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /E2E failure:.*exit=1/);
  assert.match(result.output, /"http_status":200/);
  assert.match(result.output, /"status":530/);
  assert.match(result.output, /"content_type":"text\/html"/);
  assert.match(result.output, /"response_size":5957/);
  assert.match(result.output, /"has_more":true/);
  assert.match(result.output, new RegExp(runId));
  assert.doesNotMatch(result.output, /private-|authorization|set-cookie/);
  assert.equal(
    result.requests.filter((url) => url.includes("/network?")).length,
    1,
  );
  assert.ok(result.requests.at(-2).includes("/network?"));
  assert.equal(result.requests.at(-1), "/api/cleanup");
});

test("invalid JSON from a successful API response retains status and content type in the shared failure report", async (t) => {
  const result = await fixture(t, "invalid");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /"http_status":200/);
  assert.match(result.output, /"content_type":"text\/html"/);
  assert.doesNotMatch(result.output, /private-query|private-fragment/);
});

test("unavailable diagnostics preserve the original failure and still run cleanup", async (t) => {
  const result = await fixture(t, "unavailable");
  assert.equal(result.code, 1, result.output);
  assert.match(
    result.output,
    /Runner diagnostics unavailable:.*request_failed/,
  );
  assert.doesNotMatch(result.output, /private-/);
  assert.equal(
    result.requests.filter((url) => url.includes("/network?")).length,
    1,
  );
  assert.equal(result.requests.at(-1), "/api/cleanup");
});

test("expected nonzero request outcomes do not trigger test failure diagnostics", async (t) => {
  const result = await fixture(t, "expected");
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /E2E failure:|Recent E2E API responses/);
  assert.deepEqual(result.requests, [
    "/api/expected-forbidden",
    "/api/cleanup",
  ]);
});

test("HTTP tracing preserves response bytes, trailing newlines and body marker text", async (t) => {
  const result = await fixture(t, "exact");
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /E2E failure:/);
});

test("caller-owned curl write-out formats and response marker text remain unchanged", async (t) => {
  const result = await fixture(t, "custom-format");
  assert.equal(result.code, 0, result.output);
});

test("a recovered GET timeout retains a clean final body and the existing attempt count", async (t) => {
  const result = await fixture(t, "recover");
  assert.equal(result.code, 0, result.output);
  assert.equal(
    result.requests.filter((url) => url === "/api/recover").length,
    2,
  );
});

test("a timed-out write retains its curl exit code and is never replayed", async (t) => {
  const result = await fixture(t, "write-timeout");
  assert.equal(result.code, 0, result.output);
  assert.equal(
    result.requests.filter((url) => url === "/api/write-timeout").length,
    1,
  );
});

test("multi-run failures collect each observed run without relying on a RUN_ID variable", async (t) => {
  const result = await fixture(t, "multi");
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, new RegExp(`"run_id":"${runId}"`));
  assert.match(result.output, new RegExp(`"run_id":"${secondRunId}"`));
  assert.equal(
    result.requests.filter((url) => url.includes("/network?")).length,
    2,
  );
  assert.equal(result.requests.at(-1), "/api/cleanup");
});
