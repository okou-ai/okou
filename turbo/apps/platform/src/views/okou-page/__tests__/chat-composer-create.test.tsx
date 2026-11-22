import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
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
    let choice = queryFastControl("button", new RegExp(name, "i"), menu);
    if (!choice) {
      click(await findFastControl("button", "Create", menu));
      choice = await findFastControl("button", new RegExp(name, "i"));
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
  await mode("Image");
  click(await findFastControl("button", "Add"));
  click(await screen.findByText("Add style"));
  const dialog = await screen.findByRole("dialog");
  await expect(
    findFastControl("tab", "Image", dialog),
  ).resolves.toHaveAttribute("aria-selected", "true");
  return { dialog, editor };
}

test("chat-composer-create-008 Add style opens the Image catalog", async () => {
  const { dialog } = await openImageStyles();
  await expect(
    findFastControl("tab", "Image", dialog),
  ).resolves.toHaveAttribute("aria-selected", "true");
});
test("chat-composer-create-003 selecting an image template preserves the existing prompt, mode and model", async () => {
  const { dialog, editor } = await openImageStyles("Our launch");
  const first = within(dialog).getAllByLabelText(/^Select template /)[0]!;
  const title = first
    .getAttribute("aria-label")!
    .slice("Select template ".length);
  click(first);
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  expect(composerInlineTemplates()).toHaveLength(1);
  expect(composerInlineTemplates()[0]).toHaveTextContent(title);
  expect(editor).toHaveTextContent("Our launch");
  await findFastControl("button", "Remove Image");
  await composerModelTrigger("Claude Fable 5.1");
});
test("chat-composer-create-005 changing the first saved image style preserves both references and intervening text on send", async () => {
  const thread = continuityThread(778, 1, "Style planning");
  const [old, next, last] = ILLUSTRATION_TEMPLATE_ITEMS;
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
  click(within(editor).getByText(old!.title));
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByLabelText("Select template " + next!.title));
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
  expect(msg.indexOf(next!.title)).toBeGreaterThan(-1);
  expect(msg.indexOf("Our launch")).toBeGreaterThan(msg.indexOf(next!.title));
  expect(msg.indexOf(last!.title)).toBeGreaterThan(msg.indexOf("Our launch"));
  expect(msg.indexOf("for the cover")).toBeGreaterThan(
    msg.indexOf(last!.title),
  );
  expect(msg).not.toContain(old!.title);
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
