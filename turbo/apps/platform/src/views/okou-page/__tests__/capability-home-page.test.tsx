import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  composerInlineTemplates,
  findComposerEditor,
  tabByText,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
function button(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((item) => {
    return (
      (item.getAttribute("aria-label") ?? item.textContent?.trim()) === label
    );
  });
  if (!result) {
    throw new Error(`Expected button ${label}`);
  }
  return result;
}
async function setupHome() {
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: { [FeatureSwitchKey.HomeCapabilities]: true },
  });
  return await findComposerEditor();
}
function capabilities() {
  return screen.getByRole("group", { name: "Explore Okou capabilities" });
}

test("An empty conversation offers capabilities without an avatar and sends its first message in the same conversation", async () => {
  const capture = mockTemplateChat();
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.HomeCapabilities]: true },
  });
  const editor = await findComposerEditor();
  const discovery = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  expect(screen.queryByTestId("chat-greeting")).toBeNull();
  await fill(editor, "Prepare the launch presentation");
  click(button("Presentation", discovery));
  const shelf = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  click(button(template.title, shelf));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });
  click(button("All capabilities"));
  expect(capabilities()).toBeInTheDocument();
  expect(editor).toHaveTextContent("Prepare the launch presentation");
  click(button("Send"));
  await waitFor(() => {
    const conversation = document.querySelector(
      `[data-chat-thread-container-id="${THREAD_ID}"] [data-message-container]`,
    );
    expect(conversation).toHaveTextContent("Prepare the launch presentation");
    expect(conversation).toHaveTextContent(template.title);
  });
  expect(editor).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Explore Okou capabilities" }),
  ).toBeNull();
  expect(capture.threadCreates).toStrictEqual([]);
  // The conversation drops the compliance line but keeps its room under the
  // composer, so the composer does not move when the first message is sent.
  expect(
    screen.queryByRole("region", {
      name: "Okou’s compliance, built for your trust",
    }),
  ).toBeNull();
  expect(
    editor
      .closest("[data-chat-composer]")
      ?.querySelector('[data-slot="composer-footnote-space"]'),
  ).toBeInTheDocument();
});

test.each([
  ["home", `/agents/${AGENT_ID}/chat`],
  ["empty conversation", `/chats/${THREAD_ID}`],
])(
  "The %s lists compliance statuses under the composer",
  async (_surface, path) => {
    mockTemplateChat();
    await setupPage({
      context,
      path,
      featureSwitches: { [FeatureSwitchKey.HomeCapabilities]: true },
    });
    const editor = await findComposerEditor();
    await screen.findByRole("group", { name: "Explore Okou capabilities" });
    const compliance = screen.getByRole("region", {
      name: "Okou’s compliance, built for your trust",
    });
    expect(
      editor.compareDocumentPosition(compliance) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(compliance.closest("main")).toBeNull();
    expect(compliance.closest("[data-chat-composer]")).not.toBeNull();
    // One quiet line names the frameworks; their statuses open from it.
    click(queryAllByRoleFast("button", compliance)[0]!);
    const details = await screen.findByRole("dialog");
    expect(
      within(details)
        .getAllByRole("listitem")
        .map((item) => {
          return item.textContent;
        }),
    ).toStrictEqual([
      "SOC 2 Type IIIn progress",
      "CCPA / CPRACompliant",
      "GDPRCompliant",
      "HIPAAAligned",
      "ISO/IEC 27001Aligned",
    ]);
  },
);

test("An open tray switches capabilities and types without going back to the cards", async () => {
  mockTemplateChat();
  const editor = await setupHome();
  await fill(editor, "Keep my launch brief");
  click(button("Presentation", capabilities()));
  await screen.findByRole("group", { name: "Presentation templates" });
  const row = screen.getByRole("navigation", {
    name: "Explore Okou capabilities",
  });
  expect(button("Create", row)).toHaveAttribute("aria-current", "true");
  const types = screen.getByRole("radiogroup", { name: "Create" });
  const image = queryAllByRoleFast("radio", types).find((item) => {
    return item.textContent?.trim() === "Image";
  });
  click(image!);
  await screen.findByRole("group", { name: "Image styles" });
  expect(
    screen.queryByRole("group", { name: "Presentation templates" }),
  ).toBeNull();
  click(button("Find people", row));
  await screen.findByRole("region", { name: "Find people" });
  expect(button("Find people", row)).toHaveAttribute("aria-current", "true");
  expect(screen.queryByRole("group", { name: "Image styles" })).toBeNull();
  // Create reopens on the type chosen last.
  click(button("Create", row));
  await screen.findByRole("group", { name: "Image styles" });
  expect(editor).toHaveTextContent("Keep my launch brief");
});

test("Capability discovery and templates replace each other while the composer keeps the draft and template", async () => {
  mockTemplateChat();
  const editor = await setupHome();
  expect(screen.getByTestId("chat-greeting")).toBeInTheDocument();
  await fill(editor, "Keep my launch brief");
  click(button("Presentation", capabilities()));
  const shelf = await screen.findByRole("group", {
    name: "Presentation templates",
  });
  expect(screen.getByTestId("chat-greeting")).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Explore Okou capabilities" }),
  ).toBeNull();
  const template = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
  click(button(template.title, shelf));
  await waitFor(() => {
    expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  });
  click(button("All capabilities"));
  expect(capabilities()).toBeInTheDocument();
  expect(screen.getByTestId("chat-greeting")).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Presentation templates" }),
  ).toBeNull();
  expect(editor).toHaveTextContent("Keep my launch brief");
  expect(composerInlineTemplates()[0]).toHaveTextContent(template.title);
  click(button("Presentation", capabilities()));
  await expect(
    screen.findByRole("group", { name: "Presentation templates" }),
  ).resolves.toBeInTheDocument();
  expect(editor).toHaveTextContent("Keep my launch brief");
});

