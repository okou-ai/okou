import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { browserUserActionsContract } from "@okouai/api-contracts/contracts/browser-user-actions";
import { HttpResponse, http } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { literal, object, string } from "zod";
import { TEST_BROWSER_EXTENSION } from "../../../__tests__/browser-extension";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { browserRoutes } from "../browser";
import { browserUserActionRoutes } from "../browser-user-actions";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  createBrowserFixtures,
  MINUTE,
  PROVIDER_URL,
  START,
} from "./helpers/browser-fixture";
import { okouTokenFromExecution } from "./helpers/chat-events-fixture";

const context = testContext();
const runsApi = createRunsApi(context);
const browserFixtures = createBrowserFixtures(context);
const sessionHeaders = Object.freeze({
  authorization: "Bearer clerk-session",
});
const PASSWORD_NODE_ID = 101;
const FILE_NODE_ID = 201;

function deferred() {
  return createDeferredPromise<void>(context.signal);
}

function browserClient() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function userActionsClient() {
  return setupApp({ context, routes: browserUserActionRoutes })(
    browserUserActionsContract,
  );
}

function requireActiveWindow(
  session: Awaited<ReturnType<typeof browserFixtures.view>>,
) {
  if (session.status !== "active") {
    throw new Error("Expected an active Browser session");
  }
  return session.window;
}

function findWindowTarget(
  provider: ReturnType<typeof browserFixtures.profileProvider>,
  windowId: number,
) {
  const target = [...provider.native.targets.values()].find((entry) => {
    return entry.windowId === windowId;
  });
  if (!target) {
    throw new Error(`Expected target in window ${String(windowId)}`);
  }
  return target;
}

function urlsInWindow(
  provider: ReturnType<typeof browserFixtures.profileProvider>,
  windowId: number,
) {
  return [...provider.native.targets.values()]
    .filter((entry) => {
      return entry.windowId === windowId;
    })
    .map((entry) => {
      return entry.url;
    });
}

interface ObservedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

interface InputWriteRecord {
  readonly targetId: string;
  readonly value?: string;
  readonly operation?: string;
}

function installInputCommands(
  provider: ReturnType<typeof browserFixtures.profileProvider>,
  options: { readonly initialFiles?: readonly ObservedFile[] } = {},
) {
  let files: ObservedFile[] = [...(options.initialFiles ?? [])];
  const writes: InputWriteRecord[] = [];
  const nodeByObjectId = new Map<
    string,
    { readonly targetId: string; readonly backendNodeId: number }
  >();

  function handleRuntimeCallFunctionOn(
    targetId: string,
    params: Record<string, unknown>,
  ) {
    const fn = String(params.functionDeclaration ?? "");
    const objectId = String(params.objectId ?? "");
    const resolved = nodeByObjectId.get(objectId);
    if (fn.includes("supportedInputTypes")) {
      return {
        result: {
          value: [
            resolved?.backendNodeId === FILE_NODE_ID
              ? {
                  tagName: "INPUT",
                  inputType: "file",
                  connected: true,
                  mainDocument: true,
                  writable: true,
                  siteRequired: false,
                  multiple: false,
                  accept: ".pdf",
                  files: [...files],
                }
              : {
                  tagName: "INPUT",
                  inputType: "password",
                  connected: true,
                  mainDocument: true,
                  writable: true,
                  siteRequired: false,
                  multiple: false,
                },
          ],
        },
      };
    }
    const args = Array.isArray(params.arguments)
      ? (params.arguments as readonly { readonly value?: unknown }[])
      : [];
    if (fn.includes("DataTransfer")) {
      const operation = String(args[1]?.value ?? "");
      writes.push({ targetId, operation });
      if (operation === "clear") {
        files = [];
      }
      return { result: { value: true } };
    }
    if (fn.includes("JSON.stringify(expected)")) {
      return { result: { value: true } };
    }
    const firstSpec = args[0]?.value;
    if (
      typeof firstSpec === "object" &&
      firstSpec !== null &&
      !("verifyOnly" in firstSpec)
    ) {
      const value =
        "value" in firstSpec && typeof firstSpec.value === "string"
          ? firstSpec.value
          : undefined;
      writes.push({ targetId, value });
    }
    return { result: { value: true } };
  }

  provider.native.command = (command) => {
    const targetId = command.sessionId?.startsWith("page-")
      ? command.sessionId.slice("page-".length)
      : "";
    if (command.method === "Target.attachToTarget") {
      return { sessionId: `page-${String(command.params.targetId)}` };
    }
    if (command.method === "Page.getFrameTree") {
      const target = provider.native.targets.get(targetId);
      return {
        frameTree: {
          frame: {
            id: "main-frame",
            loaderId: "loader-1",
            url: target?.url ?? "about:blank",
          },
        },
      };
    }
    if (command.method === "Page.createIsolatedWorld") {
      return { executionContextId: 1 };
    }
    if (command.method === "DOM.resolveNode") {
      const backendNodeId = Number(command.params.backendNodeId);
      const objectId = `node-${targetId}-${String(backendNodeId)}`;
      nodeByObjectId.set(objectId, { targetId, backendNodeId });
      return { object: { objectId } };
    }
    if (command.method === "Runtime.callFunctionOn") {
      return handleRuntimeCallFunctionOn(targetId, command.params);
    }
    throw new Error(`Unexpected input CDP command: ${command.method}`);
  };

  return {
    writes,
    getFiles() {
      return files;
    },
  };
}

