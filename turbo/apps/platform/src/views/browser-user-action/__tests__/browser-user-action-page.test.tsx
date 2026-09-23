import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  browserUserActionsContract,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const REQUEST_TOKEN = `vm0_browser_user_action_${"b".repeat(43)}`;
const AGENT_ID = "c0000000-0000-4000-a000-000000001201";
const THREAD_ID = "b0000000-0000-4000-a000-000000001202";
const CALLBACK_PROMPT = "Continue after standalone browser input";
const SUCCESS_CLIENT_ID = "10000000-0000-4000-a000-000000001203";
const SUCCESS_SORT_ID = "10000000-0000-4000-a000-000000001204";
const CANCEL_CLIENT_ID = "10000000-0000-4000-a000-000000001205";
const CANCEL_SORT_ID = "10000000-0000-4000-a000-000000001206";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000001207";

function action(
  state: BrowserUserActionResponse["state"],
): Extract<BrowserUserActionResponse, { kind: "input" }> {
  return {
    kind: "input",
    requestToken: REQUEST_TOKEN,
    state,
    completedAt: state === "pending" ? null : "2026-09-22T05:00:00.000Z",
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    siteOrigin: "https://login.example.test",
    fields: [
      {
        key: "email",
        label: "Email",
        fieldKind: "username",
        required: true,
      },
      {
        key: "remembered",
        label: "Remembered answer",
        fieldKind: "text",
        required: false,
      },
    ],
    callbackIds: {
      success: {
        clientEventId: SUCCESS_CLIENT_ID,
        chatThreadSortEventId: SUCCESS_SORT_ID,
      },
      cancellation: {
        clientEventId: CANCEL_CLIENT_ID,
        chatThreadSortEventId: CANCEL_SORT_ID,
      },
    },
  };
}

function mockPendingPreflight() {
  context.mocks.api(
    browserUserActionsContract.preflight,
    ({ params, body, respond }) => {
      expect(params.requestToken).toBe(REQUEST_TOKEN);
      expect(body).toStrictEqual({});
      return respond(200, action("pending"));
    },
  );
}

function directAction(
  state: BrowserUserActionResponse["state"] = "pending",
): Extract<BrowserUserActionResponse, { kind: "direct_interaction" }> {
  return {
    kind: "direct_interaction",
    requestToken: REQUEST_TOKEN,
    state,
    completedAt: state === "pending" ? null : "2026-09-22T05:00:00.000Z",
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    reason: "Finish the visual challenge",
    callbackIds: action("pending").callbackIds,
  };
}

function browserSession(): BrowserSession {
  return {
    threadId: THREAD_ID,
    name: "Research",
    status: "suspended",
    viewerUrl: `https://browser.example.test/view/${THREAD_ID}`,
    liveUrl: null,
    screenshotUrl: "https://images.example.test/browser-suspended.png",
    proxyCountryCode: "US",
    timeoutMinutes: 240,
    screen: { width: 1440, height: 900, resizable: true },
    idleExpiresAt: null,
    suspendedAt: "2026-09-22T04:55:00.000Z",
    suspensionReason: "idle",
    createdAt: "2026-09-22T04:00:00.000Z",
    updatedAt: "2026-09-22T04:55:00.000Z",
  };
}

function route(args: { readonly threadId?: string } = {}): string {
  const params = new URLSearchParams({
    agentId: AGENT_ID,
    threadId: args.threadId ?? THREAD_ID,
    callbackPrompt: CALLBACK_PROMPT,
  });
  return `/browser/actions/${REQUEST_TOKEN}?${params.toString()}`;
}

function button(name: string): HTMLElement {
  const result = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!result) {
    throw new Error(`Button not found: ${name}`);
  }
  return result;
}

function link(name: string): HTMLElement {
  const result = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === name;
  });
  if (!result) {
    throw new Error(`Link not found: ${name}`);
  }
  return result;
}

test("The standalone route reuses the native browser input form", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let sentPrompt = "";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  mockPendingPreflight();
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "email", value: "owner@example.test" },
    ]);
    state = "succeeded";
    return respond(200, action(state));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sentPrompt = body.prompt ?? "";
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(SUCCESS_SORT_ID);
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  expect(screen.queryByRole("form")).toBeNull();
  await screen.findByText("Enter information");
  click(button("Enter information"));
  const form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  expect(within(form).getByText("https://login.example.test")).toBeVisible();
  const email = within(form).getByLabelText(/Email/u);
  expect(email).toBeRequired();
  expect(email).toHaveAttribute(
    "maxlength",
    String(BROWSER_USER_ACTION_MAX_VALUE_LENGTH),
  );
  click(button("Add to browser"));
  expect(form).toBeVisible();
  await fill(email, "owner@example.test");
  click(button("Add to browser"));

  await waitFor(() => {
    expect(sentPrompt).toBe(CALLBACK_PROMPT);
  });
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(document.title).toContain("Browser action");
});

