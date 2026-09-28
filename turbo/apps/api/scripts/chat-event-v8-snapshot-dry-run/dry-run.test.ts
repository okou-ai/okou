import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  createDryRunTally,
  inspectSnapshotObject,
  recordInspection,
  renderDryRunMarkdown,
  summarizeDryRun,
} from "./dry-run";

// Chat Event V8 transition tests: removed with the dry run in PR-3.

const CREATED_AT = "2026-09-01T00:00:00.000Z";
const SENTINELS = [
  "SENTINEL-GOAL-BRIEF-7f3a",
  "SENTINEL-MESSAGE-TEXT-91c2",
  "SENTINEL-ASSISTANT-CONTENT-4be0",
  "SENTINEL-INVALID-JSON-d81f",
] as const;

function v7Row(
  threadId: string,
  seqId: number,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    id: randomUUID(),
    chatThreadId: threadId,
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

function snapshotObject(lines: readonly string[]): Buffer {
  return gzipSync(
    Buffer.from(
      lines
        .map((line) => {
          return `${line}\n`;
        })
        .join(""),
    ),
  );
}

function snapshotKey(threadId: string, lastSeqId: number): string {
  return `chat-events/${threadId}/${lastSeqId.toString()}-r1-${"a".repeat(64)}.ndjson.gz`;
}

function goalHistory(threadId: string): Buffer {
  const runId = randomUUID();
  return snapshotObject(
    [
      v7Row(threadId, 1, {
        eventType: "input.goal",
        contextType: "goal",
        contextId: randomUUID(),
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief: SENTINELS[0] }],
          },
        },
      }),
      v7Row(threadId, 2, {
        eventType: "input.prompt",
        runId,
        contextType: "goal",
        contextId: randomUUID(),
        payload: {
          userMessage: {
            version: 1,
            parts: [{ type: "goal", goalBrief: SENTINELS[0] }],
          },
        },
      }),
      v7Row(threadId, 3, {
        eventType: "output.message",
        runId,
        contextType: "goal",
        contextId: randomUUID(),
        payload: { content: SENTINELS[2] },
      }),
      v7Row(threadId, 4, { eventType: "browser.close" }),
    ].map((row) => {
      return JSON.stringify(row);
    }),
  );
}

describe("Chat Event V7 -> V8 Snapshot dry run", () => {
  it("upgrades a V7 object with retired rows and Goal context", () => {
    const threadId = randomUUID();

    expect(
      inspectSnapshotObject(snapshotKey(threadId, 4), goalHistory(threadId)),
    ).toStrictEqual({
      kind: "upgraded",
      threadId,
      rowsIn: 4,
      rowsOut: 2,
      changed: true,
    });
  });

  it("reports an object whose rows do not upgrade", () => {
    const threadId = randomUUID();
    const body = snapshotObject([
      JSON.stringify(
        v7Row(threadId, 1, {
          eventType: "input.prompt",
          contextType: "morning_brief",
          payload: {
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: SENTINELS[1] }],
            },
          },
        }),
      ),
    ]);

    expect(inspectSnapshotObject(snapshotKey(threadId, 1), body)).toMatchObject(
      {
        kind: "failed",
        threadId,
        failure: { path: "contextType" },
      },
    );
  });

  it("keeps row content out of the summary", () => {
    const tally = createDryRunTally();
    const upgradedThread = randomUUID();
    const schemaThread = randomUUID();
    const jsonThread = randomUUID();
    const objects = [
      [snapshotKey(upgradedThread, 4), goalHistory(upgradedThread)],
      [
        snapshotKey(schemaThread, 1),
        snapshotObject([
          JSON.stringify(
            v7Row(schemaThread, 1, {
              eventType: "input.prompt",
              contextType: "morning_brief",
              payload: {
                userMessage: {
                  version: 1,
                  parts: [{ type: "goal", goalBrief: SENTINELS[0] }],
                },
                content: SENTINELS[2],
              },
            }),
          ),
        ]),
      ],
      [
        snapshotKey(jsonThread, 1),
        snapshotObject([`{"content":"${SENTINELS[3]}"`]),
      ],
    ] as const;
    tally.objectsListed = objects.length;
    for (const [key, body] of objects) {
      recordInspection(tally, key, inspectSnapshotObject(key, body));
    }
    const summary = summarizeDryRun(tally, {
      startedAt: CREATED_AT,
      finishedAt: CREATED_AT,
    });
    const rendered = `${JSON.stringify(summary)}\n${renderDryRunMarkdown(summary)}`;

    expect(summary).toMatchObject({
      objectsChecked: 3,
      succeeded: 1,
      failed: 2,
    });
    expect(
      summary.failureGroups.flatMap((group) => {
        return group.examples.map((example) => {
          return example.threadId;
        });
      }),
    ).toStrictEqual(expect.arrayContaining([schemaThread, jsonThread]));
    for (const sentinel of SENTINELS) {
      expect(rendered).not.toContain(sentinel);
    }
  });
});
