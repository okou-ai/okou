import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
  new URL("../helpers/runner-chat.bash", import.meta.url),
);
const threadId = "output-test-thread";
const runId = "output-test-run";
const steerEventId = "output-test-steer";
const steerPrompt = "Reply with only the word: STEER_OK";
const successorSource = {
  providerType: "built-in",
  runtimeProviderType: "openrouter-codex",
  model: "auto",
  credentialScope: "org",
};
const privateSentinel = "private-value-not-for-diagnostics";

const completion = { eventType: "run.completed", runId };
const consumedSteer = {
  eventType: "input.prompt",
  runId,
  revokesEventId: steerEventId,
  payload: { userMessage: { parts: [{ type: "text", text: steerPrompt }] } },
};

function message(content, messageRunId = runId) {
  return {
    eventType: "output.message",
    runId: messageRunId,
    payload: { content },
  };
}

async function waitForOutput(
  context,
  snapshots,
  { steer = false, successor = false, expected = "STEER_OK" } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "runner-chat-output-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const responses = join(directory, "responses.json");
  const counter = join(directory, "counter");
  const requests = join(directory, "requests.json");
  const send = join(directory, "send.json");
  await writeFile(
    responses,
    JSON.stringify(snapshots.map((rows) => ({ rows }))),
  );
  // Control only the external curl response. Source and execute the real helpers.
  await writeFile(
    join(directory, "curl"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const url = new URL(args.find((arg) => arg.startsWith("https://preview.example/api/")));
const requests = fs.existsSync(process.env.REQUESTS)
  ? JSON.parse(fs.readFileSync(process.env.REQUESTS, "utf8")) : [];
requests.push(url.pathname);
fs.writeFileSync(process.env.REQUESTS, JSON.stringify(requests));
if (process.env.SUCCESSOR === "true") {
  if (url.pathname === "/api/chat/events") {
    const body = JSON.parse(args[args.indexOf("-d") + 1]);
    if (body.threadId !== "output-test-thread" || Object.hasOwn(body, "model")) {
      throw new Error("Successor must retain its thread and inherit its model");
    }
    fs.writeFileSync(process.env.SEND, JSON.stringify(body));
    process.stdout.write(JSON.stringify({ threadId: body.threadId }));
    process.exit(0);
  }
  if (url.pathname === "/api/runs/output-test-run") {
    process.stdout.write(process.env.RUN_RESPONSE);
    process.exit(0);
  }
}
if (url.pathname !== "/api/chat-threads/output-test-thread/event-rows") {
  throw new Error("Unexpected chat request");
}
const snapshots = JSON.parse(fs.readFileSync(process.env.RESPONSES, "utf8"));
const count = fs.existsSync(process.env.COUNTER)
  ? Number(fs.readFileSync(process.env.COUNTER, "utf8")) : 0;
fs.writeFileSync(process.env.COUNTER, String(count + 1));
const response = snapshots[Math.min(count, snapshots.length - 1)];
if (process.env.SUCCESSOR === "true") {
  const sent = JSON.parse(fs.readFileSync(process.env.SEND, "utf8"));
  response.rows.unshift({
    eventType: "input.prompt",
    runId: "output-test-run",
    revokesEventId: sent.clientEventId,
  });
}
process.stdout.write(JSON.stringify(response));
`,
    { mode: 0o755 },
  );
  const args = steer
    ? [
        "_wait_for_runner_chat_steer_consumed",
        threadId,
        runId,
        steerEventId,
        steerPrompt,
        expected,
        "2",
      ]
    : successor
      ? [
          "runner_chat_send_after_completion",
          "output-test-agent",
          threadId,
          "initial-run",
          "Now reply with a different word: append _NEXT to your previous word.",
          expected,
          "2",
        ]
      : ["_wait_for_runner_chat_output", threadId, runId, expected, "2"];
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; shift; "$@"', "runner-chat-output", helper, ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RESPONSES: responses,
        COUNTER: counter,
        REQUESTS: requests,
        SEND: send,
        SUCCESSOR: String(successor),
        RUN_RESPONSE: JSON.stringify({
          runId,
          status: "completed",
          result: { frameworkSessionId: "continued-session", privateSentinel },
          source: { ...successorSource, privateSentinel },
          environment: { SECRET: privateSentinel },
          requestUrl: `https://private.example/?credential=${privateSentinel}`,
        }),
        E2E_API_TOKEN: "synthetic-e2e-token",
        E2E_API_URL: "https://preview.example",
        RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS: "0",
      },
    },
  );
  assert.ifError(result.error);
  return {
    ...result,
    polls: Number(await readFile(counter, "utf8")),
    requests: JSON.parse(await readFile(requests, "utf8")),
  };
}

