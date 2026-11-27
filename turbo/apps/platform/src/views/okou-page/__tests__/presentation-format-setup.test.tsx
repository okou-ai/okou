import {
  chatEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  userPreferencesContract,
  type UpdateUserPreferencesRequest,
  type UserPreferencesResponse,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor, THREAD_ID } from "./chat-composer-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  openTemplateRecommendations,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import {
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();
const features = Object.freeze({
  [FeatureSwitchKey.PresentationOutputFormat]: true,
});
const menuTitle = "Choose your default presentation format";

function control(
  role: "button" | "menuitem" | "radio",
  name: string,
  container: ParentNode = document.body,
) {
  const found = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!found) {
    throw new Error(`Expected ${role} ${name}`);
  }
  return found;
}

function mockPreferences(
  options: {
    saveGate?: Promise<void>;
    failFirstSave?: boolean;
    sendMode?: "enter" | "cmd-enter";
  } = {},
) {
  let stored: UserPreferencesResponse = {
    timezone: "Etc/UTC",
    locale: "en-US",
    supportedLocales: ["en-US"],
    sendMode: options.sendMode ?? "enter",
    cloudBrowserEnabledByDefault: false,
    chatResourcesEnabledByDefault: false,
    presentationFormat: null,
    forYouCoverId: null,
    theme: "system",
    colorTheme: null,
    captureNetworkBodiesRemaining: 0,
    memoryInitialized: true,
  };
  context.mocks.data.userPreferences(stored);
  context.mocks.api(userPreferencesContract.get, ({ respond }) => {
    return respond(200, stored);
  });
  const writes: UpdateUserPreferencesRequest[] = [];
  const requested = context.mocks.deferred<UpdateUserPreferencesRequest>();
  context.mocks.api(
    userPreferencesContract.update,
    async ({ body, respond, withSignal }) => {
      writes.push(body);
      if (!requested.settled()) {
        requested.resolve(body);
      }
      if (options.saveGate) {
        await withSignal(options.saveGate);
      }
      if (options.failFirstSave && writes.length === 1) {
        return respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Preference save failed",
          },
        });
      }
      stored = { ...stored, ...body };
      context.mocks.data.userPreferences(stored);
      return respond(200, stored);
    },
  );
  return { writes, requested };
}

async function openPresentation() {
  const capabilities = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  click(control("button", "Presentation", capabilities));
  return await screen.findByRole("combobox", { name: "Slide count" });
}

async function openSetup() {
  await waitFor(() => {
    return expect(control("button", "Send")).toBeEnabled();
  });
  click(control("button", "Send"));
  return await screen.findByRole("menu", { name: menuTitle });
}

function text(message: UserMessageDocument | undefined) {
  return message?.parts
    .flatMap((part) => {
      return part.type === "text" ? [part.text] : [];
    })
    .join("")
    .trim();
}

test.each(["html", "pptx"] as const)(
  "Choosing %s saves the member default and sends the unchanged draft once",
  async (format) => {
    const preferences = mockPreferences();
    const capture = createTemplateGalleryHelpers(context).mockTemplateChat();
    await setupPage({ context, path: "/", featureSwitches: features });
    const editor = await findComposerEditor();
    const slides = await openPresentation();
    click(slides);
    click(await screen.findByRole("option", { name: "4–8 slides" }));
    const prompt = "Create the launch deck; use HTML for this request";
    await fill(editor, prompt);
    const menu = await openSetup();
    expect(editor).toHaveTextContent(prompt);
    expect(slides).toHaveTextContent("4–8 slides");
    expect(preferences.writes).toStrictEqual([]);
    expect(capture.sentMessages).toStrictEqual([]);
    const choice = control(
      "menuitem",
      format === "html" ? "Web slides" : "PowerPoint",
      menu,
    );
    click(choice);
    click(choice);
    await screen.findByText(prompt, { selector: "[data-role=user] *" });
    await waitFor(() => {
      return expect(capture.sentMessages).toHaveLength(1);
    });
    expect(preferences.writes).toStrictEqual([{ presentationFormat: format }]);
    expect(text(capture.sentMessages[0])).toBe(prompt);
    expect(capture.sentMessages[0]?.parts).toContainEqual({
      type: "additional_info",
      text: expect.stringContaining("- Slide count: 4-8"),
    });
    expect(capture.runPrompts).toStrictEqual([prompt]);
    await screen.findByText("Default presentation format saved.");
  },
);

