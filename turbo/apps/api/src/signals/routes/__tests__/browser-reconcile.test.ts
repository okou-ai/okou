import { cronBrowserReconcileContract } from "@okouai/api-contracts/contracts/cron";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { http, HttpResponse } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { cronBrowserReconcileRoutes } from "../cron-browser-reconcile";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { controlBrowserDeadline } from "./helpers/browser-deadline";
import {
  createBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-fixture";

const context = testContext();
const { fixture, open, view, renew } = createBrowserFixtures(context);

function operator() {
  const app = setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
  });
  const cron = app(cronBrowserReconcileContract);
  return () => {
    return accept(
      cron.reconcile({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );
  };
}

test("checks one instance over one native wire while preserving independent window outcomes", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const reconcile = operator();
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const b = await f.start();
    const c = await f.start();
    const first = await open(a);
    const missing = await open(b);
    const unavailable = await open(c);
    for (let index = 0; index < 3; index++) {
      const thread = await createChatFilesBddApi(context).createThread(
        f.owned.actor,
        {},
      );
      await accept(
        setupApp({ context, routes: browserRoutes })(browserContract).open({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: thread.id },
          body: {},
        }),
        [200],
      );
    }
    if (!missing.window || !unavailable.window) {
      throw new Error("Expected the native Browser bindings");
    }
    for (const [id, target] of f.provider.native.targets) {
      if (target.windowId === missing.window.primaryWindowId) {
        f.provider.native.targets.delete(id);
      }
    }
    f.provider.native.nativeWindowErrors.set(
      unavailable.window.primaryWindowId,
      "Health unavailable",
    );
    let reads = 0;
    server.use(
      http.get(`${PROVIDER_URL}/browsers/:id`, () => {
        reads++;
      }),
    );
    const connections = f.provider.native.connections;
    const commands = f.provider.native.commands.length;
    const result = await reconcile();
    expect(result.body.errors).toBe(1);
    expect(reads).toBe(1);
    expect(f.provider.native.connections - connections).toBe(1);
    expect(f.provider.native.commands.slice(commands)).toHaveLength(6);
    expect((await view(a)).window).toStrictEqual(first.window);
    expect((await view(b)).status).toBe("suspended");
    expect((await view(c)).window).toStrictEqual(unavailable.window);
    f.provider.native.nativeWindowErrors.clear();
    expect((await open(c)).window).toStrictEqual(unavailable.window);
  });
});

test.each(["opening", "after-reply"] as const)(
  "retains live bindings when the shared provider connection closes %s",
  async (timing) => {
    await setupApp({
      context,
      routes: cronBrowserReconcileRoutes,
      isolatePg: true,
    });
    const reconcile = operator();
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const b = await f.start();
      const first = await open(a);
      const sibling = await open(b);
      const release = createDeferredPromise<void>(context.signal);
      let socket: Pick<WebSocket, "close"> | undefined;
      f.provider.native.onSocketConnection = (connected) => {
        socket = connected;
        if (timing === "opening") {
          connected.close(1013, "private-capacity-reason");
        }
      };
      if (timing === "after-reply") {
        f.provider.native.beforeNativeWindowReply = async (windowId) => {
          if (windowId === sibling.window?.primaryWindowId) {
            await release.promise;
          }
        };
        f.provider.native.afterWindowBoundsReply = () => {
          socket?.close(1013, "private-capacity-reason");
        };
      }
      const connections = f.provider.native.connections;
      const result = await settleIncludingAbort(reconcile());
      release.resolve();
      f.provider.native.onSocketConnection = undefined;
      f.provider.native.beforeNativeWindowReply = undefined;
      f.provider.native.afterWindowBoundsReply = undefined;
      if (!result.ok) {
        throw result.error;
      }
      expect(result.value.body.errors).toBe(timing === "opening" ? 2 : 1);
      expect(f.provider.native.connections - connections).toBe(1);
      expect((await view(a)).window).toStrictEqual(first.window);
      expect((await view(b)).window).toStrictEqual(sibling.window);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
      expect((await reconcile()).body.errors).toBe(0);
      expect((await open(b)).window).toStrictEqual(sibling.window);
    });
  },
);

test("rechecks expiry after batched health and preserves a concurrent renewal", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const reconcile = operator();
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let held = false;
    f.provider.native.beforeNativeWindowReply = async (windowId) => {
      if (!held && windowId === first.window?.primaryWindowId) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    mockNow(START + 9 * MINUTE);
    const checking = settleIncludingAbort(reconcile());
    const changed = await settleIncludingAbort(async () => {
      await entered.promise;
      const renewed = await renew(b);
      mockNow(START + 11 * MINUTE);
      return renewed;
    });
    release.resolve();
    const result = await checking;
    if (!changed.ok) {
      throw changed.error;
    }
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.body.errors).toBe(0);
    expect((await view(a)).status).toBe("suspended");
    const retained = await view(b);
    expect(retained.window).toStrictEqual(sibling.window);
    expect(retained.idleExpiresAt).toBe(changed.value.idleExpiresAt);
    expect(f.provider.stoppedSessionIds.size).toBe(0);
  });
});

