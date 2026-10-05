import { agents } from "@okouai/db/schema/agent";
import { eq } from "drizzle-orm";

import { db } from "../lib/db";

export async function readCanonicalAgentNameFixture(
  agentId: string,
): Promise<string> {
  const [agent] = await db()
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent) {
    throw new Error("Expected a canonical Agent fixture");
  }
  return agent.name;
}
