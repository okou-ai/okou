import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http } from "msw";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import {
  deleteFeatureSwitchesForUser,
  updateFeatureSwitchesForUser,
} from "./helpers/feature-switches";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, profileProvider } = createSharedBrowserFixtures(context);
const chat = createChatFilesBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
type Fixture = Awaited<ReturnType<typeof fixture>>;

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

async function createThread(f: Fixture, cloudBrowserEnabled = true) {
  const thread = await chat.createThread(f.owned.actor, {
    agentId: f.owned.agentId,
  });
  await chat.updateThreadComputerUseHost(f.owned.actor, thread.id, null, {
    cloudBrowserEnabled,
  });
  return { threadId: thread.id };
}

async function open(params: { readonly threadId: string }) {
  const result = await accept(
    client().open({ headers, params, body: {} }),
    [200],
  );
  return result.body.browser;
}

test("manages and recovers two no-Run chat windows in one shared Browser", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const native = installBrowserWindowContentCommands(f.provider.native);
    const a = await createThread(f);
    const b = await createThread(f);
    const first = await open(a);
    const sibling = await open(b);
    expect(first.window).toBeDefined();
    expect(first.window?.primaryWindowId).toBe(0);
    expect(sibling.window?.instanceId).toBe(first.window?.instanceId);
    expect(sibling.window?.primaryWindowId).not.toBe(
      first.window?.primaryWindowId,
    );
    expect((await open(a)).window).toStrictEqual(first.window);
    const viewed = await accept(client().get({ headers, params: a }), [200]);
    expect(viewed.body.browser.window).toStrictEqual(first.window);
    const connection = await accept(
      client().viewerConnection({ headers, params: a }),
      [200],
    );
    expect(connection.body.cdpUrl).toBe(f.provider.native.url);
    expect(connection.body.browser.window).toStrictEqual(first.window);
    const resized = await accept(
      client().resizeByThread({
        headers,
        params: a,
        body: { aspectRatio: 2 },
      }),
      [200],
    );
    expect(resized.body.browser.window).toStrictEqual(first.window);
    expect(
      native.sizes.get(Number(first.window?.primaryWindowId)),
    ).toStrictEqual({
      width: 1440,
      height: 720,
    });
    const page = [...f.provider.native.targets.values()].find((target) => {
      return target.windowId === first.window?.primaryWindowId;
    });
    if (!page) {
      throw new Error("Expected the first chat's native page");
    }
    page.url = "https://a.example.test/before-first-message";
    await accept(client().close({ headers, params: a, body: {} }), [200]);
    mockNow(START + 9 * MINUTE);
    const leased = await accept(
      client().leaseByThread({ headers, params: b, body: {} }),
      [200],
    );
    expect(leased.body.browser.idleExpiresAt).toBe(
      new Date(START + 19 * MINUTE).toISOString(),
    );
    mockNow(START + 11 * MINUTE);
    const recovered = await open(a);
    expect(recovered.window?.instanceId).toBe(first.window?.instanceId);
    expect(recovered.window?.primaryWindowId).not.toBe(
      first.window?.primaryWindowId,
    );
    expect(
      [...f.provider.native.targets.values()]
        .filter((target) => {
          return target.windowId === recovered.window?.primaryWindowId;
        })
        .map((target) => {
          return target.url;
        }),
    ).toStrictEqual([page.url]);
    const unchanged = await accept(client().get({ headers, params: b }), [200]);
    expect(unchanged.body.browser.window).toStrictEqual(sibling.window);
    expect(unchanged.body.browser.idleExpiresAt).toBe(
      leased.body.browser.idleExpiresAt,
    );
    expect(f.provider.createdIds).toHaveLength(1);
    expect(f.provider.sessionRequests).toHaveLength(1);
    const runs = await createRunReadsApi(context).requestListLogs(
      f.owned.actor,
      { limit: 10 },
      [200],
    );
    expect(runs.body.data).toStrictEqual([]);
    await chat.deleteThread(f.owned.actor, a.threadId);
    await flushWaitUntilForTest();
    expect(f.provider.sessionIds.size).toBe(1);
    await chat.deleteThread(f.owned.actor, b.threadId);
    await flushWaitUntilForTest();
    expect(f.provider.sessionIds.size).toBe(0);
  });
});

test("requires cloud-browser authorization for a no-Run chat", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const params = await createThread(f, false);
    const result = await client().open({ headers, params, body: {} });
    expect(result).toMatchObject({
      status: 403,
      body: { error: { code: "BROWSER_AUTHORIZATION_REQUIRED" } },
    });
    expect(f.provider.createdIds).toHaveLength(0);
    expect(f.provider.sessionRequests).toHaveLength(0);
  });
});

test("preserves the legacy no-Run rejection when shared ownership is disabled", async () => {
  const f = await fixture(false);
  await f.owned.run(async () => {
    const params = await createThread(f);
    await expect(
      client().open({ headers, params, body: {} }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_RUN_REQUIRED" } },
    });
    expect(f.provider.sessionRequests).toHaveLength(0);
  });
});

