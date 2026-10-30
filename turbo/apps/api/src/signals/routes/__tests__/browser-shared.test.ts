import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { createBddApi } from "./helpers/api-bdd";
import { installBrowserWindowContentCommands } from "./helpers/browser-native-window";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { uniqueSlackUserId } from "./helpers/slack-public-install";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import {
  createSharedBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-shared-fixture";

const context = testContext();
const { fixture, view, renew } = createSharedBrowserFixtures(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}
type Chat = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["start"]>>;
function runHeaders(chat: Chat) {
  return { authorization: `Bearer ${okouTokenFromClaim(chat.claim)}` };
}
async function use(chat: Chat) {
  return (
    await accept(client().use({ headers: runHeaders(chat), body: {} }), [200])
  ).body;
}

describe("shared Browser public consumers", () => {
  it("authorizes native viewing of an active Browser without a provider live URL", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const a = await f.start();
      await use(a);
      const [providerSessionId] = f.provider.sessionIds;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/${providerSessionId}`, () => {
          return HttpResponse.json({
            id: providerSessionId,
            status: "active",
            liveUrl: null,
            cdpUrl: f.provider.native.url,
            extensions: [TEST_BROWSER_EXTENSION],
            startedAt: new Date(START).toISOString(),
            timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
            finishedAt: null,
          });
        }),
      );
      const params = { threadId: a.threadId };
      const session = await accept(client().get({ headers, params }), [200]);
      expect(session.body.browser).toMatchObject({
        status: "active",
        liveUrl: null,
      });
      const viewer = await accept(
        client().viewerConnection({ headers, params }),
        [200],
      );
      expect(viewer.body).toStrictEqual({
        cdpUrl: f.provider.native.url,
        extension: TEST_BROWSER_EXTENSION,
      });
    });
  });

  it("bounds a silent initial-window lookup and recovers through confirmed instance cleanup", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      f.provider.native.windowReply = "withhold";
      await expect(
        client().use({ headers: runHeaders(a), body: {} }),
      ).resolves.toMatchObject({
        status: 503,
        body: { error: { code: "BROWSER_USE_TIMEOUT" } },
      });
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.stoppedSessionIds.size).toBe(0);

      f.provider.native.windowReply = "reply";
      const retry = await client().use({ headers: runHeaders(a), body: {} });
      expect({
        status: retry.status,
        windows: new Set(
          [...f.provider.native.targets.values()].map((target) => {
            return target.windowId;
          }),
        ).size,
      }).toStrictEqual({ status: 409, windows: 1 });
      expect(f.provider.sessionRequests).toHaveLength(1);
      mockNow(START + 2 * MINUTE);
      const recovered = await use(a);
      expect(recovered.browser.status).toBe("active");
      expect((await view(a)).window).toStrictEqual(recovered.browser.window);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(f.provider.stoppedSessionIds.size).toBe(1);
      expect([...f.provider.native.targets.values()]).toMatchObject([
        { windowId: recovered.browser.window?.primaryWindowId },
      ]);
    });
  }, 20_000);

  it("waits for the first window before admitting a sibling into a newly published instance", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
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
      const opening = settleIncludingAbort(
        accept(client().use({ headers: runHeaders(a), body: {} }), [200]),
      );
      const waiting = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          opening.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("The first open never reached its provider read");
          }),
        ]);
        expect(
          (await client().use({ headers: runHeaders(b), body: {} })).status,
        ).toBe(409);
        expect([...f.provider.native.targets.values()]).toHaveLength(1);
        expect(f.provider.sessionRequests).toHaveLength(1);
      });
      if (!release.settled()) {
        release.resolve();
      }
      const completed = await opening;
      if (!waiting.ok) {
        throw waiting.error;
      }
      if (!completed.ok) {
        throw completed.error;
      }
      const first = completed.value.body.browser;
      const sibling = (await use(b)).browser;
      expect(sibling.window?.instanceId).toBe(first.window?.instanceId);
      expect(sibling.window?.primaryWindowId).not.toBe(
        first.window?.primaryWindowId,
      );
      expect(
        new Set(
          [...f.provider.native.targets.values()].map((target) => {
            return target.windowId;
          }),
        ),
      ).toStrictEqual(
        new Set([
          first.window?.primaryWindowId,
          sibling.window?.primaryWindowId,
        ]),
      );
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it.each([true, false])(
    "creates a Browser with the mode's egress when shared admission enabled=%s",
    async (shared) => {
      const f = await fixture(shared);
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const result = await client().create({
          headers: runHeaders(a),
          body: { name: "Regional browser", proxyCountryCode: "us" },
        });
        expect(result.status).toBe(201);
        expect(result.body).toMatchObject({
          browser: { proxyCountryCode: shared ? null : "us" },
        });
        expect(f.provider.sessionRequests).toStrictEqual([
          expect.objectContaining({ proxyCountryCode: shared ? null : "us" }),
        ]);
      });
    },
  );

  it("adopts legacy chat URLs after shared cutover", async () => {
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
    const f = await fixture(false);
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
      await use(a);
      for (const page of f.provider.native.targets.values()) {
        page.url = "https://a.example.test/legacy-saved";
      }
      // B reclaims A through ordinary Browser capacity admission.
      await use(b);
      await flushWaitUntilForTest();
      await createChatFilesBddApi(context).deleteThread(
        f.owned.actor,
        b.threadId,
      );
      await flushWaitUntilForTest();
      f.provider.native.targets.clear();
      f.owned.ownsFeatureSwitches();
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: true,
      });
      const reopened = await use(a);
      expect(reopened.browser.window).toBeDefined();
      const urls = [...f.provider.native.targets.values()]
        .filter((page) => {
          return page.windowId === reopened.browser.window?.primaryWindowId;
        })
        .map((page) => {
          return page.url;
        });
      expect(urls).toStrictEqual(["https://a.example.test/legacy-saved"]);
    });
  });

  it.each(["legacy", "shared"] as const)(
    "rejects a legacy URL capture finishing after %s replacement",
    async (replacement) => {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "3");
      const f = await fixture(false);
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const b = await f.start();
        const c = await f.start();
        mockEnv("CONCURRENT_RUN_LIMIT_CAP", "1");
        await use(a);
        for (const page of f.provider.native.targets.values()) {
          page.url = "https://a.example.test/older";
        }
        // Reclamation must preserve URLs even if the requesting Browser's
        // subsequent provider start fails. Both requests independently own A's
        // capture; only the first request is held at external KMS.
        let rejectSessionStarts = true;
        server.use(
          http.post(`${PROVIDER_URL}/browsers`, () => {
            if (rejectSessionStarts) {
              return HttpResponse.json(
                { detail: "Provider temporarily unavailable" },
                { status: 503 },
              );
            }
            return;
          }),
        );
        const kms = holdSecretKms(1, context.signal);
        const earlier = settleIncludingAbort(
          client().use({ headers: runHeaders(b), body: {} }),
        );
        const replaced = await settleIncludingAbort(async () => {
          await Promise.race([
            kms.entered,
            earlier.then((result) => {
              if (!result.ok) {
                throw result.error;
              }
              throw new Error(
                "Expected the legacy capture to reach encryption",
              );
            }),
          ]);
          for (const page of f.provider.native.targets.values()) {
            page.url = "https://a.example.test/newer";
          }
          const failedStart = await client().use({
            headers: runHeaders(c),
            body: {},
          });
          expect(failedStart).toMatchObject({
            status: 502,
            body: { error: { code: "BROWSER_USE_ERROR" } },
          });
          await flushWaitUntilForTest();
          f.provider.native.targets.clear();
          if (replacement === "shared") {
            f.owned.ownsFeatureSwitches();
            await updateFeatureSwitchesForUser(context, f.featureActor, {
              [FeatureSwitchKey.BrowserSharedOwner]: true,
            });
          }
          rejectSessionStarts = false;
          const current = await use(a);
          if (replacement === "shared") {
            await accept(
              client().close({
                headers,
                params: { threadId: a.threadId },
                body: {},
              }),
              [200],
            );
          }
          return current.browser.window;
        });
        rejectSessionStarts = true;
        kms.release();
        const completed = await earlier;
        if (!replaced.ok) {
          throw replaced.error;
        }
        if (!completed.ok) {
          throw completed.error;
        }
        expect(completed.value).toMatchObject({
          status: 502,
          body: { error: { code: "BROWSER_USE_ERROR" } },
        });
        if (replacement === "shared") {
          const window = replaced.value;
          if (!window) {
            throw new Error("Expected the replacement shared window");
          }
          f.provider.native.targets.clear();
        } else {
          const [providerSessionId] = f.provider.sessionIds;
          if (!providerSessionId) {
            throw new Error("Expected the replacement legacy instance");
          }
          server.use(
            http.get(`${PROVIDER_URL}/browsers/${providerSessionId}`, () => {
              return HttpResponse.json({
                id: providerSessionId,
                status: "stopped",
                startedAt: new Date(START).toISOString(),
                timeoutAt: new Date(START + 240 * MINUTE).toISOString(),
                finishedAt: new Date(START + 12 * MINUTE).toISOString(),
                liveUrl: null,
                cdpUrl: null,
              });
            }),
          );
          f.provider.native.targets.clear();
        }
        rejectSessionStarts = false;
        const reopened = await use(a);
        const urls = [...f.provider.native.targets.values()].map((page) => {
          return page.url;
        });
        expect(urls).toContain("https://a.example.test/newer");
        expect(urls).not.toContain("https://a.example.test/older");
        if (replacement === "shared") {
          // A replacement Chrome may reuse window zero; instance identity fences it.
          expect(reopened.browser.window?.instanceId).not.toBe(
            replaced.value?.instanceId,
          );
        }
      });
    },
  );

  it("recovers a missing provider instance and preserves provider failures as failures", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const first = await use(a);
      const b = await f.start();
      const sibling = await use(b);
      const [providerSessionId] = f.provider.sessionIds;
      if (!providerSessionId) {
        throw new Error("Expected the shared provider instance");
      }
      for (const target of f.provider.native.targets.values()) {
        target.url =
          target.windowId === first.browser.window?.primaryWindowId
            ? "https://a.example.test/recovered"
            : "https://b.example.test/recovered";
      }
      await accept(
        client().close({ headers, params: { threadId: a.threadId }, body: {} }),
        [200],
      );
      await accept(
        client().close({ headers, params: { threadId: b.threadId }, body: {} }),
        [200],
      );
      let missing = false;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/${providerSessionId}`, () => {
          return HttpResponse.json(
            { detail: missing ? "Browser missing" : "Provider unavailable" },
            { status: missing ? 404 : 503 },
          );
        }),
      );
      expect(
        (await client().use({ headers: runHeaders(a), body: {} })).status,
      ).toBe(502);
      expect(f.provider.sessionRequests).toHaveLength(1);
      missing = true;
      f.provider.native.targets.clear();
      const reopened = await use(a);
      expect(reopened.browser.window?.instanceId).not.toBe(
        first.browser.window?.instanceId,
      );
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect((await view(b)).status).toBe("suspended");
      expect(
        [...f.provider.native.targets.values()].map((page) => {
          return page.url;
        }),
      ).toStrictEqual(["https://a.example.test/recovered"]);
      const restoredB = await use(b);
      expect(restoredB.browser.window?.instanceId).toBe(
        reopened.browser.window?.instanceId,
      );
      expect(restoredB.browser.window).not.toStrictEqual(
        sibling.browser.window,
      );
      expect(
        [...f.provider.native.targets.values()]
          .filter((page) => {
            return page.windowId === restoredB.browser.window?.primaryWindowId;
          })
          .map((page) => {
            return page.url;
          }),
      ).toStrictEqual(["https://b.example.test/recovered"]);
    });
  });

  it("shares the owner Browser with a Slack chat and preserves its window after the Run ends", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const web = await use(await f.start());
      const actor = f.owned.actor;
      const integrations = createBddIntegrationApi(context);
      const runs = createRunsApi(context);
      integrations.configureSlackAppMocks();
      await createBddApi(context).readOnboardingStatus(actor);
      const slackUserId = uniqueSlackUserId();
      const { teamId } = await integrations.installSlackWorkspace(actor, {
        installerSlackUserId: slackUserId,
      });
      await integrations.postSlackEvent(teamId, {
        type: "app_mention",
        user: slackUserId,
        text: "Use my Browser in this Slack chat",
        ts: "3000.000100",
        channel: "C_SHARED_BROWSER",
        channel_type: "channel",
      });
      await runs.heartbeatRunner(f.owned.runnerGroup);
      await flushWaitUntilForTest();
      const runId = (await runs.pollRunner(f.owned.runnerGroup)).body.job
        ?.runId;
      if (!runId) {
        throw new Error("Expected the Slack chat Run");
      }
      expect(
        (
          await createRunReadsApi(context).requestReadLogById(
            actor,
            runId,
            [200],
          )
        ).body.triggerSource,
      ).toBe("slack");
      const claim = await f.owned.claimRunnerRun(runId);
      const used = await accept(
        client().use({
          headers: { authorization: `Bearer ${okouTokenFromClaim(claim)}` },
          body: {},
        }),
        [200],
      );
      const slack = used.body.browser;
      expect(slack.window?.instanceId).toBe(web.browser.window?.instanceId);
      expect(slack.window?.primaryWindowId).not.toBe(
        web.browser.window?.primaryWindowId,
      );
      await createWebhookCallbackApi(context).requestAgentComplete(
        { runId, exitCode: 1, error: "The fixture Run finished" },
        { authorization: `Bearer ${claim.sandboxToken}` },
        [200],
      );
      await flushWaitUntilForTest();
      const viewed = await accept(
        client().get({ headers, params: { threadId: slack.threadId } }),
        [200],
      );
      expect(viewed.body.browser.window).toStrictEqual(slack.window);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it("provisions one profile and instance for two chats, reads and resizes only each owned window", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const external = installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await use(a);
      const current = await accept(
        client().current({ headers: runHeaders(a) }),
        [200],
      );
      expect(current.body.browser.window).toStrictEqual(first.browser.window);
      const resized = await accept(
        client().resizeByThread({
          headers,
          params: { threadId: a.threadId },
          body: { aspectRatio: 2 },
        }),
        [200],
      );
      expect(resized.body.browser.window).toStrictEqual(first.browser.window);
      const second = await use(b);
      expect(first.browser.window?.instanceId).toBe(
        second.browser.window?.instanceId,
      );
      expect(first.browser.window?.primaryWindowId).not.toBe(
        second.browser.window?.primaryWindowId,
      );
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
      expect(f.provider.sessionRequests[0]).toMatchObject({
        profileId: f.provider.createdIds[0],
        proxyCountryCode: null,
      });
      expect(
        external.sizes.get(Number(first.browser.window?.primaryWindowId)),
      ).toStrictEqual({ width: 1440, height: 720 });
      expect(
        external.sizes.get(Number(second.browser.window?.primaryWindowId)),
      ).toStrictEqual({ width: 1440, height: 900 });
      const unchanged = await accept(
        client().get({ headers, params: { threadId: b.threadId } }),
        [200],
      );
      expect(unchanged.body.browser.window).toStrictEqual(
        second.browser.window,
      );
      mockNow(START + MINUTE);
      const leased = await accept(
        client().lease({ headers: runHeaders(a), body: {} }),
        [200],
      );
      expect(Date.parse(String(leased.body.browser.idleExpiresAt))).toBe(
        START + 11 * MINUTE,
      );
      const sibling = await view(b);
      expect(Date.parse(String(sibling.idleExpiresAt))).toBe(
        START + 10 * MINUTE,
      );
    });
  });

  it("captures only the chat URLs and reopens a new window without recreating the live owner instance", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await use(a);
      const second = await use(b);
      const window = first.browser.window;
      if (!window) {
        throw new Error("Expected the public Browser window");
      }
      for (const target of f.provider.native.targets.values()) {
        target.url =
          target.windowId === window.primaryWindowId
            ? "https://a.example.test/saved"
            : "https://b.example.test/private";
      }
      await accept(
        client().close({ headers, params: { threadId: a.threadId }, body: {} }),
        [200],
      );
      // Native closure must leave recovery dependent on the sidebar capture.
      for (const [id, target] of f.provider.native.targets) {
        if (target.windowId === window.primaryWindowId) {
          f.provider.native.targets.delete(id);
        }
      }
      const resumed = await use(a);
      expect(resumed.browser.window?.instanceId).toBe(window.instanceId);
      expect(resumed.browser.window?.primaryWindowId).not.toBe(
        window.primaryWindowId,
      );
      const restored = [...f.provider.native.targets.values()].filter(
        (target) => {
          return target.windowId === resumed.browser.window?.primaryWindowId;
        },
      );
      expect(
        restored.map((target) => {
          return target.url;
        }),
      ).toStrictEqual(["https://a.example.test/saved"]);
      expect((await use(b)).browser.window).toStrictEqual(
        second.browser.window,
      );
      expect(f.provider.sessionRequests).toHaveLength(1);
      mockNow(START + 11 * MINUTE);
      const restarted = await use(a);
      expect(restarted.browser.window?.instanceId).not.toBe(window.instanceId);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(f.provider.sessionRequests[1]).toMatchObject({
        profileId: f.provider.createdIds[0],
        proxyCountryCode: null,
      });
      expect(
        [...f.provider.native.targets.values()].map((target) => {
          return target.url;
        }),
      ).toStrictEqual(["https://a.example.test/saved"]);
      const sleepingSibling = await accept(
        client().get({ headers, params: { threadId: b.threadId } }),
        [200],
      );
      expect(sleepingSibling.body.browser.status).toBe("suspended");
      expect(sleepingSibling.body.browser.window).toBeUndefined();
    });
  });

  it("preserves a named Browser and its preview while an earlier open is still resolving", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      await use(a);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let first = true;
      f.provider.native.beforeNativeWindowReply = async () => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
      };
      const earlier = settleIncludingAbort(use(a));
      const published = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          earlier.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("The first open never reached its provider read");
          }),
        ]);
        const named = await accept(
          client().create({
            headers: runHeaders(a),
            body: { name: "Trip planning", proxyCountryCode: null },
          }),
          [201],
        );
        expect(named.body.browser.name).toBe("Trip planning");
        await accept(
          client().close({
            headers,
            params: { threadId: a.threadId },
            body: {},
          }),
          [200],
        );
        const viewed = await accept(
          client().get({ headers, params: { threadId: a.threadId } }),
          [200],
        );
        expect(viewed.body.browser.screenshotUrl).not.toBeNull();
        return viewed.body.browser.screenshotUrl;
      });
      if (!release.settled()) {
        release.resolve();
      }
      const completed = await earlier;
      if (!published.ok) {
        throw published.error;
      }
      if (!completed.ok) {
        throw completed.error;
      }
      const latest = await accept(
        client().get({ headers, params: { threadId: a.threadId } }),
        [200],
      );
      expect(latest.body.browser.screenshotUrl).toBe(published.value);
      expect(latest.body.browser.name).toBe("Trip planning");
    });
  });

  it("preserves a new window's preview when the old window's screenshot upload finishes late", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await use(a);
      await use(b);
      const window = first.browser.window;
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === window?.primaryWindowId;
      });
      if (!window || !page) {
        throw new Error("Expected A's first Browser window and page");
      }
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      const uploads: { readonly key: string; readonly bytes: Buffer }[] = [];
      const send = context.mocks.s3.send.getMockImplementation();
      if (!send) {
        throw new Error("Expected the external object-storage fixture");
      }
      context.mocks.s3.send.mockImplementation(async (command: unknown) => {
        if (
          command instanceof PutObjectCommand &&
          command.input.ContentType === "image/webp"
        ) {
          if (!command.input.Key || !Buffer.isBuffer(command.input.Body)) {
            throw new Error("Expected an immutable screenshot upload");
          }
          uploads.push({ key: command.input.Key, bytes: command.input.Body });
          if (uploads.length === 1) {
            entered.resolve();
            await release.promise;
          }
        }
        return await send(command);
      });
      context.mocks.s3.getSignedUrl.mockImplementation(
        (_client: unknown, command: unknown) => {
          if (!(command instanceof GetObjectCommand) || !command.input.Key) {
            throw new Error("Expected a private screenshot download");
          }
          return Promise.resolve(
            `https://screenshots.example.test/${encodeURIComponent(command.input.Key)}`,
          );
        },
      );
      const oldCapture = settleIncludingAbort(
        accept(
          client().close({
            headers,
            params: { threadId: a.threadId },
            body: {},
          }),
          [200],
        ),
      );
      const publication = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          oldCapture.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("The screenshot never reached its upload");
          }),
        ]);
        f.provider.native.targets.delete(page.targetId);
        const replacement = await use(a);
        expect(replacement.browser.window?.primaryWindowId).not.toBe(
          window.primaryWindowId,
        );
        await accept(
          client().close({
            headers,
            params: { threadId: a.threadId },
            body: {},
          }),
          [200],
        );
        const viewed = await accept(
          client().get({ headers, params: { threadId: a.threadId } }),
          [200],
        );
        const preview = viewed.body.browser.screenshotUrl;
        const oldUpload = uploads[0];
        const newUpload = uploads[1];
        if (!oldUpload || !newUpload) {
          throw new Error("Expected both native-window screenshot uploads");
        }
        expect(oldUpload.bytes.toString()).toBe(`preview:${page.targetId}`);
        expect(preview).toBe(
          `https://screenshots.example.test/${encodeURIComponent(newUpload.key)}`,
        );
        return preview;
      });
      if (!release.settled()) {
        release.resolve();
      }
      const completed = await oldCapture;
      if (!publication.ok) {
        throw publication.error;
      }
      if (!completed.ok) {
        throw completed.error;
      }
      const latest = await accept(
        client().get({ headers, params: { threadId: a.threadId } }),
        [200],
      );
      expect(latest.body.browser.screenshotUrl).toBe(publication.value);
      expect(uploads).toHaveLength(2);
    });
  });

  it("does not fall back to thread provisioning when shared admission is disabled", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      await use(a);
      await updateFeatureSwitchesForUser(context, f.featureActor, {
        [FeatureSwitchKey.BrowserSharedOwner]: false,
      });
      const b = await f.start();
      const denied = await client().use({ headers: runHeaders(b), body: {} });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({
        error: { code: "BROWSER_SHARED_OWNER_DISABLED" },
      });
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });
});

