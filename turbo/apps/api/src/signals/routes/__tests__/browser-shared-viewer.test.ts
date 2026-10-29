import { randomUUID } from "node:crypto";
import {
  browserContract,
  type BrowserViewerActivity,
} from "@okouai/api-contracts/contracts/browser";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import {
  createSharedBrowserFixtures,
  START,
  MINUTE,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, view } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function lease(threadId: string, viewerActivity?: BrowserViewerActivity) {
  return setupApp({ context, routes: browserRoutes })(
    browserContract,
  ).leaseByThread({
    headers,
    params: { threadId },
    body: viewerActivity ? { viewerActivity } : {},
  });
}

describe("shared viewer activity through the public lease endpoint", () => {
  it("does not renew an idle mounted viewer without selected-page evidence", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const original = await open(a);
      mockNow(START + 2 * MINUTE);
      expect((await lease(a.threadId)).status).toBe(409);
      expect((await view(a)).idleExpiresAt).toBe(original.idleExpiresAt);
    });
  });

  it.each([false, true])(
    "renews the selected native window rather than route A (moved=%s)",
    async (moved) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const a = await f.start();
        const b = await f.start();
        const first = await open(a);
        const sibling = await open(b);
        if (!first.window || !sibling.window) {
          throw new Error("Expected shared window bindings");
        }
        const page = [...f.provider.native.targets.values()].find((target) => {
          return (
            target.windowId ===
            (moved ? first.window : sibling.window)?.primaryWindowId
          );
        });
        if (!page) {
          throw new Error("Expected selected provider page");
        }
        if (moved) {
          f.provider.native.beforeWindowReply = (targetId) => {
            if (targetId === page.targetId) {
              page.windowId = sibling.window!.primaryWindowId;
            }
          };
        }
        mockNow(START + 2 * MINUTE);
        const result = await accept(
          lease(a.threadId, {
            instanceId: first.window.instanceId,
            pageTargetId: page.targetId,
          }),
          [200],
        );
        expect(result.body.browser.threadId).toBe(a.threadId);
        expect(result.body.browser.idleExpiresAt).toBe(first.idleExpiresAt);
        expect((await view(a)).idleExpiresAt).toBe(first.idleExpiresAt);
        expect((await view(b)).idleExpiresAt).toBe(
          new Date(START + 12 * MINUTE).toISOString(),
        );
      });
    },
  );

  it("renews an authorized selected window with native id zero", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const original = await open(a);
      const page = [...f.provider.native.targets.values()][0];
      if (!original.window || !page) {
        throw new Error("Expected shared provider page");
      }
      expect(original.window.primaryWindowId).toBe(0);
      mockNow(START + 2 * MINUTE);
      const leased = await accept(
        lease(a.threadId, {
          instanceId: original.window.instanceId,
          pageTargetId: page.targetId,
        }),
        [200],
      );
      expect(leased.body.browser.idleExpiresAt).toBe(
        new Date(START + 12 * MINUTE).toISOString(),
      );
      expect((await view(a)).idleExpiresAt).toBe(
        leased.body.browser.idleExpiresAt,
      );
    });
  });

  it("does not widen Run credentials to the selected sibling chat", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === sibling.window?.primaryWindowId;
      });
      if (!first.window || !page) {
        throw new Error("Expected shared native windows");
      }
      mockNow(START + 2 * MINUTE);
      const result = await setupApp({ context, routes: browserRoutes })(
        browserContract,
      ).leaseByThread({
        headers: { authorization: `Bearer ${okouTokenFromClaim(a.claim)}` },
        params: { threadId: a.threadId },
        body: {
          viewerActivity: {
            instanceId: first.window.instanceId,
            pageTargetId: page.targetId,
          },
        },
      });
      expect(result.status).toBe(409);
      expect((await view(a)).idleExpiresAt).toBe(first.idleExpiresAt);
      expect((await view(b)).idleExpiresAt).toBe(sibling.idleExpiresAt);
    });
  });

  it.each([
    "missing",
    "unregistered",
    "stale-instance",
    "expired",
    "lookup-error",
    "deleted-chat",
  ] as const)(
    "rejects %s evidence without renewing the route",
    async (failure) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const a = await f.start();
        const b = await f.start();
        const original = await open(a);
        const sibling = await open(b);
        if (!original.window || !sibling.window) {
          throw new Error("Expected shared window bindings");
        }
        const page = [...f.provider.native.targets.values()].find((target) => {
          return target.windowId === sibling.window?.primaryWindowId;
        });
        if (!page) {
          throw new Error("Expected selected provider page");
        }
        mockNow(START + 2 * MINUTE);
        if (failure === "missing") {
          f.provider.native.targets.delete(page.targetId);
        } else if (failure === "unregistered") {
          page.windowId = 9000;
        } else if (failure === "lookup-error") {
          f.provider.native.windowErrors.set(
            page.targetId,
            "Native lookup unavailable",
          );
        } else if (failure === "expired") {
          f.provider.native.beforeWindowReply = () => {
            mockNow(START + 11 * MINUTE);
          };
        } else if (failure === "deleted-chat") {
          f.provider.native.beforeWindowReply = async () => {
            f.provider.native.beforeWindowReply = undefined;
            await createChatFilesBddApi(context).deleteThread(
              f.owned.actor,
              b.threadId,
            );
          };
        }
        const result = await lease(a.threadId, {
          instanceId:
            failure === "stale-instance"
              ? randomUUID()
              : original.window.instanceId,
          pageTargetId: page.targetId,
        });
        expect(result.status).toBe(failure === "lookup-error" ? 502 : 409);
        expect((await view(a)).idleExpiresAt).toBe(
          failure === "expired" ? null : original.idleExpiresAt,
        );
        if (failure !== "deleted-chat" && failure !== "expired") {
          expect((await view(b)).idleExpiresAt).toBe(sibling.idleExpiresAt);
        }
      });
    },
  );
});
