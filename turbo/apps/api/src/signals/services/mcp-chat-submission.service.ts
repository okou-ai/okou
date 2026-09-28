import { isDeepStrictEqual } from "node:util";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq } from "drizzle-orm";
import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";

export const MCP_SUBMISSION_RETRY_MS = 24 * 60 * 60 * 1000;

export interface McpSubmissionIdentity {
  readonly requestId: string;
  readonly text: string;
  readonly clientId: string;
}

interface McpSubmissionOwner {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
}

export async function resolveMcpSubmission(
  db: Pick<Db, "select">,
  identity: McpSubmissionIdentity,
  owner: McpSubmissionOwner,
) {
  // Original immutable inputs outlive the 24-hour retry window in the
  // 30-day live event store. No guarantee extends beyond that window.
  const [event] = await db
    .select({
      requestId: chatEvents.id,
      threadId: chatEvents.chatThreadId,
      userId: chatThreads.userId,
      orgId: agents.orgId,
      eventType: chatEvents.eventType,
      runId: chatEvents.runId,
      revokesEventId: chatEvents.revokesEventId,
      userMessage: canonicalChatEventUserMessage(),
      inputSeqId: chatEvents.seqId,
      acceptedAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(eq(chatEvents.id, identity.requestId))
    .limit(1);
  if (!event) {
    return { kind: "missing" } as const;
  }
  const parts = event.userMessage?.parts ?? [];
  const text = parts[0];
  const source = parts[1];
  const attributedInput =
    event.userMessage?.version === 1 &&
    parts.length === 2 &&
    text?.type === "text" &&
    text.text === identity.text &&
    source?.type === "source" &&
    source.kind === "mcp" &&
    source.clientId === identity.clientId;
  // A text-only MCP input accepted by the old writer remains replayable for
  // its existing 24-hour window. It has no client identity to reconstruct;
  // never add a source to it on a retry. Remove after the last old-writer
  // acceptance plus the retry window and bounded drain (see #37276).
  const legacyInput = isDeepStrictEqual(event.userMessage, {
    version: 1,
    parts: [{ type: "text", text: identity.text }],
  });
  if (
    event.threadId !== owner.threadId ||
    event.userId !== owner.userId ||
    event.orgId !== owner.orgId ||
    event.eventType !== "input.prompt" ||
    event.runId !== null ||
    event.revokesEventId !== null ||
    (!attributedInput && !legacyInput)
  ) {
    return { kind: "conflict" } as const;
  }
  if (event.acceptedAt.getTime() + MCP_SUBMISSION_RETRY_MS <= now()) {
    return { kind: "expired" } as const;
  }
  return {
    kind: "accepted",
    receipt: {
      requestId: event.requestId,
      inputSeqId: event.inputSeqId,
      acceptedAt: event.acceptedAt,
    },
  } as const;
}
