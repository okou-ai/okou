import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  browserUserActionsContract,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
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
        control: { tagName: "INPUT", inputType: "email" },
      },
      {
        key: "remembered",
        label: "Remembered answer",
        fieldKind: "text",
        required: false,
        control: { tagName: "INPUT", inputType: "text" },
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

function numberAction(
  required: boolean,
): Extract<BrowserUserActionResponse, { kind: "input" }> {
  return {
    ...action("pending"),
    fields: [
      {
        key: "quantity",
        label: "Quantity",
        fieldKind: "number",
        required,
        control: {
          tagName: "INPUT",
          inputType: "number",
          siteRequired: false,
          min: "10",
          max: "20",
          step: "0.5",
        },
      },
    ],
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

  expect(
    queryAllByRoleFast("button").some((candidate) => {
      return candidate.textContent?.trim() === "Enter information";
    }),
  ).toBeFalsy();
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

test("The standalone form uses preflight's observed multiline and email controls", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    const pending = action("pending");
    return respond(200, {
      ...pending,
      fields: [
        {
          ...pending.fields[0],
          control: {
            tagName: "INPUT",
            inputType: "email",
            siteRequired: true,
            multiple: true,
          },
        },
        {
          ...pending.fields[1],
          control: { tagName: "TEXTAREA", inputType: "textarea", minLength: 3 },
        },
      ],
    });
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "email", value: "owner@example.test" },
      { key: "remembered", value: "first line\nsecond line" },
    ]);
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
  const multiline = within(form).getByLabelText(/Remembered answer/u);
  expect(email).toHaveAttribute("type", "email");
  expect(email).toHaveAttribute("multiple");
  expect(email).toBeRequired();
  expect(multiline.tagName).toBe("TEXTAREA");
  expect(multiline).toHaveAttribute("minlength", "3");
  await fill(email, "owner@example.test");
  await fill(multiline, "first line\nsecond line");
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("The standalone form uses the existing input style with live number constraints", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let applied = false;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, { ...numberAction(true), state });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, numberAction(true));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    applied = true;
    expect(body.values).toStrictEqual([{ key: "quantity", value: "12.5" }]);
    state = "succeeded";
    return respond(200, { ...numberAction(true), state });
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
  const quantity = within(form).getByLabelText(/Quantity/u);
  expect(quantity).toHaveAttribute("data-slot", "input");
  expect(quantity).toHaveAttribute("type", "number");
  expect(quantity).toHaveAttribute("min", "10");
  expect(quantity).toHaveAttribute("max", "20");
  expect(quantity).toHaveAttribute("step", "0.5");
  expect(quantity).toBeRequired();
  await fill(quantity, "12.5");
  click(button("Add to browser"));
  await waitFor(() => {
    expect(applied).toBe(true);
  });
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test.each([
  { clear: false, typedThenDeleted: false, expected: [] },
  {
    clear: true,
    typedThenDeleted: false,
    expected: [{ key: "quantity", value: "" }],
  },
  { clear: false, typedThenDeleted: true, expected: [] },
])(
  "Optional number field can be untouched or explicitly cleared ($clear, $typedThenDeleted)",
  async ({ clear, typedThenDeleted, expected }) => {
    let state: BrowserUserActionResponse["state"] = "pending";
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, { ...numberAction(false), state });
    });
    context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
      return respond(200, numberAction(false));
    });
    context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
      expect(body.values).toStrictEqual(expected);
      state = "succeeded";
      return respond(200, { ...numberAction(false), state });
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
    expect(within(form).getByLabelText(/Quantity/u)).toHaveAttribute(
      "type",
      "number",
    );
    if (clear) {
      click(button("Clear website value"));
      expect(button("Leave website value unchanged")).toBeVisible();
    }
    if (typedThenDeleted) {
      const quantity = within(form).getByLabelText(/Quantity/u);
      await fill(quantity, "12.5");
      await fill(quantity, "");
      expect(button("Clear website value")).toBeVisible();
    }
    click(button("Add to browser"));
    await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  },
);

