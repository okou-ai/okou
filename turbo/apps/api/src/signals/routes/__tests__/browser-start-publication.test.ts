import { browserUserActionsContract } from "@okouai/api-contracts/contracts/browser-user-actions";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockNow } from "../../../lib/time";
import { browserUserActionRoutes } from "../browser-user-actions";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { strictObject, string } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { browserRoutes } from "../browser";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { okouTokenFromClaim } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const PROVIDER_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT = Date.parse("2026-07-24T10:00:00.000Z");

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

describe("Browser start publication", () => {
  it("keeps a browser unpublished when its provider identity already exists", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    mockEnv("APP_URL", "https://app.okou.ai");
    const chat = createChatFilesBddApi(context);
    const threadIds: string[] = [];
    const providerId = randomUUID();
    let providerStatus: "active" | "stopped" = "active";
    const webSocketUrl = `wss://${providerId}.cdp.browser-use.com/devtools/browser/test`;
    function providerSession() {
      const active = providerStatus === "active";
      return {
        id: providerId,
        status: providerStatus,
        liveUrl: active
          ? `https://live.browser-use.com/?wss=${providerId}`
          : null,
        cdpUrl: active ? `https://${providerId}.cdp.browser-use.com/` : null,
        extensions: [TEST_BROWSER_EXTENSION],
        timeoutAt: new Date(STARTED_AT + 240 * 60_000).toISOString(),
        startedAt: new Date(STARTED_AT).toISOString(),
        finishedAt: active ? null : new Date(STARTED_AT).toISOString(),
        agentSessionId: null,
        recordingUrl: null,
      };
    }
    server.use(
      http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
        const { name } = strictObject({ name: string() }).parse(
          await request.json(),
        );
        return HttpResponse.json(
          {
            id: randomUUID(),
            userId: null,
            name,
            lastUsedAt: null,
            createdAt: new Date(STARTED_AT).toISOString(),
            updatedAt: new Date(STARTED_AT).toISOString(),
            cookieDomains: null,
          },
          { status: 201 },
        );
      }),
      http.delete(`${PROVIDER_URL}/profiles/:id`, () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${PROVIDER_URL}/browsers`, () => {
        return HttpResponse.json(providerSession(), { status: 201 });
      }),
      http.get(`${PROVIDER_URL}/browsers/:id`, () => {
        return HttpResponse.json(providerSession());
      }),
      http.patch(`${PROVIDER_URL}/browsers/:id`, () => {
        providerStatus = "stopped";
        return HttpResponse.json(providerSession());
      }),
      http.get(`https://${providerId}.cdp.browser-use.com/json/version`, () => {
        return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
      }),
      browserUseCdpHandler(webSocketUrl),
    );
    const owned = await publicChatActor(context, {
      optionalEnvironmentNames: ["OKOU_BROWSER_USE_API_KEY"],
      clockTime: STARTED_AT,
      beforeWorkspaceCleanup: async (actor) => {
        for (const threadId of threadIds) {
          await chat.deleteThread(actor, threadId);
          await flushWaitUntilForTest();
        }
      },
    });
    await owned.run(async () => {
      async function startRun(prompt: string) {
        const sent = await chat.sendAndLaunch(owned.actor, {
          agentId: owned.agentId,
          prompt,
          cloudBrowserEnabled: true,
        });
        threadIds.push(sent.threadId);
        const claimed = await owned.claimChatRun(owned.runnerGroup, sent.runId);
        return {
          threadId: sent.threadId,
          headers: {
            authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
          },
        };
      }
      const first = await startRun("Open the first managed browser");
      const active = await accept(
        client().use({ headers: first.headers, body: {} }),
        [200],
      );
      expect(active.body.browser).toMatchObject({
        threadId: first.threadId,
        status: "active",
        screen: { width: 1440, height: 900, resizable: true },
      });

      const second = await startRun("Open another managed browser");
      const failed = await createApp({
        signal: context.signal,
        routes: browserRoutes,
      }).request("/api/browsers/use", {
        method: "POST",
        headers: { ...second.headers, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(failed.status).toBe(500);
      await flushWaitUntilForTest();
      const current = await accept(
        client().current({ headers: second.headers }),
        [200],
      );
      expect(current.body.browser).toMatchObject({
        threadId: second.threadId,
        status: "creating",
      });
      expect(current.body.browser).not.toHaveProperty("screen");
    });
  });
});

