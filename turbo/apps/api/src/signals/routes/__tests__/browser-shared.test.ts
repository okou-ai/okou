import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
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
import {
  createRunnerBrowserFixtures,
  MINUTE,
  START,
} from "./helpers/runner-browser-fixture";

const context = testContext();
const { fixture, accepted } = createRunnerBrowserFixtures(context);
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
  const sizes = new Map<
    number,
    { readonly width: number; readonly height: number }
  >();
  f.provider.native.command = (command) => {
    const targetId = command.sessionId?.replace(/^page-/u, "");
    if (command.method === "Target.attachToTarget") {
      return { sessionId: `page-${String(command.params.targetId)}` };
    }
    if (command.method === "Browser.setContentsSize") {
      sizes.set(Number(command.params.windowId), {
        width: Number(command.params.width),
        height: Number(command.params.height),
      });
      return {};
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
      release.resolve();
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
