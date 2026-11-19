import {
  type BrowserUserActionApplyRequest,
  type BrowserUserActionResponse,
  browserUserActionsContract,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
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

const REQUEST_TOKEN = `vm0_browser_user_action_${"a".repeat(43)}`;
const AGENT_ID = "6f1f8c1e-4a52-4c1b-9b0e-0d2f3c4a5b61";
const THREAD_ID = "8a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CALLBACK_PROMPT = "The invoice sign-in details were entered.";
const CHANGED_TOPIC = `browserUserActionChanged:${THREAD_ID}`;
const SUCCESS_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const SUCCESS_SORT_ID = "22222222-2222-4222-8222-222222222222";
const CANCELLATION_EVENT_ID = "33333333-3333-4333-8333-333333333333";
const CANCELLATION_SORT_ID = "44444444-4444-4444-8444-444444444444";

type ActionState = BrowserUserActionResponse["state"];
type DisplayField = BrowserUserActionResponse["fields"][number];

const ACTION_PATH = `/browser/actions/${REQUEST_TOKEN}?${new URLSearchParams({
  agentId: AGENT_ID,
  threadId: THREAD_ID,
  callbackPrompt: CALLBACK_PROMPT,
}).toString()}`;

function textField(
  key: string,
  label: string,
  overrides: Partial<Omit<DisplayField, "control">> & {
    readonly inputType?: DisplayField["control"]["inputType"];
  } = {},
): DisplayField {
  const { inputType = "text", ...field } = overrides;
  return {
    key,
    label,
    fieldKind: "text",
    required: true,
    control: { tagName: "INPUT", inputType },
    ...field,
  };
}

const EMAIL_FIELD = textField("email", "Email address", {
  inputType: "email",
});
const PASSWORD_FIELD = textField("password", "Password", {
  fieldKind: "password",
  inputType: "password",
});
const CODE_FIELD = textField("code", "Verification code", {
  fieldKind: "one_time_code",
});

interface ActionStory {
  state: ActionState;
  callbackDelivered: boolean;
  readonly reads: ActionState[];
  readonly applies: BrowserUserActionApplyRequest["values"][];
  readonly log: string[];
  readonly callbackPrompts: string[];
}

function actionResponse(
  story: ActionStory,
  details: {
    readonly fields: readonly DisplayField[];
    readonly title?: string;
    readonly reason?: string;
  },
): BrowserUserActionResponse {
  return {
    kind: "input",
    requestToken: REQUEST_TOKEN,
    state: story.state,
    completedAt: null,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    callbackIds: {
      success: {
        clientEventId: SUCCESS_EVENT_ID,
        chatThreadSortEventId: SUCCESS_SORT_ID,
      },
      cancellation: {
        clientEventId: CANCELLATION_EVENT_ID,
        chatThreadSortEventId: CANCELLATION_SORT_ID,
      },
    },
    callbackDelivered: story.callbackDelivered,
    siteOrigin: "https://billing.example.com",
    fields: [...details.fields],
    ...(details.title === undefined ? {} : { title: details.title }),
    ...(details.reason === undefined ? {} : { reason: details.reason }),
  };
}

/**
 * The server owns one Browser input request. Each write changes the state a
 * later read returns and publishes the thread change the way the API does.
 */
function mockBrowserAction(options: {
  readonly fields: readonly DisplayField[];
  readonly title?: string;
  readonly reason?: string;
  readonly initialState?: ActionState;
  readonly readState?: (story: ActionStory) => ActionState;
  readonly preflight?: (story: ActionStory) => Promise<void> | void;
  readonly applyState?: ActionState;
  readonly callbackFailure?: string;
}): ActionStory {
  const story: ActionStory = {
    state: options.initialState ?? "pending",
    callbackDelivered: false,
    reads: [],
    applies: [],
    log: [],
    callbackPrompts: [],
  };
  const respondWith = () => {
    return actionResponse(story, options);
  };
  const publish = () => {
    context.mocks.ably.trigger(CHANGED_TOPIC);
  };
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    if (options.readState) {
      story.state = options.readState(story);
    }
    story.reads.push(story.state);
    return respond(200, respondWith());
  });
  context.mocks.api(
    browserUserActionsContract.preflight,
    async ({ respond }) => {
      story.log.push("preflight");
      await options.preflight?.(story);
      return respond(200, respondWith());
    },
  );
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    story.applies.push(body.values);
    story.log.push("apply");
    story.state = options.applyState ?? "succeeded";
    publish();
    return respond(200, respondWith());
  });
  context.mocks.api(browserUserActionsContract.cancel, ({ respond }) => {
    story.log.push("cancel");
    story.state = "cancelled";
    publish();
    return respond(200, respondWith());
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    story.log.push("callback");
    story.callbackPrompts.push(body.prompt ?? "");
    if (options.callbackFailure) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: options.callbackFailure },
      });
    }
    story.callbackDelivered =
      body.clientEventId === SUCCESS_EVENT_ID ||
      body.clientEventId === CANCELLATION_EVENT_ID;
    publish();
    return respond(201, {
      threadId: THREAD_ID,
      createdAt: "2026-11-20T00:00:00.000Z",
    });
  });
  return story;
}