test("Escape and Cancel leave the original draft and attachments ready at Send without saving", async () => {
  const preferences = mockPreferences();
  const capture = createTemplateGalleryHelpers(context).mockTemplateChat();
  const file = new File(["Source"], "brief.txt", { type: "text/plain" });
  context.mocks.upload.success({
    id: "30000000-0000-4000-8000-000000000023",
    filename: file.name,
    size: file.size,
    contentType: file.type,
    url: "/artifacts/30000000000040008000000000000023.txt",
  });
  await setupPage({ context, path: "/", featureSwitches: features });
  const editor = await findComposerEditor();
  await openPresentation();
  await fill(editor, "Keep the original briefing");
  await userEvent.upload(
    await screen.findByLabelText("Attach", { selector: 'input[type="file"]' }),
    file,
  );
  await screen.findByLabelText("Remove brief.txt");
  await openSetup();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(
      screen.queryByRole("menu", { name: menuTitle }),
    ).not.toBeInTheDocument();
    expect(control("button", "Send")).toHaveFocus();
  });
  expect(editor).toHaveTextContent("Keep the original briefing");
  expect(screen.getByLabelText("Remove brief.txt")).toBeEnabled();
  const reopened = await openSetup();
  click(control("menuitem", "Cancel", reopened));
  await waitFor(() => {
    return expect(
      screen.queryByRole("menu", { name: menuTitle }),
    ).not.toBeInTheDocument();
  });
  expect(preferences.writes).toStrictEqual([]);
  expect(capture.sentMessages).toStrictEqual([]);
});

test("A failed save keeps setup and the draft, then an explicit retry sends once after confirmation", async () => {
  const release = context.mocks.deferred<void>();
  const preferences = mockPreferences({
    saveGate: release.promise,
    failFirstSave: true,
  });
  const capture = createTemplateGalleryHelpers(context).mockTemplateChat();
  await setupPage({ context, path: "/", featureSwitches: features });
  const editor = await findComposerEditor();
  await openPresentation();
  await fill(editor, "Retain this draft until saving succeeds");
  const menu = await openSetup();
  click(control("menuitem", "PowerPoint", menu));
  await preferences.requested.promise;
  expect(capture.sentMessages).toStrictEqual([]);
  await within(menu).findByRole("status");
  expect(control("button", "Send")).toBeDisabled();
  release.resolve();
  await within(menu).findByRole("alert");
  expect(editor).toHaveTextContent("Retain this draft until saving succeeds");
  expect(capture.sentMessages).toStrictEqual([]);
  click(control("menuitem", "PowerPoint", menu));
  await screen.findByText("Retain this draft until saving succeeds", {
    selector: "[data-role=user] *",
  });
  await waitFor(() => {
    return expect(capture.sentMessages).toHaveLength(1);
  });
  expect(preferences.writes).toStrictEqual([
    { presentationFormat: "pptx" },
    { presentationFormat: "pptx" },
  ]);
});

test("A saved default survives a rejected send and resubmitting does not resave", async () => {
  const preferences = mockPreferences();
  createTemplateGalleryHelpers(context).mockTemplateChat();
  const sends: (string | undefined)[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sends.push(body.prompt);
    return respond(400, {
      error: { code: "BAD_REQUEST", message: "Message was not accepted" },
    });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: features,
  });
  await clickComposerAddMenuItem("Create");
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  click(control("radio", "Presentation", types));
  await screen.findByRole("combobox", { name: "Slide count" });
  const prompt = "Send this original request";
  await fill(await findComposerEditor(), prompt);
  click(control("menuitem", "PowerPoint", await openSetup()));
  await screen.findByText("Message was not accepted");
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "pptx" }]);
  expect(sends).toStrictEqual([prompt]);
  // Normal optimistic sends clear the composer before HTTP acceptance.
  await fill(await findComposerEditor(), prompt);
  await waitFor(() => {
    return expect(control("button", "Send")).toBeEnabled();
  });
  click(control("button", "Send"));
  await waitFor(() => {
    return expect(sends).toStrictEqual([prompt, prompt]);
  });
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "pptx" }]);
});

