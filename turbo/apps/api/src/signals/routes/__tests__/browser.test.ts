import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installArtifactReferenceStorage } from "./helpers/artifact-reference-storage";
import { createHash, randomUUID } from "node:crypto";

import { testBrowserReconcileContract } from "@okouai/api-contracts/contracts/test-browser-reconcile";
import {
  browserAuthorizationRequestsContract,
  browserContract,
} from "@okouai/api-contracts/contracts/browser";
import { browserUserActionsContract } from "@okouai/api-contracts/contracts/browser-user-actions";
import {
  chatThreadComputerUseHostContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { HttpResponse, http } from "msw";
import { aroundEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { browserUseCdpHandler } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { deleteChatThreadRootFixture } from "../../../test-fixtures/chat-thread-deletion";
import {
  stageBrowserUserActionClosureFixture,
  stageBrowserUserActionCompletedAtFixture,
  stageRetiredDirectBrowserUserActionFixture,
  stageStuckBrowserUserActionFixture,
} from "../../../test-fixtures/browser-user-action";
import { deleteAgentRunRootFixture } from "../../../test-fixtures/run-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { setBrowserTabSnapshotAsPreviousApi } from "./helpers/runtime-state";
import { createRouteMocks } from "./helpers/route-test";
import { testBrowserReconcileRoutes } from "../test-browser-reconcile";
import { browserRoutes } from "../browser";
import { browserAuthorizationRoutes } from "../browser-authorization";
import { browserUserActionRoutes } from "../browser-user-actions";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadComputerUseHostRoutes } from "../chat-threads-computer-use-host";

const TEST_APP_ROUTES = Object.freeze([
  ...browserAuthorizationRoutes,
  ...browserRoutes,
  ...chatThreadRoutes,
]);

const context = testContext();
const computerUse = createComputerUseBddApi(context);
const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v3";
const STARTED_AT_MS = Date.parse("2026-07-24T10:00:00.000Z");
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command !== "object" ||
    command === null ||
    !("input" in command) ||
    typeof command.input !== "object" ||
    command.input === null
  ) {
    return {};
  }
  return command.input as Record<string, unknown>;
}

function browserInputWrites() {
  return context.mocks.browserUseCdp.command.mock.calls.filter(([command]) => {
    return (
      command.method === "Runtime.callFunctionOn" &&
      typeof command.params.functionDeclaration === "string" &&
      command.params.functionDeclaration.includes("setter.call")
    );
  });
}

function browserControlInspections() {
  return context.mocks.browserUseCdp.command.mock.calls.filter(([command]) => {
    return (
      command.method === "Runtime.callFunctionOn" &&
      typeof command.params.functionDeclaration === "string" &&
      command.params.functionDeclaration.includes("supportedInputTypes") &&
      command.params.functionDeclaration.includes("controls.map")
    );
  });
}

function browserInputVerifications() {
  return context.mocks.browserUseCdp.command.mock.calls.filter(([command]) => {
    return (
      command.method === "Runtime.callFunctionOn" &&
      typeof command.params.functionDeclaration === "string" &&
      command.params.functionDeclaration.includes("expectedValues") &&
      command.params.functionDeclaration.includes("controls.every")
    );
  });
}

function browserUserActionObjectId(backendNodeId: unknown): string {
  if (backendNodeId === 43) {
    return "native-username-object";
  }
  return backendNodeId === 44 ? "native-code-object" : "native-password-object";
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
          declaration.includes("expected") ||
          declaration.includes("nextValue")
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

interface NativeNumberConstraints {
  readonly min: string;
  readonly max: string;
  readonly step: string;
}

function validNumberValue(
  value: unknown,
  { min, max, step }: NativeNumberConstraints,
): boolean {
  if (value === null || value === "") {
    return true;
  }
  if (typeof value !== "string") {
    return false;
  }
  const numeric = Number(value);
  return (
    Number.isFinite(numeric) &&
    numeric >= Number(min) &&
    numeric <= Number(max) &&
    (step === "any" || Number.isInteger((numeric - Number(min)) / Number(step)))
  );
}

function mockNativeNumberTarget(args: {
  readonly constraints: () => NativeNumberConstraints;
  readonly verificationMatches: () => boolean;
}): void {
  context.mocks.browserUseCdp.command.mockImplementation((command) => {
    switch (command.method) {
      case "Target.getTargets": {
        return {
          targetInfos: [
            {
              targetId: "native-input-target",
              type: "page",
              url: "https://example.com/order",
            },
          ],
        };
      }
      case "Target.attachToTarget": {
        return { sessionId: "native-number-session" };
      }
      case "Browser.getWindowForTarget": {
        return { windowId: 7 };
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "native-number-loader",
              url: "https://example.com/order",
            },
          },
        };
      }
      case "DOM.resolveNode": {
        return { object: { objectId: "native-number-object" } };
      }
      case "Page.getLayoutMetrics": {
        return {
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: 1440,
            clientHeight: 900,
          },
        };
      }
      case "Page.captureScreenshot": {
        return { data: Buffer.from("screenshot").toString("base64") };
      }
      case "Runtime.callFunctionOn": {
        const declaration = String(command.params.functionDeclaration);
        if (declaration.includes("expectedValues")) {
          return { result: { value: args.verificationMatches() } };
        }
        if (declaration.includes("cloneNode")) {
          const first = Array.isArray(command.params.arguments)
            ? command.params.arguments[0]
            : undefined;
          const value =
            typeof first === "object" && first !== null && "value" in first
              ? first.value
              : undefined;
          return {
            result: { value: validNumberValue(value, args.constraints()) },
          };
        }
        if (declaration.includes("nextValue")) {
          return { result: { value: true } };
        }
        return {
          result: {
            value: [
              {
                tagName: "INPUT",
                inputType: "number",
                connected: true,
                mainDocument: true,
                writable: true,
                siteRequired: false,
                multiple: false,
                ...args.constraints(),
              },
            ],
          },
        };
      }
      default: {
        return {};
      }
    }
  });
}

