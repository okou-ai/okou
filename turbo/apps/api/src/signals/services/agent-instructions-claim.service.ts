import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { agents } from "@okouai/db/schema/agent";
import { writeDb$ } from "../external/db";
import { notFound } from "../../lib/error";
import { visibleJoinedAgentCondition } from "./agent-data.service";

/** The primary read is the instruction selection point for this claim attempt. */
export const readAgentInstructionsForClaim$ = command(
  async (
    { set },
    args: {
      readonly agentId: string | null;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    if (args.agentId === null) {
      throw new Error("Agent instruction claim is missing its Agent");
    }
    const [agent] = await set(writeDb$)
      .select({ instructions: agents.instructions })
      .from(agents)
      .where(
        and(
          eq(agents.id, args.agentId),
          eq(agents.orgId, args.orgId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      return {
        available: false as const,
        response: notFound("Agent not found"),
      };
    }
    return { available: true as const, instructions: agent.instructions };
  },
);
