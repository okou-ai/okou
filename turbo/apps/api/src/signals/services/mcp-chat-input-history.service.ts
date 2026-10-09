import type { ChatEventRow } from "@okouai/api-contracts/contracts/chat-event-rows";
import type { McpGetChatInputInput } from "@okouai/api-contracts/contracts/mcp-chat-input";
import { command } from "ccstate";
import { createReadOnlyQueryCommand } from "../external/db";
import { awaitWithSignal, settleIncludingAbort } from "../utils";
import {
  addHistorySize,
  historyReadFailure,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_ROWS,
  McpMessageHistoryError,
  type HistoryBudget,
} from "./mcp-chat-message-history.service";
import {
  inputHistoryQueryRowSchema,
  unarchivedInputHistoryQuery,
} from "./mcp-chat-input-history.query";

type InputHistorySelection =
  | { readonly kind: "canonical" }
  | {
      readonly kind: "selected";
      readonly rows: readonly ChatEventRow[] | null;
    };

const readInputSnapshot$ = createReadOnlyQueryCommand(
  inputHistoryQueryRowSchema,
  3000,
);

/**
 * One business statement proves no archive and captures complete relevant facts.
 * Retention requires archive coverage; any archive or origin miss still needs
 * canonical authority because retained caller-owned UUIDs can be reused.
 */
export const readUnarchivedMcpChatInput$ = command(
  async (
    { set },
    principal: { readonly userId: string; readonly orgId: string },
    input: McpGetChatInputInput,
    budget: HistoryBudget,
    signal: AbortSignal,
  ): Promise<InputHistorySelection> => {
    budget.check();
    const result = await settleIncludingAbort(
      awaitWithSignal(
        set(
          readInputSnapshot$,
          unarchivedInputHistoryQuery(principal, input, {
            bytes: MAX_HISTORY_BYTES - budget.bytes,
            rows: MAX_HISTORY_ROWS - budget.rows,
          }),
          signal,
        ),
        signal,
      ),
    );
    signal.throwIfAborted();
    budget.check();
    if (!result.ok) {
      throw historyReadFailure(result.error);
    }
    const [snapshot] = result.value;
    if (snapshot === undefined) {
      throw new McpMessageHistoryError(
        "history_unavailable",
        "Chat input snapshot is unavailable.",
      );
    }
    switch (snapshot.kind) {
      case "canonical": {
        return { kind: "canonical" };
      }
      case "not_found": {
        return { kind: "selected", rows: null };
      }
      case "history_limit": {
        throw new McpMessageHistoryError(
          "history_limit",
          "Chat history exceeds the 32 MiB or 50,000 event read limit.",
        );
      }
      case "history_unavailable": {
        throw new McpMessageHistoryError(
          "history_unavailable",
          "Chat input origin or replacement chain cannot be resolved completely.",
        );
      }
      case "selected": {
        addHistorySize(budget, snapshot.bytes, snapshot.rows);
        if (snapshot.events.length !== snapshot.rows) {
          throw new McpMessageHistoryError(
            "history_unavailable",
            "Chat input facts are incomplete inside their statement snapshot.",
          );
        }
        return { kind: "selected", rows: snapshot.events };
      }
    }
  },
);
