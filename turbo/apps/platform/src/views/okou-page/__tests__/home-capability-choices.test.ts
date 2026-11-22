import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { sendComposerMessage } from "./chat-composer-template-gallery-test-helpers.ts";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage, click, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import {
  queryFastControl,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function home() {
  await setupPage({ context, path: "/" });
  await screen.findByRole("region", { name: "Find people" });
  return findComposerEditor();
}
async function cover(name: string) {
  const region = await screen.findByRole("region", { name });
  click(within(region).getByTestId("capability-card-cover"));
}
async function closeTray() {
  click(await findFastControl("button", "All capabilities"));
  await screen.findByRole("region", { name: "Find people" });
}
async function choose(name: string) {
  click(await findFastControl("button", new RegExp(name, "i")));
}
async function append(editor: HTMLElement, text: string) {
  editor.focus();
  const selection = document.getSelection();
  selection?.selectAllChildren(editor);
  selection?.collapseToEnd();
  await userEvent.setup({ delay: null }).paste(text);
}
test("capability-home-page-002 The home card grid precedes all five compliance statuses and the composer follows them", async () => {
  const editor = await home();
  const badge = screen.getByText("SOC 2 Type II");
  const cards = screen.getByRole("region", { name: "Find people" });
  expect(
    cards.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    badge.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  for (const [label, status] of [
    ["SOC 2 Type II", "In progress"],
    ["CCPA / CPRA", "Compliant"],
    ["GDPR", "Compliant"],
    ["HIPAA", "Aligned"],
    ["ISO/IEC 27001", "Aligned"],
  ] as const) {
    const row = screen.getByText(label).closest("li");
    expect(row).toHaveTextContent(status);
  }
});
test("capability-home-page-004 Hiding compliance restores composer focus and persists after returning from Workflows", async () => {
  context.mocks.browser.matchMedia(true);
  const editor = await home();
  click(await findFastControl("button", "Hide compliance"));
  await waitFor(() => {
    expect(screen.queryByText("SOC 2 Type II")).toBeNull();
  });
  expect(editor).toHaveFocus();
  click(await findFastControl("link", "Workflows"));
  await screen.findByRole("heading", { name: "Workflows" });
  click(await findFastControl("link", "Chat"));
  await screen.findByRole("region", { name: "Find people" });
  expect(screen.queryByText("SOC 2 Type II")).toBeNull();
});
test("capability-home-page-018 Each card cover opens its own capability content", async () => {
  await home();
  for (const [name, content] of [
    ["Research", "Compare website traffic"],
    ["Find people", "Potential customers"],
    ["Create", "Presentation"],
    ["Workflow", "Schedule a task"],
  ] as const) {
    await cover(name);
    const visibleContent =
      content === "Schedule a task"
        ? await screen.findByRole("region", { name: content })
        : (await screen.findAllByText(content, { exact: true }))[0];
    expect(visibleContent).toBeVisible();
    await closeTray();
  }
});
test("capability-home-page-020 Closing an unchanged recommendation clears it and focuses the composer", async () => {
  const editor = await home();
  await cover("Find people");
  await choose("Potential customers");
  await waitFor(() => {
    expect(editor).toHaveTextContent(/customers/i);
  });
  await closeTray();
  expect(editor.textContent).toBe("");
  expect(editor).toHaveFocus();
  expect(screen.getByRole("region", { name: "Workflow" })).toBeVisible();
});
test.each([
  ["capability-home-page-025", "Find people", "Potential customers"],
  ["capability-home-page-026", "Research", "Compare website traffic"],
] as const)(
  "%s Closing %s preserves a suggestion that the user edited",
  async (_id, group, suggestion) => {
    const editor = await home();
    await cover(group);
    await choose(suggestion);
    await waitFor(() => {
      expect(editor.textContent?.trim()).not.toBe("");
    });
    const original = editor.textContent;
    await append(editor, " Focus on my company.");
    await closeTray();
    expect(editor.textContent).toBe(original + " Focus on my company.");
  },
);
test("capability-home-page-030 Closing Find people restores the original draft after changing injected suggestions", async () => {
  const editor = await home();
  await fill(editor, "Keep my own brief.");
  await cover("Find people");
  await choose("Potential customers");
  await waitFor(() => {
    expect(editor).toHaveTextContent(/customers/i);
  });
  await choose("Event speakers");
  await waitFor(() => {
    expect(editor).toHaveTextContent(/speakers/i);
  });
  await closeTray();
  expect(editor.textContent).toBe("Keep my own brief.");
});
test("capability-home-page-009 Moving focus from Create to Workflow selects the Workflow content on Enter", async () => {
  await home();
  await cover("Create");
  const create = await findFastControl("tab", "Create");
  const workflow = await findFastControl("tab", "Workflow");
  expect(create).toHaveAttribute("aria-selected", "true");
  const user = userEvent.setup({ delay: null });
  create.focus();
  await user.keyboard("{ArrowRight}");
  expect(workflow).toHaveFocus();
  await user.keyboard("{Enter}");
  await screen.findByRole("region", { name: "Schedule a task" });
  expect(workflow).toHaveAttribute("aria-selected", "true");
});

test("capability-home-page-006 Leaving Presentation for Find people sends the editor's text as an ordinary chat message", async () => {
  const envelope = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    onSendRequest(request) {
      envelope.resolve(request.userMessage?.parts);
    },
  });
  await home();
  await cover("Create");
  await screen.findAllByText("Presentation", { exact: true });
  click(await findFastControl("tab", "Find people"));
  await screen.findByText("Potential customers");
  const text = "Find the right sources for my launch research.";
  await sendComposerMessage(userEvent.setup({ delay: null }), text);
  await screen.findByText(text, { exact: true });
  await expect(envelope.promise).resolves.toStrictEqual([
    { type: "text", text },
  ]);
});
test("capability-home-page-008 Switching capability within an open tray keeps the draft and only card-to-tray changes start a home transition", async () => {
  const transitions = context.mocks.browser.viewTransition();
  const editor = await home();
  await fill(editor, "Keep my launch brief.");
  const prior = transitions.startedTypes.length;
  await cover("Research");
  await screen.findByText("Compare website traffic");
  expect(transitions.startedTypes.slice(prior)).toStrictEqual([
    ["capability-home"],
  ]);
  click(await findFastControl("tab", "Find people"));
  await screen.findByText("Potential customers");
  expect(transitions.startedTypes.slice(prior)).toStrictEqual([
    ["capability-home"],
  ]);
  await closeTray();
  expect(transitions.startedTypes.slice(prior)).toStrictEqual([
    ["capability-home"],
    ["capability-home"],
  ]);
  expect(editor).toHaveTextContent("Keep my launch brief.");
});
test("capability-home-page-010 The Create header browses Presentation and omits the browse action for Chart", async () => {
  await home();
  await cover("Create");
  const tray = await screen.findByRole("tabpanel");
  expect(
    within(tray).getAllByText("Presentation", { exact: true }),
  ).toHaveLength(1);
  click(await findFastControl("button", "View all", tray));
  const dialog = await screen.findByRole("dialog");
  await expect(
    findFastControl("tab", "Presentation", dialog),
  ).resolves.toHaveAttribute("aria-selected", "true");
  click(await findFastControl("button", "Close", dialog));
  click(await within(tray).findByText("Chart", { exact: true }));
  await waitFor(() => {
    expect(queryFastControl("button", "View all", tray)).toBeNull();
  });
  click(await findFastControl("tab", "Find people"));
  await expect(
    screen.findByText(/Customers, creators, decision-makers/),
  ).resolves.toBeVisible();
});
test("capability-home-page-016 A News digest prompt remains editable with the user's draft and starts no run", async () => {
  const prompts: string[] = [];
  mockChatLifecycle(context, {
    onSendRequest(request) {
      prompts.push(request.prompt);
    },
  });
  const editor = await home();
  await fill(editor, "Focus on product launches.");
  await cover("Workflow");
  const tray = await screen.findByRole("tabpanel");
  click(await within(tray).findByText("Triggers", { exact: true }));
  click(await findFastControl("button", /News digest/, tray));
  await waitFor(() => {
    expect(editor).toHaveTextContent(/News digest/i);
  });
  for (const phrase of [
    "Focus on product launches.",
    "RSS",
    "Keyword match",
    "how often",
    "periodically",
    "skip items already processed",
  ]) {
    expect(editor).toHaveTextContent(phrase);
  }
  expect(editor).toHaveAttribute("contenteditable", "true");
  expect(prompts).toStrictEqual([]);
});