function browserUserActionTokenHash(requestToken: string): string {
  return createHash("sha256").update(requestToken).digest("hex");
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

describe("Browser user-action route", () => {
  it("supports live number constraints, optional clear, and exact readback", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Enter a quantity in the current browser",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let min = "10";
    let max = "20";
    let step = "0.5";
    let verificationMatches = true;
    mockNativeNumberTarget({
      constraints: () => {
        return { min, max, step };
      },
      verificationMatches: () => {
        return verificationMatches;
      },
    });
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
    );
    await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const createNumber = async (required = false) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after quantity entry",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "quantity",
                label: "Quantity",
                fieldKind: "number",
                required,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const created = await createNumber();
    expect(created.body.action.fields[0]).toMatchObject({
      fieldKind: "number",
      control: { tagName: "INPUT", inputType: "number" },
    });
    const token = created.body.action.requestToken;
    const preflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: {},
      }),
      [200],
    );
    expect(preflight.body.fields[0]?.control).toMatchObject({
      inputType: "number",
      min: "10",
      max: "20",
      step: "0.5",
    });
    expect(JSON.stringify(preflight.body)).not.toContain("backendNodeId");

    for (const value of ["not-a-number", "12.3"]) {
      const invalidNumber = await userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [{ key: "quantity", value }] },
      });
      expect(invalidNumber).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
      });
    }
    expect(browserInputWrites()).toHaveLength(0);

    min = "15";
    const invalid = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: token },
      body: { values: [{ key: "quantity", value: "12.5" }] },
    });
    expect(invalid).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    expect(browserInputWrites()).toHaveLength(0);
    min = "10";
    const applied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [{ key: "quantity", value: "12.5" }] },
      }),
      [200],
    );
    expect(applied.body.state).toBe("succeeded");
    expect(browserInputWrites().at(-1)?.[0].params.arguments).toStrictEqual([
      { value: "12.5" },
    ]);

    const untouched = await createNumber();
    const writesBeforeUntouched = browserInputWrites().length;
    const untouchedResult = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: untouched.body.action.requestToken },
        body: { values: [] },
      }),
      [200],
    );
    expect(untouchedResult.body.state).toBe("succeeded");
    expect(browserInputWrites()).toHaveLength(writesBeforeUntouched);

    const clear = await createNumber();
    const cleared = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: clear.body.action.requestToken },
        body: { values: [{ key: "quantity", value: "" }] },
      }),
      [200],
    );
    expect(cleared.body.state).toBe("succeeded");
    expect(browserInputWrites().at(-1)?.[0].params.arguments).toStrictEqual([
      { value: "" },
    ]);

    const required = await createNumber(true);
    const requiredEmpty = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: required.body.action.requestToken },
      body: { values: [{ key: "quantity", value: "" }] },
    });
    expect(requiredEmpty).toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" } },
    });

    min = "0";
    max = "1e30";
    step = "any";
    const precise = await createNumber();
    const preciseValue = "9007199254740993";
    const preciseResult = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: precise.body.action.requestToken },
        body: { values: [{ key: "quantity", value: preciseValue }] },
      }),
      [200],
    );
    expect(preciseResult.body.state).toBe("succeeded");
    expect(browserInputWrites().at(-1)?.[0].params.arguments).toStrictEqual([
      { value: preciseValue },
    ]);

    const mismatch = await createNumber();
    verificationMatches = false;
    const uncertain = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: mismatch.body.action.requestToken },
        body: { values: [{ key: "quantity", value: "12.5" }] },
      }),
      [200],
    );
    expect(uncertain.body.state).toBe("uncertain");
  });

  it("validates and applies CLI-resolved Browser input without exposing target or value data", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Ask for credentials on the current Browser page",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });

    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let currentLoaderId = "native-input-loader";
    let controlWritable = true;
    let controlConnected = true;
    let controlTagName = "INPUT";
    let controlSiteRequired = false;
    const controlMinLength = 3;
    let disconnectAfterNextWrite = false;
    let resolveNodeAvailable = true;
    let malformedNodeResponse = false;
    let verificationMatches = true;
    let failNextProviderRead = false;
    let providerStopped = false;
    let providerReadCount = 0;
    let providerReadBarrier:
      | {
          readonly entered: ReturnType<typeof createDeferredPromise<void>>;
          readonly release: ReturnType<typeof createDeferredPromise<void>>;
        }
      | undefined;
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
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
      if (command.method === "Browser.getWindowForTarget") {
        return { windowId: 7 };
      }
      if (command.method === "Target.attachToTarget") {
        return { sessionId: "native-input-session" };
      }
      if (command.method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: currentLoaderId,
              url: "https://example.com/login",
            },
          },
        };
      }
      if (command.method === "DOM.resolveNode") {
        if (malformedNodeResponse) {
          return {};
        }
        return resolveNodeAvailable
          ? {
              object: {
                objectId: browserUserActionObjectId(
                  command.params.backendNodeId,
                ),
              },
            }
          : new Error("No node with given id found");
      }
      if (command.method === "Runtime.callFunctionOn") {
        const declaration =
          typeof command.params.functionDeclaration === "string"
            ? command.params.functionDeclaration
            : "";
        if (declaration.includes("expected")) {
          return {
            result: { value: verificationMatches && controlConnected },
          };
        }
        if (declaration.includes("cloneNode")) {
          const values = Array.isArray(command.params.arguments)
            ? command.params.arguments.flatMap((argument) => {
                return typeof argument === "object" &&
                  argument !== null &&
                  "value" in argument &&
                  typeof argument.value === "string"
                  ? [argument.value]
                  : [];
              })
            : [];
          return {
            result: {
              value: values.every((value) => {
                return value.length >= (controlMinLength ?? 0);
              }),
            },
          };
        }
        if (declaration.includes("nextValue")) {
          if (disconnectAfterNextWrite) {
            disconnectAfterNextWrite = false;
            controlConnected = false;
          }
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
            value: objectIds.map((objectId) => {
              return {
                tagName: controlTagName,
                inputType:
                  controlTagName === "TEXTAREA"
                    ? "textarea"
                    : objectId === "native-username-object"
                      ? "email"
                      : objectId === "native-code-object"
                        ? "tel"
                        : "password",
                connected: controlConnected,
                mainDocument: true,
                writable: controlWritable,
                siteRequired: controlSiteRequired,
                multiple:
                  controlTagName === "INPUT" &&
                  objectId === "native-username-object",
                ...(controlMinLength === undefined
                  ? {}
                  : { minLength: controlMinLength }),
              };
            }),
          },
        };
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
        return { data: Buffer.from("screenshot").toString("base64") };
      }
      return {};
    });
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, async ({ params }) => {
        providerReadCount += 1;
        if (failNextProviderRead) {
          failNextProviderRead = false;
          return HttpResponse.json(
            { detail: "temporary provider failure" },
            { status: 503 },
          );
        }
        const barrier = providerReadBarrier;
        if (barrier) {
          providerReadBarrier = undefined;
          barrier.entered.resolve(undefined);
          await barrier.release.promise;
        }
        return HttpResponse.json(
          providerBrowser(String(params.id), {
            status: providerStopped ? "stopped" : "active",
          }),
        );
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    controlWritable = false;
    const unsupported = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after unsupported input",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "password",
            label: "Password",
            fieldKind: "password",
            required: true,
            backendNodeId: 42,
          },
        ],
      },
    });
    expect(unsupported).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL" } },
    });
    controlWritable = true;
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    providerReadCount = 0;

    const mismatchedKind = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after mismatched input",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "password",
            label: "Password",
            fieldKind: "password",
            required: true,
            backendNodeId: 43,
          },
        ],
      },
    });
    expect(mismatchedKind).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL" } },
    });
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    providerReadCount = 0;

    resolveNodeAvailable = false;
    const missingBackendNode = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after validated input",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "password",
            label: "Password",
            fieldKind: "password",
            required: true,
            backendNodeId: 42,
          },
        ],
      },
    });
    expect(missingBackendNode).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_BACKEND_NODE_NOT_FOUND" } },
    });
    resolveNodeAvailable = true;
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    providerReadCount = 0;

    const created = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after password entry",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "username",
              label: "Username",
              fieldKind: "username",
              required: true,
              backendNodeId: 43,
            },
            {
              key: "password",
              label: "Password",
              fieldKind: "password",
              required: true,
              backendNodeId: 42,
            },
          ],
        },
      }),
      [201],
    );
    expect(created.body.actionUrl).toContain("/browser/actions/");
    expect(created.body.action).toMatchObject({
      kind: "input",
      state: "pending",
      siteOrigin: "https://example.com",
      fields: [
        { key: "username", fieldKind: "username", required: true },
        { key: "password", fieldKind: "password", required: true },
      ],
    });
    expect(created.body.action).not.toHaveProperty("selector");
    expect(created.body.action).not.toHaveProperty("pageTargetId");
    expect(created.body.action).not.toHaveProperty("expiresAt");
    expect(JSON.stringify(created.body.action)).not.toContain("backendNodeId");
    expect(providerReadCount).toBe(1);
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledTimes(1);
    expect(browserControlInspections()).toHaveLength(1);
    expect(browserControlInspections()[0]?.[0].params.arguments).toStrictEqual([
      { objectId: "native-password-object" },
    ]);
    expect(
      context.mocks.browserUseCdp.command.mock.calls.some(([command]) => {
        return [
          "DOM.getDocument",
          "DOM.querySelectorAll",
          "DOM.describeNode",
        ].includes(command.method);
      }),
    ).toBeFalsy();

    const otherUser = createBddApi(context).user({ orgId: actor.orgId });
    routeMocks.clerk.session(
      otherUser.userId,
      otherUser.orgId,
      otherUser.orgRole,
    );
    const featureDisabled = await userActionClient().get({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
    });
    expect(featureDisabled).toMatchObject({
      status: 403,
      body: { error: { code: "FORBIDDEN" } },
    });
    const disabledPreflight = await userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
      body: {},
    });
    expect(disabledPreflight.status).toBe(403);
    if (!otherUser.orgId) {
      throw new Error("Expected the second user to share the organization");
    }
    await updateFeatureSwitchesForUser(
      context,
      { ...otherUser, orgId: otherUser.orgId },
      { [FeatureSwitchKey.BrowserNativeInput]: true },
    );
    const foreignOwner = await userActionClient().get({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
    });
    expect(foreignOwner).toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
    const foreignPreflight = await userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
      body: {},
    });
    expect(foreignPreflight.status).toBe(404);
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    controlSiteRequired = true;
    const preflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: created.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(preflight.body.state).toBe("pending");
    expect(preflight.body).toMatchObject({
      kind: "input",
      fields: [
        {
          control: {
            tagName: "INPUT",
            inputType: "email",
            siteRequired: true,
            multiple: true,
            minLength: 3,
          },
        },
        {
          control: {
            tagName: "INPUT",
            inputType: "password",
            siteRequired: true,
            minLength: 3,
          },
        },
      ],
    });
    expect(preflight.body).not.toHaveProperty("pageTargetId");
    expect(JSON.stringify(preflight.body)).not.toContain("backendNodeId");
    expect(browserInputWrites()).toHaveLength(0);
    expect(browserInputVerifications()).toHaveLength(0);

    const emptyRequired = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
      body: {
        values: [
          { key: "username", value: "user@example.com" },
          { key: "password", value: "" },
        ],
      },
    });
    expect(emptyRequired).toMatchObject({
      status: 400,
      body: {
        error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" },
      },
    });
    expect(
      context.mocks.browserUseCdp.command.mock.calls.some(([command]) => {
        return (
          command.method === "Runtime.callFunctionOn" &&
          typeof command.params.functionDeclaration === "string" &&
          command.params.functionDeclaration.includes("setter.call")
        );
      }),
    ).toBeFalsy();

    const invalidSiteValue = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
      body: {
        values: [
          { key: "username", value: "user@example.com" },
          { key: "password", value: "xy" },
        ],
      },
    });
    expect(invalidSiteValue).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    expect(browserInputWrites()).toHaveLength(0);

    const applied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: created.body.action.requestToken },
        body: {
          values: [
            { key: "username", value: "user@example.com" },
            { key: "password", value: "request-memory-only" },
          ],
        },
      }),
      [200],
    );
    expect(applied.body.state).toBe("succeeded");
    expect(providerReadCount).toBe(4);
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledTimes(4);
    expect(browserControlInspections()).toHaveLength(4);
    expect(browserInputWrites()).toHaveLength(1);
    expect(browserInputWrites()[0]?.[0].params.arguments).toStrictEqual([
      { value: "user@example.com" },
      { objectId: "native-password-object" },
      { value: "request-memory-only" },
    ]);
    expect(browserInputWrites()[0]?.[0].params.functionDeclaration).toContain(
      'new Event("input"',
    );
    expect(browserInputWrites()[0]?.[0].params.functionDeclaration).toContain(
      'new Event("change"',
    );
    expect(
      browserInputWrites()[0]?.[0].params.functionDeclaration,
    ).not.toContain("submit");
    expect(browserInputVerifications()).toHaveLength(1);

    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    providerReadCount = 0;

    const readBack = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: created.body.action.requestToken },
      }),
      [200],
    );
    expect(readBack.body.callbackDelivered).toBeFalsy();
    const serializedReadBack = JSON.stringify(readBack.body);
    expect(serializedReadBack).not.toContain("#password");
    expect(serializedReadBack).not.toContain("#username");
    expect(serializedReadBack).not.toContain("user@example.com");
    expect(serializedReadBack).not.toContain("request-memory-only");
    expect(providerReadCount).toBe(0);
    expect(context.mocks.browserUseCdp.connect).not.toHaveBeenCalled();
    expect(context.mocks.browserUseCdp.command).not.toHaveBeenCalled();

    await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: current.threadId,
        prompt: "Another message with a different event ID",
        clientEventId: randomUUID(),
      },
      [201],
    );
    const beforeCallback = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: created.body.action.requestToken },
      }),
      [200],
    );
    expect(beforeCallback.body.callbackDelivered).toBeFalsy();

    await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: current.threadId,
        prompt: "Continue after password entry",
        clientEventId: created.body.action.callbackIds.success.clientEventId,
        chatThreadSortEventId:
          created.body.action.callbackIds.success.chatThreadSortEventId,
      },
      [201],
    );
    const afterCallback = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: created.body.action.requestToken },
      }),
      [200],
    );
    expect(afterCallback.body.callbackDelivered).toBeTruthy();
    expect(JSON.stringify(afterCallback.body)).not.toContain(
      "request-memory-only",
    );

    const duplicateApply = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
      body: {
        values: [
          { key: "username", value: "must-not-be-written" },
          { key: "password", value: "must-not-be-written" },
        ],
      },
    });
    expect(duplicateApply).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_CONFLICT" } },
    });

    const optionalBlankCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue without changing the optional username",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "username",
              label: "Username",
              fieldKind: "username",
              required: false,
              backendNodeId: 43,
            },
            {
              key: "password",
              label: "Password",
              fieldKind: "password",
              required: true,
              backendNodeId: 42,
            },
          ],
        },
      }),
      [201],
    );
    const optionalBlankApplied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: {
          requestToken: optionalBlankCandidate.body.action.requestToken,
        },
        body: {
          values: [
            { key: "username", value: "" },
            { key: "password", value: "required-only" },
          ],
        },
      }),
      [200],
    );
    expect(optionalBlankApplied.body.state).toBe("succeeded");
    const optionalBlankWrite = browserInputWrites().at(-1);
    expect(optionalBlankWrite?.[0].params.objectId).toBe(
      "native-password-object",
    );
    expect(optionalBlankWrite?.[0].params.arguments).toStrictEqual([
      { value: "required-only" },
    ]);

    controlTagName = "TEXTAREA";
    controlSiteRequired = false;
    const multiline = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after multiline input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "note",
              label: "Note",
              fieldKind: "text",
              required: true,
              backendNodeId: 43,
            },
          ],
        },
      }),
      [201],
    );
    const multilinePreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: multiline.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(multilinePreflight.body).toMatchObject({
      kind: "input",
      fields: [{ control: { tagName: "TEXTAREA", inputType: "textarea" } }],
    });
    const multilineApplied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: multiline.body.action.requestToken },
        body: { values: [{ key: "note", value: "first line\nsecond line" }] },
      }),
      [200],
    );
    expect(multilineApplied.body.state).toBe("succeeded");
    expect(browserInputWrites().at(-1)?.[0].params.arguments).toStrictEqual([
      { value: "first line\nsecond line" },
    ]);
    controlTagName = "INPUT";

    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    providerReadCount = 0;
    const providerRetryCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after provider recovery",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "password",
              label: "Password",
              fieldKind: "password",
              required: true,
              backendNodeId: 42,
            },
          ],
        },
      }),
      [201],
    );
    failNextProviderRead = true;
    const failedPreflight = await userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: {
        requestToken: providerRetryCandidate.body.action.requestToken,
      },
      body: {},
    });
    expect([502, 503]).toContain(failedPreflight.status);
    const retriedPreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: {
          requestToken: providerRetryCandidate.body.action.requestToken,
        },
        body: {},
      }),
      [200],
    );
    expect(retriedPreflight.body.state).toBe("pending");
    malformedNodeResponse = true;
    const malformedPreflight = await userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: {
        requestToken: providerRetryCandidate.body.action.requestToken,
      },
      body: {},
    });
    malformedNodeResponse = false;
    expect(malformedPreflight.status).toBe(502);
    expect(
      (
        await accept(
          userActionClient().get({
            headers: { authorization: "Bearer clerk-session" },
            params: {
              requestToken: providerRetryCandidate.body.action.requestToken,
            },
          }),
          [200],
        )
      ).body.state,
    ).toBe("pending");
    failNextProviderRead = true;
    const providerFailure = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: {
        requestToken: providerRetryCandidate.body.action.requestToken,
      },
      body: { values: [{ key: "password", value: "retry-once" }] },
    });
    expect([502, 503]).toContain(providerFailure.status);
    expect(
      (
        await accept(
          userActionClient().get({
            headers: { authorization: "Bearer clerk-session" },
            params: {
              requestToken: providerRetryCandidate.body.action.requestToken,
            },
          }),
          [200],
        )
      ).body.state,
    ).toBe("pending");
    const writesBeforeProviderRetry = browserInputWrites().length;
    await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: {
          requestToken: providerRetryCandidate.body.action.requestToken,
        },
        body: { values: [{ key: "password", value: "retry-once" }] },
      }),
      [200],
    );
    expect(browserInputWrites()).toHaveLength(writesBeforeProviderRetry + 1);

    const staleCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after stale input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    const writesBeforeStale = browserInputWrites().length;
    const validBeforeNavigation = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: staleCandidate.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(validBeforeNavigation.body.state).toBe("pending");
    currentLoaderId = "navigated-loader";
    const stale = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: staleCandidate.body.action.requestToken },
        body: { values: [{ key: "code", value: "001234" }] },
      }),
      [200],
    );
    expect(stale.body.state).toBe("stale");
    currentLoaderId = "native-input-loader";
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);

    const navigatedCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after preflight navigation",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    currentLoaderId = "new-document-loader";
    const navigatedPreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: navigatedCandidate.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    currentLoaderId = "native-input-loader";
    expect(navigatedPreflight.body.state).toBe("stale");
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);

    const detachedCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after detached input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    resolveNodeAvailable = false;
    const detached = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: detachedCandidate.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    resolveNodeAvailable = true;
    expect(detached.body.state).toBe("stale");
    const detachedReadback = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: detachedCandidate.body.action.requestToken },
      }),
      [200],
    );
    expect(detachedReadback.body.state).toBe("stale");
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);

    const unwritableCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after control replacement",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    controlWritable = false;
    const unwritablePreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: unwritableCandidate.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    controlWritable = true;
    expect(unwritablePreflight.body.state).toBe("stale");
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);

    const replacedControlCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after control type change",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    controlTagName = "DIV";
    const incompatiblePreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: {
          requestToken: replacedControlCandidate.body.action.requestToken,
        },
        body: {},
      }),
      [200],
    );
    controlTagName = "INPUT";
    expect(incompatiblePreflight.body.state).toBe("stale");
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);

    const stoppedProviderCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after Browser closure",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    providerStopped = true;
    const stoppedPreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: {
          requestToken: stoppedProviderCandidate.body.action.requestToken,
        },
        body: {},
      }),
      [200],
    );
    providerStopped = false;
    expect(stoppedPreflight.body.state).toBe("stale");
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);

    const uncertainCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after uncertain input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    const writesBeforeUncertain = browserInputWrites().length;
    verificationMatches = false;
    const uncertain = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: uncertainCandidate.body.action.requestToken },
        body: { values: [{ key: "code", value: "009876" }] },
      }),
      [200],
    );
    verificationMatches = true;
    expect(uncertain.body.state).toBe("uncertain");
    const uncertainRetry = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: uncertainCandidate.body.action.requestToken },
      body: { values: [{ key: "code", value: "must-not-replay" }] },
    });
    expect(uncertainRetry).toMatchObject({ status: 409 });
    expect(browserInputWrites()).toHaveLength(writesBeforeUncertain + 1);

    const rerenderedCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after rerendered input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    const writesBeforeRerender = browserInputWrites().length;
    disconnectAfterNextWrite = true;
    const rerendered = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: rerenderedCandidate.body.action.requestToken },
        body: { values: [{ key: "code", value: "001234" }] },
      }),
      [200],
    );
    controlConnected = true;
    expect(rerendered.body.state).toBe("uncertain");
    expect(browserInputWrites()).toHaveLength(writesBeforeRerender + 1);
    const verification = context.mocks.browserUseCdp.command.mock.calls.find(
      ([command]) => {
        return (
          command.method === "Runtime.callFunctionOn" &&
          typeof command.params.functionDeclaration === "string" &&
          command.params.functionDeclaration.includes("expectedValues") &&
          command.params.functionDeclaration.includes("control.isConnected")
        );
      },
    );
    expect(verification?.[0].params.functionDeclaration).toContain(
      "control.ownerDocument === document",
    );

    const stuckCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after stuck input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    const writesBeforeStuckRecovery = browserInputWrites().length;
    await stageStuckBrowserUserActionFixture({
      requestToken: stuckCandidate.body.action.requestToken,
      applyStartedAt: new Date(STARTED_AT_MS - MINUTE_MS - 1),
    });
    const recovered = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: stuckCandidate.body.action.requestToken },
      }),
      [200],
    );
    expect(recovered.body.state).toBe("uncertain");
    const stuckRetry = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: stuckCandidate.body.action.requestToken },
      body: { values: [{ key: "code", value: "must-not-replay" }] },
    });
    expect(stuckRetry.status).toBe(409);
    expect(browserInputWrites()).toHaveLength(writesBeforeStuckRecovery);

    const concurrentCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after concurrent input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    const writesBeforeConcurrent = browserInputWrites().length;
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    providerReadBarrier = { entered, release };
    const firstConcurrentApply = userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: concurrentCandidate.body.action.requestToken },
      body: { values: [{ key: "code", value: "001234" }] },
    });
    await entered.promise;
    const secondConcurrentApply = userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: concurrentCandidate.body.action.requestToken },
      body: { values: [{ key: "code", value: "009876" }] },
    });
    release.resolve(undefined);
    const concurrent = await Promise.all([
      firstConcurrentApply,
      secondConcurrentApply,
    ]);
    expect(
      concurrent
        .map((response) => {
          return response.status;
        })
        .sort((left, right) => {
          return left - right;
        }),
    ).toStrictEqual([200, 409]);
    expect(browserInputWrites()).toHaveLength(writesBeforeConcurrent + 1);

    const expiringCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after expiring input",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );

    // User-action usability follows the Browser's renewable lease instead of
    // a fixed expiry copied onto the request row.
    mockNow(STARTED_AT_MS + 9 * MINUTE_MS);
    await accept(
      client().lease({
        headers: current.claim.browserHeaders,
        body: {},
      }),
      [200],
    );
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const renewed = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: expiringCandidate.body.action.requestToken },
        body: { values: [{ key: "code", value: "001234" }] },
      }),
      [200],
    );
    expect(renewed.body.state).toBe("succeeded");

    const expiredCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after Browser expiry",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "code",
              label: "Code",
              fieldKind: "one_time_code",
              required: true,
              backendNodeId: 44,
            },
          ],
        },
      }),
      [201],
    );
    const writesBeforeExpiry = browserInputWrites().length;
    mockNow(STARTED_AT_MS + 22 * MINUTE_MS);
    const expired = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: expiredCandidate.body.action.requestToken },
      body: { values: [{ key: "code", value: "001234" }] },
    });
    expect(expired).toMatchObject({
      status: 410,
      body: { error: { code: "BROWSER_USER_ACTION_EXPIRED" } },
    });
    expect(browserInputWrites()).toHaveLength(writesBeforeExpiry);
    const cannotReviveExpiredBrowser = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: nativePasswordRequest("Continue after Browser expiry"),
    });
    expect(cannotReviveExpiredBrowser).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_BROWSER_NOT_LIVE" } },
    });
    await reconcileBrowsers(current.threadId);
    const preservedStale = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: staleCandidate.body.action.requestToken },
      }),
      [200],
    );
    expect(preservedStale.body.state).toBe("stale");
    const preservedUncertain = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: uncertainCandidate.body.action.requestToken },
      }),
      [200],
    );
    expect(preservedUncertain.body.state).toBe("uncertain");
    await chat.deleteThread(actor, current.threadId);
    const erased = await userActionClient().get({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: created.body.action.requestToken },
    });
    expect(erased).toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
  }, 120_000);

  it("retires legacy direct actions while preserving live Browser input requests", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a Browser for legacy action retirement",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });

    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    mockNativeInputTarget();
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, () => {
        return HttpResponse.json(providerBrowser(providerId));
      }),
    );
    await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const createAction = async (prompt: string) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: nativePasswordRequest(prompt),
        }),
        [201],
      );
    };
    const legacy = await createAction("Legacy direct handoff");
    const input = await createAction("Continue after native input");
    await stageRetiredDirectBrowserUserActionFixture(
      legacy.body.action.requestToken,
    );

    const reconciled = await reconcileBrowsers(current.threadId);
    expect(reconciled.body).toMatchObject({ errors: 0 });
    await expect(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: legacy.body.action.requestToken },
      }),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
    await expect(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: input.body.action.requestToken },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { kind: "input", state: "pending" },
    });
    await expect(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { browser: { status: "active" } },
    });
  }, 120_000);

  it("converts closed actions from Browser finishedAt without rewriting terminal outcomes", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a Browser for user-action lifecycle conversion",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });

    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    mockNativeInputTarget();
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, () => {
        return HttpResponse.json(providerBrowser(providerId));
      }),
    );
    await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const createInputAction = async (reason: string) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: nativePasswordRequest(`Continue after ${reason}`),
        }),
        [201],
      );
    };
    const pending = await createInputAction("pending conversion");
    const applying = await createInputAction("applying conversion");
    const succeeded = await createInputAction("successful completion");
    const cancelled = await createInputAction("cancelled completion");
    const raced = await createInputAction("concurrent completion or closure");

    await stageStuckBrowserUserActionFixture({
      requestToken: applying.body.action.requestToken,
      applyStartedAt: new Date(STARTED_AT_MS),
    });
    await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: succeeded.body.action.requestToken },
        body: { values: [{ key: "password", value: "secret" }] },
      }),
      [200],
    );
    await accept(
      userActionClient().cancel({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: cancelled.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    const finishedAt = new Date(STARTED_AT_MS + MINUTE_MS);
    mockNow(finishedAt.getTime());
    const [capturedProviderId, applyRace, cancelRace] = await Promise.all([
      stageBrowserUserActionClosureFixture({
        requestToken: raced.body.action.requestToken,
        finishedAt,
      }),
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: raced.body.action.requestToken },
        body: { values: [{ key: "password", value: "secret" }] },
      }),
      userActionClient().cancel({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: raced.body.action.requestToken },
        body: {},
      }),
    ]);
    expect(capturedProviderId).toBe(providerId);
    expect([200, 409, 410]).toContain(applyRace.status);
    expect([200, 409, 410]).toContain(cancelRace.status);
    expect(
      [applyRace, cancelRace].filter((response) => {
        return response.status === 200;
      }),
    ).toHaveLength(
      applyRace.status === 200 || cancelRace.status === 200 ? 1 : 0,
    );

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: false,
    });
    let providerCallsAfterClosure = 0;
    server.use(
      http.all(`${BROWSER_USE_API_URL}/*`, () => {
        providerCallsAfterClosure += 1;
        return HttpResponse.json(
          { detail: "unexpected provider call" },
          {
            status: 500,
          },
        );
      }),
    );
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    const converted = await reconcileBrowsers(current.threadId);
    expect(converted.body).toMatchObject({ errors: 0 });
    expect(providerCallsAfterClosure).toBe(0);
    expect(context.mocks.browserUseCdp.connect).not.toHaveBeenCalled();
    expect(context.mocks.browserUseCdp.command).not.toHaveBeenCalled();

    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const tokens = [
      pending.body.action.requestToken,
      applying.body.action.requestToken,
      succeeded.body.action.requestToken,
      cancelled.body.action.requestToken,
      raced.body.action.requestToken,
    ];
    const readAction = async (requestToken: string) => {
      return await accept(
        userActionClient().get({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken },
        }),
        [200],
      );
    };
    const convertedActions = await Promise.all(tokens.map(readAction));
    expect(convertedActions[0]?.body).toMatchObject({
      state: "stale",
      completedAt: finishedAt.toISOString(),
    });
    expect(convertedActions[1]?.body).toMatchObject({
      state: "uncertain",
      completedAt: finishedAt.toISOString(),
    });
    expect(convertedActions[2]?.body.state).toBe("succeeded");
    expect(convertedActions[3]?.body.state).toBe("cancelled");
    expect(convertedActions[4]?.body.state).toMatch(
      /^(succeeded|cancelled|stale|uncertain)$/u,
    );

    const repeated = await reconcileBrowsers(current.threadId);
    expect(repeated.body).toMatchObject({ errors: 0 });
    const repeatedActions = await Promise.all(tokens.map(readAction));
    expect(
      repeatedActions.map((response) => {
        return response.body;
      }),
    ).toStrictEqual(
      convertedActions.map((response) => {
        return response.body;
      }),
    );

    await Promise.all([
      chat.deleteThread(actor, current.threadId),
      reconcileBrowsers(current.threadId),
    ]);
    await flushWaitUntilForTest();
    const erased = await userActionClient().get({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: pending.body.action.requestToken },
    });
    expect(erased).toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
  }, 120_000);

  it("retains the Browser finish source through deterministic callback-recovery batches", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a Browser for user-action retention",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });

    const providerId = randomUUID();
    const providerProfileId = randomUUID();
    const deletedProfiles: string[] = [];
    acceptBrowserUseCdpSessions([providerId]);
    mockNativeInputTarget();
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(
          providerProfile(providerProfileId, body.name),
          {
            status: 201,
          },
        );
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, ({ params }) => {
        deletedProfiles.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, () => {
        return HttpResponse.json(providerBrowser(providerId));
      }),
    );
    await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

    const tokens: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const created = await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: nativePasswordRequest(
            `Continue after retained action ${index.toString()}`,
          ),
        }),
        [201],
      );
      tokens.push(created.body.action.requestToken);
    }
    const laterTerminal = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: nativePasswordRequest("Continue after the later terminal action"),
      }),
      [201],
    );
    await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: laterTerminal.body.action.requestToken },
        body: { values: [{ key: "password", value: "secret" }] },
      }),
      [200],
    );

    const finishedAt = new Date(STARTED_AT_MS + MINUTE_MS);
    const laterCompletedAt = new Date(finishedAt.getTime() + MINUTE_MS);
    const capturedProviderId = await stageBrowserUserActionClosureFixture({
      requestToken: tokens[0] ?? "",
      finishedAt,
    });
    expect(capturedProviderId).toBe(providerId);
    await stageBrowserUserActionCompletedAtFixture({
      requestToken: laterTerminal.body.action.requestToken,
      completedAt: laterCompletedAt,
    });

    const sortedTokens = [...tokens].sort((left, right) => {
      return browserUserActionTokenHash(left).localeCompare(
        browserUserActionTokenHash(right),
      );
    });
    const getAction = async (requestToken: string) => {
      return await userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
      });
    };
    mockNow(finishedAt.getTime());
    await reconcileBrowsers(current.threadId);
    const firstConversion = await Promise.all(sortedTokens.map(getAction));
    for (const response of firstConversion.slice(0, 20)) {
      expect(response).toMatchObject({
        status: 200,
        body: {
          state: "stale",
          completedAt: finishedAt.toISOString(),
        },
      });
    }
    expect(firstConversion[20]).toMatchObject({
      status: 410,
      body: { error: { code: "BROWSER_USER_ACTION_EXPIRED" } },
    });

    await reconcileBrowsers(current.threadId);
    await expect(getAction(sortedTokens[20] ?? "")).resolves.toMatchObject({
      status: 200,
      body: { state: "stale", completedAt: finishedAt.toISOString() },
    });

    mockNow(finishedAt.getTime() + 7 * DAY_MS - 1);
    await reconcileBrowsers(current.threadId);
    await expect(getAction(sortedTokens[0] ?? "")).resolves.toMatchObject({
      status: 200,
      body: { state: "stale" },
    });
    expect(deletedProfiles).toStrictEqual([]);

    mockNow(finishedAt.getTime() + 7 * DAY_MS);
    await reconcileBrowsers(current.threadId);
    const afterFirstDeletion = await Promise.all(sortedTokens.map(getAction));
    for (const response of afterFirstDeletion.slice(0, 20)) {
      expect(response).toMatchObject({
        status: 404,
        body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
      });
    }
    expect(afterFirstDeletion[20]).toMatchObject({
      status: 200,
      body: { state: "stale" },
    });
    expect(deletedProfiles).toStrictEqual([]);

    await reconcileBrowsers(current.threadId);
    await expect(getAction(sortedTokens[20] ?? "")).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
    await expect(
      getAction(laterTerminal.body.action.requestToken),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        state: "succeeded",
        completedAt: laterCompletedAt.toISOString(),
      },
    });
    expect(deletedProfiles).toStrictEqual([]);

    mockNow(laterCompletedAt.getTime() + 7 * DAY_MS - 1);
    await reconcileBrowsers(current.threadId);
    await expect(
      getAction(laterTerminal.body.action.requestToken),
    ).resolves.toMatchObject({ status: 200, body: { state: "succeeded" } });
    expect(deletedProfiles).toStrictEqual([]);

    mockNow(laterCompletedAt.getTime() + 7 * DAY_MS);
    await reconcileBrowsers(current.threadId);
    await expect(
      getAction(laterTerminal.body.action.requestToken),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: { code: "BROWSER_USER_ACTION_NOT_FOUND" } },
    });
    const retiredBrowser = await client().get({
      headers: { authorization: "Bearer clerk-session" },
      params: { threadId: current.threadId },
    });
    expect(retiredBrowser.status).toBe(404);
    expect(deletedProfiles).toStrictEqual([providerProfileId]);
  }, 120_000);
});

