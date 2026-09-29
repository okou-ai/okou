import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { HttpResponse } from "msw";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatEventsContract,
  chatThreadEventsContract,
  type ChatEventSendBody,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventRowsResponse,
  testContext,
} from "../../../signals/__tests__/test-helpers.ts";
import { mockChatEventRowContextType } from "./chat-event-test-helpers.ts";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { resetSignal } from "../../../signals/utils.ts";
import { nowDate } from "../../../lib/time.ts";
import {
  completedConversation,
  installCapabilityChat,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import {
  listDeliveryIntents,
  saveDeliveryIntent,
} from "../../../signals/chat-page/chat-delivery-intents.ts";
import {
  context,
  findButton,
  findEnabledButton,
  installRunChat,
  promptEvent,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

function supportCrossTabRetry(): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown>,
      ) => {
        return await callback({
          name: "test-delivery-lock",
          mode: "exclusive",
        } as Lock);
      },
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, "locks", descriptor);
      } else {
        Reflect.deleteProperty(navigator, "locks");
      }
    },
    { once: true },
  );
}

function identity() {
  return { userId: "test-user-123", orgId: "org_default" };
}
const refreshedContext = testContext();

async function sendViaComposer(text: string): Promise<void> {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, text);
  click(await findEnabledButton("Send"));
}

test("a rejected existing-thread send is visible and retries with the original ID", async () => {
  supportCrossTabRetry();
  installRunChat();
  const requests: ChatEventSendBody[] = [];
  let reject = true;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    requests.push(body);
    if (reject) {
      return respond(401, {
        error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
      });
    }
    return respond(201, { runId: null, threadId: RUN_THREAD_ID });
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await sendViaComposer("Retain this launch instruction");

  await expect(
    screen.findByText(
      "Message not sent. Sign in again, then check delivery before retrying.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Retain this launch instruction"),
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "",
  );
  expect(requests).toHaveLength(1);

  reject = false;
  click(await findButton("Check and retry"));
  await expect(
    screen.findByText(
      "Message accepted; waiting for confirmation in the chat history.",
    ),
  ).resolves.toBeInTheDocument();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.clientEventId).toBe(requests[0]?.clientEventId);
  expect(requests[1]?.chatThreadSortEventId).toBe(
    requests[0]?.chatThreadSortEventId,
  );
});

test("failed browser persistence does not clear or post a message", async () => {
  installRunChat();
  let posts = 0;
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    posts += 1;
    return respond(201, { runId: null, threadId: RUN_THREAD_ID });
  });
  // Simulate blocked browser storage at the browser boundary, rather than
  // replacing any internal signal or command.
  // Replace only the external browser storage boundary for this page test.
  const original = globalThis.localStorage.setItem.bind(
    globalThis.localStorage,
  );
  const blocked = vi
    .spyOn(globalThis.localStorage, "setItem")
    .mockImplementation((key, value) => {
      if (key.startsWith("okou_chat-delivery-v1:")) {
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      }
      return original(key, value);
    });
  context.signal.addEventListener(
    "abort",
    () => {
      return blocked.mockRestore();
    },
    {
      once: true,
    },
  );

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await sendViaComposer("Do not lose the report outline");
  await expect(
    screen.findByText(
      /Message not sent: this browser could not save a recovery copy/iu,
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Do not lose the report outline",
  );
  expect(posts).toBe(0);
});

test("a saved prompt from a prior page lifetime is shown with an uncertain state", async () => {
  installRunChat();
  const eventId = "10000000-0000-4000-a000-000000000099";
  // A full reload creates a new Router/Store; the browser's persisted recovery
  // copy is external input to that fresh page (not a signal state mutation).
  expect(
    saveDeliveryIntent(identity(), {
      kind: "existing-thread",
      threadId: RUN_THREAD_ID,
      clientEventId: eventId,
      createdAt: nowDate().toISOString(),
      status: "prepared",
      rejection: null,
      delivery: "run",
      body: {
        agentId: "c0000000-0000-4000-a000-000000000001",
        threadId: RUN_THREAD_ID,
        clientEventId: eventId,
        chatThreadSortEventId: "10000000-0000-4000-a000-000000000098",
        prompt: "Recover my original brief",
        hasTextContent: true,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Recover my original brief" }],
        },
      },
    }),
  ).toBeTruthy();

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await expect(
    screen.findByText("Recover my original brief"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText(
      "Delivery unconfirmed. Check the server before retrying.",
    ),
  ).resolves.toBeInTheDocument();
});

