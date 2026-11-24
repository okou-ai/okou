import { command, computed, type Computed } from "ccstate";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { visibleWorkflowCondition } from "./workflow-visibility";

interface WorkflowRecencyMember {
  readonly orgId: string;
  readonly userId: string;
}

export function createWorkflowRecency(
  member$: Computed<WorkflowRecencyMember>,
) {
  const visibleWorkflowIds$ = computed(async (get) => {
    const member = get(member$);
    const rows = await get(db$)
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, member.orgId),
          visibleWorkflowCondition(member.userId),
        ),
      );
    // Run now can use a visible workflow even when the composer omits it.
    return new Set(
      rows.map((row) => {
        return row.id;
      }),
    );
  });

  const recentWorkflowIds$ = computed(async (get) => {
    const member = get(member$);
    const [row] = await get(db$)
      .select({ workflowIds: orgMembersMetadata.recentWorkflowIds })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, member.orgId),
          eq(orgMembersMetadata.userId, member.userId),
        ),
      )
      .limit(1);
    if (!row || row.workflowIds === null) {
      return null;
    }
    const visible = await get(visibleWorkflowIds$);
    return row.workflowIds.filter((id) => {
      return visible.has(id);
    });
  });

  const saveRecentWorkflowIds$ = command(
    async (
      { get, set },
      args: {
        readonly workflowIds: readonly string[];
        readonly operation: "use" | "import";
      },
      signal: AbortSignal,
    ) => {
      const member = get(member$);
      const visible = await get(visibleWorkflowIds$);
      signal.throwIfAborted();
      const workflowIds = [
        ...new Set(
          args.workflowIds
            .map((id) => {
              return id.toLowerCase();
            })
            .filter((id) => {
              return visible.has(id);
            }),
        ),
      ];
      const [saved] = await set(writeDb$)
        .insert(orgMembersMetadata)
        .values({
          orgId: member.orgId,
          userId: member.userId,
          recentWorkflowIds: workflowIds,
        })
        .onConflictDoUpdate({
          target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
          set: {
            recentWorkflowIds:
              args.operation === "import"
                ? sql`COALESCE(${orgMembersMetadata.recentWorkflowIds}, excluded.recent_workflow_ids)`
                : sql`(
                    SELECT COALESCE(jsonb_agg(recent.workflow_id ORDER BY recent.position), '[]'::jsonb)
                    FROM (
                      SELECT workflow_id, min(position) AS position
                      FROM jsonb_array_elements_text(
                        excluded.recent_workflow_ids || COALESCE(${orgMembersMetadata.recentWorkflowIds}, '[]'::jsonb)
                      ) WITH ORDINALITY AS history(workflow_id, position)
                      WHERE workflow_id = ANY(${sql.param([...visible])}::text[])
                      GROUP BY workflow_id
                    ) AS recent
                  )`,
            updatedAt: nowDate(),
          },
        })
        .returning({ workflowIds: orgMembersMetadata.recentWorkflowIds });
      signal.throwIfAborted();
      if (!saved || saved.workflowIds === null) {
        throw new Error(
          "Workflow recency write returned no initialized history",
        );
      }
      return saved.workflowIds.filter((id) => {
        return visible.has(id);
      });
    },
  );

  return { recentWorkflowIds$, saveRecentWorkflowIds$ };
}
