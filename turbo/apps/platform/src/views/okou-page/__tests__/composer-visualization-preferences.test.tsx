import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
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
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const HOME_PATH = `/agents/${AGENT_ID}/chat`;
const THREAD_PATH = `/chats/${THREAD_ID}`;
const SUMMARY_NAME =
  /^(?:Charts(?::|$)|(?:Presentation|Website|Spreadsheet|Report)(?:, Charts:|$))/u;
const SPREADSHEET_BAR = "Spreadsheet, Charts: Bar chart";

function control(
  role: "button" | "menuitem" | "radio",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast(role, container).find((candidate) => {
    return (
      (candidate.getAttribute("aria-label") ??
        candidate.textContent?.trim()) === name
    );
  });
  if (!result) {
    throw new Error(`Expected ${role} named ${name}`);
  }
  return result;
}

function composerCard(editor: HTMLElement): HTMLElement {
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected the composer card");
  }
  return card;
}

function outputPicker(options: HTMLElement): HTMLElement {
  return within(options).getByRole("group", { name: "Output format" });
}

function chartPicker(options: HTMLElement): HTMLElement {
  return within(options).getByRole("group", { name: "Preferred charts" });
}

function draftSummaries(editor: HTMLElement): HTMLElement[] {
  return within(composerCard(editor)).queryAllByRole("group", {
    name: SUMMARY_NAME,
  });
}

async function expectSummary(
  editor: HTMLElement,
  name: string,
  text: RegExp,
): Promise<HTMLElement> {
  const summary = await within(composerCard(editor)).findByRole("group", {
    name,
  });
  expect(draftSummaries(editor)).toHaveLength(1);
  expect(summary).toHaveTextContent(text);
  return summary;
}

function expectUnselectedOptions(options: HTMLElement): void {
  for (const picker of [outputPicker(options), chartPicker(options)]) {
    expect(
      queryAllByRoleFast("button", picker).filter((button) => {
        return button.getAttribute("aria-pressed") === "true";
      }),
    ).toHaveLength(0);
  }
}

async function openThreadChartOptions(editor: HTMLElement) {
  const user = userEvent.setup({ delay: null });
  await user.click(control("button", "Add", composerCard(editor)));
  const menu = await screen.findByRole("menu", { name: "Add" });
  await user.click(control("menuitem", "Create", menu));
  const create = await screen.findByRole("radiogroup", { name: "Create" });
  click(control("radio", "Chart", create));
  return await screen.findByRole("region", { name: "Visualization options" });
}

async function sendDraft(editor: HTMLElement, prompt: string): Promise<void> {
  await fill(editor, prompt);
  await waitFor(() => {
    expect(control("button", "Send", composerCard(editor))).toBeEnabled();
  });
  click(control("button", "Send", composerCard(editor)));
}

async function expectOptionsDismissed(): Promise<void> {
  await waitFor(() => {
    expect(
      screen.queryByRole("region", { name: "Visualization options" }),
    ).toBeNull();
  });
}

function sentMessage(chat: HTMLElement, prompt: string): HTMLElement {
  const message = within(chat)
    .getByText(prompt)
    .closest<HTMLElement>('[data-role="user"]');
  if (!message) {
    throw new Error(`Expected the sent message for ${prompt}`);
  }
  return message;
}

