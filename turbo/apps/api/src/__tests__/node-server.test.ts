import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { createDeferredPromise } from "../signals/utils";

const childFixture = fileURLToPath(
  new URL("../test-fixtures/node-server-child.ts", import.meta.url),
);

interface ChildEvent {
  readonly event: string;
  readonly port?: number;
}

function isChildEvent(value: unknown): value is ChildEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "event" in value &&
    typeof value.event === "string"
  );
}

function createEventQueue(child: ChildProcess) {
  const buffered: ChildEvent[] = [];
  const waiters: ((event: ChildEvent) => void)[] = [];

  child.on("message", (message: unknown) => {
    if (!isChildEvent(message)) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      buffered.push(message);
    }
  });

  return async function nextEvent(
    expected: string,
    signal: AbortSignal,
  ): Promise<ChildEvent> {
    while (true) {
      const queued = buffered.shift();
      if (queued) {
        if (queued.event === expected) {
          return queued;
        }
        continue;
      }
      const deferred = createDeferredPromise<ChildEvent>(signal);
      waiters.push((event) => {
        deferred.resolve(event);
      });
      const event = await deferred.promise;
      if (event.event === expected) {
        return event;
      }
    }
  };
}

describe("standalone Node server shutdown", () => {
  it("node-server-003 cancels active work, rejects late health requests, and tolerates repeated signals", async () => {
    const controller = new AbortController();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", childFixture, "0"],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    onTestFinished(() => {
      controller.abort();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });

    const nextEvent = createEventQueue(child);
    const ready = await nextEvent("ready", controller.signal);
    if (ready.port === undefined) {
      throw new Error("Expected standalone server port");
    }

    const socket = createConnection({ host: "127.0.0.1", port: ready.port });
    onTestFinished(() => {
      socket.destroy();
    });
    await once(socket, "connect");

    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const socketClosed = once(socket, "close");

    socket.write(
      "GET /work HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n",
    );
    await nextEvent("working", controller.signal);

    child.kill("SIGTERM");
    await nextEvent("aborted", controller.signal);

    child.kill("SIGTERM");
    child.kill("SIGINT");
    child.send("ping");
    await nextEvent("pong", controller.signal);

    socket.write(
      "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Shutdown-Probe: true\r\nConnection: keep-alive\r\n\r\n",
    );
    child.send("finish");

    const [exitCode, exitSignal] = (await once(child, "exit")) as [
      number | null,
      NodeJS.Signals | null,
    ];
    await socketClosed;

    const raw = Buffer.concat(chunks).toString("utf8");
    expect(raw).toContain('"cancelled":true');
    expect(raw).toContain("HTTP/1.1 503");
    expect(raw.toLowerCase()).toContain("connection: close");
    expect(raw).not.toContain('"status":"ok"');
    expect(exitCode).toBe(0);
    expect(exitSignal).toBeNull();
  });
});
