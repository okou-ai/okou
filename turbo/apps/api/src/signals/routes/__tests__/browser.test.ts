import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installArtifactReferenceStorage } from "./helpers/artifact-reference-storage";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { runInNewContext } from "node:vm";

import { testBrowserReconcileContract } from "@okouai/api-contracts/contracts/test-browser-reconcile";
import {
  browserAuthorizationRequestsContract,
  browserContract,
} from "@okouai/api-contracts/contracts/browser";
import {
  BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES,
  BROWSER_USER_ACTION_MAX_FILE_BYTES,
  browserUserActionsContract,
} from "@okouai/api-contracts/contracts/browser-user-actions";
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
import { setupApp, setupRawAppRequest } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { mockNow, withMockNowForTest } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { deleteChatThreadRootFixture } from "../../../test-fixtures/chat-thread-deletion";
import { stageRetiredDirectBrowserUserActionFixture } from "../../../test-fixtures/browser-user-action";
import { deleteAgentRunRootFixture } from "../../../test-fixtures/run-deletion";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
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

function inspectShadowTextControl(declaration: string, type: string): unknown {
  const document = {};
  const shadowRoot = {};
  class NativeInput {
    readonly tagName = "INPUT";
    readonly isConnected = true;
    readonly ownerDocument = document;
    readonly required = false;
    readonly readOnly = false;
    readonly multiple = false;
    readonly minLength = -1;
    readonly maxLength = -1;
    readonly pattern = "";
    readonly value = "synthetic";

    constructor(readonly type: string) {}

    getRootNode() {
      return shadowRoot;
    }

    matches() {
      return false;
    }
  }
  // Run the actual CDP function rather than fabricating its inspection flags.
  return runInNewContext(`(${declaration}).call(control)`, {
    control: new NativeInput(type),
    document,
    HTMLInputElement: NativeInput,
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    HTMLOptGroupElement: class {},
  }) as unknown;
}

function browserSelectWrites() {
  return context.mocks.browserUseCdp.command.mock.calls.filter(([command]) => {
    return (
      command.method === "Runtime.callFunctionOn" &&
      typeof command.params.functionDeclaration === "string" &&
      command.params.functionDeclaration.includes("firstSpec")
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

function browserValidationNodeResult(args: {
  readonly backendNodeId: unknown;
  readonly available: boolean;
  readonly missingBackendNodeId: number | null;
  readonly malformed: boolean;
  readonly failure: string | null;
}): unknown {
  if (args.failure) {
    return new Error(args.failure);
  }
  if (args.malformed) {
    return {};
  }
  return args.available && args.backendNodeId !== args.missingBackendNodeId
    ? { object: { objectId: browserUserActionObjectId(args.backendNodeId) } }
    : new Error("No node with given id found");
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

async function createNativePasswordActionForPreflightTest(
  eventsBeforeReply?: NonNullable<Parameters<typeof browserUseCdpHandler>[1]>,
  withholdReply?: NonNullable<Parameters<typeof browserUseCdpHandler>[2]>,
): Promise<{
  readonly token: string;
  readonly providerId: string;
}> {
  const { routeMocks, runs, chat, actor, agent } = await setupBrowserScenario();
  const current = await createClaimedChatRun(
    chat,
    runs,
    actor,
    agent.agentId,
    "Enter a password on the current Browser page",
  );
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.BrowserNativeInput]: true,
  });
  const providerId = randomUUID();
  acceptBrowserUseCdpSessions([providerId], eventsBeforeReply, withholdReply);
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
    http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
      return HttpResponse.json(providerBrowser(String(params.id)));
    }),
  );
  await accept(
    client().use({ headers: current.claim.browserHeaders, body: {} }),
    [200],
  );
  routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  const created = await accept(
    userActionClient().create({
      headers: current.claim.browserHeaders,
      body: nativePasswordRequest("Continue after entering the password"),
    }),
    [201],
  );
  return { token: created.body.action.requestToken, providerId };
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

interface NativeConstrainedMockArgs {
  readonly constraints: () => NativeNumberConstraints;
  readonly verificationMatches: () => boolean;
  readonly inputType?: () => string;
  readonly siteRequired?: () => boolean;
  readonly rangeValue?: () => string;
  readonly colorValue?: () => string;
  readonly writable?: () => boolean;
  readonly validValue?: (value: unknown) => boolean;
}

function nativeVerifyOnly(argumentsValue: unknown): boolean {
  const first = Array.isArray(argumentsValue) ? argumentsValue[0] : undefined;
  return (
    typeof first === "object" &&
    first !== null &&
    "value" in first &&
    typeof first.value === "object" &&
    first.value !== null &&
    "verifyOnly" in first.value &&
    first.value.verifyOnly === true
  );
}

function nativeObservedColorMetadata(args: NativeConstrainedMockArgs) {
  return args.inputType?.() === "color" && args.writable?.() !== false
    ? { colorValue: args.colorValue?.() ?? "#000000", colorMode: "opaque-srgb" }
    : {};
}

function mockNativeConstrainedInspection(args: NativeConstrainedMockArgs) {
  const { min, max, step } = args.constraints();
  return {
    result: {
      value: [
        {
          tagName: "INPUT",
          inputType: args.inputType?.() ?? "number",
          connected: true,
          mainDocument: true,
          writable: args.writable?.() ?? true,
          siteRequired: args.siteRequired?.() ?? false,
          multiple: false,
          ...(args.inputType?.() === "range" && args.writable?.() !== false
            ? { rangeValue: args.rangeValue?.() ?? "50" }
            : {}),
          ...nativeObservedColorMetadata(args),
          ...(min ? { min } : {}),
          ...(max ? { max } : {}),
          ...(step ? { step } : {}),
        },
      ],
    },
  };
}

function mockNativeConstrainedCall(
  args: NativeConstrainedMockArgs,
  params: {
    readonly functionDeclaration?: unknown;
    readonly arguments?: unknown;
  },
) {
  const declaration = String(params.functionDeclaration);
  if (declaration.includes("firstSpec")) {
    return {
      result: {
        value:
          !nativeVerifyOnly(params.arguments) || args.verificationMatches(),
      },
    };
  }
  if (declaration.includes("expectedValues")) {
    return { result: { value: args.verificationMatches() } };
  }
  if (declaration.includes("cloneNode")) {
    const first = Array.isArray(params.arguments)
      ? params.arguments[0]
      : undefined;
    const value =
      typeof first === "object" && first !== null && "value" in first
        ? first.value
        : undefined;
    return {
      result: {
        value: args.validValue
          ? args.validValue(value)
          : validNumberValue(value, args.constraints()),
      },
    };
  }
  if (declaration.includes("nextValue")) {
    return { result: { value: true } };
  }
  return mockNativeConstrainedInspection(args);
}

function mockNativeNumberTarget(args: NativeConstrainedMockArgs): void {
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
        return mockNativeConstrainedCall(args, command.params);
      }
      default: {
        return {};
      }
    }
  });
}

function mockNativeSelectTarget(args: {
  readonly mode: () => "select-one" | "select-multiple";
  readonly options: () => readonly {
    readonly index: number;
    readonly label: string;
    readonly value: string;
    readonly disabled: boolean;
    readonly selected: boolean;
    readonly empty: boolean;
  }[];
  readonly writeMatches: () => boolean;
  readonly includeScalar?: () => boolean;
  readonly writable?: () => boolean;
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
        return { sessionId: "native-select-session" };
      }
      case "Browser.getWindowForTarget": {
        return { windowId: 7 };
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "native-select-loader",
              url: "https://example.com/order",
            },
          },
        };
      }
      case "DOM.resolveNode": {
        return {
          object: {
            objectId:
              args.includeScalar?.() && command.params.backendNodeId === 46
                ? "native-scalar-object"
                : "native-select-object",
          },
        };
      }
      case "Runtime.callFunctionOn": {
        const declaration = String(command.params.functionDeclaration);
        if (declaration.includes("firstSpec")) {
          return { result: { value: args.writeMatches() } };
        }
        if (declaration.includes("cloneNode")) {
          return { result: { value: true } };
        }
        const select = {
          tagName: "SELECT",
          inputType: args.mode(),
          connected: true,
          mainDocument: true,
          writable: args.writable?.() ?? true,
          siteRequired: false,
          multiple: args.mode() === "select-multiple",
          options: args.options(),
        };
        const scalar = {
          tagName: "INPUT",
          inputType: "text",
          connected: true,
          mainDocument: true,
          writable: true,
          siteRequired: false,
          multiple: false,
          options: [],
        };
        const controls =
          args.includeScalar?.() &&
          Array.isArray(command.params.arguments) &&
          command.params.arguments.length > 0
            ? [select, scalar]
            : [select];
        return { result: { value: controls } };
      }
      default: {
        return {};
      }
    }
  });
}

