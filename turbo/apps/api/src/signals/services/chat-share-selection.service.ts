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

/** Selection identity follows confirmed events, never a client's render groups. */
function projectSelection(
  history: readonly ChatEventRow[],
): ChatShareSelection {
  const revoked = new Set(
    history.flatMap((row) => {
      return row.revokesEventId ? [row.revokesEventId] : [];
    }),
  );
  const messages: ChatShareSelection["messages"] = [];
  interface Turn {
    prompts: string[];
    answer?: ChatEventRow;
    complete: boolean;
  }
  const turns: Turn[] = [];
  const byRun = new Map<string, Turn>();
  let current: Turn | undefined;
  for (const row of history) {
    if (revoked.has(row.id)) continue;
    if (
      row.eventType === "input.prompt" ||
      row.eventType === "input.automation"
    ) {
      if (row.runId === null) continue;
      const document = canonicalArchivedChatEventUserMessage(row);
      if (
        !document ||
        (!projectUserMessageForPublicShare(document).trim() &&
          !document.parts.some((part) => {
            return part.type === "file";
          }))
      )
        continue;
      if (!current || current.answer || current.complete) {
        if (current?.answer) current.complete = true;
        current = { prompts: [], complete: false };
        turns.push(current);
      }
      current.prompts.push(row.id);
      byRun.set(row.runId, current);
      messages.push({ eventId: row.id, role: "user", turnEventIds: [row.id] });
    } else if (row.eventType === "output.message") {
      if (!canonicalArchivedChatEventContent(row)?.trim()) continue;
      let turn =
        row.runId === null
          ? current?.answer?.runId === null || !current?.answer
            ? current
            : undefined
          : byRun.get(row.runId);
      if (!turn) {
        turn = { prompts: [], complete: row.runId === null };
        turns.push(turn);
        if (row.runId !== null) byRun.set(row.runId, turn);
      }
      turn.answer = row;
      if (row.runId === null) turn.complete = true;
      current = turn;
    } else if (row.eventType === "run.completed") {
      const turn = row.runId === null ? undefined : byRun.get(row.runId);
      if (turn) turn.complete = true;
    } else if (
      row.eventType === "run.failed" ||
      row.eventType === "run.cancelled" ||
      row.eventType === "output.error"
    ) {
      const turn = row.runId === null ? undefined : byRun.get(row.runId);
      if (turn) {
        turn.answer = undefined;
        turn.complete = true;
      }
    }
  }
  for (const turn of turns) {
    if (turn.answer && turn.complete) {
      messages.push({
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
  messages.sort((a, b) => {
    return (order.get(a.eventId) ?? 0) - (order.get(b.eventId) ?? 0);
  });
  return { messages };
}

export const readChatShareSelection$ = command(
  async (
    { set },
    source: { orgId: string; userId: string; threadId: string },
    signal: AbortSignal,
  ): Promise<ChatShareSelection | null> => {
    if (!(await set(ownsSharedThreadSource$, source, signal))) return null;
    const history = await set(
      readSharedThreadChatEventHistory$,
      source.threadId,
      signal,
    );
    return projectSelection(history);
  },
);
