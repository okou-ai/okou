import {
  openTemplateRecommendations,
  createTemplateGalleryHelpers,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  readClipboardItemText,
  readSingleRichClipboardWrite,
} from "./chat-clipboard-test-helpers.ts";
import {
  composerInlineTemplates,
  composerModelTrigger,
  createChatComposerHelpers,
  findComposerEditor,
  composerWorkflow,
  THREAD_ID,
} from "./chat-composer-test-helpers.ts";
import {
  continuityDraft,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { SIDEBAR_DESKTOP_MEDIA_QUERY } from "../sidebar-breakpoint.ts";

const context = testContext();

async function mode(name: "Image" | "Presentation") {
  const card = screen.queryByRole("region", { name: "Create" });
  if (card) {
    click(await findFastControl("button", name, card));
  } else {
    const editor = await findComposerEditor();
    await userEvent.click(editor);
    await userEvent.keyboard(" /");
    const menu = await screen.findByTestId("slash-workflow-menu");
    const option = name === "Image" ? /image/i : /presentation/i;
    let choice = queryFastControl("button", option, menu);
    if (!choice) {
      click(await findFastControl("button", "Create", menu));
      choice = await findFastControl("button", option);
    }
    click(choice);
  }
  return await findFastControl("button", "Remove " + name);
}
test("chat-composer-create-001 copying a user prompt omits its generation instruction and settings", async () => {
  const clipboard = context.mocks.browser.clipboardWrite();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    chatEvents: [
      {
        role: "user",
        createdAt: "2026-11-01T09:15:00Z",
        content: "Our launch brief",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "additional_info",
              text: "Create a presentation. Slide count: 20-24",
            },
            { type: "text", text: "Our launch brief" },
          ],
        },
      },
    ],
  });
  await setupPage({ context, path: RUN_PATH });
  const prompt = await screen.findByText("Our launch brief");
  const bubble = prompt.closest("[data-role=user]")! as HTMLElement;
  expect(bubble).not.toHaveTextContent("Slide count");
  expect(bubble).not.toHaveTextContent("Create a presentation");
  await userEvent.hover(bubble);
  click(await findFastControl("button", /Copy/, bubble));
  const item = await readSingleRichClipboardWrite(clipboard);
  await expect(readClipboardItemText(item, "text/plain")).resolves.toBe(
    "Our launch brief",
  );
});
async function openImageStyles(draft?: string) {
  createChatComposerHelpers(context).mockPersonalModelRoutes();
  context.mocks.data.userModelPreference({
    selectedModel: "claude-fable-5-1",
    serviceTier: null,
    modelSettings: {},
    selectedImageModel: null,
    updatedAt: null,
  });
  await setupPage({ context, path: "/" });
  const editor = await findComposerEditor();
  if (draft) {
    await fill(editor, draft);
  }
  const shelf = await openTemplateRecommendations("Image");
  return { shelf, editor };
}

