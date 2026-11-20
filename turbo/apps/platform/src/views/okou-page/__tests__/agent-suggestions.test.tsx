import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  feedContract,
  type Suggestion,
  type SuggestionOption,
} from "@okouai/api-contracts/contracts/feed";
import {
  chatEventsContract,
  chatThreadByIdContract,
  chatThreadDraftContract,
  chatThreadMetadataContract,
  chatThreadsContract,
  type ChatEventSendBody,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { sidebarThreadLinks } from "./chat-list-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { nowDate } from "../../../lib/time.ts";
import {
  mockChatThreadSnapshotResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const SECONDARY_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const FIRST_CARD_ID = "a0000000-0000-4000-a000-000000000001";
const SECOND_CARD_ID = "a0000000-0000-4000-a000-000000000002";
const SOURCE_THREAD_ID = "b2000000-0000-4000-a000-000000000001";
const TARGET_THREAD_ID = "b2000000-0000-4000-a000-000000000002";
const CONSUME_TOKEN = "a".repeat(64);

interface Attachment {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
}

function attachment(id: string, filename: string): Attachment {
  return {
    id,
    url: `https://files.example.com/${id}`,
    filename,
    contentType: "application/pdf",
    size: 2048,
  };
}

function fileParts(files: readonly Attachment[]) {
  return files.map((file) => {
    return {
      type: "file" as const,
      fileId: file.id,
      filenameSnapshot: file.filename,
      contentType: file.contentType,
    };
  });
}

interface OptionSpec {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly threadId?: string;
  readonly reference?: { readonly threadId: string; readonly title: string };
  readonly files?: readonly Attachment[];
}

function option(spec: OptionSpec): SuggestionOption {
  const files = spec.files ?? [];
  return {
    id: spec.id,
    label: spec.label,
    description: "",
    threadId: spec.threadId ?? null,
    draft: {
      draftUserMessage: {
        version: 1,
        parts: [
          { type: "text", text: spec.text },
          ...(spec.reference
            ? [
                {
                  type: "chat_thread" as const,
                  threadId: spec.reference.threadId,
                  titleSnapshot: spec.reference.title,
                },
              ]
            : []),
          ...fileParts(files),
        ],
      },
      draftAttachments: files.length > 0 ? [...files] : null,
    },
  };
}

function suggestion(spec: {
  readonly id: string;
  readonly title: string;
  readonly options?: readonly OptionSpec[];
  readonly background?: string;
  readonly backgroundFiles?: readonly Attachment[];
  readonly consumeToken?: string;
  readonly customThreadId?: string;
}): Suggestion {
  const backgroundFiles = spec.backgroundFiles ?? [];
  return {
    id: spec.id,
    type: "suggestion",
    priority: 0,
    createdAt: nowDate().toISOString(),
    updatedAt: nowDate().toISOString(),
    expiresAt: new Date(nowDate().getTime() + 3_600_000).toISOString(),
    content: {
      title: spec.title,
      rationale: `Why ${spec.title} matters now`,
      options: (
        spec.options ?? [
          {
            id: "send",
            label: `Start ${spec.title}`,
            text: `Please start: ${spec.title}`,
          },
        ]
      ).map(option),
      customOption: {
        id: "custom",
        threadId: spec.customThreadId ?? null,
        draft: {
          draftUserMessage: {
            version: 1,
            parts: [
              {
                type: "feedback",
                quote: spec.background ?? `Background for ${spec.title}`,
                note: [],
              },
              ...fileParts(backgroundFiles),
            ],
          },
          draftAttachments:
            backgroundFiles.length > 0 ? [...backgroundFiles] : null,
        },
      },
    },
    state: { status: "active", selectedOptionId: null, feedbacks: [] },
    ...(spec.consumeToken ? { consumeToken: spec.consumeToken } : {}),
  };
}

interface ConsumeRequest {
  readonly id: string;
  readonly optionId: string | null;
  readonly consumeToken: string | undefined;
}

function installFeed(
  cards: readonly Suggestion[],
  consume?: (request: ConsumeRequest) => Promise<number> | number,
) {
  let items = [...cards];
  const consumed: ConsumeRequest[] = [];
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items });
  });
  context.mocks.api(feedContract.consume, async ({ params, body, respond }) => {
    const request = {
      id: params.id,
      optionId: body.optionId,
      consumeToken: body.snapshot?.consumeToken,
    };
    consumed.push(request);
    const card = cards.find((candidate) => {
      return candidate.id === params.id;
    });
    const status = consume ? await consume(request) : 200;
    if (status === 409 || !card) {
      return respond(409, {
        error: { code: "CONFLICT", message: "Suggestion already consumed" },
      });
    }
    return respond(200, {
      ...card,
      state: {
        status: "consumed",
        selectedOptionId: body.optionId,
        feedbacks: [],
      },
    });
  });
  return {
    consumed,
    removeFromPool(id: string) {
      items = items.filter((item) => {
        return item.id !== id;
      });
    },
  };
}

