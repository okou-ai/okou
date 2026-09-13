import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadMetadataContract,
  chatThreadsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  testContext,
  type TestContext,
} from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000081";
const ACTIVE_RUN_ID = "a0000000-0000-4000-a000-000000000081";
const WATCHED_RUN_ID = "a0000000-0000-4000-a000-000000000082";
const WATCHED_THREAD_ID = "b0000000-0000-4000-a000-000000000082";
const WATCHED_AGENT_ID = "c0000000-0000-4000-a000-000000000082";
const ACTIVE_PROMPT_THREAD_ID = "b0000000-0000-4000-a000-000000000091";
const SKIP_EVENT_THREAD_ID = "b0000000-0000-4000-a000-000000000092";
const WATCHED_EVENT_THREAD_ID = "b0000000-0000-4000-a000-000000000093";

function textDocument(text: string): UserMessageDocument {
  return { version: 1, parts: [{ type: "text", text }] };
}

function automationDocument(
  workflowName: string,
  automationBrief: string,
): UserMessageDocument {
  return {
    version: 1,
    parts: [{ type: "automation", workflowName, automationBrief }],
  };
}

function watchedRunDocument(summary: string): UserMessageDocument {
  return {
    version: 1,
    parts: [
      { type: "text", text: summary },
      {
        type: "source",
        kind: "agent",
        runId: WATCHED_RUN_ID,
        threadId: WATCHED_THREAD_ID,
        agentId: WATCHED_AGENT_ID,
        titleSnapshot: "Release watch",
        href: `/chats/${WATCHED_THREAD_ID}#run-${WATCHED_RUN_ID}`,
      },
    ],
  };
}

function eventRow(
  threadId: string,
  sequence: number,
  options: Pick<ChatEventRow, "eventType" | "payload" | "runId">,
): ChatEventRow {
  const caseSuffix = threadId.slice(-8);
  return {
    id: `d0000000-0000-4000-a000-${caseSuffix}${sequence
      .toString()
      .padStart(4, "0")}`,
    chatThreadId: threadId,
    runId: options.runId,
    revokesEventId: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: sequence,
    createdAt: `2026-08-01T00:00:${sequence.toString().padStart(2, "0")}.000Z`,
    eventType: options.eventType,
    payload: options.payload,
  };
}

function activeRunRow(threadId: string): ChatEventRow {
  return eventRow(threadId, 1, {
    eventType: "input.prompt",
    runId: ACTIVE_RUN_ID,
    payload: { userMessage: textDocument("Investigate the release") },
  });
}

function workflowAuth(caseId: string) {
  const userId = `workflow-queue-user-${caseId}`;
  const orgId = `workflow-queue-org-${caseId}`;
  return {
    user: { id: userId, fullName: "Workflow queue user" },
    organization: {
      activeOrg: { id: orgId, name: "Workflow queue org" },
      memberships: [{ id: orgId }],
    },
  };
}

