import { mcpChatSubmissions } from "@okouai/db/schema/mcp-chat-submission";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { eq } from "drizzle-orm";
import { now } from "../../lib/time";
import type { Db } from "../external/db";

export const MCP_SUBMISSION_RETRY_MS = 24 * 60 * 60 * 1000;

export interface McpSubmissionIdentity {
  readonly requestId: string;
  readonly requestHash: string;
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
  const loadReceipt = async () => {
    const [receipt] = await db
      .select()
      .from(mcpChatSubmissions)
      .where(eq(mcpChatSubmissions.requestId, identity.requestId))
      .limit(1);
    return receipt;
  };
  let receipt = await loadReceipt();
  if (!receipt) {
    // Never adopt a first-party event. Recheck after observing a collision:
    // another transaction may have committed its event and receipt together
    // between these two READ COMMITTED queries.
    const [event] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(eq(chatEvents.id, identity.requestId))
      .limit(1);
    if (!event) {
      return { kind: "missing" } as const;
    }
    receipt = await loadReceipt();
    if (!receipt) {
      return { kind: "conflict" } as const;
    }
  }
  if (
    receipt.threadId !== owner.threadId ||
    receipt.userId !== owner.userId ||
    receipt.orgId !== owner.orgId ||
    receipt.requestHash !== identity.requestHash
  ) {
    return { kind: "conflict" } as const;
  }
  if (receipt.acceptedAt.getTime() + MCP_SUBMISSION_RETRY_MS <= now()) {
    return { kind: "expired" } as const;
  }
  return { kind: "accepted", receipt } as const;
}

export async function recordMcpSubmission(
  db: Pick<Db, "insert">,
  identity: McpSubmissionIdentity,
  owner: McpSubmissionOwner,
  input: {
    readonly id: string;
    readonly seqId: number;
    readonly createdAt: Date;
  },
): Promise<void> {
  if (input.id !== identity.requestId) {
    throw new Error("MCP submission identity does not match its input");
  }
  await db.insert(mcpChatSubmissions).values({
    ...owner,
    ...identity,
    inputSeqId: input.seqId,
    acceptedAt: input.createdAt,
  });
}