async function setupCharts({
  homeCapabilities = false,
  visualizationSummary = true,
  path = HOME_PATH,
  sendGate,
  onRunCreate,
  rejectSend = false,
}: {
  readonly homeCapabilities?: boolean;
  readonly visualizationSummary?: boolean;
  readonly path?: string;
  readonly sendGate?: Promise<void>;
  readonly onRunCreate?: () => void;
  readonly rejectSend?: boolean;
} = {}) {
  const { lifecycle } = mockTemplateChat({ sendGate, onRunCreate });
  if (rejectSend) {
    context.mocks.api(chatEventsContract.send, async ({ respond }) => {
      if (sendGate) {
        await sendGate;
      }
      return respond(400, {
        error: { code: "BAD_REQUEST", message: "Message was not accepted" },
      });
    });
  }
  await setupPage({
    context,
    path: path === HOME_PATH ? `${path}?compose=1` : path,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: {
          id: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
          name: "Okou",
        },
        memberships: [],
      },
    },
    featureSwitches: {
      [FeatureSwitchKey.HomeCapabilities]: homeCapabilities,
      [FeatureSwitchKey.SingleAgent]: false,
      [FeatureSwitchKey.ChatMessageVisualizationSummary]: visualizationSummary,
    },
  });
  const editor = await findComposerEditor();
  if (path !== HOME_PATH) {
    return { editor, options: await openThreadChartOptions(editor), lifecycle };
  }
  const choices = await screen.findByRole("group", {
    name: homeCapabilities ? "Explore Okou capabilities" : "Choose a task",
  });
  click(control("button", "Chart", choices));
  const options = await screen.findByRole("region", {
    name: "Visualization options",
  });
  return { editor, options, lifecycle };
}

