import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  computerUseAuthorizationRequestsContract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockAuthorizationCallbackThread } from "./authorization-callback-test-helpers.ts";
import { createMessageExperienceHelpers } from "./chat-message-experience-test-helpers.ts";
import { onlineComputerUseHost } from "./chat-list-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const NOW = "2026-11-20T08:00:00.000Z";
const THREAD_ID = "b0000000-0000-4000-a000-000000000931";
const REQUEST_ID = "a3000000-0000-4000-8000-000000000931";
const REQUEST_TOKEN = "cu-card-request-931";
const STUDIO_MAC = "f0000000-0000-4000-8000-000000000931";
const ASSISTANT_TEXT = "I need your Mac to open the design file.";
const ENABLED = "Computer access enabled for future runs in this chat.";

function authorizationLink(query = ""): string {
  return `https://app.okou.ai/computer-use/authorize/${REQUEST_TOKEN}${query}`;
}

interface ServerRequest {
  hosts: ComputerUseHost[];
  completedAt: string | null;
  computerUseHostId: string | null;
}

interface ApplyEvidence {
  hostId?: string;
  /** Set when an apply reaches a request that is already authorized. */
  reauthorizedHostId?: string;
}

/** The API's copy of one chat-scoped request; applying it completes it. */
function mockAuthorizationRequest(
  initial: Partial<ServerRequest> = {},
  outcome: "authorized" | "forbidden" = "authorized",
): { server: ServerRequest; apply: ApplyEvidence } {
  const server: ServerRequest = {
    hosts: [onlineComputerUseHost(STUDIO_MAC, "Studio Mac")],
    completedAt: null,
    computerUseHostId: null,
    ...initial,
  };
  const apply: ApplyEvidence = {};
  context.mocks.api(
    computerUseAuthorizationRequestsContract.get,
    ({ respond }) => {
      return respond(200, {
        id: REQUEST_ID,
        source: "chat",
        chatThreadId: THREAD_ID,
        expiresAt: "2026-11-20T09:00:00.000Z",
        completedAt: server.completedAt,
        computerUseHostId: server.computerUseHostId,
        hosts: server.hosts,
      });
    },
  );
  context.mocks.api(
    computerUseAuthorizationRequestsContract.apply,
    ({ body, respond }) => {
      if (outcome === "forbidden") {
        return respond(403, {
          error: { code: "FORBIDDEN", message: "Computer access denied" },
        });
      }
      if (server.completedAt) {
        apply.reauthorizedHostId = body.computerUseHostId;
      }
      apply.hostId = body.computerUseHostId;
      server.completedAt = "2026-11-20T08:00:00.000Z";
      server.computerUseHostId = body.computerUseHostId;
      return respond(200, {
        ok: true,
        source: "chat",
        computerUseHostId: body.computerUseHostId,
      });
    },
  );
  return { server, apply };
}

