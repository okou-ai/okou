import {
  computerUseAuthorizationRequestsContract as contract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { initContract } from "@okouai/api-contracts/contracts/base";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { onlineComputerUseHost } from "./chat-list-test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const THREAD_ID = "20000000-0000-4000-8000-000000000001";
const HOST_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_HOST_ID = "30000000-0000-4000-8000-000000000002";
const REQUEST_TOKEN = "vm0_computer_use_authorization_request_test";
const AUTHORIZATION_URL = `https://app.okou.ai/computer-use/authorize/${REQUEST_TOKEN}`;

function mockRequest(
  options: {
    hosts?: ComputerUseHost[];
    threadId?: string;
    completed?: boolean;
    blockedReason?: "run_active" | "chat_busy" | "request_superseded" | null;
  } = {},
) {
  let completed = options.completed ?? false;
  let hosts = options.hosts ?? [onlineComputerUseHost(HOST_ID)];
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(200, {
      source: "chat",
      ...(options.blockedReason !== undefined
        ? { continuation: { blockedReason: options.blockedReason } }
        : {}),
      chatThreadId: options.threadId ?? THREAD_ID,
      expiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
      completedAt: completed ? new Date(now()).toISOString() : null,
      computerUseHostId: completed ? HOST_ID : null,
      hosts,
    });
  });
  return {
    complete() {
      completed = true;
      context.mocks.ably.trigger("desktopShellAuthorizationChanged");
    },
    updateHosts(next: ComputerUseHost[]) {
      hosts = next;
      context.mocks.ably.trigger("computerUseHostsChanged");
    },
  };
}

async function setupChat() {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Computer authorization",
    chatEvents: [
      {
        id: "computer-request",
        role: "assistant",
        content: AUTHORIZATION_URL,
        runId: "computer-request-run",
        createdAt: "2026-11-06T08:00:00.000Z",
      },
    ],
  });
  await setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
  return await screen.findByTestId("computer-use-authorization-card");
}

function button(card: HTMLElement, name: string) {
  const result = queryAllByRoleFast("button", card).find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!result) {
    throw new Error(`Missing button: ${name}`);
  }
  return result;
}

test("A user authorizes the only online computer directly in the chat", async () => {
  const request = mockRequest();
  context.mocks.api(contract.apply, ({ params, body, respond }) => {
    expect(params.requestToken).toBe(REQUEST_TOKEN);
    expect(body.computerUseHostId).toBe(HOST_ID);
    request.complete();
    return respond(200, {
      ok: true,
      source: "chat",
      computerUseHostId: HOST_ID,
    });
  });
  const card = await setupChat();
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeEnabled();
  });
  click(button(card, "Authorize"));
  await waitFor(() => {
    expect(button(card, "Authorized")).toBeDisabled();
  });
  expect(
    within(card).getByText("Computer access enabled for this chat."),
  ).toBeInTheDocument();
});

test("With multiple online computers, a user chooses which one to authorize", async () => {
  const request = mockRequest({
    hosts: [
      { ...onlineComputerUseHost(HOST_ID), displayName: "Work Mac" },
      { ...onlineComputerUseHost(OTHER_HOST_ID), displayName: "Studio Mac" },
    ],
  });
  context.mocks.api(contract.apply, ({ body, respond }) => {
    expect(body.computerUseHostId).toBe(OTHER_HOST_ID);
    request.complete();
    return respond(200, {
      ok: true,
      source: "chat",
      computerUseHostId: OTHER_HOST_ID,
    });
  });
  const card = await setupChat();
  const select = await within(card).findByRole("combobox", {
    name: "Select a computer",
  });
  await waitFor(() => {
    expect(select).toBeEnabled();
  });
  expect(button(card, "Authorize")).toBeDisabled();
  await userEvent.click(select);
  await userEvent.click(
    await screen.findByRole("option", { name: "Studio Mac" }),
  );
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeEnabled();
  });
  request.updateHosts([
    { ...onlineComputerUseHost(HOST_ID), displayName: "Work Mac" },
  ]);
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeDisabled();
    expect(select).toHaveTextContent("Select a computer");
  });
  request.updateHosts([
    { ...onlineComputerUseHost(HOST_ID), displayName: "Work Mac" },
    { ...onlineComputerUseHost(OTHER_HOST_ID), displayName: "Studio Mac" },
  ]);
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeEnabled();
    expect(select).toHaveTextContent("Studio Mac");
  });
  click(button(card, "Authorize"));
  await waitFor(() => {
    expect(button(card, "Authorized")).toBeDisabled();
  });
});

