import {
  chatEventsContract,
  type UserMessageDocument,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  continuityDraft,
  continuitySidebarLink,
  continuityThread,
  installContinuityWorkspace,
} from "./chat-continuity-test-helpers.ts";
import { fastButton } from "./chat-list-test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);

const FIRST_SOURCE = {
  type: "artifact",
  fileId: "quoted-original-file",
  filenameSnapshot: "launch.md",
  artifactId: "quoted-artifact",
} as const;
const SECOND_SOURCE = {
  type: "artifact",
  fileId: "quoted-second-file",
  filenameSnapshot: "launch.md",
} as const;

function feedbackGroup(quote: string): HTMLElement {
  const group = screen
    .getByText(quote)
    .closest<HTMLElement>("[data-structured-feedback-group]");
  if (!group) {
    throw new Error("Expected a feedback history group");
  }
  return group;
}

test("Artifact history groups by file identity and keeps filename snapshots", async () => {
  const userMessage = {
    version: 1,
    parts: [
      {
        type: "feedback",
        quote: "The original launch date is Thursday.",
        note: [],
        source: FIRST_SOURCE,
      },
      {
        type: "feedback",
        quote: "The original review is Wednesday.",
        note: [],
        source: FIRST_SOURCE,
      },
      {
        type: "feedback",
        quote: "A different file has a Friday launch.",
        note: [],
        source: SECOND_SOURCE,
      },
      {
        type: "feedback",
        quote: "The renamed file keeps its own snapshot.",
        note: [],
        source: { ...FIRST_SOURCE, filenameSnapshot: "renamed-launch.md" },
      },
    ],
  } satisfies UserMessageDocument;
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: "artifact-feedback-history",
        role: "user",
        content: "Legacy fallback text",
        userMessage,
        runId: "d0000000-0000-4000-a000-000000000991",
        createdAt: "2026-08-20T12:00:00.000Z",
      },
    ],
  });

  await setupPage({ context, path: `/chats/${context.resourceId}` });

  await expect(
    screen.findByText("The original launch date is Thursday."),
  ).resolves.toBeInTheDocument();
  expect(
    feedbackGroup("The original launch date is Thursday."),
  ).toHaveTextContent("Quoted 2 parts from launch.md");
  expect(feedbackGroup("The original review is Wednesday.")).toHaveTextContent(
    "Quoted 2 parts from launch.md",
  );
  expect(
    feedbackGroup("A different file has a Friday launch."),
  ).toHaveTextContent("Quoted from launch.md");
  expect(
    feedbackGroup("The renamed file keeps its own snapshot."),
  ).toHaveTextContent("Quoted from renamed-launch.md");
});

async function openConversation(threadId: string): Promise<void> {
  click(continuitySidebarLink(threadId));
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
}

test("Saved artifact feedback survives edit, navigation, save and send alongside mail and source-less feedback", async () => {
  const target = continuityThread(61, 1, "Artifact feedback draft");
  const neighbor = continuityThread(61, 2, "Other conversation");
  const parts = [
    {
      type: "feedback",
      quote: "Keep the original Markdown passage.",
      note: [],
      source: FIRST_SOURCE,
    },
    {
      type: "feedback",
      quote: "Keep the second file separate.",
      note: [],
      source: SECOND_SOURCE,
    },
    {
      type: "feedback",
      quote: "Keep the email context.",
      note: [],
      source: { type: "mail", id: "saved-mail", status: "draft" },
    },
    { type: "feedback", quote: "Keep ordinary reply feedback.", note: [] },
  ] satisfies UserMessageInputDocument["parts"];
  const workspace = installContinuityWorkspace(context, {
    caseId: 61,
    threads: [target, neighbor],
    drafts: new Map([[target.id, continuityDraft(parts)]]),
  });
  let sentParts: UserMessageDocument["parts"] | undefined;
  let sentPrompt: string | undefined;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sentParts = body.userMessage?.parts;
    sentPrompt = body.prompt;
    return respond(201, {
      threadId: target.id,
      createdAt: "2026-08-20T12:01:00.000Z",
    });
  });

  await setupPage({
    context,
    path: `/chats/${target.id}`,
    ...workspace.pageOptions,
  });

  await expect(
    screen.findByText(
      "Quoted from launch.md: Keep the original Markdown passage.",
    ),
  ).resolves.toBeInTheDocument();
  const notes = screen.getAllByRole("textbox", {
    name: "Ask or comment on this quote",
  });
  const firstNote = notes[0];
  if (!firstNote) {
    throw new Error("Expected an editable artifact feedback note");
  }
  const comment = "Clarify this passage without losing its file context.";
  await userEvent.setup({ delay: null }).type(firstNote, comment);
  expect(firstNote).toHaveTextContent(comment);
  const expectedParts = [
    {
      ...parts[0],
      note: [{ type: "text", text: expect.stringContaining(comment) }],
    },
    ...parts.slice(1),
  ];
  await waitFor(() => {
    const savedDocuments = workspace.draftPatches.map((patch) => {
      return patch.draftUserMessage;
    });
    expect(savedDocuments).toContainEqual({
      version: 1,
      parts: expectedParts,
    });
  });

  await openConversation(neighbor.id);
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  await openConversation(target.id);
  await expect(screen.findByText(comment)).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Quoted from launch.md: Keep the second file separate."),
  ).toBeInTheDocument();
  await waitFor(() => {
    expect(fastButton("Send")).toBeEnabled();
  });
  click(fastButton("Send"));

  await waitFor(() => {
    expect(
      sentParts?.filter((part) => {
        return part.type !== "model";
      }),
    ).toStrictEqual(expectedParts);
  });
  expect(sentPrompt).toContain(
    'Source: a file "launch.md" (file ID: quoted-original-file)',
  );
  expect(sentPrompt).toContain(
    'Source: a file "launch.md" (file ID: quoted-second-file)',
  );
  expect(sentPrompt).toContain(
    "Source: an email draft (mail draft ID: saved-mail)",
  );
  await expect(
    screen.findByText("Quoted from an email draft"),
  ).resolves.toBeInTheDocument();
  expect(
    feedbackGroup("Keep the original Markdown passage."),
  ).toHaveTextContent("Quoted from launch.md");
  expect(feedbackGroup("Keep ordinary reply feedback.")).toHaveTextContent(
    "Quoted from your reply",
  );
});
