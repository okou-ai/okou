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
const steerPrompt = "Reply with only this token: STEER_OK";

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

async function waitForOutput(context, snapshots, { steer = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "runner-chat-output-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const responses = join(directory, "responses.json");
  const counter = join(directory, "counter");
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
if (!args.some((arg) => arg.startsWith(
  "https://preview.example/api/chat-threads/output-test-thread/event-rows?"
))) {
  throw new Error("Unexpected chat event request");
}
const snapshots = JSON.parse(fs.readFileSync(process.env.RESPONSES, "utf8"));
const count = fs.existsSync(process.env.COUNTER)
  ? Number(fs.readFileSync(process.env.COUNTER, "utf8")) : 0;
fs.writeFileSync(process.env.COUNTER, String(count + 1));
process.stdout.write(JSON.stringify(snapshots[Math.min(count, snapshots.length - 1)]));
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
        "STEER_OK",
        "2",
      ]
    : ["_wait_for_runner_chat_output", threadId, runId, "STEER_OK", "2"];
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
        E2E_API_TOKEN: "synthetic-e2e-token",
        E2E_API_URL: "https://preview.example",
        RUNNER_CHAT_EVENT_POLL_INTERVAL_SECONDS: "0",
      },
    },
  );
  assert.ifError(result.error);
  return { ...result, polls: Number(await readFile(counter, "utf8")) };
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
