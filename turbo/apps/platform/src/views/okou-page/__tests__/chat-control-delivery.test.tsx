import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import type { MockChatEventInput } from "./chat-event-test-helpers.ts";
import { setupPage } from "./chat-lifecycle-test-helpers.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  promptEvent,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
} from "./chat-run-test-fixtures.ts";

const RUN_ID = "a0000000-0000-4000-a000-000000000301";
const AUTOMATION_ID = "queued-control-target";
const CREATED_AT = "2026-08-01T10:00:00.000Z";

function runningEvents(): MockChatEventInput[] {
  return [
    promptEvent({
      id: "running-control-target",
      runId: RUN_ID,
      seqId: 1,
      text: "Review this request",
      createdAt: CREATED_AT,
    }),
  ];
}

function queuedEvents(): MockChatEventInput[] {
  return [
    ...runningEvents(),
    {
      id: AUTOMATION_ID,
      eventType: "input.automation",
      role: "user",
      runId: undefined,
      content: null,
      seqId: 2,
      createdAt: CREATED_AT,
    },
  ];
}

async function openChat(): Promise<void> {
  await setupPage({ context, path: RUN_PATH });
  await readyChat();
}

async function removeQueuedItem(): Promise<void> {
  await expect(
    screen.findByRole("listitem", { name: "Pending automation event" }),
  ).resolves.toBeInTheDocument();
  click(await findEnabledButton("Skip automation event"));
}

function expectQueuedItem(): void {
  expect(
    screen.getByRole("listitem", { name: "Pending automation event" }),
  ).toBeInTheDocument();
}

test("A rejected revoke keeps the queued item and reports failure without replaying it", async () => {
  const sent: string[] = [];
  installRunChat({ chatEvents: queuedEvents(), activeRunIds: [RUN_ID] });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.revokesEventId !== AUTOMATION_ID || !body.clientEventId) {
      throw new Error("Expected automation revoke");
    }
    sent.push(body.clientEventId);
    return respond(401, {
      error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
    });
  });
  await openChat();
  await removeQueuedItem();

  await expect(
    screen.findByText(/Remove queued item was rejected/),
  ).resolves.toBeInTheDocument();
  expectQueuedItem();
  click(await findEnabledButton("Skip automation event"));
  click(await findEnabledButton("Refresh conversation"));
  expectQueuedItem();
  expect(sent).toHaveLength(1);
});

test("A revoke accepted without a response stays uncertain until its server event is refreshed", async () => {
  const events = queuedEvents();
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  const sent: string[] = [];
  context.mocks.http.post("*/api/chat/events", async ({ request }) => {
    const body = (await request.json()) as {
      revokesEventId?: string;
      clientEventId?: string;
    };
    if (body.revokesEventId !== AUTOMATION_ID || !body.clientEventId) {
      throw new Error("Expected automation revoke");
    }
    sent.push(body.clientEventId);
    return HttpResponse.error();
  });
  await openChat();
  await removeQueuedItem();

  await expect(
    screen.findByText(/Couldn't confirm Remove queued item/),
  ).resolves.toBeInTheDocument();
  expectQueuedItem();
  click(await findEnabledButton("Skip automation event"));
  expect(sent).toHaveLength(1);

  events.push({
    id: sent[0],
    eventType: "control.revoke",
    revokesEventId: AUTOMATION_ID,
    content: null,
    createdAt: CREATED_AT,
    seqId: 3,
  });
  click(await findEnabledButton("Refresh conversation"));
  await waitFor(() => {
    expect(
      screen.queryByText(/Couldn't confirm Remove queued item/),
    ).toBeNull();
    expect(
      screen.queryByRole("listitem", { name: "Pending automation event" }),
    ).toBeNull();
  });
  expect(sent).toHaveLength(1);
});

test("A rejected interrupt leaves Stop available and identifies the failure", async () => {
  const sent: string[] = [];
  installRunChat({ chatEvents: runningEvents(), activeRunIds: [RUN_ID] });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.interruptsRunId !== RUN_ID || !body.clientEventId) {
      throw new Error("Expected live-run interrupt");
    }
    sent.push(body.clientEventId);
    return respond(401, {
      error: { code: "NOT_AUTHENTICATED", message: "Not authenticated" },
    });
  });
  await openChat();
  click(await findEnabledButton("Stop"));

  await expect(
    screen.findByText(/Stop run was rejected/),
  ).resolves.toBeInTheDocument();
  await expect(findEnabledButton("Stop")).resolves.toBeInTheDocument();
  click(await findEnabledButton("Stop"));
  expect(sent).toHaveLength(1);
});