function actions() {
  return setupApp({ context, routes: browserUserActionRoutes })(
    browserUserActionsContract,
  );
}
function mockNativeInputTarget(): void {
  context.mocks.browserUseCdp.command.mockImplementation((command) => {
    switch (command.method) {
      case "Target.getTargets": {
        return {
          targetInfos: [
            {
              targetId: "native-input-target",
              type: "page",
              url: "https://example.com/login",
            },
          ],
        };
      }
      case "Browser.getWindowForTarget": {
        return { windowId: 7 };
      }
      case "Target.attachToTarget": {
        return { sessionId: "native-input-session" };
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "native-input-loader",
              url: "https://example.com/login",
            },
          },
        };
      }
      case "DOM.resolveNode": {
        return { object: { objectId: "native-password-object" } };
      }
      case "Runtime.callFunctionOn": {
        const declaration = String(command.params.functionDeclaration);
        if (
          declaration.includes("firstSpec") ||
          declaration.includes("cloneNode")
        ) {
          return { result: { value: true } };
        }
        const objectIds = [
          command.params.objectId,
          ...(Array.isArray(command.params.arguments)
            ? command.params.arguments.flatMap((argument) => {
                return typeof argument === "object" &&
                  argument !== null &&
                  "objectId" in argument
                  ? [argument.objectId]
                  : [];
              })
            : []),
        ];
        return {
          result: {
            value: objectIds.map(() => {
              return {
                tagName: "INPUT",
                inputType: "password",
                connected: true,
                mainDocument: true,
                writable: true,
                siteRequired: false,
                multiple: false,
              };
            }),
          },
        };
      }
      default: {
        return {};
      }
    }
  });
}

function nativePasswordRequest(callbackPrompt: string) {
  return {
    kind: "input" as const,
    title: "Sign in to download invoices",
    reason: "The website requires sign-in to access your invoices.",
    callbackPrompt,
    pageTargetId: "native-input-target",
    fields: [
      {
        key: "password",
        label: "Password",
        fieldKind: "password" as const,
        required: true,
        backendNodeId: 42,
      },
    ],
  };
}

