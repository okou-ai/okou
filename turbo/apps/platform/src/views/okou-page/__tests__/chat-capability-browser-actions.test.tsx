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
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findButton,
  findEnabledButton,
  queryButton,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const path = browserInputPath();
async function openConversation(
  fields: Field[],
  messages: string[],
  options: {
    arrange?: (request: ReturnType<typeof installBrowserRequest>) => void;
    initial?: Parameters<typeof installBrowserRequest>[2];
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
  const request = installBrowserRequest(context, fields, options.initial);
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
  click(await findButton("Enter information"));
  return screen.findByRole("dialog");
}
test("chat-capability-browser-actions-010 the reopened billing form keeps its email and clears both secrets", async () => {
  await openConversation(loginFields(), [path]);
  const form = await openForm();
  const dialog = within(form);
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
  click(await findEnabledButton("Close", form));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  const reopened = within(await openForm());
  expect(reopened.getByLabelText("Billing email")).toHaveValue(
    "billing@example.test",
  );
  expect(reopened.getByLabelText("Billing password")).toHaveValue("");
  expect(reopened.getByLabelText("Invoice code")).toHaveValue("");
  expect(window.location.pathname).toBe(chatPath);
});
test("Two cards for the same input request expose one modal editor at a time", async () => {
  await openConversation(loginFields(), [path, "https://app.okou.ai" + path]);
  const triggers = await waitFor(() => {
    const buttons = queryAllByRoleFast("button").filter((button) => {
      return button.textContent?.trim() === "Enter information";
    });
    expect(buttons).toHaveLength(2);
    return buttons;
  });
  click(triggers[0]!);
  const first = await screen.findByRole("dialog");
  const fields = within(first);
  await fill(fields.getByLabelText("Billing email"), "review@example.test");
  await fill(
    fields.getByLabelText("Billing password"),
    "draft for this review",
  );
  await fill(fields.getByLabelText("Invoice code"), "431902");
  expect(queryButton("Enter information")).toBeNull();
  expect(fields.getByLabelText("Invoice code")).toHaveValue("431902");
  click(await findEnabledButton("Close", first));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(triggers[1]!);
  const second = within(await screen.findByRole("dialog"));
  expect(second.getByLabelText("Billing email")).toHaveValue(
    "review@example.test",
  );
  expect(second.getByLabelText("Billing password")).toHaveValue("");
  expect(second.getByLabelText("Invoice code")).toHaveValue("");
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
  const form = await openForm();
  const dialog = within(form);
  await waitFor(() => {
    expect(dialog.getByRole("checkbox", { name: consent.label })).toBeChecked();
  });
  const confirm = queryButton("Add to browser", form)!;
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
  const form = await openForm();
  const dialog = within(form);
  const file = dialog.getByLabelText("Document", {
    selector: 'input[type="file"]',
  });
  await waitFor(() => {
    expect(file).toHaveAttribute("accept", ".txt");
  });
  const confirm = queryButton("Add to browser", form)!;
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
  const form = await openForm();
  const dialog = within(form);
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
  const reopened = within(await openForm());
  expect(window.location.pathname).toBe(chatPath);
  expect(reopened.getByLabelText("Billing password")).toHaveValue("");
});

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
    open: (panel: boolean) => {
      return setupPage({
        context,
        host: "app.okou.ai",
        path: "/chats/" + tid,
        featureSwitches: { [FeatureSwitchKey.CloudBrowserPanel]: panel },
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
  const card = await findButton("Open Research browser");
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
  await browser.open(true);
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
  context.mocks.ably.triggerConnectionState("suspended");
  browser.resume();
  context.mocks.ably.triggerReconnect();
  await waitFor(() => {
    const restored = queryButton("Open Research browser")!;
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
  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  const panel = within(sidebar);
  await panel.findByText("Browser not live");
  const preview = within(card)
    .getByTestId("browser-session-thumbnail")
    .getAttribute("src");
  expect(preview).toMatch(
    /^https:\/\/a\.okou\.io\/cdn-cgi\/image\/[^/]*width=800[^/]*\//u,
  );
  expect(preview?.endsWith("/" + pausedShot)).toBeTruthy();
  expect(queryButton("Start browser", sidebar)).toBeEnabled();
  expect(queryButton("Close cloud browser", sidebar)).toBeEnabled();
  expect(
    queryAllByRoleFast("link", sidebar).find((link) => {
      return (
        link.getAttribute("aria-label") === "Open this browser in a new page"
      );
    }),
  ).toHaveAttribute("href", "/browsers/" + browser.tid);
  expect(panel.getByLabelText("Remote browser input")).toBeDisabled();
});
test("chat-capability-browser-actions-005 the example page follows its live, stopped and resumed Research session", async () => {
  const browser = managedBrowser();
  await browser.open(true);
  const firstFrame = browser.cdp.holdTargetFrames("example-page");
  const card = await checkPreview("Live", "research-first.png?sig=first");
  click(card);
  const sidebar = await screen.findByRole("complementary", {
    name: "Cloud browser",
  });
  const panel = within(sidebar);
  await firstFrame.received;
  expect(panel.queryByRole("img", { name: "Live browser view" })).toBeNull();
  expect(within(card).getByTestId("browser-session-thumbnail")).toHaveAttribute(
    "src",
    expect.stringMatching(
      /^https:\/\/cdn\.okou\.io\/cdn-cgi\/image\/[^/]+\/invoices\/research-first\.png\?sig=first$/u,
    ),
  );
  // The viewer requests a WebP screencast. Deliver a complete first image.
  firstFrame.release("UklGRhwAAABXRUJQVlA4TA8AAAAvD8ADAAcQ0f/+ByKi/wEA");
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
  expect(queryButton("Start browser", sidebar)).toBeEnabled();
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

test.each(["explained", "historical"] as const)(
  "Submitting the %s Notes dialog leaves the completed request in the conversation",
  async (version) => {
    const notes: Field = {
      key: "notes",
      label: "Notes",
      fieldKind: "text",
      required: true,
      control: { tagName: "INPUT", inputType: "text" },
    };
    const companionToken = "vm0_browser_user_action_" + "d".repeat(43);
    const originalUrl = new URL(path, "https://app.okou.ai");
    const otherUrl = new URL(originalUrl);
    otherUrl.pathname = "/browser/actions/" + companionToken;
    const inspecting = context.mocks.deferred<void>(),
      checked = context.mocks.deferred<void>();
    let finishedCompanion = false,
      reopened = false;
    const task = {
      title: "Update release notes",
      reason: "Add the signed-off text to the release form.",
    };
    const request = await openConversation(
      [notes],
      [originalUrl.href, otherUrl.href],
      {
        initial: version === "explained" ? task : {},
        arrange(primary) {
          context.mocks.api(
            browserUserActionsContract.get,
            ({ params, respond }) => {
              return params.requestToken === companionToken
                ? respond(200, {
                    ...primary.record,
                    requestToken: companionToken,
                    title: "Companion approval",
                    callbackDelivered: false,
                    state: finishedCompanion ? "succeeded" : "pending",
                  })
                : respond(200, primary.record);
            },
          );
          context.mocks.api(
            browserUserActionsContract.preflight,
            async ({ respond }) => {
              if (!inspecting.settled()) {
                inspecting.resolve();
              }
              await checked.promise;
              return respond(200, {
                ...primary.record,
                fields: [
                  {
                    ...notes,
                    control: { tagName: "TEXTAREA", inputType: "textarea" },
                  },
                  {
                    key: "qty",
                    label: reopened ? "Updated quantity" : "Quantity",
                    fieldKind: "number",
                    required: false,
                    control: { tagName: "INPUT", inputType: "number" },
                  },
                ],
              });
            },
          );
        },
      },
    );
    await waitFor(() => {
      return expect(
        screen.getAllByText("Enter information", { selector: "button" }),
      ).toHaveLength(2);
    });
    const primaryButton = screen.getAllByText("Enter information", {
      selector: "button",
    })[0]!;
    const primaryAnswer = primaryButton.closest<HTMLElement>(
      '[data-role="assistant"]',
    )!;
    click(primaryButton);
    const dialog = await screen.findByRole("dialog");
    const form = within(dialog);
    expect(form.getByRole("heading")).toHaveTextContent(
      version === "explained" ? task.title : "Enter information in browser",
    );
    expect(form.queryAllByText(task.reason)).toHaveLength(
      version === "explained" ? 1 : 0,
    );
    await inspecting.promise;
    await fill(
      form.getByLabelText("Notes", { selector: "input" }),
      "Draft notes",
    );
    checked.resolve();
    await expect(
      form.findByLabelText("Notes", { selector: "textarea" }),
    ).resolves.toHaveValue("Draft notes");
    await form.findByLabelText("Quantity");
    finishedCompanion = true;
    request.announce();
    await screen.findByText("Information added");
    expect(dialog).toBeVisible();
    click(await findEnabledButton("Close", dialog));
    reopened = true;
    click(await screen.findByText("Enter information", { selector: "button" }));
    const again = await screen.findByRole("dialog");
    await within(again).findByLabelText("Updated quantity");
    await fill(within(again).getByLabelText("Notes"), "Ready");
    click(await findEnabledButton("Add to browser", again));
    await screen.findByText("Agent notified");
    expect(
      within(primaryAnswer).getByText("Agent notified"),
    ).toBeInTheDocument();
    expect(queryButton("Enter information", primaryAnswer)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Information added")).toBeInTheDocument();
    expect(location.pathname).toBe("/chats/" + threadId);
    await expect(request.applied.promise).resolves.toContainEqual({
      key: "notes",
      value: "Ready",
    });
    await expect(request.callback.promise).resolves.toMatchObject({
      threadId,
      prompt: callbackPrompt,
    });
  },
);