test("A fresh standalone action page reads accepted callback delivery", async () => {
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, { ...action("succeeded"), callbackDelivered: true });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(
    queryAllByRoleFast("button", document.body).some((candidate) => {
      return candidate.textContent?.trim() === "Continue";
    }),
  ).toBeFalsy();
});

test("An ambiguous callback response reconciles from the accepted event read", async () => {
  let delivered = false;
  let reads = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    reads += 1;
    return respond(200, {
      ...action("succeeded"),
      callbackDelivered: delivered,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    delivered = true;
    return respond(503, {
      error: { code: "CHAT_UNAVAILABLE", message: "Chat unavailable" },
    });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await screen.findByText("Information added");
  click(button("Continue"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(reads).toBeGreaterThan(1);
});

test("Standalone entry waits for preflight and retries a transient failure without exposing fields", async () => {
  const entered = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  let attempts = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("pending"));
  });
  context.mocks.api(
    browserUserActionsContract.preflight,
    async ({ body, respond }) => {
      expect(body).toStrictEqual({});
      attempts += 1;
      if (attempts === 1) {
        entered.resolve(undefined);
        await release.promise;
        return respond(503, {
          error: {
            code: "BROWSER_UNAVAILABLE",
            message: "Browser unavailable",
          },
        });
      }
      return respond(200, action("pending"));
    },
  );

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await screen.findByText("Enter information");
  click(button("Enter information"));
  await entered.promise;
  expect(screen.queryByRole("form")).toBeNull();
  expect(screen.getByText("Checking this request…")).toBeVisible();
  release.resolve(undefined);
  await screen.findByText("Retry");
  click(button("Retry"));
  await screen.findByRole("form", { name: "Enter information in browser" });
  expect(attempts).toBe(2);
});

test("Standalone preflight makes a confirmed changed target stale before showing fields", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    state = "stale";
    return respond(200, action(state));
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await screen.findByText("Enter information");
  click(button("Enter information"));
  await expect(screen.findByText("Fields changed")).resolves.toBeVisible();
  expect(screen.queryByRole("form")).toBeNull();
  expect(
    screen.getByText("Ask the agent to create a new request."),
  ).toBeVisible();
});

test("A terminal standalone action retries only its stable callback", async () => {
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("succeeded"));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(CALLBACK_PROMPT);
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(SUCCESS_SORT_ID);
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(screen.findByText("Information added")).resolves.toBeVisible();
  click(button("Continue"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A standalone direct interaction opens the existing Browser page and completes before its callback", async () => {
  const ordering: string[] = [];
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, directAction(state));
  });
  context.mocks.api(browserContract.get, ({ params, respond }) => {
    expect(params.threadId).toBe(THREAD_ID);
    return respond(200, { browser: browserSession() });
  });
  context.mocks.api(browserUserActionsContract.complete, ({ respond }) => {
    ordering.push("complete");
    state = "succeeded";
    return respond(200, directAction(state));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    ordering.push("callback");
    expect(body.prompt).toBe(CALLBACK_PROMPT);
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(SUCCESS_SORT_ID);
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(
    screen.findByText("Finish the visual challenge"),
  ).resolves.toBeVisible();
  expect(document.title).toContain("Browser action");
  const browserLink = await waitFor(() => {
    return link("Open Research browser");
  });
  expect(browserLink).toHaveAttribute("href", `/browsers/${THREAD_ID}`);
  expect(browserLink).toHaveAttribute("target", "_blank");
  expect(browserLink).toHaveAttribute("rel", "noreferrer");
  click(button("Done"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(ordering).toStrictEqual(["complete", "callback"]);
});

test("A direct interaction serializes duplicate completion and retries only its failed callback", async () => {
  const completeResponse = context.mocks.deferred<void>();
  let state: BrowserUserActionResponse["state"] = "pending";
  let completeCount = 0;
  let callbackCount = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, directAction(state));
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "BROWSER_NOT_FOUND", message: "Browser not found" },
    });
  });
  context.mocks.api(
    browserUserActionsContract.complete,
    async ({ respond }) => {
      completeCount += 1;
      await completeResponse.promise;
      state = "succeeded";
      return respond(200, directAction(state));
    },
  );
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    callbackCount += 1;
    if (callbackCount === 1) {
      return respond(503, {
        error: { code: "CHAT_UNAVAILABLE", message: "Chat unavailable" },
      });
    }
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await screen.findByText("Finish the visual challenge");
  const done = button("Done");
  click(done);
  click(done);
  await waitFor(() => {
    expect(completeCount).toBe(1);
  });
  completeResponse.resolve();

  await expect(
    screen.findByText("The agent wasn't notified. Try Continue again."),
  ).resolves.toBeVisible();
  click(button("Continue"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(completeCount).toBe(1);
  expect(callbackCount).toBe(2);
});

