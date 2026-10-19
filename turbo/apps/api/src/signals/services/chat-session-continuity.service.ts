import type { NativeContinuation } from "@okouai/api-contracts/contracts/runners";
import { CHAT_EVENT_USER_MESSAGE_TEXT_TYPES } from "@okouai/api-contracts/contracts/chat-events";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import type { agents } from "@okouai/db/schema/agent";
import { computed, type Computed } from "ccstate";
import {
  and,
  eq,
  exists,
  gte,
  isNotNull,
  lt,
  ne,
  notExists,
  sql,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { ChatThreadRequestRow } from "./chat-thread-request-facts";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import {
  canReuseSession,
  type SessionExecutionIdentity,
} from "./session-compatibility";

export const NATIVE_CONTEXT_RECOVERY_PROMPT =
  "This Run did not resume the earlier native conversation context. Before processing the current request, you must run `okou chat messages --output-dir threads`, read and understand this Thread's earlier messages, and then continue the current request using that context.";

export type ChatThreadContinuationRoute = SessionExecutionIdentity;

export interface ChatThreadNativeBinding {
  readonly threadAgentId: string | null;
  readonly framework: string | null;
  readonly frameworkSessionId: string | null;
  readonly frameworkSessionRunId: string | null;
}

type NativeSourceRun = Pick<
  typeof agentRuns.$inferSelect,
  "id" | "agentId" | "selectedModel"
>;
const priorRun = alias(agentRuns, "prior_conversation_run");
const laterNativeRun = alias(agentRuns, "later_native_source_run");

export interface ChatThreadExecutionSnapshot {
  readonly agent: Pick<
    typeof agents.$inferSelect,
    "id" | "orgId" | "owner"
  > | null;
  readonly previousRun: NativeSourceRun | null;
  readonly nativeContinuation: NativeContinuation;
}

export interface ChatThreadContinuationRead {
  readonly selectedModel: string | null;
  readonly cliAgentType: string | null;
  readonly previousRun: NativeSourceRun | null;
  readonly hasPriorConversationRound: boolean;
}

export interface ChatThreadContinuationSnapshot
  extends ChatThreadContinuationRead, ChatThreadNativeBinding {
  readonly cloudBrowserEnabled: boolean;
  readonly agent: ChatThreadExecutionSnapshot["agent"];
}

export interface ChatThreadContinuation {
  readonly expected: ChatThreadNativeBinding;
  readonly cloudBrowserEnabled: boolean;
  readonly nativeContinuation: NativeContinuation;
  readonly executionSnapshot: ChatThreadExecutionSnapshot;
}

/** Reads native provenance and an existence fact, never message bodies. */
export function createChatThreadContinuationRead(
  pickedEvent$: Computed<
    Promise<{
      readonly id: string;
      readonly chatThreadId: string;
      readonly seqId: number;
    } | null>
  >,
  orgId: string,
  userId: string,
): Computed<Promise<ChatThreadContinuationRead | undefined>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event) {
      return undefined;
    }
    // The event PK makes this a nullable scalar, including before attribution.
    // Candidate Run IDs are non-null, so IS DISTINCT FROM preserves exclusion
    // when the current event has no Run (or no longer exists).
    const currentInputRun = new QueryBuilder()
      .select({ runId: chatEvents.runId })
      .from(chatEvents)
      .where(eq(chatEvents.id, event.id));
    const nativeSourceRun = new QueryBuilder()
      .select({
        id: agentRuns.id,
        agentId: agentRuns.agentId,
        selectedModel: agentRuns.selectedModel,
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, chatThreads.frameworkSessionRunId),
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.agentId, chatThreads.agentId),
          eq(agentRuns.framework, chatThreads.framework),
          eq(agentRuns.frameworkSessionId, chatThreads.frameworkSessionId),
          notExists(
            new QueryBuilder()
              .select({ id: laterNativeRun.id })
              .from(laterNativeRun)
              .where(
                and(
                  eq(laterNativeRun.chatThreadId, chatThreads.id),
                  ne(laterNativeRun.id, agentRuns.id),
                  gte(laterNativeRun.createdAt, agentRuns.createdAt),
                  isNotNull(laterNativeRun.frameworkSessionId),
                  sql`${laterNativeRun.id} IS DISTINCT FROM (${currentInputRun})`,
                ),
              ),
          ),
        ),
      )
      // The PK already bounds cardinality; LIMIT keeps provenance checks inside
      // the lateral lookup rather than flattening them into the thread join.
      .limit(1)
      .as("native_source_run");
    const [row] = await get(db$)
      .select({
        selectedModel: nativeSourceRun.selectedModel,
        cliAgentType: chatThreads.framework,
        previousRun: {
          id: nativeSourceRun.id,
          agentId: nativeSourceRun.agentId,
          selectedModel: nativeSourceRun.selectedModel,
        },
        // Run records survive Chat archival. Check them first and only inspect
        // visible message history when no earlier attributed Run exists.
        hasPriorConversationRound: sql`CASE WHEN ${exists(
          new QueryBuilder()
            .select({ id: priorRun.id })
            .from(priorRun)
            .where(
              and(
                eq(priorRun.chatThreadId, event.chatThreadId),
                isNotNull(priorRun.triggerSource),
                sql`${priorRun.id} IS DISTINCT FROM (${currentInputRun})`,
              ),
            ),
        )} THEN true ELSE ${exists(
          new QueryBuilder()
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.chatThreadId, event.chatThreadId),
                lt(chatEvents.seqId, event.seqId),
                isNotNull(chatEvents.runId),
                chatEventTypeIn(CHAT_EVENT_USER_MESSAGE_TEXT_TYPES),
                visibleChatEventCondition(),
              ),
            ),
        )} END`.mapWith(pgBooleanDecoder),
      })
      .from(chatThreads)
      .leftJoinLateral(nativeSourceRun, sql`true`)
      .where(
        and(
          eq(chatThreads.id, event.chatThreadId),
          eq(chatThreads.userId, userId),
        ),
      )
      .limit(1);
    return row;
  });
}

