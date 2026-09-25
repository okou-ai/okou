import {
  BROWSER_USER_ACTION_MAX_VALUE_LENGTH,
  browserUserActionsContract,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

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

function checkboxAction(args: {
  readonly required: boolean;
  readonly checked: boolean;
  readonly preflight?: boolean;
  readonly siteRequired?: boolean;
}): Extract<BrowserUserActionResponse, { kind: "input" }> {
  return {
    ...action("pending"),
    fields: [
      {
        key: "consent",
        label: "Consent",
        fieldKind: "checkbox",
        required: args.required,
        control: {
          tagName: "INPUT",
          inputType: "checkbox",
          ...(args.preflight
            ? {
                checked: args.checked,
                siteRequired: args.siteRequired ?? false,
              }
            : {}),
        },
      },
    ],
  };
}

const RADIO_FINGERPRINT = "b".repeat(64);
function radioAction(args: {
  required: boolean;
  selected: number;
  preflight?: boolean;
  siteRequired?: boolean;
  fingerprint?: string;
}) {
  return {
    ...action("pending"),
    fields: [
      {
        key: "delivery",
        label: "Delivery",
        fieldKind: "radio" as const,
        required: args.required,
        control: {
          tagName: "INPUT" as const,
          inputType: "radio" as const,
          ...(args.preflight
            ? {
                siteRequired: args.siteRequired ?? false,
                radioGroupFingerprint: args.fingerprint ?? RADIO_FINGERPRINT,
                radioOptions: [0, 1, 2].map((index) => {
                  return {
                    index,
                    label: "Same",
                    disabled: index === 2,
                    selected: index === args.selected,
                  };
                }),
              }
            : {}),
        },
      },
    ],
  };
}

const SELECT_FINGERPRINT = "a".repeat(64);

function selectAction(args: {
  readonly required: boolean;
  readonly multiple: boolean;
  readonly preflight?: boolean;
  readonly fingerprint?: string;
}): Extract<BrowserUserActionResponse, { kind: "input" }> {
  return {
    ...action("pending"),
    fields: [
      {
        key: "region",
        label: "Region",
        fieldKind: "select",
        required: args.required,
        control: {
          tagName: "SELECT",
          inputType: args.multiple ? "select-multiple" : "select-one",
          ...(args.preflight
            ? {
                siteRequired: false,
                multiple: args.multiple,
                optionSetFingerprint: args.fingerprint ?? SELECT_FINGERPRINT,
                options: [
                  {
                    index: 0,
                    label: "Choose",
                    disabled: false,
                    selected: !args.multiple,
                    empty: true,
                  },
                  {
                    index: 1,
                    label: "First",
                    disabled: false,
                    selected: args.multiple,
                    empty: false,
                  },
                  {
                    index: 2,
                    label: "Second",
                    disabled: false,
                    selected: false,
                    empty: false,
                  },
                  {
                    index: 3,
                    label: "Unavailable",
                    disabled: true,
                    selected: false,
                    empty: false,
                  },
                ],
              }
            : {}),
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

test("The standalone form accepts input and submission while its background check is pending", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let applied = false;
  const checkStarted = createDeferredPromise<void>(context.signal);
  const releaseCheck = createDeferredPromise<void>(context.signal);
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action(state));
  });
  context.mocks.api(
    browserUserActionsContract.preflight,
    async ({ respond }) => {
      checkStarted.resolve(undefined);
      await releaseCheck.promise;
      return respond(200, action("pending"));
    },
  );
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    applied = true;
    expect(body.values).toStrictEqual([
      { key: "email", value: "owner@example.test" },
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
  await checkStarted.promise;
  expect(screen.getByText("Checking this request…")).toBeVisible();
  expect(button("Add to browser")).toBeEnabled();
  await fill(within(form).getByLabelText(/Email/u), "owner@example.test");
  click(button("Add to browser"));
  await waitFor(() => {
    expect(applied).toBeTruthy();
  });
  releaseCheck.resolve(undefined);
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A failed background check blocks submission and retains the draft for retry", async () => {
  let checks = 0;
  let applied = false;
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, action("pending"));
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    checks += 1;
    return checks === 1
      ? respond(503, {
          error: {
            code: "BROWSER_USE_TIMEOUT",
            message: "Browser check timed out",
          },
        })
      : respond(200, action("pending"));
  });
  context.mocks.api(browserUserActionsContract.apply, ({ respond }) => {
    applied = true;
    return respond(200, action("succeeded"));
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
  await expect(
    screen.findByText(/Couldn't check the browser/u),
  ).resolves.toBeVisible();
  expect(button("Add to browser")).toBeDisabled();
  expect(email).toHaveValue("owner@example.test");
  expect(applied).toBeFalsy();
  click(button("Retry"));
  await waitFor(() => {
    expect(checks).toBe(2);
    expect(button("Add to browser")).toBeEnabled();
  });
  expect(email).toHaveValue("owner@example.test");
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
  await waitFor(() => {
    expect(within(form).getByLabelText(/Remembered answer/u).tagName).toBe(
      "TEXTAREA",
    );
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
    expect(applied).toBeTruthy();
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
    }
    if (typedThenDeleted) {
      const quantity = within(form).getByLabelText(/Quantity/u);
      await fill(quantity, "12.5");
      await fill(quantity, "");
    }
    expect(
      button(clear ? "Leave website value unchanged" : "Clear website value"),
    ).toBeVisible();
    click(button("Add to browser"));
    await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  },
);

test.each([
  { siteChecked: true, expected: false },
  { siteChecked: false, expected: true },
])(
  "An optional checkbox submits an explicit $expected rather than the website's $siteChecked",
  async ({ siteChecked, expected }) => {
    let state: BrowserUserActionResponse["state"] = "pending";
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, {
        ...checkboxAction({ required: false, checked: siteChecked }),
        state,
      });
    });
    context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
      return respond(
        200,
        checkboxAction({
          required: false,
          checked: siteChecked,
          preflight: true,
        }),
      );
    });
    context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
      expect(body.values).toStrictEqual([
        { key: "consent", checked: expected, observedChecked: siteChecked },
      ]);
      state = "succeeded";
      return respond(200, {
        ...checkboxAction({ required: false, checked: siteChecked }),
        state,
      });
    });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      expect(body.prompt).toBe(CALLBACK_PROMPT);
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
    const checkbox = within(form).getByRole("checkbox", { name: /Consent/u });
    await waitFor(() => {
      expect(checkbox).toBeEnabled();
    });
    expect(checkbox).toHaveProperty("checked", siteChecked);
    const user = userEvent.setup({ delay: null });
    await user.click(checkbox);
    click(button("Add to browser"));
    await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  },
);

