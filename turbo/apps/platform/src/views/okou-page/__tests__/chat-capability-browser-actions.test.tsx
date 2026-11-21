import cardStyles from "./browser-session-card-fixture.css?inline";
import {
  browserContract,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { arrangeNativePage } from "../../browser-session/__tests__/browser-native-page-fixture.ts";
import { browserUserActionsContract } from "@okouai/api-contracts/contracts/browser-user-actions";
import { HttpResponse } from "msw";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserInputPath,
  callbackPrompt,
  installBrowserRequest,
  threadId,
  type Field,
} from "../../browser-user-action/__tests__/browser-input-request-fixture.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const path = browserInputPath(AGENT_ID);
async function openConversation(
  fields: Field[],
  messages: string[],
  options: {
    initial?: Parameters<typeof installBrowserRequest>[2];
    arrange?: (request: ReturnType<typeof installBrowserRequest>) => void;
    startPath?: string;
  } = {},
) {
  const chatEvents = messages.flatMap((text, index) => {
    const runId = crypto.randomUUID();
    const seqId = index * 2 + 1;
    return [
      assistantEvent({ id: "invoice-request-" + index, runId, seqId, text }),
      completedEvent({
        id: "invoice-completion-" + index,
        runId,
        seqId: seqId + 1,
      }),
    ];
  });
  createChatRunFixtures(context).installRunChat({ threadId, chatEvents });
  const request = installBrowserRequest(context, fields, {
    agentId: AGENT_ID,
    ...options.initial,
  });
  options.arrange?.(request);
  await setupPage({
    context,
    host: "app.okou.ai",
    path: options.startPath ?? "/chats/" + threadId,
  });
  return request;
}

test("chat-capability-browser-actions-012 selecting a local appointment continues the chat with the exact wall-clock time", async () => {
  const appointment: Field = {
    key: "appointment",
    label: "Pickup appointment",
    fieldKind: "date_time",
    required: true,
    control: {
      tagName: "INPUT",
      inputType: "datetime-local",
      min: "2026-09-01T00:00",
      max: "2026-09-30T23:59",
      step: "60",
    },
  };
  const request = await openConversation(
    [appointment],
    ["https://app.okou.ai" + path],
  );
  click(await screen.findByText("Enter information", { selector: "button" }));
  const dialog = within(await screen.findByRole("dialog"));
  const input = dialog.getByLabelText(appointment.label, {
    selector: 'input[type="datetime-local"]',
  });
  await waitFor(() => {
    expect(input).toHaveAttribute("step", "60");
  });
  const value = "2026-09-25T09:30";
  fireEvent.change(input, { target: { value } });
  click(dialog.getByText("Add to browser", { selector: "button" }));
  await screen.findByText("Agent notified");
  await expect(request.applied.promise).resolves.toStrictEqual([
    { key: "appointment", value },
  ]);
  await expect(request.callback.promise).resolves.toMatchObject({
    prompt: callbackPrompt,
    threadId,
  });
});

test("chat-capability-browser-actions-025 absolute and relative account URLs render as buttons in the conversation", async () => {
  const absolute = "https://app.okou.ai" + path;
  const field: Field = {
    key: "account",
    label: "Account email",
    fieldKind: "username",
    required: true,
    control: { tagName: "INPUT", inputType: "email" },
  };
  await openConversation([field], [absolute, path]);
  await waitFor(() => {
    expect(
      screen.getAllByText("Enter information", { selector: "button" }),
    ).toHaveLength(2);
  });
  const routeLinks = queryAllByRoleFast("link").filter((element) => {
    return (
      element.getAttribute("href") === absolute ||
      element.getAttribute("href") === path
    );
  });
  expect(routeLinks).toStrictEqual([]);
  const [first] = screen.getAllByText("Enter information", {
    selector: "button",
  });
  click(first!);
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByLabelText("Account email")).toBeInTheDocument();
});

