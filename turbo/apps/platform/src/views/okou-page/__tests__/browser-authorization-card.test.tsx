import { browserAuthorizationRequestsContract } from "@okouai/api-contracts/contracts/browser";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "b0000000-0000-4000-a000-000000000902";
const REQUEST_ID = "a0000000-0000-4000-a000-000000000901";
const REQUEST_TOKEN = "vm0_browser_authorization_request_test";
const AUTHORIZATION_URL = `https://app.okou.ai/browser/authorize/${REQUEST_TOKEN}`;
const CALLBACK =
  "The cloud browser is enabled. Please continue the previous task.";

function mockRequest(options?: { threadId?: string; enabled?: boolean }) {
  context.mocks.api(browserAuthorizationRequestsContract.get, ({ respond }) => {
    return respond(200, {
      id: REQUEST_ID,
      chatThreadId: options?.threadId ?? THREAD_ID,
      expiresAt: "2099-09-01T10:00:00.000Z",
      completedAt: options?.enabled ? "2026-09-01T10:00:00.000Z" : null,
      cloudBrowserEnabled: options?.enabled ?? false,
    });
  });
}

function mockConversation(
  content = AUTHORIZATION_URL,
  onSend?: (prompt: string) => void,
) {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Browser authorization",
    chatEvents: [
      {
        id: "browser-request",
        role: "assistant",
        content,
        runId: "browser-request-run",
        createdAt: "2026-09-01T12:00:00.000Z",
      },
    ],
    onSendRequest: ({ prompt }) => {
      onSend?.(prompt);
    },
  });
}

function setupChat(
  content = AUTHORIZATION_URL,
  onSend?: (prompt: string) => void,
) {
  mockConversation(content, onSend);
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
}

function getButton(container: HTMLElement, name: string) {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!button) {
    throw new Error(`Button not found: ${name}`);
  }
  return button;
}

test.each([
  AUTHORIZATION_URL,
  `/browser/authorize/${REQUEST_TOKEN}`,
  `[Enable browser](${AUTHORIZATION_URL})`,
])("A user allows a browser request and continues from %s", async (url) => {
  mockRequest();
  let authorized = false;
  const sent: string[] = [];
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    ({ params, respond }) => {
      expect(params.requestToken).toBe(REQUEST_TOKEN);
      authorized = true;
      return respond(200, { ok: true, cloudBrowserEnabled: true });
    },
  );
  await setupChat(`I need a browser to continue.\n\n${url}`, (prompt) => {
    expect(authorized).toBeTruthy();
    sent.push(prompt);
  });
  const card = await screen.findByTestId("browser-authorization-card");
  const allow = getButton(card, "Allow");
  await waitFor(() => {
    expect(allow).toBeEnabled();
  });

  click(allow);

  await waitFor(() => {
    expect(getButton(card, "Allowed")).toBeDisabled();
  });
  expect(sent).toStrictEqual([CALLBACK]);
  await expect(screen.findByText(CALLBACK)).resolves.toBeInTheDocument();
  expect(screen.getByText("I need a browser to continue.")).toBeInTheDocument();
});

test("A failed continuation retries with the same callback event identity", async () => {
  mockRequest();
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    ({ respond }) => {
      return respond(200, { ok: true, cloudBrowserEnabled: true });
    },
  );
  mockConversation();
  const events: { prompt: string | undefined; eventId: string | undefined }[] =
    [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    events.push({ prompt: body.prompt, eventId: body.clientEventId });
    return events.length === 1
      ? respond(500, {
          error: { code: "INTERNAL_SERVER_ERROR", message: "Chat unavailable" },
        })
      : respond(201, { threadId: THREAD_ID });
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  const card = await screen.findByTestId("browser-authorization-card");
  await waitFor(() => {
    expect(getButton(card, "Allow")).toBeEnabled();
  });

  click(getButton(card, "Allow"));

  await within(card).findByText("Couldn't continue. Try again.");
  click(getButton(card, "Retry"));

  await waitFor(() => {
    expect(getButton(card, "Allowed")).toBeDisabled();
  });
  expect(events).toStrictEqual([
    { prompt: CALLBACK, eventId: REQUEST_ID },
    { prompt: CALLBACK, eventId: REQUEST_ID },
  ]);
});

test("Failed authorization leaves the task paused", async () => {
  mockRequest();
  const sent: string[] = [];
  context.mocks.api(
    browserAuthorizationRequestsContract.apply,
    ({ respond }) => {
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Authorization unavailable" },
      });
    },
  );
  await setupChat(AUTHORIZATION_URL, (prompt) => {
    sent.push(prompt);
  });
  const card = await screen.findByTestId("browser-authorization-card");
  await waitFor(() => {
    expect(getButton(card, "Allow")).toBeEnabled();
  });

  click(getButton(card, "Allow"));

  await within(card).findByText("Couldn't continue. Try again.");
  expect(sent).toStrictEqual([]);
  expect(getButton(card, "Retry")).toBeEnabled();
});

test("A request from another chat cannot enable a browser or continue this task", async () => {
  mockRequest({ threadId: "b0000000-0000-4000-a000-000000000999" });
  await setupChat();
  const card = await screen.findByTestId("browser-authorization-card");
  await within(card).findByText(
    "This cloud browser authorization link is invalid, expired, or not available for this workspace.",
  );
  expect(getButton(card, "Retry")).toBeEnabled();
  expect(
    queryAllByRoleFast("button", card).find((button) => {
      return button.textContent?.trim() === "Allow";
    }),
  ).toBeUndefined();
});

test("Completed requests stay allowed when the chat is reopened", async () => {
  mockRequest({ enabled: true });
  const sent: string[] = [];
  await setupChat(AUTHORIZATION_URL, (prompt) => {
    sent.push(prompt);
  });
  const card = await screen.findByTestId("browser-authorization-card");
  await waitFor(() => {
    expect(getButton(card, "Allowed")).toBeDisabled();
  });
  expect(sent).toStrictEqual([]);
});

test("Expired requests are unavailable in the transcript", async () => {
  context.mocks.api(browserAuthorizationRequestsContract.get, ({ respond }) => {
    return respond(410, {
      error: { code: "GONE", message: "Authorization expired" },
    });
  });
  await setupChat();
  const card = await screen.findByTestId("browser-authorization-card");
  await within(card).findByText(
    "This cloud browser authorization link is invalid, expired, or not available for this workspace.",
  );
  expect(
    queryAllByRoleFast("button", card).find((button) => {
      return button.textContent?.trim() === "Allow";
    }),
  ).toBeUndefined();
});
