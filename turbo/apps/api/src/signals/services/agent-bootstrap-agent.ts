import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { computed } from "ccstate";
import { eq } from "drizzle-orm";
import { db$ } from "../external/db";
import type { AgentRunRecord } from "./agent-run-execution.service";

/** Internal Agent facts remain independently readable before authorization. */
export function createBootstrapAgent(agentId: string) {
  return computed(async (get): Promise<AgentRunRecord | null> => {
    const [agent] = await get(db$)
      .select({
        id: agents.id,
        name: agents.name,
        orgId: agents.orgId,
        defaultAgentId: orgMetadata.defaultAgentId,
        owner: agents.owner,
        visibility: agents.visibility,
        displayName: agents.displayName,
        description: agents.description,
        sound: agents.sound,
        modelProviderId: agents.modelProviderId,
        selectedModel: agents.selectedModel,
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(eq(agents.id, agentId))
      .limit(1);
    return agent ?? null;
  });
}
