import { suggestionContextPart } from "@okouai/api-contracts/contracts/suggestion-context";
import { installCorrespondence } from "./correspondence-test-fixtures.ts";
import userEvent from "@testing-library/user-event";
import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityAttachment,
  continuityDraft,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { findEnabledButton } from "./chat-run-test-fixtures.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";

const context = testContext();

async function openDraft(
  caseId: number,
  parts: Parameters<typeof continuityDraft>[0],
  attachments: Parameters<typeof continuityDraft>[1] = [],
) {
  const chat = continuityThread(caseId, 2, "Copy review");
  const sent = context.mocks.deferred<{
    prompt: string;
    userMessage?: UserMessageDocument;
  }>();
  mockChatLifecycle(context, {
    threadId: chat.id,
    onSendRequest: (body) => {
      return sent.resolve(body);
    },
  });
  const draft = continuityDraft(parts, attachments);
  const workspace = installContinuityWorkspace(context, {
    caseId,
    threads: [chat],
    drafts: new Map([[chat.id, draft]]),
  });
  await setupPage({
    context,
    path: "/chats/" + chat.id,
    ...workspace.pageOptions,
  });
  return {
    threadId: chat.id,
    editor: await findComposerEditor(),
    async saveAgain() {
      const extra = continuityAttachment(caseId, 9, "scratch.txt");
      context.mocks.upload.success(extra);
      const input = document.querySelector<HTMLInputElement>(
        "input[type=file][multiple]",
      )!;
      await userEvent.upload(
        input,
        new File(["scratch"], extra.filename, { type: "text/plain" }),
      );
      const remove = await findEnabledButton("Remove scratch.txt");
      await waitFor(() => {
        return expect(
          workspace.draftPatches.at(-1)?.draftUserMessage?.parts,
        ).toContainEqual(
          expect.objectContaining({ type: "file", fileId: extra.id }),
        );
      });
      click(remove);
      await waitFor(() => {
        return expect(
          workspace.draftPatches.at(-1)?.draftUserMessage,
        ).toStrictEqual({ version: 1, parts });
      });
    },
    async send() {
      click(await findEnabledButton("Send"));
      const message = await sent.promise;
      await waitFor(() => {
        return expect(
          workspace.draftPatches.at(-1)?.draftUserMessage,
        ).toBeNull();
      });
      return message;
    },
  };
}
test("user-message-document-008 Sending the annotated drawing preserves the original image and its marked region", async () => {
  const original = continuityAttachment(784, 1, "entrance.png", "image/png");
  const annotations = {
    marks: [
      {
        id: "east-entry",
        shape: "box" as const,
        rect: { x: 0.22, y: 0.18, width: 0.32, height: 0.4 },
        ink: "#A81A3A",
        note: "Widen entrance",
      },
    ],
  };
  const file = {
    ...original,
    annotations,
    annotatedFileId: continuityAttachment(784, 2, "marked.png").id,
  };
  const part = {
    type: "file",
    fileId: file.id,
    filenameSnapshot: file.filename,
    contentType: file.contentType,
    annotations,
    annotatedFileId: file.annotatedFileId,
  } as const;
  const draft = await openDraft(784, [part], [file]);
  await expect(findEnabledButton("Remove entrance.png")).resolves.toBeVisible();
  expect((await draft.send()).userMessage?.parts).toContainEqual(part);
});

test("user-message-document-011 Templates embedded in the draft and in quoted feedback reach the run in order", async () => {
  const deck = {
    type: "template",
    titleSnapshot: "Pitch deck",
    template: {
      type: "presentation",
      selection: { templateId: "investor-review" },
    },
  } as const;
  const paper = {
    type: "template",
    titleSnapshot: "Paper cut",
    template: {
      type: "illustration",
      selection: { illustrationStyleId: "paper-cut" },
    },
  } as const;
  const parts: UserMessageDocument["parts"] = [
    { type: "text", text: "Prepare " },
    deck,
    { type: "text", text: "with " },
    paper,
    {
      type: "feedback",
      quote: "Market overview",
      note: [{ type: "text", text: "Redraw using " }, paper],
    },
  ];
  const draft = await openDraft(785, parts);
  expect(draft.editor.textContent).toMatch(
    /Prepare.*Pitch deck.*with.*Paper cut.*Market overview.*Redraw using.*Paper cut/su,
  );
  await draft.saveAgain();
  const sent = await draft.send();
  expect(sent.userMessage?.parts).toStrictEqual([
    ...parts,
    expect.objectContaining({ type: "model" }),
  ]);
  expect(sent.prompt).toMatch(
    /Prepare.*Pitch deck.*with.*Paper cut.*Market overview.*Redraw using.*Paper cut/su,
  );
});

test("user-message-document-017 The editor and outgoing prompt keep both mentions of the same project", async () => {
  const project = {
    type: "project",
    projectId: "b23111c2-7834-40b3-a3b1-a2c344c61a42",
    nameSnapshot: "Campus renewal",
  } as const;
  const parts: UserMessageDocument["parts"] = [
    { type: "text", text: "Revisit " },
    project,
    { type: "feedback", quote: "Landscaping", note: [project] },
  ];
  const draft = await openDraft(786, parts);
  expect(draft.editor.textContent).toMatch(
    /Campus renewal.*Landscaping.*Campus renewal/su,
  );
  await draft.saveAgain();
  const sent = await draft.send();
  expect(sent.userMessage?.parts).toStrictEqual([
    ...parts,
    expect.objectContaining({ type: "model" }),
  ]);
  expect(sent.prompt.split("/projects/" + project.projectId)).toHaveLength(3);
});

test("user-message-document-012 Saving a restored multiline draft keeps its hard break, blank paragraph and edge spaces", async () => {
  const lines = ["  North wing", "Door schedule  ", "", "Final delivery  "];
  const draft = await openDraft(798, [
    { type: "text", text: lines.join("\n") },
  ]);
  expect(draft.editor.innerHTML).toContain("  North wing");
  expect(draft.editor.textContent).toContain("Final delivery  ");
  await draft.saveAgain();
});

test("user-message-document-016 A restored suggestion keeps its feedback while the linked message shows its title", async () => {
  const suggestion = suggestionContextPart({
    suggestionId: "1163d0a5-ddcf-4039-89e8-ff57b6978069",
    draftId: "9608fa1a-497b-4f23-a16f-8a8dc28aba35",
    optionId: "custom",
    titleSnapshot: "Renew the lease",
    rationaleSnapshot: "The lease expires next quarter",
    contextVersion: "verified-lease",
    attachmentIds: [],
  });
  const source = "PROPERTY-204";
  const direction = "Compare the two renewal periods";
  const parts: UserMessageDocument["parts"] = [
    { type: "text", text: "Prepare the renewal" },
    suggestion,
    {
      type: "feedback",
      quote: "See annex " + source + " for the revised terms",
      note: [{ type: "text", text: direction }],
    },
  ];
  const draft = await openDraft(799, parts);
  expect(draft.editor.textContent).toContain(direction);
  await draft.saveAgain();
  const sent = await draft.send();
  expect(sent.prompt).toContain(source);
  expect(sent.prompt).toContain(direction);
  const doc = sent.userMessage;
  if (!doc) {
    throw new Error("The sent request omitted the suggestion document");
  }
  const display = await installCorrespondence(context, draft.threadId, () => {
    return doc;
  })();
  expect(display).toContain("Renew the lease");
  expect(display).not.toContain(source);
});