test("chat-composer-create-003 selecting an image template preserves the existing prompt, mode and model", async () => {
  const { shelf, editor } = await openImageStyles("Our launch");
  const title = ILLUSTRATION_TEMPLATE_ITEMS[0]!.title;
  click(await findFastControl("button", "Use template " + title, shelf));
  await within(editor).findByText(title);
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(title);
  expect(editor).toHaveTextContent("Our launch");
  await findFastControl("button", "Remove Image");
  await composerModelTrigger("Claude Fable 5.1");
});
test("chat-composer-create-005 the saved image styles retain both references and intervening text on send", async () => {
  const thread = continuityThread(778, 1, "Style planning");
  const [old, , last] = ILLUSTRATION_TEMPLATE_ITEMS;
  const template = (item: typeof old) => {
    return {
      type: "template" as const,
      titleSnapshot: item!.title,
      template: {
        type: "illustration" as const,
        selection: { illustrationStyleId: item!.illustrationStyleId },
      },
    };
  };
  const saved = continuityDraft([
    template(old),
    { type: "text", text: "Our launch" },
    template(last),
    { type: "text", text: "for the cover." },
  ]);
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    threadId: thread.id,
    onSendRequest: (b) => {
      return sent.resolve(b.userMessage);
    },
  });
  const w = installContinuityWorkspace(context, {
    caseId: 778,
    threads: [thread],
    drafts: new Map([[thread.id, saved]]),
  });
  await setupPage({ context, path: "/chats/" + thread.id, ...w.pageOptions });
  const editor = await findComposerEditor();
  await within(editor).findByText(old!.title);
  await mode("Image");
  click(await findFastControl("button", "Send"));
  await expect(sent.promise).resolves.toMatchObject({
    parts: expect.arrayContaining([
      expect.objectContaining({
        type: "additional_info",
        text: expect.stringMatching(/image/i),
      }),
    ]),
  });
  const msg = JSON.stringify(await sent.promise);
  expect(msg.indexOf(old!.title)).toBeGreaterThan(-1);
  expect(msg.indexOf("Our launch")).toBeGreaterThan(msg.indexOf(old!.title));
  expect(msg.indexOf(last!.title)).toBeGreaterThan(msg.indexOf("Our launch"));
  expect(msg.indexOf("for the cover")).toBeGreaterThan(
    msg.indexOf(last!.title),
  );
});
test("chat-composer-create-009 leaving Presentation mode sends the edited ordinary draft with its template", async () => {
  const thread = continuityThread(779, 1, "Normal draft");
  const saved = continuityDraft([
    { type: "text", text: "Our launch /notes" },
    {
      type: "template",
      titleSnapshot: "Review deck",
      template: {
        type: "presentation",
        selection: { templateId: "local-review" },
      },
    },
  ]);
  const sent = context.mocks.deferred<unknown>();
  mockChatLifecycle(context, {
    threadId: thread.id,
    onSendRequest: (b) => {
      return sent.resolve(b.userMessage);
    },
  });
  const w = installContinuityWorkspace(context, {
    caseId: 779,
    threads: [thread],
    drafts: new Map([[thread.id, saved]]),
  });
  await setupPage({ context, path: "/chats/" + thread.id, ...w.pageOptions });
  const editor = await findComposerEditor();
  await within(editor).findByText("Review deck");
  const remove = await mode("Presentation");
  click(remove);
  expect(editor).toHaveTextContent("Our launch /notes");
  expect(editor).toHaveTextContent("Review deck");
  click(await findFastControl("button", "Send"));
  const body = await sent.promise;
  expect(body).toMatchObject({
    parts: expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Our launch /notes" }),
      expect.objectContaining({
        type: "template",
        titleSnapshot: "Review deck",
      }),
    ]),
  });
  expect(JSON.stringify(body)).not.toContain("additional_info");
});

test("chat-composer-create-002 queuing a presentation keeps the member's typed instruction separate from its slide settings", async () => {
  const queued = context.mocks.deferred<unknown>();
  const run = crypto.randomUUID();
  const text = "Create a presentation. Keep these words in my message.";
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    activeRunIds: [run],
    chatEvents: [
      {
        role: "user",
        content: "Review the initial outline",
        runId: run,
        createdAt: "2026-08-01T10:00:00Z",
      },
    ],
    onQueuedEventAppend(body) {
      queued.resolve(body.userMessage);
    },
  });
  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: true },
  });
  await screen.findByText("Review the initial outline");
  const editor = await findComposerEditor();
  const shelf = await openTemplateRecommendations("Presentation");
  click(await within(shelf).findByText("Paper magazine"));
  await findFastControl("button", "Remove Presentation");
  await fill(editor, text);
  click(await screen.findByLabelText("Slide count"));
  click(await screen.findByText("20–24 slides"));
  click(await findFastControl("button", "Send"));
  await expect(queued.promise).resolves.toMatchObject({
    parts: expect.arrayContaining([
      { type: "text", text },
      {
        type: "additional_info",
        text: expect.stringMatching(
          /Create a presentation[\s\S]*Slide count: 20-24/i,
        ),
      },
    ]),
  });
  await screen.findByText(text);
});

test("chat-composer-add-menu-002 follows the workflow link from skill import", async () => {
  await setupPage({ context, path: "/" });
  await clickComposerAddMenuItem("Import skills");
  const dialog = await screen.findByRole("dialog", {
    name: "Import your skills",
  });
  expect(
    within(dialog).getByText("Copy prompt").closest("button"),
  ).toBeEnabled();
  click(within(dialog).getByText("View workflows"));
  await expect(
    screen.findByRole("heading", { name: "Workflows", level: 1 }),
  ).resolves.toBeInTheDocument();
  expect(location.pathname).toBe("/workflows");
  expect(dialog).not.toBeInTheDocument();
});

