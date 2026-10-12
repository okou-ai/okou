import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { chromium, type Browser, type Page } from "@playwright/test";
import { WebSocketServer, type WebSocket } from "ws";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "../../../turbo/packages/api-contracts/src/contracts/chat-event-schema-version";

import { RunnerWssApi } from "./run-wss-api";
import {
  bundleRunWssProbe,
  closeRunWssProbe,
  installRunWssProbe,
  verifyRunWssEcho,
  verifyRunWssRevocation,
} from "./run-wss-probe";

const RUN = "11111111-1111-4111-8111-111111111111";
const RUNNER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const THREAD = "44444444-4444-4444-8444-444444444444";
const TARGET = `wss://runner.example.test:443/ws/${RUNNER}`;

interface PeerOptions {
  readonly corruptEcho?: boolean;
  readonly acceptReplay?: boolean;
  readonly failCancellation?: boolean;
}

async function peer(options: PeerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "wss-probe-peer-"));
  let browser: Browser | undefined;
  const sockets = new Set<WebSocket>();
  const used = new Set<string>();
  const paths: string[] = [];
  let terminal = false;
  let serial = 0;
  let clientEventId = "";
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=runner.example.test",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
  ]);
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const path = new URL(request.url ?? "/", "https://peer.test").pathname;
    paths.push(`${request.method} ${path}`);
    response.setHeader("Content-Type", "application/json");
    let body: unknown = {};
    let status = 200;
    if (path.endsWith("/wss/bootstrap")) {
      status = terminal ? 404 : 200;
      body = {
        wssUrl: TARGET,
        ticket: String(++serial).padEnd(43, "_"),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    } else if (path === "/api/agents" && request.method === "POST") {
      status = 201;
      body = { agentId: AGENT };
    } else if (path === "/api/chat/events") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (
        typeof input !== "object" ||
        input === null ||
        !("clientEventId" in input) ||
        typeof input.clientEventId !== "string"
      )
        throw new Error("Missing public input identity");
      clientEventId = input.clientEventId;
      status = 201;
      body = { threadId: THREAD, runId: null };
    } else if (path.endsWith("/event-rows")) {
      const query = new URL(request.url ?? "/", "https://peer.test")
        .searchParams;
      if (
        query.get("sinceSeqId") !== "0" ||
        request.headers["x-chat-event-schema-version"] !==
          String(CURRENT_CHAT_EVENT_SCHEMA_VERSION)
      ) {
        status = 400;
      } else {
        body = {
          rows: [
            {
              eventType: "input.prompt",
              revokesEventId: clientEventId,
              runId: RUN,
            },
          ],
        };
      }
    } else if (path.endsWith("/runner"))
      body = {
        runnerId: RUNNER,
        runnerHostname: "runner.example.test",
        runnerHeartbeatGeneration: 1,
      };
    else if (path.endsWith("/cancel")) {
      status = options.failCancellation ? 500 : 200;
      body = { status: "cancelled", credential: "must-not-appear-in-errors" };
      terminal = !options.failCancellation;
    } else if (path === `/api/runs/${RUN}`)
      body = { status: terminal ? "completed" : "running" };
    else if (request.method === "DELETE") status = 204;
    else {
      response.setHeader("Content-Type", "text/html");
      body = null;
    }
    response.writeHead(status);
    response.end(
      status === 204
        ? undefined
        : body === null
          ? '<html><body>controlled browser peer<script>window.Clerk = {loaded:true,publishableKey:"pk_test_fixture",organization:{id:"org_fixture"},setActive:async function(){},session:{getToken:async function(){return "fixture-session"}}};</script></body></html>'
          : JSON.stringify(body),
    );
  };
  const server = createServer(
    {
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    },
    handler,
  );
  const httpServer = createHttpServer(handler);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (websocket) =>
      wss.emit("connection", websocket, request),
    ),
  );
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let admitted = false;
    socket.on("message", (data, binary) => {
      if (!admitted) {
        const message: unknown = JSON.parse(data.toString());
        if (
          typeof message !== "object" ||
          message === null ||
          !("ticket" in message) ||
          typeof message.ticket !== "string"
        ) {
          socket.close(1000);
          return;
        }
        if (used.has(message.ticket)) {
          if (options.acceptReplay) {
            socket.send(JSON.stringify({ type: "auth.ok" }, null, 2));
            socket.close(1000);
          } else {
            // Match Runner's rejected pre-auth lifetime: it drops the stream.
            socket.terminate();
          }
          return;
        }
        used.add(message.ticket);
        admitted = true;
        socket.send(JSON.stringify({ type: "auth.ok" }));
        return;
      }
      assert.equal(binary, true);
      socket.send(options.corruptEcho ? Buffer.from([99]) : data, {
        binary: true,
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `https://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const httpAddress = httpServer.address();
  assert.ok(httpAddress && typeof httpAddress !== "string");
  const apiOrigin = `http://127.0.0.1:${httpAddress.port}`;
  try {
    browser = await chromium.launch({
      executablePath: process.env.WSS_TEST_CHROMIUM_PATH,
      args: [
        `--host-resolver-rules=MAP runner.example.test 127.0.0.1:${address.port}`,
        "--no-proxy-server",
      ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(origin);
    return {
      page,
      origin,
      apiOrigin,
      paths,
      async revoke() {
        terminal = true;
        for (const socket of sockets) socket.close(1000);
      },
      async close() {
        if (!page.isClosed()) await closeRunWssProbe(page);
        await context.close();
        await browser?.close();
        for (const socket of sockets) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await browser?.close();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function install(page: Page, origin: string): Promise<void> {
  await installRunWssProbe(page, await bundleRunWssProbe(), origin);
}

test("the browser probe uses native sockets, checks opaque frames/replay and observes terminal bootstrap", async () => {
  const fixture = await peer();
  try {
    await install(fixture.page, fixture.origin);
    await verifyRunWssEcho(fixture.page, RUN, TARGET, true);
    await fixture.revoke();
    await verifyRunWssRevocation(fixture.page, RUN);
    const report = await fixture.page.evaluate(() => ({
      state: window.__runWssProbe?.state,
      statuses: window.__runWssProbe?.bootstrapStatuses,
    }));
    assert.deepEqual(report, { state: "failed", statuses: [200, 404] });
    assert.ok(!JSON.stringify(report).includes("fixture-session"));
  } finally {
    await fixture.close();
  }
});

test("corrupted peer echo fails instead of recording a successful acceptance", async () => {
  const fixture = await peer({ corruptEcho: true });
  try {
    await install(fixture.page, fixture.origin);
    await assert.rejects(
      verifyRunWssEcho(fixture.page, RUN, TARGET, false),
      /Opaque echo mismatch/,
    );
    await closeRunWssProbe(fixture.page);
    assert.equal(
      await fixture.page.evaluate(() => window.__runWssProbe),
      undefined,
    );
  } finally {
    await fixture.close();
  }
});

test("an acknowledged replay fails even when the peer closes normally", async () => {
  const fixture = await peer({ acceptReplay: true });
  try {
    await install(fixture.page, fixture.origin);
    await assert.rejects(verifyRunWssEcho(fixture.page, RUN, TARGET, true));
  } finally {
    await fixture.close();
  }
});

test("owned public cleanup continues after cancellation failure without leaking its response", async () => {
  const fixture = await peer({ failCancellation: true });
  try {
    const api = new RunnerWssApi(
      fixture.apiOrigin,
      "fixture-public-device-token",
    );
    await api.createAgent();
    await api.start("fixture-native-model", 45);
    // Public device-flow cleanup remains available after the browser is lost.
    await fixture.page.close();
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
    assert.ok(fixture.paths.includes(`DELETE /api/chat-threads/${THREAD}`));
    assert.ok(fixture.paths.includes(`DELETE /api/agents/${AGENT}`));
  } finally {
    await fixture.close();
  }
});