test("The card follows the host directory when a computer disconnects and returns", async () => {
  const request = mockRequest();
  const card = await setupChat();
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeEnabled();
  });
  request.updateHosts([
    { ...onlineComputerUseHost(HOST_ID), status: "offline" },
  ]);
  await waitFor(() => {
    expect(button(card, "No online computers")).toBeDisabled();
  });
  expect(
    within(card).getByText("Open Okou on your Mac to bring it online."),
  ).toBeInTheDocument();
  request.updateHosts([onlineComputerUseHost(HOST_ID)]);
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeEnabled();
  });
});

test("An authorization failure stays visible without claiming access was enabled", async () => {
  mockRequest();
  context.mocks.api(contract.apply, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "Authorization unavailable" },
    });
  });
  const card = await setupChat();
  await waitFor(() => {
    expect(button(card, "Authorize")).toBeEnabled();
  });
  click(button(card, "Authorize"));
  await within(card).findByText(
    "Could not authorize this computer. Refresh the chat to try again.",
  );
  expect(button(card, "Authorize")).toBeDisabled();
});

test("A request from another chat cannot authorize a computer from this card", async () => {
  mockRequest({ threadId: "20000000-0000-4000-8000-000000000002" });
  const card = await setupChat();
  await within(card).findByText(
    "This Computer Use authorization link is invalid, expired, or not available for this workspace.",
  );
  expect(queryAllByRoleFast("button", card)).toHaveLength(0);
});

test("An older API response without chat scope cannot offer inline authorization", async () => {
  const oldGetContract = initContract().router({
    get: {
      ...contract.get,
      responses: {
        ...contract.get.responses,
        200: contract.get.responses[200].omit({ chatThreadId: true }),
      },
    },
  }).get;
  context.mocks.api(oldGetContract, ({ respond }) => {
    return respond(200, {
      source: "chat",
      expiresAt: new Date(now() + 60 * 60 * 1000).toISOString(),
      completedAt: null,
      computerUseHostId: null,
      hosts: [onlineComputerUseHost(HOST_ID)],
    });
  });
  const card = await setupChat();
  await within(card).findByText(
    "This Computer Use authorization link is invalid, expired, or not available for this workspace.",
  );
  expect(queryAllByRoleFast("button", card)).toHaveLength(0);
});

test("An expired authorization request is unavailable in the transcript", async () => {
  context.mocks.api(contract.get, ({ respond }) => {
    return respond(410, {
      error: { code: "GONE", message: "Authorization expired" },
    });
  });
  const card = await setupChat();
  await within(card).findByText(
    "This Computer Use authorization link is invalid, expired, or not available for this workspace.",
  );
  expect(queryAllByRoleFast("button", card)).toHaveLength(0);
});

test("Completed requests remain authorized when the chat is reopened", async () => {
  mockRequest({ completed: true });
  const card = await setupChat();
  await waitFor(() => {
    expect(button(card, "Authorized")).toBeDisabled();
  });
});

test("Web authorization promises continuation and waits for the source Run", async () => {
  mockRequest({ blockedReason: "run_active" });
  const card = await setupChat();
  await waitFor(() => {
    return expect(button(card, "Authorize and continue")).toBeDisabled();
  });
  expect(
    within(card).getByText(
      "Wait for the requesting Run to finish before approving.",
    ),
  ).toBeInTheDocument();
});

test("An obsolete authorization card asks for a fresh request", async () => {
  mockRequest({ blockedReason: "request_superseded" });
  const card = await setupChat();
  await waitFor(() => {
    return expect(button(card, "Authorize and continue")).toBeDisabled();
  });
  expect(
    within(card).getByText(
      "This chat has a newer task. Ask for a new Computer Use request.",
    ),
  ).toBeInTheDocument();
});

test("Web authorization refreshes the card after the server enqueues continuation", async () => {
  const request = mockRequest({ blockedReason: null });
  context.mocks.api(contract.apply, ({ respond }) => {
    request.complete();
    return respond(200, {
      ok: true,
      source: "chat",
      computerUseHostId: HOST_ID,
      continuationEnqueued: true,
    });
  });
  const card = await setupChat();
  await waitFor(() => {
    return expect(button(card, "Authorize and continue")).toBeEnabled();
  });
  click(button(card, "Authorize and continue"));
  await waitFor(() => {
    return expect(button(card, "Authorized")).toBeDisabled();
  });
});
