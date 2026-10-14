import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";

import { RunnerWssApi } from "./runner-wss-api";
import { RunnerWssClient } from "./runner-wss-client";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "../../turbo/packages/api-contracts/src/contracts/chat-event-schema-version";

const RUN = "11111111-1111-4111-8111-111111111111";
const RUNNER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const TICKET = "fixture".padEnd(43, "_");

async function peer(
  options: {
    corruptEcho?: boolean;
    acceptReplay?: boolean;
    extraFrame?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "wss-node-peer-"));
  const sockets = new Set<WebSocket>();
  const used = new Set<string>();
  try {
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ]);
    const ca = await readFile(join(directory, "cert.pem"));
    const server = createHttpsServer({
      key: await readFile(join(directory, "key.pem")),
      cert: ca,
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let admitted = false;
      let echoes = 0;
      socket.on("message", (data, binary) => {
        if (!admitted) {
          assert.equal(binary, false);
          const message: unknown = JSON.parse(data.toString());
          assert.ok(
            typeof message === "object" &&
              message !== null &&
              "ticket" in message &&
              message.ticket === TICKET &&
              "runId" in message &&
              message.runId === RUN,
          );
          if (used.has(TICKET)) {
            if (options.acceptReplay) {
              socket.send(JSON.stringify({ type: "auth.ok" }, null, 2));
              socket.close(1000);
            } else socket.terminate();
            return;
          }
          used.add(TICKET);
          admitted = true;
          socket.send(JSON.stringify({ type: "auth.ok" }));
          return;
        }
        assert.equal(binary, true);
        socket.send(options.corruptEcho ? Buffer.from([99]) : data, {
          binary: true,
        });
        if (++echoes === 6 && options.extraFrame)
          socket.send(Buffer.from([99]), { binary: true });
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {
      ca,
      ticket: {
        wssUrl: `wss://127.0.0.1:${address.port}/ws/${RUNNER}`,
        ticket: TICKET,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
      async close() {
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test("corrupt Guest echo fails the protocol verdict", async () => {
  const fixture = await peer({ corruptEcho: true });
  const client = new RunnerWssClient(
    RUN,
    fixture.ticket,
    undefined,
    fixture.ca,
  );
  try {
    await client.connect();
    await assert.rejects(client.echo(), /Opaque Guest echo mismatch/);
  } finally {
    try {
      await client.close();
    } finally {
      await fixture.close();
    }
  }
});

test("extra Guest frames after the awaited echo remain a failure", async () => {
  const fixture = await peer({ extraFrame: true });
  const client = new RunnerWssClient(
    RUN,
    fixture.ticket,
    undefined,
    fixture.ca,
  );
  try {
    await client.connect();
    await assert.rejects(async () => {
      await client.echo();
      await client.echo();
    }, /Opaque Guest echo mismatch/);
  } finally {
    try {
      await client.close();
    } finally {
      await fixture.close();
    }
  }
});

test("acknowledged replay fails even if the peer immediately closes", async () => {
  const fixture = await peer({ acceptReplay: true });
  const client = new RunnerWssClient(
    RUN,
    fixture.ticket,
    undefined,
    fixture.ca,
  );
  try {
    await client.connect();
    await client.echo();
    await assert.rejects(client.rejectReplay(), /Replayed ticket was admitted/);
  } finally {
    try {
      await client.close();
    } finally {
      await fixture.close();
    }
  }
});

test("an untrusted TLS peer cannot be accepted as WSS admission", async () => {
  const fixture = await peer();
  // No fixture CA is installed for this client: normal trust must reject it.
  const client = new RunnerWssClient(RUN, fixture.ticket);
  try {
    await assert.rejects(client.connect(), /WSS connection failed/);
  } finally {
    try {
      await client.close();
    } finally {
      await fixture.close();
    }
  }
});

test("public cleanup deletes owned thread and agent after cancellation failure without leaking its response", async () => {
  const paths: string[] = [];
  let clientEventId = "";
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://peer.test");
    paths.push(`${request.method} ${url.pathname}`);
    response.setHeader("Content-Type", "application/json");
    let status = 200;
    let body: unknown;
    if (url.pathname === "/api/agents" && request.method === "POST") {
      status = 201;
      body = { agentId: AGENT };
    } else if (url.pathname === "/api/chat/events") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      assert.ok(
        typeof input === "object" &&
          input !== null &&
          "clientEventId" in input &&
          typeof input.clientEventId === "string",
      );
      clientEventId = input.clientEventId;
      status = 201;
      body = { threadId: THREAD, runId: null };
    } else if (url.pathname.endsWith("/event-rows")) {
      assert.equal(url.searchParams.get("sinceSeqId"), "0");
      assert.equal(
        request.headers["x-chat-event-schema-version"],
        String(CURRENT_CHAT_EVENT_SCHEMA_VERSION),
      );
      body = {
        rows: [
          {
            eventType: "input.prompt",
            revokesEventId: clientEventId,
            runId: RUN,
          },
          {
            eventType: "output.message",
            runId: RUN,
            payload: { content: `WSS_READY_${clientEventId}` },
          },
        ],
      };
    } else if (url.pathname.endsWith("/runner"))
      body = {
        runnerId: RUNNER,
        runnerHostname: "runner.example.test",
        runnerHeartbeatGeneration: 1,
      };
    else if (url.pathname.endsWith("/cancel")) {
      status = 500;
      body = { credential: "must-not-appear-in-errors" };
    } else if (request.method === "DELETE") status = 204;
    else if (url.pathname === `/api/runs/${RUN}`) body = { status: "running" };
    else {
      status = 404;
      body = {};
    }
    response.writeHead(status);
    response.end(status === 204 ? undefined : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const api = new RunnerWssApi(
    `http://127.0.0.1:${address.port}`,
    "fixture-public-device-token",
  );
  try {
    await api.createAgent();
    await api.start("fixture-native-model");
    await assert.rejects(api.cleanup(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(!String(error).includes("must-not-appear-in-errors"));
      assert.ok(
        error.errors.every(
          (value) => !String(value).includes("must-not-appear-in-errors"),
        ),
      );
      return true;
    });
    assert.ok(paths.includes(`DELETE /api/chat-threads/${THREAD}`));
    assert.ok(paths.includes(`DELETE /api/agents/${AGENT}`));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
