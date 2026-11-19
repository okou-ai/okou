import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import {
  browserUserActionsContract,
  type BrowserUserActionApplyRequest,
  type BrowserUserActionResponse,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  type CapturedChatSend,
  waitForSend,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const APP_ORIGIN = "https://app.okou.ai";
const SITE_ORIGIN = "https://accounts.example.com";
const REQUEST_TOKEN = `vm0_browser_user_action_${"a".repeat(43)}`;
const COMPANION_TOKEN = `vm0_browser_user_action_${"b".repeat(43)}`;
const CALLBACK_PROMPT = "Continue with the browser form";
const FINGERPRINT = "f".repeat(64);
const SUCCESS_EVENT_ID = "e1000000-0000-4000-a000-000000000001";
const INITIAL_SCREENSHOT = "https://screens.example.com/initial.png";

type BrowserInputField = BrowserUserActionResponse["fields"][number];

function browserInputUrl(
  token: string,
  callbackPrompt: string,
  relative = false,
): string {
  const url = new URL(`/browser/actions/${token}`, APP_ORIGIN);
  url.searchParams.set("agentId", CAPABILITY_AGENT_ID);
  url.searchParams.set("threadId", RUN_THREAD_ID);
  url.searchParams.set("callbackPrompt", callbackPrompt);
  return relative ? `${url.pathname}${url.search}` : url.href;
}

function inputField(
  key: string,
  label: string,
  fieldKind: BrowserInputField["fieldKind"],
  control: BrowserInputField["control"],
  required = true,
): BrowserInputField {
  return { key, label, fieldKind, required, control };
}

function browserInput(
  fields: readonly BrowserInputField[],
  overrides: Partial<BrowserUserActionResponse> = {},
): BrowserUserActionResponse {
  return {
    kind: "input",
    requestToken: REQUEST_TOKEN,
    state: "pending",
    completedAt: null,
    agentId: CAPABILITY_AGENT_ID,
    threadId: RUN_THREAD_ID,
    callbackIds: {
      success: {
        clientEventId: SUCCESS_EVENT_ID,
        chatThreadSortEventId: "e1000000-0000-4000-a000-000000000002",
      },
      cancellation: {
        clientEventId: "e1000000-0000-4000-a000-000000000003",
        chatThreadSortEventId: "e1000000-0000-4000-a000-000000000004",
      },
    },
    siteOrigin: SITE_ORIGIN,
    fields: [...fields],
    ...overrides,
  };
}

const accountFields = (): BrowserInputField[] => {
  return [
    inputField("email", "Email", "username", {
      tagName: "INPUT",
      inputType: "email",
    }),
    inputField("password", "Password", "password", {
      tagName: "INPUT",
      inputType: "password",
    }),
    inputField("code", "Verification code", "one_time_code", {
      tagName: "INPUT",
      inputType: "text",
    }),
  ];
};

interface BrowserInputServer {
  readonly applied: BrowserUserActionApplyRequest[];
  readonly preflights: string[];
  readonly set: (action: BrowserUserActionResponse) => void;
}

/**
 * Serve Browser input requests by token. Apply completes the request and the
 * agent callback marks its delivery, as the API reports after both writes.
 */
function mockBrowserInputs(
  actions: readonly BrowserUserActionResponse[],
  preflight: (
    action: BrowserUserActionResponse,
  ) => BrowserUserActionResponse | Promise<BrowserUserActionResponse> = (
    action,
  ) => {
    return action;
  },
): BrowserInputServer {
  const current = new Map(
    actions.map((action) => {
      return [action.requestToken, action];
    }),
  );
  const applied: BrowserUserActionApplyRequest[] = [];
  const preflights: string[] = [];
  const read = (token: string) => {
    const action = current.get(token);
    if (!action) {
      throw new Error(`Unknown Browser input ${token}`);
    }
    return action;
  };
  context.mocks.api(browserUserActionsContract.get, ({ params, respond }) => {
    return respond(200, read(params.requestToken));
  });
  context.mocks.api(
    browserUserActionsContract.preflight,
    async ({ params, respond }) => {
      preflights.push(params.requestToken);
      return respond(200, await preflight(read(params.requestToken)));
    },
  );
  context.mocks.api(
    browserUserActionsContract.apply,
    ({ body, params, respond }) => {
      applied.push(body);
      const succeeded = {
        ...read(params.requestToken),
        state: "succeeded" as const,
        completedAt: "2026-08-01T10:05:00.000Z",
      };
      current.set(params.requestToken, succeeded);
      return respond(200, succeeded);
    },
  );
  return {
    applied,
    preflights,
    set: (action) => {
      current.set(action.requestToken, action);
    },
  };
}

function installBrowserConversation(
  lines: readonly string[],
  sends: CapturedChatSend[] = [],
): CapturedChatSend[] {
  installCapabilityChat({
    events: completedConversation(lines.join("\n\n")),
    onSend(send) {
      sends.push(send);
    },
  });
  return sends;
}

function publishBrowserInputChange(): void {
  context.mocks.ably.trigger(`browserUserActionChanged:${RUN_THREAD_ID}`, {});
}

function openButtons(): HTMLElement[] {
  return queryAllByRoleFast("button").filter((button) => {
    return button.textContent?.trim() === "Enter information";
  });
}

async function findOpenButton(index = 0): Promise<HTMLElement> {
  return await waitFor(() => {
    const button = openButtons()[index];
    expect(button).toBeEnabled();
    return button!;
  });
}

async function openBrowserInput(name: string, index = 0): Promise<HTMLElement> {
  click(await findOpenButton(index));
  return await screen.findByRole("dialog", { name });
}

function dialogButton(dialog: HTMLElement, name: string): HTMLElement {
  const button = queryAllByRoleFast("button", dialog).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!button) {
    throw new Error(`${name} button is not in the dialog`);
  }
  return button;
}

