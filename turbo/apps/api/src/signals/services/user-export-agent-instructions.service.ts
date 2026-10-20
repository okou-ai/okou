import { agents } from "@okouai/db/schema/agent";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { agentInstructionsContent } from "./agent-instructions.service";

export const readUserExportAgentInstructions$ = command(
  async (
    { get },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const [agent] = await get(db$)
      .select({ instructions: agents.instructions })
      .from(agents)
      .where(
        and(
          eq(agents.id, args.agentId),
          eq(agents.orgId, args.orgId),
          eq(agents.owner, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      throw new Error("Agent became unavailable during export");
    }
    return agentInstructionsContent(agent.instructions);
  },
);
