import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  chatEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { expect, test, vi } from "vitest";
import { HttpResponse } from "msw";
import {
  deliveryIntentsChanged$,
  listDeliveryIntents,
  updateDeliveryIntent,
  type NewThreadDeliveryIntent,
} from "../../../signals/chat-page/chat-delivery-intents.ts";
import { reconcileNewThreadDeliveries$ } from "../../../signals/chat-page/new-thread-delivery.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";

import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  RUN_PATH,
  selectPassage,
} from "./chat-capability-test-helpers.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  NEW_CHAT_PATH,
  readyChat,
} from "./chat-run-test-fixtures.ts";

function savedFirstMessage(): NewThreadDeliveryIntent {
  const item = listDeliveryIntents({
    userId: "test-user-123",
    orgId: "org_default",
  }).find((intent): intent is NewThreadDeliveryIntent => {
    return intent.kind === "new-thread";
  });
  if (!item) {
    throw new Error("Expected the saved first-message delivery intent");
  }
  return item;
}

function clickFirstMessageRetry(): void {
  const button = document.querySelector<HTMLButtonElement>(
    "[data-new-thread-delivery-id] button",
  );
  if (!button?.isConnected || button.disabled) {
    throw new Error(
      "Expected a connected, enabled first-message retry control",
    );
  }
  click(button);
}

function enableTestWebLocks(): void {
  const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T,>(
        name: string,
        _options: LockOptions,
        action: (lock: Lock) => Promise<T>,
      ): Promise<T> => {
        return await action({ name, mode: "exclusive" } as Lock);
      },
    },
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (previous) {
        Object.defineProperty(navigator, "locks", previous);
      } else {
        Reflect.deleteProperty(navigator, "locks");
      }
    },
    { once: true },
  );
}

function presentThreadMetadata(threadId: string) {
  context.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(200, {
      id: threadId,
      agentId: AGENT_ID,
      title: null,
      selectedModel: "claude-sonnet-5",
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      archived: false,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
    });
  });
}

interface FirstSendIds {
  readonly threadId: string;
  readonly createEventId: string;
  readonly promptEventId: string;
}

test("The first message carries the original thread and event IDs across navigation", async () => {
  let createdThreadId: string | undefined;
  let createEventId: string | undefined;
  let sentThreadId: string | undefined;
  let promptEventId: string | undefined;
  installRunChat({
    onThreadCreate(body) {
      createdThreadId = body.clientThreadId;
      createEventId = body.eventId;
    },
    onSendRequest(body) {
      sentThreadId = body.threadId;
      promptEventId = body.clientEventId;
    },
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Prepare the launch notes",
  );
  click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(createdThreadId).toBeDefined();
    expect(sentThreadId).toBe(createdThreadId);
    expect(window.location.pathname).toBe(`/chats/${createdThreadId}`);
  });
  expect(createEventId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(promptEventId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(promptEventId).not.toBe(createEventId);
  await expect(
    screen.findByText("Prepare the launch notes"),
  ).resolves.toBeInTheDocument();
});

test("A rejected thread creation keeps the first message available without posting it", async () => {
  let createdThreadId: string | undefined;
  let sentPrompt = false;
  installRunChat();
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    createdThreadId = body.clientThreadId;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Sign in required" },
    });
  });
  context.mocks.api(chatEventsContract.send, ({ respond }) => {
    sentPrompt = true;
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Sign in required" },
    });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Do not lose the first message",
  );
  click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(createdThreadId).toBeDefined();
    expect(window.location.pathname).toBe(`/chats/${createdThreadId}`);
  });
  await waitFor(() => {
    expect(screen.getByText(/Chat creation rejected/u)).toBeInTheDocument();
  });
  expect(
    screen.getAllByText("Do not lose the first message").some((element) => {
      return !element.closest("[data-new-thread-delivery-id]");
    }),
  ).toBe(true);
  expect(sentPrompt).toBe(false);
});

test("A rejected first prompt is distinct from a successful thread creation", async () => {
  let createdThreadId: string | undefined;
  let promptEventId: string | undefined;
  installRunChat({
    onThreadCreate(body) {
      createdThreadId = body.clientThreadId;
    },
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    promptEventId = body.clientEventId;
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Not allowed" },
    });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Recover the first prompt",
  );
  click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(createdThreadId).toBeDefined();
    expect(promptEventId).toBeDefined();
  });
  await waitFor(() => {
    expect(screen.getByText(/First message rejected/u)).toBeInTheDocument();
  });
  expect(
    screen.getAllByText("Recover the first prompt").some((element) => {
      return !element.closest("[data-new-thread-delivery-id]");
    }),
  ).toBe(true);
});

