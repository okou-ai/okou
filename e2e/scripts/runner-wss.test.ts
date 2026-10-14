import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import { RunnerWssApi } from "./runner-wss-api";
import { RunnerWssClient } from "./runner-wss-client";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  type SandboxChannelMessage,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import { sandboxDiagnosticsEchoSchema } from "@okouai/api-contracts/contracts/sandbox-channel-diagnostics";
import {
  sandboxFsListParamsSchema,
  sandboxFsListCloseParamsSchema,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import { probeHomeFiles } from "./runner-wss-files";

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
    filesystem?: boolean;
    corruptListing?: boolean;
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
      let ready = false;
      const cursors = new Map<string, { listingId: string; offset: number }>();
      const reverse = new Map<
        string,
        Extract<SandboxChannelMessage, { type: "request" }>
      >();
      const emit = (message: SandboxChannelMessage) =>
        socket.send(Buffer.from(encodeSandboxChannelFrame(message)), {
          binary: true,
        });
      const result = (requestId: string, payload: unknown) => {
        emit({
          schemaVersion: 1,
          type: "response",
          id: randomUUID(),
          requestId,
          result: payload,
        });
        if (++echoes === 12 && options.extraFrame)
          socket.send(Buffer.from([99]), { binary: true });
      };
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
        const frame = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const message = decodeSandboxChannelFrame(new Uint8Array(frame).buffer);
        if (message.type === "hello" && !ready) {
          ready = true;
          emit({
            schemaVersion: 1,
            type: "response",
            id: randomUUID(),
            requestId: message.id,
            result: {
              categories: {
                diagnostics: 1,
                ...(options.filesystem ? { fs: 1 } : {}),
              },
            },
          });
          // Deliberately send the first business frame in the same callback.
          emit({
            schemaVersion: 1,
            type: "event",
            id: randomUUID(),
            category: "diagnostics",
            categoryVersion: 1,
            event: "notice",
            data: { message: "ready" },
          });
          return;
        }
        assert.ok(ready);
        if (message.type === "event") return;
        if (message.type === "response") {
          const pending = reverse.get(message.requestId);
          assert.ok(pending);
          reverse.delete(message.requestId);
          const parsed = sandboxDiagnosticsEchoSchema.parse(message.result);
          result(
            pending.id,
            options.corruptEcho ? { payload: "invalid" } : parsed,
          );
          return;
        }
        assert.ok(message.type === "request");
        if (message.category === "fs") {
          const fail = (code: string) =>
            emit({
              schemaVersion: 1,
              type: "response",
              id: randomUUID(),
              requestId: message.id,
              error: { code },
            });
          const token = (name: string) =>
            Buffer.from(name).toString("base64url");
          const entry = (
            name: string,
            kind: "directory" | "file" | "symlink",
          ) => ({ nameToken: token(name), displayName: name, kind });
          if (message.operation === "list.close") {
            const params = sandboxFsListCloseParamsSchema.parse(message.params);
            if (!cursors.delete(params.cursor)) fail("cursor_expired");
            else result(message.id, {});
            return;
          }
          if (message.operation !== "list") {
            fail("unknown_operation");
            return;
          }
          const parsed = sandboxFsListParamsSchema.safeParse(message.params);
          if (!parsed.success) {
            fail("invalid_params");
            return;
          }
          const params = parsed.data;
          if (params.path?.length === 0) {
            result(message.id, {
              listingId: randomUUID(),
              entries: [entry("wss-home-fixture", "directory")],
              nextCursor: null,
            });
            return;
          }
          if (params.path?.[1] === token("nested")) {
            result(message.id, {
              listingId: randomUUID(),
              entries: [entry("leaf", "file")],
              nextCursor: null,
            });
            return;
          }
          if (params.path?.[1] === token("outside")) {
            fail("link_not_expandable");
            return;
          }
          const cursor = params.cursor ?? randomUUID();
          const state = params.cursor
            ? cursors.get(cursor)
            : { listingId: randomUUID(), offset: 0 };
          if (!state) {
            fail("cursor_expired");
            return;
          }
          const entries = [
            entry("nested", "directory"),
            entry(".hidden", "file"),
            entry("outside", "symlink"),
            ...Array.from({ length: 270 }, (_, index) =>
              entry(`file-${index}`, "file"),
            ),
          ];
          const rows = entries.slice(state.offset, state.offset + 128);
          state.offset += rows.length;
          const next = state.offset < entries.length ? cursor : null;
          if (next) cursors.set(cursor, state);
          else cursors.delete(cursor);
          result(message.id, {
            listingId:
              options.corruptListing && params.cursor
                ? randomUUID()
                : state.listingId,
            entries: rows,
            nextCursor: next,
          });
          return;
        }
        assert.equal(message.category, "diagnostics");
        assert.equal(message.categoryVersion, 1);
        const params = sandboxDiagnosticsEchoSchema.parse(message.params);
        if (message.operation === "echo")
          result(
            message.id,
            options.corruptEcho ? { payload: "invalid" } : params,
          );
        else {
          assert.equal(message.operation, "peer.echo");
          const id = randomUUID();
          reverse.set(id, message);
          emit({
            schemaVersion: 1,
            type: "request",
            id,
            category: "diagnostics",
            categoryVersion: 1,
            operation: "echo",
            params,
          });
        }
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

test("current Guest schema supports reverse RPC, immediate notice and post-replay use", async () => {
  const fixture = await peer();
  const client = new RunnerWssClient(
    RUN,
    fixture.ticket,
    undefined,
    fixture.ca,
  );
  try {
    await client.connect();
    await assert.rejects(
      client.list({ path: [] }),
      /Filesystem role unavailable/,
    );
    await client.diagnostics();
    await client.rejectReplay();
    await client.diagnostics();
    assert.deepEqual(client.receipts, { reverseCalls: 12, noticesReceived: 1 });
  } finally {
    try {
      await client.close();
    } finally {
      await fixture.close();
    }
  }
});

test("filesystem probe preserves page ownership, closes cursors and rejects stale listing identity", async () => {
  for (const corruptListing of [false, true]) {
    const fixture = await peer({ filesystem: true, corruptListing });
    const client = new RunnerWssClient(
      RUN,
      fixture.ticket,
      undefined,
      fixture.ca,
    );
    try {
      await client.connect();
      if (corruptListing)
        await assert.rejects(
          probeHomeFiles(client, "wss-home-fixture"),
          /Continuation must keep listing identity/,
        );
      else {
        const receipt = await probeHomeFiles(client, "wss-home-fixture");
        assert.equal(receipt.directoryPages, 3);
        assert.equal(receipt.cursorRelease, true);
        await client.diagnostics();
      }
    } finally {
      try {
        await client.close();
      } finally {
        await fixture.close();
      }
    }
  }
});

test("corrupt Guest diagnostics fails the protocol verdict", async () => {
  const fixture = await peer({ corruptEcho: true });
  const client = new RunnerWssClient(
    RUN,
    fixture.ticket,
    undefined,
    fixture.ca,
  );
  try {
    await client.connect();
    await assert.rejects(client.diagnostics(), /Invalid sandbox channel/);
  } finally {
    try {
      await client.close();
    } finally {
      await fixture.close();
    }
  }
});

test("extra invalid Guest frames after awaited diagnostics remain a failure", async () => {
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
      await client.diagnostics();
      await client.diagnostics();
    }, /Invalid sandbox channel/);
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
    await client.diagnostics();
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
