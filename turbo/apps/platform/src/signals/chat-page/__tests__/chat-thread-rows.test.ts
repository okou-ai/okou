import { computed, state } from "ccstate";
import { expect, test } from "vitest";

import { testContext } from "../../__tests__/test-helpers.ts";
import type { ChatEventGroup, EnrichedChatEvent } from "../chat-event.ts";
import { createChatThreadRows } from "../chat-thread-rows.ts";
import type { ThreadScrollPosition } from "../chat-thread-scroll.ts";

const context = testContext();

const THREAD_ID = "b0000000-0000-4000-a000-000000000a01";
const FIRST_RUN_ID = "d0000000-0000-4000-a000-000000000a11";
const SECOND_RUN_ID = "d0000000-0000-4000-a000-000000000a12";

function promptEvent(
  id: string,
  runId: string,
  seqId: number,
): EnrichedChatEvent {
  return {
    id,
    threadId: THREAD_ID,
    eventType: "input.prompt",
    content: null,
    runId,
    seqId,
    createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
    userMessage: {
      version: 1,
      parts: [{ type: "text", text: `Prompt ${id}` }],
    },
    tree: undefined,
    isQueued: false,
    inputCreatedAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
    inputOriginId: id,
    userMessageRenderDocument: undefined,
  };
}

function outputEvent(
  id: string,
  runId: string,
  seqId: number,
  content: string,
): EnrichedChatEvent {
  return {
    id,
    threadId: THREAD_ID,
    eventType: "output.message",
    content,
    runId,
    seqId,
    createdAt: `2026-08-01T10:00:0${String(seqId)}.000Z`,
    tree: undefined,
    isQueued: false,
    userMessageRenderDocument: undefined,
  };
}

// Every recomputation of the transcript allocates new event and group objects,
// as the render window does for every event change.
function transcript(
  events: readonly EnrichedChatEvent[],
): readonly ChatEventGroup[] {
  return events.map((event) => {
    return {
      beginEventId: event.id,
      role: event.eventType === "input.prompt" ? "user" : "assistant",
      events: [{ ...event }],
    };
  });
}

function setupRows(events: readonly EnrichedChatEvent[]) {
  const groups$ = state(transcript(events));
  const position$ = state<ThreadScrollPosition | null>(null);
  const rows = createChatThreadRows({
    renderedGroups$: computed((get) => {
      return get(groups$);
    }),
    threadScrollPosition$: computed((get) => {
      return get(position$);
    }),
  });
  context.store.set(rows.syncVisibleRows$);
  return {
    rows,
    replaceTranscript: (next: readonly EnrichedChatEvent[]) => {
      context.store.set(groups$, transcript(next));
      context.store.set(rows.syncVisibleRows$);
    },
  };
}

// The store keeps persisted events, so each recomputation spreads the same
// event objects into new transcript objects.
function persistedEvents() {
  return {
    firstTurn: [
      promptEvent("prompt-1", FIRST_RUN_ID, 1),
      outputEvent("output-1", FIRST_RUN_ID, 2, "First answer"),
    ],
    secondPrompt: promptEvent("prompt-2", SECOND_RUN_ID, 3),
  };
}

test("Streaming into the latest turn changes only that row", () => {
  const { firstTurn, secondPrompt } = persistedEvents();
  const { rows, replaceTranscript } = setupRows([
    ...firstTurn,
    secondPrompt,
    outputEvent("output-2", SECOND_RUN_ID, 4, "Second"),
  ]);
  const visibleRows = context.store.get(rows.visibleRows$);
  const models = visibleRows.map((row) => {
    return context.store.get(row.model$);
  });
  expect(models).toHaveLength(4);

  replaceTranscript([
    ...firstTurn,
    secondPrompt,
    outputEvent("output-2", SECOND_RUN_ID, 4, "Second answer"),
  ]);

  expect(context.store.get(rows.visibleRows$)).toBe(visibleRows);
  const [firstPrompt, firstAnswer, nextPrompt, streamingAnswer] =
    visibleRows.map((row) => {
      return context.store.get(row.model$);
    });
  expect(firstPrompt).toBe(models[0]);
  expect(firstAnswer).toBe(models[1]);
  expect(nextPrompt).toBe(models[2]);
  expect(streamingAnswer).not.toBe(models[3]);
  expect(streamingAnswer?.group.events[0]?.content).toBe("Second answer");
});

test("A new turn adds a row and keeps the existing rows", () => {
  const { firstTurn, secondPrompt } = persistedEvents();
  const { rows, replaceTranscript } = setupRows(firstTurn);
  const visibleRows = context.store.get(rows.visibleRows$);
  const [promptModel, answerModel] = visibleRows.map((row) => {
    return context.store.get(row.model$);
  });

  replaceTranscript([...firstTurn, secondPrompt]);

  const nextRows = context.store.get(rows.visibleRows$);
  expect(nextRows).toHaveLength(3);
  expect(nextRows[0]).toBe(visibleRows[0]);
  expect(nextRows[1]).toBe(visibleRows[1]);
  expect(context.store.get(nextRows[0]!.model$)).toBe(promptModel);
  // The next prompt ends the previous run's work and takes its status row.
  const nextAnswerModel = context.store.get(nextRows[1]!.model$);
  expect(nextAnswerModel).not.toBe(answerModel);
  expect(nextAnswerModel.holdsStatusRow).toBeFalsy();
  expect(nextAnswerModel.group).toBe(answerModel?.group);
});