function mockNativeCheckboxTarget(args: {
  readonly checked: () => boolean;
  readonly writable: () => boolean;
  readonly type: () => string;
  readonly writeMatches: () => boolean;
  readonly siteRequired: () => boolean;
}): void {
  context.mocks.browserUseCdp.command.mockImplementation((command) => {
    switch (command.method) {
      case "Target.getTargets": {
        return {
          targetInfos: [
            {
              targetId: "native-input-target",
              type: "page",
              url: "https://example.com/consent",
            },
          ],
        };
      }
      case "Target.attachToTarget": {
        return { sessionId: "native-checkbox-session" };
      }
      case "Browser.getWindowForTarget": {
        return { windowId: 7 };
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "native-checkbox-loader",
              url: "https://example.com/consent",
            },
          },
        };
      }
      case "DOM.resolveNode": {
        return { object: { objectId: "native-checkbox-object" } };
      }
      case "Runtime.callFunctionOn": {
        const declaration = String(command.params.functionDeclaration);
        if (declaration.includes("firstSpec")) {
          return { result: { value: args.writeMatches() } };
        }
        return {
          result: {
            value: [
              {
                tagName: "INPUT",
                inputType: args.type(),
                connected: true,
                mainDocument: true,
                writable: args.writable(),
                siteRequired: args.siteRequired(),
                multiple: false,
                ...(args.type() === "checkbox"
                  ? { checked: args.checked() }
                  : {}),
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

type NativeRadioMockState = {
  memberIds: readonly number[];
  name: string;
  formOwnerId: number;
  selectedIndex: number;
  disabledIndex: number;
  writeMatches: boolean;
  readbackMatches: boolean;
  siteRequired: boolean;
  scalar?: {
    nodeId: number;
    required: boolean;
    requiredAfterWrite: "immediate" | "microtask";
  } | null;
};

function mockNativeRadioCallFunctionOn(
  state: NativeRadioMockState,
  params: {
    functionDeclaration?: unknown;
    arguments?: unknown;
    objectId?: unknown;
  },
) {
  const declaration = String(params.functionDeclaration);
  if (declaration.includes("firstSpec")) {
    const args = params.arguments as {
      value?: { kind?: string; required?: boolean; verifyOnly?: boolean };
    }[];
    if (
      state.scalar &&
      (state.scalar.requiredAfterWrite === "immediate" ||
        (args[0]?.value?.verifyOnly &&
          state.scalar.requiredAfterWrite === "microtask"))
    ) {
      state.scalar.required = true;
    }
    const scalarSpec = args.find((arg) => {
      return arg.value?.kind === "scalar";
    })?.value;
    const constraintsMatch =
      !state.scalar || scalarSpec?.required === state.scalar.required;
    return {
      result: {
        value:
          (args[0]?.value?.verifyOnly
            ? state.readbackMatches
            : state.writeMatches) && constraintsMatch,
      },
    };
  }
  if (declaration.includes("function (nextValue")) {
    return { result: { value: true } };
  }
  if (declaration.includes("function(limit)")) {
    return { result: { objectId: "radio-array" } };
  }
  if (declaration.includes("function(anchor, owner)")) {
    return {
      result: {
        value: {
          name: state.name,
          options: state.memberIds.map((_, index) => {
            return {
              label: "Same label",
              value: "same-private-value",
              disabled: index === state.disabledIndex,
              selected: index === state.selectedIndex,
              required: state.siteRequired && index === 0,
              writable: true,
            };
          }),
        },
      },
    };
  }
  const objectIds = [
    params.objectId,
    ...((params.arguments as { objectId: string }[] | undefined) ?? []).map(
      (arg) => {
        return arg.objectId;
      },
    ),
  ];
  return {
    result: {
      value: objectIds.map((objectId) => {
        return objectId === "native-scalar-object"
          ? {
              tagName: "INPUT",
              inputType: "text",
              connected: true,
              mainDocument: true,
              writable: true,
              siteRequired: state.scalar?.required ?? false,
              multiple: false,
            }
          : {
              tagName: "INPUT",
              inputType: "radio",
              connected: true,
              mainDocument: true,
              writable: true,
              siteRequired: state.siteRequired,
              multiple: false,
            };
      }),
    },
  };
}

function mockNativeRadioTarget(state: NativeRadioMockState): void {
  context.mocks.browserUseCdp.command.mockImplementation((command) => {
    switch (command.method) {
      case "Target.getTargets": {
        return {
          targetInfos: [
            {
              targetId: "native-input-target",
              type: "page",
              url: "https://example.com/radio",
            },
          ],
        };
      }
      case "Target.attachToTarget": {
        return { sessionId: "native-radio-session" };
      }
      case "Browser.getWindowForTarget": {
        return { windowId: 7 };
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "native-radio-loader",
              url: "https://example.com/radio",
            },
          },
        };
      }
      case "DOM.resolveNode": {
        return {
          object: {
            objectId:
              state.scalar?.nodeId === command.params.backendNodeId
                ? "native-scalar-object"
                : "radio-object",
          },
        };
      }
      case "DOM.describeNode": {
        const objectId = String(command.params.objectId);
        if (objectId === "radio-form") {
          return {
            node: { backendNodeId: state.formOwnerId, nodeName: "FORM" },
          };
        }
        const index = Number(objectId.split("-")[1]);
        return {
          node: { backendNodeId: state.memberIds[index], nodeName: "INPUT" },
        };
      }
      case "Runtime.getProperties": {
        return {
          result: [
            ...state.memberIds.map((_, index) => {
              return {
                name: String(index),
                value: { objectId: `radio-${index}` },
              };
            }),
            { name: "formOwner", value: { objectId: "radio-form" } },
          ],
        };
      }
      case "Runtime.callFunctionOn": {
        return mockNativeRadioCallFunctionOn(state, command.params);
      }
      default: {
        return {};
      }
    }
  });
}

function mockNativeFileTarget(state: {
  readonly current: () => readonly {
    name: string;
    size: number;
    type: string;
  }[];
  readonly writable: () => boolean;
  readonly mainDocument: () => boolean;
  readonly missingNode: () => boolean;
  readonly readback: () => boolean;
  readonly accept: () => string;
  readonly multiple: () => boolean;
  readonly write: (
    files: readonly { name: string; size: number; type: string }[],
  ) => void;
}): void {
  context.mocks.browserUseCdp.command.mockImplementation((command) => {
    switch (command.method) {
      case "Target.getTargets": {
        return {
          targetInfos: [
            {
              targetId: "native-input-target",
              type: "page",
              url: "https://example.com/upload",
            },
          ],
        };
      }
      case "Target.attachToTarget": {
        return { sessionId: "native-file-session" };
      }
      case "Browser.getWindowForTarget": {
        return { windowId: 7 };
      }
      case "Page.getFrameTree": {
        return {
          frameTree: {
            frame: {
              id: "main-frame",
              loaderId: "native-file-loader",
              url: "https://example.com/upload",
            },
          },
        };
      }
      case "Page.createIsolatedWorld": {
        return { executionContextId: 101 };
      }
      case "DOM.resolveNode": {
        return state.missingNode()
          ? new Error("No node with given id found")
          : { object: { objectId: "file-object" } };
      }
      case "Runtime.callFunctionOn": {
        const declaration = String(command.params.functionDeclaration);
        if (declaration.includes("const transfer = new DataTransfer")) {
          const args = command.params.arguments as { value?: unknown }[];
          const files = args[2]?.value as readonly {
            name: string;
            size: number;
            type: string;
          }[];
          state.write(
            args[1]?.value === "clear"
              ? []
              : files.map(({ name, size, type }) => {
                  return { name, size, type };
                }),
          );
          return { result: { value: true } };
        }
        if (declaration.includes("function (original, expected)")) {
          return { result: { value: state.readback() } };
        }
        return {
          result: {
            value: [
              {
                tagName: "INPUT",
                inputType: "file",
                connected: true,
                mainDocument: state.mainDocument(),
                writable: state.writable(),
                siteRequired: false,
                multiple: state.multiple(),
                accept: state.accept(),
                files: state.current(),
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

async function setupNativeFileScenario() {
  const { routeMocks, runs, chat, actor, agent } = await setupBrowserScenario();
  const current = await createClaimedChatRun(
    chat,
    runs,
    actor,
    agent.agentId,
    "Choose a local file for the website",
  );
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.BrowserNativeInput]: true,
  });
  const providerId = randomUUID();
  acceptBrowserUseCdpSessions([providerId]);
  const temporaryObjects = new Map<string, Buffer>();
  const deletedKeys: string[] = [];
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (command instanceof GetObjectCommand) {
      const bytes = temporaryObjects.get(String(command.input.Key));
      if (!bytes) {
        throw new Error("Synthetic temporary object missing");
      }
      return Promise.resolve({
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      });
    }
    if (command instanceof DeleteObjectsCommand) {
      for (const entry of command.input.Delete?.Objects ?? []) {
        const key = String(entry.Key);
        deletedKeys.push(key);
        temporaryObjects.delete(key);
      }
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
  const state = {
    files: [] as readonly { name: string; size: number; type: string }[],
    siteAccept: ".txt",
    multiple: true,
    writable: true,
    fileInMainDocument: true,
    missingNode: false,
    readback: true,
  };
  mockNativeFileTarget({
    current: () => {
      return state.files;
    },
    writable: () => {
      return state.writable;
    },
    mainDocument: () => {
      return state.fileInMainDocument;
    },
    missingNode: () => {
      return state.missingNode;
    },
    readback: () => {
      return state.readback;
    },
    accept: () => {
      return state.siteAccept;
    },
    multiple: () => {
      return state.multiple;
    },
    write: (next) => {
      state.files = next;
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
  const create = async (required = false) => {
    return await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after selecting the file",
          pageTargetId: "native-input-target",
          fields: [
            {
              key: "document",
              label: "Document",
              fieldKind: "file",
              required,
              backendNodeId: 45,
            },
          ],
        },
      }),
      [201],
    );
  };
  const stageSyntheticFile = async (
    requestToken: string,
    bytes = Buffer.from("test"),
    index = 0,
  ) => {
    const prepared = await accept(
      userActionClient().prepareFileUpload({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken },
        body: {
          key: "document",
          index,
          size: bytes.length,
        },
      }),
      [200],
    );
    expect(prepared.body.uploadUrl).toMatch(/^https?:\/\//u);
    const signing = context.mocks.s3.getSignedUrl.mock.lastCall;
    const signedCommand = signing?.[1];
    if (!(signedCommand instanceof PutObjectCommand)) {
      throw new Error("Expected a synthetic signed PUT command");
    }
    expect(signedCommand.input).toMatchObject({
      Bucket: "test-user-storages",
      ContentLength: bytes.length,
      ContentType: "application/octet-stream",
    });
    expect(signing?.[2]).toMatchObject({ expiresIn: 600 });
    expect(signedCommand.input.ChecksumSHA256).toBeUndefined();
    expect(prepared.body).toStrictEqual({
      uploadUrl: expect.stringMatching(/^https?:\/\//u),
    });
    expect(JSON.stringify(prepared.body)).not.toContain("note.txt");
    const key = `browser-native-input/${browserUserActionTokenHash(requestToken)}/${index.toString()}`;
    temporaryObjects.set(key, bytes);
    return key;
  };
  return {
    state,
    current,
    create,
    stageSyntheticFile,
    temporaryObjects,
    deletedKeys,
  };
}

function nativeFileValue(fingerprint: string) {
  return {
    key: "document",
    observedFingerprint: fingerprint,
    operation: "replace" as const,
    files: [{ name: "note.txt", size: 4, type: "text/plain" }],
  };
}

aroundEach(async (runTest) => {
  await withMockNowForTest(STARTED_AT_MS, runTest);
});

describe("Browser user-action route", () => {
  it("bounds native file input and cleans staged files when target observation becomes stale", async () => {
    const { state, create, stageSyntheticFile, temporaryObjects, deletedKeys } =
      await setupNativeFileScenario();
    const created = await create();
    const token = created.body.action.requestToken;
    expect(created.body.action.fields[0]?.control).toMatchObject({
      inputType: "file",
    });
    expect(JSON.stringify(created.body)).not.toContain("fileSetFingerprint");
    const oversized = await setupRawAppRequest({
      context,
      routes: browserUserActionRoutes,
    })(`/api/browser/user-actions/${token}/apply`, {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
      },
      body: " ".repeat(BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body).toMatchObject({
      error: { message: "Browser input request is too large" },
    });
    const observed = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: {},
      }),
      [200],
    );
    expect(observed.body.fields[0]?.control).toMatchObject({
      inputType: "file",
      accept: ".txt",
      multiple: true,
      files: [],
    });
    const fingerprint = observed.body.fields[0]?.control.fileSetFingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    const value = nativeFileValue(fingerprint ?? "");
    const firstKey = await stageSyntheticFile(token);
    const invalidMime = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: token },
      body: {
        values: [
          { ...value, files: [{ ...value.files[0]!, type: "TEXT/PLAIN" }] },
        ],
      },
    });
    expect(invalidMime.status).toBe(400);
    expect(state.files).toHaveLength(0);
    state.siteAccept = ".pdf";
    const drifted = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [value] },
      }),
      [200],
    );
    expect(drifted.body.state).toBe("stale");
    expect(state.files).toHaveLength(0);
    state.siteAccept = ".txt";
    const preflightCandidate = await create();
    const preflightKey = await stageSyntheticFile(
      preflightCandidate.body.action.requestToken,
    );
    state.missingNode = true;
    const preflightStale = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: {
          requestToken: preflightCandidate.body.action.requestToken,
        },
        body: {},
      }),
      [200],
    );
    expect(preflightStale.body.state).toBe("stale");
    expect(deletedKeys).toContain(preflightKey);
    expect(temporaryObjects.has(preflightKey)).toBeFalsy();
    expect(state.files).toHaveLength(0);
    state.missingNode = false;
    state.files = [];
    const next = await create();
    const nextToken = next.body.action.requestToken;
    const nextKey = await stageSyntheticFile(nextToken);
    const applied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: nextToken },
        body: { values: [value] },
      }),
      [200],
    );
    expect(applied.body.state).toBe("succeeded");
    expect(deletedKeys).toContain(firstKey);
    expect(deletedKeys).toContain(nextKey);
    expect(state.files).toStrictEqual([
      { name: "note.txt", size: 4, type: "text/plain" },
    ]);
    expect(JSON.stringify(applied.body)).not.toContain("note.txt");
    expect(
      context.mocks.browserUseCdp.command.mock.calls.some(([command]) => {
        return command.method === "Page.createIsolatedWorld";
      }),
    ).toBeTruthy();
  });

  it("preserves selected files for unavailable controls and reports failed independent readback", async () => {
    const { state, current, create, stageSyntheticFile } =
      await setupNativeFileScenario();
    // Model an existing user selection at the provider boundary. This scenario
    // verifies it survives an unavailable/replaced control without another upload.
    state.files = [{ name: "note.txt", size: 4, type: "text/plain" }];
    const value = nativeFileValue("");
    state.writable = false;
    const unavailable = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after selecting the file",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "document",
            label: "Document",
            fieldKind: "file",
            required: false,
            backendNodeId: 45,
          },
        ],
      },
    });
    expect(unavailable.status).toBe(409);
    state.writable = true;
    const movedToShadow = await create();
    state.fileInMainDocument = false;
    const staleRoot = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: movedToShadow.body.action.requestToken },
        body: { values: [] },
      }),
      [200],
    );
    expect(staleRoot.body.state).toBe("stale");
    expect(state.files).toStrictEqual([
      { name: "note.txt", size: 4, type: "text/plain" },
    ]);
    const unsupportedFileRoot = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after unsupported file root",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "document",
            label: "Document",
            fieldKind: "file",
            required: false,
            backendNodeId: 45,
          },
        ],
      },
    });
    expect(unsupportedFileRoot).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL" } },
    });
    state.fileInMainDocument = true;
    const missing = await create();
    state.missingNode = true;
    const staleNode = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: missing.body.action.requestToken },
        body: { values: [] },
      }),
      [200],
    );
    expect(staleNode.body.state).toBe("stale");
    state.missingNode = false;
    const noReadback = await create();
    const changedFingerprint =
      (
        await accept(
          userActionClient().preflight({
            headers: { authorization: "Bearer clerk-session" },
            params: { requestToken: noReadback.body.action.requestToken },
            body: {},
          }),
          [200],
        )
      ).body.fields[0]?.control.fileSetFingerprint ?? "";
    state.readback = false;
    await stageSyntheticFile(noReadback.body.action.requestToken);
    const uncertain = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: noReadback.body.action.requestToken },
        body: {
          values: [{ ...value, observedFingerprint: changedFingerprint }],
        },
      }),
      [200],
    );
    expect(uncertain.body.state).toBe("uncertain");
  });

  it("bounds staged file transfer, supports multiple files and cleans cancelled uploads", async () => {
    const { state, create, stageSyntheticFile, temporaryObjects, deletedKeys } =
      await setupNativeFileScenario();
    const tampered = await create();
    const observed = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: tampered.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    const value = nativeFileValue(
      observed.body.fields[0]?.control.fileSetFingerprint ?? "",
    );
    const tamperedKey = await stageSyntheticFile(
      tampered.body.action.requestToken,
    );
    const writesBeforeTamper = browserInputWrites().length;
    temporaryObjects.delete(tamperedKey);
    const missingObject = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: tampered.body.action.requestToken },
      body: { values: [value] },
    });
    expect(missingObject.status).toBe(409);
    expect(browserInputWrites()).toHaveLength(writesBeforeTamper);

    temporaryObjects.set(
      tamperedKey,
      Buffer.alloc(BROWSER_USER_ACTION_MAX_FILE_BYTES + 1),
    );
    const oversizedObject = await userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: tampered.body.action.requestToken },
      body: { values: [value] },
    });
    expect(oversizedObject.status).toBe(409);
    expect(browserInputWrites()).toHaveLength(writesBeforeTamper);
    // A same-size replacement is now accepted: only size, not SHA, is checked.
    temporaryObjects.set(tamperedKey, Buffer.from("bad!"));
    const acceptedChangedBytes = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: tampered.body.action.requestToken },
        body: { values: [value] },
      }),
      [200],
    );
    expect(acceptedChangedBytes.body.state).toBe("succeeded");
    expect(browserInputWrites()).toHaveLength(writesBeforeTamper + 1);
    state.files = [];

    const maxBytes = Buffer.alloc(10 * 1024 * 1024, 0x61);
    const maxAction = await create();
    await stageSyntheticFile(maxAction.body.action.requestToken, maxBytes);
    const maxApplied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: maxAction.body.action.requestToken },
        body: {
          values: [
            {
              ...value,
              files: [
                {
                  ...value.files[0]!,
                  size: maxBytes.length,
                },
              ],
            },
          ],
        },
      }),
      [200],
    );
    expect(maxApplied.body.state).toBe("succeeded");
    expect(state.files).toStrictEqual([
      { name: "note.txt", size: maxBytes.length, type: "text/plain" },
    ]);

    state.files = [];
    const multiAction = await create();
    const parts = [
      Buffer.from("first"),
      Buffer.from("second"),
      Buffer.from("third"),
    ];
    const multiToken = multiAction.body.action.requestToken;
    const multiKeys: string[] = [];
    for (const [index, bytes] of parts.entries()) {
      multiKeys.push(await stageSyntheticFile(multiToken, bytes, index));
    }
    const multiValues = parts.map((bytes, index) => {
      return {
        name: `part-${index.toString()}.txt`,
        type: "text/plain",
        size: bytes.length,
      };
    });
    const multiApplied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: multiToken },
        body: { values: [{ ...value, files: multiValues }] },
      }),
      [200],
    );
    expect(multiApplied.body.state).toBe("succeeded");
    expect(state.files).toStrictEqual(
      multiValues.map(({ name, size, type }) => {
        return { name, size, type };
      }),
    );
    for (const key of multiKeys) {
      expect(deletedKeys).toContain(key);
      expect(temporaryObjects.has(key)).toBeFalsy();
    }

    const cancelled = await create();
    const cancelToken = cancelled.body.action.requestToken;
    const cancelledKey = await stageSyntheticFile(cancelToken);
    const cancelledResponse = await accept(
      userActionClient().cancel({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: cancelToken },
        body: {},
      }),
      [200],
    );
    expect(cancelledResponse.body.state).toBe("cancelled");
    expect(deletedKeys).toContain(cancelledKey);
    expect(temporaryObjects.has(cancelledKey)).toBeFalsy();
  });

  it("lets apply finish while the preflight provider read is still pending", async () => {
    const { token } = await createNativePasswordActionForPreflightTest();
    const readStarted = createDeferredPromise<void>(context.signal);
    const releaseRead = createDeferredPromise<void>(context.signal);
    let holdNextRead = true;
    server.use(
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, async ({ params }) => {
        if (holdNextRead) {
          holdNextRead = false;
          readStarted.resolve(undefined);
          await releaseRead.promise;
        }
        return HttpResponse.json(providerBrowser(String(params.id)));
      }),
    );

    const preflight = userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: token },
      body: {},
    });
    await readStarted.promise;
    const applied = await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [{ key: "password", value: "synthetic-secret" }] },
      }),
      [200],
    );
    expect(applied.body.state).toBe("succeeded");
    releaseRead.resolve(undefined);
    const checked = await preflight;
    expect(checked.status).toBe(409);
    expect(browserInputWrites()).toHaveLength(1);
  });

  it("returns a retryable provider timeout when the internal CDP deadline expires", async () => {
    const { token, providerId } =
      await createNativePasswordActionForPreflightTest();
    const deadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 15_000 ? deadline.signal : undefined;
    });
    const discoveryStarted = createDeferredPromise<void>(context.signal);
    const discoveryAborted = createDeferredPromise<void>(context.signal);
    server.use(
      http.get(
        `https://${providerId}.cdp.browser-use.com/json/version`,
        async ({ request }) => {
          request.signal.addEventListener(
            "abort",
            () => {
              discoveryAborted.resolve(undefined);
            },
            { once: true },
          );
          discoveryStarted.resolve(undefined);
          await discoveryAborted.promise;
          return HttpResponse.json({
            webSocketDebuggerUrl: browserUseCdpWebSocketUrl(providerId),
          });
        },
      ),
    );
    const preflight = userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: token },
      body: {},
    });
    await discoveryStarted.promise;
    deadline.abort(new DOMException("CDP deadline", "TimeoutError"));
    const checked = await preflight;
    await discoveryAborted.promise;
    expect(checked).toMatchObject({
      status: 503,
      body: { error: { code: "BROWSER_USE_TIMEOUT" } },
    });
  });

  it("keeps a preflight pending when its attach reply is withheld until the deadline", async () => {
    const attachStarted = createDeferredPromise<void>(context.signal);
    let holdAttachReply = false;
    const { token } = await createNativePasswordActionForPreflightTest(
      (command) => {
        if (holdAttachReply && command.method === "Target.attachToTarget") {
          attachStarted.resolve();
          return [{ method: "Target.attachedToTarget", params: {} }];
        }
        return [];
      },
      (command) => {
        return holdAttachReply && command.method === "Target.attachToTarget";
      },
    );
    const deadline = new AbortController();
    context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
      return milliseconds === 15_000 ? deadline.signal : undefined;
    });
    holdAttachReply = true;
    const preflight = userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: token },
      body: {},
    });
    await attachStarted.promise;
    deadline.abort(new DOMException("CDP deadline", "TimeoutError"));
    const failed = await preflight;
    expect(failed).toMatchObject({
      status: 503,
      body: { error: { code: "BROWSER_USE_TIMEOUT" } },
    });
    const pending = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
      }),
      [200],
    );
    expect(pending.body.state).toBe("pending");
  });

  it("preflights when an attach event and reply arrive back-to-back", async () => {
    let emitAttachEvent = false;
    const { token } = await createNativePasswordActionForPreflightTest(
      (command) => {
        return emitAttachEvent && command.method === "Target.attachToTarget"
          ? [{ method: "Target.attachedToTarget", params: {} }]
          : [];
      },
    );
    emitAttachEvent = true;
    const checked = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: {},
      }),
      [200],
    );
    expect(checked.body.state).toBe("pending");
  });

  it("keeps an input request pending when an interleaved attach reply is a CDP error", async () => {
    let emitAttachEvent = false;
    const { token } = await createNativePasswordActionForPreflightTest(
      (command) => {
        return emitAttachEvent && command.method === "Target.attachToTarget"
          ? [{ method: "Target.attachedToTarget", params: {} }]
          : [];
      },
    );
    const originalCommand =
      context.mocks.browserUseCdp.command.getMockImplementation();
    if (!originalCommand) {
      throw new Error("Browser CDP mock has no command implementation");
    }
    context.mocks.browserUseCdp.command.mockImplementation((command) => {
      if (command.method === "Target.attachToTarget") {
        return new Error("Synthetic attach failure");
      }
      return originalCommand(command);
    });
    emitAttachEvent = true;
    const failed = await userActionClient().preflight({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: token },
      body: {},
    });
    expect(failed).toMatchObject({
      status: 502,
      body: { error: { code: "BROWSER_USER_ACTION_PROVIDER_ERROR" } },
    });
    const pending = await accept(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
      }),
      [200],
    );
    expect(pending.body.state).toBe("pending");
  });

  it("applies explicit checkbox booleans, preserves untouched state, and rejects changed or required checkboxes", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Confirm a checkbox in the Browser",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let checked = true;
    let writable = true;
    let type = "checkbox";
    let writeMatches = true;
    let siteRequired = false;
    mockNativeCheckboxTarget({
      checked: () => {
        return checked;
      },
      writable: () => {
        return writable;
      },
      type: () => {
        return type;
      },
      writeMatches: () => {
        return writeMatches;
      },
      siteRequired: () => {
        return siteRequired;
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
    const createCheckbox = async (required = false) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after checkbox input",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "consent",
                label: "Consent",
                fieldKind: "checkbox",
                required,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const preflight = async (token: string) => {
      return await accept(
        userActionClient().preflight({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken: token },
          body: {},
        }),
        [200],
      );
    };
    const apply = async (
      token: string,
      values: readonly {
        readonly key: string;
        readonly checked: boolean;
        readonly observedChecked: boolean;
      }[],
    ) => {
      return await userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [...values] },
      });
    };
    const created = await createCheckbox();
    expect(created.body.action.fields[0]).toMatchObject({
      fieldKind: "checkbox",
      control: { tagName: "INPUT", inputType: "checkbox" },
    });
    expect(JSON.stringify(created.body)).not.toContain('"checked"');
    const token = created.body.action.requestToken;
    expect((await preflight(token)).body.fields[0]?.control).toMatchObject({
      checked: true,
      siteRequired: false,
    });
    const falseChoice = {
      key: "consent",
      checked: false,
      observedChecked: true,
    };
    expect((await accept(apply(token, [falseChoice]), [200])).body.state).toBe(
      "succeeded",
    );
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { kind: "checkbox", checked: false, observedChecked: true } },
      { value: 0 },
    ]);
    expect(
      JSON.stringify(browserSelectWrites().at(-1)?.[0].params.arguments),
    ).not.toContain('"on"');
    const untouched = await createCheckbox();
    expect(
      (await accept(apply(untouched.body.action.requestToken, []), [200])).body
        .state,
    ).toBe("succeeded");
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { kind: "checkbox", checked: null, observedChecked: true } },
      { value: 0 },
    ]);
    const drifted = await createCheckbox();
    const driftedToken = drifted.body.action.requestToken;
    await preflight(driftedToken);
    checked = false;
    expect(
      (await accept(apply(driftedToken, [falseChoice]), [200])).body.state,
    ).toBe("stale");
    const required = await createCheckbox(true);
    const requiredToken = required.body.action.requestToken;
    await expect(apply(requiredToken, [])).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" } },
    });
    await expect(
      apply(requiredToken, [
        { key: "consent", checked: false, observedChecked: false },
      ]),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" } },
    });
    expect(
      (
        await accept(
          apply(requiredToken, [
            { key: "consent", checked: true, observedChecked: false },
          ]),
          [200],
        )
      ).body.state,
    ).toBe("succeeded");
    siteRequired = true;
    const siteRequiredAction = await createCheckbox();
    const siteRequiredToken = siteRequiredAction.body.action.requestToken;
    await expect(
      apply(siteRequiredToken, [
        { key: "consent", checked: false, observedChecked: false },
      ]),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    siteRequired = false;
    writable = false;
    const disabled = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after checkbox input",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "consent",
            label: "Consent",
            fieldKind: "checkbox",
            required: false,
            backendNodeId: 45,
          },
        ],
      },
    });
    expect(disabled.status).toBe(409);
    writable = true;
    type = "text";
    expect(
      (
        await userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after checkbox input",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "consent",
                label: "Consent",
                fieldKind: "checkbox",
                required: false,
                backendNodeId: 45,
              },
            ],
          },
        })
      ).status,
    ).toBe(409);
    type = "checkbox";
    writeMatches = false;
    const uncertain = await createCheckbox();
    expect(
      (
        await accept(
          apply(uncertain.body.action.requestToken, [
            { key: "consent", checked: true, observedChecked: false },
          ]),
          [200],
        )
      ).body.state,
    ).toBe("uncertain");
  });

  it("discovers exact radio member identities, selects duplicate-valued option by index, and rejects group drift", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Choose radio option",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    const group = {
      memberIds: [45, 46, 47] as readonly number[],
      name: "delivery",
      formOwnerId: 90,
      selectedIndex: 0,
      disabledIndex: 2,
      writeMatches: true,
      readbackMatches: true,
      siteRequired: false,
      scalar: null as {
        nodeId: number;
        required: boolean;
        requiredAfterWrite: "immediate" | "microtask";
      } | null,
    };
    mockNativeRadioTarget(group);
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
    const create = async () => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after radio selection",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "delivery",
                label: "Delivery",
                fieldKind: "radio",
                required: false,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const preflight = async (token: string) => {
      return await accept(
        userActionClient().preflight({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken: token },
          body: {},
        }),
        [200],
      );
    };
    const apply = async (
      token: string,
      memberIndex: number,
      observedSelectedIndex: number,
      fingerprint: string,
    ) => {
      return await userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: {
          values: [
            {
              key: "delivery",
              memberIndex,
              observedSelectedIndex,
              groupFingerprint: fingerprint,
            },
          ],
        },
      });
    };
    const fingerprintFor = async (requestToken: string) => {
      const value = (await preflight(requestToken)).body.fields[0]?.control
        .radioGroupFingerprint;
      if (!value) {
        throw new Error("Missing radio fingerprint");
      }
      return value;
    };
    const created = await create();
    const token = created.body.action.requestToken;
    expect(JSON.stringify(created.body)).not.toContain("radioMemberNodeIds");
    const observed = await preflight(token);
    const control = observed.body.fields[0]?.control;
    expect(control?.radioOptions).toMatchObject([
      { index: 0, label: "Same label", selected: true },
      { index: 1, label: "Same label", disabled: false },
      { index: 2, disabled: true },
    ]);
    expect(JSON.stringify(observed.body)).not.toContain("same-private-value");
    expect(JSON.stringify(observed.body)).not.toContain("radioMemberNodeIds");
    const fingerprint = control?.radioGroupFingerprint;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    if (!fingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    expect(
      (await accept(apply(token, 1, 0, fingerprint), [200])).body.state,
    ).toBe("succeeded");
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { kind: "radio", index: 1, selectedIndex: 0, memberCount: 3 } },
      { value: 0 },
      { objectId: "radio-0" },
      { objectId: "radio-1" },
      { objectId: "radio-2" },
      { objectId: "radio-form" },
    ]);
    const clear = await create();
    const clearToken = clear.body.action.requestToken;
    const clearFingerprint = (await preflight(clearToken)).body.fields[0]
      ?.control.radioGroupFingerprint;
    if (!clearFingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    expect(
      (await accept(apply(clearToken, -1, 0, clearFingerprint), [200])).body
        .state,
    ).toBe("succeeded");
    const disabled = await create();
    const disabledToken = disabled.body.action.requestToken;
    const disabledFingerprint = (await preflight(disabledToken)).body.fields[0]
      ?.control.radioGroupFingerprint;
    if (!disabledFingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    await expect(
      apply(disabledToken, 2, 0, disabledFingerprint),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    group.siteRequired = true;
    group.selectedIndex = -1;
    const siteRequired = await create();
    const siteRequiredToken = siteRequired.body.action.requestToken;
    const siteFingerprint = (await preflight(siteRequiredToken)).body.fields[0]
      ?.control.radioGroupFingerprint;
    if (!siteFingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    await expect(
      apply(siteRequiredToken, -1, -1, siteFingerprint),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    group.siteRequired = false;
    group.selectedIndex = 0;
    group.writeMatches = false;
    const uncertain = await create();
    const uncertainToken = uncertain.body.action.requestToken;
    const uncertainFingerprint = (await preflight(uncertainToken)).body
      .fields[0]?.control.radioGroupFingerprint;
    if (!uncertainFingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    expect(
      (await accept(apply(uncertainToken, 1, 0, uncertainFingerprint), [200]))
        .body.state,
    ).toBe("uncertain");
    group.writeMatches = true;
    group.readbackMatches = false;
    const reverted = await create();
    const revertedToken = reverted.body.action.requestToken;
    const revertedFingerprint = await fingerprintFor(revertedToken);
    expect(
      (await accept(apply(revertedToken, 1, 0, revertedFingerprint), [200]))
        .body.state,
    ).toBe("uncertain");
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      {
        value: {
          kind: "radio",
          index: 1,
          selectedIndex: 0,
          memberCount: 3,
          verifyOnly: true,
        },
      },
      { value: 0 },
      { objectId: "radio-0" },
      { objectId: "radio-1" },
      { objectId: "radio-2" },
      { objectId: "radio-form" },
    ]);
    group.readbackMatches = true;
    const changed = await create();
    const changedToken = changed.body.action.requestToken;
    const checked = await preflight(changedToken);
    const changedFingerprint =
      checked.body.fields[0]?.control.radioGroupFingerprint;
    if (!changedFingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    group.selectedIndex = 1;
    expect(
      (await accept(apply(changedToken, 0, 0, changedFingerprint), [200])).body
        .state,
    ).toBe("stale");
    group.selectedIndex = 0;
    const renamed = await create();
    const renamedToken = renamed.body.action.requestToken;
    const renamedFingerprint = await fingerprintFor(renamedToken);
    group.name = "other-delivery";
    expect(
      (await accept(apply(renamedToken, 1, 0, renamedFingerprint), [200])).body
        .state,
    ).toBe("stale");
    group.name = "delivery";
    const moved = await create();
    const movedToken = moved.body.action.requestToken;
    const movedFingerprint = await fingerprintFor(movedToken);
    group.formOwnerId = 91;
    expect(
      (await accept(apply(movedToken, 1, 0, movedFingerprint), [200])).body
        .state,
    ).toBe("stale");
    group.formOwnerId = 90;
    const replaced = await create();
    const replacedToken = replaced.body.action.requestToken;
    const replacedFingerprint = (await preflight(replacedToken)).body.fields[0]
      ?.control.radioGroupFingerprint;
    if (!replacedFingerprint) {
      throw new Error("Missing radio fingerprint");
    }
    group.memberIds = [45, 46, 48];
    expect(
      (await accept(apply(replacedToken, 1, 0, replacedFingerprint), [200]))
        .body.state,
    ).toBe("stale");

    // A radio change handler can make another, untouched field required after
    // the initial scalar validation. This is a partial write, not success.
    const verifyMixedConstraintDrift = async () => {
      group.memberIds = [45, 46, 47];
      group.scalar = {
        nodeId: 50,
        required: false,
        requiredAfterWrite: "immediate",
      };
      const createMixed = async () => {
        return await accept(
          userActionClient().create({
            headers: current.claim.browserHeaders,
            body: {
              kind: "input",
              callbackPrompt: "Continue after the mixed form",
              pageTargetId: "native-input-target",
              fields: [
                {
                  key: "delivery",
                  label: "Delivery",
                  fieldKind: "radio",
                  required: false,
                  backendNodeId: 45,
                },
                {
                  key: "note",
                  label: "Note",
                  fieldKind: "text",
                  required: false,
                  backendNodeId: 50,
                },
              ],
            },
          }),
          [201],
        );
      };
      const mixed = await createMixed();
      const mixedToken = mixed.body.action.requestToken;
      const mixedFingerprint = await fingerprintFor(mixedToken);
      expect(
        (
          await accept(
            userActionClient().apply({
              headers: { authorization: "Bearer clerk-session" },
              params: { requestToken: mixedToken },
              body: {
                values: [
                  {
                    key: "delivery",
                    memberIndex: 1,
                    observedSelectedIndex: 0,
                    groupFingerprint: mixedFingerprint,
                  },
                ],
              },
            }),
            [200],
          )
        ).body.state,
      ).toBe("uncertain");
      expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
        { value: { kind: "radio", index: 1 } },
        { value: 1 },
        { objectId: "native-scalar-object" },
        {
          value: {
            kind: "scalar",
            required: false,
            multiple: false,
            value: null,
          },
        },
        { objectId: "radio-0" },
        { objectId: "radio-1" },
        { objectId: "radio-2" },
        { objectId: "radio-form" },
      ]);

      // If the site's handler defers the constraint change to a microtask, the
      // first write can appear successful; the independent readback must reject it.
      group.scalar = {
        nodeId: 50,
        required: false,
        requiredAfterWrite: "microtask",
      };
      const delayed = await createMixed();
      const delayedToken = delayed.body.action.requestToken;
      const delayedFingerprint = await fingerprintFor(delayedToken);
      const writesBeforeDelayed = browserSelectWrites().length;
      expect(
        (
          await accept(
            userActionClient().apply({
              headers: { authorization: "Bearer clerk-session" },
              params: { requestToken: delayedToken },
              body: {
                values: [
                  {
                    key: "delivery",
                    memberIndex: 1,
                    observedSelectedIndex: 0,
                    groupFingerprint: delayedFingerprint,
                  },
                ],
              },
            }),
            [200],
          )
        ).body.state,
      ).toBe("uncertain");
      expect(browserSelectWrites()).toHaveLength(writesBeforeDelayed + 2);
      expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
        { value: { kind: "radio", verifyOnly: true } },
        { value: 1 },
        { objectId: "native-scalar-object" },
        { value: { kind: "scalar", required: false, value: null } },
        { objectId: "radio-0" },
        { objectId: "radio-1" },
        { objectId: "radio-2" },
        { objectId: "radio-form" },
      ]);
    };
    await verifyMixedConstraintDrift();
  });

  it("selects by option index, rejects disabled and drifted options, and supports explicit clear", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Choose a region on the current browser page",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let mode: "select-one" | "select-multiple" = "select-one";
    let options = [
      {
        index: 0,
        label: "Choose",
        value: "",
        disabled: false,
        selected: false,
        empty: true,
      },
      {
        index: 1,
        label: "Unavailable",
        value: "same",
        disabled: true,
        selected: false,
        empty: false,
      },
      {
        index: 2,
        label: "First",
        value: "same",
        disabled: false,
        selected: true,
        empty: false,
      },
      {
        index: 3,
        label: "Second",
        value: "same",
        disabled: false,
        selected: false,
        empty: false,
      },
    ];
    let writeMatches = true;
    let includeScalar = false;
    let writable = true;
    mockNativeSelectTarget({
      writable: () => {
        return writable;
      },
      mode: () => {
        return mode;
      },
      options: () => {
        return options;
      },
      writeMatches: () => {
        return writeMatches;
      },
      includeScalar: () => {
        return includeScalar;
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
    const createSelect = async (required = false) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after region selection",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "region",
                label: "Region",
                fieldKind: "select",
                required,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const preflight = async (token: string) => {
      return await accept(
        userActionClient().preflight({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken: token },
          body: {},
        }),
        [200],
      );
    };
    const apply = async (
      token: string,
      indexes: readonly number[],
      fingerprint: string,
    ) => {
      return await userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: {
          values: [
            {
              key: "region",
              optionIndexes: [...indexes],
              optionSetFingerprint: fingerprint,
            },
          ],
        },
      });
    };
    const first = await createSelect();
    expect(first.body.action.fields[0]).toMatchObject({
      fieldKind: "select",
      control: { tagName: "SELECT", inputType: "select-one" },
    });
    const token = first.body.action.requestToken;
    const checked = await preflight(token);
    expect(checked.body.fields[0]?.control.options).toMatchObject(
      options.map((option) => {
        return {
          index: option.index,
          label: option.label,
          disabled: option.disabled,
          selected: option.selected,
          empty: option.empty,
        };
      }),
    );
    const fingerprint = checked.body.fields[0]?.control.optionSetFingerprint;
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    if (!fingerprint) {
      throw new Error("Missing option fingerprint");
    }
    expect(JSON.stringify(checked.body)).not.toContain("backendNodeId");
    expect(JSON.stringify(checked.body)).not.toContain('"same"');
    const disabled = await apply(token, [1], fingerprint);
    expect(disabled).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    expect(browserSelectWrites()).toHaveLength(0);
    options = options.map((option) => {
      return option.index === 3 ? { ...option, label: "Changed" } : option;
    });
    const drifted = await accept(apply(token, [3], fingerprint), [200]);
    expect(drifted.body.state).toBe("stale");
    expect(browserSelectWrites()).toHaveLength(0);

    const duplicate = await createSelect();
    const duplicateToken = duplicate.body.action.requestToken;
    const duplicateFingerprint = (await preflight(duplicateToken)).body
      .fields[0]?.control.optionSetFingerprint;
    if (!duplicateFingerprint) {
      throw new Error("Missing option fingerprint");
    }
    const chosen = await accept(
      apply(duplicateToken, [3], duplicateFingerprint),
      [200],
    );
    expect(chosen.body.state).toBe("succeeded");
    expect(JSON.stringify(chosen.body)).not.toContain('"same"');
    const write = browserSelectWrites().at(-1)?.[0];
    expect(write?.params.arguments).toMatchObject([
      { value: { kind: "select", mode: "select-one", indices: [3] } },
      { value: 0 },
    ]);
    expect(JSON.stringify(write?.params.arguments)).not.toContain(
      "native-select-object",
    );

    mode = "select-multiple";
    const multi = await createSelect();
    const multiToken = multi.body.action.requestToken;
    const multiFingerprint = (await preflight(multiToken)).body.fields[0]
      ?.control.optionSetFingerprint;
    if (!multiFingerprint) {
      throw new Error("Missing option fingerprint");
    }
    const chosenMulti = await accept(
      apply(multiToken, [2, 3], multiFingerprint),
      [200],
    );
    expect(chosenMulti.body.state).toBe("succeeded");
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { mode: "select-multiple", indices: [2, 3] } },
      { value: 0 },
    ]);
    const clear = await createSelect();
    const clearToken = clear.body.action.requestToken;
    const clearFingerprint = (await preflight(clearToken)).body.fields[0]
      ?.control.optionSetFingerprint;
    if (!clearFingerprint) {
      throw new Error("Missing option fingerprint");
    }
    expect(
      (await accept(apply(clearToken, [], clearFingerprint), [200])).body.state,
    ).toBe("succeeded");
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { indices: [] } },
      { value: 0 },
    ]);

    const required = await createSelect(true);
    const requiredToken = required.body.action.requestToken;
    const requiredFingerprint = (await preflight(requiredToken)).body.fields[0]
      ?.control.optionSetFingerprint;
    if (!requiredFingerprint) {
      throw new Error("Missing option fingerprint");
    }
    const requiredEmpty = await apply(requiredToken, [], requiredFingerprint);
    expect(requiredEmpty).toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" } },
    });
    const requiredPlaceholder = await apply(
      requiredToken,
      [0],
      requiredFingerprint,
    );
    expect(requiredPlaceholder).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    writeMatches = false;
    expect(
      (await accept(apply(requiredToken, [3], requiredFingerprint), [200])).body
        .state,
    ).toBe("uncertain");

    includeScalar = true;
    writeMatches = true;
    const verifyMixed = async () => {
      const createMixed = async () => {
        return await accept(
          userActionClient().create({
            headers: current.claim.browserHeaders,
            body: {
              kind: "input",
              callbackPrompt:
                "Continue after selecting a region and entering a note",
              pageTargetId: "native-input-target",
              fields: [
                {
                  key: "region",
                  label: "Region",
                  fieldKind: "select",
                  required: false,
                  backendNodeId: 45,
                },
                {
                  key: "note",
                  label: "Note",
                  fieldKind: "text",
                  required: true,
                  backendNodeId: 46,
                },
              ],
            },
          }),
          [201],
        );
      };
      const mixed = await createMixed();
      const mixedToken = mixed.body.action.requestToken;
      const mixedFingerprint =
        (await preflight(mixedToken)).body.fields[0]?.control
          .optionSetFingerprint ?? "";
      expect(mixedFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const appliedMixed = await accept(
        userActionClient().apply({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken: mixedToken },
          body: {
            values: [
              {
                key: "region",
                optionIndexes: [3],
                optionSetFingerprint: mixedFingerprint,
              },
              { key: "note", value: "A short note" },
            ],
          },
        }),
        [200],
      );
      expect(appliedMixed.body.state).toBe("succeeded");
      expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
        { value: { kind: "select", indices: [3] } },
        { value: 1 },
        { objectId: "native-scalar-object" },
        { value: { kind: "scalar", value: "A short note" } },
      ]);

      const untouchedMixed = await createMixed();
      const untouchedToken = untouchedMixed.body.action.requestToken;
      expect(
        (
          await accept(
            userActionClient().apply({
              headers: { authorization: "Bearer clerk-session" },
              params: { requestToken: untouchedToken },
              body: { values: [{ key: "note", value: "Only the note" }] },
            }),
            [200],
          )
        ).body.state,
      ).toBe("succeeded");
      expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
        { value: { kind: "select", indices: null } },
        { value: 1 },
        { objectId: "native-scalar-object" },
        { value: { kind: "scalar", value: "Only the note" } },
      ]);
    };
    await verifyMixed();

    // A control disabled by its containing fieldset is not writable, even
    // though its own `disabled` property remains false in the browser.
    const restricted = await createSelect();
    const priorWrites = browserSelectWrites().length;
    writable = false;
    const restrictedPreflight = await preflight(
      restricted.body.action.requestToken,
    );
    expect(restrictedPreflight.body.state).toBe("stale");
    expect(browserSelectWrites()).toHaveLength(priorWrites);
  });

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

  it("guards native slider position, constraints, required confirmation and post-event readback", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Choose a website slider position",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let value = "19";
    let min = "10";
    let max = "20";
    let step = "3";
    let writable = true;
    let readbackMatches = true;
    mockNativeNumberTarget({
      constraints: () => {
        return { min, max, step };
      },
      inputType: () => {
        return "range";
      },
      rangeValue: () => {
        return value;
      },
      writable: () => {
        return writable;
      },
      verificationMatches: () => {
        return readbackMatches;
      },
      validValue: (next) => {
        return (
          next === null ||
          next === "19" ||
          next === "16" ||
          next === "50" ||
          next === "51" ||
          next === "200"
        );
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
    const create = async (required = false) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after slider selection",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "level",
                label: "Level",
                fieldKind: "range",
                required,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const apply = async (
      token: string,
      values: readonly {
        key: string;
        observedValue: string;
        observedMin?: string;
        observedMax?: string;
        observedStep?: string;
        value: string;
      }[],
    ) => {
      return await userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [...values] },
      });
    };
    const choice = (next: string) => {
      return {
        key: "level",
        observedValue: "19",
        observedMin: "10",
        observedMax: "20",
        observedStep: "3",
        value: next,
      };
    };
    const untouched = await create();
    expect(untouched.body.action.fields[0]?.control).toMatchObject({
      inputType: "range",
    });
    expect(JSON.stringify(untouched.body)).not.toContain("rangeValue");
    const observed = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: untouched.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(observed.body.fields[0]?.control).toMatchObject({
      inputType: "range",
      rangeValue: "19",
      min: "10",
      max: "20",
      step: "3",
    });
    await expect(
      accept(apply(untouched.body.action.requestToken, []), [200]),
    ).resolves.toMatchObject({ body: { state: "succeeded" } });
    expect(browserSelectWrites()).toHaveLength(2);
    expect(browserSelectWrites()[0]?.[0].params.arguments).toMatchObject([
      {
        value: {
          kind: "scalar",
          inputType: "range",
          value: null,
          rangeValue: "19",
        },
      },
      { value: 0 },
    ]);
    expect(browserSelectWrites()[1]?.[0].params.arguments).toMatchObject([
      { value: { verifyOnly: true } },
      { value: 0 },
    ]);
    const required = await create(true);
    await expect(
      apply(required.body.action.requestToken, []),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" } },
    });
    await expect(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: required.body.action.requestToken },
        body: { values: [{ key: "level", value: "16" }] },
      }),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUES" } },
    });
    await expect(
      accept(apply(required.body.action.requestToken, [choice("19")]), [200]),
    ).resolves.toMatchObject({ body: { state: "succeeded" } });
    expect(browserSelectWrites().at(-2)?.[0].params.arguments).toMatchObject([
      {
        value: {
          kind: "scalar",
          inputType: "range",
          value: "19",
          rangeValue: "19",
          min: "10",
          max: "20",
          step: "3",
        },
      },
      { value: 0 },
    ]);
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { verifyOnly: true } },
      { value: 0 },
    ]);
    const invalid = await create();
    await expect(
      apply(invalid.body.action.requestToken, [choice("17")]),
    ).resolves.toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
    });
    await expect(
      accept(apply(invalid.body.action.requestToken, [choice("16")]), [200]),
    ).resolves.toMatchObject({ body: { state: "succeeded" } });
    const changed = await create();
    value = "16";
    expect(
      (
        await accept(
          apply(changed.body.action.requestToken, [choice("19")]),
          [200],
        )
      ).body.state,
    ).toBe("stale");
    value = "19";
    const constraintsChanged = await create();
    min = "11";
    expect(
      (
        await accept(
          apply(constraintsChanged.body.action.requestToken, [choice("19")]),
          [200],
        )
      ).body.state,
    ).toBe("stale");
    min = "10";
    const reverted = await create();
    readbackMatches = false;
    expect(
      (
        await accept(
          apply(reverted.body.action.requestToken, [choice("16")]),
          [200],
        )
      ).body.state,
    ).toBe("uncertain");
    readbackMatches = true;
    min = "";
    max = "";
    step = "";
    value = "50";
    const defaultBounds = await create(true);
    const defaultPreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: defaultBounds.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(defaultPreflight.body.fields[0]?.control).toMatchObject({
      inputType: "range",
      rangeValue: "50",
    });
    expect(defaultPreflight.body.fields[0]?.control).not.toHaveProperty("min");
    expect(defaultPreflight.body.fields[0]?.control).not.toHaveProperty("max");
    expect(defaultPreflight.body.fields[0]?.control).not.toHaveProperty("step");
    await expect(
      accept(
        apply(defaultBounds.body.action.requestToken, [
          { key: "level", observedValue: "50", value: "51" },
        ]),
        [200],
      ),
    ).resolves.toMatchObject({ body: { state: "succeeded" } });
    // Chromium treats min=200 and an absent max (default 100) as a valid
    // single-position slider at 200, rather than an invalid control.
    min = "200";
    value = "200";
    const singlePosition = await create(true);
    const singlePreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: singlePosition.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(singlePreflight.body.fields[0]?.control).toMatchObject({
      inputType: "range",
      rangeValue: "200",
      min: "200",
    });
    await expect(
      accept(
        apply(singlePosition.body.action.requestToken, [
          {
            key: "level",
            observedValue: "200",
            observedMin: "200",
            value: "200",
          },
        ]),
        [200],
      ),
    ).resolves.toMatchObject({ body: { state: "succeeded" } });
    writable = false;
    const disabled = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after slider selection",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "level",
            label: "Level",
            fieldKind: "range",
            required: false,
            backendNodeId: 45,
          },
        ],
      },
    });
    expect(disabled.status).toBe(409);
  });

  it("guards native opaque color selection, unchanged values, stale targets and independent readback", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Choose a website color",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let color = "#123abc";
    let writable = true;
    let readbackMatches = true;
    mockNativeNumberTarget({
      constraints: () => {
        return { min: "", max: "", step: "" };
      },
      inputType: () => {
        return "color";
      },
      colorValue: () => {
        return color;
      },
      writable: () => {
        return writable;
      },
      verificationMatches: () => {
        return readbackMatches;
      },
      validValue: (value) => {
        return value === null || value === "#123abc" || value === "#00ff00";
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
    const create = (required = false) => {
      return accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after choosing a color",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "swatch",
                label: "Swatch",
                fieldKind: "color",
                required,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const apply = (
      token: string,
      values: readonly { key: string; observedColor: string; value: string }[],
    ) => {
      return userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [...values] },
      });
    };
    const choice = (value: string) => {
      return {
        key: "swatch",
        observedColor: "#123abc",
        value,
      };
    };
    const untouched = await create();
    expect(untouched.body.action.fields[0]?.control).toMatchObject({
      inputType: "color",
    });
    expect(JSON.stringify(untouched.body)).not.toContain("#123abc");
    const preflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: untouched.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(preflight.body.fields[0]?.control).toMatchObject({
      inputType: "color",
      colorValue: "#123abc",
      colorMode: "opaque-srgb",
    });
    expect(
      (await accept(apply(untouched.body.action.requestToken, []), [200])).body
        .state,
    ).toBe("succeeded");
    expect(browserSelectWrites().at(-2)?.[0].params.arguments).toMatchObject([
      {
        value: {
          kind: "scalar",
          inputType: "color",
          colorValue: "#123abc",
          colorMode: "opaque-srgb",
          value: null,
        },
      },
      { value: 0 },
    ]);
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { verifyOnly: true } },
      { value: 0 },
    ]);
    const required = await create(true);
    expect((await apply(required.body.action.requestToken, [])).status).toBe(
      400,
    );
    expect(
      (
        await userActionClient().apply({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken: required.body.action.requestToken },
          body: { values: [{ key: "swatch", value: "#00ff00" }] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await accept(
          apply(required.body.action.requestToken, [choice("#123abc")]),
          [200],
        )
      ).body.state,
    ).toBe("succeeded");
    expect(browserSelectWrites().at(-2)?.[0].params.arguments).toMatchObject([
      {
        value: { inputType: "color", colorValue: "#123abc", value: "#123abc" },
      },
      { value: 0 },
    ]);
    const invalid = await create();
    expect(
      (await apply(invalid.body.action.requestToken, [choice("#ff0000")]))
        .status,
    ).toBe(409);
    expect(
      (
        await accept(
          apply(invalid.body.action.requestToken, [choice("#00ff00")]),
          [200],
        )
      ).body.state,
    ).toBe("succeeded");
    const attributed = await create();
    writable = false; // A newly added alpha/colorspace attribute makes inspection unwritable.
    expect(
      (
        await accept(
          apply(attributed.body.action.requestToken, [choice("#00ff00")]),
          [200],
        )
      ).body.state,
    ).toBe("stale");
    writable = true;
    color = "#00ff00";
    const drift = await create();
    expect(
      (
        await accept(
          apply(drift.body.action.requestToken, [choice("#123abc")]),
          [200],
        )
      ).body.state,
    ).toBe("stale");
    color = "#123abc";
    const rollback = await create();
    readbackMatches = false;
    expect(
      (
        await accept(
          apply(rollback.body.action.requestToken, [choice("#00ff00")]),
          [200],
        )
      ).body.state,
    ).toBe("uncertain");
    readbackMatches = true;
    writable = false; // Also models unsupported alpha/colorspace modes: inspected as non-writable.
    expect(
      (
        await userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after choosing a color",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "swatch",
                label: "Swatch",
                fieldKind: "color",
                required: false,
                backendNodeId: 45,
              },
            ],
          },
        })
      ).status,
    ).toBe(409);
  });

  it("validates all five native date/time subtypes, empty/required values and independent readback", async () => {
    const { routeMocks, runs, chat, actor, agent } =
      await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Enter a date or time in the current browser",
    );
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    let inputType = "date";
    let min = "";
    let max = "";
    let step = "any";
    let siteRequired = false;
    let verificationMatches = true;
    let canonical = "2026-09-25";
    mockNativeNumberTarget({
      constraints: () => {
        return { min, max, step };
      },
      verificationMatches: () => {
        return verificationMatches;
      },
      inputType: () => {
        return inputType;
      },
      siteRequired: () => {
        return siteRequired;
      },
      validValue: (value) => {
        return (
          value === null ||
          value === canonical ||
          (value === "" && !siteRequired)
        );
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
    const create = async (required = false) => {
      return await accept(
        userActionClient().create({
          headers: current.claim.browserHeaders,
          body: {
            kind: "input",
            callbackPrompt: "Continue after date entry",
            pageTargetId: "native-input-target",
            fields: [
              {
                key: "arrival",
                label: "Arrival",
                fieldKind: "date_time",
                required,
                backendNodeId: 45,
              },
            ],
          },
        }),
        [201],
      );
    };
    const apply = async (
      token: string,
      values: readonly { key: string; value: string }[],
    ) => {
      return await userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: token },
        body: { values: [...values] },
      });
    };
    for (const [subtype, expected] of [
      ["date", "2026-09-25"],
      ["time", "09:30"],
      ["datetime-local", "2026-09-25T09:30"],
      ["month", "2026-09"],
      ["week", "2026-W39"],
    ] as const) {
      inputType = subtype;
      canonical = expected;
      min = subtype === "date" ? "2026-01-01" : "";
      max = subtype === "date" ? "2026-12-31" : "";
      step = subtype === "time" ? "60" : "any";
      const created = await create();
      const token = created.body.action.requestToken;
      expect(created.body.action.fields[0]?.control).toMatchObject({
        tagName: "INPUT",
        inputType: subtype,
      });
      const observed = await accept(
        userActionClient().preflight({
          headers: { authorization: "Bearer clerk-session" },
          params: { requestToken: token },
          body: {},
        }),
        [200],
      );
      expect(observed.body.fields[0]?.control).toMatchObject({
        inputType: subtype,
        ...(min ? { min } : {}),
        ...(max ? { max } : {}),
        step,
      });
      expect(JSON.stringify(observed.body)).not.toContain("backendNodeId");
      const invalid = await apply(token, [
        { key: "arrival", value: "not-a-date" },
      ]);
      expect(invalid).toMatchObject({
        status: 409,
        body: { error: { code: "BROWSER_USER_ACTION_INVALID_VALUE" } },
      });
      const written = await accept(
        apply(token, [{ key: "arrival", value: expected }]),
        [200],
      );
      expect(written.body.state).toBe("succeeded");
      expect(browserSelectWrites().at(-2)?.[0].params.arguments).toMatchObject([
        {
          value: {
            kind: "scalar",
            inputType: subtype,
            value: expected,
            ...(min ? { min } : {}),
            ...(max ? { max } : {}),
            step,
          },
        },
        { value: 0 },
      ]);
      expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
        { value: { verifyOnly: true } },
        { value: 0 },
      ]);
    }
    inputType = "date";
    canonical = "2026-09-25";
    siteRequired = false;
    const untouched = await create();
    const beforeUntouched = browserSelectWrites().length;
    expect(
      (await accept(apply(untouched.body.action.requestToken, []), [200])).body
        .state,
    ).toBe("succeeded");
    expect(browserSelectWrites()).toHaveLength(beforeUntouched);
    const clearing = await create();
    expect(
      (
        await accept(
          apply(clearing.body.action.requestToken, [
            { key: "arrival", value: "" },
          ]),
          [200],
        )
      ).body.state,
    ).toBe("succeeded");
    expect(browserSelectWrites().at(-1)?.[0].params.arguments).toMatchObject([
      { value: { value: "", verifyOnly: true } },
      { value: 0 },
    ]);
    const required = await create(true);
    await expect(
      apply(required.body.action.requestToken, [{ key: "arrival", value: "" }]),
    ).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "BROWSER_USER_ACTION_REQUIRED_VALUE_MISSING" } },
    });
    const drifted = await create();
    inputType = "month";
    expect(
      (
        await accept(
          apply(drifted.body.action.requestToken, [
            { key: "arrival", value: "2026-09" },
          ]),
          [200],
        )
      ).body.state,
    ).toBe("stale");
    inputType = "date";
    const reverted = await create();
    verificationMatches = false;
    expect(
      (
        await accept(
          apply(reverted.body.action.requestToken, [
            { key: "arrival", value: canonical },
          ]),
          [200],
        )
      ).body.state,
    ).toBe("uncertain");
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
    let controlMainDocument = true;
    let controlConnected = true;
    let controlTagName = "INPUT";
    let controlSiteRequired = false;
    const controlMinLength = 3;
    let disconnectAfterNextWrite = false;
    let resolveNodeAvailable = true;
    let missingBackendNodeId: number | null = null;
    let nodeResolutionFailure: string | null = null;
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
        return browserValidationNodeResult({
          backendNodeId: command.params.backendNodeId,
          available: resolveNodeAvailable,
          missingBackendNodeId,
          malformed: malformedNodeResponse,
          failure: nodeResolutionFailure,
        });
      }
      if (command.method === "Runtime.callFunctionOn") {
        const declaration =
          typeof command.params.functionDeclaration === "string"
            ? command.params.functionDeclaration
            : "";
        if (
          !controlMainDocument &&
          declaration.includes("supportedInputTypes")
        ) {
          return {
            result: {
              value: inspectShadowTextControl(
                declaration,
                command.params.objectId === "native-code-object"
                  ? "tel"
                  : "password",
              ),
            },
          };
        }
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
                mainDocument: controlMainDocument,
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
      body: {
        error: {
          code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL",
          message:
            "--field 1: the selected Browser control is not a writable top-level input, textarea, or select",
        },
      },
    });
    controlWritable = true;
    controlMainDocument = false;
    const unsupportedRoot = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after unsupported root",
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
    expect(unsupportedRoot).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL" } },
    });
    controlMainDocument = true;
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
      body: {
        error: {
          code: "BROWSER_USER_ACTION_UNSUPPORTED_CONTROL",
          message:
            "--field 1: fieldKind 'password' does not match the observed input type 'email'; use text or username",
        },
      },
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
      body: {
        error: {
          code: "BROWSER_USER_ACTION_BACKEND_NODE_NOT_FOUND",
          message:
            "--field 1: the selected Browser control no longer exists; inspect the page and recapture it",
        },
      },
    });
    expect(JSON.stringify(missingBackendNode.body)).not.toContain(
      "https://example.com/login",
    );
    resolveNodeAvailable = true;
    context.mocks.browserUseCdp.connect.mockClear();
    context.mocks.browserUseCdp.command.mockClear();
    providerReadCount = 0;

    missingBackendNodeId = 42;
    const secondFieldMissing = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after input",
        pageTargetId: "native-input-target",
        fields: [
          {
            key: "username",
            label: "Email",
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
    });
    expect(secondFieldMissing).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "BROWSER_USER_ACTION_BACKEND_NODE_NOT_FOUND",
          message:
            "--field 2: the selected Browser control no longer exists; inspect the page and recapture it",
        },
      },
    });
    missingBackendNodeId = null;

    const nodeInspectionRequest = {
      headers: current.claim.browserHeaders,
      body: {
        kind: "input" as const,
        callbackPrompt: "Continue after input",
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
      },
    };
    nodeResolutionFailure = "Target session closed";
    const failedNodeInspection = await userActionClient().create(
      nodeInspectionRequest,
    );
    expect(failedNodeInspection).toMatchObject({
      status: 502,
      body: {
        error: {
          code: "BROWSER_USER_ACTION_PROVIDER_ERROR",
          message: "Managed Browser operation failed",
        },
      },
    });
    expect(JSON.stringify(failedNodeInspection.body)).not.toContain(
      "Target session closed",
    );
    nodeResolutionFailure = null;

    malformedNodeResponse = true;
    const malformedNodeInspection = await userActionClient().create(
      nodeInspectionRequest,
    );
    expect(malformedNodeInspection).toMatchObject({
      status: 502,
      body: { error: { code: "BROWSER_USER_ACTION_PROVIDER_ERROR" } },
    });
    malformedNodeResponse = false;

    const missingPage = await userActionClient().create({
      headers: current.claim.browserHeaders,
      body: {
        kind: "input",
        callbackPrompt: "Continue after input",
        pageTargetId: "missing-target",
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
    expect(missingPage).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "BROWSER_USER_ACTION_PAGE_TARGET_NOT_FOUND",
          message:
            "The selected Browser page no longer exists; inspect the active tab and recapture the controls",
        },
      },
    });
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

    const shadowCandidate = await accept(
      userActionClient().create({
        headers: current.claim.browserHeaders,
        body: {
          kind: "input",
          callbackPrompt: "Continue after control leaves the document root",
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
    controlMainDocument = false;
    const shadowPreflight = await accept(
      userActionClient().preflight({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: shadowCandidate.body.action.requestToken },
        body: {},
      }),
      [200],
    );
    expect(shadowPreflight.body.state).toBe("stale");
    expect(browserInputWrites()).toHaveLength(writesBeforeStale);
    controlMainDocument = true;

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
    // Hold a claimed apply at its provider read, then let the app clock pass
    // the stuck-apply deadline so the public read performs recovery.
    const stuckEntered = createDeferredPromise<void>(context.signal);
    const stuckRelease = createDeferredPromise<void>(context.signal);
    providerReadBarrier = { entered: stuckEntered, release: stuckRelease };
    const stalledApply = userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: stuckCandidate.body.action.requestToken },
      body: { values: [{ key: "code", value: "001234" }] },
    });
    await stuckEntered.promise;
    mockNow(STARTED_AT_MS + MINUTE_MS + 1);
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
    providerStopped = true;
    stuckRelease.resolve(undefined);
    const stalled = await stalledApply;
    providerStopped = false;
    expect(stalled).toMatchObject({
      status: 502,
      body: { error: { code: "BROWSER_USER_ACTION_PROVIDER_ERROR" } },
    });
    await expect(
      userActionClient().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: stuckCandidate.body.action.requestToken },
      }),
    ).resolves.toMatchObject({ status: 200, body: { state: "uncertain" } });
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
    let providerStopped = false;
    let providerReadBarrier:
      | {
          readonly entered: ReturnType<typeof createDeferredPromise<void>>;
          readonly release: ReturnType<typeof createDeferredPromise<void>>;
        }
      | undefined;
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
      http.get(`${BROWSER_USE_API_URL}/browsers/:id`, async () => {
        const barrier = providerReadBarrier;
        if (barrier) {
          providerReadBarrier = undefined;
          barrier.entered.resolve(undefined);
          await barrier.release.promise;
        }
        return HttpResponse.json(
          providerBrowser(providerId, {
            status: providerStopped ? "stopped" : "active",
          }),
        );
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
    // Hold one claimed apply at its provider read so it is still applying
    // when the Browser closes.
    const applyingEntered = createDeferredPromise<void>(context.signal);
    const applyingRelease = createDeferredPromise<void>(context.signal);
    providerReadBarrier = {
      entered: applyingEntered,
      release: applyingRelease,
    };
    const heldApply = userActionClient().apply({
      headers: { authorization: "Bearer clerk-session" },
      params: { requestToken: applying.body.action.requestToken },
      body: { values: [{ key: "password", value: "secret" }] },
    });
    await applyingEntered.promise;

    // The provider reports the Browser stopped; the public reconciler records
    // the closure at the app clock while apply and cancel race it.
    const finishedAt = new Date(STARTED_AT_MS + MINUTE_MS);
    mockNow(finishedAt.getTime());
    providerStopped = true;
    const [closure, applyRace, cancelRace] = await Promise.all([
      reconcileBrowsers(current.threadId),
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
    expect(closure.body).toMatchObject({ errors: 0 });
    expect([200, 409, 410, 502]).toContain(applyRace.status);
    expect([200, 409, 410]).toContain(cancelRace.status);
    expect(
      [applyRace, cancelRace].filter((response) => {
        return response.status === 200;
      }),
    ).toHaveLength(
      applyRace.status === 200 || cancelRace.status === 200 ? 1 : 0,
    );
    applyingRelease.resolve(undefined);
    await expect(heldApply).resolves.toMatchObject({
      status: 502,
      body: { error: { code: "BROWSER_USER_ACTION_PROVIDER_ERROR" } },
    });
    await expect(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { browser: { status: "suspended", suspensionReason: "provider" } },
    });

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
      /^(cancelled|stale|uncertain)$/u,
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
    let providerStopped = false;
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
        return HttpResponse.json(
          providerBrowser(providerId, {
            status: providerStopped ? "stopped" : "active",
          }),
        );
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
    const finishedAt = new Date(STARTED_AT_MS + MINUTE_MS);
    const laterCompletedAt = new Date(finishedAt.getTime() + MINUTE_MS);
    // The later terminal action commits its completion after the Browser's
    // finish boundary; the app clock records that order through public routes.
    mockNow(laterCompletedAt.getTime());
    await accept(
      userActionClient().apply({
        headers: { authorization: "Bearer clerk-session" },
        params: { requestToken: laterTerminal.body.action.requestToken },
        body: { values: [{ key: "password", value: "secret" }] },
      }),
      [200],
    );

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
    // The provider reports the Browser stopped, so the public reconciler
    // records its finish at the app clock and converts the first batch.
    mockNow(finishedAt.getTime());
    providerStopped = true;
    await reconcileBrowsers(current.threadId);
    await expect(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { browser: { status: "suspended" } },
    });
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
  eventsBeforeReply?: NonNullable<Parameters<typeof browserUseCdpHandler>[1]>,
  withholdReply?: NonNullable<Parameters<typeof browserUseCdpHandler>[2]>,
  afterReply?: NonNullable<Parameters<typeof browserUseCdpHandler>[3]>,
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
      browserUseCdpHandler(
        webSocketUrl,
        eventsBeforeReply,
        withholdReply,
        afterReply,
      ),
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
      preferred: true,
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
  const sent = await chat.sendAndLaunch(actor, {
    agentId,
    prompt,
    cloudBrowserEnabled: true,
  });
  return {
    runId: sent.runId,
    threadId: sent.threadId,
    claim: await claimChatRun(runs, actor, sent.runId),
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
  it.each([true, false])(
    "applies the saved cloud browser preference (%s) to a new chat and its run permissions",
    async (enabled) => {
      const { runs, chat, actor, agent } = await setupBrowserScenario();
      await createMiscRoutesApi(context).updatePreferences(
        actor,
        { cloudBrowserEnabledByDefault: enabled },
        [200],
      );
      const sent = await chat.sendAndLaunch(actor, {
        agentId: agent.agentId,
        prompt: "Use my saved browser preference",
      });
      await expect(
        chat.readThreadMetadata(actor, sent.threadId),
      ).resolves.toMatchObject({ cloudBrowserEnabled: enabled });
      await flushWaitUntilForTest();
      const claim = await runs.claimRunnerJob(sent.runId);
      const browser = await accept(
        client().get({
          headers: {
            authorization: `Bearer ${claim.platformEnvironment.OKOU_TOKEN}`,
          },
          params: { threadId: sent.threadId },
        }),
        [403, 404],
      );
      // An authorized run reaches the empty browser lookup; a disabled run
      // has no browser capability and is rejected before that lookup.
      expect(browser.status).toBe(enabled ? 404 : 403);
      expect(browser.body.error.code).toBe(
        enabled ? "BROWSER_NOT_FOUND" : "FORBIDDEN",
      );
    },
  );

  it.each([
    "cloud browser",
    "disabled",
    "no computer",
    "computer use",
  ] as const)(
    "honors an explicit %s selection over saved Chat preferences",
    async (selection) => {
      const { runs, chat, actor, agent } = await setupBrowserScenario();
      await createMiscRoutesApi(context).updatePreferences(
        actor,
        { cloudBrowserEnabledByDefault: selection !== "cloud browser" },
        [200],
      );
      const host =
        selection === "computer use"
          ? await computerUse.startComputerUseHost(actor)
          : null;
      const sent = await chat.sendAndLaunch(actor, {
        agentId: agent.agentId,
        prompt: "Use this chat's explicit computer selection",
        ...(selection === "disabled" || selection === "cloud browser"
          ? { cloudBrowserEnabled: selection === "cloud browser" }
          : { computerUseHostId: host?.hostId ?? null }),
      });
      await expect(
        chat.readThreadMetadata(actor, sent.threadId),
      ).resolves.toMatchObject({
        cloudBrowserEnabled: selection === "cloud browser",
        computerUseHostId: host?.hostId ?? null,
      });
      await runs.requestCancelRun(actor, sent.runId, [200]);
    },
  );

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

  it("keeps managed browser access off when the user explicitly disables it", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const sent = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Try to open a managed browser without enabling it",
      cloudBrowserEnabled: false,
    });
    await flushWaitUntilForTest();
    const claim = await runs.claimRunnerJob(sent.runId);
    expect(claim.appendSystemPrompt ?? "").toContain(
      "Okou Browser is currently off for this chat thread",
    );
    expect(claim.appendSystemPrompt ?? "").not.toContain(
      "Browser user input priority:",
    );
    expect(claim.appendSystemPrompt ?? "").not.toContain(
      "okou browser input-request",
    );
    expect(claim.appendSystemPrompt ?? "").not.toContain(
      "Browser tab continuity:",
    );
    const browserToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.runId,
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

  it("omits native input guidance when the switch is disabled", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Open a managed browser",
      cloudBrowserEnabled: true,
    });

    await flushWaitUntilForTest();
    const claim = await runs.claimRunnerJob(sent.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).toContain(
      "Okou Cloud Browser and Okou Computer Use are separate surfaces. `okou browser use` creates, reuses, or resumes a remote browser",
    );
    expect(appendSystemPrompt).toContain(
      "Okou Browser lifetime: `okou browser use` and `okou browser lease` each extend the session's idle lease by a fixed 10 minutes",
    );
    expect(appendSystemPrompt).not.toContain("okou browser input-request");
    expect(appendSystemPrompt).toContain(
      "Browser tab continuity: When resuming a page after `okou browser use`",
    );
    expect(appendSystemPrompt).toContain("`okou browser tab list`");
    expect(appendSystemPrompt).toContain(
      "Keep the selected tab only if non-sensitive page evidence confirms it",
    );
    expect(appendSystemPrompt).toContain(
      "Origin or selection alone is not proof, even with one match",
    );
    expect(appendSystemPrompt).not.toContain("a local binding may restore");
    expect(appendSystemPrompt).toContain(
      "Never invoke raw `agent-browser tab list` or `agent-browser tab <id>` (including `--json`)",
    );
    expect(appendSystemPrompt).not.toContain("Browser input completion:");
    expect(appendSystemPrompt).toContain(
      "Direct Browser takeover is a last resort, not the default for login",
    );
    expect(appendSystemPrompt).not.toContain("Browser user input priority:");
    expect(appendSystemPrompt).not.toContain(
      "Okou Browser is currently off for this chat thread",
    );
  });

  it("prioritizes native input when both browser and native input are enabled", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.BrowserNativeInput]: true,
    });
    const sent = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Sign in to a website",
      cloudBrowserEnabled: true,
    });

    await flushWaitUntilForTest();
    const claim = await runs.claimRunnerJob(sent.runId);
    const appendSystemPrompt = claim.appendSystemPrompt ?? "";
    expect(appendSystemPrompt).toContain(
      "prefer `okou browser input-request` over direct Browser takeover",
    );
    expect(appendSystemPrompt).toContain(
      "especially login username, password, or one-time code",
    );
    expect(appendSystemPrompt).toContain(
      "After it succeeds, return its exact action URL and use no further Browser commands in this turn",
    );
    expect(appendSystemPrompt).toContain("`okou browser tab select <id>`");
    expect(appendSystemPrompt).toContain(
      "Never invoke raw `agent-browser tab list` or `agent-browser tab <id>` (including `--json`)",
    );
    expect(appendSystemPrompt).toContain(
      "If safe commands are unavailable or the page remains unclear, stop",
    );
    expect(appendSystemPrompt).toContain(
      "On a successful callback, run `okou browser use` and follow the tab-continuity check to confirm the existing intended page",
    );
    expect(appendSystemPrompt).toContain("submit at most once");
    expect(appendSystemPrompt).toContain(
      "If a target is stale, inspect and recapture it once where safe; never blindly replay an uncertain write",
    );
    expect(appendSystemPrompt).toContain(
      "Direct Browser takeover is a last resort, not the default for login",
    );
    expect(appendSystemPrompt).toContain(
      "If the user explicitly asks to view the Browser, you may share its live view without treating that request as a takeover",
    );
  });

  it("disables cloud browser when a computer host is selected", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const sent = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Open a managed browser before selecting this computer",
      cloudBrowserEnabled: true,
    });
    const host = await computerUse.startComputerUseHost(actor);

    await accept(
      chatThreadComputerUseHostClient().update({
        headers: { authorization: "Bearer clerk-session" },
        params: { id: sent.threadId },
        body: { computerUseHostId: host.hostId },
      }),
      [204],
    );

    const browserToken = runs.okouTokenForRunWithCapabilities(
      actor,
      sent.runId,
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
    const sent = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      prompt: "Ask the user to enable a cloud browser",
      cloudBrowserEnabled: false,
    });
    const sandboxRunToken = runs.sandboxTokenForRun(actor, sent.runId);
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
      sent.runId,
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
        chatThreadId: sent.threadId,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
      }),
    );
  });

  it("attaches concurrent requests to the same thread browser", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open this browser from concurrent requests",
    );
    server.use(
      http.post(`${BROWSER_USE_API_URL}/profiles`, async ({ request }) => {
        const body = z
          .strictObject({ name: z.string() })
          .parse(await request.json());
        return HttpResponse.json(providerProfile(randomUUID(), body.name), {
          status: 201,
        });
      }),
      http.delete(`${BROWSER_USE_API_URL}/profiles/:id`, () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
        const providerId = randomUUID();
        acceptBrowserUseCdpSessions([providerId]);
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
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

    const results = await Promise.all(
      Array.from({ length: 3 }, () => {
        return client().use({
          headers: current.claim.browserHeaders,
          body: {},
        });
      }),
    );
    expect(
      results.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    const attached = await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    expect(attached.body.browser).toMatchObject({
      threadId: current.threadId,
      status: "active",
    });
    for (const result of results) {
      expect([200, 409]).toContain(result.status);
      if (result.status === 200) {
        expect(result.body.browser).toMatchObject({
          threadId: current.threadId,
          status: "active",
        });
        expect(result.body.cdpUrl).toBe(attached.body.cdpUrl);
      }
    }

    mockNow(STARTED_AT_MS + 11 * MINUTE_MS);
    await reconcileBrowsers(current.threadId);
    const suspended = await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [200],
    );
    expect(suspended.body.browser.status).toBe("suspended");

    const resumed = await Promise.all(
      Array.from({ length: 3 }, () => {
        return client().use({
          headers: current.claim.browserHeaders,
          body: {},
        });
      }),
    );
    const active = await accept(
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      [200],
    );
    expect(active.body.browser).toMatchObject({
      threadId: current.threadId,
      status: "active",
    });
    expect(active.body.cdpUrl).not.toBe(attached.body.cdpUrl);
    expect(
      resumed.some((result) => {
        return result.status === 200;
      }),
    ).toBeTruthy();
    for (const result of resumed) {
      expect([200, 409]).toContain(result.status);
      if (result.status === 200) {
        expect(result.body.cdpUrl).toBe(active.body.cdpUrl);
      }
    }

    await chat.deleteThread(actor, current.threadId);
    await flushWaitUntilForTest();
  });

  it("rejects and stops a provider that finishes starting after its thread is deleted", async () => {
    const { runs, chat, actor, agent } = await setupBrowserScenario();
    const current = await createClaimedChatRun(
      chat,
      runs,
      actor,
      agent.agentId,
      "Open a browser while its provider is still starting",
    );
    const providerId = randomUUID();
    acceptBrowserUseCdpSessions([providerId]);
    const createStarted = createDeferredPromise<void>(context.signal);
    const finishCreate = createDeferredPromise<void>(context.signal);
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
      http.post(`${BROWSER_USE_API_URL}/browsers`, async () => {
        createStarted.resolve(undefined);
        await finishCreate.promise;
        return HttpResponse.json(providerBrowser(providerId), { status: 201 });
      }),
      http.patch(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
        const stoppedId = String(params.id);
        stoppedProviderIds.push(stoppedId);
        return HttpResponse.json(
          providerBrowser(stoppedId, { status: "stopped" }),
        );
      }),
    );

    const [started] = await Promise.all([
      client().use({ headers: current.claim.browserHeaders, body: {} }),
      (async () => {
        const deleted = await settleIncludingAbort(
          (async () => {
            await createStarted.promise;
            await chat.deleteThread(actor, current.threadId);
          })(),
        );
        finishCreate.resolve(undefined);
        if (!deleted.ok) {
          throw deleted.error;
        }
      })(),
    ]);
    expect(started).toMatchObject({
      status: 409,
      body: { error: { code: "BROWSER_RUN_ENDED" } },
    });
    await flushWaitUntilForTest();
    expect(stoppedProviderIds).toStrictEqual([providerId]);

    await accept(
      client().get({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: current.threadId },
      }),
      [404],
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

    // The missing-thread reconciler remains the durable provider teardown
    // path after the thread is gone.
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

  it.each([
    { caseName: "provider rejects resize", abortAfterReply: false },
    { caseName: "deadline aborts after resize reply", abortAfterReply: true },
  ])(
    "can retry browser start after its initial size cannot be applied: $caseName",
    async ({ abortAfterReply }) => {
      const { runs, chat, actor, agent } = await setupBrowserScenario();
      const first = await createClaimedChatRun(
        chat,
        runs,
        actor,
        agent.agentId,
        "Open a managed browser whose window cannot be resized",
      );
      const providerId = randomUUID();
      const deadline = new AbortController();
      if (abortAfterReply) {
        context.mocks.abortSignal.timeout.mockImplementation((milliseconds) => {
          return milliseconds === 15_000 ? deadline.signal : undefined;
        });
      }
      acceptBrowserUseCdpSessions(
        [providerId],
        undefined,
        undefined,
        abortAfterReply
          ? (command) => {
              if (command.method === "Browser.setContentsSize") {
                // MSW queues the reply dispatch first. Abort after its listener
                // settles, before the command's awaiting continuation resumes.
                queueMicrotask(() => {
                  deadline.abort(
                    new DOMException("CDP deadline", "TimeoutError"),
                  );
                });
              }
            }
          : undefined,
      );
      context.mocks.browserUseCdp.command.mockImplementation((command) => {
        return !abortAfterReply && command.method === "Browser.setContentsSize"
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
          return HttpResponse.json(providerBrowser(providerId), {
            status: 201,
          });
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

      const retryProviderId = randomUUID();
      acceptBrowserUseCdpSessions([retryProviderId]);
      context.mocks.abortSignal.timeout.mockImplementation(() => {
        return undefined;
      });
      context.mocks.browserUseCdp.command.mockImplementation(() => {
        return undefined;
      });
      server.use(
        http.post(`${BROWSER_USE_API_URL}/browsers`, () => {
          return HttpResponse.json(providerBrowser(retryProviderId), {
            status: 201,
          });
        }),
        http.get(`${BROWSER_USE_API_URL}/browsers/:id`, ({ params }) => {
          return HttpResponse.json(providerBrowser(String(params.id)));
        }),
      );
      const retried = await accept(
        client().use({ headers: first.claim.browserHeaders, body: {} }),
        [200],
      );
      expect(retried.body.browser).toMatchObject({
        threadId: first.threadId,
        status: "active",
        screen: { width: 1440, height: 900, resizable: true },
      });
      expect(retried.body.cdpUrl).toBe(
        `https://${retryProviderId}.cdp.browser-use.com/`,
      );

      await chat.deleteThread(actor, first.threadId);
      await flushWaitUntilForTest();
      expect(providerStops).toBe(2);
    },
    120_000,
  );

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
    // the runner claim. A chat send at the org's run limit waits without a
    // run, so the limit is lifted by one only while the candidate run starts;
    // browser admission then meets the original limit.
    async function createCandidate(prompt: string) {
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "3");
      const sentCandidate = await chat.sendAndLaunch(actor, {
        agentId: agent.agentId,
        prompt,
        cloudBrowserEnabled: true,
      });
      mockEnv("CONCURRENT_RUN_LIMIT_CAP", "2");
      return {
        threadId: sentCandidate.threadId,
        browserHeaders: {
          authorization: `Bearer ${runs.okouTokenForRunWithCapabilities(
            actor,
            sentCandidate.runId,
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

    // Each deletion frees a run slot and can pick another fixture thread.
    // Settle that route-owned work before deleting the next one.
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
    const followup = await chat.sendAndLaunch(actor, {
      agentId: agent.agentId,
      threadId: first.threadId,
      prompt: "Continue in the same browser",
    });
    const followupRunId = followup.runId;
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
    const resumed = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId },
        body: {},
      }),
      [200],
    );
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
      body: JSON.stringify({}),
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
        body: {},
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
        body: {},
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

  it("keeps viewer actions separate from managed-browser reclamation", async () => {
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
    await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: {},
      }),
      [200],
    );

    const firstStart = await accept(
      client().use({ headers: first.claim.browserHeaders, body: {} }),
      [200],
    );

    await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: {},
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
    expect(providerCreates).toBe(2);

    const alreadyActive = await accept(
      client().open({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: {},
      }),
      [200],
    );
    expect(alreadyActive.body).toMatchObject({
      browser: { threadId: first.threadId, status: "active" },
    });

    const closed = await accept(
      client().close({
        headers: { authorization: "Bearer clerk-session" },
        params: { threadId: first.threadId },
        body: {},
      }),
      [200],
    );
    expect(closed.body).toStrictEqual({});
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

    await chat.deleteThread(actor, first.threadId);
    await flushWaitUntilForTest();
    expect(providerStops).toBe(2);
  }, 120_000);
});