describe("shared Browser capture publication and admission", () => {
  it.each(["closed", "blank"] as const)(
    "distinguishes a %s native window when capturing recovery URLs",
    async (state) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const b = await f.start();
        const first = await use(a);
        const sibling = await use(b);
        const window = first.browser.window;
        const page = [...f.provider.native.targets.values()].find((target) => {
          return target.windowId === window?.primaryWindowId;
        });
        if (!window || !page) {
          throw new Error("Expected A's original native window and page");
        }
        page.url = "https://a.example.test/recoverable";
        const params = { threadId: a.threadId };
        await accept(client().close({ headers, params, body: {} }), [200]);
        if (state === "closed") {
          f.provider.native.targets.delete(page.targetId);
        } else {
          page.url = "about:blank";
        }
        await accept(client().close({ headers, params, body: {} }), [200]);
        f.provider.native.targets.delete(page.targetId);
        const reopened = await use(a);
        expect(reopened.browser.window?.primaryWindowId).not.toBe(
          window.primaryWindowId,
        );
        expect(
          [...f.provider.native.targets.values()]
            .filter((target) => {
              return (
                target.windowId === reopened.browser.window?.primaryWindowId
              );
            })
            .map((target) => {
              return target.url ?? "about:blank";
            }),
        ).toStrictEqual([
          state === "closed"
            ? "https://a.example.test/recoverable"
            : "about:blank",
        ]);
        const siblingAfter = await accept(
          client().get({ headers, params: { threadId: b.threadId } }),
          [200],
        );
        expect(siblingAfter.body.browser.window).toStrictEqual(
          sibling.browser.window,
        );
        expect(siblingAfter.body.browser.idleExpiresAt).toBe(
          sibling.browser.idleExpiresAt,
        );
      });
    },
  );

  it.each([true, false])(
    "keeps the restored winner when native loser cleanup succeeds=%s",
    async (cleanupSucceeds) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const b = await f.start();
        const first = await use(a);
        const sibling = await use(b);
        const window = first.browser.window;
        if (!window) {
          throw new Error("Expected A's original window");
        }
        for (const target of f.provider.native.targets.values()) {
          if (target.windowId === window.primaryWindowId) {
            target.url = "https://a.example.test/first";
          }
        }
        const secondPage = randomUUID();
        f.provider.native.targets.set(secondPage, {
          targetId: secondPage,
          windowId: window.primaryWindowId,
          url: "https://a.example.test/second",
        });
        await accept(
          client().close({
            headers,
            params: { threadId: a.threadId },
            body: {},
          }),
          [200],
        );
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === window.primaryWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
        f.provider.native.closeSucceeds = cleanupSucceeds;
        const firstCandidate = createDeferredPromise<void>(context.signal);
        const both = createDeferredPromise<void>(context.signal);
        const nativeArrivals: number[] = [];
        f.provider.native.beforeCreateReply = async (target) => {
          nativeArrivals.push(target.windowId);
          if (nativeArrivals.length === 1) {
            firstCandidate.resolve();
          }
          if (nativeArrivals.length === 2) {
            both.resolve();
          }
          await both.promise;
        };
        function startOpen() {
          return settleIncludingAbort(
            client().use({ headers: runHeaders(a), body: {} }),
          );
        }
        const opened = startOpen();
        const requests = [opened];
        function completedEarly(request: ReturnType<typeof startOpen>) {
          return request.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error(
              `Admission completed before both native candidates: ${JSON.stringify({ status: result.value.status, body: result.value.body, nativeArrivals })}`,
            );
          });
        }
        const coordinated = await settleIncludingAbort(async () => {
          // Retirement may legitimately reject another open before creation.
          // Compete only once the first candidate exists, before publication.
          await Promise.race([firstCandidate.promise, completedEarly(opened)]);
          const admitted = startOpen();
          requests.push(admitted);
          await Promise.race([
            both.promise,
            completedEarly(opened),
            completedEarly(admitted),
          ]);
        });
        if (!both.settled()) {
          both.resolve();
        }
        const completed = await Promise.all(requests);
        if (!coordinated.ok) {
          throw coordinated.error;
        }
        const results = completed.map((result) => {
          if (!result.ok) {
            throw result.error;
          }
          return result.value;
        });
        const [successful, conflict] = results.sort((left, right) => {
          return left.status - right.status;
        });
        expect(results).toHaveLength(2);
        expect(successful?.status).toBe(200);
        expect(conflict).toMatchObject({
          status: 409,
          body: { error: { code: "BROWSER_RECLAIMING" } },
        });
        const winner = await view(a);
        expect(winner.window).toStrictEqual(successful?.body.browser.window);
        const pages = [...f.provider.native.targets.values()];
        expect(
          pages
            .filter((page) => {
              return page.windowId === winner.window?.primaryWindowId;
            })
            .map((page) => {
              return page.url;
            })
            .sort(),
        ).toStrictEqual([
          "https://a.example.test/first",
          "https://a.example.test/second",
        ]);
        expect(
          new Set(
            pages.map((page) => {
              return page.windowId;
            }),
          ),
        ).toStrictEqual(
          new Set([
            ...(cleanupSucceeds
              ? [winner.window?.primaryWindowId]
              : nativeArrivals),
            sibling.browser.window?.primaryWindowId,
          ]),
        );
        const siblingAfter = await view(b);
        expect(siblingAfter.window).toStrictEqual(sibling.browser.window);
        expect(siblingAfter.idleExpiresAt).toBe(sibling.browser.idleExpiresAt);
        expect(f.provider.sessionRequests).toHaveLength(1);
      });
    },
  );

  it.each([
    { previous: false, retirement: "missing" },
    { previous: true, retirement: "missing" },
    { previous: true, retirement: "healthy" },
    { previous: true, retirement: "unavailable" },
  ] as const)(
    "keeps newer recovery URLs after a delayed native reply with previous=$previous and retirement=$retirement",
    async ({ previous, retirement }) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const b = await f.start();
        const first = await use(a);
        const sibling = await use(b);
        const window = first.browser.window;
        const page = [...f.provider.native.targets.values()].find((target) => {
          return target.windowId === window?.primaryWindowId;
        });
        if (!window || !page) {
          throw new Error("Expected A's live native page");
        }
        const close = () => {
          return accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          );
        };
        if (previous) {
          page.url = "https://a.example.test/previous";
          await close();
        }
        const entered = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        let hold = true;
        f.provider.native.afterNativeWindowReply = async (windowId) => {
          if (hold && windowId === window.primaryWindowId) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
        };
        mockNow(START + 1000);
        page.url = "https://a.example.test/older-observation";
        const earlier = settleIncludingAbort(close());
        const newer = await settleIncludingAbort(async () => {
          await Promise.race([
            entered.promise,
            earlier.then((result) => {
              if (!result.ok) {
                throw result.error;
              }
              throw new Error("Expected a held native URL response");
            }),
          ]);
          mockNow(START + 2000);
          page.url = "https://a.example.test/newer-accepted";
          await close();
        });
        mockNow(START + 3000);
        release.resolve();
        const completed = await earlier;
        if (!newer.ok) {
          throw newer.error;
        }
        if (!completed.ok) {
          throw completed.error;
        }
        if (retirement === "missing") {
          // Native loss must restore accepted data without a fresh recapture.
          for (const [id, target] of f.provider.native.targets) {
            if (target.windowId === window.primaryWindowId) {
              f.provider.native.targets.delete(id);
            }
          }
        } else {
          mockNow(START + 9 * MINUTE);
          await renew(b);
          if (retirement === "unavailable") {
            f.provider.native.nativeWindowErrors.set(
              window.primaryWindowId,
              "Retirement capture unavailable",
            );
          }
          mockNow(START + 11 * MINUTE);
        }
        const restored = await use(a);
        expect(restored.browser.window?.instanceId).toBe(window.instanceId);
        expect(restored.browser.window?.primaryWindowId).not.toBe(
          window.primaryWindowId,
        );
        const siblingAfter = await view(b);
        expect(siblingAfter.window).toStrictEqual(sibling.browser.window);
        expect(siblingAfter.idleExpiresAt).toBe(
          retirement === "missing"
            ? sibling.browser.idleExpiresAt
            : new Date(START + 19 * MINUTE).toISOString(),
        );
        expect(
          [...f.provider.native.targets.values()]
            .filter((target) => {
              return (
                target.windowId === restored.browser.window?.primaryWindowId
              );
            })
            .map((target) => {
              return target.url;
            }),
        ).toStrictEqual(["https://a.example.test/newer-accepted"]);
      });
    },
  );

  it("keeps newer close URLs when a delayed native retirement capture wins closing", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await use(a);
      const sibling = await use(b);
      const window = first.browser.window;
      const page = [...f.provider.native.targets.values()].find((target) => {
        return target.windowId === window?.primaryWindowId;
      });
      if (!window || !page) {
        throw new Error("Expected A's live native page");
      }
      mockNow(START + 9 * MINUTE);
      const leased = await renew(b);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let hold = true;
      f.provider.native.afterNativeWindowReply = async (windowId) => {
        if (hold && windowId === window.primaryWindowId) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
      };
      mockNow(START + 11 * MINUTE);
      page.url = "https://a.example.test/older-retirement";
      const earlier = settleIncludingAbort(use(a));
      const newer = await settleIncludingAbort(async () => {
        await Promise.race([
          entered.promise,
          earlier.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("Expected a held native retirement response");
          }),
        ]);
        mockNow(START + 11 * MINUTE + 1000);
        page.url = "https://a.example.test/newer-accepted";
        await accept(
          client().close({
            headers,
            params: { threadId: a.threadId },
            body: {},
          }),
          [200],
        );
      });
      mockNow(START + 11 * MINUTE + 2000);
      release.resolve();
      const completed = await earlier;
      if (!newer.ok) {
        throw newer.error;
      }
      if (!completed.ok) {
        throw completed.error;
      }
      const restored = completed.value;
      expect(restored.browser.window?.instanceId).toBe(window.instanceId);
      expect(restored.browser.window?.primaryWindowId).not.toBe(
        window.primaryWindowId,
      );
      expect(
        [...f.provider.native.targets.values()]
          .filter((target) => {
            return target.windowId === restored.browser.window?.primaryWindowId;
          })
          .map((target) => {
            return target.url;
          }),
      ).toStrictEqual(["https://a.example.test/newer-accepted"]);
      const siblingAfter = await view(b);
      expect(siblingAfter.window).toStrictEqual(sibling.browser.window);
      expect(siblingAfter.idleExpiresAt).toBe(leased.idleExpiresAt);
    });
  });

  it.each([false, true])(
    "keeps the newer preview after a delayed native screenshot with previous=%s",
    async (previous) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        await use(a);
        const close = () => {
          return accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          );
        };
        if (previous) {
          await close();
          expect((await view(a)).screenshotUrl).not.toBeNull();
        }
        const native = f.provider.native.command;
        if (!native) {
          throw new Error("Expected external CDP fixture");
        }
        const entered = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        let hold = true;
        f.provider.native.command = async (command) => {
          if (command.method !== "Page.captureScreenshot") {
            return await native(command);
          }
          const earlier = hold;
          const result = {
            data: Buffer.from(
              earlier ? "earlier image" : "later image",
            ).toString("base64"),
          };
          if (earlier) {
            hold = false;
            entered.resolve();
            await release.promise;
          }
          return result;
        };
        mockNow(START + 1000);
        const earlier = settleIncludingAbort(close());
        const newer = await settleIncludingAbort(async () => {
          await Promise.race([
            entered.promise,
            earlier.then((result) => {
              if (!result.ok) {
                throw result.error;
              }
              throw new Error("Expected a held native screenshot response");
            }),
          ]);
          mockNow(START + 2000);
          await close();
          const preview = (await view(a)).screenshotUrl;
          expect(preview).not.toBeNull();
          return preview;
        });
        mockNow(START + 3000);
        release.resolve();
        const completed = await earlier;
        if (!newer.ok) {
          throw newer.error;
        }
        if (!completed.ok) {
          throw completed.error;
        }
        expect((await view(a)).screenshotUrl).toBe(newer.value);
      });
    },
  );

  it.each(["sequential", "older-last", "older-first"] as const)(
    "preserves the newer same-window preview with %s completion",
    async (completion) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const first = await use(a);
        let capture = 0;
        const native = f.provider.native.command;
        if (!native) {
          throw new Error("Expected external CDP fixture");
        }
        f.provider.native.command = (command) => {
          if (command.method === "Page.captureScreenshot") {
            return {
              data: Buffer.from("capture:" + ++capture).toString("base64"),
            };
          }
          return native(command);
        };
        const entered = createDeferredPromise<void>(context.signal);
        const release = createDeferredPromise<void>(context.signal);
        const uploads: { key: string; bytes: Buffer }[] = [];
        const send = context.mocks.s3.send.getMockImplementation();
        if (!send) {
          throw new Error("Expected external S3 fixture");
        }
        context.mocks.s3.send.mockImplementation(async (command: unknown) => {
          if (
            command instanceof PutObjectCommand &&
            command.input.ContentType === "image/webp"
          ) {
            if (!command.input.Key || !Buffer.isBuffer(command.input.Body)) {
              throw new Error("Expected immutable screenshot bytes");
            }
            uploads.push({ key: command.input.Key, bytes: command.input.Body });
            if (uploads.length === 1) {
              entered.resolve();
              await release.promise;
            } else if (uploads.length === 2 && completion === "older-first") {
              if (!release.settled()) {
                release.resolve();
              }
              const completed = await earlier;
              if (!completed.ok) {
                throw completed.error;
              }
            }
          }
          return await send(command);
        });
        context.mocks.s3.getSignedUrl.mockImplementation(
          (_client: unknown, command: unknown) => {
            if (!(command instanceof GetObjectCommand) || !command.input.Key) {
              throw new Error("Expected preview download");
            }
            return Promise.resolve(
              "https://screenshots.example.test/" +
                encodeURIComponent(command.input.Key),
            );
          },
        );
        const earlier = settleIncludingAbort(
          accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          ),
        );
        const publication = await settleIncludingAbort(async () => {
          await Promise.race([
            entered.promise,
            earlier.then((r) => {
              if (!r.ok) {
                throw r.error;
              }
              throw new Error("Earlier capture did not reach external upload");
            }),
          ]);
          if (completion === "sequential") {
            if (!release.settled()) {
              release.resolve();
            }
            const completed = await earlier;
            if (!completed.ok) {
              throw completed.error;
            }
          }
          if (completion === "older-first") {
            mockNow(START + MINUTE);
          }
          await accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          );
          const viewed = await accept(
            client().get({ headers, params: { threadId: a.threadId } }),
            [200],
          );
          expect(viewed.body.browser.window).toStrictEqual(
            first.browser.window,
          );
          expect(
            uploads.map((x) => {
              return x.bytes.toString();
            }),
          ).toStrictEqual(["capture:1", "capture:2"]);
          const newerUpload = uploads[1];
          if (!newerUpload) {
            throw new Error("Expected the newer screenshot upload");
          }
          expect(viewed.body.browser.screenshotUrl).toBe(
            "https://screenshots.example.test/" +
              encodeURIComponent(newerUpload.key),
          );
          return viewed.body.browser.screenshotUrl;
        });
        if (!release.settled()) {
          release.resolve();
        }
        const joined = await earlier;
        if (!publication.ok) {
          throw publication.error;
        }
        if (!joined.ok) {
          throw joined.error;
        }
        const latest = await accept(
          client().get({ headers, params: { threadId: a.threadId } }),
          [200],
        );
        expect(latest.body.browser.window).toStrictEqual(first.browser.window);
        expect(
          latest.body.browser.screenshotUrl,
          "Older capture must not replace the newer preview",
        ).toBe(publication.value);
      });
    },
  );

  it.each([
    { reverse: false, before: 0, after: 0, warmup: false },
    { reverse: true, before: 0, after: 0, warmup: false },
    { reverse: false, before: 0, after: -MINUTE, warmup: false },
    { reverse: true, before: 0, after: MINUTE, warmup: false },
    { reverse: true, before: 90_000, after: MINUTE, warmup: true },
  ])(
    "restores newer URLs with reverse=$reverse, clocks=$before/$after and warmup=$warmup",
    async ({ reverse, before, after, warmup }) => {
      const f = await fixture();
      await f.owned.run(async () => {
        installBrowserWindowContentCommands(f.provider.native);
        const a = await f.start();
        const b = await f.start();
        const first = await use(a);
        const sibling = await use(b);
        const window = first.browser.window;
        if (!window) {
          throw new Error("Expected current native window");
        }
        const page = [...f.provider.native.targets.values()].find((t) => {
          return t.windowId === window.primaryWindowId;
        });
        if (!page) {
          throw new Error("Expected A's native page");
        }
        if (warmup) {
          page.url = "https://a.example.test/initial";
          mockNow(START + 2 * MINUTE);
          await accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          );
        }
        mockNow(START + before);
        page.url = "https://a.example.test/older";
        const kms = holdSecretKms(1, context.signal);
        const earlier = settleIncludingAbort(
          accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          ),
        );
        const saved = await settleIncludingAbort(async () => {
          await Promise.race([
            kms.entered,
            earlier.then((r) => {
              if (!r.ok) {
                throw r.error;
              }
              throw new Error(
                "Earlier snapshot did not reach external encryption",
              );
            }),
          ]);
          if (!reverse) {
            kms.release();
            const completed = await earlier;
            if (!completed.ok) {
              throw completed.error;
            }
          }
          mockNow(START + after);
          page.url = "https://a.example.test/newer";
          await accept(
            client().close({
              headers,
              params: { threadId: a.threadId },
              body: {},
            }),
            [200],
          );
        });
        kms.release();
        const joined = await earlier;
        if (!saved.ok) {
          throw saved.error;
        }
        if (!joined.ok) {
          throw joined.error;
        }
        // Retire an already closed native window so it cannot re-save newer
        // URLs and mask a stale concurrent sidebar snapshot publication.
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === window.primaryWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
        const reopened = await use(a);
        expect(reopened.browser.window?.instanceId).toBe(window.instanceId);
        expect(reopened.browser.window?.primaryWindowId).not.toBe(
          window.primaryWindowId,
        );
        const siblingAfter = await accept(
          client().get({ headers, params: { threadId: b.threadId } }),
          [200],
        );
        expect(siblingAfter.body.browser.window).toStrictEqual(
          sibling.browser.window,
        );
        expect(siblingAfter.body.browser.idleExpiresAt).toBe(
          sibling.browser.idleExpiresAt,
        );
        const restored = [...f.provider.native.targets.values()]
          .filter((t) => {
            return t.windowId === reopened.browser.window?.primaryWindowId;
          })
          .map((t) => {
            return t.url;
          });
        expect(
          restored,
          "The latest successful close must supply the restored URLs",
        ).toStrictEqual(["https://a.example.test/newer"]);
      });
    },
  );

  it("initializes native contents before publishing a window", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      const { sizes } = installBrowserWindowContentCommands(f.provider.native);
      // External native state follows the separately measured local Chromium
      // viewport after creating a sibling of a 1440x720 window.
      f.provider.native.beforeCreateReply = (candidate) => {
        sizes.set(candidate.windowId, { width: 1440, height: 776 });
      };
      const b = await f.start();
      const first = await use(b);
      const firstWindow = first.browser.window;
      if (!firstWindow) {
        throw new Error("Expected the sibling Browser window");
      }
      await accept(
        client().resizeByThread({
          headers,
          params: { threadId: b.threadId },
          body: { aspectRatio: 2 },
        }),
        [200],
      );
      expect(sizes.get(firstWindow.primaryWindowId)).toStrictEqual({
        width: 1440,
        height: 720,
      });
      const a = await f.start();
      const joined = await use(a);
      const joinedWindow = joined.browser.window;
      if (!joinedWindow) {
        throw new Error("Expected the admitted Browser window");
      }
      expect(
        sizes.get(joinedWindow.primaryWindowId),
        "Admission must establish the published native contents",
      ).toStrictEqual({ width: 1440, height: 900 });
    });
  });

  it("restores the saved chat URLs before publishing the replacement", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      installBrowserWindowContentCommands(f.provider.native);
      const a = await f.start();
      const b = await f.start();
      const first = await use(a);
      const sibling = await use(b);
      const window = first.browser.window;
      if (!window) {
        throw new Error("Expected A's original window");
      }
      for (const target of f.provider.native.targets.values()) {
        if (target.windowId === window.primaryWindowId) {
          target.url = "https://a.example.test/saved";
        }
      }
      await accept(
        client().close({
          headers,
          params: { threadId: a.threadId },
          body: {},
        }),
        [200],
      );
      for (const [id, target] of f.provider.native.targets) {
        if (target.windowId === window.primaryWindowId) {
          f.provider.native.targets.delete(id);
        }
      }
      const reopened = await use(a);
      expect(reopened.browser.window?.instanceId).toBe(window.instanceId);
      expect(reopened.browser.window?.primaryWindowId).not.toBe(
        window.primaryWindowId,
      );
      expect((await use(b)).browser.window).toStrictEqual(
        sibling.browser.window,
      );
      const urls = [...f.provider.native.targets.values()]
        .filter((t) => {
          return t.windowId === reopened.browser.window?.primaryWindowId;
        })
        .map((t) => {
          return t.url ?? "about:blank";
        });
      expect(
        urls,
        "Admission must restore the chat snapshot before publication",
      ).toStrictEqual(["https://a.example.test/saved"]);
    });
  });
});
