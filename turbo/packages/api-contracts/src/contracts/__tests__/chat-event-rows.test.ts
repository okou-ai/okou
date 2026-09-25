import { describe, expect, it } from "vitest";
import { CHAT_EVENT_TYPES, type ChatEventType } from "../chat-events";
import { chatEventFromRow } from "../chat-event-row-projection";
import {
  PI_MEMORY_CITATION_OPEN,
  PI_MEMORY_CITATION_CLOSE,
} from "../pi-memory-citations";
import { chatEventRowSchema, type ChatEventRow } from "../chat-event-rows";
import {
  CHAT_EVENT_SCHEMA_VERSION_HEADER,
  CURRENT_CHAT_EVENT_SCHEMA_VERSION,
} from "../chat-event-schema-version";
import { chatEventSchema, chatThreadEventsContract } from "../chat-threads";

const CREATED_AT = "2026-08-08T10:00:00.000Z";

function canonicalRow(
  overrides: Readonly<Record<string, unknown>>,
): ChatEventRow {
  return chatEventRowSchema.parse({
    id: "00000000-0000-4000-8000-000000000003",
    chatThreadId: "00000000-0000-4000-8000-000000000002",
    runId: null,
    revokesEventId: null,
    eventType: "output.message",
    payload: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId: 2,
    createdAt: CREATED_AT,
    ...overrides,
  });
}

function projectableRow(eventType: ChatEventType): ChatEventRow {
  const runId = "00000000-0000-4000-8000-000000000013";
  const revokesEventId = "00000000-0000-4000-8000-000000000014";
  const userMessage = {
    version: 1,
    parts: [{ type: "text", text: eventType }],
  };
  const variants: Record<ChatEventType, Readonly<Record<string, unknown>>> = {
    "input.prompt": { payload: { userMessage }, contextType: "web" },
    "input.automation": {
      payload: { userMessage },
      contextType: "automation",
      contextId: "00000000-0000-4000-8000-000000000015",
    },
    "input.goal": {
      payload: { userMessage },
      contextType: "goal",
      contextId: "00000000-0000-4000-8000-000000000016",
    },
    "input.budget": { payload: { userMessage }, contextType: "web" },
    "input.rejected": {
      payload: { userMessage, error: "rejected" },
      contextType: "web",
    },
    "output.message": { payload: { content: "message" } },
    "output.error": {
      payload: { content: "display error", error: "output error" },
    },
    "output.thinking": { payload: { thinking: "thinking" } },
    "output.followups": { payload: { content: "followups" } },
    "run.queued": { runId, payload: { content: "queued" } },
    "run.dequeued": { runId, revokesEventId },
    "run.completed": { runId },
    "run.failed": {
      runId,
      payload: { content: "failed", error: "runner error" },
    },
    "run.cancelled": { runId, payload: { error: "cancelled" } },
    "control.interrupt": { runId },
    "control.revoke": { revokesEventId },
    "browser.open": {},
    "browser.close": {},
    "goal.open": { payload: { content: "goal opened" } },
    "goal.close": {},
    "usage.recorded": {
      runId,
      payload: {
        usage: {
          version: 1,
          totalCredits: 1,
          settledAt: CREATED_AT,
          breakdown: [],
        },
      },
    },
  };
  return canonicalRow({ eventType, ...variants[eventType] });
}

describe("canonical chat event row schema", () => {
  it("accepts canonical rows", () => {
    const row = canonicalRow({ payload: { content: "canonical" } });
    expect(
      chatEventRowSchema.parse(JSON.parse(JSON.stringify(row))),
    ).toStrictEqual(row);
  });

  it("preserves canonical multi-leaf payloads and nested JSON nulls", () => {
    const row = canonicalRow({
      payload: {
        content: "historical content",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "historical input" }],
          nestedProbe: { value: null },
        },
        thinking: "historical thinking",
        error: "historical error",
        usage: {
          version: 1,
          totalCredits: 4,
          settledAt: CREATED_AT,
          breakdown: [],
        },
      },
    });
    const parsed = chatEventRowSchema.parse(JSON.parse(JSON.stringify(row)));
    expect(parsed).toStrictEqual(row);
    expect(parsed.payload).toHaveProperty(
      "userMessage.nestedProbe.value",
      null,
    );
    expect(parsed).not.toHaveProperty("content");
    expect(parsed).not.toHaveProperty("interruptsRunId");
    expect(parsed).not.toHaveProperty("runGroupId");
  });
});

