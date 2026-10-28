import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { createBddApi } from "./helpers/api-bdd";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createRunReadsApi } from "./helpers/api-bdd-run-reads";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { uniqueSlackUserId } from "./helpers/slack-public-install";
import { holdSecretKms } from "./helpers/hold-secret-kms";
import {
  createRunnerBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/runner-browser-fixture";

const context = testContext();
const { fixture, allocate, admit, accepted } =
  createRunnerBrowserFixtures(context);
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
function nativeCommands(f: Awaited<ReturnType<typeof fixture>>) {
  const sizes = f.provider.native.contentsSizes;
  f.provider.native.command = (command) => {
    const targetId = command.sessionId?.replace(/^page-/u, "");
    if (command.method === "Target.attachToTarget") {
      return { sessionId: `page-${String(command.params.targetId)}` };
    }
    if (command.method === "Page.getFrameTree") {
      return {
        frameTree: {
          frame: { id: "frame", loaderId: "loader", url: "about:blank" },
        },
      };
    }
    if (command.method === "Page.createIsolatedWorld") {
      return { executionContextId: 1 };
    }
    if (command.method === "Runtime.evaluate") {
      const expression = String(command.params.expression);
      if (expression.includes("window.open(")) {
        const source = f.provider.native.targets.get(String(targetId));
        if (!source) {
          throw new Error("Restore source missing");
        }
        const match =
          /^Boolean\(window\.open\(("(?:[^"\\]|\\.)*"), "_blank"\)\)$/u.exec(
            expression,
          );
        if (!match?.[1]) {
          throw new Error("Unexpected restore expression");
        }
        const target = {
          targetId: randomUUID(),
          windowId: source.windowId,
          url: String(JSON.parse(match[1])),
        };
        f.provider.native.targets.set(target.targetId, target);
        return { result: { value: true } };
      }
      return { result: { value: true } };
    }
    if (command.method === "Page.getLayoutMetrics") {
      return {
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 1440,
          clientHeight: 900,
        },
      };
    }
    if (command.method === "Page.captureScreenshot") {
      return { data: Buffer.from(`preview:${targetId}`).toString("base64") };
    }
    throw new Error(`Unexpected external CDP operation: ${command.method}`);
  };
  return { sizes };
}

