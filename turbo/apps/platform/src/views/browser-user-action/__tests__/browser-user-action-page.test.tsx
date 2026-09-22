import {
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
  await fill(within(form).getByLabelText(/Email/u), "owner@example.test");
  click(button("Add to browser"));

  await waitFor(() => {
    expect(sentPrompt).toBe(CALLBACK_PROMPT);
  });
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(document.title).toContain("Browser input");
});

test("A terminal standalone action retries only its stable callback", async () => {
  let applyCalls = 0;
  let callbackCalls = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("succeeded"));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ respond }) => {
    applyCalls += 1;
    return respond(200, action("succeeded"));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callbackCalls += 1;
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

  await waitFor(() => {
    expect(callbackCalls).toBe(1);
  });
  expect(applyCalls).toBe(0);
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("Invalid standalone claims fail closed without reading the action", async () => {
  let getCalls = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    getCalls += 1;
    return respond(200, action("pending"));
  });

  await setupPage({
    context,
    path: route({ threadId: "not-a-uuid" }),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await expect(screen.findByText("Request unavailable")).resolves.toBeVisible();
  expect(getCalls).toBe(0);
});

test("The standalone feature gate prevents Browser action reads", async () => {
  let getCalls = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    getCalls += 1;
    return respond(200, action("pending"));
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: false },
  });

  await expect(screen.findByText("Request unavailable")).resolves.toBeVisible();
  expect(getCalls).toBe(0);
});