describe("Chat Event Raw Event cursor contract", () => {
  it("allows only a cold start or a paired positive cursor", () => {
    const querySchema = chatThreadEventsContract.rows.query;
    expect(querySchema.safeParse({ sinceSeqId: 0 }).success).toBeTruthy();
    expect(
      querySchema.safeParse({
        sinceSeqId: 9,
        sinceEventId: "00000000-0000-4000-8000-000000000009",
      }).success,
    ).toBeTruthy();
    expect(querySchema.safeParse({ sinceSeqId: 9 }).success).toBeFalsy();
    expect(
      querySchema.safeParse({
        sinceSeqId: 0,
        sinceEventId: "00000000-0000-4000-8000-000000000009",
      }).success,
    ).toBeFalsy();
  });
});

describe("Chat Event versioned read contract", () => {
  it("requires the request version header and Snapshot terminal event ID", () => {
    expect(CURRENT_CHAT_EVENT_SCHEMA_VERSION).toBe(7);
    const headersSchema = chatThreadEventsContract.snapshot.headers;
    expect(
      headersSchema.safeParse({ authorization: "Bearer test" }).success,
    ).toBe(false);
    expect(
      headersSchema.safeParse({
        authorization: "Bearer test",
        [CHAT_EVENT_SCHEMA_VERSION_HEADER]:
          CURRENT_CHAT_EVENT_SCHEMA_VERSION.toString(),
      }).success,
    ).toBe(true);

    const snapshotResponse = {
      url: "https://example.com/snapshot.ndjson.gz",
      expiresInSeconds: 900,
      lastSeqId: 9,
    };
    expect(
      chatThreadEventsContract.snapshot.responses[200].safeParse(
        snapshotResponse,
      ).success,
    ).toBe(false);
    expect(
      chatThreadEventsContract.snapshot.responses[200].safeParse({
        ...snapshotResponse,
        lastEventId: "00000000-0000-4000-8000-000000000009",
      }).success,
    ).toBe(true);
  });
});