test("a missing POST response keeps an uncertain queued message with uploaded file references", async () => {
  installRunChat({
    activeRunIds: ["d0000000-0000-4000-a000-000000000007"],
    chatEvents: [
      promptEvent({
        id: "original-running-input",
        runId: "d0000000-0000-4000-a000-000000000007",
        seqId: 1,
        text: "Work on the previous task",
      }),
    ],
  });
  const file = new File(["draft attachment"], "spec-notes.txt", {
    type: "text/plain",
  });
  context.mocks.upload.success({
    id: "f0000000-0000-4000-a000-000000000007",
    filename: file.name,
    contentType: file.type,
    size: file.size,
    url: "https://files.example.test/spec-notes.txt",
  });
  context.mocks.http.post("*/api/chat/events", () => {
    return HttpResponse.error();
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  await userEvent.upload(input!, file);
  await findEnabledButton("Send");
  await sendViaComposer("Queue the specification review");
  await expect(
    screen.findByText(
      "Delivery unconfirmed. Check the server before retrying.",
    ),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByText("Queue the specification review"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("spec-notes.txt").length).toBeGreaterThan(0);
});

test("a new edit made while the first POST is pending stays in the composer", async () => {
  const accepted = context.mocks.deferred<void>();
  installRunChat({ sendGate: accepted.promise });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await sendViaComposer("First instruction");
  await expect(
    screen.findByText("First instruction"),
  ).resolves.toBeInTheDocument();
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "Second instruction, still a draft");
  accepted.resolve(undefined);
  await expect(
    screen.findByText(
      "Message accepted; waiting for confirmation in the chat history.",
    ),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Second instruction, still a draft",
  );
});

test("an intent for a different signed-in member never appears on this chat", async () => {
  installRunChat();
  expect(
    saveDeliveryIntent(
      { userId: "other-member", orgId: identity().orgId },
      {
        kind: "existing-thread",
        threadId: RUN_THREAD_ID,
        clientEventId: "10000000-0000-4000-a000-000000000091",
        createdAt: nowDate().toISOString(),
        status: "rejected",
        rejection: "authentication",
        delivery: "run",
        body: {
          agentId: "c0000000-0000-4000-a000-000000000001",
          threadId: RUN_THREAD_ID,
          clientEventId: "10000000-0000-4000-a000-000000000091",
          prompt: "Private work for another member",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Private work for another member" }],
          },
        },
      },
    ),
  ).toBeTruthy();
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  expect(document.body).not.toHaveTextContent(
    "Private work for another member",
  );
  expect(document.body).not.toHaveTextContent(
    "Message not sent. Sign in again",
  );
});

test("a server-accepted prompt with a lost response reconciles before retry", async () => {
  supportCrossTabRetry();
  installRunChat();
  let requestBody: ChatEventSendBody | undefined;
  let postCount = 0;
  let canonicalRow: ChatEventRow | null = null;
  context.mocks.api(chatThreadEventsContract.rows, ({ query, respond }) => {
    const rows =
      canonicalRow && canonicalRow.seqId > query.sinceSeqId
        ? [canonicalRow]
        : [];
    return respond(200, chatEventRowsResponse(rows, query));
  });
  context.mocks.http.post("*/api/chat/events", async ({ request }) => {
    postCount += 1;
    requestBody = chatEventsContract.send.body.parse(await request.json());
    return HttpResponse.error();
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await sendViaComposer("Prepare the handoff memo");
  await expect(
    screen.findByText(
      "Delivery unconfirmed. Check the server before retrying.",
    ),
  ).resolves.toBeInTheDocument();
  expect(postCount).toBe(1);
  const id = requestBody?.clientEventId;
  if (!id || !requestBody || !("prompt" in requestBody)) {
    throw new Error("Expected a prompt POST");
  }
  canonicalRow = chatEventRowSchema.parse({
    id,
    chatThreadId: RUN_THREAD_ID,
    runId: null,
    revokesEventId: null,
    contextType: mockChatEventRowContextType("input.prompt"),
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 1,
    createdAt: nowDate().toISOString(),
    eventType: "input.prompt",
    payload: { userMessage: requestBody.userMessage },
  });
  click(await findButton("Check and retry"));
  await waitFor(() => {
    expect(
      screen.queryByText(
        "Delivery unconfirmed. Check the server before retrying.",
      ),
    ).not.toBeInTheDocument();
  });
  expect(screen.getAllByText("Prepare the handoff memo")).toHaveLength(1);
  expect(postCount).toBe(1);
});

test("a rejected send remains recoverable after an actual page remount", async () => {
  const resetPage$ = resetSignal();
  const firstPageSignal = context.store.set(resetPage$, context.signal);
  installRunChat();
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(401, {
      error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
    });
  });
  await setupPage({
    context: { ...context, signal: firstPageSignal },
    path: RUN_PATH,
  });
  await readyChat();
  await sendViaComposer("Preserve this after reload");
  await expect(
    screen.findByText(
      "Message not sent. Sign in again, then check delivery before retrying.",
    ),
  ).resolves.toBeInTheDocument();

  context.store.set(resetPage$);
  cleanup();
  vi.mocked(window.history.pushState).mockRestore();
  vi.mocked(window.history.replaceState).mockRestore();
  vi.mocked(window.history.back).mockRestore();
  await setupPage({ context: refreshedContext, path: RUN_PATH });
  await readyChat();
  await expect(
    screen.findByText("Preserve this after reload"),
  ).resolves.toBeInTheDocument();
  await expect(
    screen.findByText(
      "Message not sent. Sign in again, then check delivery before retrying.",
    ),
  ).resolves.toBeInTheDocument();
});

test("forwarding into an existing thread does not claim a rejected message was sent", async () => {
  installCapabilityChat({
    events: completedConversation("The rollout plan has three phases."),
  });
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Not allowed" },
    });
  });
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage("rollout plan has three phases");
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog");
  click(
    await within(dialog).findByRole("option", {
      name: "Capability conversation",
    }),
  );
  const forwardComposer = await within(dialog).findByRole("textbox", {
    name: "Add a message",
  });
  await fill(forwardComposer, "Send this to the active discussion");
  click(await findEnabledButton("Send", dialog));
  await expect(
    screen.findByText(
      "Forward not sent. Your message is saved in this browser.",
    ),
  ).resolves.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
  const [forwardIntent] = listDeliveryIntents(identity()).filter((intent) => {
    return (
      intent.kind === "existing-thread" && intent.body.sourceRunId !== undefined
    );
  });
  expect(forwardIntent).toMatchObject({
    status: "rejected",
    threadId: RUN_THREAD_ID,
  });
  expect(forwardIntent?.body.prompt).toContain(
    "Send this to the active discussion",
  );
});