async function prepareScenario() {
  mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.okou.ai");
  const chat = createChatFilesBddApi(context);
  let threadId: string | undefined;
  const providerId = randomUUID();
  let providerStatus: "active" | "stopped" = "active";
  const webSocketUrl = `wss://${providerId}.cdp.browser-use.com/devtools/browser/test`;
  function providerSession() {
    const active = providerStatus === "active";
    return {
      id: providerId,
      status: providerStatus,
      liveUrl: active
        ? `https://live.browser-use.com/?wss=${providerId}`
        : null,
      cdpUrl: active ? `https://${providerId}.cdp.browser-use.com/` : null,
      extensions: [TEST_BROWSER_EXTENSION],
      timeoutAt: new Date(STARTED_AT + 240 * 60_000).toISOString(),
      startedAt: new Date(STARTED_AT).toISOString(),
      finishedAt: active ? null : new Date(STARTED_AT).toISOString(),
      agentSessionId: null,
      recordingUrl: null,
    };
  }
  server.use(
    http.post(`${PROVIDER_URL}/profiles`, async ({ request }) => {
      const { name } = strictObject({ name: string() }).parse(
        await request.json(),
      );
      return HttpResponse.json(
        {
          id: randomUUID(),
          userId: null,
          name,
          lastUsedAt: null,
          createdAt: new Date(STARTED_AT).toISOString(),
          updatedAt: new Date(STARTED_AT).toISOString(),
          cookieDomains: null,
        },
        { status: 201 },
      );
    }),
    http.delete(`${PROVIDER_URL}/profiles/:id`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${PROVIDER_URL}/browsers`, () => {
      return HttpResponse.json(providerSession(), { status: 201 });
    }),
    http.get(`${PROVIDER_URL}/browsers/:id`, () => {
      return HttpResponse.json(providerSession());
    }),
    http.patch(`${PROVIDER_URL}/browsers/:id`, () => {
      providerStatus = "stopped";
      return HttpResponse.json(providerSession());
    }),
    http.get(`https://${providerId}.cdp.browser-use.com/json/version`, () => {
      return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
    }),
    browserUseCdpHandler(webSocketUrl),
  );
  const owned = await publicChatActor(context, {
    clockTime: STARTED_AT,
    optionalEnvironmentNames: ["OKOU_BROWSER_USE_API_KEY"],
    beforeWorkspaceCleanup: async (actor) => {
      if (threadId) {
        await chat.deleteThread(actor, threadId);
        await flushWaitUntilForTest();
      }
    },
  });
  const orgId = owned.actor.orgId;
  if (!orgId) {
    throw new Error("Browser action creation requires an organization");
  }
  return await owned.run(async () => {
    owned.ownsFeatureSwitches();
    await updateFeatureSwitchesForUser(
      context,
      { ...owned.actor, orgId },
      {
        [FeatureSwitchKey.BrowserNativeInput]: true,
      },
    );
    const sent = await chat.sendAndLaunch(owned.actor, {
      agentId: owned.agentId,
      prompt: "Enter the website password",
      cloudBrowserEnabled: true,
    });
    threadId = sent.threadId;
    const claimed = await owned.claimChatRun(owned.runnerGroup, sent.runId);
    const runHeaders = {
      authorization: `Bearer ${okouTokenFromClaim(claimed.claim)}`,
    };
    await accept(client().use({ headers: runHeaders, body: {} }), [200]);
    return {
      ...owned,
      threadId: sent.threadId,
      runHeaders,
      providerId,
      providerSession: providerSession(),
    };
  });
}
describe("Browser action creation", () => {
  it("keeps created requests separate and rejects a lease that expires during external validation", async () => {
    const owned = await prepareScenario();
    await owned.run(async () => {
      mockNativeInputTarget();
      const first = await accept(
        actions().create({
          headers: owned.runHeaders,
          body: nativePasswordRequest("Continue after the first password"),
        }),
        [201],
      );
      const second = await accept(
        actions().create({
          headers: owned.runHeaders,
          body: nativePasswordRequest("Continue after the second password"),
        }),
        [201],
      );
      expect(first.body.action.requestToken).not.toBe(
        second.body.action.requestToken,
      );
      const headers = { authorization: "Bearer clerk-session" };
      for (const created of [first, second]) {
        const observed = await accept(
          actions().get({
            headers,
            params: { requestToken: created.body.action.requestToken },
          }),
          [200],
        );
        expect(observed.body.state).toBe("pending");
      }
      const leased = await accept(
        client().leaseByThread({
          headers,
          params: { threadId: owned.threadId },
          body: {},
        }),
        [200],
      );
      const deadline = leased.body.browser.idleExpiresAt;
      if (!deadline) {
        throw new Error("Expected the owner's Browser lease");
      }
      const validationStarted = createDeferredPromise<void>(context.signal);
      const releaseValidation = createDeferredPromise<void>(context.signal);
      server.use(
        http.get(
          `${PROVIDER_URL}/browsers/${owned.providerId}`,
          async () => {
            validationStarted.resolve();
            await releaseValidation.promise;
            return HttpResponse.json(owned.providerSession);
          },
          { once: true },
        ),
      );
      const pending = settleIncludingAbort(() => {
        return actions().create({
          headers: owned.runHeaders,
          body: nativePasswordRequest("Continue after the delayed validation"),
        });
      });
      const advance = await settleIncludingAbort(async () => {
        await validationStarted.promise;
        mockNow(Date.parse(deadline) + 1);
      });
      releaseValidation.resolve();
      const rejected = await pending;
      if (!advance.ok) {
        throw advance.error;
      }
      if (!rejected.ok) {
        throw rejected.error;
      }
      expect(rejected.value).toMatchObject({
        status: 404,
        body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
      });
      const previous = await actions().get({
        headers,
        params: { requestToken: first.body.action.requestToken },
      });
      expect(previous).toMatchObject({
        status: 410,
        body: { error: { code: "BROWSER_USER_ACTION_EXPIRED" } },
      });
    });
  });
});