test("An interrupt accepted without a response does not imply success or send twice", async () => {
  const events = runningEvents();
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  const sent: string[] = [];
  context.mocks.http.post("*/api/chat/events", async ({ request }) => {
    const body = (await request.json()) as {
      interruptsRunId?: string;
      clientEventId?: string;
    };
    if (body.interruptsRunId !== RUN_ID || !body.clientEventId) {
      throw new Error("Expected live-run interrupt");
    }
    sent.push(body.clientEventId);
    return HttpResponse.error();
  });
  await openChat();
  click(await findEnabledButton("Stop"));

  await expect(
    screen.findByText(/Couldn't confirm Stop run/),
  ).resolves.toBeInTheDocument();
  await expect(findEnabledButton("Stop")).resolves.toBeInTheDocument();
  click(await findEnabledButton("Stop"));
  expect(sent).toHaveLength(1);

  events.push({
    id: sent[0],
    eventType: "control.interrupt",
    interruptsRunId: RUN_ID,
    content: null,
    createdAt: CREATED_AT,
    seqId: 2,
  });
  click(await findEnabledButton("Refresh conversation"));
  await waitFor(() => {
    expect(screen.queryByText(/Couldn't confirm Stop run/)).toBeNull();
  });
  expect(sent).toHaveLength(1);
});

test("A 201 control waits for the canonical event rather than optimistically removing the item", async () => {
  const events = queuedEvents();
  installRunChat({ chatEvents: events, activeRunIds: [RUN_ID] });
  let sentId: string | undefined;
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.revokesEventId !== AUTOMATION_ID || !body.clientEventId) {
      throw new Error("Expected automation revoke");
    }
    sentId = body.clientEventId;
    return respond(201, { runId: null, threadId: RUN_THREAD_ID });
  });
  await openChat();
  await removeQueuedItem();

  await expect(
    screen.findByText(/Remove queued item was accepted/),
  ).resolves.toBeInTheDocument();
  expectQueuedItem();
  expect(sentId).toBeDefined();
  // Another client can win the target race: the server acknowledges this POST
  // but the canonical control has that client's ID, not this request's ID.
  events.push({
    id: "d0000000-0000-4000-a000-000000000399",
    eventType: "control.revoke",
    revokesEventId: AUTOMATION_ID,
    content: null,
    createdAt: CREATED_AT,
    seqId: 3,
  });
  click(await findEnabledButton("Refresh conversation"));
  await waitFor(() => {
    expect(screen.queryByText(/Remove queued item was accepted/)).toBeNull();
    expect(
      screen.queryByRole("listitem", { name: "Pending automation event" }),
    ).toBeNull();
  });
});

test("A freshly loaded conversation shows only the canonical control outcome", async () => {
  installRunChat({
    chatEvents: [
      ...queuedEvents(),
      {
        id: "d0000000-0000-4000-a000-000000000398",
        eventType: "control.revoke",
        revokesEventId: AUTOMATION_ID,
        content: null,
        createdAt: CREATED_AT,
        seqId: 3,
      },
    ],
    activeRunIds: [RUN_ID],
  });
  await openChat();
  await expect(
    screen.findByText("Review this request"),
  ).resolves.toBeInTheDocument();
  expect(
    screen.queryByRole("listitem", { name: "Pending automation event" }),
  ).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(/Remove queued item was accepted/)).toBeNull();
});
