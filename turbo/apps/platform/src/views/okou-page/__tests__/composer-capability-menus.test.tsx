import { workflowsCollectionContract } from "@okouai/api-contracts";
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
import {
  composerWorkflow,
  findComposerEditor,
} from "./chat-composer-test-helpers.ts";
import {
  AGENT_ID,
  THREAD_ID,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);
const HOME_PATH = `/agents/${AGENT_ID}/chat`;
const CAPABILITIES = [
  { label: "Find people", role: "region", name: "Find people" },
  { label: "Research", role: "region", name: "Research" },
  { label: "Create", role: "group", name: "Presentation templates" },
  { label: "Workflow", role: "region", name: "Schedule a task" },
] as const;
const CAPABILITY_LABELS = CAPABILITIES.map(({ label }) => {
  return label;
});
type User = ReturnType<typeof userEvent.setup>;

async function setupMenus({
  homeCapabilities = true,
  slashActions = false,
  desktop = false,
  path = HOME_PATH,
  sendGate,
}: {
  readonly homeCapabilities?: boolean;
  readonly slashActions?: boolean;
  readonly desktop?: boolean;
  readonly path?: string;
  readonly sendGate?: Promise<void>;
} = {}) {
  const capture = mockTemplateChat(sendGate ? { sendGate } : undefined);
  const workflow = composerWorkflow("daily-recap", "Prepare a daily recap");
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [workflow]);
  });
  context.mocks.browser.matchMedia(desktop);
  await setupPage({
    context,
    path: path === HOME_PATH ? `${path}?compose=1` : path,
    featureSwitches: {
      [FeatureSwitchKey.HomeCapabilities]: homeCapabilities,
      [FeatureSwitchKey.SlashActions]: slashActions,
      [FeatureSwitchKey.Projects]: false,
    },
  });
  return { editor: await findComposerEditor(), lifecycle: capture.lifecycle };
}

function controlLabel(element: HTMLElement): string {
  const name =
    element.querySelector('[data-slot="slash-workflow-name"]') ?? element;
  return (
    element.getAttribute("aria-label") ??
    name.textContent?.replace(/\s+/gu, " ").trim() ??
    ""
  );
}

function control(
  role: "button" | "menuitem" | "radio" | "tab",
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const result = queryAllByRoleFast(role, container).find((element) => {
    return controlLabel(element) === label;
  });
  if (!result) {
    throw new Error(`Expected ${role} named ${label}`);
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

async function openAddMenu(editor: HTMLElement, user: User) {
  await user.click(control("button", "Add", composerCard(editor)));
  return await screen.findByRole("menu", { name: "Add" });
}

async function selectAddCapability(
  editor: HTMLElement,
  user: User,
  label: string,
) {
  const menu = await openAddMenu(editor, user);
  await user.click(control("menuitem", label, menu));
}

async function expectDraftFocus(editor: HTMLElement, draft: string) {
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    expect(screen.queryByTestId("slash-workflow-menu")).toBeNull();
    expect(editor).toHaveFocus();
  });
  expect(editor.textContent).toBe(draft);
}

async function expectCapability(capability: (typeof CAPABILITIES)[number]) {
  await expect(
    screen.findByRole(capability.role, { name: capability.name }),
  ).resolves.toBeInTheDocument();
  const tabs = screen.getByRole("tablist", {
    name: "Explore Okou capabilities",
  });
  expect(control("tab", capability.label, tabs)).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

function slashButtonNames(menu: HTMLElement): string[] {
  return queryAllByRoleFast("button", menu).map(controlLabel);
}

function slashEntry(menu: HTMLElement, prefix: string): HTMLElement {
  const result = queryAllByRoleFast("button", menu).find((element) => {
    return controlLabel(element).startsWith(prefix);
  });
  if (!result) {
    throw new Error(`Expected slash entry starting with ${prefix}`);
  }
  return result;
}

test("The add menu opens each home capability and restores its own trigger only on dismissal", async () => {
  const { editor } = await setupMenus();
  const user = userEvent.setup({ delay: null });
  const draft = "Keep my launch brief.";
  await fill(editor, draft);
  const menu = await openAddMenu(editor, user);
  expect(queryAllByRoleFast("menuitem", menu).map(controlLabel)).toStrictEqual([
    "Attach",
    "Template",
    ...CAPABILITY_LABELS,
    "Import skills",
  ]);

  for (const [index, capability] of CAPABILITIES.entries()) {
    if (index === 0) {
      await user.click(control("menuitem", capability.label, menu));
    } else {
      await selectAddCapability(editor, user, capability.label);
    }
    await expectCapability(capability);
    await expectDraftFocus(editor, draft);
  }
  expect(window.location.pathname).toBe(HOME_PATH);

  // An existing task must not suppress ordinary Escape focus restoration.
  const add = control("button", "Add", composerCard(editor));
  await openAddMenu(editor, user);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    expect(add).toHaveFocus();
  });
});

