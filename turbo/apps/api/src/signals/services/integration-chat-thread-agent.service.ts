import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import type { PersistProducerRunBinding } from "./agent-run-create.service";
import { appendChatThreadEvent } from "./chat-thread-event.service";

interface IntegrationChatThreadAgent {
  readonly agentId: string;
  readonly expectedThreadAgentId?: string;
  readonly persistProducerRunBinding?: PersistProducerRunBinding;
}

/** Integration input always runs the organization default; legacy preferences rebind once. */
export async function resolveIntegrationChatThreadAgent(
  db: Db,
  input: {
    readonly contextType: string | null;
    readonly chatThreadId: string;
    readonly agentId: string;
    readonly userId: string;
    readonly orgId: string;
  },
): Promise<IntegrationChatThreadAgent | null> {
  if (
    input.contextType !== "slack" &&
    input.contextType !== "feishu" &&
    input.contextType !== "teams" &&
    input.contextType !== "discord" &&
    input.contextType !== "telegram" &&
    input.contextType !== "agentphone"
  ) {
    return { agentId: input.agentId };
  }
  const [agent] = await db
    .select({ id: agents.id })
    .from(orgMetadata)
    .innerJoin(agents, eq(agents.id, orgMetadata.defaultAgentId))
    .where(
      and(eq(orgMetadata.orgId, input.orgId), eq(agents.orgId, input.orgId)),
    )
    .limit(1);
  if (!agent) {
    return null;
  }
  if (agent.id === input.agentId) {
    return { agentId: agent.id };
  }
  return {
    agentId: agent.id,
    expectedThreadAgentId: input.agentId,
    persistProducerRunBinding: async (tx) => {
      // The run core has already replaced the session binding in this same
      // transaction. The old agent's native/Pi session is never resumed.
      await tx
        .update(chatThreads)
        .set({ agentId: agent.id })
        .where(
          and(
            eq(chatThreads.id, input.chatThreadId),
            eq(chatThreads.userId, input.userId),
            eq(chatThreads.agentId, input.agentId),
          ),
        );
      await appendChatThreadEvent(tx, {
        kind: "sort_touched",
        chatThreadId: input.chatThreadId,
        userId: input.userId,
        orgId: input.orgId,
        agentId: agent.id,
        reassignedAgentId: agent.id,
      });
    },
  };
}