async function closeDialog(dialog: HTMLElement): Promise<void> {
  click(dialogButton(dialog, "Close"));
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
}

async function addToBrowser(dialog: HTMLElement): Promise<void> {
  const submit = await waitFor(() => {
    const button = dialogButton(dialog, "Add to browser");
    expect(button).toBeEnabled();
    return button;
  });
  click(submit);
}

/** The API delivers the agent callback, then notifies the chat. */
async function expectAgentNotified(
  sends: readonly CapturedChatSend[],
  server: BrowserInputServer,
  action: BrowserUserActionResponse,
): Promise<void> {
  const send = await waitForSend(sends, 1);
  expect(send).toMatchObject({
    prompt: CALLBACK_PROMPT,
    clientEventId: SUCCESS_EVENT_ID,
  });
  server.set({
    ...action,
    state: "succeeded",
    completedAt: "2026-08-01T10:05:00.000Z",
    callbackDelivered: true,
  });
  publishBrowserInputChange();
  await expect(screen.findByText("Agent notified")).resolves.toBeVisible();
  expect(openButtons()).toHaveLength(0);
}

test.each([
  {
    taskContext: true,
    task: {
      title: "Update the order",
      reason: "The store needs order notes.",
    },
    title: "Update the order",
    description: "The store needs order notes.",
  },
  {
    taskContext: false,
    task: {},
    title: "Enter information in browser",
    description: "",
  },
])(
  "A Browser input card opens, reopens and completes (task context: $taskContext)",
  async ({ task, title, description }) => {
    const notesInput = inputField(
      "notes",
      "Notes",
      "text",
      { tagName: "INPUT", inputType: "text" },
      false,
    );
    const notesTextarea = inputField(
      "notes",
      "Notes",
      "text",
      { tagName: "TEXTAREA", inputType: "textarea" },
      false,
    );
    const quantity = inputField(
      "quantity",
      "Quantity",
      "number",
      { tagName: "INPUT", inputType: "number", min: "1", max: "9" },
      false,
    );
    const action = browserInput([notesInput], task);
    const companion = browserInput(
      [
        inputField("city", "City", "text", {
          tagName: "INPUT",
          inputType: "text",
        }),
      ],
      { requestToken: COMPANION_TOKEN, title: "Shipping city" },
    );
    const firstCheck = context.mocks.deferred<void>();
    let checks = 0;
    const server = mockBrowserInputs([action, companion], async (current) => {
      if (current.requestToken !== REQUEST_TOKEN) {
        return current;
      }
      checks += 1;
      if (checks === 1) {
        await firstCheck.promise;
      }
      return browserInput([notesTextarea, quantity], task);
    });
    const sends = installBrowserConversation([
      browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT),
      browserInputUrl(COMPANION_TOKEN, "Use the shipping city"),
    ]);
    await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
    await readyChat();

    let dialog = await openBrowserInput(title, 0);
    expect(dialog).toHaveAccessibleDescription(description);
    await fill(within(dialog).getByLabelText("Notes"), "Pack separately");
    firstCheck.resolve();
    await waitFor(() => {
      expect(within(dialog).getByLabelText("Notes").tagName).toBe("TEXTAREA");
    });
    expect(within(dialog).getByLabelText("Notes")).toHaveValue(
      "Pack separately",
    );
    expect(within(dialog).getByLabelText("Quantity")).toBeVisible();
    expect(location.pathname).toBe(RUN_PATH);

    server.set({ ...companion, state: "succeeded" });
    publishBrowserInputChange();
    await expect(
      screen.findByText("Information added"),
    ).resolves.toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Notes")).toHaveValue(
      "Pack separately",
    );

    await closeDialog(dialog);
    dialog = await openBrowserInput(title, 0);
    await waitFor(() => {
      expect(server.preflights).toStrictEqual([REQUEST_TOKEN, REQUEST_TOKEN]);
    });
    await fill(within(dialog).getByLabelText("Notes"), "Ready");
    await addToBrowser(dialog);

    await waitFor(() => {
      expect(server.applied).toStrictEqual([
        { values: [{ key: "notes", value: "Ready" }] },
      ]);
    });
    await expectAgentNotified(sends, server, action);
    expect(location.pathname).toBe(RUN_PATH);
  },
);