test("A remote draft-clear error cannot strand the prompt after thread creation", async () => {
  let createdThreadId: string | undefined;
  let sentThreadId: string | undefined;
  installRunChat({
    onThreadCreate(body) {
      createdThreadId = body.clientThreadId;
    },
    onSendRequest(body) {
      sentThreadId = body.threadId;
    },
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Draft update unavailable" },
    });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Send despite draft cleanup failure",
  );
  click(await findEnabledButton("Send"));

  await waitFor(() => {
    expect(createdThreadId).toBeDefined();
    expect(sentThreadId).toBe(createdThreadId);
  });
  await expect(
    screen.findByText("Send despite draft cleanup failure"),
  ).resolves.toBeInTheDocument();
});

test("A forward with no response never claims success in the source conversation", async () => {
  let sentEventId: string | undefined;
  installRunChat({
    chatEvents: completedConversation("A source decision to carry forward."),
  });
  context.mocks.http.post("*/api/chat/events", async ({ request }) => {
    const body: unknown = await request.json();
    if (
      body &&
      typeof body === "object" &&
      "clientEventId" in body &&
      typeof body.clientEventId === "string"
    ) {
      sentEventId = body.clientEventId;
    }
    return HttpResponse.error();
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage("source decision");
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByRole("option", { name: "Okou" }));
  await within(dialog).findByRole("textbox", { name: "Add a message" });
  click(await findEnabledButton("Send", dialog));

  await waitFor(() => {
    expect(sentEventId).toBeDefined();
    expect(window.location.pathname).toBe(RUN_PATH);
  });
  await expect(
    screen.findByText(/First message unconfirmed/u),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Forwarded successfully")).toBeNull();
});

test("A delayed agent-draft clear cannot overwrite notes typed after the first send", async () => {
  const clearGate = context.mocks.deferred<void>();
  const clearStarted = context.mocks.deferred<void>();
  const clearFinished = context.mocks.deferred<void>();
  context.signal.addEventListener(
    "abort",
    () => {
      if (!clearGate.settled()) {
        clearGate.resolve();
      }
    },
    { once: true },
  );
  let remoteDraft = "";
  installRunChat();
  context.mocks.api(agentDraftContract.patch, async ({ body, respond }) => {
    if (body.draftUserMessage === null) {
      clearStarted.resolve();
      await clearGate.promise;
      remoteDraft = "";
      clearFinished.resolve();
    } else {
      remoteDraft =
        body.draftUserMessage?.parts
          .flatMap((part) => {
            return part.type === "text" ? [part.text] : [];
          })
          .join("") ?? "";
    }
    return respond(204);
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(screen.getByRole("textbox", { name: "Message" }), "First message");
  click(await findEnabledButton("Send"));
  await clearStarted.promise;
  await waitFor(() => {
    expect(window.location.pathname).toMatch(/^\/chats\//u);
  });
  const agentLink = await waitFor(() => {
    const link = queryAllByRoleFast("link").find((candidate) => {
      return candidate.getAttribute("href") === NEW_CHAT_PATH;
    });
    if (!link) {
      throw new Error("Expected an agent chat link");
    }
    return link;
  });
  click(agentLink);
  const composer = await screen.findByRole("textbox", { name: "Message" });
  await fill(composer, "New notes typed after sending");
  await waitFor(() => {
    expect(remoteDraft).toBe("New notes typed after sending");
  });
  clearGate.resolve();
  await clearFinished.promise;
  await waitFor(() => {
    expect(remoteDraft).toBe("New notes typed after sending");
  });
  expect(composer).toHaveTextContent("New notes typed after sending");
});

test("Forwarding the first message to an agent retains the source conversation", async () => {
  let ids: FirstSendIds | undefined;
  let createdThreadId: string | undefined;
  let createEventId: string | undefined;
  installRunChat({
    chatEvents: completedConversation("A source decision to carry forward."),
    onThreadCreate(body) {
      createdThreadId = body.clientThreadId;
      createEventId = body.eventId;
    },
    onSendRequest(body) {
      if (createdThreadId && createEventId && body.clientEventId) {
        ids = {
          threadId: body.threadId ?? "",
          createEventId,
          promptEventId: body.clientEventId,
        };
      }
      expect(body.sourceRunId).toBeDefined();
    },
  });

  await setupPage({ context, path: RUN_PATH });
  await readyChat();
  await selectPassage("source decision");
  click(await findEnabledButton("Forward"));
  const dialog = await screen.findByRole("dialog");
  click(await within(dialog).findByRole("option", { name: "Okou" }));
  const editor = await within(dialog).findByRole("textbox", {
    name: "Add a message",
  });
  await fill(editor, "Keep the context for this agent");
  click(await findEnabledButton("Send", dialog));

  await waitFor(() => {
    expect(ids).toBeDefined();
    expect(window.location.pathname).toBe(RUN_PATH);
  });
  expect(ids?.threadId).toBe(createdThreadId);
  expect(ids?.promptEventId).not.toBe(ids?.createEventId);
  const saved = savedFirstMessage();
  expect(saved.body.sourceRunId).toBeDefined();
  expect(saved.body.threadId).toBe(createdThreadId);
  expect(saved.createBody.eventId).toBe(createEventId);
});

test("A create rejection retries the saved thread/event IDs, not a second chat", async () => {
  enableTestWebLocks();
  const createIds: string[] = [];
  const promptIds: string[] = [];
  installRunChat({
    onSendRequest(body) {
      if (body.clientEventId) {
        promptIds.push(body.clientEventId);
      }
    },
  });
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    createIds.push(body.clientThreadId ?? "");
    return respond(401, {
      error: { code: "UNAUTHORIZED", message: "Sign in required" },
    });
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Use the same IDs",
  );
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(screen.getByText(/Chat creation rejected/u)).toBeInTheDocument();
  });
  const saved = savedFirstMessage();
  expect(saved.phase).toBe("create");
  expect(saved.createBody.clientThreadId).toBe(saved.threadId);
  expect(saved.createBody.eventId).toBe(saved.createEventId);
  expect(saved.body.clientEventId).toBe(saved.clientEventId);
  expect(saved.body.userMessage?.parts).toContainEqual({
    type: "text",
    text: "Use the same IDs",
  });

  expect(
    listDeliveryIntents({ userId: "test-user-123", orgId: "another-org" }),
  ).toEqual([]);
  expect(
    listDeliveryIntents({ userId: "another-user", orgId: "org_default" }),
  ).toEqual([]);

  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    createIds.push(body.clientThreadId ?? "");
    return respond(201, {
      id: body.clientThreadId ?? saved.threadId,
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-5",
      serviceTier: null,
    });
  });
  clickFirstMessageRetry();
  await waitFor(() => {
    expect(promptIds).toEqual([saved.clientEventId]);
  });
  expect(createIds).toEqual([saved.threadId, saved.threadId]);
  expect(savedFirstMessage().phase).toBe("prompt");
});