test("chat-composer-add-menu-004 accepts the file returned by the Attach picker", async () => {
  const file = new File(["Draft"], "brief.txt", { type: "text/plain" });
  const id = "30000000-0000-4000-8000-000000000022";
  context.mocks.upload.success({
    id,
    filename: file.name,
    size: file.size,
    contentType: file.type,
    url: "/artifacts/30000000000040008000000000000022.txt",
  });
  await setupPage({ context, path: "/" });
  const input = await screen.findByLabelText("Attach", {
    selector: 'input[type="file"]',
  });
  const picked = context.mocks.deferred<HTMLInputElement>();
  Object.defineProperty(input, "showPicker", {
    value(this: HTMLInputElement) {
      picked.resolve(this);
    },
  });
  await clickComposerAddMenuItem("Attach");
  const picker = await picked.promise;
  await waitFor(() => {
    expect(screen.queryByRole("menu", { name: "Add" })).not.toBeInTheDocument();
  });
  await userEvent.upload(picker, file);
  await expect(
    screen.findByLabelText("Remove brief.txt"),
  ).resolves.toBeEnabled();
  expect(screen.getByText("brief.txt")).toBeInTheDocument();
});

const { mockTemplateChat } = createTemplateGalleryHelpers(context);

const DRAFT = "Plan the offsite";

async function composerCard(): Promise<HTMLElement> {
  const editor = await findComposerEditor();
  const card = editor.closest<HTMLElement>('[data-slot="chat-composer-card"]');
  if (!card) {
    throw new Error("Expected the composer card");
  }
  return card;
}

async function typeDraft(text: string): Promise<void> {
  const user = userEvent.setup({ delay: null });
  await user.click(await findComposerEditor());
  await user.paste(text);
  await expect(findComposerEditor()).resolves.toHaveTextContent(text.trim());
}

function labelled(container: ParentNode, label: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
}

/** The open menu or dialog whose accessible name is `name`. */
async function findPopup(
  role: "menu" | "dialog",
  name: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const popup = [
      ...document.querySelectorAll<HTMLElement>(`[role="${role}"]`),
    ].find((candidate) => {
      const labelledBy = candidate.getAttribute("aria-labelledby");
      const label =
        candidate.getAttribute("aria-label") ??
        (labelledBy ? document.getElementById(labelledBy)?.textContent : null);
      return label?.trim() === name;
    });
    if (!popup) {
      throw new Error(`Expected the ${name} ${role}`);
    }
    return popup;
  });
}