const chatPath = "/chats/" + threadId;
function loginFields(): Field[] {
  return [
    {
      key: "email",
      label: "Billing email",
      required: true,
      fieldKind: "username",
      control: { tagName: "INPUT", inputType: "email" },
    },
    {
      key: "secret",
      label: "Billing password",
      required: true,
      fieldKind: "password",
      control: { tagName: "INPUT", inputType: "password" },
    },
    {
      key: "code",
      label: "Invoice code",
      required: true,
      fieldKind: "one_time_code",
      control: { tagName: "INPUT", inputType: "text" },
    },
  ];
}
async function openForm() {
  click(await screen.findByText("Enter information", { selector: "button" }));
  return within(await screen.findByRole("dialog"));
}
test("chat-capability-browser-actions-010 the reopened billing form keeps its email and clears both secrets", async () => {
  await openConversation(loginFields(), [path]);
  const dialog = await openForm();
  const email = dialog.getByLabelText("Billing email");
  const secret = dialog.getByLabelText("Billing password");
  const code = dialog.getByLabelText("Invoice code");
  expect(email.closest("form")).toHaveAttribute("autocomplete", "off");
  expect(email).toHaveAttribute("autocomplete", "off");
  expect(secret).toHaveAttribute("autocomplete", "off");
  expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await fill(email, "billing@example.test");
  await fill(secret, "private draft");
  await fill(code, "632271");
  expect(secret).toHaveValue("private draft");
  expect(code).toHaveValue("632271");
  click(dialog.getByText("Use a saved password"));
  await expect(
    dialog.findByText(/Right-click the username or password field/),
  ).resolves.toBeVisible();
  click(dialog.getByLabelText("Close"));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const reopened = await openForm();
  expect(reopened.getByLabelText("Billing email")).toHaveValue(
    "billing@example.test",
  );
  expect(reopened.getByLabelText("Billing password")).toHaveValue("");
  expect(reopened.getByLabelText("Invoice code")).toHaveValue("");
  expect(window.location.pathname).toBe(chatPath);
});
test("chat-capability-browser-actions-013 confirming already checked consent continues the conversation", async () => {
  const consent: Field = {
    key: "consent",
    label: "Allow local invoice import",
    required: true,
    fieldKind: "checkbox",
    control: {
      tagName: "INPUT",
      inputType: "checkbox",
      siteRequired: false,
      checked: true,
    },
  };
  const req = await openConversation([consent], [path]);
  const dialog = await openForm();
  await waitFor(() => {
    expect(dialog.getByRole("checkbox", { name: consent.label })).toBeChecked();
  });
  const confirm = dialog.getByText("Add to browser", { selector: "button" });
  expect(confirm).toBeEnabled();
  click(confirm);
  await screen.findByText("Agent notified");
  await expect(req.applied.promise).resolves.toStrictEqual([
    { key: "consent", checked: true, observedChecked: true },
  ]);
  await expect(req.callback.promise).resolves.toMatchObject({
    threadId,
    prompt: callbackPrompt,
    state: "succeeded",
  });
  expect(window.location.pathname).toBe(chatPath);
});
test("chat-capability-browser-actions-016 confirming a four-byte document transfers the selected bytes and continues this chat", async () => {
  const fingerprint = "b".repeat(64);
  const documentField: Field = {
    key: "document",
    label: "Document",
    required: true,
    fieldKind: "file",
    control: {
      tagName: "INPUT",
      inputType: "file",
      accept: ".txt",
      files: [],
      fileSetFingerprint: fingerprint,
    },
  };
  const uploads: { bytes: string; credentials: string }[] = [];
  const prepared: { key: string; index: number; size: number }[] = [];
  const url = "https://upload.example.test/billing-document";
  const req = await openConversation([documentField], [path], {
    arrange: () => {
      context.mocks.api(
        browserUserActionsContract.prepareFileUpload,
        ({ body, respond }) => {
          prepared.push(body);
          return respond(200, { uploadUrl: url });
        },
      );
      context.mocks.http.put(url, async ({ request }) => {
        uploads.push({
          bytes: await request.text(),
          credentials: request.credentials,
        });
        return new HttpResponse(null, { status: 200 });
      });
    },
  });
  const dialog = await openForm();
  const file = dialog.getByLabelText("Document", {
    selector: 'input[type="file"]',
  });
  await waitFor(() => {
    expect(file).toHaveAttribute("accept", ".txt");
  });
  const confirm = dialog.getByText("Add to browser", { selector: "button" });
  expect(confirm).toBeDisabled();
  fireEvent.change(file, {
    target: { files: [new File(["note"], "note.txt", { type: "text/plain" })] },
  });
  await waitFor(() => {
    expect(confirm).toBeEnabled();
  });
  expect(prepared).toStrictEqual([]);
  expect(uploads).toStrictEqual([]);
  click(confirm);
  await screen.findByText("Agent notified");
  expect(prepared).toStrictEqual([{ key: "document", index: 0, size: 4 }]);
  expect(uploads).toStrictEqual([{ bytes: "note", credentials: "omit" }]);
  await expect(req.applied.promise).resolves.toStrictEqual([
    {
      key: "document",
      observedFingerprint: fingerprint,
      operation: "replace",
      files: [{ name: "note.txt", type: "text/plain", size: 4 }],
    },
  ]);
  await expect(req.callback.promise).resolves.toMatchObject({
    threadId,
    prompt: callbackPrompt,
    state: "succeeded",
  });
  expect(window.location.pathname).toBe(chatPath);
});
test("chat-capability-browser-actions-022 browser history leaves the request and clears the password on return", async () => {
  await openConversation([loginFields()[1]!], [path], {
    startPath: "/connectors",
  });
  const conversation = await waitFor(() => {
    const link = queryAllByRoleFast("link").find((el) => {
      return el.getAttribute("href") === chatPath;
    });
    expect(link).toBeDefined();
    return link!;
  });
  click(conversation);
  const dialog = await openForm();
  await fill(dialog.getByLabelText("Billing password"), "local-only draft");
  expect(dialog.getByLabelText("Billing password")).toHaveValue(
    "local-only draft",
  );
  window.history.back();
  await waitFor(() => {
    expect(window.location.pathname).toBe("/connectors");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(
    screen.queryByDisplayValue("local-only draft"),
  ).not.toBeInTheDocument();
  window.history.forward();
  const reopened = await openForm();
  expect(window.location.pathname).toBe(chatPath);
  expect(reopened.getByLabelText("Billing password")).toHaveValue("");
});

test.each([
  { id: "008", task: true },
  { id: "009", task: false },
])(
  "chat-capability-browser-actions-$id task context and edited notes survive a live field change and a companion receipt",
  async ({ task }) => {
    const notes: Field = {
      key: "notes",
      label: "Notes",
      required: true,
      fieldKind: "text",
      control: { tagName: "INPUT", inputType: "text" },
    };
    const companionToken = "vm0_browser_user_action_" + "d".repeat(43);
    const companionPath = path.replace("c".repeat(43), "d".repeat(43));
    const inspected = context.mocks.deferred<void>();
    const title = "Reconcile invoice";
    const reason = "The billing system needs a note";
    const options = task ? { title, reason } : {};
    let quantityMin = "1";
    let companionDone = false;
    const req = await openConversation([notes], [path, companionPath], {
      initial: options,
      arrange: ({ record }) => {
        context.mocks.api(
          browserUserActionsContract.get,
          ({ params, respond }) => {
            if (params.requestToken === companionToken) {
              return respond(200, {
                ...record,
                requestToken: companionToken,
                title: "Check delivery address",
                state: companionDone ? "succeeded" : "pending",
                callbackDelivered: false,
              });
            }
            return respond(200, record);
          },
        );
        context.mocks.api(
          browserUserActionsContract.preflight,
          async ({ respond }) => {
            await inspected.promise;
            return respond(200, {
              ...record,
              fields: [
                {
                  ...notes,
                  control: { tagName: "TEXTAREA", inputType: "textarea" },
                },
                {
                  key: "qty",
                  label: "Quantity",
                  required: false,
                  fieldKind: "number",
                  control: {
                    tagName: "INPUT",
                    inputType: "number",
                    min: quantityMin,
                  },
                },
              ],
            });
          },
        );
      },
    });
    const cardTitle = task ? title : "Enter information in browser";
    const first = await screen.findByText(cardTitle);
    const card = first.closest<HTMLElement>(
      '[data-testid="browser-user-action-card"]',
    )!;
    const companion = (
      await screen.findByText("Check delivery address")
    ).closest<HTMLElement>('[data-testid="browser-user-action-card"]')!;
    click(within(card).getByText("Enter information", { selector: "button" }));
    const modal = await screen.findByRole("dialog");
    const dialog = within(modal);
    expect(dialog.getByText(cardTitle, { selector: "h2" })).toBeInTheDocument();
    const description = modal.querySelector('[data-slot="dialog-description"]');
    expect(description?.textContent ?? null).toBe(task ? reason : null);
    await fill(
      dialog.getByLabelText("Notes", { selector: "input" }),
      "Verify delivery",
    );
    inspected.resolve();
    await expect(
      dialog.findByLabelText("Notes", { selector: "textarea" }),
    ).resolves.toHaveValue("Verify delivery");
    expect(dialog.getByLabelText("Quantity")).toHaveAttribute("min", "1");
    companionDone = true;
    req.announce();
    await within(companion).findByText("Information added");
    expect(dialog.getByLabelText("Notes")).toHaveValue("Verify delivery");
    expect(window.location.pathname).toBe(chatPath);
    click(dialog.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    quantityMin = "2";
    const again = await openForm();
    await waitFor(() => {
      expect(again.getByLabelText("Quantity")).toHaveAttribute("min", "2");
    });
    await fill(again.getByLabelText("Notes"), "Ready");
    click(again.getByText("Add to browser", { selector: "button" }));
    await within(card).findByText("Agent notified");
    await expect(req.applied.promise).resolves.toContainEqual({
      key: "notes",
      value: "Ready",
    });
    await expect(req.callback.promise).resolves.toMatchObject({
      threadId,
      prompt: callbackPrompt,
      state: "succeeded",
    });
    expect(
      screen.queryByText("Enter information", { selector: "button" }),
    ).toBeNull();
    expect(window.location.pathname).toBe(chatPath);
  },
);

const firstShot = "https://cdn.okou.io/invoices/research-first.png?sig=first";
const pausedShot =
  "https://invoice-images.r2.cloudflarestorage.com/snapshots/research-paused.png?X-Amz-Credential=invoices%2Fresearch&X-Amz-Signature=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
function managedBrowser(initial: "active" | "suspended" = "active") {
  const { viewer, cdp } = arrangeNativePage(context);
  const live = {
    ...viewer.browser,
    name: "Research",
    screenshotUrl: firstShot,
    liveUrl: "https://live.example.test/research",
  };
  const { window: activeWindow, ...details } = live;
  const paused: BrowserSession = {
    ...details,
    status: "suspended",
    screenshotUrl: pausedShot,
    liveUrl: null,
    suspensionReason: "idle",
    suspendedAt: "2026-09-01T10:00:00Z",
  };
  let session: BrowserSession = initial === "active" ? live : paused;
  const runId = crypto.randomUUID();
  const tid = live.threadId;
  createChatRunFixtures(context).installRunChat({
    threadId: tid,
    cloudBrowserEnabled: true,
    chatEvents: [
      assistantEvent({
        id: "research-browser",
        seqId: 1,
        runId,
        text: live.viewerUrl,
      }),
      completedEvent({ id: "research-done", seqId: 2, runId }),
    ],
  });
  function acquisition() {
    return {
      browser: session,
      viewer:
        session.status === "active" ? { ...viewer, browser: session } : null,
    };
  }
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(200, acquisition());
  });
  context.mocks.api(browserContract.open, ({ respond }) => {
    return respond(200, acquisition());
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: session });
  });
  return {
    tid,
    cdp,
    open: (panel: boolean, transport: "direct" | "message-port" = "direct") => {
      return setupPage({
        context,
        host: "app.okou.ai",
        path: "/chats/" + tid,
        featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: panel },
        sharedWorkerTestTransport: transport,
      });
    },
    pause: () => {
      session = paused;
    },
    resume: () => {
      session = {
        ...live,
        window: activeWindow,
        liveUrl: "https://live.example.test/resumed",
      };
    },
    announce: () => {
      context.mocks.ably.trigger("browserSessionChanged", { threadId: tid });
    },
  };
}
async function checkPreview(state: string, filename: string) {
  const card = await screen.findByLabelText("Open Research browser", {
    selector: "button",
  });
  await waitFor(() => {
    expect(within(card).getByText(state)).toBeInTheDocument();
    expect(
      within(card).getByTestId("browser-session-thumbnail").getAttribute("src"),
    ).toContain(filename);
  });
  return card;
}
test("chat-capability-browser-actions-002 a delayed subscription and interrupted connection restore the matching Research snapshot", async () => {
  const browser = managedBrowser();
  const subscription = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "browserSessionChanged",
  );
  await browser.open(true, "message-port");
  await checkPreview("Live", "research-first.png?sig=first");
  await subscription.started;
  browser.pause();
  subscription.attach();
  const channel = "user:test-user-123";
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscriptionOnChannel(
        channel,
        "browserSessionChanged",
      ),
    ).toBeTruthy();
  });
  context.mocks.ably.triggerOnChannel(channel, "browserSessionChanged", {
    threadId: browser.tid,
  });
  await checkPreview("Stopped", "research-paused.png?X-Amz-Credential=");
  context.mocks.ably.triggerSharedWorkerConnectionState("suspended");
  browser.resume();
  context.mocks.ably.triggerSharedWorkerReconnect();
  await waitFor(() => {
    const restored = screen.getByLabelText("Open Research browser", {
      selector: "button",
    });
    expect(within(restored).getByText("Live")).toBeInTheDocument();
    expect(
      within(restored).getByTestId("browser-session-thumbnail"),
    ).toHaveAttribute(
      "src",
      expect.stringContaining("research-first.png?sig=first"),
    );
  });
});
test("chat-capability-browser-actions-003 the paused Research panel offers a restart and preserves its signed preview", async () => {
  const browser = managedBrowser("suspended");
  await browser.open(false);
  const card = await checkPreview(
    "Stopped",
    "research-paused.png?X-Amz-Credential=",
  );
  click(card);
  const panel = within(
    await screen.findByRole("complementary", { name: "Cloud browser" }),
  );
  await panel.findByText("Browser not live");
  const preview = within(card)
    .getByTestId("browser-session-thumbnail")
    .getAttribute("src");
  expect(preview).toMatch(
    /^https:\/\/a\.okou\.io\/cdn-cgi\/image\/[^/]*width=800[^/]*\//u,
  );
  expect(preview?.endsWith("/" + pausedShot)).toBeTruthy();
  expect(
    panel.getByText("Start browser", { selector: "button" }),
  ).toBeEnabled();
  expect(panel.getByLabelText("Close cloud browser")).toBeEnabled();
  expect(
    panel.getByLabelText("Open this browser in a new page"),
  ).toHaveAttribute("href", "/browsers/" + browser.tid);
  expect(panel.getByLabelText("Remote browser input")).toBeDisabled();
});
test("chat-capability-browser-actions-005 the example page follows its live, stopped and resumed Research session", async () => {
  const browser = managedBrowser();
  await browser.open(true);
  const firstFrame = browser.cdp.holdTargetFrames("example-page");
  const card = await checkPreview("Live", "research-first.png?sig=first");
  click(card);
  const panel = within(
    await screen.findByRole("complementary", { name: "Cloud browser" }),
  );
  await firstFrame.received;
  expect(panel.queryByRole("img", { name: "Live browser view" })).toBeNull();
  firstFrame.release("QUJD");
  await waitFor(() => {
    expect(panel.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(panel.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(
    panel.getByRole("img", { name: "Live browser view" }),
  ).toBeInTheDocument();
  browser.pause();
  browser.announce();
  await checkPreview("Stopped", "research-paused.png");
  await panel.findByText("Browser not live");
  expect(panel.getByLabelText("Remote browser input")).toBeDisabled();
  expect(
    panel.getByText("Start browser", { selector: "button" }),
  ).toBeEnabled();
  browser.resume();
  browser.announce();
  await checkPreview("Live", "research-first.png");
  await waitFor(() => {
    expect(panel.getByLabelText("Address")).toHaveValue("https://example.com");
    expect(panel.getByLabelText("Remote browser input")).toBeEnabled();
  });
});

test("chat-capability-browser-actions-001 the Research card exposes its live thumbnail and specified visual metrics", async () => {
  const css = document.createElement("style");
  css.textContent = cardStyles;
  document.head.append(css);
  context.signal.addEventListener(
    "abort",
    () => {
      css.remove();
    },
    { once: true },
  );
  const browser = managedBrowser();
  await browser.open(true);
  const card = await checkPreview("Live", "research-first.png?sig=first");
  expect(within(card).getByText("Cloud browser")).toBeInTheDocument();
  const style = getComputedStyle(card);
  expect(style.borderTopWidth).toBe("1px");
  expect(
    style.transitionProperty.split(",").map((property) => {
      return property.trim();
    }),
  ).toStrictEqual(
    expect.arrayContaining(["background-color", "border-color", "transform"]),
  );
  expect(getComputedStyle(within(card).getByText("Live")).lineHeight).toBe(
    "16px",
  );
});