test("An untouched optional checkbox preserves a checked website value", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...checkboxAction({ required: false, checked: true }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(
      200,
      checkboxAction({ required: false, checked: true, preflight: true }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([]);
    state = "succeeded";
    return respond(200, {
      ...checkboxAction({ required: false, checked: true }),
      state,
    });
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
  const checkbox = within(form).getByRole("checkbox", { name: /Consent/u });
  await waitFor(() => {
    expect(checkbox).toBeEnabled();
  });
  expect(checkbox).toBeChecked();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A required checked checkbox needs explicit confirmation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...checkboxAction({ required: true, checked: true }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(
      200,
      checkboxAction({ required: true, checked: true, preflight: true }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      { key: "consent", checked: true, observedChecked: true },
    ]);
    state = "succeeded";
    return respond(200, {
      ...checkboxAction({ required: true, checked: true }),
      state,
    });
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
  const checkbox = within(form).getByRole("checkbox", { name: /Consent/u });
  await waitFor(() => {
    expect(checkbox).toBeEnabled();
  });
  expect(checkbox).toBeChecked();
  expect(button("Add to browser")).toBeDisabled();
  click(button("Leave website value unchanged"));
  expect(button("Add to browser")).toBeEnabled();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A changed checkbox state on Retry requires a fresh confirmation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let checks = 0;
  let applies = 0;
  const submissions: unknown[] = [];
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...checkboxAction({ required: true, checked: false }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    checks += 1;
    return respond(
      200,
      checkboxAction({
        required: true,
        checked: checks === 2,
        preflight: true,
      }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    applies += 1;
    submissions.push(body.values);
    if (applies === 1) {
      return respond(409, {
        error: {
          code: "BROWSER_USER_ACTION_INVALID_VALUE",
          message: "Changed website state",
        },
      });
    }
    state = "succeeded";
    return respond(200, {
      ...checkboxAction({ required: true, checked: true }),
      state,
    });
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
  const checkbox = within(form).getByRole("checkbox", { name: /Consent/u });
  await waitFor(() => {
    expect(checkbox).toBeEnabled();
  });
  const user = userEvent.setup({ delay: null });
  await user.click(checkbox);
  click(button("Add to browser"));
  await screen.findByRole("alert");
  click(button("Retry"));
  await waitFor(() => {
    expect(checks).toBe(2);
  });
  expect(checkbox).toBeChecked();
  expect(button("Add to browser")).toBeDisabled();
  click(button("Leave website value unchanged"));
  expect(button("Add to browser")).toBeEnabled();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(submissions).toStrictEqual([
    [{ key: "consent", checked: true, observedChecked: false }],
    [{ key: "consent", checked: true, observedChecked: true }],
  ]);
});

test.each([
  { memberIndex: 1, label: "2. Same" },
  { memberIndex: -1, label: "Clear website value" },
])(
  "A radio group submits an indexed choice or explicit clear without its duplicate value ($memberIndex)",
  async ({ memberIndex, label }) => {
    let state: BrowserUserActionResponse["state"] = "pending";
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, {
        ...radioAction({ required: false, selected: 0 }),
        state,
      });
    });
    context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
      return respond(
        200,
        radioAction({ required: false, selected: 0, preflight: true }),
      );
    });
    context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
      expect(body.values).toStrictEqual([
        {
          key: "delivery",
          memberIndex,
          observedSelectedIndex: 0,
          groupFingerprint: RADIO_FINGERPRINT,
        },
      ]);
      state = "succeeded";
      return respond(200, {
        ...radioAction({ required: false, selected: 0 }),
        state,
      });
    });
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      expect(body.prompt).toBe(CALLBACK_PROMPT);
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
    const radios = await within(form).findAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]).toBeChecked();
    expect(radios[2]).toBeDisabled();
    if (memberIndex >= 0) {
      await userEvent
        .setup({ delay: null })
        .click(within(form).getByRole("radio", { name: label }));
    } else {
      click(button(label));
    }
    click(button("Add to browser"));
    await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  },
);