test("An ambiguous create response reconciles an existing server thread before prompt retry", async () => {
  enableTestWebLocks();
  let threadId: string | undefined;
  let createCount = 0;
  const promptIds: string[] = [];
  installRunChat({
    onSendRequest(body) {
      if (body.clientEventId) {
        promptIds.push(body.clientEventId);
      }
    },
  });
  context.mocks.http.post("*/api/chat-threads", async ({ request }) => {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "clientThreadId" in body) {
      threadId = String(body.clientThreadId);
    }
    createCount++;
    return HttpResponse.error();
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Commit may have worked",
  );
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(screen.getByText(/Chat creation unconfirmed/u)).toBeInTheDocument();
  });
  const saved = savedFirstMessage();
  expect(threadId).toBe(saved.threadId);
  presentThreadMetadata(saved.threadId);
  clickFirstMessageRetry();
  await waitFor(() => {
    expect(promptIds).toEqual([saved.clientEventId]);
  });
  expect(createCount).toBe(1);
  expect(savedFirstMessage().createEventId).toBe(saved.createEventId);
});

test("A lost prompt response retries the original event ID after checking the server", async () => {
  enableTestWebLocks();
  let firstEventId: string | undefined;
  const retryIds: string[] = [];
  let createCount = 0;
  installRunChat({
    onThreadCreate() {
      createCount++;
    },
  });
  context.mocks.http.post("*/api/chat/events", async ({ request }) => {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && "clientEventId" in body) {
      firstEventId = String(body.clientEventId);
    }
    return HttpResponse.error();
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Recover my first prompt",
  );
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(screen.getByText(/First message unconfirmed/u)).toBeInTheDocument();
  });
  const saved = savedFirstMessage();
  expect(firstEventId).toBe(saved.clientEventId);
  expect(saved.phase).toBe("prompt");
  presentThreadMetadata(saved.threadId);
  installRunChat({
    onSendRequest(body) {
      if (body.clientEventId) {
        retryIds.push(body.clientEventId);
      }
    },
  });
  clickFirstMessageRetry();
  await waitFor(() => {
    expect(retryIds).toEqual([saved.clientEventId]);
  });
  expect(createCount).toBe(1);
});