async function openChat(link: string): Promise<HTMLElement> {
  mockNow(new Date(NOW), context.signal);
  installMessageExperienceChat({
    threadId: THREAD_ID,
    chatEvents: [
      {
        id: "computer-request-message",
        role: "assistant",
        content: `${ASSISTANT_TEXT}\n\n${link}`,
        runId: "d0000000-0000-4000-a000-000000000931",
        seqId: 1,
        createdAt: "2026-11-20T07:59:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  await expect(screen.findByText(ASSISTANT_TEXT)).resolves.toBeInTheDocument();
  return await screen.findByTestId("computer-use-authorization-card");
}

function cardButton(card: HTMLElement, name: string): HTMLElement | undefined {
  return queryAllByRoleFast("button", card).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
}

async function findEnabledButton(
  card: HTMLElement,
  name: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const found = cardButton(card, name);
    expect(found).toBeEnabled();
    return found as HTMLElement;
  });
}

test("A user authorizes the only online computer directly in the chat", async () => {
  const { apply } = mockAuthorizationRequest();
  const card = await openChat(authorizationLink());
  const authorize = await findEnabledButton(card, "Authorize");
  expect(
    within(card).getByRole("combobox", { name: "Select a computer" }),
  ).toHaveTextContent("Studio Mac");

  click(authorize);

  await expect(within(card).findByText(ENABLED)).resolves.toBeInTheDocument();
  await waitFor(() => {
    expect(cardButton(card, "Authorized")).toBeDisabled();
  });
  expect(apply.hostId).toBe(STUDIO_MAC);
});

test("The card follows the host directory when a computer disconnects and returns", async () => {
  const { server } = mockAuthorizationRequest();
  const card = await openChat(authorizationLink());
  await findEnabledButton(card, "Authorize");

  server.hosts = [
    { ...onlineComputerUseHost(STUDIO_MAC, "Studio Mac"), status: "offline" },
  ];
  context.mocks.ably.trigger("computerUseHostsChanged");

  await expect(
    within(card).findByText("Open Okou on your Mac to bring it online."),
  ).resolves.toBeInTheDocument();
  expect(cardButton(card, "No online computers")).toBeDisabled();
  expect(cardButton(card, "Authorize")).toBeUndefined();

  server.hosts = [onlineComputerUseHost(STUDIO_MAC, "Studio Mac")];
  context.mocks.ably.trigger("computerUseHostsChanged");

  await findEnabledButton(card, "Authorize");
  expect(
    within(card).queryByText("Open Okou on your Mac to bring it online."),
  ).not.toBeInTheDocument();
});

test("An authorization failure stays visible without claiming access was enabled", async () => {
  mockAuthorizationRequest({}, "forbidden");
  const card = await openChat(authorizationLink());

  click(await findEnabledButton(card, "Authorize"));

  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "Could not authorize this computer. Try again.",
  );
  await findEnabledButton(card, "Authorize");
  expect(within(card).queryByText(ENABLED)).not.toBeInTheDocument();
  expect(cardButton(card, "Authorized")).toBeUndefined();
});

test("Completed requests remain authorized when the chat is reopened", async () => {
  mockAuthorizationRequest({
    completedAt: "2026-11-20T07:30:00.000Z",
    computerUseHostId: STUDIO_MAC,
  });

  const card = await openChat(authorizationLink());

  await waitFor(() => {
    expect(cardButton(card, "Authorized")).toBeDisabled();
  });
  expect(within(card).getByText(ENABLED)).toBeInTheDocument();
  expect(cardButton(card, "Authorize")).toBeUndefined();
});

test("Computer authorization resumes only with an explicit callback (false)", async () => {
  mockAuthorizationRequest();
  const card = await openChat(authorizationLink());
  const callback: { prompt?: string } = {};
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    callback.prompt = body.prompt;
    return respond(503, {
      error: { code: "UNEXPECTED_CALLBACK", message: "No callback expected" },
    });
  });

  click(await findEnabledButton(card, "Authorize"));

  await waitFor(() => {
    expect(cardButton(card, "Authorized")).toBeDisabled();
  });
  expect(within(card).getByText(ENABLED)).toBeInTheDocument();
  // Without a callback prompt in the link, nothing is posted to the chat.
  expect(callback.prompt).toBeUndefined();
});

test("A failed computer callback retries the same input without reauthorizing", async () => {
  const { apply } = mockAuthorizationRequest();
  mockAuthorizationCallbackThread(context, THREAD_ID);
  const card = await openChat(
    authorizationLink(`?callbackPrompt=Continue.&threadId=${THREAD_ID}`),
  );
  const continuation: {
    available: boolean;
    failed?: { prompt?: string; clientEventId?: string };
    delivered?: { prompt?: string; clientEventId?: string };
  } = { available: false };
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    const input = { prompt: body.prompt, clientEventId: body.clientEventId };
    if (!continuation.available) {
      continuation.failed = input;
      return respond(503, {
        error: { code: "SERVICE_UNAVAILABLE", message: "Run dispatch busy" },
      });
    }
    continuation.delivered = input;
    return respond(201, { threadId: THREAD_ID });
  });

  click(await findEnabledButton(card, "Authorize"));

  await expect(within(card).findByRole("alert")).resolves.toHaveTextContent(
    "Access enabled, but the conversation could not continue. Try again.",
  );
  expect(apply.hostId).toBe(STUDIO_MAC);
  const retry = await findEnabledButton(card, "Authorize");

  // The conversation service recovers before the user retries.
  continuation.available = true;
  click(retry);

  await waitFor(() => {
    expect(cardButton(card, "Authorized")).toBeDisabled();
  });
  expect(within(card).getByText(ENABLED)).toBeInTheDocument();
  expect(apply.reauthorizedHostId).toBeUndefined();
  expect(continuation.failed).toStrictEqual({
    prompt: "Continue.",
    clientEventId: REQUEST_ID,
  });
  expect(continuation.delivered).toStrictEqual(continuation.failed);
});
