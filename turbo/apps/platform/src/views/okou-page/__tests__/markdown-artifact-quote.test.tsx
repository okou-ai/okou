import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  artifactFile,
  draftAttachment,
  draftForAttachment,
  findNamedLink,
  getNamedButton,
  mockAttachmentChat,
  mockSplitAttachmentChats,
  publicArtifactUrl,
  SECOND_ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import {
  findButton,
  quoteSelectedPassage,
  selectPassage,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

const context = testContext();
const PASSAGE = "Review the launch plan carefully.";
const SECOND_PASSAGE = "Check the schedule before announcing.";
const FILE_ID = "c0000000-0000-4000-a000-000000000821";
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000821";
const SECOND_FILE_ID = "c0000000-0000-4000-a000-000000000822";
const SPLIT_QUERY = "(min-width: 80rem)";

function markdownFile(filename: string, id: string) {
  return artifactFile(filename, {
    id,
    artifactId: ARTIFACT_ID,
    contentType: "text/markdown",
  });
}

function markdownEvents() {
  return [
    {
      id: "markdown-quote-reply",
      role: "assistant" as const,
      content: `[Launch plan](${publicArtifactUrl("plan.md")})\n\n[Schedule](${publicArtifactUrl("schedule.md")})`,
      runId: ATTACHMENT_RUN_ID,
      runEventId: "markdown-quote-output",
      sequenceNumber: 1,
      createdAt: "2026-11-20T00:00:00Z",
    },
  ];
}

function mockMarkdown() {
  context.mocks.http.get(publicArtifactUrl("plan.md"), () => {
    return HttpResponse.text(`# Launch plan\n\n${PASSAGE}`);
  });
  context.mocks.http.get(publicArtifactUrl("schedule.md"), () => {
    return HttpResponse.text(`# Schedule\n\n${SECOND_PASSAGE}`);
  });
}

async function openMarkdown(): Promise<HTMLElement> {
  click(await findNamedLink("Launch plan"));
  const sidebar = await screen.findByTestId("artifact-sidebar");
  await within(sidebar).findByText(PASSAGE);
  return sidebar;
}

function quoteAction() {
  return queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-keyshortcuts") === "q";
  });
}

// Native selection also works when the document deliberately has no Quote scope.
function selectDocumentText(container: HTMLElement) {
  const paragraph = within(container).getByText(PASSAGE);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const rect = new DOMRect(24, 24, 200, 24);
  Object.defineProperty(range, "getClientRects", {
    value: () => {
      return [rect];
    },
  });
  Object.defineProperty(range, "getBoundingClientRect", {
    value: () => {
      return rect;
    },
  });
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Native selection is unavailable");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  expect(selection.toString()).toBe(PASSAGE);
}

test("Quote multiple Markdown files without replacing the draft or attachment", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SPLIT_QUERY;
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockMarkdown();
  const sends: CapturedChatSend[] = [];
  mockAttachmentChat(context, {
    chatEvents: markdownEvents(),
    artifacts: [
      markdownFile("plan.md", FILE_ID),
      markdownFile("schedule.md", SECOND_FILE_ID),
    ],
    draft: draftForAttachment(draftAttachment("notes.png"), "Keep this draft."),
    onSendRequest: (body) => {
      return sends.push(body);
    },
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: true,
      [FeatureSwitchKey.MarkdownArtifactQuote]: true,
    },
  });
  await openMarkdown();
  await selectPassage(PASSAGE);
  click(await findButton("Copy"));
  await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([PASSAGE]);
  await selectPassage(PASSAGE);
  await quoteSelectedPassage();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Keep this draft.",
  );
  expect(
    getNamedButton("Open image preview for notes.png"),
  ).toBeInTheDocument();
  expect(sends).toHaveLength(0);

  click(await findNamedLink("Schedule"));
  await screen.findByText(SECOND_PASSAGE);
  await selectPassage(SECOND_PASSAGE);
  await quoteSelectedPassage();
  expect(
    screen.getAllByRole("textbox", { name: "Ask or comment on this quote" }),
  ).toHaveLength(2);
  expect(sends).toHaveLength(0);
  const composer = screen
    .getByRole("textbox", { name: "Message" })
    .closest<HTMLElement>("[data-chat-composer]");
  if (!composer) {
    throw new Error("Owning composer is unavailable");
  }
  click(getNamedButton("Send", composer));
  await waitFor(() => {
    return expect(sends).toHaveLength(1);
  });
  expect(sends[0]?.userMessage?.parts).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "Keep this draft." }),
      expect.objectContaining({ type: "file", filenameSnapshot: "notes.png" }),
      {
        type: "feedback",
        quote: PASSAGE,
        note: [],
        source: {
          type: "artifact",
          fileId: FILE_ID,
          filenameSnapshot: "plan.md",
          artifactId: ARTIFACT_ID,
        },
      },
      {
        type: "feedback",
        quote: SECOND_PASSAGE,
        note: [],
        source: {
          type: "artifact",
          fileId: SECOND_FILE_ID,
          filenameSnapshot: "schedule.md",
          artifactId: ARTIFACT_ID,
        },
      },
    ]),
  );
  expect(sends[0]?.prompt).toContain(FILE_ID);
  expect(sends[0]?.prompt).toContain("plan.md");
});

