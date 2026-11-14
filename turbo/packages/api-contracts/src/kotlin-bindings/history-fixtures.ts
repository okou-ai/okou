import type { ZodType } from "zod";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadMarkReadContract,
} from "../contracts/chat-threads";
import { chatEventRowSchema } from "../contracts/chat-event-rows";
import type { KotlinRouteBinding, KotlinTypeBinding } from "./bindings";

/** Test-only protocol bindings; installed reader routes are registered separately. */
export const kotlinHistoryFixtureRoutes: readonly KotlinRouteBinding[] = [
  {
    name: "snapshot",
    response: "HistorySnapshot",
    route: chatThreadEventsContract.snapshot,
  },
  {
    name: "rows",
    response: "HistoryRows",
    route: chatThreadEventsContract.rows,
  },
  {
    name: "detail",
    response: "ThreadDetail",
    route: chatThreadByIdContract.get,
  },
  {
    name: "markRead",
    response: "ReadState",
    route: chatThreadMarkReadContract.markRead,
  },
];

export const kotlinHistoryFixtureTypes: readonly KotlinTypeBinding[] = [
  ...kotlinHistoryFixtureRoutes.map(({ response, route }) => {
    return {
      name: response,
      schema: route.responses[200]!,
      direction: "output" as const,
    };
  }),
  { name: "RawHistoryRow", schema: chatEventRowSchema, direction: "output" },
];

const threadId = "11111111-1111-4111-8111-111111111111";
const eventId = "44444444-4444-4444-8444-444444444444";
const date = "2026-11-13T00:00:00.000Z";

function wire(schema: ZodType, value: unknown): unknown {
  schema.parse(value);
  return value;
}

export function kotlinHistoryFixtureJson(): string {
  const base = {
    id: eventId,
    chatThreadId: threadId,
    runId: null,
    revokesEventId: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 17,
    createdAt: date,
  };
  const rows = [
    {
      ...base,
      id: "input",
      eventType: "input.prompt",
      contextType: "web",
      payload: {
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Hello" },
            { type: "attachment", metadata: { arbitrary: [null, true, 7] } },
          ],
        },
      },
    },
    {
      ...base,
      id: "output",
      seqId: 23,
      eventType: "output.message",
      payload: { content: "Reply", userMessage: null },
    },
    {
      ...base,
      id: "failed",
      seqId: 29,
      eventType: "run.failed",
      failureReason: "runner_failed",
      payload: { error: "Failed" },
    },
    {
      ...base,
      id: "revoke",
      seqId: 32,
      eventType: "control.revoke",
      revokesEventId: "input",
      payload: null,
    },
    {
      ...base,
      seqId: 37,
      eventType: "usage.recorded",
      payload: { usage: { input: 42, nested: ["future", null] } },
    },
  ];
  const cursor = { lastEventId: eventId, lastSeqId: 37 };
  return (
    JSON.stringify(
      {
        snapshotEmpty: wire(chatThreadEventsContract.snapshot.responses[200], {
          url: "https://storage.example/history",
          expiresInSeconds: 60,
          lastEventId: null,
          lastSeqId: 0,
        }),
        snapshotWarm: wire(chatThreadEventsContract.snapshot.responses[200], {
          url: "https://storage.example/history",
          expiresInSeconds: 60,
          ...cursor,
        }),
        page: wire(chatThreadEventsContract.rows.responses[200], {
          rows,
          cursor,
          hasMore: false,
        }),
        pageEmpty: wire(chatThreadEventsContract.rows.responses[200], {
          rows: [],
          cursor: { lastEventId: null, lastSeqId: 0 },
          hasMore: false,
        }),
        queryCold: wire(chatThreadEventsContract.rows.query, {
          sinceSeqId: 0,
          limit: 50,
        }),
        queryWarm: wire(chatThreadEventsContract.rows.query, {
          sinceSeqId: 37,
          sinceEventId: eventId,
          limit: 12.5,
        }),
        detail: wire(chatThreadByIdContract.get.responses[200], {
          lastReadAt: null,
          cancellationRecoveryPending: false,
        }),
        readState: wire(chatThreadMarkReadContract.markRead.responses[200], {
          lastReadAt: date,
        }),
      },
      null,
      2,
    ) + "\n"
  );
}