test("Closing an inline form clears password and code drafts while preserving ordinary text", async () => {
  mockBrowserInputs([browserInput(accountFields())]);
  installBrowserConversation([browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT)]);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  let dialog = await openBrowserInput("Enter information in browser");
  const form = within(dialog).getByRole("form", {
    name: "Enter information in browser",
  });
  expect(form).toHaveAttribute("autocomplete", "off");
  expect(within(dialog).getByLabelText("Email")).toHaveAttribute(
    "autocomplete",
    "off",
  );
  expect(within(dialog).getByLabelText("Password")).toHaveAttribute(
    "autocomplete",
    "off",
  );
  expect(within(dialog).getByLabelText("Verification code")).toHaveAttribute(
    "autocomplete",
    "one-time-code",
  );
  await fill(within(dialog).getByLabelText("Email"), "ada@example.com");
  await fill(within(dialog).getByLabelText("Password"), "correct horse");
  await fill(within(dialog).getByLabelText("Verification code"), "123456");
  click(within(dialog).getByText("Use a saved password"));
  await expect(
    within(dialog).findByText("You can use passwords saved in your browser."),
  ).resolves.toBeVisible();

  await closeDialog(dialog);
  dialog = await openBrowserInput("Enter information in browser");

  expect(within(dialog).getByLabelText("Email")).toHaveValue("ada@example.com");
  expect(within(dialog).getByLabelText("Password")).toHaveValue("");
  expect(within(dialog).getByLabelText("Verification code")).toHaveValue("");
  expect(location.pathname).toBe(RUN_PATH);
});

test("Shared inline forms retain sensitive drafts until their final owner closes", async () => {
  mockBrowserInputs([browserInput(accountFields())]);
  const url = browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT);
  installBrowserConversation([url, url]);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();
  const secondTrigger = await findOpenButton(1);

  const first = await openBrowserInput("Enter information in browser", 0);
  await fill(within(first).getByLabelText("Email"), "ada@example.com");
  await fill(within(first).getByLabelText("Password"), "correct horse");
  await fill(within(first).getByLabelText("Verification code"), "123456");
  // The first modal hides the transcript from accessibility queries, so the
  // second card's trigger is held from before it opened.
  fireEvent.click(secondTrigger);
  const second = await waitFor(() => {
    // An opened modal hides the earlier one from the accessibility tree.
    const dialogs = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ];
    expect(dialogs).toHaveLength(2);
    return dialogs.find((dialog) => {
      return dialog !== first;
    })!;
  });
  expect(second).toHaveAccessibleName("Enter information in browser");
  expect(within(second).getByLabelText("Password")).toHaveValue(
    "correct horse",
  );
  expect(within(second).getByLabelText("Verification code")).toHaveValue(
    "123456",
  );

  await closeDialog(second);
  expect(within(first).getByLabelText("Password")).toHaveValue("correct horse");
  expect(within(first).getByLabelText("Verification code")).toHaveValue(
    "123456",
  );

  await closeDialog(first);
  const reopened = await openBrowserInput("Enter information in browser", 0);
  expect(within(reopened).getByLabelText("Email")).toHaveValue(
    "ada@example.com",
  );
  expect(within(reopened).getByLabelText("Password")).toHaveValue("");
  expect(within(reopened).getByLabelText("Verification code")).toHaveValue("");
});

