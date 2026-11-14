import type { ChatShareSelection } from "@okouai/api-contracts/contracts/chat-share-selection-types";
import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import { command } from "ccstate";
import {
  canonicalArchivedChatEventContent,
  canonicalArchivedChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { projectUserMessageForPublicShare } from "./chat-user-message.service";
import { readSharedThreadChatEventHistory$ } from "./chat-event-history.service";
import { ownsSharedThreadSource$ } from "./shared-thread.service";

interface ShareTurn {
  prompts: string[];
  answer?: ChatEventRow;
  complete: boolean;
}

interface SelectionProjection {
  messages: ChatShareSelection["messages"];
  turns: ShareTurn[];
  byRun: Map<string, ShareTurn>;
  current?: ShareTurn;
}

function appendPrompt(
  projection: SelectionProjection,
  row: ChatEventRow,
): void {
  if (row.runId === null) {
    return;
  }
  const document = canonicalArchivedChatEventUserMessage(row);
  if (
    !document ||
    (!projectUserMessageForPublicShare(document).trim() &&
      !document.parts.some((part) => {
        return part.type === "file";
      }))
  ) {
    return;
  }
  if (
    !projection.current ||
    projection.current.answer ||
    projection.current.complete
  ) {
    if (projection.current?.answer) {
      projection.current.complete = true;
    }
    projection.current = { prompts: [], complete: false };
    projection.turns.push(projection.current);
  }
  projection.current.prompts.push(row.id);
  projection.byRun.set(row.runId, projection.current);
  projection.messages.push({
    eventId: row.id,
    role: "user",
    turnEventIds: [row.id],
  });
}

function appendAnswer(
  projection: SelectionProjection,
  row: ChatEventRow,
): void {
  if (!canonicalArchivedChatEventContent(row)?.trim()) {
    return;
  }
  let turn =
    row.runId === null
      ? projection.current?.answer?.runId === null ||
        !projection.current?.answer
        ? projection.current
        : undefined
      : projection.byRun.get(row.runId);
  if (!turn) {
    turn = { prompts: [], complete: row.runId === null };
    projection.turns.push(turn);
    if (row.runId !== null) {
      projection.byRun.set(row.runId, turn);
    }
  }
  turn.answer = row;
  if (row.runId === null) {
    turn.complete = true;
  }
  projection.current = turn;
}

function finishTurn(projection: SelectionProjection, row: ChatEventRow): void {
  const turn = row.runId === null ? undefined : projection.byRun.get(row.runId);
  if (!turn) {
    return;
  }
  if (row.eventType !== "run.completed") {
    turn.answer = undefined;
  }
  turn.complete = true;
}

/** Selection identity follows confirmed events, never a client's render groups. */
function projectSelection(
  history: readonly ChatEventRow[],
): ChatShareSelection {
  const revoked = new Set(
    history.flatMap((row) => {
      return row.revokesEventId ? [row.revokesEventId] : [];
    }),
  );
  const projection: SelectionProjection = {
    messages: [],
    turns: [],
    byRun: new Map(),
  };
  for (const row of history) {
    if (revoked.has(row.id)) {
      continue;
    }
    switch (row.eventType) {
      case "input.prompt":
      case "input.automation": {
        appendPrompt(projection, row);
        break;
      }
      case "output.message": {
        appendAnswer(projection, row);
        break;
      }
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
      case "output.error": {
        finishTurn(projection, row);
        break;
      }
    }
  }
  for (const turn of projection.turns) {
    if (turn.answer && turn.complete) {
      projection.messages.push({
        eventId: turn.answer.id,
        role: "assistant",
        turnEventIds: [...turn.prompts, turn.answer.id],
      });
    }
  }
  const order = new Map(
    history.map((row, index) => {
      return [row.id, index];
    }),
  );
  projection.messages.sort((a, b) => {
    return (order.get(a.eventId) ?? 0) - (order.get(b.eventId) ?? 0);
  });
  return { messages: projection.messages };
}

export const readChatShareSelection$ = command(
  async (
    { set },
    source: { orgId: string; userId: string; threadId: string },
    signal: AbortSignal,
  ): Promise<ChatShareSelection | null> => {
    if (!(await set(ownsSharedThreadSource$, source, signal))) {
      return null;
    }
    const history = await set(
      readSharedThreadChatEventHistory$,
      source.threadId,
      signal,
    );
    return projectSelection(history);
  },
);