function isoAt(offsetMs: number): string {
  return new Date(STARTED_AT_MS + offsetMs).toISOString();
}

function client() {
  return setupApp({ context, routes: browserRoutes })(browserContract);
}

function authorizationClient(baseUrl = "http://api.test") {
  return setupApp({
    baseUrl,
    context,
    routes: browserAuthorizationRoutes,
  })(browserAuthorizationRequestsContract);
}

function userActionClient(baseUrl = "http://api.test") {
  return setupApp({
    baseUrl,
    context,
    routes: browserUserActionRoutes,
  })(browserUserActionsContract);
}

function chatThreadsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract);
}

function chatThreadComputerUseHostClient() {
  return setupApp({ context, routes: chatThreadComputerUseHostRoutes })(
    chatThreadComputerUseHostContract,
  );
}

function browserReconcileClient() {
  return setupApp({ context, routes: testBrowserReconcileRoutes })(
    testBrowserReconcileContract,
  );
}

async function requestBrowserUse(
  headers: Readonly<Record<string, string>>,
): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: TEST_APP_ROUTES,
  }).request("/api/browsers/use", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
}

function providerBrowser(
  id: string,
  args: {
    readonly status?: "active" | "stopped";
  } = {},
) {
  const status = args.status ?? "active";
  return {
    id,
    status,
    liveUrl:
      status === "active"
        ? "https://live.browser-use.com/?wss=provider-live-token"
        : null,
    cdpUrl: status === "active" ? `https://${id}.cdp.browser-use.com/` : null,
    // The API buys the provider's longest lifetime and reclaims idle browsers
    // itself, so the provider deadline stays far away in these tests.
    timeoutAt: isoAt(240 * MINUTE_MS),
    startedAt: isoAt(0),
    finishedAt: status === "stopped" ? isoAt(10 * MINUTE_MS) : null,
    agentSessionId: null,
    recordingUrl: null,
  };
}