test.each([
  {
    slashActions: false,
    desktop: true,
    capabilityOrder: [...CAPABILITY_LABELS].reverse(),
    otherEntries: ["/daily-recap", "Browse all templates"],
  },
  {
    slashActions: true,
    desktop: false,
    capabilityOrder: CAPABILITY_LABELS,
    otherEntries: ["Connect", "Workflows 1", "Templates "],
  },
])(
  "Slash capabilities preserve the draft with SlashActions=$slashActions and desktop=$desktop",
  async ({ slashActions, desktop, capabilityOrder, otherEntries }) => {
    const path = slashActions ? HOME_PATH : `/chats/${THREAD_ID}`;
    const { editor } = await setupMenus({ slashActions, desktop, path });
    const user = userEvent.setup({ delay: null });
    const draft = "Keep my own brief";
    await fill(editor, `${draft} /`);
    const menu = await screen.findByTestId("slash-workflow-menu");
    await waitFor(() => {
      expect(
        slashButtonNames(menu).filter((name) => {
          return CAPABILITY_LABELS.some((label) => {
            return label === name;
          });
        }),
      ).toStrictEqual(capabilityOrder);
      for (const prefix of otherEntries) {
        expect(slashEntry(menu, prefix)).toBeInTheDocument();
      }
    });

    for (const [index, capability] of CAPABILITIES.entries()) {
      const search = capability.label === "Research";
      if (index > 0) {
        await fill(editor, `${draft} /${search ? "research" : ""}`);
      }
      const activeMenu = await screen.findByTestId("slash-workflow-menu");
      const row = control("button", capability.label, activeMenu);
      if (search) {
        await user.keyboard("{Enter}");
      } else {
        await user.click(row);
      }
      await expectCapability(capability);
      await expectDraftFocus(editor, `${draft} `);
    }
    expect(window.location.pathname).toBe(path);
  },
);

test("The Templates browser remains usable when home capabilities replace Make", async () => {
  const { editor } = await setupMenus({ slashActions: true, desktop: true });
  const user = userEvent.setup({ delay: null });
  await fill(editor, "Keep my template brief /");
  const menu = await screen.findByTestId("slash-workflow-menu");
  const templates = await waitFor(() => {
    return slashEntry(menu, "Templates ");
  });
  await user.hover(templates);
  const pane = await within(menu).findByRole("region", { name: "Templates" });
  const website = slashEntry(pane, "Website ");
  click(website);
  await waitFor(() => {
    expect(slashEntry(pane, "Website ")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
  click(control("button", "Browse all templates", pane));
  const picker = await screen.findByRole("dialog");
  expect(control("tab", "Presentation", picker)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(editor.textContent).toBe("Keep my template brief ");
});

test("Both menus reopen the remembered creation type and workflow kind without toggling them off", async () => {
  const { editor } = await setupMenus({ slashActions: true });
  const user = userEvent.setup({ delay: null });
  const draft = "Keep my creative brief.";
  await fill(editor, draft);
  await selectAddCapability(editor, user, "Create");
  await screen.findByRole("group", { name: "Presentation templates" });
  click(
    control(
      "radio",
      "Image",
      screen.getByRole("radiogroup", { name: "Create" }),
    ),
  );
  await screen.findByRole("group", { name: "Image styles" });
  await selectAddCapability(editor, user, "Research");
  await screen.findByRole("region", { name: "Research" });

  await fill(editor, `${draft} /create`);
  const createMenu = await screen.findByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(control("button", "Create", createMenu)).toHaveAttribute(
      "data-active",
      "true",
    );
  });
  await user.keyboard("{Enter}");
  await screen.findByRole("group", { name: "Image styles" });
  await expectDraftFocus(editor, `${draft} `);
  await selectAddCapability(editor, user, "Create");
  await screen.findByRole("group", { name: "Image styles" });
  await expectDraftFocus(editor, `${draft} `);

  await selectAddCapability(editor, user, "Workflow");
  await screen.findByRole("region", { name: "Schedule a task" });
  click(
    control(
      "radio",
      "Triggers",
      screen.getByRole("radiogroup", { name: "Workflow" }),
    ),
  );
  await screen.findByRole("region", { name: "Triggers" });
  await selectAddCapability(editor, user, "Find people");
  await screen.findByRole("region", { name: "Find people" });

  await fill(editor, `${draft} /workflow`);
  const workflowMenu = await screen.findByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(control("button", "Workflow", workflowMenu)).toHaveAttribute(
      "data-active",
      "true",
    );
  });
  await user.keyboard("{Enter}");
  await screen.findByRole("region", { name: "Triggers" });
  await selectAddCapability(editor, user, "Workflow");
  await screen.findByRole("region", { name: "Triggers" });
  await expectDraftFocus(editor, `${draft} `);

  click(control("button", "All capabilities"));
  await screen.findByRole("group", { name: "Explore Okou capabilities" });
  await selectAddCapability(editor, user, "Workflow");
  await screen.findByRole("region", { name: "Triggers" });
  await expectDraftFocus(editor, `${draft} `);
});

