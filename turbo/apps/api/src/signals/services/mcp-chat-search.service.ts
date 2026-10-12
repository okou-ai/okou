import { computed, type Computed } from "ccstate";
import type {
  McpChatSearchResponse,
  McpChatSearchResult,
} from "@okouai/api-contracts/contracts/mcp-chat-search";
import { agentDisplayName } from "@okouai/core/brand-presentation";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";
import { visibleJoinedAgentCondition } from "./agent-data.service";
import { chatSearch } from "./chat-search.service";

export function mcpChatSearch(
  args$: Computed<{
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: number;
  }>,
): Computed<Promise<McpChatSearchResponse>> {
  const nativeSearch$ = chatSearch(args$);

  return computed(async (get) => {
    const args = get(args$);
    const search = await get(nativeSearch$);
    if (search.results.length === 0) {
      return { results: [] };
    }

    // Native hits carry the indexed Agent's organization-unique internal name.
    // Resolve that key, not a UUID guess or the thread's possibly reassigned Agent.
    const names = [
      ...new Set(
        search.results.map((hit) => {
          return hit.agentName;
        }),
      ),
    ];
    const rows = await get(db$)
      .select({
        agentId: agents.id,
        name: agents.name,
        displayName: agents.displayName,
        defaultAgentId: orgMetadata.defaultAgentId,
      })
      .from(agents)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
      .where(
        and(
          eq(agents.orgId, args.orgId),
          inArray(agents.name, names),
          visibleJoinedAgentCondition(args.userId),
        ),
      );
    const metadata = new Map(
      rows.map((row) => {
        return [
          row.name,
          {
            agentId: row.agentId,
            displayName: agentDisplayName(row),
          },
        ];
      }),
    );

    return {
      results: search.results.flatMap(
        ({ agentName, ...hit }): McpChatSearchResult[] => {
          const agent = metadata.get(agentName);
          // Do not publish metadata for an Agent that disappeared or became hidden.
          return agent ? [{ ...hit, ...agent }] : [];
        },
      ),
    };
  });
}