function providerProfile(id: string, name: string) {
  return {
    id,
    userId: null,
    name,
    lastUsedAt: null,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    cookieDomains: null,
  };
}

function browserUseCdpWebSocketUrl(providerSessionId: string): string {
  return `wss://${providerSessionId}.cdp.browser-use.com/devtools/browser/test`;
}

function acceptBrowserUseCdpSessions(
  providerSessionIds: readonly string[],
): void {
  for (const providerSessionId of providerSessionIds) {
    const webSocketUrl = browserUseCdpWebSocketUrl(providerSessionId);
    server.use(
      http.get(
        `https://${providerSessionId}.cdp.browser-use.com/json/version`,
        () => {
          return HttpResponse.json({ webSocketDebuggerUrl: webSocketUrl });
        },
      ),
      browserUseCdpHandler(webSocketUrl),
    );
  }
}

function browserHeadersForRun(
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  runId: string,
): { readonly authorization: string } {
  const browserToken = runs.okouTokenForRunWithCapabilities(actor, runId, [
    "browser:read",
    "browser:write",
  ]);
  return { authorization: `Bearer ${browserToken}` };
}

async function claimChatRun(
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  runId: string,
) {
  await flushWaitUntilForTest();
  const claim = await runs.claimRunnerJob(runId);
  const okouToken = claim.platformEnvironment.OKOU_TOKEN;
  if (!okouToken) {
    throw new Error("Expected the runner claim to include OKOU_TOKEN");
  }
  return {
    browserHeaders: browserHeadersForRun(runs, actor, runId),
    sandboxHeaders: {
      authorization: `Bearer ${claim.sandboxToken}`,
    },
  };
}