function installWorkflowQueueFixture(
  testContextValue: TestContext,
  threadId: string,
  rows: readonly ChatEventRow[],
): { readonly revokedEventIds: string[] } {
  const revokedEventIds: string[] = [];
  testContextValue.mocks.data.agents([
    {
      agentId: AGENT_ID,
      displayName: "Queue agent",
      visibility: "private",
    },
  ]);
  testContextValue.mocks.api(chatThreadMetadataContract.get, ({ respond }) => {
    return respond(200, {
      id: threadId,
      agentId: AGENT_ID,
      title: "Workflow queue",
      selectedModel: "claude-sonnet-4-6",
      modelSettings: {},
      serviceTier: null,
      pinnedAt: null,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedVideoModel: null,
      selectedImageModel: null,
    });
  });
  testContextValue.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [
        {
          id: threadId,
          agentId: AGENT_ID,
          title: "Workflow queue",
          sortAt: "2026-08-01T00:00:00.000Z",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          pinnedAt: null,
          renamedAt: null,
          selectedModel: "claude-sonnet-4-6",
          serviceTier: null,
          computerUseHostId: null,
          cloudBrowserEnabled: false,
          selectedVideoModel: null,
          selectedImageModel: null,
        },
      ],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  testContextValue.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  testContextValue.mocks.api(
    chatThreadEventsContract.rows,
    ({ query, respond }) => {
      if (query.sinceSeqId === 0) {
        const last = rows.at(-1);
        const cursor: ChatEventCursor =
          last === undefined
            ? { lastEventId: null, lastSeqId: 0 }
            : { lastEventId: last.id, lastSeqId: last.seqId };
        return respond(200, {
          rows: [...rows],
          cursor,
          hasMore: false,
        });
      }
      const cursor: ChatEventCursor =
        query.sinceEventId === undefined
          ? { lastEventId: null, lastSeqId: 0 }
          : {
              lastEventId: query.sinceEventId,
              lastSeqId: query.sinceSeqId,
            };
      return respond(200, {
        rows: [],
        cursor,
        hasMore: false,
      });
    },
  );
  testContextValue.mocks.api(
    chatThreadEventsContract.snapshot,
    ({ respond }) => {
      return respond(404, {
        error: {
          code: "CHAT_EVENT_SNAPSHOT_NOT_FOUND",
          message: "Chat event snapshot not found",
        },
      });
    },
  );
  testContextValue.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.revokesEventId !== undefined) {
      revokedEventIds.push(body.revokesEventId);
    }
    return respond(201, {
      runId: null,
      threadId,
      status: "pending",
      createdAt: "2026-08-01T00:01:00.000Z",
    });
  });
  testContextValue.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Browser session not found" },
    });
  });
  return { revokedEventIds };
}

function queueListForText(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[role="listitem"]');
  expect(row).not.toBeNull();
  const list = row!.closest('[role="list"]');
  expect(list).not.toBeNull();
  return list as HTMLElement;
}

function button(container: ParentNode, name: string): HTMLElement {
  const result = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  expect(result).toBeDefined();
  return result!;
}

test("Active-run prompts stay in the conversation while automation events wait in the queue", async () => {
  installWorkflowQueueFixture(context, ACTIVE_PROMPT_THREAD_ID, [
    activeRunRow(ACTIVE_PROMPT_THREAD_ID),
    eventRow(ACTIVE_PROMPT_THREAD_ID, 2, {
      eventType: "input.prompt",
      runId: null,
      payload: { userMessage: textDocument("Prepare the follow-up summary") },
    }),
    eventRow(ACTIVE_PROMPT_THREAD_ID, 3, {
      eventType: "input.automation",
      runId: null,
      payload: {
        userMessage: automationDocument(
          "Release watcher",
          "Check rollout health",
        ),
      },
    }),
    eventRow(ACTIVE_PROMPT_THREAD_ID, 4, {
      eventType: "input.automation",
      runId: null,
      payload: {
        userMessage: automationDocument(
          "Incident watcher",
          "Summarize new incidents",
        ),
      },
    }),
    eventRow(ACTIVE_PROMPT_THREAD_ID, 5, {
      eventType: "goal.open",
      runId: null,
      payload: { content: "Keep the rollout healthy" },
    }),
  ]);

  await setupPage({
    context,
    path: `/chats/${ACTIVE_PROMPT_THREAD_ID}`,
    auth: workflowAuth("active-prompt"),
  });

  await waitFor(() => {
    expect(screen.getByText("Investigate the release")).toBeVisible();
    expect(screen.getByText("2 events waiting")).toBeVisible();
  });
  expect(screen.getByText("Prepare the follow-up summary")).toBeVisible();
  const list = queueListForText("Check rollout health");
  const rows = Array.from(list.querySelectorAll('[role="listitem"]'));
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveAccessibleName("Pending automation event");
  expect(rows[0]).toHaveTextContent("Check rollout health");
  expect(rows[1]).toHaveAccessibleName("Pending automation event");
  expect(rows[1]).toHaveTextContent("Summarize new incidents");
  expect(screen.getAllByText("Check rollout health")).toHaveLength(1);
  expect(screen.getAllByText("Summarize new incidents")).toHaveLength(1);
});