async function openActionPage(): Promise<void> {
  await setupPage({ context, path: ACTION_PATH });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(CHANGED_TOPIC)).toBeTruthy();
  });
}

async function findActionForm(name: string): Promise<HTMLElement> {
  return await screen.findByRole("form", { name });
}

async function findStatus(title: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const status = screen.queryAllByRole("status").find((candidate) => {
      return candidate.textContent?.includes(title) === true;
    });
    if (!status) {
      throw new Error(`Expected the "${title}" status`);
    }
    return status;
  });
}

function control(
  role: "button" | "link",
  name: string,
  container: HTMLElement = document.body,
): HTMLElement {
  const found = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      candidate.textContent?.trim() === name ||
      candidate.getAttribute("aria-label") === name ||
      candidate.querySelector(`img[alt="${name}"]`) !== null
    );
  });
  if (!found) {
    throw new Error(`Expected ${role} "${name}"`);
  }
  return found;
}

function withoutPreflight(log: readonly string[]): string[] {
  return log.filter((entry) => {
    return entry !== "preflight";
  });
}

function inputValues(): string[] {
  return [...document.querySelectorAll("input, textarea")].map((element) => {
    return (element as HTMLInputElement).value;
  });
}

test.each([
  {
    taskContext: true,
    title: "Sign in to download invoices",
    reason: "The billing site needs your account before it lists invoices.",
    description: "Use the email for the billing account.",
    guidance: [
      "The billing site needs your account before it lists invoices.",
      "Use the email for the billing account.",
    ],
  },
  {
    taskContext: false,
    title: undefined,
    reason: undefined,
    description: undefined,
    guidance: [],
  },
])(
  "The standalone route completes native input (task context: $taskContext)",
  async ({ title, reason, description, guidance }) => {
    const story = mockBrowserAction({
      fields: [
        textField("email", "Email address", {
          inputType: "email",
          ...(description === undefined ? {} : { description }),
        }),
      ],
      ...(title === undefined ? {} : { title }),
      ...(reason === undefined ? {} : { reason }),
    });
    await openActionPage();

    const expectedTitle = title ?? "Enter information in browser";
    const form = await findActionForm(expectedTitle);
    expect(
      within(form).getByRole("heading", { name: expectedTitle }),
    ).toBeInTheDocument();
    for (const text of guidance) {
      expect(within(form).getByText(text)).toBeInTheDocument();
    }
    expect(
      within(form).getByText("https://billing.example.com"),
    ).toBeInTheDocument();

    await fill(
      within(form).getByLabelText("Email address"),
      "billing@example.com",
    );
    click(control("button", "Add to browser", form));

    await expect(findStatus("Agent notified")).resolves.toBeInTheDocument();
    expect(story.applies).toStrictEqual([
      [{ key: "email", value: "billing@example.com" }],
    ]);
    expect(story.callbackPrompts).toStrictEqual([CALLBACK_PROMPT]);
  },
);

test("Saved-password help preserves credential input and is scoped to username requests", async () => {
  mockBrowserAction({
    title: "Sign in to the billing site",
    fields: [
      textField("username", "Email", {
        fieldKind: "username",
        inputType: "email",
      }),
    ],
  });
  await openActionPage();
  const form = await findActionForm("Sign in to the billing site");
  const email = within(form).getByLabelText("Email");
  await fill(email, "member@example.com");

  const help = within(form).getByText("Use a saved password");
  const details = help.closest("details");
  if (!details) {
    throw new Error("Saved-password help is not a disclosure");
  }
  const instruction = within(details).getByText(
    "You can use passwords saved in your browser.",
  );
  expect(instruction).not.toBeVisible();

  click(help);
  await waitFor(() => {
    expect(instruction).toBeVisible();
  });
  expect(email).toHaveValue("member@example.com");

  click(help);
  await waitFor(() => {
    expect(instruction).not.toBeVisible();
  });
  expect(email).toHaveValue("member@example.com");
});

test("The standalone form accepts input and submission while its background check is pending", async () => {
  const check = context.mocks.deferred<void>();
  const story = mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [EMAIL_FIELD],
    preflight: async () => {
      await check.promise;
    },
  });
  await openActionPage();
  const form = await findActionForm("Sign in to download invoices");
  await waitFor(() => {
    expect(story.log).toContain("preflight");
  });
  expect(
    within(form).getByLabelText("Checking this request…"),
  ).toBeInTheDocument();

  await fill(
    within(form).getByLabelText("Email address"),
    "billing@example.com",
  );
  const submit = control("button", "Add to browser", form);
  expect(submit).toBeEnabled();
  click(submit);

  await expect(findStatus("Agent notified")).resolves.toBeInTheDocument();
  expect(story.applies).toStrictEqual([
    [{ key: "email", value: "billing@example.com" }],
  ]);
  expect(story.callbackPrompts).toStrictEqual([CALLBACK_PROMPT]);
  check.resolve();
});

