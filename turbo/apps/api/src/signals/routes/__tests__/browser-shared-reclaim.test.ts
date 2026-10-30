import { once } from "node:events";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture } = createSharedBrowserFixtures(context);
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
async function open(chat: Chat) {
  const result = await accept(use(chat), [200]);
  const window = result.body.browser.window;
  if (!window) {
    throw new Error("Expected the public Browser's assigned native window");
  }
  return { ...result.body, window };
}
function pages(f: Fixture, windowId: number) {
  return [...f.provider.native.targets.values()].filter((page) => {
    return page.windowId === windowId;
  });
}
function navigate(f: Fixture, windowId: number, url: string) {
  const page = pages(f, windowId)[0];
  if (!page) {
    throw new Error("Expected an external native page");
  }
  page.url = url;
  return page;
}
async function renew(chat: Chat) {
  return await accept(
    client().leaseByThread({
      headers,
      params: { threadId: chat.threadId },
      body: {},
    }),
    [200],
  );
}

describe("shared Browser expiry through public reopen", () => {
  it("saves and restores expired A in the same instance while preserving active B", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      navigate(f, first.window.primaryWindowId, "https://a.example.test/task");
      const bPage = navigate(
        f,
        sibling.window.primaryWindowId,
        "https://b.example.test/task",
      );
      mockNow(START + 9 * MINUTE);
      const leasedB = await renew(b);
      mockNow(START + 11 * MINUTE);
      const reopened = await open(a);
      expect(reopened.window.instanceId).toBe(first.window.instanceId);
      expect(reopened.window.primaryWindowId).not.toBe(
        first.window.primaryWindowId,
      );
      expect(
        pages(f, reopened.window.primaryWindowId).map((page) => {
          return page.url;
        }),
      ).toStrictEqual(["https://a.example.test/task"]);
      expect(f.provider.native.targets.get(bPage.targetId)).toStrictEqual(
        bPage,
      );
      const currentB = await accept(
        client().get({ headers, params: { threadId: b.threadId } }),
        [200],
      );
      expect(currentB.body.browser.window).toStrictEqual(sibling.window);
      expect(currentB.body.browser.idleExpiresAt).toBe(
        leasedB.body.browser.idleExpiresAt,
      );
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it("stops after all windows expire and recreates only A using the same profile", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      navigate(
        f,
        first.window.primaryWindowId,
        "https://a.example.test/recover",
      );
      navigate(
        f,
        sibling.window.primaryWindowId,
        "https://b.example.test/recover",
      );
      server.use(
        http.patch(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
          if (f.provider.sessionIds.has(String(params.id))) {
            expect(f.provider.native.targets.size).toBe(0);
          }
          return;
        }),
      );
      mockNow(START + 11 * MINUTE);
      const reopened = await open(a);
      expect(reopened.window.instanceId).not.toBe(first.window.instanceId);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toStrictEqual([
        expect.objectContaining({ profileId: f.provider.createdIds[0] }),
        expect.objectContaining({ profileId: f.provider.createdIds[0] }),
      ]);
      expect(
        [...f.provider.native.targets.values()].map((page) => {
          return page.url;
        }),
      ).toStrictEqual(["https://a.example.test/recover"]);
      const dormant = await accept(
        client().get({ headers, params: { threadId: b.threadId } }),
        [200],
      );
      expect(dormant.body.browser.status).toBe("suspended");
      const reopenedB = await open(b);
      expect(reopenedB.window.instanceId).toBe(reopened.window.instanceId);
      expect(
        pages(f, reopenedB.window.primaryWindowId).map((page) => {
          return page.url;
        }),
      ).toStrictEqual(["https://b.example.test/recover"]);
      expect(f.provider.sessionRequests).toHaveLength(2);
    });
  });

  it("preserves recovery after required native capture fails until normal reopen reconciles it", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const aPage = navigate(
        f,
        first.window.primaryWindowId,
        "https://a.example.test/saved",
      );
      mockNow(START + 9 * MINUTE);
      await renew(b);
      mockNow(START + 11 * MINUTE);
      f.provider.native.windowError = "Provider unavailable";
      const blocked = await use(a);
      expect(blocked.status).toBe(409);
      expect(f.provider.native.targets.get(aPage.targetId)).toStrictEqual(
        aPage,
      );
      expect(f.provider.sessionRequests).toHaveLength(1);
      f.provider.native.windowError = undefined;
      const recovered = await open(a);
      expect(recovered.window.instanceId).toBe(first.window.instanceId);
      expect(
        pages(f, recovered.window.primaryWindowId).map((page) => {
          return page.url;
        }),
      ).toStrictEqual(["https://a.example.test/saved"]);
      expect(pages(f, sibling.window.primaryWindowId)).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it.each(["failed", "accepted", "lost-response"] as const)(
    "waits for a confirmed provider stop after a %s stop request",
    async (response) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const first = await open(a);
        navigate(
          f,
          first.window.primaryWindowId,
          "https://a.example.test/confirmed",
        );
        let stopAllowed = false;
        let missingSession: string | null = null;
        server.use(
          http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
            if (String(params.id) === missingSession) {
              return HttpResponse.json(
                { detail: "Browser missing" },
                { status: 404 },
              );
            }
            return;
          }),
          http.patch(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
            if (stopAllowed || !f.provider.sessionIds.has(String(params.id))) {
              return;
            }
            if (response === "lost-response") {
              missingSession = String(params.id);
              f.provider.sessionIds.delete(missingSession);
              return HttpResponse.error();
            }
            return response === "failed"
              ? HttpResponse.json(
                  { detail: "Provider unavailable" },
                  { status: 503 },
                )
              : HttpResponse.json({ status: "active" }, { status: 202 });
          }),
        );
        mockNow(START + 11 * MINUTE);
        const blocked = await use(a);
        expect(blocked.status).toBe(409);
        expect(f.provider.native.targets.size).toBe(0);
        expect(f.provider.sessionIds.size).toBe(
          response === "lost-response" ? 0 : 1,
        );
        expect(f.provider.sessionRequests).toHaveLength(1);
        stopAllowed = true;
        const recovered = await open(a);
        expect(recovered.window.instanceId).not.toBe(first.window.instanceId);
        expect(f.provider.createdIds).toHaveLength(1);
        expect(f.provider.sessionIds.size).toBe(1);
        expect(f.provider.sessionRequests).toHaveLength(2);
        expect(
          pages(f, recovered.window.primaryWindowId).map((page) => {
            return page.url;
          }),
        ).toStrictEqual(["https://a.example.test/confirmed"]);
      });
    },
  );

  it("retains the complete snapshot after partial native closure and sidebar capture", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const page = navigate(
        f,
        first.window.primaryWindowId,
        "https://a.example.test/first",
      );
      const second = {
        targetId: "second-expired-page",
        windowId: first.window.primaryWindowId,
        url: "https://a.example.test/second",
      };
      f.provider.native.targets.set(second.targetId, second);
      mockNow(START + 9 * MINUTE);
      await renew(b);
      mockNow(START + 11 * MINUTE);
      f.provider.native.beforeCloseWindowReply = (windowId) => {
        if (windowId === first.window.primaryWindowId) {
          f.provider.native.targets.delete(page.targetId);
          f.provider.native.closed.push(page.targetId);
          f.provider.native.closeSucceeds = false;
        }
      };
      const reopened = await open(a);
      expect(f.provider.native.targets.has(page.targetId)).toBeFalsy();
      expect(f.provider.native.targets.get(second.targetId)).toStrictEqual(
        second,
      );
      await accept(
        client().close({
          headers,
          params: { threadId: a.threadId },
          body: {},
        }),
        [200],
      );
      f.provider.native.beforeCloseWindowReply = undefined;
      f.provider.native.closeSucceeds = true;
      expect(reopened.window.instanceId).toBe(first.window.instanceId);
      expect(
        pages(f, reopened.window.primaryWindowId).map((target) => {
          return target.url;
        }),
      ).toStrictEqual([
        "https://a.example.test/first",
        "https://a.example.test/second",
      ]);
      expect(pages(f, sibling.window.primaryWindowId)).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it("keeps the winning complete snapshot when an overlapping reclaim observes a partial close", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      await open(b);
      const page = navigate(
        f,
        first.window.primaryWindowId,
        "https://a.example.test/first",
      );
      const second = {
        targetId: "second-overlapping-page",
        windowId: first.window.primaryWindowId,
        url: "https://a.example.test/second",
      };
      f.provider.native.targets.set(second.targetId, second);
      mockNow(START + 9 * MINUTE);
      await renew(b);
      mockNow(START + 11 * MINUTE);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let hold = true;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, async ({ params }) => {
          if (hold && f.provider.sessionIds.has(String(params.id))) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
          return;
        }),
      );
      f.provider.native.beforeCloseWindowReply = (windowId) => {
        if (windowId === first.window.primaryWindowId) {
          f.provider.native.targets.delete(page.targetId);
          f.provider.native.closed.push(page.targetId);
          f.provider.native.closeSucceeds = false;
        }
      };
      const earlier = settleIncludingAbort(use(a));
      const completed = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          earlier.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("The earlier reclaim did not reach provider IO");
          }),
        ]);
        expect((await use(a)).status).toBe(200);
        expect(f.provider.native.targets.has(page.targetId)).toBeFalsy();
        expect(f.provider.native.targets.has(second.targetId)).toBeTruthy();
      });
      release.resolve();
      const loser = await earlier;
      if (!completed.ok) {
        throw completed.error;
      }
      if (!loser.ok) {
        throw loser.error;
      }
      expect(loser.value.status).toBe(200);
      f.provider.native.beforeCloseWindowReply = undefined;
      f.provider.native.closeSucceeds = true;
      const reopened = await open(a);
      expect(
        pages(f, reopened.window.primaryWindowId).map((target) => {
          return target.url;
        }),
      ).toStrictEqual([
        "https://a.example.test/first",
        "https://a.example.test/second",
      ]);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it("cancels an unacknowledged stop at the real provider deadline and retains it for reconciliation", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const first = await open(a);
      const cancelled = createDeferredPromise<void>(context.signal);
      let withhold = true;
      server.use(
        http.patch(
          `${PROVIDER_URL}/browsers/:id`,
          async ({ params, request }) => {
            if (!withhold || !f.provider.sessionIds.has(String(params.id))) {
              return;
            }
            if (!request.signal.aborted) {
              await once(request.signal, "abort", { signal: context.signal });
            }
            cancelled.resolve();
            return HttpResponse.error();
          },
        ),
      );
      mockNow(START + 11 * MINUTE);
      const blocked = await use(a);
      await cancelled.promise;
      expect(blocked.status).toBe(409);
      expect(f.provider.sessionRequests).toHaveLength(1);
      withhold = false;
      const recovered = await open(a);
      expect(recovered.window.instanceId).not.toBe(first.window.instanceId);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
    });
  }, 20_000);

  it("reuses a renewed window instead of reclaiming it at its earlier deadline", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const first = await open(a);
      const page = navigate(
        f,
        first.window.primaryWindowId,
        "https://a.example.test/working",
      );
      mockNow(START + 9 * MINUTE);
      await renew(a);
      mockNow(START + 11 * MINUTE);
      const stillActive = await open(a);
      expect(stillActive.window).toStrictEqual(first.window);
      expect(f.provider.native.targets.get(page.targetId)).toStrictEqual(page);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it("leaves an intentionally moved page in its current sibling window", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const moved = navigate(
        f,
        first.window.primaryWindowId,
        "https://a.example.test/moved",
      );
      moved.windowId = sibling.window.primaryWindowId;
      mockNow(START + 9 * MINUTE);
      await renew(b);
      mockNow(START + 11 * MINUTE);
      const reopened = await open(a);
      expect(reopened.window.instanceId).toBe(sibling.window.instanceId);
      expect(f.provider.native.targets.get(moved.targetId)?.windowId).toBe(
        sibling.window.primaryWindowId,
      );
      expect(pages(f, sibling.window.primaryWindowId)).toHaveLength(2);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });
});