test("capability-home-page-005 Moving between capability tabs retains the draft, restores Image, and displays each active chip", async () => {
  const editor = await home();
  await fill(editor, "Keep my launch brief.");
  await cover("Create");
  const tray = await screen.findByRole("tabpanel");
  click(await findFastControl("radio", "Image", tray));
  await expect(
    findFastControl("button", "Remove Image"),
  ).resolves.toBeVisible();
  expect(queryFastControl("button", "Tools")).toBeNull();
  for (const [tab, sample] of [
    ["Find people", "Potential customers"],
    ["Research", "Compare website traffic"],
  ] as const) {
    click(await findFastControl("tab", tab));
    await expect(screen.findByText(sample)).resolves.toBeVisible();
    await expect(
      findFastControl("button", "Remove " + tab),
    ).resolves.toBeVisible();
  }
  click(await findFastControl("tab", "Create"));
  await expect(findFastControl("radio", "Image")).resolves.toHaveAttribute(
    "aria-checked",
    "true",
  );
  click(await findFastControl("tab", "Workflow"));
  await screen.findByRole("region", { name: "Schedule a task" });
  await expect(
    findFastControl("button", "Remove Workflow"),
  ).resolves.toBeVisible();
  expect(queryFastControl("button", "Tools")).toBeNull();
  expect(editor).toHaveTextContent("Keep my launch brief.");
});
test("capability-home-page-012 An advanced workflow recommendation adds Morning brief to the existing draft and opens the workflow catalog", async () => {
  const editor = await home();
  await fill(editor, "Focus on customer meetings.");
  await cover("Workflow");
  click(await findFastControl("radio", "Advanced"));
  click(await findFastControl("button", "Start your day with a clear plan"));
  await waitFor(() => {
    expect(editor).toHaveTextContent(/morning brief/i);
  });
  expect(editor).toHaveTextContent("Focus on customer meetings.");
  expect(
    editor.querySelector("[data-composer-inline-template]"),
  ).toHaveTextContent("Morning brief");
  expect(editor).toHaveTextContent(/meetings.*priorities/i);
  click(await findFastControl("button", "View all"));
  const picker = await screen.findByRole("dialog");
  await expect(
    findFastControl("tab", "Workflow", picker),
  ).resolves.toHaveAttribute("aria-selected", "true");
  await expect(
    within(picker).findByText("Morning brief", { exact: true }),
  ).resolves.toBeVisible();
  click(await findFastControl("button", "Close", picker));
  await closeTray();
  await cover("Workflow");
  click(await findFastControl("radio", "Triggers"));
  await expect(
    screen.findByText("Email replies", { exact: true }),
  ).resolves.toBeVisible();
});
async function applyPresentation() {
  await cover("Create");
  const tray = await screen.findByRole("tabpanel");
  const select = await findFastControl(
    "button",
    /^(?:Select template )?Sunburst playroom$/,
    tray,
  );
  click(select);
}
test("capability-home-page-011 Discovery and Presentation alternate while the greeting, selected template and draft persist", async () => {
  const editor = await home();
  await fill(editor, "Keep my launch brief.");
  await screen.findByTestId("chat-greeting");
  await applyPresentation();
  await waitFor(() => {
    expect(
      editor.querySelector("[data-composer-inline-template]"),
    ).toHaveTextContent("Sunburst playroom");
  });
  expect(screen.getByTestId("chat-greeting")).toBeVisible();
  expect(screen.queryByRole("region", { name: "Find people" })).toBeNull();
  await closeTray();
  expect(screen.queryByRole("tabpanel")).toBeNull();
  expect(screen.getByTestId("chat-greeting")).toBeVisible();
  await cover("Create");
  await screen.findByRole("tabpanel");
  expect(editor).toHaveTextContent("Keep my launch brief.");
  expect(
    editor.querySelector("[data-composer-inline-template]"),
  ).toHaveTextContent("Sunburst playroom");
  expect(screen.getByTestId("chat-greeting")).toBeVisible();
});
test("capability-home-page-001 The empty conversation sends its chosen template and message in its existing thread", async () => {
  const thread = "a5790000-0000-4000-8000-000000000001";
  const sent = context.mocks.deferred<{ threadId?: string; parts: unknown }>();
  const created: string[] = [];
  mockChatLifecycle(context, {
    threadId: thread,
    chatEvents: [],
    onThreadCreate(body) {
      created.push(String(body.clientThreadId));
    },
    onSendRequest(body) {
      sent.resolve({ threadId: body.threadId, parts: body.userMessage?.parts });
    },
  });
  await setupPage({ context, path: "/chats/" + thread });
  await screen.findByRole("region", { name: "Create" });
  expect(screen.queryByTestId("chat-greeting")).toBeNull();
  await applyPresentation();
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(
      editor.querySelector("[data-composer-inline-template]"),
    ).toHaveTextContent("Sunburst playroom");
  });
  await closeTray();
  const text = "Prepare the launch presentation.";
  await sendComposerMessage(userEvent.setup({ delay: null }), text);
  await screen.findByText(text, { exact: true });
  const delivery = await sent.promise;
  expect(delivery.threadId).toBe(thread);
  expect(delivery.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "template",
        titleSnapshot: "Sunburst playroom",
      }),
      { type: "text", text },
    ]),
  );
  expect(location.pathname).toBe("/chats/" + thread);
  await expect(findComposerEditor()).resolves.toBeVisible();
  expect(created).toStrictEqual([]);
});
