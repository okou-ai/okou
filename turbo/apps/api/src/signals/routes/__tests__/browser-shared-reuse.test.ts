import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, open, view, renew } = createSharedBrowserFixtures(context);
const chatApi = createChatFilesBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function request(chat: Chat, entry: "run" | "chat" = "run") {
  return entry === "chat"
    ? client().open({ headers, params: { threadId: chat.threadId }, body: {} })
    : client().use({
        headers: { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` },
        body: {},
      });
}

test.each(["run", "chat"] as const)(
  "reuses a healthy %s Browser with one provider read and native socket",
  async (entry) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      if (!sibling.window) {
        throw new Error("Expected the sibling's native window");
      }
      f.provider.native.nativeWindowErrors.set(
        sibling.window.primaryWindowId,
        "Sibling health is unavailable",
      );
      let reads = 0;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          reads++;
        }),
      );
      const connections = f.provider.native.connections;
      const commands = f.provider.native.commands.length;
      mockNow(START + MINUTE);
      const reused = await accept(request(a, entry), [200]);
      expect(reused.body.browser.window).toStrictEqual(first.window);
      expect(reused.body.browser.idleExpiresAt).toBe(
        new Date(START + 11 * MINUTE).toISOString(),
      );
      expect(reads).toBe(1);
      expect(f.provider.native.connections - connections).toBe(1);
      expect(
        f.provider.native.commands.slice(commands).map(({ method, params }) => {
          return { method, params };
        }),
      ).toStrictEqual([
        {
          method: "Browser.getWindowBounds",
          params: { windowId: first.window?.primaryWindowId },
        },
      ]);
      expect(f.provider.sessionRequests).toHaveLength(1);
      const unchanged = await view(b);
      expect(unchanged.window).toStrictEqual(sibling.window);
      expect(unchanged.idleExpiresAt).toBe(sibling.idleExpiresAt);
    });
  },
);

test("recovers a window lost during the provider await through a fresh binding read", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    server.use(
      http.get(`${PROVIDER_URL}/browsers/:id`, () => {
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === first.window?.primaryWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
      }),
    );
    const recovered = await open(a);
    expect(recovered.window?.instanceId).toBe(first.window?.instanceId);
    expect(recovered.window?.primaryWindowId).not.toBe(
      first.window?.primaryWindowId,
    );
    expect((await view(b)).window).toStrictEqual(sibling.window);
    expect((await view(b)).idleExpiresAt).toBe(sibling.idleExpiresAt);
    expect(f.provider.sessionRequests).toHaveLength(1);
    expect(f.provider.stoppedSessionIds.size).toBe(0);
  });
});

test("recovers a confirmed stopped provider without reusing its old instance", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const first = await open(a);
    const [providerId] = f.provider.sessionIds;
    if (!providerId) {
      throw new Error("Expected an accepted provider session");
    }
    f.provider.stoppedSessionIds.add(providerId);
    f.provider.native.targets.clear();
    const recovered = await open(a);
    expect(recovered.window?.instanceId).not.toBe(first.window?.instanceId);
    expect(f.provider.sessionRequests).toHaveLength(2);
    expect((await view(a)).window).toStrictEqual(recovered.window);
  });
});

test.each(["provider", "native"] as const)(
  "returns a %s failure without retrying or reclaiming the live binding",
  async (failure) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const first = await open(a);
      let reads = 0;
      let failing = true;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          reads++;
          if (failure === "provider" && failing) {
            return HttpResponse.json({}, { status: 503 });
          }
        }),
      );
      if (failure === "native") {
        f.provider.native.windowBoundsError = {
          code: -32_000,
          message: "Native health unavailable",
        };
      }
      expect((await request(a)).status).toBe(502);
      expect(reads).toBe(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
      failing = false;
      f.provider.native.windowBoundsError = undefined;
      const unchanged = await view(a);
      expect(unchanged.window).toStrictEqual(first.window);
      expect(unchanged.idleExpiresAt).toBe(first.idleExpiresAt);
    });
  },
);

test.each(["revoked", "expired"] as const)(
  "rejects renewal when the warm binding is %s during its native check",
  async (change) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const first = await open(a);
      f.provider.native.beforeNativeWindowReply = async () => {
        f.provider.native.beforeNativeWindowReply = undefined;
        if (change === "revoked") {
          await chatApi.updateThreadComputerUseHost(
            f.owned.actor,
            a.threadId,
            null,
            { cloudBrowserEnabled: false },
          );
        } else {
          mockNow(START + 11 * MINUTE);
        }
      };
      const result = await request(a);
      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_RECLAIMING" } },
      });
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
      if (change === "revoked") {
        await chatApi.updateThreadComputerUseHost(
          f.owned.actor,
          a.threadId,
          null,
          { cloudBrowserEnabled: true },
        );
        expect((await view(a)).idleExpiresAt).toBe(first.idleExpiresAt);
      }
    });
  },
);

test("rejects a late healthy result for a replaced native binding", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    mockNow(START + 9 * MINUTE);
    await renew(b);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let hold = true;
    f.provider.native.beforeNativeWindowReply = async (windowId) => {
      if (hold && windowId === first.window?.primaryWindowId) {
        hold = false;
        entered.resolve();
        await release.promise;
      }
    };
    const earlier = settleIncludingAbort(request(a));
    const replacement = await settleIncludingAbort(async () => {
      await Promise.race([
        entered.promise,
        earlier.then((result) => {
          if (!result.ok) {
            throw result.error;
          }
          throw new Error("Expected the warm native check to remain pending");
        }),
      ]);
      // A failed native close leaves the old window present, so its delayed
      // health result can be true even after the DB binding has been replaced.
      f.provider.native.closeSucceeds = false;
      mockNow(START + 11 * MINUTE);
      return await open(a);
    });
    release.resolve();
    const completed = await earlier;
    if (!replacement.ok) {
      throw replacement.error;
    }
    if (!completed.ok) {
      throw completed.error;
    }
    expect(completed.value.status).toBe(409);
    expect(replacement.value.window?.primaryWindowId).not.toBe(
      first.window?.primaryWindowId,
    );
    expect((await view(a)).window).toStrictEqual(replacement.value.window);
    expect((await view(b)).window).toStrictEqual(sibling.window);
    expect(f.provider.sessionRequests).toHaveLength(1);
  });
});

test.each(["provider", "native"] as const)(
  "settles warm-open cancellation during the %s check without renewal",
  async (phase) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const first = await open(a);
      const controller = new AbortController();
      const cancellation = new DOMException("Open ended", "AbortError");
      const cancel = () => {
        controller.abort(cancellation);
      };
      if (phase === "provider") {
        server.use(http.get(`${PROVIDER_URL}/browsers/:id`, cancel));
      } else {
        f.provider.native.beforeNativeWindowReply = cancel;
      }
      const result = await settleIncludingAbort(
        setupApp({
          context,
          routes: browserRoutes,
          signal: AbortSignal.any([context.signal, controller.signal]),
          rethrowErrors: true,
        })(browserContract).use({
          headers: {
            authorization: `Bearer ${okouTokenFromClaim(a.claim)}`,
          },
          body: {},
        }),
      );
      expect(result).toStrictEqual({ ok: false, error: cancellation });
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
      f.provider.native.beforeNativeWindowReply = undefined;
      expect((await view(a)).idleExpiresAt).toBe(first.idleExpiresAt);
    });
  },
);