test("A direct cancellation fails closed when the mutation response changes action kind", async () => {
  let callbackCount = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, directAction());
  });
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "BROWSER_NOT_FOUND", message: "Browser not found" },
    });
  });
  context.mocks.api(browserUserActionsContract.cancel, ({ respond }) => {
    return respond(200, action("cancelled"));
  });
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    callbackCount += 1;
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await screen.findByText("Finish the visual challenge");
  click(button("Cancel"));

  await waitFor(() => {
    expect(button("Cancel")).toBeEnabled();
  });
  expect(callbackCount).toBe(0);
  expect(screen.getByText("Finish the visual challenge")).toBeVisible();
});

test("A terminal standalone direct interaction retries only its stable callback", async () => {
  let callbackCount = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, directAction("succeeded"));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callbackCount += 1;
    expect(body.prompt).toBe(CALLBACK_PROMPT);
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(SUCCESS_SORT_ID);
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(
    screen.findByText("Browser interaction complete"),
  ).resolves.toBeVisible();
  click(button("Continue"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(callbackCount).toBe(1);
});

test("A failed Continue announces the error and remains retryable", async () => {
  let rejectCallback = true;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("succeeded"));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.prompt).toBe(CALLBACK_PROMPT);
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(SUCCESS_SORT_ID);
    if (rejectCallback) {
      rejectCallback = false;
      return respond(503, {
        error: { code: "CHAT_UNAVAILABLE", message: "Chat unavailable" },
      });
    }
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(screen.findByText("Information added")).resolves.toBeVisible();
  click(button("Continue"));
  await waitFor(() => {
    expect(
      screen.getByText("The agent wasn't notified. Try Continue again."),
    ).toBeVisible();
  });
  click(button("Continue"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A failed callback retries without repeating the Browser mutation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let rejectCallback = true;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  mockPendingPreflight();
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(state).toBe("pending");
    expect(body.values).toStrictEqual([
      { key: "email", value: "owner@example.test" },
    ]);
    state = "succeeded";
    return respond(200, action(state));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.clientEventId).toBe(SUCCESS_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(SUCCESS_SORT_ID);
    if (rejectCallback) {
      rejectCallback = false;
      return respond(503, {
        error: { code: "CHAT_UNAVAILABLE", message: "Chat unavailable" },
      });
    }
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await screen.findByText("Enter information");
  click(button("Enter information"));
  const form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  await fill(within(form).getByLabelText(/Email/u), "owner@example.test");
  click(button("Add to browser"));

  await waitFor(() => {
    expect(
      screen.getByText("The agent wasn't notified. Try Continue again."),
    ).toBeVisible();
  });
  expect(screen.queryByDisplayValue("owner@example.test")).toBeNull();
  click(button("Continue"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A transient apply failure keeps the draft for an explicit retry", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let rejectApply = true;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  mockPendingPreflight();
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "email", value: "owner@example.test" },
    ]);
    if (rejectApply) {
      rejectApply = false;
      return respond(503, {
        error: { code: "BROWSER_UNAVAILABLE", message: "Browser unavailable" },
      });
    }
    state = "succeeded";
    return respond(200, action(state));
  });
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await screen.findByText("Enter information");
  click(button("Enter information"));
  const form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  const email = within(form).getByLabelText(/Email/u);
  await fill(email, "owner@example.test");
  click(button("Add to browser"));

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(
    "Your entries are still here",
  );
  expect(email).toHaveValue("owner@example.test");
  click(button("Add to browser"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test.each([
  ["applying", "Adding information"],
  ["stale", "Fields changed"],
  ["uncertain", "Check the browser"],
  ["cancelled", "Request cancelled"],
] as const)(
  "Projects the %s API state without a form",
  async (state, title) => {
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, action(state));
    });

    await setupPage({
      context,
      path: route(),
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
    });

    await expect(screen.findByText(title)).resolves.toBeInTheDocument();
    expect(
      screen.queryByRole("form", { name: "Enter information in browser" }),
    ).toBeNull();
  },
);

test("Maps an expired API response to the inert expiry state", async () => {
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(410, {
      error: { code: "BROWSER_USER_ACTION_EXPIRED", message: "Expired" },
    });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(
    screen.findByText("Request expired"),
  ).resolves.toBeInTheDocument();
});

test("Fails closed for a mismatched response", async () => {
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, { ...action("pending"), agentId: OTHER_AGENT_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(
    screen.findByText("Request unavailable"),
  ).resolves.toBeInTheDocument();
});

test("Invalid standalone claims fail closed without reading the action", async () => {
  await setupPage({
    context,
    path: route({ threadId: "not-a-uuid" }),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(screen.findByText("Request unavailable")).resolves.toBeVisible();
});

test("The standalone feature gate prevents Browser action reads", async () => {
  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: false },
  });

  await expect(screen.findByText("Request unavailable")).resolves.toBeVisible();
});