interface ThreadCreate {
  readonly clientThreadId: string | undefined;
  readonly title: string | undefined;
  readonly agentId: string;
}

function recordNewChats(failSends = 0) {
  const creates: ThreadCreate[] = [];
  const sends: ChatEventSendBody[] = [];
  let failures = failSends;
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    creates.push({
      clientThreadId: body.clientThreadId,
      title: body.title,
      agentId: body.agentId,
    });
    return respond(201, {
      id: body.clientThreadId ?? crypto.randomUUID(),
      title: body.title ?? null,
      createdAt: nowDate().toISOString(),
      selectedModel: body.model ?? null,
      serviceTier: body.serviceTier ?? null,
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sends.push(body);
    if (failures > 0) {
      failures -= 1;
      return respond(503, {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Follow-up temporarily unavailable",
        },
      });
    }
    return respond(201, {
      threadId: "threadId" in body && body.threadId ? body.threadId : "",
      createdAt: nowDate().toISOString(),
    });
  });
  return { creates, sends };
}

function installHomeDraft(text: string, files: readonly Attachment[] = []) {
  const patches: unknown[] = [];
  context.mocks.api(agentDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text }, ...fileParts(files)],
      },
      draftAttachments: files.length > 0 ? [...files] : null,
    });
  });
  context.mocks.api(agentDraftContract.patch, ({ body, respond }) => {
    patches.push(body);
    return respond(204);
  });
  return patches;
}

function chatThread(id: string, title: string, agentId = DEFAULT_AGENT_ID) {
  return {
    id,
    agentId,
    title,
    sortAt: "2026-03-10T00:00:00Z",
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    pinnedAt: null,
    archived: false,
    renamedAt: null,
    selectedModel: null,
    serviceTier: null,
    modelSettings: {},
    computerUseHostId: null,
    cloudBrowserEnabled: false,
  };
}

function installChats(threads: readonly ReturnType<typeof chatThread>[]) {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(
      200,
      mockChatThreadSnapshotResponse(context, {
        chatThreads: threads,
        latestEventId: null,
        latestSeqId: null,
      }),
    );
  });
}

async function openForYou(path = "/for-you"): Promise<void> {
  await setupPage({
    context,
    path,
    featureSwitches: { [FeatureSwitchKey.AgentSuggestion]: true },
  });
}

async function findCard(title: string): Promise<HTMLElement> {
  return await screen.findByRole("article", { name: title });
}

function messageText(document: UserMessageDocument | undefined): string {
  return (document?.parts ?? [])
    .map((part) => {
      return part.type === "text"
        ? part.text
        : part.type === "feedback"
          ? part.quote
          : part.type;
    })
    .join("\n");
}

function sentDocument(body: ChatEventSendBody | undefined) {
  return body && "userMessage" in body ? body.userMessage : undefined;
}

function editorIn(container: HTMLElement): HTMLElement {
  const editor = container.querySelector('[contenteditable="true"]');
  if (!(editor instanceof HTMLElement)) {
    throw new Error("Expected a composer editor");
  }
  return editor;
}

function queryControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast(role, container).find((candidate) => {
      return (
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.replace(/\s+/gu, " ").trim() === name
      );
    }) ?? null
  );
}