test("Opening a side pane releases the retained composer's old send lock without aborting its request", async () => {
  const main = continuityThread(984, 1, "Main conversation");
  const side = continuityThread(984, 2, "Reference conversation");
  const workspace = installContinuityWorkspace(context, {
    caseId: 984,
    threads: [main, side],
  });
  const pending = context.mocks.deferred<void>();
  const received = context.mocks.deferred<void>();
  const firstPrompt = "Keep this send running across navigation";
  const nextPrompt = "Send from the new composer owner";
  context.mocks.api(
    chatEventsContract.send,
    async ({ body, respond, withSignal }) => {
      const first = body.prompt === firstPrompt;
      if (first) {
        received.resolve();
        await withSignal(pending.promise);
      }
      return respond(400, {
        error: {
          code: "BAD_REQUEST",
          message: first
            ? "Original send finished after navigation"
            : "Follow-up send reached the server",
        },
      });
    },
  );
  await setupPage({
    context,
    ...workspace.pageOptions,
    path: `/chats/${main.id}`,
    featureSwitches: { [FeatureSwitchKey.PresentationOutputFormat]: false },
  });
  try {
    await fill(await findComposerEditor(), firstPrompt);
    await waitFor(() => {
      return expect(control("button", "Send")).toBeEnabled();
    });
    click(control("button", "Send"));
    await received.promise;

    fireEvent.click(continuitySidebarLink(side.id), { altKey: true });
    await screen.findByText("Reference conversation", {
      selector: '[data-testid="chat-thread-header-title"]',
    });
    expect(location.pathname).toBe(`/chats/${main.id}`);
    expect(new URLSearchParams(location.search).get("sidebar")).toBe(side.id);

    const editor = await findComposerEditor();
    const composer = editor.closest('[data-slot="chat-composer-card"]')!;
    await fill(editor, nextPrompt);
    await waitFor(() => {
      return expect(control("button", "Send", composer)).toBeEnabled();
    });
    click(control("button", "Send", composer));
    await screen.findByText("Follow-up send reached the server");

    pending.resolve();
    await screen.findByText("Original send finished after navigation");
  } finally {
    if (!pending.settled()) {
      pending.resolve();
    }
  }
});

test.each(["enter", "cmd-enter"] as const)(
  "The %s keyboard shortcut uses the same setup admission, while IME Enter keeps editing",
  async (sendMode) => {
    mockPreferences({ sendMode });
    context.mocks.browser.userAgent("Mozilla/5.0 (X11; Linux x86_64)");
    createTemplateGalleryHelpers(context).mockTemplateChat();
    await setupPage({ context, path: "/", featureSwitches: features });
    const editor = await findComposerEditor();
    await openPresentation();
    await fill(editor, "Keep composing this presentation");
    await userEvent.click(editor);
    await userEvent.keyboard(
      sendMode === "enter" ? "{Enter}" : "{Control>}{Enter}{/Control}",
    );
    await screen.findByRole("menu", { name: menuTitle });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      return expect(control("button", "Send")).toHaveFocus();
    });
    await userEvent.click(editor);
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    expect(editor).toHaveFocus();
    expect(
      screen.queryByRole("menu", { name: menuTitle }),
    ).not.toBeInTheDocument();
    fireEvent.compositionEnd(editor, { data: "" });
    // A normal button activation remains available after composition completes.
    click(control("button", "Send"));
    const menu = await screen.findByRole("menu", { name: menuTitle });
    expect(control("menuitem", "PowerPoint", menu)).toBeInTheDocument();
  },
);

test("Visualization Presentation queues through first-use setup without replacing the active run", async () => {
  const preferences = mockPreferences();
  const queued = context.mocks.deferred<UserMessageDocument | undefined>();
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "Review underway",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onQueuedEventAppend: (body) => {
      return queued.resolve(body.userMessage);
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: features,
  });
  await screen.findByText("Review underway");
  await clickComposerAddMenuItem("Create");
  const types = screen.getByRole("radiogroup", { name: "Create" });
  const chart = queryAllByRoleFast("radio", types).find((item) => {
    return item.textContent?.trim() === "Chart";
  });
  if (!chart) {
    throw new Error("Expected Chart task");
  }
  click(chart);
  const panel = await screen.findByRole("region", {
    name: "Visualization options",
  });
  click(control("button", "Presentation", panel));
  const prompt = "Visualize the quarterly figures after this run";
  await fill(await findComposerEditor(), prompt);
  const menu = await openSetup();
  expect(queued.settled()).toBeFalsy();
  click(control("menuitem", "Web slides", menu));
  expect(text(await queued.promise)).toBe(prompt);
  expect(preferences.writes).toStrictEqual([{ presentationFormat: "html" }]);
  await screen.findByText(prompt);
});

test("Stop remains available without asking for a presentation default", async () => {
  const preferences = mockPreferences();
  const stopped = context.mocks.deferred<void>();
  const runId = crypto.randomUUID();
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    activeRunIds: [runId],
    chatEvents: [
      {
        role: "user",
        content: "An active presentation",
        runId,
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
    onInterruptEventAppend: () => {
      return stopped.resolve();
    },
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: features,
  });
  await screen.findByText("An active presentation");
  await openTemplateRecommendations("Presentation");
  await fill(await findComposerEditor(), "");
  await waitFor(() => {
    return expect(control("button", "Stop")).toBeEnabled();
  });
  click(control("button", "Stop"));
  await stopped.promise;
  expect(preferences.writes).toStrictEqual([]);
  expect(
    screen.queryByRole("menu", { name: menuTitle }),
  ).not.toBeInTheDocument();
});