async function setupBrowserScenario() {
  mockNow(STARTED_AT_MS);
  mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
  mockEnv("APP_URL", "https://app.okou.ai");
  server.use(
    http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const bdd = createBddApi(context);
  const routeMocks = createRouteMocks(context);
  const runs = createRunsApi(context);
  const chat = createChatFilesBddApi(context);
  const callbacks = createChatCallbacksApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const actor = bdd.user();
  if (!actor.orgId) {
    throw new Error("Managed browser tests require an organization");
  }
  const orgActor = { ...actor, orgId: actor.orgId };
  callbacks.acceptChatObjectStorage();
  callbacks.disableVapid();
  callbacks.failIfChatCallbackRouteIsFetched();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const runnerGroup = runs.configureRunnerGroup();
  await runs.heartbeatRunner(runnerGroup);
  await runs.grantProEntitlement(orgActor);
  const { providerId } = await runs.ensureOrgModelProvider(orgActor);
  await runs.updateOrgModelPolicies(orgActor, [
    {
      model: "claude-fable-5-1",
      isDefault: true,
      defaultProviderType: "anthropic-api-key",
      credentialScope: "org",
      modelProviderId: providerId,
    },
  ]);
  const agent = await bdd.createAgent(orgActor, {
    displayName: "Managed Browser Test",
    visibility: "private",
  });

  return {
    routeMocks,
    runs,
    chat,
    webhooks,
    actor: orgActor,
    runnerGroup,
    agent,
  };
}

async function createClaimedChatRun(
  chat: ReturnType<typeof createChatFilesBddApi>,
  runs: ReturnType<typeof createRunsApi>,
  actor: ApiTestUser,
  agentId: string,
  prompt: string,
) {
  const sent = await chat.requestSendEvent(
    actor,
    {
      agentId,
      prompt,
      cloudBrowserEnabled: true,
    },
    [201],
  );
  if (sent.status !== 201 || sent.body.runId === null) {
    throw new Error("Expected a chat run");
  }
  return {
    sent,
    runId: sent.body.runId,
    threadId: sent.body.threadId,
    claim: await claimChatRun(runs, actor, sent.body.runId),
  };
}

async function reconcileBrowsers(
  chatThreadId: string,
  ...additionalChatThreadIds: string[]
) {
  return await accept(
    browserReconcileClient().reconcile({
      body: {
        chat_thread_ids: [chatThreadId, ...additionalChatThreadIds],
      },
    }),
    [200],
  );
}

describe("okou browser route", () => {
  it("requires a chat thread when starting a managed browser", async () => {
    const { runs, actor } = await setupBrowserScenario();

    const rejected = await requestBrowserUse(
      browserHeadersForRun(runs, actor, randomUUID()),
    );
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toStrictEqual({
      error: {
        code: "BROWSER_CHAT_THREAD_REQUIRED",
        message: "Managed browsers can only be started from an Okou chat run",
      },
    });
  });

  it("keeps managed browser access off for a default chat thread", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Try to open a managed browser without enabling it",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const claim = await runs.claimRunnerJob(sent.body.runId);
    expect(claim.appendSystemPrompt ?? "").toContain(
      "Okou Browser is currently off for this chat thread",
    );
    const browserToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      ["browser:read", "browser:write"],
    );

    const rejected = await requestBrowserUse({
      authorization: `Bearer ${browserToken}`,
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      },
    });
  });

  it("advertises managed browser access for an enabled chat thread", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Open a managed browser",
        cloudBrowserEnabled: true,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }

    const claim = await runs.claimRunnerJob(sent.body.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).toContain(
      "Okou Browser and Okou Computer Use are separate surfaces. `okou browser use` creates, reuses, or resumes a remote browser",
    );
    expect(appendSystemPrompt).toContain(
      "Okou Browser lifetime: `okou browser use` and `okou browser lease` each extend the session's idle lease by a fixed 10 minutes",
    );
    expect(appendSystemPrompt).not.toContain(
      "Okou Browser is currently off for this chat thread",
    );
  });

  it("disables cloud browser when a computer host is selected", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Open a managed browser before selecting this computer",
        cloudBrowserEnabled: true,
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const host = await computerUse.startComputerUseHost(actor);

    await accept(
      chatThreadComputerUseHostClient().update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: sent.body.threadId },
        body: { computerUseHostId: host.hostId },
      }),
      [204],
    );

    const browserToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      ["browser:read", "browser:write"],
    );
    const rejected = await requestBrowserUse({
      authorization: `Bearer ${browserToken}`,
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: {
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      },
    });
  });

  it("uses the configured app URL for browser authorization from run tokens", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const sent = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        prompt: "Ask the user to enable a cloud browser",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected a chat run");
    }
    const sandboxRunToken = runs.sandboxTokenForRun(actor, sent.body.runId);
    const sandboxCreated = await accept(
      authorizationClient().create({
        headers: { authorization: `Bearer ${sandboxRunToken}` },
        body: {},
      }),
      [200],
    );
    expect(new URL(sandboxCreated.body.authorizationUrl).origin).toBe(
      "https://app.okou.ai",
    );
    const okouRunToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.body.runId,
      [],
    );
    const createdOnOkouApi = await accept(
      authorizationClient("https://api.okou.ai").create({
        headers: { authorization: `Bearer ${okouRunToken}` },
        body: {},
      }),
      [200],
    );
    expect(new URL(createdOnOkouApi.body.authorizationUrl).origin).toBe(
      "https://app.okou.ai",
    );
    const requestToken = decodeURIComponent(
      new URL(createdOnOkouApi.body.authorizationUrl).pathname
        .split("/")
        .at(-1) ?? "",
    );
    expect(requestToken).toMatch(/^vm0_browser_authorization_request_/u);

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const pending = await accept(
      authorizationClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
      }),
      [200],
    );
    expect(pending.body).toMatchObject({
      completedAt: null,
      cloudBrowserEnabled: false,
    });

    const applied = await accept(
      authorizationClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
        body: {},
      }),
      [200],
    );
    expect(applied.body).toStrictEqual({
      ok: true,
      cloudBrowserEnabled: true,
    });

    const events = await accept(
      chatThreadsClient().events({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(events.body.events).toContainEqual(
      expect.objectContaining({
        kind: "computer_use_host_updated",
        chatThreadId: sent.body.threadId,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    );
  });

  it("isolates profiles across concurrent thread browser sessions", async () => {
    const { routeMocks, runs, chat, webhooks, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );
    const firstBrowserHeaders = browserHeadersForRun(runs, actor, first.runId);
    const other = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Use a separate profile from another thread",
    );

    const profileIds = [randomUUID(), randomUUID()] as const;
    const providerIds = [randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const stoppedProviderIds: string[] = [];
    let profileCreates = 0;
    let providerCreates = 0;
    // The reconcile route is global, so count only this test's own instances.
    const providerStops = () => {
      return stoppedProviderIds.filter((stopped) => {
        return (providerIds as readonly string[]).includes(stopped);
      }).length;
    };
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        expect(request.headers.get("x-browser-use-api-key")).toBe(
          "test-browser-use-key",
        );
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        expect(body.name).toMatch(/^okou-browser-profile-[0-9a-f-]{36}$/u);
        const profileId = profileIds[profileCreates];
        profileCreates += 1;
        if (!profileId) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerProfile(profileId, body.name), {
          status: 201,
        });
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, ({ params }) => {
        const profileId = String(params.id);
        deletedProfiles.push(profileId);
        if (
          profileId === profileIds[0] &&
          deletedProfiles.filter((deleted) => {
            return deleted === profileId;
          }).length === 1
        ) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, async ({ request }) => {
        providerCreateBodies.push(await request.json());
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(
        `${BROWSER_USE_API_URL}/browsers/:id`,
        async ({ params, request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            action: "stop",
          });
          stoppedProviderIds.push(String(params.id));
          return HttpResponse.json(
            providerBrowser(String(params.id), { status: "stopped" }),
          );
        },
      ),
    );

    const firstCreateRequest = client().create({
      headers: firstBrowserHeaders,
      body: {
        name: "booking",
        proxyCountryCode: null,
      },
    });
    const otherCreateRequest = client().create({
      headers: other.claim.browserHeaders,
      body: {
        name: "research",
        proxyCountryCode: null,
      },
    });
    const [created, createdInOtherThread] = await Promise.all([
      accept(firstCreateRequest, [201]),
      accept(otherCreateRequest, [201]),
    ]);
    expect(created.body.browser).toMatchObject({
      name: "booking",
      status: "active",
      // The API always requests the provider's longest lifetime and manages
      // reclamation through the idle lease instead.
      timeoutMinutes: 240,
      idleExpiresAt: isoAt(10 * MINUTE_MS),
      viewerUrl: `https://app.okou.ai/browsers/${created.body.browser.threadId}`,
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(created.body.cdpUrl).toMatch(
      /^https:\/\/[0-9a-f-]{36}\.cdp\.browser-use\.com\/$/u,
    );
    expect(createdInOtherThread.body.browser).toMatchObject({
      name: "research",
      status: "active",
      viewerUrl: `https://app.okou.ai/browsers/${createdInOtherThread.body.browser.threadId}`,
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(createdInOtherThread.body.browser.threadId).not.toBe(
      created.body.browser.threadId,
    );
    expect(profileCreates).toBe(2);
    expect(providerCreates).toBe(2);
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Browser.setContentsSize";
        }),
    ).toStrictEqual([
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 900 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 900 },
      },
    ]);

    const crossThreadResize = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(
      `/api/chat-threads/${createdInOtherThread.body.browser.threadId}/browser/resize`,
      {
        method: "POST",
        headers: {
          ...firstBrowserHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({ aspectRatio: 0.75 }),
      },
    );
    expect(crossThreadResize.status).toBe(404);
    await expect(crossThreadResize.json()).resolves.toMatchObject({
      error: { code: "BROWSER_NOT_FOUND" },
    });

    expect(
      providerCreateBodies.map((body) => {
        return z
          .strictObject({
            profileId: z.uuid(),
            proxyCountryCode: z.null(),
            timeout: z.literal(240),
            browserScreenWidth: z.literal(1440),
            browserScreenHeight: z.literal(900),
            allowResizing: z.literal(true),
            enableRecording: z.literal(false),
          })
          .parse(body).profileId;
      }),
    ).toStrictEqual(expect.arrayContaining([...profileIds]));
    expect(deletedProfiles).toStrictEqual([]);

    const createdProviderId = new URL(created.body.cdpUrl).hostname.split(
      ".",
    )[0];
    if (!createdProviderId) {
      throw new Error("Expected a Browser Use provider ID");
    }
    const cdpWebSocketUrl = browserUseCdpWebSocketUrl(createdProviderId);
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const resized = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );
    expect(resized.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      screen: {
        width: 1440,
        height: 1920,
        resizable: true,
      },
    });
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledTimes(1);
    expect(context.mocks.browserUseCdp.connect).toHaveBeenCalledWith(
      cdpWebSocketUrl,
    );
    expect(
      context.mocks.browserUseCdp.command.mock.calls.map(([command]) => {
        return command;
      }),
    ).toStrictEqual([
      { id: 1, method: "Target.getTargets", params: {} },
      {
        id: 2,
        method: "Browser.getWindowForTarget",
        params: { targetId: "page-target" },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
    ]);

    const restoredForAnotherViewer = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        extraHeaders: { origin: "https://app.okou.ai" },
        params: { threadId: created.body.browser.threadId },
      }),
      [200],
    );
    expect(restoredForAnotherViewer.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 1920,
      resizable: true,
    });
    expect(restoredForAnotherViewer.body.browser.viewerUrl).toBe(
      `https://app.okou.ai/browsers/${created.body.browser.threadId}`,
    );

    context.mocks.browserUseCdp.command.mockClear();
    const clampedTall = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 0.1 },
      }),
      [200],
    );
    expect(clampedTall.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 3456,
      resizable: true,
    });
    const clampedWide = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: created.body.browser.threadId },
        body: { aspectRatio: 10 },
      }),
      [200],
    );
    expect(clampedWide.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 320,
      resizable: true,
    });
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Browser.setContentsSize";
        }),
    ).toStrictEqual([
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 3456 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 320 },
      },
    ]);
    const copiedToAnotherThread = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/chat-threads/${randomUUID()}/browser`, {
      headers: firstBrowserHeaders,
    });
    expect(copiedToAnotherThread.status).toBe(404);

    const duplicateNew = await accept(
      client().create({
        headers: firstBrowserHeaders,
        body: {
          name: "another",
          proxyCountryCode: null,
        },
      }),
      [201],
    );
    expect(duplicateNew.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      name: "booking",
      status: "active",
    });
    expect(providerCreates).toBe(2);
    expect(profileCreates).toBe(2);
    expect(deletedProfiles).toStrictEqual([]);

    // A terminal run leaves its browser live so the user can keep using it, and
    // restarts the idle lease from the end of the run. The clock moves first so
    // the refreshed deadline cannot be confused with the one create wrote.
    mockNow(STARTED_AT_MS + 2 * MINUTE_MS);
    await webhooks.requestAgentComplete(
      {
        runId: first.runId,
        exitCode: 0,
      },
      first.claim.sandboxHeaders,
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId: other.runId,
        exitCode: 0,
      },
      other.claim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops()).toBe(0);
    const stillLive = await accept(
      client().get({
        headers: firstBrowserHeaders,
        params: { threadId: created.body.browser.threadId },
      }),
      [200],
    );
    expect(stillLive.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(12 * MINUTE_MS),
    });

    // Thread deletion releases both local slots and requests provider cleanup
    // without waiting for Browser Use.
    mockNow(Date.parse("2026-08-03T06:00:00.000Z"));
    await chat.deleteThread(actor, first.threadId);
    await chat.deleteThread(actor, other.threadId);
    await flushWaitUntilForTest();
    expect(providerStops()).toBe(2);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(1);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[1];
      }),
    ).toHaveLength(1);

    // Root deletion preserves browser ownership, so the missing-thread
    // reconciler remains the sole durable provider teardown path.
    await deleteAgentRunRootFixture(first.runId);
    await deleteAgentRunRootFixture(other.runId);
    await reconcileBrowsers(first.threadId, other.threadId);
    expect(providerStops()).toBe(3);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(2);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[1];
      }),
    ).toHaveLength(1);
    await reconcileBrowsers(first.threadId, other.threadId);
    expect(providerStops()).toBe(3);
    expect(
      deletedProfiles.filter((profileId) => {
        return profileId === profileIds[0];
      }),
    ).toHaveLength(2);
  }, 120_000);

  it("fails browser start when its initial size cannot be applied", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser whose window cannot be resized",
    );
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      return command.method === "Browser.setContentsSize"
        ? new Error("test resize failure")
        : undefined;
    });
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const failed = await requestBrowserUse(first.claim.browserHeaders);
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      error: { code: "BROWSER_USE_RESIZE_ERROR" },
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    const current = await accept(
      client().current({ headers: first.claim.browserHeaders }),
      [200],
    );
    expect(current.body.browser.status).toBe("error");
    expect(current.body.browser).not.toHaveProperty("screen");

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
  }, 120_000);

  it("reclaims the earliest idle lease before starting past org concurrency", async () => {
    // Two managed browsers keep the third start past the limit, independent of
    // the Pro plan's own concurrency.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );
    const other = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Use the shared profile from another thread",
    );

    // Admission candidates only need a browser-capable run token, so they skip
    // the runner claim that the org's run concurrency limit would throttle.
    async function createCandidate(prompt: string) {
      const sentCandidate = await chat.requestSendEvent(
        actor,
        {
          agentId: agent.agentId,
          prompt,
          cloudBrowserEnabled: true,
        },
        [201],
      );
      if (sentCandidate.status !== 201 || sentCandidate.body.runId === null) {
        throw new Error("Expected a browser admission candidate run");
      }
      return {
        threadId: sentCandidate.body.threadId,
        browserHeaders: {
          authorization: `Bearer ${runs.okouTokenForRunWithCapabilities(
            actor,
            sentCandidate.body.runId,
            ["browser:read", "browser:write"],
          )}`,
        },
      };
    }

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    let providerCreates = 0;
    const providerStopAttempts: string[] = [];
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        providerStopAttempts.push(providerId);
        if (providerId === providerIds[0]) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "booking", proxyCountryCode: null },
      }),
      [201],
    );
    await accept(
      client().create({
        headers: other.claim.browserHeaders,
        body: { name: "research", proxyCountryCode: null },
      }),
      [201],
    );
    expect(providerCreates).toBe(2);

    mockNow(STARTED_AT_MS + MINUTE_MS);
    await accept(
      client().lease({
        headers: other.claim.browserHeaders,
        body: {},
      }),
      [200],
    );
    const candidate = await createCandidate(
      "Start past the managed browser concurrency limit",
    );
    await accept(
      client().create({
        headers: candidate.browserHeaders,
        body: {
          name: "concurrency-replacement",
          proxyCountryCode: null,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    expect(providerCreates).toBe(3);
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    const reclaimed = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: {
          threadId: (
            await accept(
              client().current({
                headers: first.claim.browserHeaders,
              }),
              [200],
            )
          ).body.browser.threadId,
        },
      }),
      [200],
    );
    expect(reclaimed.body.browser).toMatchObject({
      status: "suspended",
      suspensionReason: "reconcile",
    });
    const healthy = await reconcileBrowsers(
      first.threadId,
      other.threadId,
      candidate.threadId,
    );
    expect(healthy.body).toMatchObject({
      checked: 2,
      stopped: 0,
      errors: 0,
      healthy: 2,
    });
    expect(providerStopAttempts).toStrictEqual([providerIds[0]]);

    // Each deletion can promote a queued run and revoke its marker on another
    // fixture thread. Settle that route-owned work before deleting the next one.
    for (const threadId of [
      first.threadId,
      other.threadId,
      candidate.threadId,
    ]) {
      await chat.deleteThread(actor, threadId);
      await flushWaitUntilForTest();
    }
    expect(providerStopAttempts).toStrictEqual([
      providerIds[0],
      providerIds[1],
      providerIds[2],
    ]);
  }, 120_000);

  it("reconciles only explicitly selected browser fixtures", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const target = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open the selected managed browser",
    );
    const sentinel = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open the untouched managed browser",
    );
    const providerIds = [randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    let providerCreates = 0;
    const stoppedProviderIds: string[] = [];
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        stoppedProviderIds.push(providerId);
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().use({ headers: target.claim.browserHeaders, body: {} }),
      [200],
    );
    await accept(
      client().use({ headers: sentinel.claim.browserHeaders, body: {} }),
      [200],
    );

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reconciled = await reconcileBrowsers(target.threadId);
    expect(reconciled.body).toStrictEqual({
      checked: 1,
      stopped: 1,
      errors: 0,
      healthy: 0,
    });
    await flushWaitUntilForTest();
    expect(stoppedProviderIds).toStrictEqual([providerIds[0]]);

    const untouched = await accept(
      client().get({
        headers: sentinel.claim.browserHeaders,
        params: { threadId: sentinel.threadId },
      }),
      [200],
    );
    expect(untouched.body.browser).toMatchObject({
      threadId: sentinel.threadId,
      status: "active",
    });

    await chat.deleteThread(actor, target.threadId);
    await chat.deleteThread(actor, sentinel.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it("keeps the browser live across runs, lets its viewer resume, and reclaims its idle lease without retrying provider stop", async () => {
    const { routeMocks, runs, chat, webhooks, actor, runnerGroup, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    const savedTabUrls = [
      "https://example.com/research?q=one",
      "http://example.org/draft#section",
    ] as const;
    const cdpWebSocketUrls = [
      browserUseCdpWebSocketUrl(providerIds[0]),
      browserUseCdpWebSocketUrl(providerIds[1]),
      browserUseCdpWebSocketUrl(providerIds[2]),
    ] as const;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
        if (currentCdpWebSocketUrl === cdpWebSocketUrls[0]) {
          return {
            targetInfos: [
              {
                targetId: "first-tab",
                type: "page",
                url: savedTabUrls[0],
              },
              {
                targetId: "duplicate-first-tab",
                type: "page",
                url: savedTabUrls[0],
              },
              {
                targetId: "second-tab",
                type: "page",
                url: savedTabUrls[1],
              },
              {
                targetId: "internal-tab",
                type: "page",
                url: "chrome://settings/",
              },
              {
                targetId: "embedded-page",
                type: "iframe",
                url: "https://example.net/embedded",
              },
            ],
          };
        }
        return {
          targetInfos: [
            {
              targetId: "default-tab",
              type: "page",
              url: "about:blank",
            },
          ],
        };
      }
      if (
        currentCdpWebSocketUrl === cdpWebSocketUrls[1] &&
        command.method === "Target.createTarget" &&
        command.params.url === savedTabUrls[0]
      ) {
        return new Error("test tab restoration failure");
      }
      if (
        currentCdpWebSocketUrl === cdpWebSocketUrls[2] &&
        command.method === "Browser.setContentsSize"
      ) {
        return new Error("test resize failure");
      }
      return undefined;
    });
    let providerCreates = 0;
    let providerStops = 0;
    let firstStopFailures = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(
        `${BROWSER_USE_API_URL}/browsers/:id`,
        async ({ params, request }) => {
          await expect(request.json()).resolves.toStrictEqual({
            action: "stop",
          });
          const providerId = String(params.id);
          if (providerId === providerIds[0] && firstStopFailures === 0) {
            firstStopFailures += 1;
            return HttpResponse.json(
              { detail: "temporary Browser Use outage" },
              { status: 503 },
            );
          }
          providerStops += 1;
          return HttpResponse.json(
            providerBrowser(providerId, { status: "stopped" }),
          );
        },
      ),
    );

    const opened = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    const threadId = opened.body.browser.threadId;
    expect(opened.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(10 * MINUTE_MS),
      screen: {
        width: 1440,
        height: 900,
        resizable: true,
      },
    });
    expect(providerCreates).toBe(1);
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const fitted = await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );
    expect(fitted.body.browser.screen).toStrictEqual({
      width: 1440,
      height: 1920,
      resizable: true,
    });

    // The run ends without stopping the browser, and the thread's next message
    // starts a run right away instead of waiting for browser cleanup.
    mockNow(STARTED_AT_MS + 3 * MINUTE_MS);
    await webhooks.requestAgentComplete(
      { runId: first.runId, exitCode: 0 },
      first.claim.sandboxHeaders,
      [200],
    );
    await flushWaitUntilForTest();
    expect(providerStops).toBe(0);
    const released = await accept(
      client().get({
        headers: first.claim.browserHeaders,
        params: { threadId },
      }),
      [200],
    );
    expect(released.body.browser).toMatchObject({
      status: "active",
      idleExpiresAt: isoAt(13 * MINUTE_MS),
    });

    await runs.heartbeatRunner(runnerGroup);
    mockNow(STARTED_AT_MS + 5 * MINUTE_MS);
    const followup = await chat.requestSendEvent(
      actor,
      {
        agentId: agent.agentId,
        threadId: first.threadId,
        prompt: "Continue in the same browser",
      },
      [201],
    );
    if (followup.status !== 201 || followup.body.runId === null) {
      throw new Error("Expected the follow-up message to start a run");
    }
    const followupRunId = followup.body.runId;
    const followupClaim = await claimChatRun(runs, actor, followupRunId);

    // The next run attaches to the very same provider instance.
    const reused = await accept(
      client().use({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(reused.body.browser).toMatchObject({
      threadId: threadId,
      status: "active",
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });
    expect(providerCreates).toBe(1);

    const leased = await accept(
      client().lease({ headers: followupClaim.browserHeaders, body: {} }),
      [200],
    );
    expect(leased.body.browser).toMatchObject({
      threadId: threadId,
      idleExpiresAt: isoAt(15 * MINUTE_MS),
    });

    // Before the lease expires the reconciler leaves the browser alone.
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const healthy = await reconcileBrowsers(threadId);
    expect(healthy.body).toMatchObject({
      checked: 1,
      stopped: 0,
      errors: 0,
      healthy: 1,
    });
    expect(providerStops).toBe(0);

    mockNow(STARTED_AT_MS + 16 * MINUTE_MS);
    context.mocks.ably.publish.mockClear();
    const reclaimed = await reconcileBrowsers(threadId);
    expect(reclaimed.body).toMatchObject({
      stopped: 1,
      errors: 0,
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { threadId },
    );
    await flushWaitUntilForTest();
    expect(firstStopFailures).toBe(1);
    expect(providerStops).toBe(0);
    const afterFailedStop = await reconcileBrowsers(threadId);
    expect(afterFailedStop.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
    expect(firstStopFailures).toBe(1);

    await accept(
      chatThreadComputerUseHostClient().update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: first.threadId },
        body: {
          computerUseHostId: null,
          cloudBrowserEnabled: false,
        },
      }),
      [204],
    );

    const agentRead = await accept(
      client().get({
        headers: followupClaim.browserHeaders,
        params: { threadId },
      }),
      [403],
    );
    expect(agentRead.body.error).toMatchObject({
      code: "BROWSER_AUTHORIZATION_REQUIRED",
    });

    const suspended = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
      }),
      [200],
    );
    expect(suspended.body.browser).toMatchObject({
      threadId: threadId,
      status: "suspended",
      suspensionReason: "idle",
      idleExpiresAt: null,
    });

    // The viewer can restore a reclaimed browser without a live run.
    context.mocks.ably.publish.mockClear();
    const resumedEventId = randomUUID();
    const resumed = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { eventId: resumedEventId },
      }),
      [200],
    );
    expect(resumed.body.lifecycleEventId).toBe(resumedEventId);
    expect(resumed.body.browser).toMatchObject({
      threadId: threadId,
      status: "active",
      idleExpiresAt: isoAt(26 * MINUTE_MS),
      screen: {
        width: 1440,
        height: 1920,
        resizable: true,
      },
    });
    expect(providerCreates).toBe(2);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "browserSessionChanged",
      { threadId },
    );
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Browser.setContentsSize";
        }),
    ).toStrictEqual([
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 900 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
      {
        id: 3,
        method: "Browser.setContentsSize",
        params: { windowId: 7, width: 1440, height: 1920 },
      },
    ]);
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return (
            command.method === "Target.createTarget" ||
            command.method === "Target.closeTarget"
          );
        }),
    ).toStrictEqual([
      {
        id: 2,
        method: "Target.createTarget",
        params: { url: savedTabUrls[0] },
      },
      {
        id: 3,
        method: "Target.createTarget",
        params: { url: savedTabUrls[1] },
      },
      {
        id: 4,
        method: "Target.closeTarget",
        params: { targetId: "default-tab" },
      },
    ]);

    mockNow(STARTED_AT_MS + 20 * MINUTE_MS);
    const viewerLease = await accept(
      client().leaseByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: {},
      }),
      [200],
    );
    expect(viewerLease.body.browser).toMatchObject({
      threadId: threadId,
      idleExpiresAt: isoAt(30 * MINUTE_MS),
    });

    mockNow(STARTED_AT_MS + 31 * MINUTE_MS);
    const reclaimedAgain = await reconcileBrowsers(threadId);
    expect(reclaimedAgain.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    const failedResume = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/chat-threads/${threadId}/browser/open`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventId: randomUUID() }),
    });
    expect(failedResume.status).toBe(502);
    await expect(failedResume.json()).resolves.toMatchObject({
      error: { code: "BROWSER_USE_RESIZE_ERROR" },
    });
    await flushWaitUntilForTest();
    expect(providerCreates).toBe(3);
    expect(providerStops).toBe(2);
    const afterFailedResume = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
      }),
      [200],
    );
    expect(afterFailedResume.body.browser.status).toBe("error");
    expect(afterFailedResume.body.browser).not.toHaveProperty("screen");

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);

    const reconciled = await reconcileBrowsers(threadId);
    expect(reconciled.body).toMatchObject({
      checked: 0,
      stopped: 0,
      errors: 0,
    });
  }, 120_000);

  it("deletes inactive browser state and its profile after seven days", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser that will expire",
    );
    const profileIds = [randomUUID(), randomUUID()] as const;
    const providerIds = [randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    const providerCreateBodies: unknown[] = [];
    const deletedProfiles: string[] = [];
    const savedTabUrl = "https://example.com/retained-tab";
    let profileCreates = 0;
    let providerCreates = 0;
    let providerStops = 0;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.getTargets") {
        return {
          targetInfos: [
            currentCdpWebSocketUrl === browserUseCdpWebSocketUrl(providerIds[0])
              ? {
                  targetId: "retained-tab",
                  type: "page",
                  url: savedTabUrl,
                }
              : {
                  targetId: "default-tab",
                  type: "page",
                  url: "about:blank",
                },
          ],
        };
      }
      if (command.method === "Target.attachToTarget") {
        return { sessionId: "foreground-session" };
      }
      if (command.method === "Runtime.evaluate") {
        return { result: { type: "boolean", value: true } };
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
        return { data: Buffer.from("retained screenshot").toString("base64") };
      }
      return undefined;
    });
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        const profileId = profileIds[profileCreates];
        profileCreates += 1;
        if (!profileId) {
          return HttpResponse.json(
            { error: "unexpected profile create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerProfile(profileId, body.name), {
          status: 201,
        });
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, ({ params }) => {
        const profileId = String(params.id);
        deletedProfiles.push(profileId);
        if (profileId === profileIds[0] && deletedProfiles.length === 1) {
          return HttpResponse.json(
            { detail: "temporary Browser Use outage" },
            { status: 503 },
          );
        }
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, async ({ request }) => {
        providerCreateBodies.push(await request.json());
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const created = await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    await accept(
      client().resizeByThread({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
        body: { aspectRatio: 0.75 },
      }),
      [200],
    );

    mockNow(STARTED_AT_MS + MINUTE_MS);
    await reconcileBrowsers(current.threadId);
    await flushWaitUntilForTest();
    const withScreenshot = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    const screenshotUrl = withScreenshot.body.browser.screenshotUrl;
    if (!screenshotUrl) {
      throw new Error("Expected a retained browser screenshot");
    }
    const screenshotKey = new URL(screenshotUrl).pathname.slice(1);

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const stopped = await reconcileBrowsers(current.threadId);
    expect(stopped.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS + 7 * DAY_MS - 1);
    const retained = await reconcileBrowsers(current.threadId);
    expect(retained.body.errors).toBe(0);
    const beforeCutoff = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(beforeCutoff.body.browser).toMatchObject({
      status: "suspended",
      screenshotUrl,
    });
    expect(deletedProfiles).toStrictEqual([]);

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS + 7 * DAY_MS);
    const failedCleanup = await reconcileBrowsers(current.threadId);
    expect(failedCleanup.body.errors).toBe(1);
    expect(deletedProfiles).toStrictEqual([profileIds[0]]);
    expect(providerStops).toBe(1);
    const afterFailedProfileDelete = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(afterFailedProfileDelete.body.browser).toMatchObject({
      status: "suspended",
      screenshotUrl: null,
    });
    expect(afterFailedProfileDelete.body.browser).not.toHaveProperty("screen");
    expect(
      context.mocks.s3.send.mock.calls.some(([command]) => {
        const input = commandInput(command);
        return (JSON.stringify(input.Delete) ?? "").includes(screenshotKey);
      }),
    ).toBeFalsy();

    const cleaned = await reconcileBrowsers(current.threadId);
    expect(cleaned.body).toMatchObject({ errors: 0 });
    expect(deletedProfiles).toStrictEqual([profileIds[0], profileIds[0]]);
    expect(providerStops).toBe(1);
    await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [404],
    );

    context.mocks.browserUseCdp.command.mockClear();
    const reopened = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
        body: { eventId: randomUUID() },
      }),
      [200],
    );
    expect(reopened.body.browser).toMatchObject({
      threadId: created.body.browser.threadId,
      status: "active",
      screenshotUrl: null,
      screen: { width: 1440, height: 900, resizable: true },
    });
    expect(profileCreates).toBe(2);
    expect(providerCreates).toBe(2);
    expect(
      z
        .strictObject({
          profileId: z.uuid(),
          proxyCountryCode: z.null(),
          timeout: z.literal(240),
          browserScreenWidth: z.literal(1440),
          browserScreenHeight: z.literal(900),
          allowResizing: z.literal(true),
          enableRecording: z.literal(false),
        })
        .parse(providerCreateBodies[1]).profileId,
    ).toBe(profileIds[1]);
    expect(
      context.mocks.browserUseCdp.command.mock.calls.some(([command]) => {
        return command.method === "Target.createTarget";
      }),
    ).toBeFalsy();

    await chat.deleteThread(actor, current.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it("deduplicates previous snapshot URLs before restoring browser tabs", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Restore a managed browser snapshot",
    );

    const providerIds = [randomUUID(), randomUUID()] as const;
    const savedTabUrls = [
      "https://example.com/research?q=one",
      "http://example.org/draft#section",
    ] as const;
    const cdpWebSocketUrls = [
      `wss://${providerIds[0]}.cdp.browser-use.com/devtools/browser/test`,
      `wss://${providerIds[1]}.cdp.browser-use.com/devtools/browser/test`,
    ] as const;
    let currentCdpWebSocketUrl: string | null = null;
    context.mocks.browserUseCdp.connect.mockImplementation((url) => {
      currentCdpWebSocketUrl = url;
    });
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method !== "Target.getTargets") {
        return undefined;
      }
      if (currentCdpWebSocketUrl === cdpWebSocketUrls[0]) {
        return {
          targetInfos: [
            {
              targetId: "captured-tab",
              type: "page",
              url: savedTabUrls[0],
            },
          ],
        };
      }
      return {
        targetInfos: [
          {
            targetId: "default-tab",
            type: "page",
            url: "about:blank",
          },
        ],
      };
    });
    let providerCreates = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const providerId = providerIds[providerCreates];
        providerCreates += 1;
        if (!providerId) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(providerId), {
          status: 201,
        });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      ...providerIds.map((providerId, index) => {
        const webSocketUrl = cdpWebSocketUrls[index];
        return http.get(
          `https://${providerId}.cdp.browser-use.com/json/version`,
          () => {
            return HttpResponse.json({
              webSocketDebuggerUrl: webSocketUrl,
            });
          },
        );
      }),
      ...cdpWebSocketUrls.map((webSocketUrl) => {
        return browserUseCdpHandler(webSocketUrl);
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    const opened = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    const threadId = opened.body.browser.threadId;
    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers(threadId);
    expect(reclaimed.body).toMatchObject({ stopped: 1, errors: 0 });
    await flushWaitUntilForTest();

    // This historical snapshot shape cannot be produced through the current
    // capture path because capture now deduplicates before persistence.
    await setBrowserTabSnapshotAsPreviousApi(context, {
      threadId,
      tabUrls: [
        savedTabUrls[0],
        savedTabUrls[0],
        savedTabUrls[1],
        savedTabUrls[0],
        savedTabUrls[1],
      ],
    });
    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const resumed = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: { eventId: randomUUID() },
      }),
      [200],
    );
    expect(resumed.body.browser.status).toBe("active");
    expect(
      context.mocks.browserUseCdp.command.mock.calls
        .map(([command]) => {
          return command;
        })
        .filter((command) => {
          return command.method === "Target.createTarget";
        }),
    ).toStrictEqual([
      {
        id: 2,
        method: "Target.createTarget",
        params: { url: savedTabUrls[0] },
      },
      {
        id: 3,
        method: "Target.createTarget",
        params: { url: savedTabUrls[1] },
      },
    ]);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
  }, 120_000);

  it.each(["no_page_target", "target_disappeared", "other", "timeout"])(
    "absorbs a %s screenshot failure and keeps the browser usable",
    async (failureKind) => {
      const { routeMocks, runs, chat, actor, agent } =
        await setupBrowserScenario();
      const current = await createClaimedChatRun(
        chat,
        runs,
        actor,
        agent.agentId,
        "Open a browser without a screenshot",
      );
      const providerId = randomUUID();
      acceptBrowserUseCdpSessions([providerId]);
      server.use(
        http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
          const body = z
            .strictObject({ name: z.string() })
            .parse(await request.json());
          return HttpResponse.json(providerProfile(randomUUID(), body.name), {
            status: 201,
          });
        }),
        http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
          return HttpResponse.json(providerBrowser(providerId), {
            status: 201,
          });
        }),
        http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
          return HttpResponse.json(providerBrowser(String(params.id)));
        }),
      );
      await accept(
        client().use({ headers: current.claim.browserHeaders, body: {} }),
        [200],
      );
      await flushWaitUntilForTest();
      context.mocks.browserUseCdp.command.mockImplementation((command) => {
        if (
          command.method === "Target.getTargets" &&
          failureKind === "no_page_target"
        ) {
          return { targetInfos: [] };
        }
        if (command.method === "Target.attachToTarget") {
          if (failureKind === "target_disappeared") {
            return new Error("No target with given id found");
          }
          return { sessionId: "foreground-session" };
        }
        if (command.method === "Runtime.evaluate") {
          return { result: { type: "boolean", value: true } };
        }
        if (command.method === "Page.getLayoutMetrics") {
          return {
            cssVisualViewport: {
              pageX: 0,
              pageY: 0,
              clientWidth: 1280,
              clientHeight: 720,
            },
          };
        }
        if (command.method === "Page.captureScreenshot") {
          return failureKind === "other"
            ? new Error("Screenshot capture unavailable")
            : { data: Buffer.from("screenshot").toString("base64") };
        }
        return undefined;
      });
      if (failureKind === "timeout") {
        // Node storage transports can wrap the deadline in an AbortError.
        const timeout = new Error("The operation was aborted", {
          cause: new DOMException(
            "Screenshot deadline exceeded",
            "TimeoutError",
          ),
        });
        timeout.name = "AbortError";
        context.mocks.s3.send.mockImplementation((command: unknown) => {
          return commandInput(command).ContentType === "image/webp"
            ? Promise.reject(timeout)
            : Promise.resolve({});
        });
      }

      const reconciled = await reconcileBrowsers(current.threadId);
      expect(reconciled.body).toMatchObject({ healthy: 1, errors: 0 });
      await flushWaitUntilForTest();

      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
      const lease = await accept(
        client().leaseByThread({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
          body: {},
        }),
        [200],
      );
      expect(lease.body.browser).toMatchObject({
        status: "active",
        screenshotUrl: null,
      });
      await flushWaitUntilForTest();
      expect(
        context.mocks.browserUseCdp.command.mock.calls.filter(([command]) => {
          return command.method === "Page.captureScreenshot";
        }),
      ).toHaveLength(
        failureKind === "other" || failureKind === "timeout" ? 1 : 0,
      );
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return input.ContentType === "image/webp" || "Delete" in input;
        }),
      ).toHaveLength(failureKind === "timeout" ? 1 : 0);
      expect(context.mocks.sentry.captureException.mock.calls).toStrictEqual(
        [],
      );
    },
    120_000,
  );

  it.each([false, true])(
    "captures the foreground tab and retains screenshots across updates and flag changes (private=%s)",
    async (privateFiles) => {
      const { routeMocks, runs, chat, actor, agent } =
        await setupBrowserScenario();
      const current = await createClaimedChatRun(
        chat,
        runs,
        actor,
        agent.agentId,
        "Open a managed browser for screenshot capture",
      );
      if (!actor.orgId) {
        throw new Error("Expected organization");
      }
      const flagActor = { ...actor, orgId: actor.orgId };
      await updateFeatureSwitchesForUser(context, flagActor, {
        [FeatureSwitchKey.PrivateArtifacts]: privateFiles,
      });
      if (privateFiles) {
        context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
          const input = commandInput(command);
          expect(input.Bucket).toBe("test-private-artifacts");
          return Promise.resolve(
            `https://screenshot-r2.example/${String(input.Bucket)}/${String(input.Key)}?signature=preview`,
          );
        });
      }
      const providerId = randomUUID();
      acceptBrowserUseCdpSessions([providerId]);
      server.use(
        http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
          const body = z
            .strictObject({ name: z.string() })
            .parse(await request.json());
          return HttpResponse.json(providerProfile(randomUUID(), body.name), {
            status: 201,
          });
        }),
        http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
          return HttpResponse.json(providerBrowser(providerId), {
            status: 201,
          });
        }),
        http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
          return HttpResponse.json(providerBrowser(String(params.id)));
        }),
        http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
          return HttpResponse.json(
            providerBrowser(String(params.id), { status: "stopped" }),
          );
        }),
      );
      const releaseSecondScreenshotUpload = createDeferredPromise<void>(
        context.signal,
      );
      const releaseThirdScreenshotUpload = createDeferredPromise<void>(
        context.signal,
      );
      let screenshotUploadCount = 0;
      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const input = commandInput(command);
        if (input.ContentType === "image/webp") {
          screenshotUploadCount += 1;
          if (screenshotUploadCount === 2) {
            return releaseSecondScreenshotUpload.promise;
          }
          if (screenshotUploadCount === 3) {
            return releaseThirdScreenshotUpload.promise;
          }
        }
        return Promise.resolve({});
      });
      installArtifactReferenceStorage(context);
      let captureCount = 0;
      let failNextCapture = false;
      context.mocks.browserUseCdp.command.mockImplementation((command) => {
        if (command.method === "Target.getTargets") {
          return {
            targetInfos: [
              {
                targetId: "background-page",
                type: "page",
                url: "https://background.example.com",
              },
              {
                targetId: "foreground-page",
                type: "page",
                url: "https://foreground.example.com",
              },
            ],
          };
        }
        if (command.method === "Target.attachToTarget") {
          return {
            sessionId:
              command.params.targetId === "foreground-page"
                ? "foreground-session"
                : "background-session",
          };
        }
        if (command.method === "Runtime.evaluate") {
          return {
            result: {
              type: "boolean",
              value: command.sessionId === "foreground-session",
            },
          };
        }
        if (command.method === "Page.getLayoutMetrics") {
          return {
            cssVisualViewport: {
              pageX: 0,
              pageY: 24,
              clientWidth: 1280,
              clientHeight: 720,
            },
          };
        }
        if (command.method === "Page.captureScreenshot") {
          if (failNextCapture) {
            return new Error("Screenshot capture unavailable");
          }
          captureCount += 1;
          return {
            data: Buffer.from(`screenshot-${String(captureCount)}`).toString(
              "base64",
            ),
          };
        }
        return undefined;
      });

      await accept(
        client().use({ headers: current.claim.browserHeaders, body: {} }),
        [200],
      );
      routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);

      const firstLease = await accept(
        client().leaseByThread({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
          body: {},
        }),
        [200],
      );
      expect(firstLease.body.browser.screenshotUrl).toBeNull();
      await flushWaitUntilForTest();
      expect(captureCount).toBe(0);

      const afterViewerLease = await accept(
        client().get({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
        }),
        [200],
      );
      expect(afterViewerLease.body.browser.screenshotUrl).toBeNull();

      const firstReconcile = await reconcileBrowsers(current.threadId);
      expect(firstReconcile.body).toMatchObject({
        errors: 0,
      });
      await flushWaitUntilForTest();

      const afterFirstCapture = await accept(
        client().get({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
        }),
        [200],
      );
      const firstScreenshotUrl = afterFirstCapture.body.browser.screenshotUrl;
      expect(firstScreenshotUrl).toMatch(
        privateFiles
          ? /^https:\/\/screenshot-r2\.example\/test-private-artifacts\/private-artifacts\/.+\?signature=preview$/u
          : /^https:\/\/a\.okou\.io\/.+\.webp$/u,
      );
      if (!firstScreenshotUrl) {
        throw new Error("Expected the first browser screenshot URL");
      }
      const firstScreenshotKey = privateFiles
        ? new URL(firstScreenshotUrl).pathname.slice(
            "/test-private-artifacts/".length,
          )
        : `artifacts/${new URL(firstScreenshotUrl).pathname.slice(1)}`;
      const screenshotPut = context.mocks.s3.send.mock.calls
        .map(([command]) => {
          return commandInput(command);
        })
        .find((input) => {
          return input.ContentType === "image/webp";
        });
      expect(screenshotPut?.Bucket).toBe(
        privateFiles ? "test-private-artifacts" : "test-user-artifacts",
      );
      expect(screenshotPut?.Metadata).toMatchObject(
        privateFiles
          ? { "artifact-id": expect.any(String) }
          : { "public-brand": "okou" },
      );

      const secondLease = await accept(
        client().leaseByThread({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
          body: {},
        }),
        [200],
      );
      expect(secondLease.body.browser.screenshotUrl).toBe(firstScreenshotUrl);
      await flushWaitUntilForTest();
      expect(captureCount).toBe(1);

      const secondReconcile = await reconcileBrowsers(current.threadId);
      expect(secondReconcile.body).toMatchObject({
        errors: 0,
      });
      releaseSecondScreenshotUpload.resolve(undefined);
      await flushWaitUntilForTest();

      const afterSecondCapture = await accept(
        client().get({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
        }),
        [200],
      );
      const secondScreenshotUrl = afterSecondCapture.body.browser.screenshotUrl;
      expect(secondScreenshotUrl).not.toBe(firstScreenshotUrl);
      if (!secondScreenshotUrl) {
        throw new Error("Expected the second browser screenshot URL");
      }
      const secondScreenshotKey = privateFiles
        ? new URL(secondScreenshotUrl).pathname.slice(
            "/test-private-artifacts/".length,
          )
        : `artifacts/${new URL(secondScreenshotUrl).pathname.slice(1)}`;
      expect(captureCount).toBe(2);
      expect(
        context.mocks.browserUseCdp.command.mock.calls
          .map(([command]) => {
            return command;
          })
          .filter((command) => {
            return command.method === "Page.captureScreenshot";
          }),
      ).toStrictEqual([
        {
          id: 7,
          method: "Page.captureScreenshot",
          params: {
            format: "webp",
            quality: 80,
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: 0,
              y: 24,
              width: 1280,
              height: 720,
              scale: 0.5,
            },
          },
          sessionId: "foreground-session",
        },
        {
          id: 7,
          method: "Page.captureScreenshot",
          params: {
            format: "webp",
            quality: 80,
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: 0,
              y: 24,
              width: 1280,
              height: 720,
              scale: 0.5,
            },
          },
          sessionId: "foreground-session",
        },
      ]);

      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return (JSON.stringify(input.Delete) ?? "").includes(
            firstScreenshotKey,
          );
        }),
      ).toHaveLength(0);
      const thirdReconcile = await reconcileBrowsers(current.threadId);
      expect(thirdReconcile.body).toMatchObject({
        errors: 0,
      });
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return (JSON.stringify(input.Delete) ?? "").includes(
            firstScreenshotKey,
          );
        }),
      ).toHaveLength(0);
      releaseThirdScreenshotUpload.resolve(undefined);
      await flushWaitUntilForTest();

      const afterThirdCapture = await accept(
        client().get({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
        }),
        [200],
      );
      const finalScreenshotUrl = afterThirdCapture.body.browser.screenshotUrl;
      expect(finalScreenshotUrl).not.toBe(secondScreenshotUrl);
      if (!finalScreenshotUrl) {
        throw new Error("Expected the third browser screenshot URL");
      }
      const finalScreenshotKey = privateFiles
        ? new URL(finalScreenshotUrl).pathname.slice(
            "/test-private-artifacts/".length,
          )
        : `artifacts/${new URL(finalScreenshotUrl).pathname.slice(1)}`;
      expect(captureCount).toBe(3);
      await updateFeatureSwitchesForUser(context, flagActor, {
        [FeatureSwitchKey.PrivateArtifacts]: !privateFiles,
      });
      failNextCapture = true;
      const failedCapture = await reconcileBrowsers(current.threadId);
      expect(failedCapture.body).toMatchObject({ healthy: 1, errors: 0 });
      await flushWaitUntilForTest();
      const retainedPreview = await accept(
        client().get({
          headers: { authorization: "Bearer clerk-session" },
          params: { threadId: current.threadId },
        }),
        [200],
      );
      expect(retainedPreview.body.browser).toMatchObject({
        status: "active",
        screenshotUrl: finalScreenshotUrl,
      });
      expect(context.mocks.sentry.captureException.mock.calls).toStrictEqual(
        [],
      );
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return (JSON.stringify(input.Delete) ?? "").includes(
            secondScreenshotKey,
          );
        }),
      ).toHaveLength(0);

      await chat.deleteThread(actor, current.threadId);
      await flushWaitUntilForTest();
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return (JSON.stringify(input.Delete) ?? "").includes(
            finalScreenshotKey,
          );
        }),
      ).toHaveLength(0);

      const reconciled = await reconcileBrowsers(current.threadId);
      expect(reconciled.body).toMatchObject({
        errors: 0,
      });
      expect(
        context.mocks.s3.send.mock.calls.filter(([command]) => {
          const input = commandInput(command);
          return (JSON.stringify(input.Delete) ?? "").includes(
            finalScreenshotKey,
          );
        }),
      ).toHaveLength(0);
    },
    120_000,
  );

  it("reclaims an active browser after its thread is already deleted", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        providerStops += 1;
        return HttpResponse.json(
          providerBrowser(String(params.id), { status: "stopped" }),
        );
      }),
    );

    await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );

    await deleteChatThreadRootFixture(first.threadId);
    const reclaimed = await reconcileBrowsers(first.threadId);
    expect(reclaimed.body).toStrictEqual({
      checked: 2,
      stopped: 2,
      errors: 0,
      healthy: 0,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);

    const retired = await reconcileBrowsers(first.threadId);
    expect(retired.body).toStrictEqual({
      checked: 0,
      stopped: 0,
      errors: 0,
      healthy: 0,
    });
    await deleteAgentRunRootFixture(first.runId);
  }, 120_000);

  it("records browser lifecycle events only for UI actions and automatic reclamation", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const first = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a managed browser",
    );

    const providerIds = [randomUUID(), randomUUID(), randomUUID()] as const;
    acceptBrowserUseCdpSessions(providerIds);
    let providerCreates = 0;
    let providerStops = 0;
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const id = providerIds[providerCreates];
        providerCreates += 1;
        if (!id) {
          return HttpResponse.json(
            { error: "unexpected browser create" },
            { status: 500 },
          );
        }
        return HttpResponse.json(providerBrowser(id), { status: 201 });
      }),
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const providerId = String(params.id);
        if (
          providerIds.some((id) => {
            return id === providerId;
          })
        ) {
          providerStops += 1;
        }
        return HttpResponse.json(
          providerBrowser(providerId, { status: "stopped" }),
        );
      }),
    );

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    const beforeStartCloseEventId = randomUUID();
    await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: beforeStartCloseEventId },
      }),
      [200],
    );

    const firstStart = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );
    expect(firstStart.body.lifecycleEventId).toBeNull();

    const beforeReclaimCloseEventId = randomUUID();
    await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: beforeReclaimCloseEventId },
      }),
      [200],
    );

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    const reclaimed = await reconcileBrowsers(first.threadId);
    expect(reclaimed.body).toMatchObject({
      errors: 0,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
    const resumed = await accept(
      client().create({
        headers: first.claim.browserHeaders,
        body: { name: "replacement", proxyCountryCode: null },
      }),
      [201],
    );
    expect(resumed.body.browser).toMatchObject({
      threadId: firstStart.body.browser.threadId,
      status: "active",
    });
    expect(resumed.body.lifecycleEventId).toBeNull();
    expect(providerCreates).toBe(2);

    const openEventId = randomUUID();
    const alreadyActive = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: openEventId },
      }),
      [200],
    );
    expect(alreadyActive.body).toMatchObject({
      lifecycleEventId: openEventId,
      browser: { threadId: first.threadId, status: "active" },
    });

    const closeEventId = randomUUID();
    const closed = await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: { eventId: closeEventId },
      }),
      [200],
    );
    expect(closed.body).toStrictEqual({
      lifecycleEventId: closeEventId,
    });
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);
    const stillActive = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
      }),
      [200],
    );
    expect(stillActive.body.browser.status).toBe("active");

    const events = await readProjectedChatEvents(context, {
      threadId: first.threadId,
      headers: { authorization: "Bearer clerk-session" },
    });
    expect(
      events.flatMap((event) => {
        return event.eventType === "browser.open" ||
          event.eventType === "browser.close"
          ? [
              {
                id: event.id,
                eventType: event.eventType,
                content: event.content,
              },
            ]
          : [];
      }),
    ).toStrictEqual([
      {
        id: beforeStartCloseEventId,
        eventType: "browser.close",
        content: null,
      },
      {
        id: beforeReclaimCloseEventId,
        eventType: "browser.close",
        content: null,
      },
      {
        id: expect.any(String),
        eventType: "browser.close",
        content: null,
      },
      {
        id: openEventId,
        eventType: "browser.open",
        content: null,
      },
      {
        id: closeEventId,
        eventType: "browser.close",
        content: null,
      },
    ]);

    const collided = await createApp({
      signal: context.signal,
      routes: TEST_APP_ROUTES,
    }).request(`/api/chat-threads/${first.threadId}/browser/close`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ eventId: closeEventId }),
    });
    expect(collided.status).toBe(409);
    await expect(collided.json()).resolves.toMatchObject({
      error: { code: "BROWSER_EVENT_ID_CONFLICT" },
    });
    expect(providerCreates).toBe(2);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(1);

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);
  }, 120_000);
});