function control(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): HTMLElement {
  const element = queryControl(role, name, container);
  if (!element) {
    throw new Error(`Expected ${role} named "${name}"`);
  }
  return element;
}

async function findControl(
  role: "button" | "link",
  name: string,
  container: ParentNode = document.body,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return control(role, name, container);
  });
}

function chatComposer(): HTMLElement {
  const composer = document.querySelector('[data-slot="chat-composer-card"]');
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Chat composer is not mounted");
  }
  return composer;
}

async function openDirection(card: HTMLElement): Promise<HTMLElement> {
  click(control("button", "What do you have in mind?", card));
  return await waitFor(() => {
    const composer = card.querySelector('[data-slot="chat-composer-card"]');
    if (!(composer instanceof HTMLElement)) {
      throw new Error("Direction composer is not open");
    }
    return composer;
  });
}

async function typeDirection(
  composer: HTMLElement,
  text: string,
): Promise<void> {
  const user = userEvent.setup({ delay: null });
  await user.click(editorIn(composer));
  await user.paste(text);
  await waitFor(() => {
    expect(editorIn(composer)).toHaveTextContent(text);
  });
}

async function sendFrom(composer: HTMLElement): Promise<void> {
  const send = control("button", "Send", composer);
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  click(send);
}

async function openHome(): Promise<HTMLElement> {
  click(control("link", "Chat"));
  return await waitFor(() => {
    const editor = document.querySelector(
      '[data-slot="chat-composer-card"] [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Home composer is not mounted");
    }
    return editor;
  });
}

test("A cached card still sends its action after server cleanup", async () => {
  const card = suggestion({
    id: FIRST_CARD_ID,
    title: "Close the vendor review",
    consumeToken: CONSUME_TOKEN,
  });
  const feed = installFeed([card]);
  const { sends } = recordNewChats();
  await openForYou();
  const loaded = await findCard("Close the vendor review");
  feed.removeFromPool(FIRST_CARD_ID);

  click(control("button", "Start Close the vendor review", loaded));

  await waitFor(() => {
    expect(feed.consumed).toStrictEqual([
      { id: FIRST_CARD_ID, optionId: "send", consumeToken: CONSUME_TOKEN },
    ]);
  });
  expect(messageText(sentDocument(sends[0]))).toBe(
    "Please start: Close the vendor review",
  );
  expect(location.pathname).toBe("/for-you");
});

test("Choosing an action sends it to a new thread and keeps the homepage draft", async () => {
  const patches = installHomeDraft("My saved draft");
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Prepare the launch brief",
      options: [
        {
          id: "brief",
          label: "Draft the brief",
          text: "Draft the launch brief from the planning chat",
          reference: { threadId: SOURCE_THREAD_ID, title: "Launch planning" },
        },
        {
          id: "agenda",
          label: "Draft the agenda",
          text: "Draft the launch agenda",
        },
      ],
    }),
    suggestion({ id: SECOND_CARD_ID, title: "Review the budget" }),
  ]);
  const { creates, sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Prepare the launch brief");

  click(control("button", "Draft the brief", card));

  await expect(findCard("Review the budget")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(creates).toStrictEqual([
    {
      clientThreadId: expect.any(String),
      title: "Prepare the launch brief",
      agentId: DEFAULT_AGENT_ID,
    },
  ]);
  const message = sentDocument(sends[0]);
  expect(message?.parts).toContainEqual({
    type: "chat_thread",
    threadId: SOURCE_THREAD_ID,
    titleSnapshot: "Launch planning",
  });
  expect(messageText(message)).toContain(
    "Draft the launch brief from the planning chat",
  );
  expect(messageText(message)).not.toContain("Draft the launch agenda");
  expect(location.pathname).toBe("/for-you");

  const homeEditor = await openHome();
  await waitFor(() => {
    expect(homeEditor).toHaveTextContent("My saved draft");
  });
  expect(homeEditor).not.toHaveTextContent("Draft the launch brief");
  expect(patches).toStrictEqual([]);
});