test("Skip one pending automation event without removing the others", async () => {
  const firstEvent = eventRow(SKIP_EVENT_THREAD_ID, 2, {
    eventType: "input.automation",
    runId: null,
    payload: {
      userMessage: automationDocument("First workflow", "Check deployment"),
    },
  });
  const secondEvent = eventRow(SKIP_EVENT_THREAD_ID, 3, {
    eventType: "input.automation",
    runId: null,
    payload: {
      userMessage: automationDocument("Second workflow", "Publish digest"),
    },
  });
  const requests = installWorkflowQueueFixture(context, SKIP_EVENT_THREAD_ID, [
    activeRunRow(SKIP_EVENT_THREAD_ID),
    firstEvent,
    secondEvent,
  ]);

  await setupPage({
    context,
    path: `/chats/${SKIP_EVENT_THREAD_ID}`,
    auth: workflowAuth("skip-event"),
  });

  await waitFor(() => {
    expect(screen.getByText("Check deployment")).toBeVisible();
    expect(screen.getByText("Publish digest")).toBeVisible();
  });
  const firstRow = screen
    .getByText("Check deployment")
    .closest('[role="listitem"]');
  expect(firstRow).not.toBeNull();
  await userEvent.click(
    button(firstRow as HTMLElement, "Skip automation event"),
  );

  await waitFor(() => {
    expect(screen.queryByText("Check deployment")).not.toBeInTheDocument();
  });
  expect(screen.getByText("Publish digest")).toBeVisible();
  expect(requests.revokedEventIds).toStrictEqual([firstEvent.id]);
});

test("A watched-run automation waits as an automation event", async () => {
  const watchedEvent = eventRow(WATCHED_EVENT_THREAD_ID, 2, {
    eventType: "input.automation",
    runId: null,
    payload: {
      userMessage: watchedRunDocument("Release watch completed successfully"),
    },
  });
  const requests = installWorkflowQueueFixture(
    context,
    WATCHED_EVENT_THREAD_ID,
    [activeRunRow(WATCHED_EVENT_THREAD_ID), watchedEvent],
  );

  await setupPage({
    context,
    path: `/chats/${WATCHED_EVENT_THREAD_ID}`,
    auth: workflowAuth("watched-event"),
  });

  await waitFor(() => {
    expect(screen.getByText("1 event waiting")).toBeVisible();
    expect(
      screen.getByText("Release watch completed successfully"),
    ).toBeVisible();
  });
  const sourceSummary = screen.getByText(
    "Release watch completed successfully",
  );
  const eventRowElement = sourceSummary.closest('[role="listitem"]');
  expect(eventRowElement).not.toBeNull();
  expect(eventRowElement).toHaveAccessibleName("Pending automation event");
  expect(
    screen.queryByRole("listitem", { name: "Queued message" }),
  ).not.toBeInTheDocument();

  await userEvent.click(
    button(eventRowElement as HTMLElement, "About this automation event"),
  );
  const eventHeading = await screen.findByText("Automation event");
  expect(eventHeading).toBeVisible();
  expect(
    screen.getByText(
      "Waits behind queued messages and runs once the current run finishes.",
    ),
  ).toBeVisible();

  await userEvent.click(
    button(eventRowElement as HTMLElement, "Skip automation event"),
  );

  await waitFor(() => {
    expect(
      screen.queryByText("Release watch completed successfully"),
    ).not.toBeInTheDocument();
  });
  expect(requests.revokedEventIds).toStrictEqual([watchedEvent.id]);
});