test("A radio choice from a changed website group cannot survive Retry without new confirmation", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  let checks = 0;
  const submissions: unknown[] = [];
  const changedFingerprint = "c".repeat(64);
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...radioAction({ required: true, selected: 0 }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    checks += 1;
    return respond(
      200,
      radioAction({
        required: true,
        selected: checks === 1 ? 0 : 1,
        preflight: true,
        fingerprint: checks === 1 ? RADIO_FINGERPRINT : changedFingerprint,
      }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    submissions.push(body.values);
    if (submissions.length === 1) {
      return respond(409, {
        error: {
          code: "BROWSER_USER_ACTION_INVALID_VALUE",
          message: "Changed website group",
        },
      });
    }
    state = "succeeded";
    return respond(200, {
      ...radioAction({ required: true, selected: 1 }),
      state,
    });
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
  const radios = await within(form).findAllByRole("radio");
  await waitFor(() => {
    expect(radios[0]).toBeEnabled();
  });
  await userEvent.setup({ delay: null }).click(radios[1]);
  click(button("Add to browser"));
  await screen.findByRole("alert");
  click(button("Retry"));
  await waitFor(() => {
    expect(checks).toBe(2);
    expect(radios[1]).toBeChecked();
  });
  expect(button("Add to browser")).toBeDisabled();
  click(button("Leave website value unchanged"));
  expect(button("Add to browser")).toBeEnabled();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(submissions).toStrictEqual([
    [
      {
        key: "delivery",
        memberIndex: 1,
        observedSelectedIndex: 0,
        groupFingerprint: RADIO_FINGERPRINT,
      },
    ],
    [
      {
        key: "delivery",
        memberIndex: 1,
        observedSelectedIndex: 1,
        groupFingerprint: changedFingerprint,
      },
    ],
  ]);
});

test("An untouched optional radio group preserves the existing selection", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...radioAction({ required: false, selected: 0 }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(
      200,
      radioAction({ required: false, selected: 0, preflight: true }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([]);
    state = "succeeded";
    return respond(200, {
      ...radioAction({ required: false, selected: 0 }),
      state,
    });
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
  await within(form).findAllByRole("radio");
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("An Agent-required radio group needs a deliberate confirmation of the website choice", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...radioAction({ required: true, selected: 0 }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(
      200,
      radioAction({ required: true, selected: 0, preflight: true }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "delivery",
        memberIndex: 0,
        observedSelectedIndex: 0,
        groupFingerprint: RADIO_FINGERPRINT,
      },
    ]);
    state = "succeeded";
    return respond(200, {
      ...radioAction({ required: true, selected: 0 }),
      state,
    });
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
  await within(form).findAllByRole("radio");
  expect(button("Add to browser")).toBeDisabled();
  click(button("Leave website value unchanged"));
  expect(button("Add to browser")).toBeEnabled();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("The standalone form selects a required native option by index, not its website value", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...selectAction({ required: true, multiple: false }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(
      200,
      selectAction({ required: true, multiple: false, preflight: true }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "region",
        optionIndexes: [2],
        optionSetFingerprint: SELECT_FINGERPRINT,
      },
    ]);
    state = "succeeded";
    return respond(200, {
      ...selectAction({ required: true, multiple: false }),
      state,
    });
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
  const region = within(form).getByLabelText(/Region/u);
  await waitFor(() => {
    expect(region).toBeEnabled();
  });
  expect(region).not.toHaveAttribute("multiple");
  expect(button("Add to browser")).toBeDisabled();
  const user = userEvent.setup({ delay: null });
  await user.selectOptions(region, "2");
  expect(button("Add to browser")).toBeEnabled();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("A required multiple select cannot keep a disabled website choice and drops it on change", async () => {
  const preflight = selectAction({
    required: true,
    multiple: true,
    preflight: true,
  });
  const [field] = preflight.fields;
  if (!field?.control.options) {
    throw new Error("Expected select options in the preflight fixture");
  }
  const snapshot = {
    ...preflight,
    fields: [
      {
        ...field,
        control: {
          ...field.control,
          options: field.control.options.map((option) => {
            return option.index === 3 ? { ...option, selected: true } : option;
          }),
        },
      },
    ],
  };
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...selectAction({ required: true, multiple: true }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, snapshot);
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "region",
        optionIndexes: [1, 2],
        optionSetFingerprint: SELECT_FINGERPRINT,
      },
    ]);
    state = "succeeded";
    return respond(200, {
      ...selectAction({ required: true, multiple: true }),
      state,
    });
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
  const region = within(form).getByLabelText(/Region/u);
  await waitFor(() => {
    expect(region).toBeEnabled();
  });
  expect(button("Add to browser")).toBeDisabled();
  expect(screen.queryByText("Leave website value unchanged")).toBeNull();
  const user = userEvent.setup({ delay: null });
  await user.selectOptions(region, "2");
  expect(button("Add to browser")).toBeEnabled();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test("An optional multiple select distinguishes untouched from an explicit clear", async () => {
  let state: BrowserUserActionResponse["state"] = "pending";
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    return respond(200, {
      ...selectAction({ required: false, multiple: true }),
      state,
    });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(
      200,
      selectAction({ required: false, multiple: true, preflight: true }),
    );
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    expect(body.values).toStrictEqual([
      {
        key: "region",
        optionIndexes: [],
        optionSetFingerprint: SELECT_FINGERPRINT,
      },
    ]);
    state = "succeeded";
    return respond(200, {
      ...selectAction({ required: false, multiple: true }),
      state,
    });
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
  const region = within(form).getByLabelText(/Region/u);
  await waitFor(() => {
    expect(region).toBeEnabled();
  });
  expect(region).toHaveAttribute("multiple");
  click(button("Clear website value"));
  expect(button("Leave website value unchanged")).toBeVisible();
  click(button("Add to browser"));
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
});

test.each([
  { siteSelection: 1, confirmedIndex: 1, canKeep: true },
  { siteSelection: 0, confirmedIndex: 2, canKeep: false },
])(
  "A changed select snapshot requires a fresh choice or valid website confirmation ($siteSelection)",
  async ({ siteSelection, confirmedIndex, canKeep }) => {
    let state: BrowserUserActionResponse["state"] = "pending";
    let preflights = 0;
    let applies = 0;
    const submissions: unknown[] = [];
    const nextFingerprint = "b".repeat(64);
    context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
      return respond(200, {
        ...selectAction({ required: true, multiple: false }),
        state,
      });
    });
    context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
      preflights += 1;
      const checked = selectAction({
        required: true,
        multiple: false,
        preflight: true,
        fingerprint: preflights === 1 ? SELECT_FINGERPRINT : nextFingerprint,
      });
      if (preflights === 1) {
        return respond(200, checked);
      }
      return respond(200, {
        ...checked,
        fields: checked.fields.map((field) => {
          return {
            ...field,
            control: {
              ...field.control,
              options: field.control.options?.map((option) => {
                return {
                  ...option,
                  selected: option.index === siteSelection,
                  label:
                    option.index === 1 ? "Current site choice" : option.label,
                };
              }),
            },
          };
        }),
      });
    });
    context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
      applies += 1;
      submissions.push(body.values);
      if (applies === 1) {
        return respond(409, {
          error: {
            code: "BROWSER_USER_ACTION_INVALID_VALUE",
            message: "Website choices changed",
          },
        });
      }
      state = "succeeded";
      return respond(200, {
        ...selectAction({ required: true, multiple: false }),
        state,
      });
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
    const region = within(form).getByLabelText(/Region/u);
    await waitFor(() => {
      expect(region).toBeEnabled();
    });
    const user = userEvent.setup({ delay: null });
    await user.selectOptions(region, "2");
    click(button("Add to browser"));
    await screen.findByRole("alert");
    click(button("Retry"));
    await waitFor(() => {
      expect(preflights).toBe(2);
    });
    expect(region).toHaveValue(String(siteSelection));
    expect(button("Add to browser")).toBeDisabled();
    expect(screen.queryByText("Leave website value unchanged") !== null).toBe(
      canKeep,
    );
    if (canKeep) {
      click(button("Leave website value unchanged"));
    } else {
      await user.selectOptions(region, "2");
    }
    expect(button("Add to browser")).toBeEnabled();
    click(button("Add to browser"));
    await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
    expect(applies).toBe(2);
    expect(submissions).toStrictEqual([
      [
        {
          key: "region",
          optionIndexes: [2],
          optionSetFingerprint: SELECT_FINGERPRINT,
        },
      ],
      [
        {
          key: "region",
          optionIndexes: [confirmedIndex],
          optionSetFingerprint: nextFingerprint,
        },
      ],
    ]);
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

test("A transient standalone preflight failure keeps fields visible but blocks submission", async () => {
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
  expect(
    screen.getByRole("form", { name: "Enter information in browser" }),
  ).toBeVisible();
  expect(button("Add to browser")).toBeDisabled();
  click(button("Retry"));
  await waitFor(() => {
    expect(attempts).toBe(2);
    expect(button("Add to browser")).toBeEnabled();
  });
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
