import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const source = await readFile(
  new URL("../exec/chromium-https.mjs", import.meta.url),
  "utf8",
);

// An external Chromium/CDP peer. Events deliberately precede Page.navigate's
// reply, and responses use split pipe frames. The actual probe owns all parsing,
// assertions, browser lifetime and temporary-profile cleanup.
const peer = String.raw`
import assert from "node:assert/strict";
import { writeFileSync, writeSync } from "node:fs";
import { Socket } from "node:net";

const scenario = process.env.CHROMIUM_TEST_CASE;
assert.ok(!process.argv.some((arg) => arg.includes("ignore-certificate-errors")));
const profile = process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.split("=")[1];
assert.ok(profile, "browser needs an isolated profile");
writeFileSync(process.env.CHROMIUM_TEST_RECORD, JSON.stringify({profile, pid: process.pid}));
function send(message) {
  const frame = JSON.stringify(message) + "\0";
  writeSync(4, frame.slice(0, 5));
  writeSync(4, frame.slice(5));
}
function handle(message) {
  const reply = (result = {}) => send({id: message.id, result, sessionId: message.sessionId});
  switch (message.method) {
    case "Browser.getVersion": reply({product: "fixture-chromium"}); break;
    case "Target.createTarget": reply({targetId: "target"}); break;
    case "Target.attachToTarget": reply({sessionId: "session"}); break;
    case "Network.enable": reply(); break;
    case "Page.navigate": {
      if (scenario === "early-exit") process.exit(42);
      if (scenario === "cancel") {
        console.error("fixture: navigation is pending");
        return;
      }
      if (scenario === "certificate-error") {
        reply({errorText: "net::ERR_CERT_AUTHORITY_INVALID"});
        return;
      }
      send({method: "Network.responseReceived", sessionId: "unrelated-session", params: {}});
      send({method: "Network.responseReceived", sessionId: "session", params: {
        type: "Document", frameId: "frame", loaderId: "loader", requestId: "request",
        response: {url: message.params.url, status: scenario === "http-error" ? 503 : 200},
      }});
      send({method: scenario === "body-error" ? "Network.loadingFailed" : "Network.loadingFinished",
        sessionId: "session", params: {requestId: "request", errorText: "net::ERR_CONTENT_LENGTH_MISMATCH"}});
      reply({frameId: "frame", loaderId: "loader"});
      break;
    }
    case "Network.getResponseBody":
      reply({body: Buffer.from(scenario === "wrong-body" ? "unrelated page" : "User-agent: *").toString("base64"), base64Encoded: true});
      break;
    case "Browser.close":
      reply();
      process.exit(scenario === "shutdown-error" ? 42 : 0);
    default:
      throw new Error("unexpected browser command: " + message.method);
  }
}
let buffer = "";
for await (const chunk of new Socket({fd: 3, readable: true, writable: false}).setEncoding("utf8")) {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\0")) !== -1) {
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    handle(JSON.parse(frame));
  }
}
`;