async function chooseAddItem(name: string): Promise<void> {
  click(labelled(await composerCard(), "Add") as HTMLElement);
  const menu = await findPopup("menu", "Add");
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected the ${name} item`);
  }
  click(item);
}

function capability(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
}

async function expectComposerFocusedWithDraft(): Promise<void> {
  const editor = await findComposerEditor();
  await waitFor(() => {
    expect(document.activeElement).toBe(editor);
  });
  expect(editor).toHaveTextContent(DRAFT);
}

function useDesktopLayout(): void {
  context.mocks.browser.matchMedia((query) => {
    return (
      query === SIDEBAR_DESKTOP_MEDIA_QUERY || query === "(min-width: 1280px)"
    );
  });
}

function slashMenuItems(): HTMLElement[] {
  const menu = document.querySelector<HTMLElement>("[role=dialog]");
  return menu ? [...menu.querySelectorAll<HTMLElement>("button")] : [];
}

test("The add menu opens each home capability and restores its own trigger only on dismissal", async () => {
  mockTemplateChat();
  await setupPage({ context, path: "/" });
  await typeDraft(DRAFT);
  const homeChat = window.location.pathname;
  const card = await composerCard();
  const attach = card.querySelector<HTMLInputElement>(
    'input[aria-label="Attach"]',
  );
  if (!attach) {
    throw new Error("Expected the Attach file input");
  }
  // Happy DOM has no native file picker, so its opening is recorded here.
  const picker = { opened: false };
  Object.defineProperty(attach, "showPicker", {
    value: () => {
      picker.opened = true;
    },
  });

  click(labelled(card, "Add") as HTMLElement);
  const menu = await findPopup("menu", "Add");
  expect(
    queryAllByRoleFast("menuitem", menu).map((item) => {
      return item.textContent?.trim();
    }),
  ).toStrictEqual([
    "Attach",
    "Project",
    "Find people",
    "Research",
    "Create",
    "Workflow",
    "Import skills",
  ]);
  await userEvent.keyboard("{Escape}");

  for (const name of ["Find people", "Research"]) {
    await chooseAddItem(name);
    await waitFor(() => {
      expect(capability(name)).toBeInTheDocument();
    });
    expect(labelled(card, `Remove ${name}`)).toBeInTheDocument();
    await expectComposerFocusedWithDraft();
  }

  await chooseAddItem("Create");
  await waitFor(() => {
    expect(labelled(card, "Remove Presentation")).toBeInTheDocument();
  });
  await expectComposerFocusedWithDraft();

  await chooseAddItem("Workflow");
  await waitFor(() => {
    expect(labelled(card, "Remove Workflow")).toBeInTheDocument();
  });
  await expectComposerFocusedWithDraft();

  await chooseAddItem("Import skills");
  await expect(
    findPopup("dialog", "Import your skills"),
  ).resolves.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expectComposerFocusedWithDraft();

  // Attach hands off to the browser's file picker; the draft stays.
  await chooseAddItem("Attach");
  await waitFor(() => {
    expect(picker.opened).toBeTruthy();
  });
  await expect(findComposerEditor()).resolves.toHaveTextContent(DRAFT);
  expect(window.location.pathname).toBe(homeChat);

  // Dismissing the menu, rather than choosing an item, restores its trigger.
  await userEvent.click(await findComposerEditor());
  click(labelled(card, "Add") as HTMLElement);
  await findPopup("menu", "Add");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(document.activeElement).toBe(labelled(card, "Add"));
  });
});

test("Slash capabilities preserve the draft with SlashActions=false and desktop=true", async () => {
  useDesktopLayout();
  mockTemplateChat();
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, [
      composerWorkflow("daily-recap", "Summarize yesterday's work"),
    ]);
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.SlashActions]: false },
  });
  await typeDraft(`${DRAFT} `);
  const card = await composerCard();
  const user = userEvent.setup({ delay: null });

  await user.keyboard("/");

  await waitFor(() => {
    expect(
      slashMenuItems().map((item) => {
        return item.textContent?.replace(/\s+/gu, " ").trim();
      }),
    ).toStrictEqual([
      "/daily-recap Summarize yesterday's work",
      "Workflow",
      "Create",
      "Research",
      "Find people",
    ]);
  });

  let first = true;
  for (const [name, chip] of [
    ["Find people", "Remove Find people"],
    ["Research", "Remove Research"],
    ["Create", "Remove Presentation"],
    ["Workflow", "Remove Workflow"],
  ] as const) {
    if (!first) {
      await user.keyboard("/");
    }
    first = false;
    const item = await waitFor(() => {
      const found = slashMenuItems().find((candidate) => {
        return candidate.textContent?.trim() === name;
      });
      if (!found) {
        throw new Error(`Expected the ${name} slash item`);
      }
      return found;
    });
    click(item);
    await waitFor(() => {
      expect(labelled(card, chip)).toBeInTheDocument();
    });
    // The slash that opened the menu is consumed; the draft stays.
    const editor = await findComposerEditor();
    expect(editor.textContent?.trim()).toBe(DRAFT);
    expect(window.location.pathname).toBe(`/chats/${THREAD_ID}`);
  }
});

test("A successful send dismisses menu discovery in an existing conversation", async () => {
  mockTemplateChat();
  await setupPage({ context, path: `/chats/${THREAD_ID}` });
  await typeDraft("Draft the launch recap");
  await chooseAddItem("Research");
  await waitFor(() => {
    expect(capability("Research")).toBeInTheDocument();
  });

  await userEvent.keyboard("{Enter}");

  await expect(
    screen.findByText("Draft the launch recap", {
      selector: "[data-role='user'] *",
    }),
  ).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(capability("Research")).not.toBeInTheDocument();
  });
  expect(window.location.pathname).toBe(`/chats/${THREAD_ID}`);
});