test("Chart choices produce one read-only summary with compact text and ordered full names", async () => {
  const { editor, options } = await setupCharts();
  const outputs = outputPicker(options);
  const charts = chartPicker(options);
  expect(
    control("button", "Remove Chart", composerCard(editor)),
  ).toBeInTheDocument();
  expect(draftSummaries(editor)).toHaveLength(0);

  click(control("button", "Spreadsheet", outputs));
  await expectSummary(editor, "Spreadsheet", /^Spreadsheet$/u);
  click(control("button", "Bar chart", charts));
  const summary = await expectSummary(
    editor,
    SPREADSHEET_BAR,
    /^Spreadsheet · Bar$/u,
  );
  expect(control("button", "Send", composerCard(editor))).toBeDisabled();
  expect(summary).not.toHaveAttribute("aria-haspopup");
  expect(queryAllByRoleFast("button", summary)).toHaveLength(0);
  const user = userEvent.setup({ delay: null });
  await user.click(summary);
  await user.keyboard("{Enter}");
  expect(
    screen.queryByRole("dialog", { name: "Visualization options" }),
  ).toBeNull();
  expect(screen.queryByRole("menu")).toBeNull();
  await user.click(editor);
  await user.keyboard("{Enter}");
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  expect(control("button", "Send", composerCard(editor))).toBeDisabled();
  expect(control("button", "Spreadsheet", outputs)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(control("button", "Bar chart", charts)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  click(control("button", "Spreadsheet", outputs));
  await expectSummary(editor, "Charts: Bar chart", /^Bar$/u);
  click(control("button", "Sankey diagram", charts));
  await expectSummary(
    editor,
    "Charts: Bar chart, Sankey diagram",
    /^Bar, Sankey$/u,
  );
  click(control("button", "Line chart", charts));
  await expectSummary(
    editor,
    "Charts: Bar chart, Sankey diagram, Line chart",
    /^Bar \+2$/u,
  );
  click(control("button", "Bar chart", charts));
  await expectSummary(
    editor,
    "Charts: Sankey diagram, Line chart",
    /^Sankey, Line$/u,
  );
  click(control("button", "Line chart", charts));
  await expectSummary(editor, "Charts: Sankey diagram", /^Sankey$/u);
  click(control("button", "Sankey diagram", charts));
  await waitFor(() => {
    expect(control("button", "Sankey diagram", charts)).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(draftSummaries(editor)).toHaveLength(0);
  });
});

test("Removing Chart and choosing another task remembers its choices for the draft", async () => {
  const { editor, options } = await setupCharts();
  const draft = "Keep my quarterly analysis draft.";
  await fill(editor, draft);
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);

  click(control("button", "Remove Chart", composerCard(editor)));
  const choices = await screen.findByRole("group", { name: "Choose a task" });
  click(control("button", "Image", choices));
  await screen.findByRole("group", { name: "Image styles" });
  expect(
    control("button", "Remove Image", composerCard(editor)),
  ).toBeInTheDocument();
  expect(draftSummaries(editor)).toHaveLength(0);
  expect(editor).toHaveTextContent(draft);

  click(control("button", "Remove Image", composerCard(editor)));
  const restoredChoices = await screen.findByRole("group", {
    name: "Choose a task",
  });
  click(control("button", "Chart", restoredChoices));
  const restoredOptions = await screen.findByRole("region", {
    name: "Visualization options",
  });
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  expect(
    control("button", "Spreadsheet", outputPicker(restoredOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(restoredOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(editor).toHaveTextContent(draft);
});

test.each([false, true])(
  "The first Chart send keeps pending choices and consumes them only on acceptance with HomeCapabilities=%s",
  async (homeCapabilities) => {
    const gate = createDeferredPromise<void>(context.signal);
    const {
      editor: homeEditor,
      options,
      lifecycle,
    } = await setupCharts({ homeCapabilities, sendGate: gate.promise });
    click(control("button", "Spreadsheet", outputPicker(options)));
    click(control("button", "Bar chart", chartPicker(options)));
    await expectSummary(homeEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
    const firstPrompt = "Compare our quarterly sales.";
    await sendDraft(homeEditor, firstPrompt);

    const chat = await screen.findByRole("region", { name: "Chat thread" });
    await within(chat).findByText(firstPrompt);
    const editor = await findComposerEditor();
    await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
    expect(
      control("button", "Remove Chart", composerCard(editor)),
    ).toBeInTheDocument();
    expect(
      within(sentMessage(chat, firstPrompt)).getByRole("group", {
        name: SPREADSHEET_BAR,
      }),
    ).toHaveTextContent("Spreadsheet · Bar");
    expect(window.location.pathname).toMatch(/^\/chats\//u);

    gate.resolve();
    await waitFor(() => {
      expect(draftSummaries(editor)).toHaveLength(0);
    });
    lifecycle.completeRun("The quarterly comparison is ready.");
    await within(chat).findByText("The quarterly comparison is ready.");
    await waitFor(() => {
      expect(
        control("button", "Send", composerCard(editor)),
      ).toBeInTheDocument();
    });

    const nextPrompt = "Explain the sales trend without choosing a chart.";
    await sendDraft(editor, nextPrompt);
    await within(chat).findByText(nextPrompt);
    expect(
      within(chat).getAllByRole("group", { name: SUMMARY_NAME }),
    ).toHaveLength(1);
    expect(
      within(chat).getByRole("group", { name: SPREADSHEET_BAR }),
    ).toHaveTextContent("Spreadsheet · Bar");
    expect(draftSummaries(editor)).toHaveLength(0);
  },
);

test("A destination A-to-B-to-A Chart choice survives the first blocked send", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  const runStarted = createDeferredPromise<void>(context.signal);
  const {
    editor: homeEditor,
    options,
    lifecycle,
  } = await setupCharts({
    homeCapabilities: true,
    sendGate: gate.promise,
    onRunCreate: () => {
      runStarted.resolve();
    },
  });
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  await expectSummary(homeEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  const firstPrompt = "Compare the quarterly sales.";
  await sendDraft(homeEditor, firstPrompt);
  const chat = await screen.findByRole("region", { name: "Chat thread" });
  await within(chat).findByText(firstPrompt);
  const editor = await findComposerEditor();
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  const path = window.location.pathname;
  expect(path).toMatch(/^\/chats\//u);

  const nextOptions = await openThreadChartOptions(editor);
  const nextDraft = "Keep my separate chart draft.";
  await fill(editor, nextDraft);
  click(control("button", "Website", outputPicker(nextOptions)));
  click(control("button", "Bar chart", chartPicker(nextOptions)));
  click(control("button", "Sankey diagram", chartPicker(nextOptions)));
  await expectSummary(
    editor,
    "Website, Charts: Sankey diagram",
    /^Website · Sankey$/u,
  );
  expect(
    within(sentMessage(chat, firstPrompt)).getByRole("group", {
      name: SPREADSHEET_BAR,
    }),
  ).toHaveTextContent("Spreadsheet · Bar");
  click(control("button", "Spreadsheet", outputPicker(nextOptions)));
  click(control("button", "Sankey diagram", chartPicker(nextOptions)));
  click(control("button", "Bar chart", chartPicker(nextOptions)));
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);

  gate.resolve();
  await runStarted.promise;
  lifecycle.completeRun("The first chart request is complete.");
  await within(chat).findByText("The first chart request is complete.");
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  expect(editor).toHaveTextContent(nextDraft);
  expect(
    within(sentMessage(chat, firstPrompt)).getByRole("group", {
      name: SPREADSHEET_BAR,
    }),
  ).toHaveTextContent("Spreadsheet · Bar");
  const retainedOptions = screen.getByRole("region", {
    name: "Visualization options",
  });
  expect(
    control("button", "Spreadsheet", outputPicker(retainedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(retainedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(window.location.pathname).toBe(path);
});

test("A failed first Chart send keeps the destination's choices available", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  const { editor: homeEditor, options } = await setupCharts({
    homeCapabilities: true,
    sendGate: gate.promise,
    rejectSend: true,
  });
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  await expectSummary(homeEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  const prompt = "Compare the quarterly sales.";
  await sendDraft(homeEditor, prompt);
  const chat = await screen.findByRole("region", { name: "Chat thread" });
  await within(chat).findByText(prompt);
  const editor = await findComposerEditor();
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  gate.resolve();
  await screen.findByText("Message was not accepted");
  const retainedEditor = await findComposerEditor();
  await expectSummary(retainedEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  const retainedOptions = await openThreadChartOptions(retainedEditor);
  expect(
    control("button", "Spreadsheet", outputPicker(retainedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(retainedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(window.location.pathname).toMatch(/^\/chats\//u);
});

test("Sending and queuing in an existing thread consume each draft without changing sent summaries", async () => {
  const { editor, options } = await setupCharts({
    homeCapabilities: true,
    path: THREAD_PATH,
  });
  const chat = screen.getByRole("region", { name: "Chat thread" });
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  await sendDraft(editor, "Prepare the quarterly comparison.");
  await expectOptionsDismissed();
  expect(draftSummaries(editor)).toHaveLength(0);
  await expect(
    within(chat).findByRole("group", { name: SPREADSHEET_BAR }),
  ).resolves.toHaveTextContent("Spreadsheet · Bar");
  await waitFor(() => {
    expect(control("button", "Stop", composerCard(editor))).toBeInTheDocument();
  });

  const nextOptions = await openThreadChartOptions(editor);
  expectUnselectedOptions(nextOptions);
  click(control("button", "Website", outputPicker(nextOptions)));
  click(control("button", "Sankey diagram", chartPicker(nextOptions)));
  const nextSelection = "Website, Charts: Sankey diagram";
  await expectSummary(editor, nextSelection, /^Website · Sankey$/u);
  const queuedPrompt = "Add a flow breakdown after the comparison.";
  await sendDraft(editor, queuedPrompt);
  await expectOptionsDismissed();
  await within(chat).findByText(queuedPrompt);
  expect(draftSummaries(editor)).toHaveLength(0);
  await expect(
    within(chat).findByRole("group", { name: nextSelection }),
  ).resolves.toHaveTextContent("Website · Sankey");
  expect(
    within(chat).getByRole("group", { name: SPREADSHEET_BAR }),
  ).toHaveTextContent("Spreadsheet · Bar");
  const emptyOptions = await openThreadChartOptions(editor);
  expectUnselectedOptions(emptyOptions);
  expect(window.location.pathname).toBe(THREAD_PATH);
});

test("An A-to-B-to-A next-draft Chart choice survives an earlier blocked send", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  const { editor, options } = await setupCharts({
    homeCapabilities: true,
    path: THREAD_PATH,
    sendGate: gate.promise,
  });
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  const firstPrompt = "Compare the quarterly sales.";
  await sendDraft(editor, firstPrompt);
  const chat = screen.getByRole("region", { name: "Chat thread" });
  await within(chat).findByText(firstPrompt);
  const draftEditor = await findComposerEditor();
  await waitFor(() => {
    expect(draftEditor.textContent).toBe("");
  });
  await expectSummary(draftEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);

  const pendingOptions = await screen.findByRole("region", {
    name: "Visualization options",
  });
  const nextDraft = "Keep this separate flow analysis.";
  await fill(draftEditor, nextDraft);
  click(control("button", "Website", outputPicker(pendingOptions)));
  click(control("button", "Bar chart", chartPicker(pendingOptions)));
  click(control("button", "Sankey diagram", chartPicker(pendingOptions)));
  await expectSummary(
    draftEditor,
    "Website, Charts: Sankey diagram",
    /^Website · Sankey$/u,
  );
  click(control("button", "Spreadsheet", outputPicker(pendingOptions)));
  click(control("button", "Sankey diagram", chartPicker(pendingOptions)));
  click(control("button", "Bar chart", chartPicker(pendingOptions)));
  await expectSummary(draftEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  gate.resolve();
  // The pending tray dismisses only after that send has been accepted.
  await expectOptionsDismissed();
  await expectSummary(draftEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  expect(draftEditor).toHaveTextContent(nextDraft);
  expect(
    within(sentMessage(chat, firstPrompt)).getByRole("group", {
      name: SPREADSHEET_BAR,
    }),
  ).toHaveTextContent("Spreadsheet · Bar");
  const nextOptions = await openThreadChartOptions(draftEditor);
  expect(
    control("button", "Spreadsheet", outputPicker(nextOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(nextOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Sankey diagram", chartPicker(nextOptions)),
  ).toHaveAttribute("aria-pressed", "false");
});

test("A rejected Chart submission leaves the selected choices available", async () => {
  const { editor, options } = await setupCharts({
    homeCapabilities: true,
    path: THREAD_PATH,
    rejectSend: true,
  });
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  await expectSummary(editor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  await sendDraft(editor, "Compare the quarterly sales.");
  await screen.findByText("Message was not accepted");
  const draftEditor = await findComposerEditor();
  await expectSummary(draftEditor, SPREADSHEET_BAR, /^Spreadsheet · Bar$/u);
  const retainedOptions = await screen.findByRole("region", {
    name: "Visualization options",
  });
  expect(
    control("button", "Spreadsheet", outputPicker(retainedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(retainedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Chart choices remain remembered after sending when visualization summaries are disabled", async () => {
  const { editor: homeEditor, options } = await setupCharts({
    homeCapabilities: true,
    visualizationSummary: false,
  });
  click(control("button", "Spreadsheet", outputPicker(options)));
  click(control("button", "Bar chart", chartPicker(options)));
  expect(control("button", "Bar chart", chartPicker(options))).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(draftSummaries(homeEditor)).toHaveLength(0);
  await sendDraft(homeEditor, "Compare the quarterly sales.");
  const chat = await screen.findByRole("region", { name: "Chat thread" });
  await within(chat).findByText("Compare the quarterly sales.");
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(
      control("button", "Remove Chart", composerCard(editor)),
    ).toBeInTheDocument();
  });
  const rememberedOptions = await openThreadChartOptions(editor);
  expect(
    control("button", "Spreadsheet", outputPicker(rememberedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(
    control("button", "Bar chart", chartPicker(rememberedOptions)),
  ).toHaveAttribute("aria-pressed", "true");
  expect(draftSummaries(editor)).toHaveLength(0);
  expect(within(chat).queryByRole("group", { name: SUMMARY_NAME })).toBeNull();
});
