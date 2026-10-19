import { expect, test } from "vitest";
import { runnerWssTicketsContract } from "@okouai/api-contracts/contracts/runner-wss-tickets";
import {
  decodeSandboxChannelFrame,
  encodeSandboxChannelFrame,
  type SandboxChannelMessage,
} from "@okouai/api-contracts/contracts/sandbox-channel";
import {
  sandboxFsCategory,
  SANDBOX_FS_VERSION,
  sandboxFsList,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import { createBrowserSandboxChannelPeer } from "../sandbox-channel-peer.ts";
import { createAuthedContractClient } from "../../signals/api-client-base.ts";
import type { ApiClientFactory } from "../../signals/api-client.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { now } from "../time.ts";

const context = testContext();
const RUN_ID = "d0000000-0000-4000-a000-000000000911";

class Socket extends EventTarget {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  readonly application: SandboxChannelMessage[] = [];
  admission: unknown;
  readonly responses = [
    { categories: { fs: SANDBOX_FS_VERSION } },
    {
      listingId: "home",
      entries: [
        {
          nameToken: "d29ya3NwYWNl",
          displayName: "workspace",
          kind: "directory",
        },
      ],
      nextCursor: null,
    },
  ];
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
      this.dispatchEvent(
        new MessageEvent("message", { data: '{"type":"auth.ok"}' }),
      );
    });
  }
  send(data: unknown): void {
    if (typeof data === "string") {
      this.admission = JSON.parse(data);
      return;
    }
    if (!(data instanceof ArrayBuffer)) {
      throw new Error("binary frame required");
    }
    const request = decodeSandboxChannelFrame(data);
    this.application.push(request);
    if (request.type !== "request" && request.type !== "hello") {
      throw new Error("call required");
    }
    const result = this.responses.shift();
    if (!result) {
      throw new Error("unexpected operation");
    }
    const response = encodeSandboxChannelFrame({
      schemaVersion: 1,
      type: "response",
      id: "00000000-0000-4000-8000-000000000001",
      requestId: request.id,
      result,
    });
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

test("the inert Platform factory uses authenticated bootstrap and shared business readiness", async () => {
  context.mocks.api(runnerWssTicketsContract.bootstrap, ({ respond }) => {
    return respond(200, {
      wssUrl: `wss://runner.example.com:443/ws/${RUN_ID}`,
      ticket: "a".repeat(43),
      expiresAt: new Date(now() + 30_000).toISOString(),
    });
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
  let remote: Socket | undefined;
  const peer = createBrowserSandboxChannelPeer(RUN_ID, createClient, {
    categories: [sandboxFsCategory],
    createSocket: () => {
      remote = new Socket();
      return remote;
    },
  });
  expect(peer.state).toBe("idle");
  expect(remote).toBeUndefined();
  await peer.connect(context.signal);
  expect(peer.state).toBe("ready");
  expect(remote?.admission).toMatchObject({
    runId: RUN_ID,
    ticket: "a".repeat(43),
  });
  const page = await peer.call(sandboxFsList, { path: [] }, context.signal);
  expect(page).toStrictEqual({
    listingId: "home",
    entries: [
      {
        nameToken: "d29ya3NwYWNl",
        displayName: "workspace",
        kind: "directory",
      },
    ],
    nextCursor: null,
  });
  expect(remote?.application).toMatchObject([
    { type: "hello", categories: { fs: SANDBOX_FS_VERSION } },
    {
      type: "request",
      category: "fs",
      operation: "list",
      params: { path: [] },
    },
  ]);
  peer.close();
  expect(remote?.readyState).toBe(WebSocket.CLOSED);
});