async function setupSharedWindows(
  urlA: string,
  urlB: string,
  options: { readonly initialFiles?: readonly ObservedFile[] } = {},
) {
  const { owned, start, provider } = await browserFixtures.fixture();
  const cdp = installInputCommands(provider, options);
  const chatA = await start();
  const chatB = await start();

  const browserA = await browserFixtures.open(chatA);
  const windowA = requireActiveWindow(browserA);
  expect(windowA.primaryWindowId).toBe(0);

  provider.native.windowIds.push(17);
  const browserB = await browserFixtures.open(chatB);
  const windowB = requireActiveWindow(browserB);
  expect(windowB.primaryWindowId).toBe(17);

  const targetA = findWindowTarget(provider, windowA.primaryWindowId);
  const targetB = findWindowTarget(provider, windowB.primaryWindowId);
  targetA.url = urlA;
  targetB.url = urlB;

  return {
    owned,
    provider,
    cdp,
    chatA,
    chatB,
    windowA,
    windowB,
    targetA,
    targetB,
  };
}

function passwordCreateBody(pageTargetId: string) {
  return {
    kind: "input" as const,
    title: "Sign in to portal",
    reason: "Enter your password to continue",
    callbackPrompt: "Continue after sign-in",
    pageTargetId,
    fields: [
      {
        key: "password",
        label: "Password",
        fieldKind: "password" as const,
        required: true,
        backendNodeId: PASSWORD_NODE_ID,
      },
    ],
  };
}

function fileCreateBody(pageTargetId: string) {
  return {
    kind: "input" as const,
    title: "Upload receipt",
    reason: "Provide or clear the document on this form",
    callbackPrompt: "Continue after upload",
    pageTargetId,
    fields: [
      {
        key: "document",
        label: "Document",
        fieldKind: "file" as const,
        required: false,
        backendNodeId: FILE_NODE_ID,
      },
    ],
  };
}

