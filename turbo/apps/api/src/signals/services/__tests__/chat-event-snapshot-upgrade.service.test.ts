import { randomUUID } from "node:crypto";

import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { describe, expect, it } from "vitest";

import {
  PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
  upgradeChatEventSnapshotBody,
} from "../chat-event-snapshot-upgrade.service";

// Chat Event V8 transition tests: removed with the V7 -> V8 Snapshot upgrade
// in PR-3 once every Snapshot pointer is V8.

const THREAD_ID = randomUUID();
const CREATED_AT = "2026-09-01T00:00:00.000Z";

type V7Row = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly seqId: number;
};

function v7Row(
  seqId: number,
  fields: Readonly<Record<string, unknown>>,
): V7Row {
  return {
    id: randomUUID(),
    chatThreadId: THREAD_ID,
    runId: null,
    revokesEventId: null,
    contextType: null,
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    seqId,
    createdAt: CREATED_AT,
    payload: null,
    ...fields,
  };
}

function v7Body(rows: readonly V7Row[]): Buffer {
  return Buffer.from(
    rows
      .map((row) => {
        return `${JSON.stringify(row)}\n`;
      })
      .join(""),
  );
}

function upgradeV7(rows: readonly V7Row[]) {
  return upgradeChatEventSnapshotBody(
    v7Body(rows),
    PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
  );
}

function textMessage(text: string) {
  return { version: 1, parts: [{ type: "text", text }] };
}

describe("V7 -> V8 Chat Event Snapshot upgrade", () => {
  const runId = randomUUID();
  const deletedRows: readonly V7Row[] = [
    v7Row(2, {
      eventType: "input.goal",
      contextType: "goal",
      contextId: randomUUID(),
      payload: {
        userMessage: {
          version: 1,
          parts: [{ type: "goal", goalBrief: "Ship the report" }],
        },
      },
    }),
    v7Row(3, {
      eventType: "goal.open",
      contextType: "goal",
      contextId: randomUUID(),
    }),
    v7Row(4, {
      eventType: "goal.close",
      contextType: "goal",
      contextId: randomUUID(),
    }),
    v7Row(5, { eventType: "run.queued", runId }),
    v7Row(6, { eventType: "run.dequeued", runId }),
    v7Row(7, {
      eventType: "output.thinking",
      runId,
      payload: { content: "reasoning" },
    }),
    v7Row(8, { eventType: "browser.open", payload: { content: "opened" } }),
    v7Row(9, { eventType: "browser.close" }),
  ];

  it.each(
    deletedRows.map((row) => {
      return [row.eventType, row] as const;
    }),
  )("deletes %s rows", (_eventType, deleted) => {
    const kept = v7Row(1, {
      eventType: "output.message",
      runId,
      payload: { content: "kept" },
    });
    const upgraded = upgradeV7([kept, deleted]);

    expect(upgraded.rows).toStrictEqual([kept]);
    // The source terminal still pairs with the V7 pointer's cursor.
    expect(upgraded.sourceTerminal).toStrictEqual({
      id: deleted.id,
      seqId: deleted.seqId,
    });
  });

  it("turns Goal input rows into automation input with text parts", () => {
    const goalId = randomUUID();
    const prompt = v7Row(1, {
      eventType: "input.prompt",
      runId,
      contextType: "goal",
      contextId: goalId,
      payload: {
        userMessage: {
          version: 1,
          parts: [
            { type: "goal", goalBrief: "Ship the weekly report" },
            { type: "text", text: "continue" },
          ],
        },
      },
    });
    const rejected = v7Row(2, {
      eventType: "input.rejected",
      contextType: "goal",
      contextId: goalId,
      payload: {
        userMessage: {
          version: 1,
          parts: [{ type: "goal", goalBrief: "Ship the weekly report" }],
        },
        error: "Insufficient credits",
      },
    });
    const revoke = v7Row(3, {
      eventType: "control.revoke",
      contextType: "goal",
      contextId: goalId,
      revokesEventId: rejected.id,
    });

    const upgraded = upgradeV7([prompt, rejected, revoke]);

    expect(upgraded.rows).toStrictEqual([
      {
        ...prompt,
        contextType: "automation",
        contextId: null,
        payload: {
          userMessage: {
            version: 1,
            parts: [
              { type: "text", text: "Ship the weekly report" },
              { type: "text", text: "continue" },
            ],
          },
        },
      },
      {
        ...rejected,
        contextType: "automation",
        contextId: null,
        payload: {
          userMessage: textMessage("Ship the weekly report"),
          error: "Insufficient credits",
        },
      },
      { ...revoke, contextType: "automation", contextId: null },
    ]);
    for (const row of upgraded.rows) {
      expect(chatEventFromRow(row).id).toBe(row.id);
    }
  });

  it("clears the context of Goal output rows", () => {
    const goalId = randomUUID();
    const rows = [
      v7Row(1, {
        eventType: "output.message",
        runId,
        contextType: "goal",
        contextId: goalId,
        payload: { content: "Goal progress" },
      }),
      v7Row(2, {
        eventType: "run.completed",
        runId,
        contextType: "goal",
        contextId: goalId,
      }),
    ];

    expect(upgradeV7(rows).rows).toStrictEqual(
      rows.map((row) => {
        return { ...row, contextType: null, contextId: null };
      }),
    );
  });

  it("turns GitHub rows into web rows", () => {
    const rows = [
      v7Row(1, {
        eventType: "input.prompt",
        contextType: "github",
        contextId: randomUUID(),
        payload: { userMessage: textMessage("Review this PR") },
      }),
      v7Row(2, {
        eventType: "output.message",
        runId,
        contextType: "github",
        contextId: randomUUID(),
        payload: { content: "Reviewed" },
      }),
    ];

    expect(upgradeV7(rows).rows).toStrictEqual(
      rows.map((row) => {
        return { ...row, contextType: "web", contextId: null };
      }),
    );
  });

  it("keeps the retired Goal notice and ordinary rows unchanged", () => {
    const notice = v7Row(1, {
      eventType: "output.message",
      payload: {
        content: `Okou Goal retired.\nGoal ID: ${randomUUID()}\nOriginal recorded status: active\nRetirement changed this Goal from active to paused; this does not mark the objective complete.\n\nFull original objective:\nShip the weekly report`,
      },
    });
    const prompt = v7Row(2, {
      eventType: "input.prompt",
      runId,
      contextType: "slack",
      contextId: randomUUID(),
      payload: { userMessage: textMessage("hello") },
    });
    const body = v7Body([notice, prompt]);

    const upgraded = upgradeChatEventSnapshotBody(
      body,
      PREVIOUS_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSION,
    );

    expect(upgraded.rows).toStrictEqual([notice, prompt]);
    expect(
      upgraded.body
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => {
          return JSON.parse(line) as unknown;
        }),
    ).toStrictEqual([notice, prompt]);
  });

  it("returns a current-version body unchanged", () => {
    const body = v7Body([
      v7Row(1, {
        eventType: "output.message",
        payload: { content: "current" },
      }),
    ]);

    expect(
      upgradeChatEventSnapshotBody(body, CURRENT_CHAT_EVENT_SCHEMA_VERSION)
        .body,
    ).toBe(body);
  });

  it("fails without an adjacent upgrade for older versions", () => {
    expect(() => {
      upgradeChatEventSnapshotBody(Buffer.alloc(0), 6);
    }).toThrow("Missing Chat Event Snapshot upgrade from V6 to V7");
  });
});
