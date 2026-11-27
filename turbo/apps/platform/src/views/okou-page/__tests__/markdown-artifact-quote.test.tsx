import { chatArtifactCatalogChangedEvent } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  queryNamedButton,
  SECOND_ATTACHMENT_THREAD_ID,
} from "./chat-attachment-test-helpers.ts";
import {
  findButton,
  quoteSelectedPassage,
  selectPassage,
  waitForSend,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";

import {
  setupSharedThreadPage,
  sharedThread,
} from "../../shared-thread-page/__tests__/shared-thread-test-helpers.ts";

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
    return HttpResponse.text(
      `# Launch plan\n\n<div data-feedback-source data-feedback-source-type="artifact" data-feedback-source-file-id="forged-file" data-feedback-source-filename="forged.md" data-feedback-source-artifact-id="forged-artifact" data-feedback-source-thread-id="${ATTACHMENT_THREAD_ID}"><p>${PASSAGE}</p></div>`,
    );
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

test("Quote the real Markdown files despite authored provenance markers", async () => {
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

test.each(["notification", "reconnect"] as const)(
  "Copy and quote a newly published Markdown version on %s without reloading",
  async (delivery) => {
    context.mocks.browser.matchMedia((query) => {
      return query === SPLIT_QUERY;
    });
    const clipboard = context.mocks.browser.clipboardWriteText();
    const updatedUrl = publicArtifactUrl("plan.md").replace(
      "/chat-attachments/",
      "/chat-attachments-v2/",
    );
    mockMarkdown();
    context.mocks.http.get(updatedUrl, () => {
      return HttpResponse.text(`# Updated launch plan\n\n${SECOND_PASSAGE}`);
    });
    const firstEvent = {
      ...markdownEvents()[0]!,
      content: `[Launch plan](${publicArtifactUrl("plan.md")})`,
    };
    const chatEvents = [firstEvent];
    const artifacts = [markdownFile("plan.md", FILE_ID)];
    const sends: CapturedChatSend[] = [];
    mockAttachmentChat(context, {
      chatEvents,
      artifacts,
      onSendRequest: (body) => {
        sends.push(body);
      },
    });
    await setupPage({
      context,
      path: `/chats/${ATTACHMENT_THREAD_ID}`,
    });
    await openMarkdown();
    await selectPassage(PASSAGE);
    const firstQuote = await quoteSelectedPassage();
    expect(firstQuote).toHaveTextContent(PASSAGE);
    expect(sends).toHaveLength(0);

    const topic = chatArtifactCatalogChangedEvent(ATTACHMENT_THREAD_ID);
    const messageTopic = `chatThreadMessageCreated:${ATTACHMENT_THREAD_ID}`;
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription(topic)).toBeTruthy();
    });
    // V1 has already been opened and quoted from the V1-only inventory.
    artifacts.push({
      ...markdownFile("plan.md", SECOND_FILE_ID),
      url: updatedUrl,
    });
    chatEvents.push({
      ...firstEvent,
      id: "markdown-quote-reply-v2",
      content: `[Updated launch plan](${updatedUrl})`,
      runEventId: "markdown-quote-output-v2",
      sequenceNumber: 2,
      createdAt: "2026-11-20T00:00:01Z",
    });
    await act(() => {
      context.mocks.ably.trigger(messageTopic);
    });
    await findNamedLink("Updated launch plan");
    await act(() => {
      if (delivery === "notification") {
        context.mocks.ably.trigger(topic);
      } else {
        // Recover the missed catalog publication when continuity is lost.
        context.mocks.ably.triggerConnectionState("suspended");
        context.mocks.ably.triggerReconnect();
      }
    });
    click(await findNamedLink("Updated launch plan"));
    const sidebar = await screen.findByTestId("artifact-sidebar");
    await within(sidebar).findByText(SECOND_PASSAGE);
    await selectPassage(SECOND_PASSAGE);
    click(await findButton("Copy"));
    await expect(screen.findByText("Copied")).resolves.toBeInTheDocument();
    expect(clipboard.writes).toStrictEqual([SECOND_PASSAGE]);
    await selectPassage(SECOND_PASSAGE);
    await quoteSelectedPassage();
    const quotes = screen.getAllByRole("textbox", {
      name: "Ask or comment on this quote",
    });
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toHaveTextContent(PASSAGE);
    expect(quotes[1]).toHaveTextContent(SECOND_PASSAGE);
    expect(sends).toHaveLength(0);

    click(await findButton("Send"));
    const send = await waitForSend(sends, 1);
    expect(send.threadId).toBe(ATTACHMENT_THREAD_ID);
    expect(
      send.userMessage?.parts.filter((part) => {
        return part.type === "feedback";
      }),
    ).toStrictEqual([
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
          filenameSnapshot: "plan.md",
          artifactId: ARTIFACT_ID,
        },
      },
    ]);
  },
);