test("A choice is still sent when another session consumed the card", async () => {
  const feed = installFeed(
    [suggestion({ id: FIRST_CARD_ID, title: "Answer the auditor" })],
    () => {
      return 409;
    },
  );
  const { sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Answer the auditor");
  feed.removeFromPool(FIRST_CARD_ID);

  click(control("button", "Start Answer the auditor", card));

  await waitFor(() => {
    expect(feed.consumed).toHaveLength(1);
  });
  expect(messageText(sentDocument(sends[0]))).toBe(
    "Please start: Answer the auditor",
  );
  await expect(
    screen.findByText("Sent to a new chat"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(location.pathname).toBe("/for-you");
});

test("The loaded option keeps its draft and destination when the server responds with a later version", async () => {
  const loaded = suggestion({
    id: FIRST_CARD_ID,
    title: "Plan the offsite",
    options: [
      { id: "plan", label: "Plan it", text: "Plan the offsite agenda" },
    ],
  });
  const later = suggestion({
    id: FIRST_CARD_ID,
    title: "Plan the offsite",
    options: [
      {
        id: "plan",
        label: "Plan it",
        text: "Use the revised offsite agenda",
        threadId: TARGET_THREAD_ID,
      },
    ],
  });
  context.mocks.api(feedContract.list, ({ respond }) => {
    return respond(200, { items: [loaded] });
  });
  const consumed: string[] = [];
  context.mocks.api(feedContract.consume, ({ body, respond }) => {
    consumed.push(body.optionId ?? "");
    return respond(200, later);
  });
  const { creates, sends } = recordNewChats();
  await openForYou();

  click(control("button", "Plan it", await findCard("Plan the offsite")));

  await waitFor(() => {
    expect(consumed).toStrictEqual(["plan"]);
  });
  expect(creates).toHaveLength(1);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ threadId: creates[0]?.clientThreadId });
  expect(messageText(sentDocument(sends[0]))).toBe("Plan the offsite agenda");
  expect(location.pathname).toBe("/for-you");
});

test("A sent suggestion advances the stack and remains reachable in the chat list", async () => {
  installFeed([
    suggestion({ id: FIRST_CARD_ID, title: "Book the venue" }),
    suggestion({ id: SECOND_CARD_ID, title: "Invite the speakers" }),
  ]);
  const { creates } = recordNewChats();
  await openForYou();

  click(
    control("button", "Start Book the venue", await findCard("Book the venue")),
  );

  await expect(findCard("Invite the speakers")).resolves.toBeInTheDocument();
  const chatLink = await waitFor(() => {
    const link = sidebarThreadLinks().find((candidate) => {
      return (
        candidate.dataset.sidebarChatThreadId === creates[0]?.clientThreadId
      );
    });
    if (!link) {
      throw new Error("The sent chat is not in the chat list");
    }
    expect(link).toHaveTextContent("Book the venue");
    return link;
  });
  click(chatLink);
  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${creates[0]?.clientThreadId}`);
  });
});

test("A choice that sends nothing returns its card to its place", async () => {
  context.mocks.api(runModelsMainContract.list, ({ respond }) => {
    return respond(200, { models: [] });
  });
  installFeed([
    suggestion({ id: FIRST_CARD_ID, title: "Renew the contract" }),
    suggestion({ id: SECOND_CARD_ID, title: "Archive old invoices" }),
  ]);
  const { sends } = recordNewChats();
  await openForYou();

  click(
    control(
      "button",
      "Start Renew the contract",
      await findCard("Renew the contract"),
    ),
  );

  await expect(
    screen.findByText("The selected model is not available"),
  ).resolves.toBeInTheDocument();
  await expect(findCard("Renew the contract")).resolves.toBeInTheDocument();
  expect(control("link", "Show suggestion 1 of 2")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(sends).toStrictEqual([]);
});

test("Suggestion options start in the default Agent after visiting a secondary Agent", async () => {
  context.mocks.data.agents([
    { agentId: DEFAULT_AGENT_ID, displayName: "Okou" },
    { agentId: SECONDARY_AGENT_ID, displayName: "Research" },
  ]);
  installFeed([suggestion({ id: FIRST_CARD_ID, title: "Draft the memo" })]);
  const { creates, sends } = recordNewChats();
  await openForYou(`/agents/${SECONDARY_AGENT_ID}/chat`);

  click(await findControl("link", "For you"));
  click(
    control("button", "Start Draft the memo", await findCard("Draft the memo")),
  );

  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(creates[0]?.agentId).toBe(DEFAULT_AGENT_ID);
  expect(sends[0]).toMatchObject({ agentId: DEFAULT_AGENT_ID });
  expect(location.pathname).toBe("/for-you");
});

test("Choosing an action confirms the send while its consumption is still saving", async () => {
  const consumption = context.mocks.deferred<number>();
  const feed = installFeed(
    [
      suggestion({ id: FIRST_CARD_ID, title: "Share the roadmap" }),
      suggestion({ id: SECOND_CARD_ID, title: "Collect feedback" }),
    ],
    () => {
      return consumption.promise;
    },
  );
  recordNewChats();
  await openForYou();

  click(
    control(
      "button",
      "Start Share the roadmap",
      await findCard("Share the roadmap"),
    ),
  );

  await expect(
    screen.findByText("Sent to a new chat"),
  ).resolves.toBeInTheDocument();
  await expect(findCard("Collect feedback")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(feed.consumed).toHaveLength(1);
  });
  expect(location.pathname).toBe("/for-you");
  consumption.resolve(200);
});

test("An existing-thread suggestion merges its content and attachments with the remote draft", async () => {
  const remoteFile = attachment("file-remote", "remote-notes.pdf");
  const suggestedFile = attachment("file-suggested", "revenue-table.pdf");
  installChats([chatThread(TARGET_THREAD_ID, "Quarterly report")]);
  context.mocks.api(chatThreadDraftContract.get, ({ params, respond }) => {
    return params.id === TARGET_THREAD_ID
      ? respond(200, {
          draftUserMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Remote notes for the report" },
              ...fileParts([remoteFile]),
            ],
          },
          draftAttachments: [remoteFile],
        })
      : respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Finish the quarterly report",
      options: [
        {
          id: "revenue",
          label: "Add the revenue table",
          text: "Add the revenue table to the report",
          threadId: TARGET_THREAD_ID,
          files: [suggestedFile],
        },
      ],
    }),
  ]);
  const { sends } = recordNewChats();
  await openForYou();

  click(
    control(
      "button",
      "Add the revenue table",
      await findCard("Finish the quarterly report"),
    ),
  );

  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${TARGET_THREAD_ID}`);
  });
  await waitFor(() => {
    const composer = chatComposer();
    expect(editorIn(composer)).toHaveTextContent(
      "Add the revenue table to the report",
    );
    expect(editorIn(composer)).toHaveTextContent("Remote notes for the report");
    expect(within(composer).getByText("remote-notes.pdf")).toBeInTheDocument();
    expect(within(composer).getByText("revenue-table.pdf")).toBeInTheDocument();
  });
  expect(sends).toStrictEqual([]);
});

