import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { HttpResponse, http } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import {
  createBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-fixture";

const context = testContext();
const { fixture, open, view, renew } = createBrowserFixtures(context);
const chatApi = createChatFilesBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const query = Object.freeze({ viewer: "native" as const });

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

test.each(["get", "open"] as const)(
  "%s acquires presentation and viewer with one provider observation",
  async (entry) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      const first = await open(a);
      let reads = 0;
      let discoveries = 0;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/:id`, () => {
          reads++;
        }),
        http.get("https://*/json/version", () => {
          discoveries++;
        }),
      );
      const params = { threadId: a.threadId };
      const response = await accept(
        entry === "get"
          ? client().get({ headers, params, query })
          : client().open({ headers, params, query, body: {} }),
        [200],
      );
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.body.viewer).toMatchObject({
        browser: response.body.browser,
        cdpUrl: f.provider.native.url,
      });
      expect(response.body.browser.window).toStrictEqual(first.window);
      expect(reads).toBe(1);
      expect(discoveries).toBe(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect((await view(a)).window).toStrictEqual(first.window);
    });
  },
);

test("read acquisition does not create a missing Browser and preserves stopped presentation", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const params = { threadId: a.threadId };
    await accept(client().get({ headers, params, query }), [404]);
    expect(f.provider.sessionRequests).toHaveLength(0);
    await open(a);
    const [id] = f.provider.sessionIds;
    if (!id) {
      throw new Error("Expected the Browser created through use");
    }
    f.provider.sessionIds.delete(id);
    f.provider.stoppedSessionIds.add(id);
    const stopped = await accept(
      client().get({ headers, params, query }),
      [200],
    );
    expect(stopped.body).toMatchObject({
      browser: { status: "suspended", liveUrl: null, idleExpiresAt: null },
      viewer: null,
    });
    expect(f.provider.sessionRequests).toHaveLength(1);
  });
});

test.each(["native", "ordinary"] as const)(
  "%s open publishes the appropriate lifecycle notification",
  async (mode) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      await open(a);
      const operationId = "44444444-4444-4444-8444-444444444444";
      const earlier = context.mocks.ably.publish.mock.calls.length;
      await accept(
        client().open({
          headers,
          params: { threadId: a.threadId },
          ...(mode === "native" ? { query } : {}),
          body: { operationId },
        }),
        [200],
      );
      const notifications = context.mocks.ably.publish.mock.calls
        .slice(earlier)
        .filter(([topic]) => {
          return topic === "browserSessionChanged";
        });
      expect(notifications).toStrictEqual([
        [
          "browserSessionChanged",
          {
            threadId: a.threadId,
            ...(mode === "native" ? { operationId } : {}),
          },
        ],
      ]);
    });
  },
);

test("native open correlates its expired-window retirement and final publication", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const first = await open(a);
    mockNow(START + 11 * MINUTE);
    const operationId = "44444444-4444-4444-8444-444444444444";
    const earlier = context.mocks.ably.publish.mock.calls.length;
    const opened = await accept(
      client().open({
        headers,
        params: { threadId: a.threadId },
        query,
        body: { operationId },
      }),
      [200],
    );
    expect(opened.body.viewer?.browser.window?.instanceId).not.toBe(
      first.window?.instanceId,
    );
    const notifications = context.mocks.ably.publish.mock.calls
      .slice(earlier)
      .filter(([topic]) => {
        return topic === "browserSessionChanged";
      });
    expect(notifications).toStrictEqual([
      ["browserSessionChanged", { threadId: a.threadId, operationId }],
      ["browserSessionChanged", { threadId: a.threadId, operationId }],
    ]);
  });
});

test("only signed-in shared callers can opt into viewer credentials", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    await open(a);
    const params = { threadId: a.threadId };
    const runHeaders = {
      authorization: `Bearer ${okouTokenFromExecution(a.execution)}`,
    };
    for (const response of [
      await client().get({ headers: runHeaders, params, query }),
      await client().open({ headers: runHeaders, params, query, body: {} }),
    ]) {
      expect(response).toMatchObject({
        status: 403,
        body: { error: { code: "BROWSER_VIEWER_SESSION_REQUIRED" } },
      });
    }
    const ordinary = await accept(
      client().get({ headers: runHeaders, params }),
      [200],
    );
    expect(ordinary.body.browser.status).toBe("active");
    expect(
      (await accept(client().get({ headers, params, query }), [200])).body
        .viewer?.browser.window,
    ).toStrictEqual(ordinary.body.browser.window);
  });
});

test.each(["get", "open"] as const)(
  "%s rechecks authorization after viewer discovery",
  async (entry) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      await open(a);
      server.use(
        http.get("https://*/json/version", async () => {
          await chatApi.updateThreadComputerUseHost(
            f.owned.actor,
            a.threadId,
            null,
            { cloudBrowserEnabled: false },
          );
        }),
      );
      const params = { threadId: a.threadId };
      const response =
        entry === "get"
          ? await client().get({ headers, params, query })
          : await client().open({ headers, params, query, body: {} });
      expect(response).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_RECLAIMING" } },
      });
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  },
);

test("a binding replaced during address discovery cannot be published", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    installBrowserWindowContentCommands(f.provider.native);
    const a = await f.start();
    const b = await f.start();
    const first = await open(a);
    const sibling = await open(b);
    mockNow(START + 9 * MINUTE);
    await renew(b);
    let replace = true;
    server.use(
      http.get("https://*/json/version", async () => {
        if (replace) {
          replace = false;
          mockNow(START + 11 * MINUTE);
          await open(a);
        }
      }),
    );
    const response = await client().get({
      headers,
      params: { threadId: a.threadId },
      query,
    });
    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_RECLAIMING" } },
    });
    expect((await view(a)).window?.primaryWindowId).not.toBe(
      first.window?.primaryWindowId,
    );
    expect((await view(b)).window).toStrictEqual(sibling.window);
  });
});

test("provider failure is returned without replaying explicit open", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const a = await f.start();
    const first = await open(a);
    server.use(
      http.get("https://*/json/version", () => {
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    const response = await client().open({
      headers,
      params: { threadId: a.threadId },
      query,
      body: {},
    });
    expect(response.status).toBe(502);
    expect(f.provider.sessionRequests).toHaveLength(1);
    expect((await view(a)).window).toStrictEqual(first.window);
  });
});