test("An inline native datetime-local picker keeps a wall-clock string through callback", async () => {
  const action = browserInput([
    inputField("appointment", "Appointment", "date_time", {
      tagName: "INPUT",
      inputType: "datetime-local",
      min: "2026-09-01T00:00",
      max: "2026-09-30T23:59",
      step: "60",
    }),
  ]);
  const server = mockBrowserInputs([action]);
  const sends = installBrowserConversation([
    browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT),
  ]);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  const dialog = await openBrowserInput("Enter information in browser");
  const appointment = within(dialog).getByLabelText("Appointment");
  expect(appointment).toHaveAttribute("type", "datetime-local");
  fireEvent.change(appointment, { target: { value: "2026-09-25T09:30" } });
  await addToBrowser(dialog);

  await waitFor(() => {
    expect(server.applied).toStrictEqual([
      { values: [{ key: "appointment", value: "2026-09-25T09:30" }] },
    ]);
  });
  await expectAgentNotified(sends, server, action);
});

test("An inline Browser input dialog confirms a required native checkbox", async () => {
  const consent = (checked?: boolean) => {
    return inputField("consent", "I agree to the terms", "checkbox", {
      tagName: "INPUT",
      inputType: "checkbox",
      siteRequired: false,
      ...(checked === undefined ? {} : { checked }),
    });
  };
  const action = browserInput([consent()]);
  const server = mockBrowserInputs([action], () => {
    return browserInput([consent(true)]);
  });
  const sends = installBrowserConversation([
    browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT),
  ]);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  const dialog = await openBrowserInput("Enter information in browser");
  await waitFor(() => {
    expect(
      within(dialog).getByRole("checkbox", { name: "I agree to the terms" }),
    ).toBeChecked();
  });
  await addToBrowser(dialog);

  await waitFor(() => {
    expect(server.applied).toStrictEqual([
      { values: [{ key: "consent", checked: true, observedChecked: true }] },
    ]);
  });
  await expectAgentNotified(sends, server, action);
  expect(location.pathname).toBe(RUN_PATH);
});

test("An inline Browser file picker binds local bytes only after confirmation", async () => {
  const action = browserInput([
    inputField("document", "Document", "file", {
      tagName: "INPUT",
      inputType: "file",
      accept: ".txt",
      files: [],
      fileSetFingerprint: FINGERPRINT,
    }),
  ]);
  const server = mockBrowserInputs([action]);
  const prepared: unknown[] = [];
  const uploadUrl = "https://uploads.example.com/browser/note";
  context.mocks.api(
    browserUserActionsContract.prepareFileUpload,
    ({ body, respond }) => {
      prepared.push(body);
      return respond(200, { uploadUrl });
    },
  );
  const uploads: { body: string; credentials: RequestCredentials }[] = [];
  context.mocks.http.put(uploadUrl, async ({ request }) => {
    uploads.push({
      body: await request.text(),
      credentials: request.credentials,
    });
    return new HttpResponse(null, { status: 200 });
  });
  const sends = installBrowserConversation([
    browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT),
  ]);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  const dialog = await openBrowserInput("Enter information in browser");
  const picker = await waitFor(() => {
    const input = within(dialog).getByLabelText("Document");
    expect(input).toBeEnabled();
    return input;
  });
  await userEvent.upload(
    picker,
    new File(["note"], "note.txt", { type: "text/plain" }),
  );
  await expect(
    within(dialog).findByText("(1) note.txt (4 B)"),
  ).resolves.toBeVisible();
  expect(prepared).toHaveLength(0);
  expect(uploads).toHaveLength(0);

  await addToBrowser(dialog);

  await waitFor(() => {
    expect(server.applied).toHaveLength(1);
  });
  expect(prepared).toStrictEqual([{ key: "document", index: 0, size: 4 }]);
  expect(uploads).toStrictEqual([{ body: "note", credentials: "omit" }]);
  expect(server.applied).toStrictEqual([
    {
      values: [
        {
          key: "document",
          operation: "replace",
          observedFingerprint: FINGERPRINT,
          files: [{ name: "note.txt", type: "text/plain", size: 4 }],
        },
      ],
    },
  ]);
  await expectAgentNotified(sends, server, action);
  expect(location.pathname).toBe(RUN_PATH);
});