test("A suggestion uses the ordinary composer to join a running target chat", async () => {
  const queued: (UserMessageDocument | undefined)[] = [];
  mockChatLifecycle(context, {
    threadId: TARGET_THREAD_ID,
    threadTitle: "Pricing review",
    chatEvents: [
      {
        id: "pricing-review-prompt",
        role: "user",
        content: "Review the pricing page",
        runId: "d1000000-0000-4000-a000-000000000001",
        createdAt: "2026-03-10T00:00:00Z",
      },
    ],
    activeRunIds: ["d1000000-0000-4000-a000-000000000001"],
    onQueuedEventAppend: (body) => {
      queued.push(body.userMessage);
    },
  });
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Tighten the pricing copy",
      options: [
        {
          id: "copy",
          label: "Suggest copy edits",
          text: "Suggest copy edits for the pricing page",
          threadId: TARGET_THREAD_ID,
          reference: { threadId: SOURCE_THREAD_ID, title: "Pricing research" },
        },
      ],
    }),
  ]);
  await openForYou();

  click(
    control(
      "button",
      "Suggest copy edits",
      await findCard("Tighten the pricing copy"),
    ),
  );

  await waitFor(() => {
    expect(location.pathname).toBe(`/chats/${TARGET_THREAD_ID}`);
  });
  await waitFor(() => {
    expect(editorIn(chatComposer())).toHaveTextContent(
      "Suggest copy edits for the pricing page",
    );
  });
  const send = await waitFor(() => {
    const button = control("button", "Send", chatComposer());
    expect(button).toBeEnabled();
    return button;
  });
  click(send);

  await waitFor(() => {
    expect(queued).toHaveLength(1);
  });
  expect(messageText(queued[0])).toContain(
    "Suggest copy edits for the pricing page",
  );
  expect(queued[0]?.parts).toContainEqual({
    type: "chat_thread",
    threadId: SOURCE_THREAD_ID,
    titleSnapshot: "Pricing research",
  });
});

