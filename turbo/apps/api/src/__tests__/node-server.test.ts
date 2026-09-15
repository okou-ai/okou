import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

import { testContext } from "./test-context";

const context = testContext();

// Process shutdown is the boundary here. Controlled HTTP work makes unfinished
// requests and background handles reproducible without stalling a real provider.

const fixture = fileURLToPath(
  new URL("../test-fixtures/node-server-child.ts", import.meta.url),
);

async function startChild(port = 0) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fixture, String(port)],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const exited = once(child, "exit").then(() => {
    return { code: child.exitCode, signal: child.signalCode };
  });
  const messages = new Map<string, unknown>();
  const events = new EventEmitter();
  child.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "event" in message) {
      const event = String(message.event);
      messages.set(event, message);
      events.emit(event);
    }
  });

  function waitFor(event: string): Promise<unknown> {
    const received = messages.has(event)
      ? Promise.resolve(messages.get(event))
      : once(events, event, { signal: context.signal }).then(() => {
          return messages.get(event);
        });
    return Promise.race([
      received,
      exited.then((result) => {
        throw new Error(
          `Child exited before ${event}: ${JSON.stringify(result)}`,
        );
      }),
    ]);
  }

  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
  });

  const ready = await waitFor("ready");
  if (
    typeof ready !== "object" ||
    ready === null ||
    !("port" in ready) ||
    typeof ready.port !== "number"
  ) {
    throw new Error("Child did not report a listening port");
  }
  return { child, port: ready.port, exited, waitFor };
}

async function openSocket(port: number) {
  const socket = connect(port, "127.0.0.1");
  onTestFinished(() => {
    socket.destroy();
  });
  const closed = once(socket, "close");
  let response = "";
  socket.on("data", (chunk: Buffer) => {
    response += chunk.toString();
  });
  await once(socket, "connect");
  return {
    socket,
    closed,
    response: () => {
      return response;
    },
  };
}

function request(socket: Socket, path: string, extraHeaders = ""): void {
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\n${extraHeaders}\r\n`,
  );
}

describe("standalone Node server shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s releases keepalive connections and allows a replacement listener",
    async (signal) => {
      const server = await startChild();
      const peer = await openSocket(server.port);
      request(peer.socket, "/health");
      await vi.waitFor(() => {
        expect(peer.response()).toContain('{"status":"ok"}');
      });
      server.child.kill(signal);
      await peer.closed;
      await expect(server.exited).resolves.toStrictEqual({
        code: 0,
        signal: null,
      });

      const replacement = await startChild(server.port);
      const replacementPeer = await openSocket(replacement.port);
      request(replacementPeer.socket, "/health", "Connection: close\r\n");
      await replacementPeer.closed;
      expect(replacementPeer.response()).toContain("200 OK");
      expect(replacementPeer.response()).toContain('{"status":"ok"}');
      replacement.child.kill("SIGTERM");
      await expect(replacement.exited).resolves.toStrictEqual({
        code: 0,
        signal: null,
      });
    },
  );

  it("cancels active work, rejects late health requests, and tolerates repeated signals", async () => {
    const server = await startChild();
    const peer = await openSocket(server.port);
    request(peer.socket, "/work");
    await server.waitFor("working");
    server.child.kill("SIGTERM");
    await server.waitFor("aborted");

    server.child.kill("SIGTERM");
    server.child.kill("SIGINT");
    server.child.send("ping");
    await server.waitFor("pong");
    request(
      peer.socket,
      "/health",
      "X-Shutdown-Probe: true\r\nConnection: close\r\n",
    );
    await server.waitFor("probe");
    server.child.send("finish");
    await peer.closed;
    expect(peer.response()).toContain('{"cancelled":true}');
    expect(peer.response()).toContain("503 Service Unavailable");
    expect(peer.response().toLowerCase()).toContain("connection: close");
    expect(peer.response()).not.toContain('{"status":"ok"}');
    await expect(server.exited).resolves.toStrictEqual({
      code: 0,
      signal: null,
    });
  });

  it("allows background cleanup after the HTTP listener closes", async () => {
    const server = await startChild();
    const peer = await openSocket(server.port);
    request(peer.socket, "/background", "Connection: close\r\n");
    await peer.closed;
    expect(peer.response()).toContain("200 OK");
    server.child.kill("SIGTERM");
    await server.waitFor("aborted");
    // The old process still owns background work, but not the listening port.
    const replacement = await startChild(server.port);
    replacement.child.kill("SIGTERM");
    await expect(replacement.exited).resolves.toStrictEqual({
      code: 0,
      signal: null,
    });
    server.child.send("finish");
    await server.waitFor("cleaned");
    await expect(server.exited).resolves.toStrictEqual({
      code: 0,
      signal: null,
    });
  });

  it.each(["/work", "/background"])(
    "bounds shutdown with stalled %s handles",
    async (path) => {
      const server = await startChild();
      const peer = await openSocket(server.port);
      request(peer.socket, path, "Connection: close\r\n");
      if (path === "/work") {
        await server.waitFor("working");
      } else {
        await peer.closed;
        expect(peer.response()).toContain("200 OK");
      }
      server.child.kill("SIGTERM");
      await server.waitFor("aborted");
      await expect(server.exited).resolves.toStrictEqual({
        code: 1,
        signal: null,
      });
      await peer.closed;
    },
    10_000,
  );
});