test.each([
  { enabled: false, wide: true, sidebar: true },
  { enabled: true, wide: false, sidebar: true },
  { enabled: true, wide: true, sidebar: false },
])(
  "Keep native text selection without Quote outside desktop split view: %j",
  async ({ enabled, wide, sidebar }) => {
    context.mocks.browser.matchMedia((query) => {
      return wide && query === SPLIT_QUERY;
    });
    mockMarkdown();
    mockAttachmentChat(context, {
      chatEvents: markdownEvents(),
      artifacts: [markdownFile("plan.md", FILE_ID)],
    });
    await setupPage({
      context,
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.ArtifactSidebarPreview]: sidebar,
        [FeatureSwitchKey.MarkdownArtifactQuote]: enabled,
      },
    });
    click(await findNamedLink("Launch plan"));
    const preview = await screen.findByTestId(
      sidebar ? "artifact-sidebar" : "attachment-lightbox",
    );
    await within(preview).findByText(PASSAGE);
    selectDocumentText(preview);
    expect(quoteAction()).toBeUndefined();
  },
);

test("Dismiss document actions on fullscreen and narrow layouts without removing quoted drafts", async () => {
  const media = context.mocks.browser.matchMedia((query) => {
    return query === SPLIT_QUERY;
  });
  mockMarkdown();
  mockAttachmentChat(context, {
    chatEvents: markdownEvents(),
    artifacts: [markdownFile("plan.md", FILE_ID)],
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: true,
      [FeatureSwitchKey.MarkdownArtifactQuote]: true,
    },
  });
  const sidebar = await openMarkdown();
  await selectPassage(PASSAGE);
  await quoteSelectedPassage();
  await selectPassage(PASSAGE);
  click(getNamedButton("Enter fullscreen", sidebar));
  await waitFor(() => {
    return expect(quoteAction()).toBeUndefined();
  });
  selectDocumentText(sidebar);
  expect(quoteAction()).toBeUndefined();
  expect(
    screen.getByRole("textbox", { name: "Ask or comment on this quote" }),
  ).toHaveTextContent(PASSAGE);
  click(getNamedButton("Exit fullscreen", sidebar));
  await selectPassage(PASSAGE);
  act(() => {
    return media.setMatches(false);
  });
  await waitFor(() => {
    return expect(quoteAction()).toBeUndefined();
  });
  expect(
    screen.getByRole("textbox", { name: "Ask or comment on this quote" }),
  ).toBeInTheDocument();
});

test("Quote a sidebar document into its viewing chat rather than its producing chat", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SPLIT_QUERY;
  });
  mockMarkdown();
  mockSplitAttachmentChats(
    context,
    {
      threadId: ATTACHMENT_THREAD_ID,
      title: "Producing chat",
      events: [{ ...markdownEvents()[0]!, content: "The source chat." }],
      artifacts: [markdownFile("plan.md", FILE_ID)],
    },
    {
      threadId: SECOND_ATTACHMENT_THREAD_ID,
      title: "Viewing chat",
      events: markdownEvents(),
      artifacts: [markdownFile("plan.md", FILE_ID)],
    },
  );
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}?sidebar=${SECOND_ATTACHMENT_THREAD_ID}`,
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: true,
      [FeatureSwitchKey.MarkdownArtifactQuote]: true,
    },
  });
  await openMarkdown();
  await selectPassage(PASSAGE);
  const note = await quoteSelectedPassage();
  expect(note.closest("[data-chat-thread-container-id]")).toHaveAttribute(
    "data-chat-thread-container-id",
    SECOND_ATTACHMENT_THREAD_ID,
  );
});