test("Workflow suggestions preserve the draft and open the real workflow picker", async () => {
  mockTemplateChat();
  const editor = await setupHome();
  await fill(editor, "Focus on customer meetings");
  click(button("Advanced workflows", capabilities()));
  const suggestions = await screen.findByRole("region", {
    name: "Advanced workflows",
  });
  expect(
    screen.queryByRole("group", { name: "Explore Okou capabilities" }),
  ).toBeNull();
  click(button("Start your day with a clear plan", suggestions));
  expect(editor).toHaveTextContent("Focus on customer meetings");
  expect(editor).toHaveTextContent("Help me set up a morning brief");
  expect(composerInlineTemplates()[0]).toHaveTextContent("Morning brief");
  expect(
    button("Keep important emails moving", suggestions),
  ).toBeInTheDocument();
  click(button("View all", suggestions));
  const dialog = await screen.findByRole("dialog");
  expect(tabByText("Workflow")).toHaveAttribute("aria-selected", "true");
  expect(
    button("Select workflow template Morning brief", dialog),
  ).toBeInTheDocument();
  click(button("Close", dialog));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  click(button("All capabilities"));
  expect(editor).toHaveTextContent(/^Focus on customer meetingsMorning brief$/);
  expect(composerInlineTemplates()[0]).toHaveTextContent("Morning brief");
  click(button("Triggers", capabilities()));
  await expect(
    screen.findByRole("region", { name: "Triggers" }),
  ).resolves.toBeInTheDocument();
  expect(button("Email replies")).toBeInTheDocument();
  expect(editor).toHaveTextContent("Focus on customer meetings");
});

test("Scheduled tasks and triggers prepare their own editable automation requests", async () => {
  const capture = mockTemplateChat();
  const editor = await setupHome();
  await fill(editor, "Use my work account.");
  click(button("Scheduled tasks", capabilities()));
  const scheduled = await screen.findByRole("region", {
    name: "Schedule a task",
  });
  click(button("Repeat on a schedule", scheduled));
  expect(editor).toHaveTextContent("Repeat on a schedule.");
  expect(editor).toHaveTextContent("which time zone to use");
  expect(editor).toHaveFocus();
  click(button("All capabilities"));
  click(button("Triggers", capabilities()));
  const triggers = await screen.findByRole("region", { name: "Triggers" });
  click(button("Email replies", triggers));
  expect(editor).toHaveTextContent("Help me set up Email replies using Gmail.");
  expect(editor).toHaveTextContent(
    "Email starred → Extract requests → Draft reply",
  );
  expect(editor).toHaveTextContent("confirm the setup before enabling it");
  expect(editor).toHaveTextContent("Use my work account.");
  expect(editor).toHaveFocus();
  expect(capture.runPrompts).toStrictEqual([]);
});

test.each([
  { title: "News digest", source: "RSS", event: "Keyword match" },
  { title: "X watchlist", source: "X", event: "New post" },
])(
  "$title prepares a periodic monitoring request without starting it",
  async ({ title, source, event }) => {
    const capture = mockTemplateChat();
    const editor = await setupHome();
    await fill(editor, "Focus on product launches.");
    click(button("Triggers", capabilities()));
    const triggers = await screen.findByRole("region", { name: "Triggers" });
    click(button(title, triggers));
    expect(editor).toHaveTextContent(
      `Help me set up ${title} using ${source}.`,
    );
    expect(editor).toHaveTextContent(event);
    expect(editor).toHaveTextContent("how often to check");
    expect(editor).toHaveTextContent(
      "Check periodically, skip items already processed",
    );
    expect(editor).toHaveTextContent("Focus on product launches.");
    expect(editor).toHaveFocus();
    expect(capture.runPrompts).toStrictEqual([]);
  },
);

