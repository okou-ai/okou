import { waitFor } from "@testing-library/react";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import {
  RUN_WSS_MAX_BUFFERED_BYTES,
  RUN_WSS_MAX_FRAME_BYTES,
  RunWssTransport,
} from "@okouai/core/run-wss-transport";
import { expect, test } from "vitest";

import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { resetSignal } from "../../signals/utils.ts";
import { now } from "../time.ts";
import { createAuthedContractClient } from "../../signals/api-client-base.ts";
import type { ApiClientFactory } from "../../signals/api-client.ts";
import { createBrowserRunWssTransport } from "../run-wss-transport.ts";

const context = testContext();
const RUN_ID = "d0000000-0000-4000-a000-000000000911";
const RUNNER_ID = "a0000000-0000-4000-a000-000000000912";
const URL = `wss://runner.example.com:443/ws/${RUNNER_ID}`;
const TICKET = "a".repeat(43);
const bootstrapResponse = (url = URL) => {
  return {
    wssUrl: url,
    ticket: TICKET,
    expiresAt: new Date(now() + 30_000).toISOString(),
  };
};

class FakeSocket extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  readonly sent: (string | ArrayBuffer)[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === "string" || data instanceof ArrayBuffer) {
      this.sent.push(data);
      return;
    }
    throw new Error("Unsupported test frame");
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function makeTransport(
  bootstrap: (
    signal: AbortSignal,
  ) => Promise<ReturnType<typeof bootstrapResponse>>,
  onFrame: (frame: ArrayBuffer) => void = () => {
    return undefined;
  },
) {
  const sockets: FakeSocket[] = [];
  const transport = new RunWssTransport(
    RUN_ID,
    async (_runId, signal) => {
      return {
        kind: "success" as const,
        body: await bootstrap(signal),
      };
    },
    {
      onFrame,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    },
  );
  return { transport, sockets };
}

async function firstSocket(sockets: FakeSocket[]): Promise<FakeSocket> {
  await waitFor(() => {
    return expect(sockets).toHaveLength(1);
  });
  const socket = sockets[0];
  if (!socket) {
    throw new Error("Missing test socket");
  }
  return socket;
}

