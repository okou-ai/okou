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

export type ChatThreadSessionRoute = SessionExecutionIdentity;
export type ChatThreadSessionResolutionAction =
  "initialized" | "reused" | "rotated";

export interface ChatThreadSessionSnapshot {
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

export interface ChatThreadSessionRead {
  readonly selectedModel: string | null;
  readonly cliAgentType: string | null;
  readonly previousRun: NativeSourceRun | null;
  readonly hasPriorConversationRound: boolean;
}

export interface ChatThreadSessionQuerySnapshot
  extends ChatThreadSessionRead, ChatThreadSessionSnapshot {
  readonly cloudBrowserEnabled: boolean;
  readonly agent: ChatThreadExecutionSnapshot["agent"];
}

export interface ChatThreadSessionResolution {
  readonly previousAgentId: string | null;
  readonly action: ChatThreadSessionResolutionAction;
  readonly resetNativeSession: boolean;
  readonly expected: ChatThreadSessionSnapshot;
  readonly cloudBrowserEnabled: boolean;
  readonly nativeContinuation: NativeContinuation;
  readonly executionSnapshot: ChatThreadExecutionSnapshot;
}

/** Reads native provenance and an existence fact, never message bodies. */
export function createChatThreadSessionRead(
  pickedEvent$: Computed<
    Promise<{
      readonly id: string;
      readonly chatThreadId: string;
      readonly seqId: number;
    } | null>
  >,
  orgId: string,
  userId: string,
): Computed<Promise<ChatThreadSessionRead | undefined>> {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (!event) {
      return undefined;
    }
    const [row] = await get(db$)
      .select({
        selectedModel: agentRuns.selectedModel,
        cliAgentType: chatThreads.framework,
        previousRun: {
          id: agentRuns.id,
          agentId: agentRuns.agentId,
          selectedModel: agentRuns.selectedModel,
        },
        hasPriorConversationRound: sql`(${exists(
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
        )}) OR (${exists(
          new QueryBuilder()
            .select({ id: priorRun.id })
            .from(priorRun)
            .where(
              and(
                eq(priorRun.chatThreadId, event.chatThreadId),
                isNotNull(priorRun.triggerSource),
                // Run records survive Chat archival. Exclude the current input's own
                // Run if this graph is revisited after its immutable attribution.
                notExists(
                  new QueryBuilder()
                    .select({ id: chatEvents.id })
                    .from(chatEvents)
                    .where(
                      and(
                        eq(chatEvents.id, event.id),
                        eq(chatEvents.runId, priorRun.id),
                      ),
                    ),
                ),
              ),
            ),
        )})`.mapWith(pgBooleanDecoder),
      })
      .from(chatThreads)
      .leftJoin(
        agentRuns,
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
                  notExists(
                    new QueryBuilder()
                      .select({ id: chatEvents.id })
                      .from(chatEvents)
                      .where(
                        and(
                          eq(chatEvents.id, event.id),
                          eq(chatEvents.runId, laterNativeRun.id),
                        ),
                      ),
                  ),
                ),
              ),
          ),
        ),
      )
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

export function chatThreadSessionIdentity(
  read: ChatThreadSessionRead | undefined,
): SessionExecutionIdentity | null {
  return read?.previousRun
    ? {
        selectedModel: read.previousRun.selectedModel,
        cliAgentType: read.cliAgentType,
      }
    : null;
}

export function capturedChatThreadSessionSnapshot(
  thread: ChatThreadRequestRow,
  read: ChatThreadSessionRead | undefined,
  agent: ChatThreadExecutionSnapshot["agent"],
): ChatThreadSessionQuerySnapshot {
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

export function resolveChatThreadSessionSnapshot(
  thread: ChatThreadSessionQuerySnapshot,
  args: { readonly route: ChatThreadSessionRoute },
): ChatThreadSessionResolution {
  const identity = chatThreadSessionIdentity(thread);
  const reusable = identity !== null && canReuseSession(identity, args.route);
  const nativeContinuation: NativeContinuation = {
    sessionId: reusable ? thread.frameworkSessionId : null,
    generationRunId: reusable ? (thread.previousRun?.id ?? null) : null,
    recoveryPrompt: thread.hasPriorConversationRound
      ? NATIVE_CONTEXT_RECOVERY_PROMPT
      : null,
  };
  return {
    previousAgentId: thread.previousRun?.agentId ?? null,
    action:
      thread.frameworkSessionId === null
        ? "initialized"
        : reusable
          ? "reused"
          : "rotated",
    resetNativeSession: !reusable,
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
