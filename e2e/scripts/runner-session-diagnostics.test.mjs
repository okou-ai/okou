import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const transport = fileURLToPath(
  new URL("../helpers/runner-chat.bash", import.meta.url),
);
const helper = fileURLToPath(
  new URL("../helpers/runner-session-diagnostics.bash", import.meta.url),
);
const firstRun = "10000000-0000-4000-8000-000000000001";
const secondRun = "10000000-0000-4000-8000-000000000002";
const thread = "20000000-0000-4000-8000-000000000001";
const firstSession = "30000000-0000-4000-8000-000000000001";
const secondSession = "30000000-0000-4000-8000-000000000002";
const privateText = "private-message-and-credential-value";

function summary(runId, sessionId, threadId = thread) {
  return `${JSON.stringify({
    runId,
    threadId,
    sessionId,
    status: "completed",
    ignored: privateText,
  })}\n${privateText}`;
}

function fixture(path) {
  const runId = path.split("/")[3];
  const actualSession = runId === firstRun ? firstSession : secondSession;
  if (path.endsWith("/context")) {
    return {
      runId,
      cliAgentType: "codex",
      sessionId: runId === firstRun ? null : firstSession,
      prompt: privateText,
      environment: { SECRET: privateText },
    };
  }
  if (path.includes("/telemetry/agent?")) {
    return {
      events: [
        {
          eventType: "thread.started",
          sequenceNumber: 0,
          eventData: { thread_id: actualSession, ignored: privateText },
        },
        {
          eventType: "output.message",
          sequenceNumber: 1,
          eventData: { content: privateText },
        },
      ],
      hasMore: false,
      ignored: privateText,
    };
  }
  return {
    runId,
    status: "completed",
    result: { framework: "codex", frameworkSessionId: actualSession },
    prompt: privateText,
    error: privateText,
  };
}

async function compare(t, { first, second, respond } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer synthetic-token");
    if (respond?.(request, response)) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(fixture(request.url)));
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
        'source "$1"; source "$2"; runner_chat_assert_codex_continuity "$3" "$4"',
        "session-diagnostics-test",
        transport,
        helper,
        first ?? summary(firstRun, firstSession),
        second ?? summary(secondRun, secondSession),
      ],
      {
        env: {
          ...process.env,
          E2E_API_TOKEN: "synthetic-token",
          E2E_API_URL: `http://127.0.0.1:${address.port}`,
          VERCEL_AUTOMATION_BYPASS_SECRET: "",
        },
        signal: t.signal,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return { ...result, requests };
}

function snapshots(result) {
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(privateText), false);
  assert.ok(Buffer.byteLength(result.stderr) < 8192);
  return Object.fromEntries(
    result.stderr
      .split("\n")
      .filter((line) => /^# (first|second)( \w+)?: \{/.test(line))
      .map((line) => {
        const split = line.indexOf(": ");
        return [line.slice(2, split), JSON.parse(line.slice(split + 2))];
      }),
  );
}

function expectedRequests() {
  return [firstRun, secondRun].flatMap((id) => [
    `/api/runs/${id}`,
    `/api/runs/${id}/context`,
    `/api/runs/${id}/telemetry/agent?limit=100&order=asc`,
  ]);
}