test("A read-only refresh clears a confirmed first message without replaying it", async () => {
  let createCount = 0;
  let sendCount = 0;
  installRunChat({
    onThreadCreate() {
      createCount++;
    },
    onSendRequest() {
      sendCount++;
    },
  });

  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Already delivered",
  );
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(savedFirstMessage().status).toBe("accepted");
  });
  const saved = savedFirstMessage();
  presentThreadMetadata(saved.threadId);
  await context.store.set(reconcileNewThreadDeliveries$, context.signal);
  await waitFor(() => {
    expect(document.querySelector("[data-new-thread-delivery-id]")).toBeNull();
  });
  expect(createCount).toBe(1);
  expect(sendCount).toBe(1);
});

test("Checking a committed prompt never creates a duplicate run", async () => {
  enableTestWebLocks();
  let createCount = 0;
  let sendCount = 0;
  installRunChat({
    onThreadCreate() {
      createCount++;
    },
    onSendRequest() {
      sendCount++;
    },
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Send once only",
  );
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(savedFirstMessage().status).toBe("accepted");
  });
  const saved = savedFirstMessage();
  presentThreadMetadata(saved.threadId);
  updateDeliveryIntent(
    { userId: "test-user-123", orgId: "org_default" },
    saved.clientEventId,
    { status: "uncertain", rejection: null },
  );
  context.store.set(deliveryIntentsChanged$);
  await waitFor(() => {
    expect(screen.getByText(/First message unconfirmed/u)).toBeInTheDocument();
  });
  clickFirstMessageRetry();
  await waitFor(() => {
    expect(
      listDeliveryIntents({ userId: "test-user-123", orgId: "org_default" }),
    ).toEqual([]);
  });
  expect(createCount).toBe(1);
  expect(sendCount).toBe(1);
});

test("Uploaded file references survive prompt rejection in the original recovery intent", async () => {
  const user = userEvent.setup({ delay: null });
  let createdThreadId: string | undefined;
  let sentEventId: string | undefined;
  installRunChat({
    onThreadCreate(body) {
      createdThreadId = body.clientThreadId;
    },
  });
  context.mocks.upload.success({
    id: "first-message-upload",
    filename: "brief.txt",
    contentType: "text/plain",
    size: 12,
    url: "https://files.example.test/brief.txt",
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    sentEventId = body.clientEventId;
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Message not allowed" },
    });
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await user.click(await findEnabledButton("Attach"));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Composer file input was not mounted");
  }
  await user.upload(
    input,
    new File(["Hello world!"], "brief.txt", { type: "text/plain" }),
  );
  await fill(screen.getByRole("textbox", { name: "Message" }), "Read my brief");
  await user.click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(screen.getByText(/First message rejected/u)).toBeInTheDocument();
  });
  const saved = savedFirstMessage();
  expect(saved.phase).toBe("prompt");
  expect(saved.threadId).toBe(createdThreadId);
  expect(saved.clientEventId).toBe(sentEventId);
  expect(saved.body.userMessage?.parts).toContainEqual({
    type: "file",
    fileId: "first-message-upload",
    filenameSnapshot: "brief.txt",
    contentType: "text/plain",
  });
  expect(saved.createBody.model).toBeDefined();
  expect(saved.body.prompt).toBe("Read my brief");
  await user.click(screen.getByText("Review saved message"));
  expect(screen.getByText("Uploaded files: brief.txt")).toBeVisible();
});

test("Unavailable recovery storage prevents first-message side effects", async () => {
  let createCount = 0;
  installRunChat({
    onThreadCreate() {
      createCount++;
    },
  });
  await setupPage({ context, path: NEW_CHAT_PATH });
  await readyChat();
  await fill(
    screen.getByRole("textbox", { name: "Message" }),
    "Keep the original draft",
  );
  const storage = vi
    .spyOn(window.localStorage, "setItem")
    .mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
  context.signal.addEventListener(
    "abort",
    () => {
      storage.mockRestore();
    },
    { once: true },
  );
  click(await findEnabledButton("Send"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Keep the original draft",
    );
  });
  expect(createCount).toBe(0);
  storage.mockRestore();
});