test("Custom direction opens a full composer for a new chat without touching the home draft", async () => {
  const patches = installHomeDraft("My saved draft");
  const feed = installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Plan the launch",
      background: "The launch slipped a week",
    }),
  ]);
  const { sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Plan the launch");

  const composer = await openDirection(card);

  expect(
    within(card).getByRole("region", { name: "New chat" }),
  ).toContainElement(composer);
  expect(composer).toHaveTextContent("Plan the launch");
  expect(composer).not.toHaveTextContent("The launch slipped a week");
  expect(composer).not.toHaveTextContent("My saved draft");
  expect(control("button", "Send", composer)).toBeDisabled();
  await typeDirection(composer, "Start with the press list");
  expect(control("button", "Send", composer)).toBeEnabled();
  click(control("button", "Close", card));

  await waitFor(() => {
    expect(composer).not.toBeInTheDocument();
  });
  expect(
    control("button", "What do you have in mind?", card),
  ).toBeInTheDocument();
  await expect(findCard("Plan the launch")).resolves.toBe(card);
  expect(feed.consumed).toStrictEqual([]);
  expect(sends).toStrictEqual([]);
  const homeEditor = await openHome();
  await waitFor(() => {
    expect(homeEditor).toHaveTextContent("My saved draft");
  });
  expect(homeEditor).not.toHaveTextContent("Start with the press list");
  expect(patches).toStrictEqual([]);
});

test("Each card shows its own background in the direction editor", async () => {
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Choose a vendor",
      background: "Two vendors bid on the contract",
    }),
    suggestion({
      id: SECOND_CARD_ID,
      title: "Hire a designer",
      background: "The design backlog doubled",
    }),
  ]);
  recordNewChats();
  await openForYou();
  const first = await findCard("Choose a vendor");
  const firstComposer = await openDirection(first);
  await typeDirection(firstComposer, "Assess the risks first");
  click(control("button", "Close", first));
  await waitFor(() => {
    expect(firstComposer).not.toBeInTheDocument();
  });

  click(control("link", "Next suggestion", first));
  const second = await findCard("Hire a designer");
  const secondComposer = await openDirection(second);

  expect(secondComposer).toHaveTextContent("Hire a designer");
  expect(secondComposer).not.toHaveTextContent("Choose a vendor");
  expect(secondComposer).not.toHaveTextContent("Assess the risks first");
  click(control("button", "Close", second));
  await waitFor(() => {
    expect(secondComposer).not.toBeInTheDocument();
  });
  await expect(findCard("Hire a designer")).resolves.toBe(second);
});

