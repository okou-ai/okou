import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { ChatEventCursor } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import {
  chatEventSchema,
  chatThreadEventsContract,
  chatThreadsContract,
  type ChatEvent,
} from "@okouai/api-contracts/contracts/chat-threads";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../../chat-threads";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";

const MAX_EVENT_ROWS_PER_PAGE = 50;

export function projectChatEventRows(
  rows: readonly ChatEventRow[],
): readonly ChatEvent[] {
  return rows.flatMap((row) => {
    const event = chatEventFromRow(row);
    if (event === null) {
      return [];
    }
    const serialized = JSON.stringify(event);
    if (serialized === undefined) {
      throw new Error(`Failed to serialize chat event ${row.id}`);
    }
    return [chatEventSchema.parse(JSON.parse(serialized))];
  });
}

export async function readProjectedChatEvents(
  context: TestContext,
  args: {
    readonly threadId: string;
    readonly headers: Readonly<{ authorization?: string }>;
    readonly limit?: number;
    readonly extraHeaders?: Readonly<Record<string, string>>;
  } & (
    | { readonly sinceSeqId?: 0; readonly sinceEventId?: never }
    | { readonly sinceSeqId: number; readonly sinceEventId: string }
  ),
): Promise<readonly ChatEvent[]> {
  const client = setupApp({ context, routes: chatThreadRoutes })(
    chatThreadEventsContract,
  );
  const limit = args.limit ?? MAX_EVENT_ROWS_PER_PAGE;
  const rows: ChatEventRow[] = [];
  let cursor: ChatEventCursor;
  if (args.sinceSeqId === undefined || args.sinceSeqId === 0) {
    cursor = { lastEventId: null, lastSeqId: 0 };
  } else {
    if (args.sinceEventId === undefined) {
      throw new Error("Chat Event test cursor requires an event ID");
    }
    cursor = {
      lastEventId: args.sinceEventId,
      lastSeqId: args.sinceSeqId,
    };
  }

  while (true) {
    const response = await accept(
      client.rows({
        headers: args.headers,
        ...(args.extraHeaders === undefined
          ? {}
          : { extraHeaders: args.extraHeaders }),
        params: { threadId: args.threadId },
        query:
          cursor.lastEventId === null
            ? { sinceSeqId: 0, limit }
            : {
                sinceSeqId: cursor.lastSeqId,
                sinceEventId: cursor.lastEventId,
                limit,
              },
      }),
      [200],
    );
    rows.push(...response.body.rows);
    if (!response.body.hasMore) {
      return projectChatEventRows(rows);
    }

    const nextCursor = response.body.cursor;
    if (
      nextCursor.lastEventId === null ||
      nextCursor.lastSeqId <= cursor.lastSeqId
    ) {
      throw new Error(
        `Chat event row cursor did not advance for ${args.threadId}`,
      );
    }
    cursor = nextCursor;
  }
}

type InputPromptEvent = Extract<
  ChatEvent,
  { readonly eventType: "input.prompt" }
>;

/**
 * Finds the caller's queued input with this exact text part through the
 * public thread lifecycle feed and thread events. A queued input has no run.
 */
export async function findPendingInputEventByText(
  context: TestContext,
  args: { readonly actor: ApiTestUser; readonly text: string },
): Promise<InputPromptEvent | undefined> {
  createRouteMocks(context).clerk.session(
    args.actor.userId,
    args.actor.orgId,
    args.actor.orgRole,
  );
  const headers = { authorization: "Bearer clerk-session" };
  const lifecycle = await accept(
    setupApp({ context, routes: chatThreadRoutes })(chatThreadsContract).events(
      { headers, query: {} },
    ),
    [200],
  );
  const threadIds = lifecycle.body.events.flatMap((event) => {
    return event.kind === "created" ? [event.chatThreadId] : [];
  });
  const matches: InputPromptEvent[] = [];
  for (const threadId of threadIds) {
    const events = await readProjectedChatEvents(context, {
      threadId,
      headers,
    });
    for (const event of events) {
      if (
        event.eventType === "input.prompt" &&
        event.runId === undefined &&
        event.userMessage.parts.some((part) => {
          return part.type === "text" && part.text === args.text;
        })
      ) {
        matches.push(event);
      }
    }
  }
  expect(matches.length).toBeLessThanOrEqual(1);
  return matches[0];
}
