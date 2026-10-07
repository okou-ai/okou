import { randomUUID } from "node:crypto";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import {
  chatThreadEventsContract,
  type UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";
import { flushWaitUntilForTest } from "../../context/wait-until";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);

function authenticate(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return {
    authorization: "Bearer clerk-session",
  };
}

function eventsClient() {
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadEventsContract,
  );
}

async function sendNoCreditMessage(
  actor: ApiTestUser,
  body: {
    readonly agentId: string;
    readonly threadId?: string;
    readonly prompt: string;
    readonly userMessage?: UserMessageDocument;
  },
): Promise<string> {
  // Snapshot input needs a no-credit Auto message, not a personal subscription route.
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the no-credit send to be accepted");
  }
  // The background pick rejects the input; let it settle before reading.
  await flushWaitUntilForTest();
  return sent.body.threadId;
}

describe("chat event snapshot read endpoints", () => {
  it("serves current Raw Event rows from cold-start and paired cursors", async () => {
    const owner = bdd.user({ orgId: `org_${randomUUID()}` });
    const agent = await bdd.createAgent(owner, {
      displayName: "Row parity agent",
    });
    const marker = `row-parity-${randomUUID()}`;
    const threadId = await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      prompt: `${marker} first`,
      userMessage: {
        version: 1,
        parts: [
          { type: "text", text: `${marker} first` },
          {
            type: "feedback",
            quote: "Raw feedback quote",
            note: [{ type: "text", text: "Keep the Raw Event location." }],
            eventId: "raw-feedback-source-event",
            range: { start: 2, end: 8 },
          },
        ],
      },
    });
    await sendNoCreditMessage(owner, {
      agentId: agent.agentId,
      threadId,
      prompt: `${marker} second`,
    });

    const fromStart = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    const firstRow = fromStart.body.rows[0];
    if (firstRow === undefined) {
      throw new Error("Expected seeded chat events");
    }
    const firstSeqId = firstRow.seqId;

    const canonicalInput = fromStart.body.rows
      .map((row) => {
        return chatEventFromRow(row);
      })
      .find((event) => {
        return event?.eventType === "input.prompt";
      });
    if (canonicalInput?.eventType !== "input.prompt") {
      throw new Error("Expected the canonical feedback input");
    }
    expect(
      canonicalInput.userMessage.parts.find((part) => {
        return part.type === "feedback";
      }),
    ).toMatchObject({
      type: "feedback",
      eventId: "raw-feedback-source-event",
      range: { start: 2, end: 8 },
    });

    const rows = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: firstRow.id,
        },
      }),
      [200],
    );
    expect(rows.body.cursor).toStrictEqual({
      lastEventId: rows.body.rows.at(-1)?.id,
      lastSeqId: rows.body.rows.at(-1)?.seqId,
    });
    for (const row of rows.body.rows) {
      chatEventRowSchema.parse(row);
      expect(row.chatThreadId).toBe(threadId);
    }

    const projected = rows.body.rows.map((row) => {
      return chatEventFromRow(row);
    });
    expect(projected).toHaveLength(rows.body.rows.length);
    expect(rows.body.rows).toStrictEqual(
      fromStart.body.rows.filter((row) => {
        return row.seqId > firstSeqId;
      }),
    );
    expect(projected).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "input.prompt",
          userMessage: expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: `${marker} second`,
              }),
            ]),
          }),
        }),
      ]),
    );

    expect(fromStart.body.rows[0]?.seqId).toBe(firstSeqId);
    expect(fromStart.body.rows).toHaveLength(rows.body.rows.length + 1);

    const mismatchedPair = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: firstSeqId,
          sinceEventId: randomUUID(),
        },
      }),
      [410],
    );
    expect(mismatchedPair.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });

    const expired = await accept(
      eventsClient().rows({
        headers: authenticate(owner),
        params: { threadId },
        query: {
          sinceSeqId: 999_999,
          sinceEventId: randomUUID(),
        },
      }),
      [410],
    );
    expect(expired.body).toStrictEqual({
      error: {
        message: "Chat events cursor has expired",
        code: "CHAT_EVENTS_EXPIRED",
      },
    });
  }, 60_000);
});