test("matching sessions on the same thread are silent and issue no requests", async (t) => {
  const result = await compare(t, {
    second: summary(secondRun, firstSession),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(result.requests, []);
});

test("session divergence retains the failure and correlates intent, initialization and result", async (t) => {
  const result = await compare(t);
  const observed = snapshots(result);
  assert.deepEqual(result.requests, expectedRequests());
  assert.deepEqual(observed.first, {
    state: "available",
    runId: firstRun,
    threadId: thread,
    sessionId: firstSession,
  });
  assert.equal(observed.second.runId, secondRun);
  assert.deepEqual(observed["first context"].session, { state: "absent" });
  assert.deepEqual(observed["second context"], {
    state: "available",
    framework: "codex",
    session: { state: "present", id: firstSession },
  });
  assert.deepEqual(observed["second initialization"], {
    state: "available",
    hasMore: false,
    initializations: [
      {
        kind: "thread.started",
        sequence: 0,
        session: { state: "present", id: secondSession },
      },
    ],
    omittedInitializations: 0,
  });
  assert.deepEqual(observed["second run"].session, {
    state: "present",
    id: secondSession,
  });
});

test("equal session IDs on different threads still fail", async (t) => {
  const result = await compare(t, {
    second: summary(secondRun, firstSession, secondRun),
  });
  snapshots(result);
  assert.deepEqual(result.requests, expectedRequests());
});

test("unavailable snapshots never retry, print error bodies, or recover the assertion", async (t) => {
  const result = await compare(t, {
    respond(request, response) {
      if (request.url.endsWith("/context")) {
        response.writeHead(503);
        response.end(privateText);
      } else if (request.url.includes("/telemetry/agent?")) {
        // A transport failure is not replayed either.
        request.socket.destroy();
      } else {
        response.end(`not-json-${privateText}`);
      }
      return true;
    },
  });
  const observed = snapshots(result);
  assert.deepEqual(result.requests, expectedRequests());
  for (const turn of ["first", "second"]) {
    for (const surface of ["run", "context", "initialization"]) {
      assert.deepEqual(observed[`${turn} ${surface}`], {
        state: "unavailable",
      });
    }
  }
});

test("partial initialization pages retain their limit and bound admitted identities", async (t) => {
  const result = await compare(t, {
    respond(request, response) {
      if (!request.url.includes("/telemetry/agent?")) return false;
      response.end(
        JSON.stringify({
          events: Array.from({ length: 12 }, (_, index) => ({
            eventType: "system",
            sequenceNumber: index,
            eventData: {
              subtype: "init",
              session_id: firstSession,
              ignored: privateText,
            },
          })),
          hasMore: true,
          nextCursor: privateText,
        }),
      );
      return true;
    },
  });
  const observed = snapshots(result);
  assert.deepEqual(result.requests, expectedRequests());
  const page = observed["second initialization"];
  assert.equal(page.hasMore, true);
  assert.equal(page.initializations.length, 8);
  assert.equal(page.omittedInitializations, 4);
  assert.equal(page.initializations[0].kind, "system.init");
});

test("oversized chunked snapshots are unavailable without emitting their content", async (t) => {
  const result = await compare(t, {
    respond(_request, response) {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"private":"');
      response.write(privateText.repeat(16384));
      response.end('"}');
      return true;
    },
  });
  const observed = snapshots(result);
  assert.deepEqual(result.requests, expectedRequests());
  assert.deepEqual(observed["second context"], { state: "unavailable" });
});

test("wrong-Run, missing, invalid and multi-document fields are not invented or echoed", async (t) => {
  const result = await compare(t, {
    respond(request, response) {
      const data = fixture(request.url);
      if (request.url.endsWith("/context")) {
        data.sessionId = privateText;
        data.cliAgentType = privateText;
        if (request.url.includes(firstRun)) delete data.sessionId;
      } else if (request.url.includes("/telemetry/agent?")) {
        data.events[0].eventData.thread_id = privateText;
        data.events[0].sequenceNumber = privateText;
      } else {
        data.runId = privateText;
      }
      response.end(JSON.stringify(data));
      return true;
    },
  });
  const observed = snapshots(result);
  assert.deepEqual(result.requests, expectedRequests());
  assert.deepEqual(observed["first run"], { state: "unavailable" });
  assert.deepEqual(observed["first context"].session, {
    state: "unavailable",
  });
  assert.deepEqual(observed["second context"], {
    state: "available",
    framework: "unavailable",
    session: { state: "invalid" },
  });
  assert.deepEqual(observed["second initialization"].initializations[0], {
    kind: "thread.started",
    sequence: null,
    session: { state: "invalid" },
  });

  const multiple = await compare(t, {
    respond(request, response) {
      response.end(`${JSON.stringify(fixture(request.url))}\n{}`);
      return true;
    },
  });
  const multiObserved = snapshots(multiple);
  assert.deepEqual(multiObserved["second context"], { state: "unavailable" });
});

test("invalid summary identities cannot become URLs or leak through diagnostics", async (t) => {
  const result = await compare(t, {
    first: summary(privateText, firstSession),
    second: summary(privateText, secondSession),
  });
  const observed = snapshots(result);
  assert.deepEqual(observed, {
    first: { state: "unavailable" },
    second: { state: "unavailable" },
  });
  assert.deepEqual(result.requests, []);
});