describe("shared Browser teardown through chat deletion", () => {
  it.each([true, false])(
    "preserves active siblings and stops after the last deletion with admission enabled=%s",
    async (enabled) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const b = await f.start();
        const first = await open(a);
        const sibling = await open(b);
        const bPage = navigate(
          f,
          sibling.window.primaryWindowId,
          "https://b.example.test/active",
        );
        if (!enabled) {
          await updateFeatureSwitchesForUser(context, f.featureActor, {
            [FeatureSwitchKey.BrowserSharedOwner]: false,
          });
        }
        const chat = createChatFilesBddApi(context);
        await chat.deleteThread(f.owned.actor, a.threadId);
        expect(pages(f, first.window.primaryWindowId)).toHaveLength(0);
        expect(f.provider.native.targets.get(bPage.targetId)).toStrictEqual(
          bPage,
        );
        expect(f.provider.sessionIds.size).toBe(1);
        const active = await accept(
          client().get({ headers, params: { threadId: b.threadId } }),
          [200],
        );
        expect(active.body.browser.window).toStrictEqual(sibling.window);
        await chat.deleteThread(f.owned.actor, b.threadId);
        expect(f.provider.native.targets.size).toBe(0);
        expect(f.provider.sessionIds.size).toBe(0);
        expect(f.provider.createdIds).toHaveLength(1);
      });
    },
  );
});