test("Search and Research open separate suggestions and prepare editable drafts without starting a run", async () => {
  const capture = mockTemplateChat();
  const editor = await setupHome();
  await fill(editor, "I am planning a research project.");
  click(button("Find people", capabilities()));
  const search = await screen.findByRole("region", { name: "Find people" });
  expect(screen.getByTestId("chat-greeting")).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Explore Okou capabilities" }),
  ).toBeNull();
  click(button("Potential customers", search));
  expect(editor).toHaveTextContent("Help me find: Potential customers.");
  expect(editor).toHaveTextContent("I am planning a research project.");
  expect(editor).toHaveFocus();
  expect(capture.runPrompts).toStrictEqual([]);
  click(button("All capabilities"));
  const explore = queryAllByRoleFast("link").find((link) => {
    return link.textContent?.trim() === "Explore what's new";
  });
  expect(explore).toHaveAttribute("href", "https://www.okou.ai/en/blog");
  expect(explore).toHaveAttribute("target", "_blank");
  click(button("Research", capabilities()));
  const research = await screen.findByRole("region", { name: "Research" });
  expect(screen.queryByRole("region", { name: "Find people" })).toBeNull();
  click(button("Compare website traffic", research));
  expect(editor).toHaveTextContent("Compare website traffic.");
  expect(editor).toHaveTextContent("I am planning a research project.");
  expect(capture.runPrompts).toStrictEqual([]);
  click(button("All capabilities"));
  expect(capabilities()).toBeInTheDocument();
  expect(editor).toHaveTextContent(/^I am planning a research project\.$/);
});

const HOME_PROMPTS = [
  {
    capability: "Find people",
    guideTitle: "Find people",
    suggestion: "Potential customers",
  },
  {
    capability: "Research",
    guideTitle: "Research",
    suggestion: "Compare website traffic",
  },
  {
    capability: "Scheduled tasks",
    guideTitle: "Schedule a task",
    suggestion: "Repeat on a schedule",
  },
  {
    capability: "Triggers",
    guideTitle: "Triggers",
    suggestion: "Email replies",
  },
  {
    capability: "Advanced workflows",
    guideTitle: "Advanced workflows",
    suggestion: "Start your day with a clear plan",
  },
] as const;

test.each(HOME_PROMPTS)(
  "Closing $capability clears its unchanged injected prompt",
  async ({ capability, guideTitle, suggestion }) => {
    mockTemplateChat();
    const editor = await setupHome();
    click(button(capability, capabilities()));
    const guide = await screen.findByRole("region", { name: guideTitle });
    click(button(suggestion, guide));
    expect(editor.textContent).not.toBe("");

    click(button("All capabilities"));

    expect(capabilities()).toBeInTheDocument();
    expect(editor).toHaveFocus();
    // Workflow template attachments are independent of the suggested text.
    expect(editor.textContent).toBe(
      capability === "Advanced workflows" ? "Morning brief" : "",
    );
  },
);

test.each(HOME_PROMPTS)(
  "Closing $capability preserves the prompt after the user edits it",
  async ({ capability, guideTitle, suggestion }) => {
    mockTemplateChat();
    const editor = await setupHome();
    click(button(capability, capabilities()));
    const guide = await screen.findByRole("region", { name: guideTitle });
    click(button(suggestion, guide));
    const user = userEvent.setup({ delay: null });
    await user.paste(" Focus on my company.");
    const editedText = editor.textContent;

    click(button("All capabilities"));

    expect(editor.textContent).toBe(editedText);
    expect(editor).toHaveTextContent("Focus on my company.");
  },
);

test("Dismissing repeated suggestions restores the original draft without stacked prompts", async () => {
  mockTemplateChat();
  const editor = await setupHome();
  await fill(editor, "Keep my own brief.");
  click(button("Find people", capabilities()));
  const guide = await screen.findByRole("region", { name: "Find people" });
  click(button("Potential customers", guide));
  click(button("Event speakers", guide));
  expect(editor).toHaveTextContent("Help me find: Event speakers.");

  click(button("All capabilities"));

  expect(editor).toHaveTextContent(/^Keep my own brief\.$/);
});

test("Dismissing a suggestion does not clear matching text the user wrote", async () => {
  mockTemplateChat();
  const editor = await setupHome();
  const prompt =
    "Help me find: Potential customers. Ask me about my target, criteria, and scope first. Return a shortlist with relevant details and source links.";
  await fill(editor, prompt);
  click(button("Find people", capabilities()));
  const guide = await screen.findByRole("region", { name: "Find people" });
  click(button("Potential customers", guide));
  click(button("Potential customers", guide));

  click(button("All capabilities"));

  expect(editor.textContent).toBe(prompt);
});