test("reclaims expired usage before waiting on a live sibling's native health", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const reconcile = operator();
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const b = await f.start();
    await open(a);
    const sibling = await open(b);
    mockNow(START + 9 * MINUTE);
    await renew(b);
    mockNow(START + 11 * MINUTE);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    f.provider.native.beforeNativeWindowReply = async (windowId) => {
      if (windowId === sibling.window?.primaryWindowId) {
        entered.resolve();
        await release.promise;
      }
    };
    const checking = settleIncludingAbort(reconcile());
    const observed = await settleIncludingAbort(async () => {
      await entered.promise;
      expect((await view(a)).status).toBe("suspended");
      expect((await view(b)).window).toStrictEqual(sibling.window);
    });
    release.resolve();
    const result = await checking;
    if (!observed.ok) {
      throw observed.error;
    }
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.body.errors).toBe(0);
    expect(f.provider.stoppedSessionIds.size).toBe(0);
  });
});

test("bounds a withheld batch and recovers its retained native bindings", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const reconcile = operator();
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    const expire = controlBrowserDeadline(context);
    let expired = false;
    f.provider.native.windowReply = "withhold";
    f.provider.native.onWithheldReply = () => {
      if (!expired) {
        expired = true;
        expire();
      }
    };
    const connections = f.provider.native.connections;
    expect((await reconcile()).body.errors).toBe(2);
    expect(f.provider.native.connections - connections).toBe(1);
    expect((await view(a)).window).toStrictEqual(first.window);
    expect((await view(b)).window).toStrictEqual(sibling.window);
    f.provider.native.windowReply = "reply";
    f.provider.native.onWithheldReply = undefined;
    expect((await reconcile()).body.errors).toBe(0);
    expect(f.provider.stoppedSessionIds.size).toBe(0);
  });
});

test("does not apply a late native observation to a replacement binding", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const reconcile = operator();
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    let held = false;
    f.provider.native.beforeNativeWindowReply = async (windowId) => {
      if (!held && windowId === first.window?.primaryWindowId) {
        held = true;
        entered.resolve();
        await release.promise;
      }
    };
    const checking = settleIncludingAbort(reconcile());
    const replaced = await settleIncludingAbort(async () => {
      await entered.promise;
      for (const [id, target] of f.provider.native.targets) {
        if (target.windowId === first.window?.primaryWindowId) {
          f.provider.native.targets.delete(id);
        }
      }
      return await open(a);
    });
    release.resolve();
    const result = await checking;
    if (!replaced.ok) {
      throw replaced.error;
    }
    if (!result.ok) {
      throw result.error;
    }
    expect(replaced.value.window?.primaryWindowId).not.toBe(
      first.window?.primaryWindowId,
    );
    expect((await view(a)).window).toStrictEqual(replaced.value.window);
    expect((await view(b)).window).toStrictEqual(sibling.window);
  });
});

test("keeps health transports and overlapping native window IDs separate across instances", async () => {
  await setupApp({
    context,
    routes: cronBrowserReconcileRoutes,
    isolatePg: true,
  });
  const reconcile = operator();
  const a = await fixture();
  const first = await a.owned.run(async () => {
    const chat = await a.start();
    return { chat, browser: await open(chat) };
  });
  const b = await fixture();
  await b.owned.run(async () => {
    const chat = await b.start();
    const second = await open(chat);
    expect(first.browser.window?.primaryWindowId).toBe(
      second.window?.primaryWindowId,
    );
    expect(first.browser.window?.instanceId).not.toBe(
      second.window?.instanceId,
    );
    let reads = 0;
    server.use(
      http.get(`${PROVIDER_URL}/browsers/:id`, ({ params }) => {
        reads++;
        const owner = [a, b].find((f) => {
          return f.provider.sessionIds.has(String(params.id));
        });
        if (!owner) {
          return HttpResponse.json({}, { status: 404 });
        }
        return HttpResponse.json({
          id: params.id,
          status: "active",
          cdpUrl: owner.provider.cdpUrl,
          extensions: [TEST_BROWSER_EXTENSION],
          liveUrl: null,
          finishedAt: null,
          startedAt: new Date(START).toISOString(),
          timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
        });
      }),
    );
    const connections = [
      a.provider.native.connections,
      b.provider.native.connections,
    ];
    expect((await reconcile()).body.errors).toBe(0);
    expect(reads).toBe(2);
    expect(a.provider.native.connections - connections[0]!).toBe(1);
    expect(b.provider.native.connections - connections[1]!).toBe(1);
    expect((await view(chat)).window).toStrictEqual(second.window);
  });
  await a.owned.run(async () => {
    createRouteMocks(context).clerk.session(
      a.owned.actor.userId,
      a.owned.actor.orgId,
      a.owned.actor.orgRole,
    );
    expect((await view(first.chat)).window).toStrictEqual(first.browser.window);
  });
});