test("A custom follow-up retains its editor on failure and reuses its identities until acceptance", async () => {
  const feed = installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Reconcile the invoices",
      background: "Three invoices do not match the ledger",
    }),
  ]);
  const { sends } = recordNewChats(1);
  await openForYou();
  const card = await findCard("Reconcile the invoices");
  const composer = await openDirection(card);
  await typeDirection(composer, "Follow up with finance");

  await sendFrom(composer);

  await expect(
    screen.findByText("Follow-up temporarily unavailable"),
  ).resolves.toBeInTheDocument();
  expect(composer).toBeInTheDocument();
  expect(editorIn(composer)).toHaveTextContent("Follow up with finance");
  await sendFrom(composer);

  await expect(
    screen.findByText("Sent to a new chat"),
  ).resolves.toBeInTheDocument();
  await expect(screen.findByText("All caught up")).resolves.toBeInTheDocument();
  expect(composer).not.toBeInTheDocument();
  expect(
    screen.queryByRole("article", { name: "Reconcile the invoices" }),
  ).not.toBeInTheDocument();
  expect(sends).toHaveLength(2);
  const [failed, accepted] = sends.map((body) => {
    return {
      threadId: "threadId" in body ? body.threadId : undefined,
      clientEventId: body.clientEventId,
    };
  });
  expect(failed).toStrictEqual({
    threadId: expect.any(String),
    clientEventId: expect.any(String),
  });
  expect(accepted).toStrictEqual(failed);
  const message = sentDocument(sends[1]);
  expect(messageText(message)).toContain(
    "Three invoices do not match the ledger",
  );
  expect(JSON.stringify(message)).toContain("Follow up with finance");
  expect(JSON.stringify(message)).toContain(FIRST_CARD_ID);
  expect(feed.consumed).toStrictEqual([]);
  expect(location.pathname).toBe("/for-you");
});

test("The custom direction editor sends the background files without the home draft", async () => {
  const homeFile = attachment("file-home", "home-notes.pdf");
  const briefFile = attachment("file-brief", "launch-brief.pdf");
  installHomeDraft("My saved draft", [homeFile]);
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Update the launch brief",
      background: "The brief is out of date",
      backgroundFiles: [briefFile],
    }),
  ]);
  const { creates, sends } = recordNewChats();
  await openForYou();
  const composer = await openDirection(
    await findCard("Update the launch brief"),
  );
  await typeDirection(composer, "Refresh the timeline section");

  await sendFrom(composer);

  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(creates).toStrictEqual([
    {
      clientThreadId: expect.any(String),
      title: "Update the launch brief",
      agentId: DEFAULT_AGENT_ID,
    },
  ]);
  const message = sentDocument(sends[0]);
  expect(message?.parts).toContainEqual(
    expect.objectContaining({ type: "file", fileId: "file-brief" }),
  );
  expect(message?.parts).not.toContainEqual(
    expect.objectContaining({ type: "file", fileId: "file-home" }),
  );
  expect(JSON.stringify(message)).not.toContain("My saved draft");
  expect(location.pathname).toBe("/for-you");
});

test("For you expands the composer inside the active card and advances after sending", async () => {
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Finalize the launch plan",
      background: "Launch plan: the budget and timeline are still open",
    }),
    suggestion({ id: SECOND_CARD_ID, title: "Review the hiring plan" }),
  ]);
  const { sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Finalize the launch plan");
  const composer = await openDirection(card);
  expect(card).toContainElement(composer);
  await typeDirection(composer, "Summarize the open budget question first");

  await sendFrom(composer);

  await expect(findCard("Review the hiring plan")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  const message = sentDocument(sends[0]);
  expect(messageText(message)).toContain(
    "Launch plan: the budget and timeline are still open",
  );
  expect(JSON.stringify(message)).toContain(
    "Summarize the open budget question first",
  );
  expect(location.pathname).toBe("/for-you");
});

test("A custom direction continues the chat its card names without touching its saved draft", async () => {
  installChats([chatThread(TARGET_THREAD_ID, "Hiring plan")]);
  context.mocks.api(chatThreadDraftContract.get, ({ params, respond }) => {
    return params.id === TARGET_THREAD_ID
      ? respond(200, {
          draftUserMessage: {
            version: 1,
            parts: [{ type: "text", text: "Saved reply draft" }],
          },
          draftAttachments: null,
        })
      : respond(200, { draftUserMessage: null, draftAttachments: null });
  });
  const draftWrites: string[] = [];
  context.mocks.api(chatThreadByIdContract.patch, ({ params, respond }) => {
    draftWrites.push(params.id);
    return respond(204);
  });
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Schedule the interviews",
      background: "Two candidates are waiting for a slot",
      customThreadId: TARGET_THREAD_ID,
      options: [
        {
          id: "schedule",
          label: "Propose slots",
          text: "Propose interview slots",
          reference: { threadId: TARGET_THREAD_ID, title: "Hiring plan" },
        },
      ],
    }),
    suggestion({ id: SECOND_CARD_ID, title: "Update the org chart" }),
  ]);
  const { sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Schedule the interviews");
  const composer = await openDirection(card);
  await expect(
    within(card).findByRole("heading", { name: "Hiring plan" }),
  ).resolves.toBeInTheDocument();
  expect(composer).toHaveTextContent("Schedule the interviews");
  expect(composer).not.toHaveTextContent("Saved reply draft");
  await typeDirection(composer, "Share the interview loop");

  await sendFrom(composer);

  await expect(findCard("Update the org chart")).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(sends[0]).toMatchObject({ threadId: TARGET_THREAD_ID });
  const message = sentDocument(sends[0]);
  expect(messageText(message)).toContain(
    "Two candidates are waiting for a slot",
  );
  expect(JSON.stringify(message)).toContain("Share the interview loop");
  expect(JSON.stringify(message)).not.toContain("Saved reply draft");
  expect(draftWrites).not.toContain(TARGET_THREAD_ID);
});