test.each([false, true])(
  "HomeCapabilities off retains template commands and the add menu with SlashActions=%s",
  async (slashActions) => {
    const { editor } = await setupMenus({
      homeCapabilities: false,
      slashActions,
    });
    const user = userEvent.setup({ delay: null });
    const menu = await openAddMenu(editor, user);
    expect(
      queryAllByRoleFast("menuitem", menu).map(controlLabel),
    ).toStrictEqual(["Attach", "Template", "Import skills"]);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Add" })).toBeNull();
    });

    await fill(editor, "Keep the legacy draft /Website");
    const slashMenu = await screen.findByTestId("slash-workflow-menu");
    await user.click(control("button", "Website", slashMenu));
    const picker = await screen.findByRole("dialog");
    expect(control("tab", "Website", picker)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(editor.textContent).toBe("Keep the legacy draft ");
  },
);

test("Task handoff stays compact until a menu opens a tray without replacing the conversation", async () => {
  const { editor: homeEditor, lifecycle } = await setupMenus();
  const user = userEvent.setup({ delay: null });
  await selectAddCapability(homeEditor, user, "Create");
  await screen.findByRole("group", { name: "Presentation templates" });
  const firstPrompt = "Keep this conversation's history.";
  await fill(homeEditor, firstPrompt);
  click(control("button", "Send", composerCard(homeEditor)));
  const chat = await screen.findByRole("region", { name: "Chat thread" });
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(control("button", "Stop", composerCard(editor))).toBeInTheDocument();
  });
  lifecycle.completeRun("The existing conversation is ready.");
  const answer = await screen.findByText("The existing conversation is ready.");
  expect(within(chat).getByText(firstPrompt)).toBeInTheDocument();
  await waitFor(() => {
    expect(control("button", "Send", composerCard(editor))).toBeInTheDocument();
  });
  // The sticky task survives the first send, but discovery needs a fresh action.
  expect(
    screen.getByRole("combobox", { name: "Slide count" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("tablist", { name: "Explore Okou capabilities" }),
  ).toBeNull();
  const path = window.location.pathname;
  expect(path).toMatch(/^\/chats\//u);

  const followup = "Continue in this conversation";
  await fill(editor, `${followup} /people`);
  const slashMenu = await screen.findByTestId("slash-workflow-menu");
  await waitFor(() => {
    expect(control("button", "Find people", slashMenu)).toHaveAttribute(
      "data-active",
      "true",
    );
  });
  await user.keyboard("{Enter}");
  const people = await screen.findByRole("region", { name: "Find people" });
  await expectDraftFocus(editor, `${followup} `);
  expect(within(chat).getByText(firstPrompt)).toBeInTheDocument();
  expect(answer).toBeInTheDocument();
  expect(
    people.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);

  await selectAddCapability(editor, user, "Research");
  const research = await screen.findByRole("region", { name: "Research" });
  await expectDraftFocus(editor, `${followup} `);
  expect(within(chat).getByText(firstPrompt)).toBeInTheDocument();
  expect(answer).toBeInTheDocument();
  expect(
    research.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);

  expect(window.location.pathname).toBe(path);
});

test("An earlier send cannot dismiss a capability opened for the next draft", async () => {
  const gate = createDeferredPromise<void>(context.signal);
  const path = `/chats/${THREAD_ID}`;
  const { editor } = await setupMenus({ path, sendGate: gate.promise });
  const user = userEvent.setup({ delay: null });
  await selectAddCapability(editor, user, "Find people");
  const prompt = "Find speakers for this event.";
  await fill(editor, prompt);
  const send = control("button", "Send", composerCard(editor));
  click(send);
  await waitFor(() => {
    expect(editor.textContent).toBe("");
  });

  const nextDraft = "Keep this research draft.";
  await fill(editor, nextDraft);
  await selectAddCapability(editor, user, "Research");
  await expectCapability(CAPABILITIES[1]);
  await expectDraftFocus(editor, nextDraft);
  gate.resolve();
  await waitFor(() => {
    expect(control("button", "Send", composerCard(editor))).toBeEnabled();
  });
  await expectCapability(CAPABILITIES[1]);
  expect(editor).toHaveTextContent(nextDraft);
  expect(window.location.pathname).toBe(path);
});

test("A successful send dismisses menu discovery in an existing conversation", async () => {
  const path = `/chats/${THREAD_ID}`;
  const { editor } = await setupMenus({ path });
  const user = userEvent.setup({ delay: null });
  const prompt = "Research this in the current conversation.";
  await fill(editor, prompt);
  await selectAddCapability(editor, user, "Research");
  await expectCapability(CAPABILITIES[1]);
  await expectDraftFocus(editor, prompt);
  const send = control("button", "Send", composerCard(editor));
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  click(send);
  await waitFor(() => {
    expect(
      screen.getByText(prompt).closest('[data-role="user"]'),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Research" })).toBeNull();
  });
  expect(window.location.pathname).toBe(path);
});