describe("shared Browser public consumers", () => {
  it("treats a missing provider instance as unavailable while preserving actual provider failures", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      nativeCommands(f);
      const a = await f.start();
      await use(a);
      const [providerSessionId] = f.provider.sessionIds;
      if (!providerSessionId) {
        throw new Error("Expected the shared provider instance");
      }
      let missing = true;
      server.use(
        http.get(`${PROVIDER_URL}/browsers/${providerSessionId}`, () => {
          return HttpResponse.json(
            { detail: missing ? "Browser missing" : "Provider unavailable" },
            { status: missing ? 404 : 503 },
          );
        }),
      );
      const params = { threadId: a.threadId };
      const viewed = await accept(client().get({ headers, params }), [200]);
      expect(viewed.body.browser).toMatchObject({
        status: "suspended",
        liveUrl: null,
      });
      expect(
        (await client().use({ headers: runHeaders(a), body: {} })).status,
      ).toBe(409);
      expect(
        (
          await client().resizeByThread({
            headers,
            params,
            body: { aspectRatio: 2 },
          })
        ).status,
      ).toBe(409);
      expect(
        (await client().viewerConnection({ headers, params })).status,
      ).toBe(409);
      await accept(client().close({ headers, params, body: {} }), [200]);
      missing = false;
      const failed = await client().get({ headers, params });
      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({
        error: { code: "BROWSER_USE_ERROR" },
      });
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it("shares the owner Browser with a Slack chat and preserves its window after the Run ends", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      nativeCommands(f);
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
      const external = nativeCommands(f);
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
      expect(resized.body.browser.screen?.height).toBe(720);
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
      expect(unchanged.body.browser.screen?.height).toBe(900);
      mockNow(START + MINUTE);
      const leased = await accept(
        client().lease({ headers: runHeaders(a), body: {} }),
        [200],
      );
      expect(Date.parse(String(leased.body.browser.idleExpiresAt))).toBe(
        START + 11 * MINUTE,
      );
      const sibling = accepted(await b.request({ kind: "inspect" }));
      expect(sibling.window?.expiresAt).toBe(START + 10 * MINUTE);
    });
  });

  it("captures only the chat URLs and reopens a new window without recreating the live owner instance", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      nativeCommands(f);
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
      accepted(
        await a.request({ kind: "retire", ...window, reason: "closed" }),
      );
      for (const [id, target] of f.provider.native.targets) {
        if (target.windowId === window.primaryWindowId) {
          f.provider.native.targets.delete(id);
        }
      }
      accepted(await a.request({ kind: "completeWindowClose", ...window }));
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
      for (const [chat, current] of [
        [a, resumed.browser.window],
        [b, second.browser.window],
      ] as const) {
        if (!current) {
          throw new Error("Expected a current chat window");
        }
        accepted(
          await chat.request({ kind: "retire", ...current, reason: "closed" }),
        );
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === current.primaryWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
        accepted(
          await chat.request({ kind: "completeWindowClose", ...current }),
        );
      }
      const stopping = accepted(
        await a.request({ kind: "beginStop", instanceId: window.instanceId }),
      );
      if (!stopping.providerSessionId) {
        throw new Error("Expected a physical provider session");
      }
      // The external provider confirms its stop before the trusted acknowledgement.
      f.provider.sessionIds.delete(stopping.providerSessionId);
      accepted(
        await a.request({
          kind: "completeStop",
          instanceId: window.instanceId,
        }),
      );
      const restarted = await use(a);
      expect(restarted.browser.window?.instanceId).not.toBe(window.instanceId);
      expect(f.provider.createdIds).toHaveLength(1);
      expect(f.provider.sessionRequests).toHaveLength(2);
      expect(f.provider.sessionRequests[1]).toMatchObject({
        profileId: f.provider.createdIds[0],
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

  it("preserves a named Browser and its preview while an earlier first open is still resolving", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      nativeCommands(f);
      const a = await f.start();
      const instance = await allocate(a);
      await admit(a, instance.id, 0);
      const entered = createDeferredPromise<void>(context.signal);
      const release = createDeferredPromise<void>(context.signal);
      let first = true;
      f.provider.native.beforeWindowReply = async () => {
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
      nativeCommands(f);
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
        accepted(
          await a.request({ kind: "retire", ...window, reason: "closed" }),
        );
        f.provider.native.targets.delete(page.targetId);
        accepted(await a.request({ kind: "completeWindowClose", ...window }));
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
        expect(preview).not.toBeNull();
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
      nativeCommands(f);
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
        nativeCommands(f);
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
        accepted(
          await a.request({ kind: "retire", ...window, reason: "closed" }),
        );
        f.provider.native.targets.delete(page.targetId);
        accepted(await a.request({ kind: "completeWindowClose", ...window }));
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

  it("keeps the restored winner when public and Runner admission create multi-page candidates", async () => {
    const f = await fixture();
    await f.owned.run(async () => {
      nativeCommands(f);
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
        client().close({ headers, params: { threadId: a.threadId }, body: {} }),
        [200],
      );
      accepted(
        await a.request({ kind: "retire", ...window, reason: "closed" }),
      );
      for (const [id, target] of f.provider.native.targets) {
        if (target.windowId === window.primaryWindowId) {
          f.provider.native.targets.delete(id);
        }
      }
      accepted(await a.request({ kind: "completeWindowClose", ...window }));
      const both = createDeferredPromise<void>(context.signal);
      let arrivals = 0;
      f.provider.native.beforeCreateReply = async () => {
        if (++arrivals === 2) {
          both.resolve();
        }
        await both.promise;
      };
      const opened = settleIncludingAbort(
        client().use({ headers: runHeaders(a), body: {} }),
      );
      const admitted = settleIncludingAbort(
        a.control({ kind: "admit", instanceId: window.instanceId }),
      );
      const coordinated = await settleIncludingAbort(
        Promise.race([
          both.promise,
          opened.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("Public admission did not reach native creation");
          }),
          admitted.then((result) => {
            if (!result.ok) {
              throw result.error;
            }
            throw new Error("Runner admission did not reach native creation");
          }),
        ]),
      );
      if (!both.settled()) {
        both.resolve();
      }
      const [publicResult, runnerResult] = await Promise.all([
        opened,
        admitted,
      ]);
      if (!coordinated.ok) {
        throw coordinated.error;
      }
      if (!publicResult.ok) {
        throw publicResult.error;
      }
      if (!runnerResult.ok) {
        throw runnerResult.error;
      }
      expect([200, 409]).toContain(publicResult.value.status);
      expect(runnerResult.value.status).toBe(200);
      expect(
        Number(publicResult.value.status === 200) +
          Number(
            runnerResult.value.status === 200 &&
              runnerResult.value.body.outcome === "accepted",
          ),
      ).toBe(1);
      const winner = accepted(await a.request({ kind: "inspect" }));
      const current = await accept(
        client().get({ headers, params: { threadId: a.threadId } }),
        [200],
      );
      expect(current.body.browser.window?.primaryWindowId).toBe(
        winner.window?.primaryWindowId,
      );
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
          winner.window?.primaryWindowId,
          sibling.browser.window?.primaryWindowId,
        ]),
      );
      expect(f.provider.sessionRequests).toHaveLength(1);
    });
  });

  it.each(["sequential", "older-last", "older-first"] as const)(
    "preserves the newer same-window preview with %s completion",
    async (completion) => {
      const f = await fixture();
      await f.owned.run(async () => {
        nativeCommands(f);
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
        nativeCommands(f);
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
        accepted(
          await a.request({ kind: "retire", ...window, reason: "closed" }),
        );
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === window.primaryWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
        accepted(await a.request({ kind: "completeWindowClose", ...window }));
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

  it.each(["public", "runner"] as const)(
    "initializes a window admitted via %s before reporting 900px",
    async (entry) => {
      const f = await fixture();
      await f.owned.run(async () => {
        const { sizes } = nativeCommands(f);
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
        if (entry === "runner") {
          accepted(
            await a.request({
              kind: "admit",
              instanceId: firstWindow.instanceId,
            }),
          );
        }
        const joined = await use(a);
        expect(joined.browser.screen?.height).toBe(900);
        const joinedWindow = joined.browser.window;
        if (!joinedWindow) {
          throw new Error("Expected the admitted Browser window");
        }
        expect(
          sizes.get(joinedWindow.primaryWindowId),
          "All admission entry points must establish the published native contents",
        ).toStrictEqual({ width: 1440, height: 900 });
      });
    },
  );

  it.each(["public", "runner"] as const)(
    "restores the saved chat URLs when the replacement is admitted via %s",
    async (entry) => {
      const f = await fixture();
      await f.owned.run(async () => {
        nativeCommands(f);
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
        accepted(
          await a.request({ kind: "retire", ...window, reason: "closed" }),
        );
        for (const [id, target] of f.provider.native.targets) {
          if (target.windowId === window.primaryWindowId) {
            f.provider.native.targets.delete(id);
          }
        }
        accepted(await a.request({ kind: "completeWindowClose", ...window }));
        if (entry === "runner") {
          accepted(
            await a.request({ kind: "admit", instanceId: window.instanceId }),
          );
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
          "All admission entry points must restore the chat snapshot before publication",
        ).toStrictEqual(["https://a.example.test/saved"]);
      });
    },
  );
});