export function chatThreadNativeIdentity(
  read: ChatThreadContinuationRead | undefined,
): SessionExecutionIdentity | null {
  return read?.previousRun
    ? {
        selectedModel: read.previousRun.selectedModel,
        cliAgentType: read.cliAgentType,
      }
    : null;
}

export function capturedChatThreadContinuationSnapshot(
  thread: ChatThreadRequestRow,
  read: ChatThreadContinuationRead | undefined,
  agent: ChatThreadExecutionSnapshot["agent"],
): ChatThreadContinuationSnapshot {
  return {
    threadAgentId: thread.agentId,
    framework: thread.framework,
    frameworkSessionId: thread.frameworkSessionId,
    frameworkSessionRunId: thread.frameworkSessionRunId,
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    agent,
    selectedModel: read?.selectedModel ?? null,
    cliAgentType: read?.cliAgentType ?? null,
    previousRun: read?.previousRun ?? null,
    hasPriorConversationRound: read?.hasPriorConversationRound ?? false,
  };
}

export function resolveChatThreadContinuation(
  thread: ChatThreadContinuationSnapshot,
  args: { readonly route: ChatThreadContinuationRoute },
): ChatThreadContinuation {
  const identity = chatThreadNativeIdentity(thread);
  const reusable = identity !== null && canReuseSession(identity, args.route);
  const nativeContinuation: NativeContinuation = {
    sessionId: reusable ? thread.frameworkSessionId : null,
    generationRunId: reusable ? (thread.previousRun?.id ?? null) : null,
    recoveryPrompt: thread.hasPriorConversationRound
      ? NATIVE_CONTEXT_RECOVERY_PROMPT
      : null,
  };
  return {
    expected: {
      threadAgentId: thread.threadAgentId,
      framework: thread.framework,
      frameworkSessionId: thread.frameworkSessionId,
      frameworkSessionRunId: thread.frameworkSessionRunId,
    },
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    nativeContinuation,
    executionSnapshot: {
      agent: thread.agent,
      previousRun: thread.previousRun,
      nativeContinuation,
    },
  };
}