test("Sending after removing the quote leaves the suggestion available", async () => {
  const feed = installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Organize the team offsite",
      background: "The offsite is in three weeks",
    }),
  ]);
  const { sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Organize the team offsite");
  const composer = await openDirection(card);
  await typeDirection(composer, "What is a good team dinner spot?");

  click(control("button", "Remove feedback", composer));
  await waitFor(() => {
    expect(composer).not.toHaveTextContent("Organize the team offsite");
  });
  await sendFrom(composer);

  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  const message = sentDocument(sends[0]);
  expect(message?.parts).toStrictEqual([
    { type: "text", text: "What is a good team dinner spot?" },
  ]);
  await expect(
    findCard("Organize the team offsite"),
  ).resolves.toBeInTheDocument();
  expect(feed.consumed).toStrictEqual([]);
  expect(location.pathname).toBe("/for-you");
});

test("A custom direction continues a named chat missing from the chat list", async () => {
  installChats([]);
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Review interview notes",
      customThreadId: TARGET_THREAD_ID,
    }),
  ]);
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    expect(params.id).toBe(TARGET_THREAD_ID);
    return respond(200, {
      ...chatThread(TARGET_THREAD_ID, "Interview notes"),
      muted: false,
    });
  });
  const { creates, sends } = recordNewChats();
  await openForYou();
  const card = await findCard("Review interview notes");
  const composer = await openDirection(card);
  await typeDirection(composer, "Summarize the feedback");

  await sendFrom(composer);

  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(sends[0]).toMatchObject({ threadId: TARGET_THREAD_ID });
  expect(sentDocument(sends[0])?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      note: expect.arrayContaining([
        { type: "text", text: "Summarize the feedback" },
      ]),
    }),
  );
  expect(creates).toHaveLength(0);
});

test("A custom direction starts a new chat when its named chat is gone", async () => {
  installChats([]);
  context.mocks.api(chatThreadMetadataContract.get, ({ params, respond }) => {
    expect(params.id).toBe(TARGET_THREAD_ID);
    return respond(404, {
      error: {
        code: "CHAT_THREAD_NOT_FOUND",
        message: "Chat thread not found",
      },
    });
  });
  installFeed([
    suggestion({
      id: FIRST_CARD_ID,
      title: "Review interview notes",
      customThreadId: TARGET_THREAD_ID,
    }),
  ]);
  const { creates, sends } = recordNewChats();
  await openForYou();
  const composer = await openDirection(
    await findCard("Review interview notes"),
  );
  await typeDirection(composer, "Summarize the feedback");

  await sendFrom(composer);

  await waitFor(() => {
    expect(sends).toHaveLength(1);
  });
  expect(creates).toHaveLength(1);
  expect(creates[0]?.clientThreadId).toStrictEqual(expect.any(String));
  expect(creates[0]?.clientThreadId).not.toBe(TARGET_THREAD_ID);
  expect(sends[0]).toMatchObject({ threadId: creates[0]?.clientThreadId });
  expect(sentDocument(sends[0])?.parts).toContainEqual(
    expect.objectContaining({
      type: "feedback",
      note: expect.arrayContaining([
        { type: "text", text: "Summarize the feedback" },
      ]),
    }),
  );
});
