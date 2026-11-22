import type { ConfirmPresentationFormatResponse } from "@okouai/api-contracts/contracts/presentation-format";
import type {
  PresentationFormatSelectionPart,
  UserMessageDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command } from "ccstate";
import { and, asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { writeDb$ } from "../external/db";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { presentationFormatContinuationEventId } from "./presentation-format-policy";

interface SourceIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly sourceRunId: string;
}

/** These reads intentionally use the publication connection, including recovery after an unknown commit. */
export const readPresentationFormatSource$ = command(
  async ({ set }, identity: SourceIdentity, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [source] = await db
      .select({
        runId: agentRuns.id,
        threadId: chatThreads.id,
        status: agentRuns.status,
        runnerCancellationMode: agentRuns.runnerCancellationMode,
        createdAt: agentRuns.createdAt,
        presentationFormat: orgMembersMetadata.presentationFormat,
        activeRunId: activeAgentRuns.runId,
      })
      .from(agentRuns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.orgId, identity.orgId),
          eq(chatThreads.userId, identity.userId),
        ),
      )
      .leftJoin(
        orgMembersMetadata,
        and(
          eq(orgMembersMetadata.orgId, identity.orgId),
          eq(orgMembersMetadata.userId, identity.userId),
        ),
      )
      .leftJoin(
        activeAgentRuns,
        eq(activeAgentRuns.chatThreadId, chatThreads.id),
      )
      .where(
        and(
          eq(agentRuns.id, identity.sourceRunId),
          eq(agentRuns.orgId, identity.orgId),
          eq(agentRuns.userId, identity.userId),
          eq(agentRuns.triggerSource, "web"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!source) {
      return null;
    }
    const original = alias(chatEvents, "presentation_format_original");
    const consumed = await db
      .select({
        id: original.id,
        threadId: original.chatThreadId,
        eventType: original.eventType,
        contextType: original.contextType,
        runId: original.runId,
        userMessage: canonicalChatEventUserMessage(original.payload),
      })
      .from(chatEvents)
      .leftJoin(original, eq(original.id, chatEvents.revokesEventId))
      .where(
        and(
          eq(chatEvents.runId, identity.sourceRunId),
          eq(chatEvents.chatThreadId, source.threadId),
          eq(chatEvents.eventType, "input.prompt"),
        ),
      )
      .orderBy(asc(original.seqId));
    signal.throwIfAborted();
    const inputs = consumed.flatMap((input) => {
      return input.id !== null &&
        input.threadId === source.threadId &&
        input.eventType === "input.prompt" &&
        input.contextType === "web" &&
        input.runId === null &&
        input.userMessage !== null
        ? [{ id: input.id, userMessage: input.userMessage }]
        : [];
    });
    return {
      ...source,
      inputs,
      inputsComplete: inputs.length === consumed.length && inputs.length > 0,
    };
  },
);

export type PresentationFormatSource = NonNullable<
  Awaited<ReturnType<(typeof readPresentationFormatSource$)["write"]>>
>;

export function recordedPresentationFormat(source: PresentationFormatSource) {
  const selections = source.inputs.flatMap(({ userMessage }) => {
    return userMessage.parts.filter(
      (part): part is PresentationFormatSelectionPart => {
        return part.type === "presentation_format_selection";
      },
    );
  });
  const formats = new Set(
    selections.map((part) => {
      return part.presentationFormat;
    }),
  );
  return formats.size > 1
    ? { kind: "conflict" as const }
    : {
        kind: "resolved" as const,
        presentationFormat: selections[0]?.presentationFormat ?? null,
      };
}

export function presentationSourceDocuments(
  source: PresentationFormatSource,
): readonly UserMessageDocument[] | null {
  if (!source.inputsComplete) {
    return null;
  }
  return source.inputs.map((input) => {
    return input.userMessage;
  });
}

type ReceiptRead =
  | { readonly kind: "absent" }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "accepted";
      readonly receipt: ConfirmPresentationFormatResponse;
      readonly pending: boolean;
    };

/** Never treat an arbitrary collision at the stable input identity as an accepted choice. */
export const readPresentationFormatReceipt$ = command(
  async (
    { set },
    identity: SourceIdentity,
    signal: AbortSignal,
  ): Promise<ReceiptRead> => {
    const db = set(writeDb$);
    const continuationEventId = presentationFormatContinuationEventId(
      identity.sourceRunId,
    );
    const [event] = await db
      .select({
        eventType: chatEvents.eventType,
        contextType: chatEvents.contextType,
        runId: chatEvents.runId,
        threadId: chatEvents.chatThreadId,
        userMessage: canonicalChatEventUserMessage(),
        createdAt: chatEvents.createdAt,
      })
      .from(chatEvents)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, chatEvents.chatThreadId),
          eq(chatThreads.userId, identity.userId),
          eq(chatThreads.orgId, identity.orgId),
        ),
      )
      .where(eq(chatEvents.id, continuationEventId))
      .limit(1);
    signal.throwIfAborted();
    if (!event) {
      return { kind: "absent" };
    }
    if (
      event.eventType !== "input.prompt" ||
      event.contextType !== "web" ||
      event.runId !== null
    ) {
      return { kind: "conflict" };
    }
    const selection = event.userMessage?.parts.find((part) => {
      return part.type === "presentation_format_selection";
    });
    if (
      !selection ||
      selection.sourceRunId !== identity.sourceRunId ||
      selection.sourceInputEventIds.length === 0 ||
      new Set(selection.sourceInputEventIds).size !==
        selection.sourceInputEventIds.length
    ) {
      return { kind: "conflict" };
    }
    const [source] = await db
      .select({ threadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, identity.sourceRunId),
          eq(agentRuns.userId, identity.userId),
          eq(agentRuns.orgId, identity.orgId),
          eq(agentRuns.triggerSource, "web"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!source || source.threadId !== event.threadId) {
      return { kind: "conflict" };
    }
    const consumed = await db
      .select({ id: chatEvents.revokesEventId })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.runId, identity.sourceRunId),
          eq(chatEvents.chatThreadId, event.threadId),
          eq(chatEvents.eventType, "input.prompt"),
        ),
      );
    signal.throwIfAborted();
    // Retained consumption edges must agree with every recorded source input.
    // Older edges may already be pruned; the immutable server-authored receipt
    // remains the confirmation fact, not the member's mutable default.
    if (
      consumed.some((input) => {
        return (
          input.id === null || !selection.sourceInputEventIds.includes(input.id)
        );
      })
    ) {
      return { kind: "conflict" };
    }
    const [revoker] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(eq(chatEvents.revokesEventId, continuationEventId))
      .limit(1);
    signal.throwIfAborted();
    return {
      kind: "accepted",
      pending: revoker === undefined,
      receipt: {
        status: "accepted",
        sourceRunId: identity.sourceRunId,
        threadId: event.threadId,
        continuationEventId,
        presentationFormat: selection.presentationFormat,
        acceptedAt: event.createdAt.toISOString(),
      },
    };
  },
);