describe("shared Browser lifecycle, reclaim, recovery, and native input", () => {
  beforeAll(async () => {
    await settleIncludingAbort(async () => {
      const warmupUser = createBddApi(context).user();
      await runsApi.grantProEntitlement(warmupUser);
      await runsApi.configureRunnerGroup();
    });
  });

  it(
    "browser-profile-cleanup-001 publishes one owner instance and cleans only the losing profile during concurrent first opens",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      let arrived = 0;
      const bothArrived = deferred();
      const provider = browserFixtures.profileProvider(async () => {
        arrived += 1;
        if (arrived === 2) {
          bothArrived.resolve();
        }
        await bothArrived.promise;
      });
      const { start } = await browserFixtures.fixture(provider);
      const chatA = await start();
      const chatB = await start();

      const [resA, resB] = await Promise.all([
        accept(
          browserClient().use({
            headers: {
              authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
            },
            body: {},
          }),
          [200, 409],
        ),
        accept(
          browserClient().use({
            headers: {
              authorization: `Bearer ${okouTokenFromExecution(chatB.execution)}`,
            },
            body: {},
          }),
          [200, 409],
        ),
      ]);

      expect([resA.status, resB.status].sort()).toStrictEqual([200, 409]);
      expect(provider.createdIds).toHaveLength(2);
      expect(provider.sessionRequests).toHaveLength(1);

      const { profileId: winningProfileId } = object({
        profileId: string(),
      }).parse(provider.sessionRequests[0]);
      const losingProfileId = provider.createdIds.find((id) => {
        return id !== winningProfileId;
      });
      if (!losingProfileId) {
        throw new Error("Expected a losing profile ID");
      }

      const [winnerCheck, loserCheck] = await Promise.all([
        fetch(`${PROVIDER_URL}/profiles/${winningProfileId}`),
        fetch(`${PROVIDER_URL}/profiles/${losingProfileId}`),
      ]);
      expect(winnerCheck.status).toBe(200);
      expect(loserCheck.status).toBe(404);
    },
  );

  it(
    "browser-reclaim-012 leaves an intentionally moved page in its current sibling window",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const chatB = await start();
      const browserA = await browserFixtures.open(chatA);
      const browserB = await browserFixtures.open(chatB);
      const windowA = requireActiveWindow(browserA);
      const windowB = requireActiveWindow(browserB);

      const targetA = findWindowTarget(provider, windowA.primaryWindowId);
      targetA.url = "https://a.example.test/moved";
      targetA.windowId = windowB.primaryWindowId;

      mockNow(START + 9 * MINUTE);
      await browserFixtures.renew(chatB);

      mockNow(START + 11 * MINUTE);
      const reopenedA = await browserFixtures.open(chatA);
      const reopenedWindowA = requireActiveWindow(reopenedA);

      expect(reopenedWindowA.instanceId).toBe(windowA.instanceId);
      const urlsInB = urlsInWindow(provider, windowB.primaryWindowId);
      expect(urlsInB).toHaveLength(2);
      expect(urlsInB).toContain("https://a.example.test/moved");
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-reclaim-003 saves and restores expired A in the same instance while preserving active B",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const chatB = await start();
      const browserA = await browserFixtures.open(chatA);
      const browserB = await browserFixtures.open(chatB);
      const windowA = requireActiveWindow(browserA);
      const windowB = requireActiveWindow(browserB);

      findWindowTarget(provider, windowA.primaryWindowId).url =
        "https://a.example.test/task";
      const targetB = findWindowTarget(provider, windowB.primaryWindowId);
      targetB.url = "https://b.example.test/task";

      mockNow(START + 9 * MINUTE);
      const renewedB = await browserFixtures.renew(chatB);
      const renewedExpiryB = renewedB.idleExpiresAt;

      mockNow(START + 11 * MINUTE);
      const recoveredA = await browserFixtures.open(chatA);
      const readB = await browserFixtures.view(chatB);
      const recoveredWindowA = requireActiveWindow(recoveredA);

      expect(recoveredWindowA.instanceId).toBe(windowA.instanceId);
      expect(recoveredWindowA.primaryWindowId).not.toBe(
        windowA.primaryWindowId,
      );
      expect(
        urlsInWindow(provider, recoveredWindowA.primaryWindowId),
      ).toStrictEqual(["https://a.example.test/task"]);
      expect(urlsInWindow(provider, windowB.primaryWindowId)).toStrictEqual([
        "https://b.example.test/task",
      ]);
      expect(requireActiveWindow(readB)).toStrictEqual(windowB);
      expect(readB.idleExpiresAt).toBe(renewedExpiryB);
      expect(provider.sessionRequests).toHaveLength(1);
    },
  );

  it(
    "browser-lifecycle-004 creates a proxyless shared Browser with the required extension",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chat = await start();

      const created = await accept(
        browserClient().create({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chat.execution)}`,
          },
          body: { name: "Research browser" },
        }),
        [201],
      );

      expect(created.body.browser.name).toBe("Research browser");
      expect(created.body.browser.status).toBe("active");
      expect(created.body.extension).toStrictEqual(TEST_BROWSER_EXTENSION);
      expect(provider.sessionRequests).toHaveLength(1);
      expect(
        object({ proxyCountryCode: literal(null) }).parse(
          provider.sessionRequests[0],
        ).proxyCountryCode,
      ).toBeNull();
    },
  );

  it(
    "browser-lifecycle-007 provisions one profile and instance for two chats, reads and resizes only each owned window",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const chatB = await start();
      const tokenA = {
        authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
      };
      const tokenB = {
        authorization: `Bearer ${okouTokenFromExecution(chatB.execution)}`,
      };

      const useA1 = await accept(
        browserClient().use({ headers: tokenA, body: {} }),
        [200],
      );
      const windowA = requireActiveWindow(useA1.body.browser);
      expect(useA1.body.extension).toStrictEqual(TEST_BROWSER_EXTENSION);
      expect(useA1.body.cdpUrl).toBe(provider.cdpUrl);

      const currentA = await accept(
        browserClient().current({ headers: tokenA }),
        [200],
      );
      expect(requireActiveWindow(currentA.body.browser)).toStrictEqual(windowA);

      const resizedA = await accept(
        browserClient().resizeByThread({
          headers: sessionHeaders,
          params: { threadId: chatA.threadId },
          body: { aspectRatio: 2 },
        }),
        [200],
      );
      expect(requireActiveWindow(resizedA.body.browser)).toStrictEqual(windowA);

      const useB = await accept(
        browserClient().use({ headers: tokenB, body: {} }),
        [200],
      );
      const windowB = requireActiveWindow(useB.body.browser);
      expect(useB.body.extension).toStrictEqual(TEST_BROWSER_EXTENSION);
      expect(useB.body.cdpUrl).toBe(provider.cdpUrl);
      expect(windowB.instanceId).toBe(windowA.instanceId);
      expect(windowB.primaryWindowId).not.toBe(windowA.primaryWindowId);

      const useA2 = await accept(
        browserClient().use({ headers: tokenA, body: {} }),
        [200],
      );
      expect(requireActiveWindow(useA2.body.browser)).toStrictEqual(windowA);
      expect(useA2.body.extension).toStrictEqual(TEST_BROWSER_EXTENSION);
      expect(useA2.body.cdpUrl).toBe(provider.cdpUrl);

      const readB1 = await browserFixtures.view(chatB);
      expect(requireActiveWindow(readB1)).toStrictEqual(windowB);
      expect(provider.createdIds).toHaveLength(1);
      expect(provider.sessionRequests).toHaveLength(1);
      expect(
        object({
          profileId: string(),
          proxyCountryCode: literal(null),
        }).parse(provider.sessionRequests[0]),
      ).toStrictEqual({
        profileId: provider.createdIds[0],
        proxyCountryCode: null,
      });
      expect(
        provider.native.contentsSizes.get(windowA.primaryWindowId),
      ).toStrictEqual({ width: 1440, height: 720 });
      expect(
        provider.native.contentsSizes.get(windowB.primaryWindowId),
      ).toStrictEqual({ width: 1440, height: 900 });

      mockNow(START + MINUTE);
      const leasedA = await accept(
        browserClient().lease({ headers: tokenA, body: {} }),
        [200],
      );
      const readB2 = await browserFixtures.view(chatB);

      mockNow(START + 11 * MINUTE);
      const expectedExpiryA = nowDate().toISOString();
      mockNow(START + 10 * MINUTE);
      const expectedExpiryB = nowDate().toISOString();

      expect(leasedA.body.browser.idleExpiresAt).toBe(expectedExpiryA);
      expect(readB2.idleExpiresAt).toBe(expectedExpiryB);
    },
  );

  it(
    "browser-lifecycle-031 initializes native contents before publishing a window",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatB = await start();
      const browserB = await browserFixtures.open(chatB);
      const windowB = requireActiveWindow(browserB);

      provider.native.beforeCreateReply = (target) => {
        provider.native.contentsSizes.set(target.windowId, {
          width: 1440,
          height: 776,
        });
      };

      const resizedB = await accept(
        browserClient().resizeByThread({
          headers: sessionHeaders,
          params: { threadId: chatB.threadId },
          body: { aspectRatio: 2 },
        }),
        [200],
      );
      expect(resizedB.status).toBe(200);
      expect(
        provider.native.contentsSizes.get(windowB.primaryWindowId),
      ).toStrictEqual({ width: 1440, height: 720 });

      const chatA = await start();
      const browserA = await browserFixtures.open(chatA);
      const windowA = requireActiveWindow(browserA);

      expect(
        provider.native.contentsSizes.get(windowA.primaryWindowId),
      ).toStrictEqual({ width: 1440, height: 900 });
    },
  );

  it(
    "browser-native-extension-004 restores accepted URLs and eventually stops the Browser after unfinished window close",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const chatB = await start();
      const browserA = await browserFixtures.open(chatA);
      const browserB = await browserFixtures.open(chatB);
      const windowA = requireActiveWindow(browserA);
      const windowB = requireActiveWindow(browserB);

      const oldTargetA = findWindowTarget(provider, windowA.primaryWindowId);
      oldTargetA.url = "https://a.example.test/accepted";

      mockNow(START + 9 * MINUTE);
      await browserFixtures.renew(chatB);
      mockNow(START + 11 * MINUTE);
      provider.native.closeSucceeds = false;

      const firstUse = await browserFixtures.open(chatA);
      const midWindowA = requireActiveWindow(firstUse);
      expect(midWindowA.instanceId).toBe(windowA.instanceId);
      expect(midWindowA.primaryWindowId).not.toBe(windowA.primaryWindowId);
      expect(
        urlsInWindow(provider, midWindowA.primaryWindowId).filter((url) => {
          return url !== "about:blank";
        }),
      ).toStrictEqual(["https://a.example.test/accepted"]);
      expect(provider.native.targets.has(oldTargetA.targetId)).toBeTruthy();

      oldTargetA.url = "https://a.example.test/later-unrestored";
      const readB1 = await browserFixtures.view(chatB);
      expect(requireActiveWindow(readB1)).toStrictEqual(windowB);
      expect(provider.sessionRequests).toHaveLength(1);

      provider.native.closeSucceeds = true;
      mockNow(START + 30 * MINUTE);

      const secondUse = await browserFixtures.open(chatA);
      const finalWindowA = requireActiveWindow(secondUse);
      const readB2 = await browserFixtures.view(chatB);

      expect(finalWindowA.instanceId).not.toBe(windowA.instanceId);
      expect(provider.stoppedSessionIds.size).toBe(1);
      expect(provider.sessionRequests).toHaveLength(2);
      expect(
        [...provider.native.targets.values()].map((entry) => {
          return entry.url;
        }),
      ).toStrictEqual(["https://a.example.test/accepted"]);
      expect(readB2.status).toBe("suspended");
    },
  );

  it(
    "browser-native-extension-007 restores A's URLs while sibling native events advance the global sequence",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { start, provider } = await browserFixtures.fixture();
      const chatA = await start();
      const chatB = await start();
      const browserA = await browserFixtures.open(chatA);
      const browserB = await browserFixtures.open(chatB);
      const windowA = requireActiveWindow(browserA);
      const windowB = requireActiveWindow(browserB);

      const targetA = findWindowTarget(provider, windowA.primaryWindowId);
      targetA.url = "https://a.example.test/busy-sibling";

      mockNow(START + 9 * MINUTE);
      await browserFixtures.renew(chatB);
      provider.native.snapshotEventWindowId = windowB.primaryWindowId;
      mockNow(START + 11 * MINUTE);

      const recoveredA = await browserFixtures.open(chatA);
      const readB = await browserFixtures.view(chatB);
      const recoveredWindowA = requireActiveWindow(recoveredA);

      expect(recoveredWindowA.instanceId).toBe(windowA.instanceId);
      expect(
        urlsInWindow(provider, recoveredWindowA.primaryWindowId),
      ).toStrictEqual(["https://a.example.test/busy-sibling"]);
      expect(requireActiveWindow(readB)).toStrictEqual(windowB);
    },
  );

  it(
    "browser-profile-cleanup-003 cleans an unadopted profile after the Run ends during preparation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const profileCreated = deferred();
      const releaseProfile = deferred();
      const provider = browserFixtures.profileProvider(async () => {
        profileCreated.resolve();
        await releaseProfile.promise;
      });
      const { owned, start } = await browserFixtures.fixture(provider);
      const chat = await start();

      const pendingUse = accept(
        browserClient().use({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chat.execution)}`,
          },
          body: {},
        }),
        [409],
      );

      await profileCreated.promise;
      await runsApi.requestCancelRun(owned.actor, chat.runId, [200, 400]);
      const completed = await createWebhookCallbackApi(
        context,
      ).requestAgentComplete(
        { runId: chat.runId, exitCode: 1, error: "Run cancelled" },
        { authorization: `Bearer ${chat.execution.sandboxToken}` },
        [200],
      );
      expect(completed.status).toBe(200);

      releaseProfile.resolve();
      const useResponse = await pendingUse;
      expect(useResponse.status).toBe(409);
      expect(provider.sessionRequests).toStrictEqual([]);
      expect(provider.createdIds).toHaveLength(1);

      for (const id of provider.createdIds) {
        const check = await fetch(`${PROVIDER_URL}/profiles/${id}`);
        expect(check.status).toBe(404);
      }
    },
  );

  it(
    "browser-recovery-003 preserves another owner's accepted profile when the provider repeats its identity",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const provider = browserFixtures.profileProvider();
      const owner1 = await browserFixtures.fixture(provider);
      const chat1 = await owner1.start();
      await browserFixtures.open(chat1);
      const firstProfileId = provider.createdIds[0];
      if (!firstProfileId) {
        throw new Error("Expected first owner profile ID");
      }

      const owner2 = await browserFixtures.fixture(provider);
      const chat2 = await owner2.start();

      let duplicateOnce = true;
      server.use(
        http.post(`${PROVIDER_URL}/profiles`, () => {
          if (!duplicateOnce) {
            return undefined;
          }
          duplicateOnce = false;
          return HttpResponse.json(provider.profile(firstProfileId), {
            status: 201,
          });
        }),
        ...provider.handlers,
      );

      const secondUse = await accept(
        browserClient().use({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chat2.execution)}`,
          },
          body: {},
        }),
        [502],
      );
      expect(secondUse.body.error.code).toBe("BROWSER_USE_INVALID_RESPONSE");

      const firstProfileCheck = await fetch(
        `${PROVIDER_URL}/profiles/${firstProfileId}`,
      );
      expect(firstProfileCheck.status).toBe(200);
      expect(provider.stoppedSessionIds.size).toBe(0);

      const firstAgain = await browserFixtures.open(chat1);
      expect(firstAgain.status).toBe("active");
    },
  );

  it(
    "browser-input-003 captures window zero and applies only the owned page without exposing sealed identities or values",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const loginUrl = "https://auth.example.test/login";
      const { cdp, chatA, chatB, targetA } = await setupSharedWindows(
        loginUrl,
        loginUrl,
      );

      const created = await accept(
        userActionsClient().create({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
          },
          body: passwordCreateBody(targetA.targetId),
        }),
        [201],
      );
      const requestToken = created.body.action.requestToken;

      const preflight = await accept(
        userActionsClient().preflight({
          headers: sessionHeaders,
          params: { requestToken },
          body: {},
        }),
        [200],
      );
      expect(preflight.body.state).toBe("pending");

      const applied = await accept(
        userActionsClient().apply({
          headers: sessionHeaders,
          params: { requestToken },
          body: {
            values: [{ key: "password", value: "private-input-value" }],
          },
        }),
        [200],
      );
      expect(applied.body.state).toBe("succeeded");
      expect(JSON.stringify(applied.body)).not.toContain("private-input-value");
      expect(cdp.writes).toStrictEqual([
        { targetId: targetA.targetId, value: "private-input-value" },
      ]);

      const readAfter = await accept(
        userActionsClient().get({
          headers: sessionHeaders,
          params: { requestToken },
        }),
        [200],
      );
      expect(readAfter.body.state).toBe("succeeded");

      const viewB = await browserFixtures.view(chatB);
      expect(requireActiveWindow(viewB).primaryWindowId).toBe(17);
    },
  );

  it(
    "browser-input-004 rejects sibling capture and treats a moved page as stale without writing",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { cdp, chatA, targetA, targetB } = await setupSharedWindows(
        "https://auth.example.test/login",
        "https://auth.example.test/login",
      );
      const tokenA = {
        authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
      };

      const siblingRejected = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: passwordCreateBody(targetB.targetId),
        }),
        [409],
      );
      expect(siblingRejected.body.error.code).toBe(
        "BROWSER_USER_ACTION_PAGE_TARGET_NOT_FOUND",
      );

      const created1 = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: passwordCreateBody(targetA.targetId),
        }),
        [201],
      );
      targetA.windowId = 17;
      const stalePreflight = await accept(
        userActionsClient().preflight({
          headers: sessionHeaders,
          params: { requestToken: created1.body.action.requestToken },
          body: {},
        }),
        [200],
      );
      expect(stalePreflight.body.state).toBe("stale");

      targetA.windowId = 0;
      const created2 = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: passwordCreateBody(targetA.targetId),
        }),
        [201],
      );
      targetA.windowId = 17;
      const staleApply = await accept(
        userActionsClient().apply({
          headers: sessionHeaders,
          params: { requestToken: created2.body.action.requestToken },
          body: { values: [{ key: "password", value: "never-written" }] },
        }),
        [200],
      );
      expect(staleApply.body.state).toBe("stale");
      expect(cdp.writes).toStrictEqual([]);
    },
  );

  it(
    "browser-input-006 expires A without reviving it through B's provider and accepts only a newly admitted A window",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const loginUrl = "https://auth.example.test/login";
      const { provider, cdp, chatA, chatB, targetA } = await setupSharedWindows(
        loginUrl,
        loginUrl,
      );
      const tokenA = {
        authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
      };

      const oldCreated = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: passwordCreateBody(targetA.targetId),
        }),
        [201],
      );
      const oldToken = oldCreated.body.action.requestToken;

      mockNow(START + 9 * MINUTE);
      const renewedB = await browserFixtures.renew(chatB);
      const expiryB = renewedB.idleExpiresAt;

      mockNow(START + 11 * MINUTE);
      const expiredPreflight = await accept(
        userActionsClient().preflight({
          headers: sessionHeaders,
          params: { requestToken: oldToken },
          body: {},
        }),
        [410],
      );
      expect(expiredPreflight.status).toBe(410);

      const createBeforeReacquire = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: passwordCreateBody(targetA.targetId),
        }),
        [409],
      );
      expect(createBeforeReacquire.status).toBe(409);

      const replacementA = await browserFixtures.open(chatA);
      const replacementWindowA = requireActiveWindow(replacementA);
      const replacementTargetA = findWindowTarget(
        provider,
        replacementWindowA.primaryWindowId,
      );
      replacementTargetA.url = loginUrl;

      const oldApply = await accept(
        userActionsClient().apply({
          headers: sessionHeaders,
          params: { requestToken: oldToken },
          body: { values: [{ key: "password", value: "stale-secret" }] },
        }),
        [410],
      );
      expect(oldApply.status).toBe(410);

      const freshCreated = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: passwordCreateBody(replacementTargetA.targetId),
        }),
        [201],
      );
      const freshApplied = await accept(
        userActionsClient().apply({
          headers: sessionHeaders,
          params: { requestToken: freshCreated.body.action.requestToken },
          body: { values: [{ key: "password", value: "fresh-value" }] },
        }),
        [200],
      );
      expect(freshApplied.body.state).toBe("succeeded");
      expect(cdp.writes).toStrictEqual([
        { targetId: replacementTargetA.targetId, value: "fresh-value" },
      ]);

      const viewB = await browserFixtures.view(chatB);
      expect(viewB.idleExpiresAt).toBe(expiryB);
    },
  );

  it(
    "browser-input-013 binds staged files and native file readback to the same window",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const signedUploadUrl = "https://storage.example.test/staged-upload";
      const { cdp, chatA, targetA } = await setupSharedWindows(
        "https://upload.example.test/form",
        "https://other.example.test/home",
        {
          initialFiles: [
            { name: "receipt.pdf", size: 128, type: "application/pdf" },
          ],
        },
      );
      context.mocks.s3.getSignedUrl.mockResolvedValue(signedUploadUrl);

      const tokenA = {
        authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
      };
      const created1 = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: fileCreateBody(targetA.targetId),
        }),
        [201],
      );
      const token1 = created1.body.action.requestToken;

      const prepared1 = await accept(
        userActionsClient().prepareFileUpload({
          headers: sessionHeaders,
          params: { requestToken: token1 },
          body: { key: "document", index: 0, size: 128 },
        }),
        [200],
      );
      expect(prepared1.body.uploadUrl).toBe(signedUploadUrl);

      const preflight = await accept(
        userActionsClient().preflight({
          headers: sessionHeaders,
          params: { requestToken: token1 },
          body: {},
        }),
        [200],
      );
      const observedFingerprint =
        preflight.body.fields[0]?.control.fileSetFingerprint;
      if (!observedFingerprint) {
        throw new Error("Expected fileSetFingerprint from preflight");
      }

      const cleared = await accept(
        userActionsClient().apply({
          headers: sessionHeaders,
          params: { requestToken: token1 },
          body: {
            values: [
              {
                key: "document",
                observedFingerprint,
                operation: "clear",
                files: [],
              },
            ],
          },
        }),
        [200],
      );
      expect(cleared.body.state).toBe("succeeded");
      expect(cdp.getFiles()).toStrictEqual([]);
      expect(cdp.writes).toStrictEqual([
        { targetId: targetA.targetId, operation: "clear" },
      ]);

      const created2 = await accept(
        userActionsClient().create({
          headers: tokenA,
          body: fileCreateBody(targetA.targetId),
        }),
        [201],
      );
      mockNow(START + 11 * MINUTE);

      const expiredPrepare = await accept(
        userActionsClient().prepareFileUpload({
          headers: sessionHeaders,
          params: { requestToken: created2.body.action.requestToken },
          body: { key: "document", index: 0, size: 64 },
        }),
        [410],
      );
      expect(expiredPrepare.status).toBe(410);
    },
  );

  it(
    "browser-input-014 exposes retired shared input as stale without touching the sibling window",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockNow(START);
      onTestFinished(() => {
        clearMockNow();
      });

      const { cdp, chatA, chatB, targetA } = await setupSharedWindows(
        "https://auth.example.test/login",
        "https://other.example.test/home",
      );

      const created = await accept(
        userActionsClient().create({
          headers: {
            authorization: `Bearer ${okouTokenFromExecution(chatA.execution)}`,
          },
          body: passwordCreateBody(targetA.targetId),
        }),
        [201],
      );
      const requestToken = created.body.action.requestToken;

      mockNow(START + 9 * MINUTE);
      await browserFixtures.renew(chatB);

      mockNow(START + 11 * MINUTE);
      await browserFixtures.open(chatA);

      const [readInput, readB] = await Promise.all([
        accept(
          userActionsClient().get({
            headers: sessionHeaders,
            params: { requestToken },
          }),
          [410],
        ),
        accept(
          browserClient().get({
            headers: sessionHeaders,
            params: { threadId: chatB.threadId },
          }),
          [200],
        ),
      ]);
      expect(readInput.status).toBe(410);
      expect(readB.body.browser.status).toBe("active");
      expect(cdp.writes).toStrictEqual([]);
    },
  );
});
