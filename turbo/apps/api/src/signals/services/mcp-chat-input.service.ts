import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { isChatInputEventType } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatEvent } from "@okouai/api-contracts/contracts/chat-threads";
import type {
  McpChatInputReadError,
  McpChatInputReadResult,
  McpGetChatInputInput,
  McpGetChatInputOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-input";
import { formatMcpChatTimestamp } from "@okouai/api-contracts/contracts/mcp-chat-time";
import { command } from "ccstate";
import { awaitWithSignal, settle } from "../utils";
import {
  createMcpChatHistoryBudget,
  McpMessageHistoryError,
  readMcpChatMessageHistory$,
} from "./mcp-chat-message-history.service";
import { readUnarchivedMcpChatInput$ } from "./mcp-chat-input-history.service";
import { nativeRunStatus } from "./native-run-status.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}
type PublicInput = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.rejected" }
>;
interface CanonicalInput {
  readonly original: PublicInput;
  readonly current:
    | PublicInput
    | Extract<ChatEvent, { eventType: "control.revoke" }>;
}
type CanonicalInputResult =
  | { readonly kind: "ok"; readonly data: CanonicalInput }
  | McpChatInputReadError;

function unavailableHistory(message: string): never {
  throw new McpMessageHistoryError("history_unavailable", message);
}

function inputSuccessor(
  current: CanonicalInput["current"],
  successor: ChatEvent,
): CanonicalInput["current"] {
  if (
    successor.seqId <= current.seqId ||
    current.eventType === "control.revoke" ||
    (current.runId !== undefined && successor.runId !== current.runId) ||
    (successor.eventType !== "input.prompt" &&
      successor.eventType !== "input.rejected" &&
      successor.eventType !== "control.revoke")
  ) {
    unavailableHistory("Chat input replacement chain is invalid.");
  }
  return successor;
}

/** Resolve canonical successors before visibility filtering, including recalls. */
function resolveInput(
  events: readonly ChatEvent[],
  eventId: string,
  checkBudget: () => void,
): CanonicalInput | null {
  const byId = new Map<string, ChatEvent>();
  const successorById = new Map<string, ChatEvent>();
  for (const event of events) {
    checkBudget();
    byId.set(event.id, event);
    if (event.revokesEventId !== undefined) {
      if (successorById.has(event.revokesEventId)) {
        unavailableHistory("Chat input has competing canonical replacements.");
      }
      successorById.set(event.revokesEventId, event);
    }
  }
  const original = byId.get(eventId);
  if (!original) {
    if (successorById.has(eventId)) {
      unavailableHistory(
        "Chat input origin is missing from canonical history.",
      );
    }
    return null;
  }
  if (
    original.eventType !== "input.prompt" &&
    original.eventType !== "input.rejected"
  ) {
    return null;
  }
  const predecessor = original.revokesEventId
    ? byId.get(original.revokesEventId)
    : undefined;
  if (original.revokesEventId !== undefined && !predecessor) {
    unavailableHistory("Chat input origin cannot be resolved completely.");
  }
  // Recommended-followup sources are not inputs; their new prompt is an origin.
  if (predecessor && isChatInputEventType(predecessor.eventType)) {
    return null;
  }
  let current: CanonicalInput["current"] = original;
  for (;;) {
    checkBudget();
    const successor = successorById.get(current.id);
    if (!successor) {
      if (
        current.eventType === "input.rejected" &&
        current.runId !== undefined
      ) {
        unavailableHistory(
          "Rejected chat input has an unexpected consuming Run.",
        );
      }
      return { original, current };
    }
    current = inputSuccessor(current, successor);
  }
}

/** Shared by observation and recall; no hot-row miss is treated as absence. */
export const readCanonicalMcpChatInput$ = command(
  async (
    { set },
    principal: Principal,
    input: McpGetChatInputInput,
    signal: AbortSignal,
  ): Promise<CanonicalInputResult> => {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const budget = createMcpChatHistoryBudget(operationSignal);
    const result = await settle(
      (async (): Promise<CanonicalInputResult> => {
        const selected = await set(
          readUnarchivedMcpChatInput$,
          principal,
          input,
          budget,
          operationSignal,
        );
        const rows =
          selected.kind === "canonical"
            ? await set(
                readMcpChatMessageHistory$,
                principal,
                input.threadId,
                budget,
                operationSignal,
              )
            : selected.rows;
        budget.check();
        const resolved =
          rows === null
            ? null
            : resolveInput(
                rows.map((row) => {
                  budget.check();
                  return chatEventFromRow(row);
                }),
                input.eventId,
                budget.check,
              );
        return resolved
          ? { kind: "ok", data: resolved }
          : { kind: "not_found", message: "Chat input not found." };
      })(),
      signal,
    );
    signal.throwIfAborted();
    if (operationSignal.aborted) {
      return {
        kind: "history_limit",
        message: "Chat input exceeded the 15-second history read budget.",
      };
    }
    if (result.ok) {
      return result.value;
    }
    return result.error instanceof McpMessageHistoryError
      ? { kind: result.error.kind, message: result.error.message }
      : {
          kind: "history_unavailable",
          message:
            "Chat input history could not be read completely. Retry later.",
        };
  },
);

function publicRejection(
  error: string,
): Extract<McpGetChatInputOutput, { inputStatus: "rejected" }>["error"] {
  switch (error) {
    case "insufficient_credits": {
      return {
        code: "insufficient_credits",
        message:
          "Insufficient credits. Add credits or connect a personal Codex or Claude subscription.",
      };
    }
    case "pro_required": {
      return {
        code: "pro_required",
        message: "This input requires a Pro plan.",
      };
    }
    default: {
      return {
        code: "input_rejected",
        message: "The input was rejected before execution.",
      };
    }
  }
}

const observeMcpChatInput$ = command(
  async (
    { get, set },
    principal: Principal,
    input: McpGetChatInputInput,
    signal: AbortSignal,
  ): Promise<McpChatInputReadResult> => {
    const resolved = await set(
      readCanonicalMcpChatInput$,
      principal,
      input,
      signal,
    );
    if (resolved.kind !== "ok") {
      return resolved;
    }
    const { original, current } = resolved.data;
    const identity = {
      threadId: input.threadId,
      eventId: original.id,
      createdAt: formatMcpChatTimestamp(original.createdAt),
    };
    if (current.eventType === "control.revoke") {
      return {
        kind: "ok",
        data: { ...identity, inputStatus: "recalled", run: null, error: null },
      };
    }
    if (current.eventType === "input.rejected") {
      return {
        kind: "ok",
        data: {
          ...identity,
          inputStatus: "rejected",
          run: null,
          error: publicRejection(current.error),
        },
      };
    }
    if (current.runId === undefined) {
      return {
        kind: "ok",
        data: { ...identity, inputStatus: "queued", run: null, error: null },
      };
    }
    const run = await awaitWithSignal(
      get(nativeRunStatus({ ...principal, runId: current.runId })),
      signal,
    );
    if (!run) {
      return {
        kind: "history_unavailable",
        message:
          "The consuming Run is unavailable; input consumption cannot be observed completely.",
      };
    }
    return {
      kind: "ok",
      data: {
        ...identity,
        inputStatus: "consumed",
        run,
        error: null,
      },
    };
  },
);

/** Bound the full observation, including the minimal native consuming-Run read. */
export const getMcpChatInput$ = command(
  async (
    { set },
    principal: Principal,
    input: McpGetChatInputInput,
    signal: AbortSignal,
  ): Promise<McpChatInputReadResult> => {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const result = await settle(
      awaitWithSignal(
        set(observeMcpChatInput$, principal, input, operationSignal),
        operationSignal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (operationSignal.aborted) {
      return {
        kind: "history_limit",
        message: "Chat input exceeded the 15-second observation budget.",
      };
    }
    return result.ok
      ? result.value
      : {
          kind: "history_unavailable",
          message:
            "Chat input could not be observed completely. Retry the read later.",
        };
  },
);
