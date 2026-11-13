import { chatEventFromRow } from "../contracts/chat-event-row-projection";
import {
  chatEventRowSchema,
  type ChatEventRow,
} from "../contracts/chat-event-rows";
import {
  groupSemanticChatEvents,
  semanticChatEventsFromChatEvents,
} from "../contracts/chat-event-semantics";
import {
  CHAT_EVENT_TYPES,
  isChatRunTerminalEventType,
} from "../contracts/chat-events";
import { deriveServerRunStateFromChatEvents } from "../contracts/chat-run-state";

const threadId = "11111111-1111-4111-8111-111111111111";
const runA = "99999999-9999-4999-8999-999999999999";
const runB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userMessage = (text: string) => {
  return {
    userMessage: { version: 1, parts: [{ type: "text", text }] },
  };
};

function row(
  id: string,
  eventType: ChatEventRow["eventType"],
  runId: string | null,
  payload: ChatEventRow["payload"] = null,
  revokesEventId: string | null = null,
): ChatEventRow {
  return chatEventRowSchema.parse({
    id,
    eventType,
    runId,
    payload,
    revokesEventId,
    seqId: 1,
    chatThreadId: threadId,
    contextType: eventType === "input.budget" ? "agent_run" : "web",
    contextId: null,
    runEventSequenceNumber: null,
    runEventId: null,
    // Deliberate ties: canonical order must not be replaced by timestamp/ID sorting.
    createdAt: "2026-11-13T00:00:00.000Z",
  });
}

const prompt = (id: string, run: string | null = runA) => {
  return row(id, "input.prompt", run, userMessage(id));
};
const automation = (id: string) => {
  return row(id, "input.automation", null, userMessage(id));
};
const reply = (id: string, run: string | null = runA) => {
  return row(id, "output.message", run, { content: "Reply 含中文 🐈" });
};
const completed = (id: string, run = runA) => {
  return row(id, "run.completed", run);
};

/** Ordered inputs, not independently authored expected native outcomes. */
const histories: Readonly<Record<string, readonly ChatEventRow[]>> = {
  empty: [],
  "pending-manual-and-automation": [
    prompt("manual", null),
    reply("reply"),
    automation("z-earlier"),
    automation("a-later"),
  ],
  "automation-delivery-and-budget": [
    automation("scheduled"),
    row(
      "delivered",
      "input.prompt",
      runA,
      userMessage("Scheduled work"),
      "scheduled",
    ),
    row("budget", "input.budget", runA, userMessage("Internal warning")),
    reply("reply"),
    completed("completed"),
  ],
  "manual-rejection": [
    prompt("pending", null),
    row(
      "rejected",
      "input.rejected",
      null,
      { ...userMessage("Request"), error: "Not admitted" },
      "pending",
    ),
  ],
  "automation-rejection": [
    automation("scheduled"),
    row(
      "rejected",
      "input.rejected",
      null,
      { ...userMessage("Scheduled work"), error: "Not admitted" },
      "scheduled",
    ),
    row("public-error", "output.error", null, {
      error: "Automation unavailable",
    }),
  ],
  "recalled-input-and-followups": [
    prompt("pending", null),
    row("recall", "control.revoke", null, null, "pending"),
    prompt("request"),
    row("followups", "output.followups", runA, { content: "Next steps" }),
    row("revoke-followups", "control.revoke", null, null, "followups"),
    completed("completed"),
  ],
  "replacement-chain": [
    automation("scheduled"),
    row(
      "delivered",
      "input.prompt",
      runA,
      userMessage("First delivery"),
      "scheduled",
    ),
    row(
      "redelivered",
      "input.prompt",
      runB,
      userMessage("Second delivery"),
      "delivered",
    ),
    reply("reply", runB),
    completed("completed", runB),
  ],
  "interrupt-before-terminal": [
    prompt("request"),
    reply("partial"),
    row("interrupt", "control.interrupt", runA),
    row("cancelled", "run.cancelled", runA, {
      error: "Original cancellation detail",
    }),
  ],
  "terminal-before-interrupt": [
    prompt("request"),
    reply("reply"),
    completed("completed"),
    row("interrupt", "control.interrupt", runA),
  ],
  "interrupt-late-output-and-terminal": [
    prompt("request"),
    reply("partial"),
    row("interrupt", "control.interrupt", runA),
    reply("late-output"),
    row("cancelled", "run.cancelled", runA, {
      error: "Original cancellation detail",
    }),
  ],
  "newer-running-older-terminal": [
    prompt("older"),
    prompt("newer", runB),
    completed("older-completed"),
    reply("newer-reply", runB),
    completed("newer-completed", runB),
  ],
  "newer-ended-older-activity": [
    prompt("older"),
    prompt("newer", runB),
    completed("newer-completed", runB),
    reply("older-late-reply"),
    row("usage", "usage.recorded", runA, { usage: { inputTokens: 42 } }),
    completed("older-completed"),
  ],
  "newer-failed-older-late-terminal": [
    prompt("older"),
    prompt("newer", runB),
    row("newer-failed", "run.failed", runB, { error: "Run failed" }),
    completed("older-completed"),
  ],
  "metadata-and-followups": [
    prompt("request"),
    reply("reply"),
    row("followups", "output.followups", runA, { content: "Next steps" }),
    row("usage", "usage.recorded", runA, { usage: { inputTokens: 42 } }),
    completed("completed"),
  ],
  "runless-error-and-pending-input": [
    prompt("request"),
    row("error", "output.error", null, { error: "Delivery failed" }),
    prompt("pending", null),
  ],
};

function expected(rows: readonly ChatEventRow[]) {
  const events = rows.map(chatEventFromRow);
  const semantic = semanticChatEventsFromChatEvents(events);
  const ordered = groupSemanticChatEvents(semantic).allGroups.flatMap(
    (group) => {
      return group.events;
    },
  );
  const state = deriveServerRunStateFromChatEvents(events);
  const terminal = [...ordered].reverse().find(({ event }) => {
    return isChatRunTerminalEventType(event.eventType);
  });
  return {
    // Visible identity and order come directly from Web, including synthetic interruption.
    events: ordered.map(({ event, isQueued }) => {
      return {
        id: event.id,
        type: event.eventType,
        queued: isQueued,
      };
    }),
    execution:
      state ??
      (terminal ? terminal.event.eventType.replace("run.", "") : "idle"),
    workSteps: semantic.filter(({ event }) => {
      return event.eventType === "output.message";
    }).length,
  };
}

/** Generated from the same pure implementations Web actually consumes; drift is a CI failure. */
export function kotlinHistorySemanticsFixtureJson(): string {
  const covered = new Set(
    Object.values(histories).flatMap((rows) => {
      return rows.map((event) => {
        return event.eventType;
      });
    }),
  );
  const missing = CHAT_EVENT_TYPES.filter((type) => {
    return !covered.has(type);
  });
  if (missing.length > 0)
    throw new Error(
      `Missing native history conformance scenarios: ${missing.join(", ")}`,
    );
  return (
    JSON.stringify(
      {
        threadId,
        histories: Object.entries(histories).map(([name, history]) => {
          const rows = history.map((event, index) => {
            return chatEventRowSchema.parse({ ...event, seqId: index * 7 + 1 });
          });
          return {
            name,
            rows,
            checkpoints: Array.from(
              { length: rows.length + 1 },
              (_, length) => {
                return {
                  length,
                  expected: expected(rows.slice(0, length)),
                };
              },
            ),
          };
        }),
      },
      null,
      2,
    ) + "\n"
  );
}