describe("canonical row projection preserves the public ChatEvent contract", () => {
  it("serializes and projects every event type from canonical fields", () => {
    expect(
      CHAT_EVENT_TYPES.map((eventType) => {
        const wireRow = JSON.parse(
          JSON.stringify(projectableRow(eventType)),
        ) as unknown;
        return chatEventFromRow(chatEventRowSchema.parse(wireRow)).eventType;
      }),
    ).toStrictEqual([...CHAT_EVENT_TYPES]);
  });

  it.each([
    "https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333",
    undefined,
  ])(
    "preserves Discord source links through raw-row serialization without exposing private context (%s)",
    (href) => {
      const source = {
        type: "source",
        kind: "discord",
        ...(href === undefined ? {} : { href }),
      };
      const row = canonicalRow({
        eventType: "input.prompt",
        contextType: "discord",
        contextId: "00000000-0000-4000-8000-000000000015",
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "Review this message" }, source],
          },
        },
      });
      const projected = chatEventFromRow(
        chatEventRowSchema.parse(JSON.parse(JSON.stringify(row))),
      );
      expect(projected).toMatchObject({
        eventType: "input.prompt",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Review this message" }, source],
        },
      });
      expect(projected).not.toHaveProperty("contextId");
      expect(projected).not.toHaveProperty("contextType");
    },
  );

  it("rejects private Discord launch fields in public source metadata", () => {
    const row = canonicalRow({
      eventType: "input.prompt",
      contextType: "discord",
      contextId: "00000000-0000-4000-8000-000000000015",
      payload: {
        userMessage: {
          version: 1,
          parts: [
            { type: "text", text: "Review this message" },
            {
              type: "source",
              kind: "discord",
              connectionId: "00000000-0000-4000-8000-000000000016",
              conversationContext: "Private channel history",
            },
          ],
        },
      },
    });
    expect(() => {
      return chatEventFromRow(row);
    }).toThrow();
  });

  it("emits the canonical interrupt run as interruptsRunId, never runId", () => {
    const target = "00000000-0000-4000-8000-000000000010";
    const projected = chatEventFromRow(
      canonicalRow({ eventType: "control.interrupt", runId: target }),
    );
    expect(projected).toMatchObject({
      eventType: "control.interrupt",
      interruptsRunId: target,
    });
    expect(projected.runId).toBeUndefined();
  });

  it("projects historical goal context rows without a run group", () => {
    const projected = chatEventFromRow(
      canonicalRow({
        payload: { content: "goal result" },
        contextType: "goal",
        contextId: "00000000-0000-4000-8000-000000000011",
      }),
    );
    expect(projected).toMatchObject({
      eventType: "output.message",
      content: "goal result",
    });
    expect(projected).not.toHaveProperty("runGroupId");
  });

  it("defensively hides citation envelopes from historical cached rows", () => {
    const projected = chatEventFromRow(
      canonicalRow({
        payload: {
          content:
            "visible<oai-mem-citation><citation_entries>private:1-1|note=[secret]</citation_entries></oai-mem-citation>",
        },
      }),
    );
    expect(projected).toMatchObject({
      eventType: "output.message",
      content: "visible",
    });
  });

  it("repeatedly projects historical literal examples without mutating rows or leaking private bodies", () => {
    const content = `explain \`${PI_MEMORY_CITATION_OPEN}\` suffix${PI_MEMORY_CITATION_OPEN}private path and note${PI_MEMORY_CITATION_CLOSE}`;
    const row = canonicalRow({ payload: { content } });
    const before = JSON.stringify(row);
    const expected = `explain \`&lt;${PI_MEMORY_CITATION_OPEN.slice(1, -1)}&gt;\` suffix`;
    let projected = chatEventFromRow(row);
    expect(projected.content).toBe(expected);
    for (let i = 0; i < 3; i++) {
      projected = chatEventFromRow(
        canonicalRow({ payload: { content: projected.content } }),
      );
      expect(projected.content).toBe(expected);
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("reads canonical usage and error payloads", () => {
    const usage = {
      version: 1,
      totalCredits: 1,
      settledAt: CREATED_AT,
      breakdown: [],
    };
    const runId = "00000000-0000-4000-8000-000000000013";
    const projected = chatEventFromRow(
      canonicalRow({
        eventType: "usage.recorded",
        runId,
        payload: { usage },
      }),
    );
    expect(projected).toMatchObject({
      eventType: "usage.recorded",
      runId,
      usage,
    });

    const failed = chatEventFromRow(
      canonicalRow({
        eventType: "run.failed",
        runId,
        payload: { content: "run failed", error: "runner error" },
      }),
    );
    expect(failed).toMatchObject({
      eventType: "run.failed",
      runId,
      content: "run failed",
      error: "runner error",
      runLifecycleEvent: "failed",
    });
  });

  it("accepts an optional V7 failure reason only on failed runs", () => {
    const runId = "00000000-0000-4000-8000-000000000013";
    const historical = chatEventFromRow(
      canonicalRow({
        eventType: "run.failed",
        runId,
        payload: { error: "historical runner error" },
      }),
    );
    expect(historical).not.toHaveProperty("failureReason");

    const withReason = chatEventFromRow(
      canonicalRow({
        eventType: "run.failed",
        runId,
        payload: { error: "provider unavailable" },
        failureReason: "future_reason",
      }),
    );
    expect(chatEventSchema.parse(withReason)).toMatchObject({
      eventType: "run.failed",
      runId,
      failureReason: "future_reason",
    });

    expect(
      chatEventRowSchema.safeParse({
        ...canonicalRow({}),
        failureReason: "future_reason",
      }).success,
    ).toBe(false);
  });
});
