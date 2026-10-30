import { expect, it } from "vitest";
import { OkouBrowserClient, type CdpEvent } from "../index";

it("an aborted attachment still releases its late native session", async () => {
  const abort = new AbortController();
  const commands: {
    method: string;
    params: Readonly<Record<string, unknown>>;
    sessionId: string | undefined;
  }[] = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const pending = OkouBrowserClient.connect({
    runtimeId: "a".repeat(32),
    signal: abort.signal,
    transport: {
      async request(method, params, sessionId) {
        commands.push({ method, params, sessionId });
        if (method === "Target.attachToBrowserTarget") {
          abort.abort();
          return { sessionId: "late-owned-browser-session" };
        }
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
  await expect(pending).rejects.toMatchObject({
    name: "BrowserBridgeError",
    kind: "unavailable",
  });
  expect(listeners.size).toBe(0);
  expect(commands).toStrictEqual([
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
