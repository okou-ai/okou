// Runs inside the Guest via `node --input-type=module --eval <source> <url> <text>`.
// The caller owns the existing 30-second guest / 40-second Runner deadlines.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, expectedText] = process.argv.slice(1);
assert.equal(new URL(url).protocol, "https:");
assert.ok(expectedText, "expected HTTPS response text is required");

const profile = await mkdtemp(join(tmpdir(), "vm0-chromium-https-"));
const browser = spawn(
  "chromium",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--no-startup-window",
    "--remote-debugging-pipe",
    `--user-data-dir=${profile}`,
  ],
  { detached: true, stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] },
);
let launchError;
let interrupted;
let groupRetired = false;
const stopped = new Promise((resolve) => {
  browser.once("error", (error) => {
    launchError = error;
  });
  browser.once("close", (code, signal) => resolve({ code, signal }));
});

function stopBrowser() {
  if (browser.pid && !groupRetired) {
    try {
      // Retire this probe's entire process group on failure or cancellation.
      process.kill(-browser.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    groupRetired = true;
  }
}

const signalHandlers = new Map(
  ["SIGTERM", "SIGINT", "SIGHUP"].map((signal) => {
    const handler = () => {
      interrupted = signal;
      process.exitCode = 1;
      stopBrowser();
    };
    process.once(signal, handler);
    return [signal, handler];
  }),
);

async function* messages() {
  let buffer = "";
  for await (const chunk of browser.stdio[4].setEncoding("utf8")) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) !== -1) {
      const message = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      yield JSON.parse(message);
    }
  }
  throw new Error("Chromium debugging pipe closed", { cause: launchError });
}

// Keep events delivered before a command's reply: a fast document can finish
// loading before Page.navigate returns. No polling or delayed event subscription.
const incoming = messages();
const buffered = [];
async function receive(predicate) {
  const index = buffered.findIndex(predicate);
  if (index !== -1) return buffered.splice(index, 1)[0];
  for (;;) {
    const { value } = await incoming.next();
    if (predicate(value)) return value;
    buffered.push(value);
  }
}

let sequence = 0;
async function command(method, params = {}, sessionId) {
  const id = ++sequence;
  browser.stdio[3].write(
    JSON.stringify({ id, method, params, sessionId }) + "\0",
  );
  const message = await receive((item) => item.id === id);
  assert.ok(!message.error, `${method}: ${JSON.stringify(message.error)}`);
  return message.result;
}
browser.stdio[3].on("error", (error) => browser.stdio[4].destroy(error));

let phase = "launch";
try {
  const { product } = await command("Browser.getVersion");
  console.log(`Chromium HTTPS browser: ${product}`);
  const { targetId } = await command("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await command("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await command("Network.enable", {}, sessionId);
  phase = "navigation";
  const { frameId, loaderId, errorText } = await command(
    "Page.navigate",
    { url },
    sessionId,
  );
  assert.ok(!errorText, `HTTPS navigation failed: ${errorText}`);
  phase = "HTTPS response";
  const { params } = await receive(
    (item) =>
      item.sessionId === sessionId &&
      item.method === "Network.responseReceived" &&
      item.params.type === "Document" &&
      item.params.frameId === frameId &&
      item.params.loaderId === loaderId,
  );
  assert.equal(new URL(params.response.url).protocol, "https:");
  assert.equal(
    params.response.status,
    200,
    "HTTPS document must return HTTP 200",
  );
  const { requestId } = params;
  const finished = await receive(
    (item) =>
      item.sessionId === sessionId &&
      ["Network.loadingFinished", "Network.loadingFailed"].includes(
        item.method,
      ) &&
      item.params.requestId === requestId,
  );
  assert.equal(
    finished.method,
    "Network.loadingFinished",
    JSON.stringify(finished.params),
  );
  phase = "response body";
  const { body, base64Encoded } = await command(
    "Network.getResponseBody",
    { requestId },
    sessionId,
  );
  const text = base64Encoded
    ? Buffer.from(body, "base64").toString("utf8")
    : body;
  assert.ok(
    text.includes(expectedText),
    "HTTPS response is missing expected text",
  );
  console.log(`Chromium HTTPS response: HTTP 200, expected text received`);
  phase = "browser shutdown";
  // Close the browser directly, avoiding --dump-dom's Target.closeTarget path.
  await command("Browser.close");
  await incoming.return();
  browser.stdio[3].destroy();
  const { code, signal } = await stopped;
  assert.equal(code, 0, `Chromium exited with code ${code}, signal ${signal}`);
  assert.ok(!interrupted, `Chromium probe interrupted by ${interrupted}`);
} catch (error) {
  console.error(`Chromium HTTPS failed during ${phase}:`, launchError ?? error);
  process.exitCode = 1;
} finally {
  stopBrowser();
  await incoming.return();
  browser.stdio[3].destroy();
  await stopped;
  await rm(profile, { recursive: true, force: true });
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