test("keeps no-Run chat access scoped to both the user and organization", async () => {
  const owner = await fixture();
  const params = await owner.owned.run(async () => {
    const thread = await createThread(owner);
    await open(thread);
    return thread;
  });
  const foreign = await fixture();
  await foreign.owned.run(async () => {
    for (const actor of [
      { ...foreign.featureActor, orgId: owner.featureActor.orgId },
      { ...owner.featureActor, orgId: foreign.featureActor.orgId },
    ]) {
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      const checked = await settleIncludingAbort(async () => {
        for (const response of [
          await client().get({ headers, params }),
          await client().open({ headers, params, body: {} }),
          await client().viewerConnection({ headers, params }),
          await client().leaseByThread({ headers, params, body: {} }),
          await client().resizeByThread({
            headers,
            params,
            body: { aspectRatio: 2 },
          }),
          await client().close({ headers, params, body: {} }),
        ]) {
          expect(response).toMatchObject({
            status: 404,
            body: { error: { code: "BROWSER_NOT_FOUND" } },
          });
        }
      });
      const cleaned = await settleIncludingAbort(
        deleteFeatureSwitchesForUser(context, actor),
      );
      if (!checked.ok) {
        throw checked.error;
      }
      if (!cleaned.ok) {
        throw cleaned.error;
      }
    }
    expect(foreign.provider.sessionRequests).toHaveLength(0);
  });
});

test.each(["profile", "instance"] as const)(
  "rejects publication when a no-Run chat's authorization is revoked during %s preparation",
  async (phase) => {
    const f = await fixture(
      true,
      profileProvider(async () => {
        if (phase === "profile") {
          await revoke();
        }
      }),
    );
    let params: { readonly threadId: string };
    async function revoke() {
      await chat.updateThreadComputerUseHost(
        f.owned.actor,
        params.threadId,
        null,
        {
          cloudBrowserEnabled: false,
        },
      );
    }
    await f.owned.run(async () => {
      params = await createThread(f);
      if (phase === "instance") {
        server.use(
          http.post(
            `${PROVIDER_URL}/browsers`,
            async () => {
              await revoke();
            },
            { once: true },
          ),
        );
      }
      const result = await client().open({ headers, params, body: {} });
      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_RECLAIMING" } },
      });
      expect(f.provider.sessionIds.size).toBe(0);
      expect(f.provider.stoppedSessionIds.size).toBe(
        phase === "instance" ? 1 : 0,
      );
      if (phase === "profile") {
        for (const id of f.provider.createdIds) {
          expect((await fetch(`${PROVIDER_URL}/profiles/${id}`)).status).toBe(
            404,
          );
        }
      }
      await expect(client().get({ headers, params })).resolves.toMatchObject({
        status: 403,
        body: { error: { code: "BROWSER_AUTHORIZATION_REQUIRED" } },
      });
    });
  },
);

test.each(["revoked", "deleted"] as const)(
  "cleans a no-Run chat's candidate window when %s and preserves its sibling",
  async (change) => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await createThread(f);
      const sibling = await open(a);
      const b = await createThread(f);
      f.provider.native.beforeCreateReply = async () => {
        if (change === "deleted") {
          await chat.deleteThread(f.owned.actor, b.threadId);
        } else {
          await chat.updateThreadComputerUseHost(
            f.owned.actor,
            b.threadId,
            null,
            {
              cloudBrowserEnabled: false,
            },
          );
        }
      };
      const result = await client().open({ headers, params: b, body: {} });
      expect(result).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_RECLAIMING" } },
      });
      expect([...f.provider.native.targets.values()]).toMatchObject([
        { windowId: sibling.window?.primaryWindowId },
      ]);
      const unchanged = await accept(
        client().get({ headers, params: a }),
        [200],
      );
      expect(unchanged.body.browser.window).toStrictEqual(sibling.window);
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);
    });
  },
);

test("keeps Run tokens scoped to their live Run while session Browser ownership is independent", async () => {
  const f = await fixture();
  await f.owned.run(async () => {
    const run = await f.start();
    const runHeaders = {
      authorization: `Bearer ${okouTokenFromClaim(run.claim)}`,
    };
    const own = await accept(
      client().use({ headers: runHeaders, body: {} }),
      [200],
    );
    const params = await createThread(f);
    const manual = await open(params);
    for (const response of [
      await client().get({ headers: runHeaders, params }),
      await client().open({ headers: runHeaders, params, body: {} }),
      await client().leaseByThread({ headers: runHeaders, params, body: {} }),
      await client().resizeByThread({
        headers: runHeaders,
        params,
        body: { aspectRatio: 2 },
      }),
      await client().close({ headers: runHeaders, params, body: {} }),
    ]) {
      expect(response.status).toBe(404);
    }
    await createWebhookCallbackApi(context).requestAgentComplete(
      { runId: run.runId, exitCode: 1, error: "The calling Run finished" },
      { authorization: `Bearer ${run.claim.sandboxToken}` },
      [200],
    );
    await expect(
      client().use({ headers: runHeaders, body: {} }),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_RUN_ENDED" } },
    });
    expect((await open({ threadId: run.threadId })).window).toStrictEqual(
      own.body.browser.window,
    );
    expect((await open(params)).window).toStrictEqual(manual.window);
  });
});