async function runProbe(t, scenario, throughRunner = false) {
  const root = await mkdtemp(join(tmpdir(), "chromium-https-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "chromium");
  const record = join(root, "browser.json");
  await writeFile(binary, `#!${process.execPath}\n${peer}`);
  await chmod(binary, 0o755);
  if (scenario === "missing-browser") await rm(binary);
  const sudo = join(root, "sudo");
  await writeFile(
    sudo,
    `#!${process.execPath}\n
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const guest = args.slice(args.indexOf("--") + 1);
if (guest[0] === "timeout") {
  assert.deepEqual(args.slice(0, 7), ["/fake/bin/runner", "exec", "--timeout", "40", "--sandbox", "fixture-sandbox", "--"]);
  assert.deepEqual(guest.slice(0, 6), ["timeout", "--kill-after=5s", "30", "node", "--input-type=module", "--eval"]);
  const result = spawnSync(guest[0], guest.slice(1), {stdio: "inherit"});
  process.exit(result.status ?? 1);
}
`,
  );
  await chmod(sudo, 0o755);
  const probe = spawn(
    throughRunner ? "bash" : process.execPath,
    throughRunner
      ? [
          fileURLToPath(new URL("../exec/https.sh", import.meta.url)),
          "/fake/bin",
          "fixture-sandbox",
        ]
      : [
          "--input-type=module",
          "--eval",
          source,
          "https://fixture.test/robots.txt",
          "User-agent:",
        ],
    {
      env: {
        ...process.env,
        PATH:
          scenario === "missing-browser"
            ? root
            : `${root}${delimiter}${process.env.PATH}`,
        TMPDIR: root,
        CHROMIUM_TEST_CASE: scenario,
        CHROMIUM_TEST_RECORD: record,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = [];
  let stderr = "";
  let cancelRequested = false;
  probe.stdout.on("data", (chunk) => output.push(chunk));
  probe.stderr.on("data", (chunk) => {
    output.push(chunk);
    stderr += chunk.toString();
    if (
      scenario === "cancel" &&
      !cancelRequested &&
      stderr.includes("fixture: navigation is pending")
    ) {
      cancelRequested = true;
      probe.kill("SIGTERM");
    }
  });
  t.after(() => probe.kill("SIGKILL"));
  const code = await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.once("close", resolve);
  });
  if (scenario === "missing-browser") {
    assert.equal(existsSync(record), false);
    assert.ok(
      !(await readdir(root)).some((name) =>
        name.startsWith("vm0-chromium-https-"),
      ),
    );
    return { code, output: Buffer.concat(output).toString() };
  }
  const { profile, pid } = JSON.parse(await readFile(record, "utf8"));
  assert.equal(
    existsSync(profile),
    false,
    "temporary browser profile must be removed",
  );
  assert.throws(
    () => process.kill(pid, 0),
    { code: "ESRCH" },
    "browser must be reaped",
  );
  return { code, output: Buffer.concat(output).toString(), profile };
}

test(
  "HTTPS content arriving before the navigation reply succeeds and closes the browser",
  { timeout: 10000 },
  async (t) => {
    const first = await runProbe(t, "success");
    const second = await runProbe(t, "success");
    assert.equal(first.code, 0, first.output);
    assert.equal(second.code, 0, second.output);
    assert.notEqual(first.profile, second.profile);
    assert.match(first.output, /HTTP 200, expected text received/);
  },
);

for (const [scenario, diagnostic] of [
  ["certificate-error", "net::ERR_CERT_AUTHORITY_INVALID"],
  ["http-error", "HTTPS document must return HTTP 200"],
  ["body-error", "net::ERR_CONTENT_LENGTH_MISMATCH"],
  ["wrong-body", "HTTPS response is missing expected text"],
  ["early-exit", "Chromium debugging pipe closed"],
  ["missing-browser", "ENOENT"],
  ["shutdown-error", "Chromium exited with code 42"],
  ["cancel", "Chromium debugging pipe closed"],
]) {
  test(
    `probe fails and cleans up on ${scenario}`,
    { timeout: 10000 },
    async (t) => {
      const result = await runProbe(t, scenario);
      assert.equal(result.code, 1, result.output);
      assert.ok(result.output.includes(diagnostic), result.output);
    },
  );
}

test(
  "native scenario retains deadlines and propagates browser failure through Runner",
  { timeout: 10000 },
  async (t) => {
    const success = await runProbe(t, "success", true);
    assert.equal(success.code, 0, success.output);
    assert.match(success.output, /HTTPS chromium: ok/);
    const failure = await runProbe(t, "certificate-error", true);
    assert.equal(failure.code, 1, failure.output);
    assert.match(failure.output, /HTTPS chromium failed with exit code 1/);
    assert.match(failure.output, /net::ERR_CERT_AUTHORITY_INVALID/);
    assert.doesNotMatch(failure.output, /HTTPS java: ok/);
  },
);