test("Leaving an open dialog clears the Password draft", async () => {
  mockBrowserInputs([browserInput(accountFields())]);
  installBrowserConversation([browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT)]);
  await setupPage({ context, path: "/connectors", host: "app.okou.ai" });
  window.history.pushState({}, "", RUN_PATH);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await readyChat();

  const dialog = await openBrowserInput("Enter information in browser");
  await fill(within(dialog).getByLabelText("Password"), "correct horse");

  window.history.back();
  await waitFor(() => {
    expect(location.pathname).toBe("/connectors");
  });
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
  });
  expect(screen.queryByDisplayValue("correct horse")).not.toBeInTheDocument();

  window.history.forward();
  await waitFor(() => {
    expect(location.pathname).toBe(RUN_PATH);
  });
  await readyChat();
  const reopened = await openBrowserInput("Enter information in browser");
  expect(within(reopened).getByLabelText("Password")).toHaveValue("");
});

test("Absolute and relative Browser input URLs both render dialog cards", async () => {
  mockBrowserInputs([browserInput(accountFields())]);
  installBrowserConversation([
    browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT),
    browserInputUrl(REQUEST_TOKEN, CALLBACK_PROMPT, true),
  ]);
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  await findOpenButton(1);
  expect(openButtons()).toHaveLength(2);
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return link.getAttribute("href")?.includes("/browser/actions/");
    }),
  ).toHaveLength(0);

  const dialog = await openBrowserInput("Enter information in browser", 1);
  expect(within(dialog).getByLabelText("Email")).toBeVisible();
});

function browserSession(
  status: BrowserSession["status"],
  screenshotUrl: string,
  liveUrl: string | null = null,
): BrowserSession {
  const base = {
    threadId: RUN_THREAD_ID,
    name: "Research",
    viewerUrl: `${APP_ORIGIN}/browsers/${RUN_THREAD_ID}`,
    liveUrl,
    screenshotUrl,
    timeoutMinutes: 10,
    idleExpiresAt: null,
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  };
  return status === "active"
    ? {
        ...base,
        status,
        window: {
          instanceId: "e2000000-0000-4000-a000-000000000001",
          primaryWindowId: 1,
        },
      }
    : {
        ...base,
        status,
        suspendedAt: "2026-08-01T10:03:00.000Z",
        suspensionReason: "idle",
      };
}

/** Install after the conversation, which reports no browser by default. */
function mockBrowserSession(session: BrowserSession): void {
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, { browser: session });
  });
}

function installBrowserCardConversation(): void {
  installBrowserConversation([`${APP_ORIGIN}/browsers/${RUN_THREAD_ID}`]);
}

async function findBrowserCard(): Promise<HTMLElement> {
  return await waitFor(() => {
    const card = document.querySelector<HTMLElement>(
      "[data-browser-session-card]",
    );
    if (!card) {
      throw new Error("Browser card is not rendered");
    }
    return card;
  });
}

function thumbnailSource(card: HTMLElement): string | null {
  return (
    within(card)
      .queryByTestId("browser-session-thumbnail")
      ?.getAttribute("src") ?? null
  );
}

test("Render a live managed browser card", async () => {
  installBrowserCardConversation();
  mockBrowserSession(
    browserSession("active", INITIAL_SCREENSHOT, "https://example.com/"),
  );
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  await readyChat();

  const card = await findBrowserCard();
  await waitFor(() => {
    expect(card).toHaveAccessibleName("Open Research browser");
  });
  expect(within(card).getByText("Cloud browser")).toBeInTheDocument();
  expect(within(card).getByText("Live")).toBeInTheDocument();
  expect(thumbnailSource(card)).toContain("initial.png");
});

test("Open a stopped browser without the refined panel", async () => {
  const signedScreenshot =
    "https://bucket.r2.cloudflarestorage.com/screens/last.png?X-Amz-Signature=testing";
  installBrowserCardConversation();
  mockBrowserSession(browserSession("suspended", signedScreenshot));
  await setupPage({
    context,
    path: RUN_PATH,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: false },
  });
  await readyChat();

  const card = await findBrowserCard();
  await waitFor(() => {
    expect(thumbnailSource(card)).toBe(
      `https://a.okou.io/cdn-cgi/image/width=800,fit=scale-down,format=auto,quality=85,metadata=none/${signedScreenshot}`,
    );
  });
  click(card);

  const panel = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  const browser = within(panel);
  await expect(
    browser.findByText("Browser not live"),
  ).resolves.toBeInTheDocument();
  expect(browser.getByRole("button", { name: "Start browser" })).toBeEnabled();
  expect(
    browser.getByRole("button", { name: "Close cloud browser" }),
  ).toBeEnabled();
  expect(
    browser.getByRole("link", { name: "Open this browser in a new page" }),
  ).toHaveAttribute("href", `/browsers/${RUN_THREAD_ID}`);
  expect(browser.getByLabelText("Remote browser input")).toBeDisabled();
});
