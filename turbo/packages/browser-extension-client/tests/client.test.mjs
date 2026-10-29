import { test } from "node:test";
import assert from "node:assert/strict";
import { OkouBrowserClient } from "../src/index.ts";

test("an aborted attachment still releases its late native session", async () => {
  const attachment = Promise.withResolvers();
  const abort = new AbortController();
  const commands = [];
  const listeners = new Set();
  const pending = OkouBrowserClient.connect({
    runtimeId: "a".repeat(32),
    signal: abort.signal,
    transport: {
      async request(method, params, sessionId) {
        commands.push({ method, params, sessionId });
        if (method === "Target.attachToBrowserTarget")
          return attachment.promise;
        return {};
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => {
          return listeners.delete(listener);
        };
      },
    },
  });
  abort.abort();
  attachment.resolve({ sessionId: "late-owned-browser-session" });
  await assert.rejects(pending, {
    name: "BrowserBridgeError",
    kind: "unavailable",
  });
  assert.equal(listeners.size, 0);
  assert.deepEqual(commands, [
    {
      method: "Target.attachToBrowserTarget",
      params: {},
      sessionId: undefined,
    },
    {
      method: "Target.detachFromTarget",
      params: { sessionId: "late-owned-browser-session" },
      sessionId: undefined,
    },
  ]);
});