test("Changed site constraints require a fresh preflight without losing ordinary draft text", async () => {
  let preflights = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    preflights += 1;
    const pending = action("pending");
    return respond(200, {
      ...pending,
      fields: [
        pending.fields[0],
        {
          ...pending.fields[1],
          control: {
            tagName: "TEXTAREA",
            inputType: "textarea",
            minLength: preflights === 1 ? 3 : 5,
          },
        },
      ],
    });
  });
  context.mocks.api(browserUserActionsContract.apply, ({ respond }) => {
    return respond(409, {
      error: {
        code: "BROWSER_USER_ACTION_INVALID_VALUE",
        message: "Browser input does not meet the website control constraints",
      },
    });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  let form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  await fill(within(form).getByLabelText(/Email/u), "owner@example.test");
  await fill(within(form).getByLabelText(/Remembered answer/u), "abcd");
  click(button("Add to browser"));
  await screen.findByRole("alert");
  click(button("Retry"));
  form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  expect(preflights).toBe(2);
  expect(within(form).getByLabelText(/Remembered answer/u)).toHaveAttribute(
    "minlength",
    "5",
  );
  expect(within(form).getByLabelText(/Remembered answer/u)).toHaveValue("abcd");
});

test("Returning to a pending standalone form keeps its password draft", async () => {
  const pending = {
    ...action("pending"),
    fields: [
      {
        key: "password",
        label: "Password",
        fieldKind: "password" as const,
        required: true,
        control: { tagName: "INPUT" as const, inputType: "password" as const },
      },
    ],
  };
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, pending);
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, pending);
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  const password = await screen.findByLabelText("Password");
  await fill(password, "temporary-secret");
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(screen.getByLabelText("Password")).toBe(password);
  expect(password).toHaveValue("temporary-secret");
});

test("The standalone form records cancellation before notifying the agent", async () => {
  const ordering: string[] = [];
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  mockPendingPreflight();
  context.mocks.api(browserUserActionsContract.cancel, ({ respond }) => {
    ordering.push("cancel");
    state = "cancelled";
    return respond(200, action(state));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    ordering.push("callback");
    expect(body.prompt).toBe("The user cancelled the browser input request.");
    expect(body.clientEventId).toBe(CANCEL_CLIENT_ID);
    expect(body.chatThreadSortEventId).toBe(CANCEL_SORT_ID);
    return respond(201, { runId: crypto.randomUUID(), threadId: THREAD_ID });
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });
  await screen.findByRole("form", { name: "Enter information in browser" });
  click(button("Cancel"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(ordering).toStrictEqual(["cancel", "callback"]);
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
      return candidate.textContent?.trim() === "Notify agent";
    }),
  ).toBeFalsy();
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
  await expect(screen.findByText("Fields changed")).resolves.toBeVisible();
  expect(screen.queryByRole("form")).toBeNull();
  expect(
    screen.getByText("Ask the agent to create a new request."),
  ).toBeVisible();
});

test("A transient standalone preflight failure offers retry without showing fields", async () => {
  let attempts = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    attempts += 1;
    return attempts === 1
      ? respond(503, {
          error: {
            code: "BROWSER_UNAVAILABLE",
            message: "Browser unavailable",
          },
        })
      : respond(200, action("pending"));
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await waitFor(() => {
    expect(button("Retry")).toBeVisible();
  });
  expect(attempts).toBe(1);
  expect(screen.queryByRole("form")).toBeNull();
  click(button("Retry"));
  await screen.findByRole("form", { name: "Enter information in browser" });
  expect(attempts).toBe(2);
});

test("Retry after a failed standalone request also runs preflight", async () => {
  let reads = 0;
  let checks = 0;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    reads += 1;
    return reads === 1
      ? respond(503, {
          error: {
            code: "BROWSER_UNAVAILABLE",
            message: "Browser unavailable",
          },
        })
      : respond(200, action("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    checks += 1;
    return respond(200, action("pending"));
  });

  await setupPage({
    context,
    path: route(),
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.BrowserNativeInput]: true },
  });

  await waitFor(() => {
    expect(button("Retry")).toBeVisible();
  });
  expect(checks).toBe(0);
  click(button("Retry"));
  await screen.findByRole("form", { name: "Enter information in browser" });
  expect(reads).toBe(2);
  expect(checks).toBe(1);
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
  click(button("Notify agent"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A failed notification announces the error and remains retryable", async () => {
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
  click(button("Notify agent"));
  await waitFor(() => {
    expect(screen.getByText("Agent not notified.")).toBeVisible();
  });
  click(button("Retry"));

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

  const form = await screen.findByRole("form", {
    name: "Enter information in browser",
  });
  await fill(within(form).getByLabelText(/Email/u), "owner@example.test");
  click(button("Add to browser"));

  await waitFor(() => {
    expect(screen.getByText("Agent not notified.")).toBeVisible();
  });
  expect(screen.queryByDisplayValue("owner@example.test")).toBeNull();
  click(button("Retry"));

  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test.each([
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