test("completed output is checked without requiring a response wrapper", async (context) => {
  const result = await waitForOutput(context, [
    [message("STEER_OK"), completion],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.polls, 1);
});

test("completed content mismatch fails after one poll with the actual output", async (context) => {
  const result = await waitForOutput(context, [
    [message("missing"), completion],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not contain.*STEER_OK.*missing/);
  assert.doesNotMatch(result.stderr, /Timed out/);
  assert.equal(result.polls, 1);
});

test("a completed successor mismatch retains only its public identity and route", async (context) => {
  const result = await waitForOutput(
    context,
    [[message("CONTINUE_NEXT"), completion]],
    { successor: true, expected: "CONTINUE_OK_NEXT" },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /did not contain.*CONTINUE_OK_NEXT.*CONTINUE_NEXT/,
  );
  const summary = result.stderr.match(
    /# Completed successor for thread output-test-thread: (.+)/,
  );
  assert.ok(summary, result.stderr);
  assert.deepEqual(JSON.parse(summary[1]), {
    runId,
    status: "completed",
    sessionId: "continued-session",
    source: successorSource,
  });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    new RegExp(privateSentinel),
  );
  assert.doesNotMatch(result.stderr, /Timed out/);
  // One launch observation and one completed-output observation, no replay.
  assert.equal(result.polls, 2);
  assert.deepEqual(result.requests, [
    "/api/chat/events",
    `/api/chat-threads/${threadId}/event-rows`,
    `/api/runs/${runId}`,
    `/api/chat-threads/${threadId}/event-rows`,
  ]);
});

test("a matching successor keeps its machine-readable success result", async (context) => {
  const result = await waitForOutput(
    context,
    [[message("CONTINUE_OK_NEXT"), completion]],
    { successor: true, expected: "CONTINUE_OK_NEXT" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    runId,
    threadId,
    sessionId: "continued-session",
    status: "completed",
  });
  assert.equal(result.polls, 2);
});

test("completion can arrive before the nonempty output projection", async (context) => {
  const result = await waitForOutput(context, [
    [completion],
    [completion, message("  ")],
    [completion, message("STEER_OK")],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.polls, 3);
});

test("an in-progress reply is not rejected before the final output arrives", async (context) => {
  const result = await waitForOutput(context, [
    [message("working")],
    [message("STEER_OK"), completion],
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.polls, 2);
});

test("another run cannot supply the expected completed output", async (context) => {
  const result = await waitForOutput(context, [
    [message("STEER_OK", "another-run"), message("missing"), completion],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not contain.*STEER_OK.*missing/);
  assert.equal(result.polls, 1);
});

test("an earlier message cannot hide a wrong final reply", async (context) => {
  const result = await waitForOutput(context, [
    [message("STEER_OK"), message("missing"), completion],
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not contain.*STEER_OK.*missing/);
  assert.equal(result.polls, 1);
});

test("consumed steering with a wrong completed reply reports a content mismatch", async (context) => {
  const result = await waitForOutput(
    context,
    [[consumedSteer, message("missing"), completion]],
    { steer: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did not contain.*STEER_OK.*missing/);
  assert.doesNotMatch(result.stderr, /Timed out/);
  assert.equal(result.polls, 1);
});

test("completed output still waits for this steering event to be consumed", async (context) => {
  const result = await waitForOutput(
    context,
    [
      [
        { ...consumedSteer, revokesEventId: "another-steer" },
        message("STEER_OK"),
        completion,
      ],
      [consumedSteer, message("STEER_OK"), completion],
    ],
    { steer: true },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.polls, 2);
});
