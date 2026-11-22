import { computed, type Computed } from "ccstate";
import { getInstructionsFilename } from "@okouai/core/frameworks";
import { stripMetadataFrontmatter } from "@okouai/core/instructions-frontmatter";
import { legacyAgentApiProfiles } from "@okouai/db/schema/legacy-agent-api-profile";
import { and, eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";

/** Presentation compatibility for legacy profile blocks; runtime reads raw text. */
export function agentInstructionsContent(content: string): string {
  return content.includes("[AGENT_PROFILE]") ||
    content.includes("<!-- ZERO_PROFILE")
    ? stripMetadataFrontmatter(content)
    : content;
}

export function agentInstructions(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
}): Computed<
  Promise<{ readonly content: string; readonly filename: string } | null>
> {
  return computed(async (get) => {
    const [agent] = await get(db$)
      .select({ instructions: legacyAgentApiProfiles.instructions })
      .from(legacyAgentApiProfiles)
      .where(
        and(
          eq(legacyAgentApiProfiles.orgId, args.orgId),
          eq(legacyAgentApiProfiles.id, args.agentId),
          visibleJoinedAgentCondition(args.userId),
        ),
      )
      .limit(1);
    if (!agent) {
      return null;
    }
    return {
      content: agentInstructionsContent(agent.instructions),
      filename: getInstructionsFilename(),
    };
  });
}
