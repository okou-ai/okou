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

function directAction(): Extract<
  BrowserUserActionResponse,
  { kind: "direct_interaction" }
> {
  return {
    kind: "direct_interaction",
    requestToken: REQUEST_TOKEN,
    state: "pending",
    completedAt: null,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    reason: "Finish the visual challenge",
    callbackIds: action("pending").callbackIds,
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

test("The standalone route reuses the native browser input form", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let sentPrompt = "";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
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
  expect(document.title).toContain("Browser input");
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

test("A failed callback retries without repeating the Browser mutation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let rejectCallback = true;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
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

  const form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  await fill(within(form).getByLabelText(/Email/u), "owner@example.test");
  click(button("Add to browser"));

  await expect(screen.findByText("Information added")).resolves.toBeVisible();
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

test.each([
  ["a mismatched response", { ...action("pending"), agentId: OTHER_AGENT_ID }],
  ["a direct-interaction response", directAction()],
] as const)("Fails closed for %s", async (_case, response) => {
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, response);
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