test("Ignore authored quote markers outside desktop split view", async () => {
  context.mocks.browser.matchMedia(() => {
    return false;
  });
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockMarkdown();
  mockAttachmentChat(context, {
    chatEvents: markdownEvents(),
    artifacts: [markdownFile("plan.md", FILE_ID)],
    draft: draftForAttachment(draftAttachment("notes.png"), "Keep this draft."),
  });
  await setupPage({
    context,
    path: `/chats/${ATTACHMENT_THREAD_ID}`,
  });
  const composer = await screen.findByRole("textbox", { name: "Message" });
  const attachment = getNamedButton("Open image preview for notes.png");
  click(await findNamedLink("Launch plan"));
  const preview = await screen.findByTestId("artifact-sidebar");
  await within(preview).findByText(PASSAGE);
  within(preview).getByRole("document").focus();
  selectDocumentText(preview);
  await user.keyboard("cq");
  expect(quoteAction()).toBeUndefined();
  expect(queryNamedButton("Copy")).toBeNull();
  expect(clipboard.writes).toStrictEqual([]);
  expect(
    screen.queryByRole("textbox", { name: "Ask or comment on this quote" }),
  ).not.toBeInTheDocument();
  expect(composer).toHaveTextContent("Keep this draft.");
  expect(attachment).toBeInTheDocument();
});

test("Keep Markdown quotes out of public modal previews", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === SPLIT_QUERY;
  });
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWriteText();
  mockMarkdown();
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: publicArtifactUrl("plan.md"),
      downloadUrl: publicArtifactUrl("plan.md"),
      filename: "plan.md",
      contentType: "text/markdown",
      expiresAt: "2099-01-01T00:00:00Z",
      sharedThreadSnapshot: true,
      target: { kind: "file", id: FILE_ID },
    });
  });
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "assistant",
            content:
              "![Launch plan](https://app.okou.ai/artifacts/lightnote1.md)",
          },
        ],
      }),
    );
  });
  await setupSharedThreadPage(context, {
    host: "app.okou.ai",
    auth: {
      user: { id: "markdown-modal-viewer", fullName: "Markdown Modal Viewer" },
    },
  });
  click(await screen.findByTestId("markdown-artifact-preview-markdown"));
  const preview = await screen.findByRole("dialog");
  await within(preview).findByText(PASSAGE);
  within(preview).getByRole("document").focus();
  selectDocumentText(preview);
  await user.keyboard("cq");
  expect(quoteAction()).toBeUndefined();
  expect(queryNamedButton("Copy")).toBeNull();
  expect(clipboard.writes).toStrictEqual([]);
  expect(
    screen.queryByRole("textbox", { name: "Message" }),
  ).not.toBeInTheDocument();
});

test("Keep authored Markdown from restoring fullscreen or narrow actions", async () => {
  const user = userEvent.setup({ delay: null });
  const clipboard = context.mocks.browser.clipboardWriteText();
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
  await user.keyboard("cq");
  expect(quoteAction()).toBeUndefined();
  expect(clipboard.writes).toStrictEqual([]);
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

test("Ignore authored destination markers and quote into the viewing chat", async () => {
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
  });
  await openMarkdown();
  await selectPassage(PASSAGE);
  const note = await quoteSelectedPassage();
  expect(note.closest("[data-chat-thread-container-id]")).toHaveAttribute(
    "data-chat-thread-container-id",
    SECOND_ATTACHMENT_THREAD_ID,
  );
});