test("Leaving and returning to a standalone form clears password and code drafts", async () => {
  mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [PASSWORD_FIELD, CODE_FIELD],
  });
  await openActionPage();
  const form = await findActionForm("Sign in to download invoices");
  await fill(within(form).getByLabelText("Password"), "correct horse");
  await fill(within(form).getByLabelText("Verification code"), "246810");

  click(control("link", "Okou"));
  await waitFor(() => {
    expect(location.pathname).toBe("/connectors");
  });
  expect(
    screen.queryByRole("form", { name: "Sign in to download invoices" }),
  ).not.toBeInTheDocument();

  window.history.back();

  const returned = await findActionForm("Sign in to download invoices");
  expect(within(returned).getByLabelText("Password")).toHaveValue("");
  expect(within(returned).getByLabelText("Verification code")).toHaveValue("");
});

test("The standalone form records cancellation before notifying the agent", async () => {
  const story = mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [EMAIL_FIELD],
  });
  await openActionPage();
  const form = await findActionForm("Sign in to download invoices");

  click(control("button", "Cancel", form));

  await expect(findStatus("Agent notified")).resolves.toBeInTheDocument();
  expect(withoutPreflight(story.log)).toStrictEqual(["cancel", "callback"]);
  expect(story.callbackPrompts).toStrictEqual([
    "The user cancelled the browser input request.",
  ]);
  expect(story.applies).toStrictEqual([]);
});

test("A completed Browser input clears sensitive values when its callback fails", async () => {
  const story = mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [EMAIL_FIELD, PASSWORD_FIELD, CODE_FIELD],
    callbackFailure: "Chat unavailable",
  });
  await openActionPage();
  const form = await findActionForm("Sign in to download invoices");
  await fill(
    within(form).getByLabelText("Email address"),
    "billing@example.com",
  );
  await fill(within(form).getByLabelText("Password"), "correct horse");
  await fill(within(form).getByLabelText("Verification code"), "246810");

  click(control("button", "Add to browser", form));

  await expect(screen.findByText("Chat unavailable")).resolves.toBeVisible();
  await expect(findStatus("Information added")).resolves.toBeInTheDocument();
  expect(withoutPreflight(story.log)).toStrictEqual(["apply", "callback"]);
  expect(form).not.toBeInTheDocument();
  expect(inputValues()).not.toContain("billing@example.com");
  expect(inputValues()).not.toContain("correct horse");
  expect(inputValues()).not.toContain("246810");
});

test("Standalone preflight makes a confirmed changed target stale before showing fields", async () => {
  const story = mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [EMAIL_FIELD],
    preflight: (current) => {
      current.state = "stale";
      context.mocks.ably.trigger(CHANGED_TOPIC);
    },
  });
  await openActionPage();

  const status = await findStatus("Fields changed");
  expect(status).toHaveTextContent("Ask the agent to create a new request.");
  expect(story.log).toContain("preflight");
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
});

test("A populated standalone form removes sensitive inputs after uncertain feedback", async () => {
  const story = mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [PASSWORD_FIELD, CODE_FIELD],
    applyState: "uncertain",
  });
  await openActionPage();
  const form = await findActionForm("Sign in to download invoices");
  await fill(within(form).getByLabelText("Password"), "correct horse");
  await fill(within(form).getByLabelText("Verification code"), "246810");

  click(control("button", "Add to browser", form));

  await expect(findStatus("Check the browser")).resolves.toBeInTheDocument();
  expect(story.applies).toStrictEqual([
    [
      { key: "password", value: "correct horse" },
      { key: "code", value: "246810" },
    ],
  ]);
  expect(form).not.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(inputValues()).not.toContain("correct horse");
  expect(inputValues()).not.toContain("246810");
});

test.each(["succeeded", "stale"] as const)(
  "An initially applying action reaches %s",
  async (settled) => {
    const story = mockBrowserAction({
      title: "Sign in to download invoices",
      fields: [EMAIL_FIELD],
      initialState: "applying",
      readState: (current) => {
        return current.reads.length === 0 ? "applying" : settled;
      },
    });
    await openActionPage();

    await expect(
      findStatus(
        settled === "succeeded" ? "Information added" : "Fields changed",
      ),
    ).resolves.toBeInTheDocument();
    expect(story.reads[0]).toBe("applying");
    expect(story.reads.at(-1)).toBe(settled);
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
  },
);

test("An applying action settles when the thread signals a change", async () => {
  const story = mockBrowserAction({
    title: "Sign in to download invoices",
    fields: [EMAIL_FIELD],
    initialState: "applying",
  });
  await openActionPage();
  await expect(
    findStatus("Checking browser status"),
  ).resolves.toBeInTheDocument();

  story.state = "uncertain";
  context.mocks.ably.trigger(CHANGED_TOPIC);

  await expect(findStatus("Check the browser")).resolves.toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
});
