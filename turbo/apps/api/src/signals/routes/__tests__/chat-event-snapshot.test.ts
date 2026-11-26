import { randomUUID } from "node:crypto";

import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const bdd = createBddApi(context);
const chat = createChatFilesBddApi(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function events(actor: ApiTestUser) {
  createRouteMocks(context).clerk.session(
    actor.userId,
    actor.orgId,
    actor.orgRole,
  );
  return setupApp({ context, routes: chatThreadRoutes })(
    chatThreadEventsContract,
  );
}

async function sendAuto(
  actor: ApiTestUser,
  body: Parameters<typeof chat.requestSendEvent>[1],
): Promise<string> {
  const sent = await chat.requestSendEvent(actor, body, [201]);
  if (sent.status !== 201) {
    throw new Error("Expected the prompt to be accepted");
  }
  return sent.body.threadId;
}

/**
 * An owner's thread with two accepted Auto prompts, the first carrying a
 * feedback part; the same user also belongs to another workspace. Background
 * work of both sends has settled so every read sees the same rows.
 */
async function threadWithFeedbackPrompts() {
  const owner = bdd.user();
  const elsewhere = bdd.user({ userId: owner.userId });
  const feedback = {
    type: "feedback" as const,
    quote: "Earlier",
    note: [{ type: "text" as const, text: "Be more concise" }],
    eventId: randomUUID(),
    range: { start: 0, end: 7 },
  };
  const threadId = await sendAuto(owner, {
    prompt: "first prompt",
    model: null,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: "first prompt" }, feedback],
    },
  });
  await sendAuto(owner, { prompt: "second prompt", threadId, model: null });
  await flushWaitUntilForTest();
  return { owner, elsewhere, feedback, threadId };
}

async function coldStartRows(owner: ApiTestUser, threadId: string) {
  const cold = await accept(
    events(owner).rows({
      headers,
      params: { threadId },
      query: { sinceSeqId: 0 },
    }),
    [200],
  );
  const rows = cold.body.rows;
  const [first, second] = rows;
  if (!first || !second) {
    throw new Error("Expected at least two raw rows");
  }
  return { rows, first, second };
}

describe("chat event snapshot read endpoints", () => {
  it("chat-event-snapshot-001 (1/4) serves cold-start rows with the canonical feedback source", async () => {
    const { owner, feedback, threadId } = await threadWithFeedbackPrompts();

    const { first } = await coldStartRows(owner, threadId);

    expect(first.eventType).toBe("input.prompt");
    expect(first.payload?.userMessage).toMatchObject({
      parts: expect.arrayContaining([
        expect.objectContaining({
          type: "feedback",
          eventId: feedback.eventId,
          range: feedback.range,
        }),
      ]),
    });
  });

  it("chat-event-snapshot-001 (2/4) pages exactly the later rows from the first row's paired cursor", async () => {
    const { owner, threadId } = await threadWithFeedbackPrompts();
    const { rows, first } = await coldStartRows(owner, threadId);

    const paired = await accept(
      events(owner).rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: first.seqId, sinceEventId: first.id },
      }),
      [200],
    );

    expect(paired.body.rows).toStrictEqual(rows.slice(1));
    for (const row of paired.body.rows) {
      expect(chatEventRowSchema.safeParse(row).success).toBeTruthy();
      expect(row.chatThreadId).toBe(threadId);
    }
    expect(
      paired.body.rows.filter((row) => {
        return row.eventType === "input.prompt";
      }),
    ).toHaveLength(1);
    const last = paired.body.rows.at(-1);
    if (!last) {
      throw new Error("Expected rows after the first cursor");
    }
    expect(paired.body.cursor).toStrictEqual({
      lastEventId: last.id,
      lastSeqId: last.seqId,
    });
  });

  it("chat-event-snapshot-001 (3/4) expires mismatched and unknown cursor pairs", async () => {
    const { owner, threadId } = await threadWithFeedbackPrompts();
    const { rows, first, second } = await coldStartRows(owner, threadId);
    const last = rows.at(-1);
    if (!last) {
      throw new Error("Expected a final raw row");
    }
    const ownerEvents = events(owner);

    const mismatched = await accept(
      ownerEvents.rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: first.seqId, sinceEventId: second.id },
      }),
      [410],
    );
    const unknown = await accept(
      ownerEvents.rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: last.seqId + 1000, sinceEventId: randomUUID() },
      }),
      [410],
    );

    for (const response of [mismatched, unknown]) {
      expect(response.body.error).toMatchObject({
        code: "CHAT_EVENTS_EXPIRED",
        message: "Chat events cursor has expired",
      });
    }
  });

  it("chat-event-snapshot-001 (4/4) hides the rows and snapshot from the user's other workspace", async () => {
    const { elsewhere, threadId } = await threadWithFeedbackPrompts();
    const otherWorkspace = events(elsewhere);

    const rows = await accept(
      otherWorkspace.rows({
        headers,
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [404],
    );
    const snapshot = await accept(
      otherWorkspace.snapshot({ headers, params: { threadId } }),
      [404],
    );

    for (const response of [rows, snapshot]) {
      expect(response.body.error.code).toBe("NOT_FOUND");
    }
  });
});
