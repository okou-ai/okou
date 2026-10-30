import { once } from "node:events";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, renew, view } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Chat = Awaited<ReturnType<Fixture["start"]>>;

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function use(chat: Chat) {
  return client().use({
    headers: { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` },
    body: {},
  });
}

function navigate(f: Fixture, windowId: number | undefined, url: string) {
  const page = [...f.provider.native.targets.values()].find((target) => {
    return target.windowId === windowId;
  });
  if (!page) {
    throw new Error("Expected the chat's native page");
  }
  page.url = url;
  return page;
}

function urls(f: Fixture, windowId: number | undefined) {
  return [...f.provider.native.targets.values()]
    .filter((target) => {
      return target.windowId === windowId;
    })
    .map((target) => {
      return target.url;
    });
}

async function save(chat: Chat) {
  await accept(
    client().close({ headers, params: { threadId: chat.threadId }, body: {} }),
    [200],
  );
}

test.each(["native window", "empty capture", "encryption"] as const)(
  "stops the last expired Browser after failed %s and restores only accepted URLs",
  async (failure) => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const first = await open(a);
      const saved = "https://a.example.test/accepted";
      const page = navigate(f, first.window?.primaryWindowId, saved);
      await save(a);
      page.url = "https://a.example.test/unsaved";
      if (failure === "native window") {
        if (first.window === undefined) {
          throw new Error("Expected A's native window");
        }
        f.provider.native.nativeWindowErrors.set(
          first.window.primaryWindowId,
          "Native window unavailable",
        );
      } else if (failure === "empty capture") {
        f.provider.native.emptySnapshot = true;
      } else {
        useSecretKmsProbe(() => {
          return Promise.reject(new Error("KMS unavailable"));
        });
      }
      mockNow(START + 11 * MINUTE);
      const restored = await open(a);
      expect(f.provider.sessionIds.size).toBe(1);
      expect(f.provider.stoppedSessionIds.size).toBe(1);
      f.provider.native.emptySnapshot = false;
      useSecretKmsProbe();
      expect(restored.window?.instanceId).not.toBe(first.window?.instanceId);
      expect(urls(f, restored.window?.primaryWindowId)).toStrictEqual([saved]);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
    });
  },
);

test.each(["native window", "encryption"] as const)(
  "retires expired A after failed %s without changing active B or importing residual URLs",
  async (failure) => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const saved = "https://a.example.test/accepted";
      const page = navigate(f, first.window?.primaryWindowId, saved);
      await save(a);
      page.url = "https://orphan.example.test/unsaved";
      mockNow(START + 9 * MINUTE);
      const leased = await renew(b);
      if (failure === "native window") {
        if (first.window === undefined) {
          throw new Error("Expected A's native window");
        }
        f.provider.native.nativeWindowErrors.set(
          first.window.primaryWindowId,
          "Native window unavailable",
        );
      } else {
        useSecretKmsProbe(() => {
          return Promise.reject(new Error("KMS unavailable"));
        });
      }
      f.provider.native.closeSucceeds = false;
      mockNow(START + 11 * MINUTE);
      const restored = await open(a);
      expect(f.provider.native.targets.get(page.targetId)).toStrictEqual(page);
      const currentB = await view(b);
      expect(currentB.window).toStrictEqual(sibling.window);
      expect(currentB.idleExpiresAt).toBe(leased.idleExpiresAt);
      expect(f.provider.stoppedSessionIds.size).toBe(0);

      f.provider.native.nativeWindowErrors.clear();
      f.provider.native.closeSucceeds = true;
      useSecretKmsProbe();
      expect(restored.window?.instanceId).toBe(first.window?.instanceId);
      expect(restored.window?.primaryWindowId).not.toBe(
        first.window?.primaryWindowId,
      );
      expect(urls(f, restored.window?.primaryWindowId)).toStrictEqual([saved]);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  },
);

test("does not expire a healthy logical window solely because native health is unavailable", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const first = await open(a);
    f.provider.native.windowError = "Native health unavailable";
    mockNow(START + 9 * MINUTE);
    expect((await use(a)).status).toBe(502);
    const current = await view(a);
    expect(current.window).toStrictEqual(first.window);
    expect(current.idleExpiresAt).toBe(first.idleExpiresAt);
    expect(f.provider.stoppedSessionIds.size).toBe(0);
    f.provider.native.windowError = undefined;
    const leased = await renew(a);
    expect(leased.window).toStrictEqual(first.window);
    expect(f.provider.sessionRequests).toHaveLength(1);
  });
});

test("stops after the last chat deletion even when its native bridge is unavailable", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const b = await f.start();
    await open(a);
    const sibling = await open(b);
    const chat = createChatFilesBddApi(context);
    f.provider.native.bridgeAvailable = false;
    await chat.deleteThread(f.owned.actor, a.threadId);
    expect((await view(b)).window).toStrictEqual(sibling.window);
    expect(f.provider.sessionIds.size).toBe(1);
    await chat.deleteThread(f.owned.actor, b.threadId);
    expect(f.provider.sessionIds.size).toBe(0);
    expect(f.provider.stoppedSessionIds.size).toBe(1);
    expect(f.provider.createdIds).toHaveLength(1);
  });
});

test("retires expired usage on failed provider lookup without treating the instance as stopped", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const first = await open(a);
    navigate(
      f,
      first.window?.primaryWindowId,
      "https://a.example.test/accepted",
    );
    await save(a);
    const [providerId] = f.provider.sessionIds;
    if (!providerId) {
      throw new Error("Expected the accepted provider instance");
    }
    let unavailable = true;
    server.use(
      http.get(`${PROVIDER_URL}/browsers/${providerId}`, () => {
        if (unavailable) {
          return HttpResponse.json(
            { detail: "Provider unavailable" },
            { status: 503 },
          );
        }
        return;
      }),
    );
    mockNow(START + 9 * MINUTE);
    expect((await use(a)).status).toBe(502);
    expect(f.provider.sessionRequests).toHaveLength(1);
    mockNow(START + 11 * MINUTE);
    await expect(use(a)).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_RECLAIMING" } },
    });
    expect(f.provider.sessionIds.has(providerId)).toBeTruthy();
    expect(f.provider.stoppedSessionIds.size).toBe(0);
    expect(f.provider.sessionRequests).toHaveLength(1);
    unavailable = false;
    const restored = await open(a);
    expect(f.provider.stoppedSessionIds.has(providerId)).toBeTruthy();
    expect(restored.window?.instanceId).not.toBe(first.window?.instanceId);
    expect(urls(f, restored.window?.primaryWindowId)).toStrictEqual([
      "https://a.example.test/accepted",
    ]);
    expect(f.provider.createdIds).toHaveLength(1);
  });
});

test("rejects late old-lifetime encryption after degraded expiry and a newer accepted snapshot", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const first = await open(a);
    const page = navigate(
      f,
      first.window?.primaryWindowId,
      "https://a.example.test/accepted",
    );
    await save(a);
    page.url = "https://a.example.test/late-old-window";
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let rejectLaterCapture = true;
    useSecretKmsProbe((request, call) => {
      if (call === 1) {
        return (async () => {
          entered.resolve();
          await release.promise;
          return {
            keyId: request.keyId,
            plaintext: Buffer.from("0123456789abcdef0123456789abcdef"),
            encryptedDataKey: Buffer.from("late-data-key"),
          };
        })();
      }
      return rejectLaterCapture
        ? Promise.reject(new Error("Later capture unavailable"))
        : undefined;
    });
    mockNow(START + 11 * MINUTE);
    const earlier = settleIncludingAbort(use(a));
    let restoredWindowId: number | undefined;
    const progressed = await settleIncludingAbort(async () => {
      await Promise.race([
        entered.promise,
        earlier.then((result) => {
          if (!result.ok) {
            throw result.error;
          }
          throw new Error("Expected retirement to reach external encryption");
        }),
      ]);
      const reopened = await open(a);
      expect(f.provider.stoppedSessionIds.size).toBe(1);
      expect(reopened.window?.instanceId).not.toBe(first.window?.instanceId);
      expect(urls(f, reopened.window?.primaryWindowId)).toStrictEqual([
        "https://a.example.test/accepted",
      ]);
      rejectLaterCapture = false;
      restoredWindowId = reopened.window?.primaryWindowId;
      navigate(f, restoredWindowId, "https://a.example.test/new-accepted");
      mockNow(START + 12 * MINUTE);
      await save(a);
    });
    release.resolve();
    const joined = await earlier;
    if (!progressed.ok) {
      throw progressed.error;
    }
    if (!joined.ok) {
      throw joined.error;
    }
    for (const [id, target] of f.provider.native.targets) {
      if (target.windowId === restoredWindowId) {
        f.provider.native.targets.delete(id);
      }
    }
    const restored = await open(a);
    expect(urls(f, restored.window?.primaryWindowId)).toStrictEqual([
      "https://a.example.test/new-accepted",
    ]);
    expect(f.provider.createdIds).toHaveLength(1);
  });
});

test("cancels silent retirement encryption at its existing deadline and stops the unused Browser", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const first = await open(a);
    const page = navigate(
      f,
      first.window?.primaryWindowId,
      "https://a.example.test/accepted",
    );
    await save(a);
    page.url = "https://a.example.test/unsaved";
    useSecretKmsProbe((_request, _call, signal) => {
      if (!signal) {
        throw new Error("Expected owned capture cancellation");
      }
      return (async () => {
        await once(signal, "abort", { signal: context.signal });
        signal.throwIfAborted();
        throw new Error("Expected the capture deadline to cancel KMS");
      })();
    });
    mockNow(START + 11 * MINUTE);
    const restored = await open(a);
    expect(f.provider.stoppedSessionIds.size).toBe(1);
    expect(restored.window?.instanceId).not.toBe(first.window?.instanceId);
    useSecretKmsProbe();
    expect(urls(f, restored.window?.primaryWindowId)).toStrictEqual([
      "https://a.example.test/accepted",
    ]);
  });
}, 20_000);