test("explicit connect bootstraps with the typed authenticated API and gates binary delivery", async () => {
  let bootstrapCalls = 0;
  context.mocks.api(runnerWssTicketsContract.bootstrap, ({ respond }) => {
    bootstrapCalls++;
    return respond(200, bootstrapResponse());
  });
  const createClient: ApiClientFactory = (contract) => {
    return createAuthedContractClient(contract, {
      baseUrl: location.origin,
      clientVersion: "0.973.2",
      getToken: () => {
        return Promise.resolve("test-session");
      },
      getVercelProtectionBypass: () => {
        return undefined;
      },
    });
  };
  const sockets: FakeSocket[] = [];
  const received: ArrayBuffer[] = [];
  const transport = createBrowserRunWssTransport(RUN_ID, createClient, {
    onFrame: (frame) => {
      return received.push(frame);
    },
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  expect(bootstrapCalls).toBe(0);
  expect(transport.send(new ArrayBuffer(1))).toBeFalsy();
  const connected = transport.connect(context.signal);
  const socket = await firstSocket(sockets);
  expect(socket.url).toBe(URL);
  expect(socket.binaryType).toBe("arraybuffer");
  expect(socket.sent).toStrictEqual([]);
  socket.open();
  expect(socket.sent).toStrictEqual([
    JSON.stringify({ runId: RUN_ID, ticket: TICKET }),
  ]);
  expect(transport.send(new ArrayBuffer(1))).toBeFalsy();
  socket.message(JSON.stringify({ type: "auth.ok" }));
  await connected;
  const outbound = new ArrayBuffer(4);
  expect(transport.send(outbound)).toBeTruthy();
  expect(socket.sent[1]).toBe(outbound);
  const inbound = new ArrayBuffer(2);
  socket.message(inbound);
  expect(received).toStrictEqual([inbound]);
  expect(bootstrapCalls).toBe(1); // API never relays payloads
  transport.close();
  expect(socket.closed).toBeTruthy();
});

test("a dead listener or denied admission reconnects with fresh bootstrap and never replays", async () => {
  let calls = 0;
  const { transport, sockets } = makeTransport(() => {
    calls++;
    return Promise.resolve({
      ...bootstrapResponse(),
      ticket: String(calls).padStart(43, "a"),
    });
  });
  const connected = transport.connect(context.signal);
  const first = await firstSocket(sockets);
  first.close(); // Runner listener exited before the handshake
  await waitFor(() => {
    return expect(sockets).toHaveLength(2);
  });
  const second = sockets[1];
  if (!second) {
    throw new Error("Missing replacement socket");
  }
  second.open();
  expect(second.sent[0]).toBe(
    JSON.stringify({ runId: RUN_ID, ticket: "a".repeat(42) + "2" }),
  );
  second.message(JSON.stringify({ type: "auth.denied" }));
  await waitFor(() => {
    return expect(sockets).toHaveLength(3);
  });
  const third = sockets[2];
  if (!third) {
    throw new Error("Missing third socket");
  }
  third.open();
  third.message(JSON.stringify({ type: "auth.ok" }));
  await connected;
  third.close(); // a post-auth loss also fetches a new ticket
  await expect(transport.connect(context.signal)).rejects.toThrow(
    "reconnecting",
  );
  await waitFor(() => {
    return expect(sockets).toHaveLength(4);
  });
  expect(calls).toBe(4);
  expect(transport.send(new ArrayBuffer(3))).toBeFalsy();
  expect(sockets[3]?.sent).toStrictEqual([]); // no offline replay
  sockets[3]?.close();
  await waitFor(() => {
    return expect(transport.state).toBe("failed");
  });
  expect(calls).toBe(4); // no unbounded reconnect after prior admission
});

test("malformed admission, oversized frames and buffered backpressure fail closed", async () => {
  const frames: ArrayBuffer[] = [];
  const { transport, sockets } = makeTransport(
    () => {
      return Promise.resolve(bootstrapResponse());
    },
    (frame) => {
      return frames.push(frame);
    },
  );
  const connected = transport.connect(context.signal);
  const socket = await firstSocket(sockets);
  socket.open();
  socket.message("not-json");
  expect(socket.closed).toBeTruthy();
  await waitFor(() => {
    return expect(sockets).toHaveLength(2);
  });
  const replacement = sockets[1];
  if (!replacement) {
    throw new Error("Missing replacement");
  }
  replacement.open();
  replacement.message(JSON.stringify({ type: "auth.ok" }));
  await connected;
  replacement.readyState = WebSocket.CLOSING;
  expect(transport.send(new ArrayBuffer(1))).toBeFalsy();
  replacement.readyState = WebSocket.OPEN;
  replacement.bufferedAmount = RUN_WSS_MAX_BUFFERED_BYTES;
  expect(transport.send(new ArrayBuffer(1))).toBeFalsy();
  expect(() => {
    return transport.send(new ArrayBuffer(RUN_WSS_MAX_FRAME_BYTES + 1));
  }).toThrow(RangeError);
  replacement.bufferedAmount = 0;
  replacement.message(new ArrayBuffer(RUN_WSS_MAX_FRAME_BYTES + 1));
  expect(replacement.closed).toBeTruthy();
  expect(frames).toStrictEqual([]);
  transport.close();
});

test("an unsolicited auth acknowledgement before the first frame never opens the channel", async () => {
  const { transport, sockets } = makeTransport(() => {
    return Promise.resolve(bootstrapResponse());
  });
  const pending = transport.connect(context.signal);
  const socket = await firstSocket(sockets);
  socket.message(JSON.stringify({ type: "auth.ok" }));
  expect(socket.closed).toBeTruthy();
  expect(socket.sent).toStrictEqual([]);
  transport.close();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("repeated listener failure stops after the bounded fresh bootstrap budget", async () => {
  let calls = 0;
  const sockets: FakeSocket[] = [];
  const transport = new RunWssTransport(
    RUN_ID,
    () => {
      calls++;
      return Promise.resolve({ kind: "transient" as const });
    },
    {
      onFrame: () => {
        return undefined;
      },
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    },
  );
  await expect(transport.connect(context.signal)).rejects.toThrow(
    "unavailable",
  );
  expect(calls).toBe(4);
  expect(sockets).toStrictEqual([]);
  expect(transport.state).toBe("failed");
});

test("expired tickets and unsafe URLs never open a socket", async () => {
  let calls = 0;
  const { transport, sockets } = makeTransport(() => {
    calls++;
    if (calls === 1) {
      return Promise.resolve({
        ...bootstrapResponse(),
        expiresAt: "2000-01-01T00:00:00Z",
      });
    }
    return Promise.resolve(bootstrapResponse(`${URL}?ticket=${TICKET}`));
  });
  await expect(transport.connect(context.signal)).rejects.toThrow(
    "unavailable",
  );
  expect(calls).toBe(2);
  expect(sockets).toStrictEqual([]);
  expect(transport.state).toBe("failed");
});

test("terminal unowned Run stops bootstrap retry and cancellation closes a pending socket", async () => {
  let calls = 0;
  context.mocks.api(runnerWssTicketsContract.bootstrap, ({ respond }) => {
    calls++;
    return respond(404, { error: { code: "NOT_FOUND", message: "Not found" } });
  });
  const createClient: ApiClientFactory = (contract) => {
    return createAuthedContractClient(contract, {
      baseUrl: location.origin,
      clientVersion: "0.973.2",
      getToken: () => {
        return Promise.resolve("test-session");
      },
      getVercelProtectionBypass: () => {
        return undefined;
      },
    });
  };
  const terminal = createBrowserRunWssTransport(RUN_ID, createClient, {
    onFrame: () => {
      return undefined;
    },
    createSocket: () => {
      return new FakeSocket(URL);
    },
  });
  await expect(terminal.connect(context.signal)).rejects.toThrow("unavailable");
  expect(calls).toBe(1);

  const resetOwner$ = resetSignal();
  const ownerSignal = context.store.set(resetOwner$, context.signal);
  const { transport, sockets } = makeTransport(() => {
    return Promise.resolve(bootstrapResponse());
  });
  const pending = transport.connect(ownerSignal);
  const socket = await firstSocket(sockets);
  context.store.set(resetOwner$);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(socket.closed).toBeTruthy();
  expect(transport.state).toBe("closed");
  socket.open(); // late callbacks cannot send a credential
  expect(socket.sent).toStrictEqual([]);
});
