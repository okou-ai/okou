import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { createWorkflowTokenMatcher } from "@okouai/core/workflow-slash-token";
import { orgMembersMetadata } from "@okouai/db/runtime/org-members-metadata";
import { computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { db$ } from "../external/db";
import { workflowList, type WorkflowMember } from "./workflow-data.service";

/** The command candidates, including the private-over-public name winner. */
export function composerWorkflows(args: {
  readonly orgId: string;
  readonly member: WorkflowMember;
  readonly agentId: string;
}) {
  const visible$ = workflowList(args);
  return computed(async (get) => {
    const visible = await get(visible$);
    return visible.filter((workflow) => {
      return !workflow.official && !workflow.shadowedBy;
    });
  });
}

export function memberWorkflowRecency(args: {
  readonly orgId: string;
  readonly userId: string;
}) {
  return computed(async (get) => {
    const [member] = await get(db$)
      .select({ recentWorkflows: orgMembersMetadata.recentWorkflows })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, args.orgId),
          eq(orgMembersMetadata.userId, args.userId),
        ),
      )
      .limit(1);
    return new Map(
      (member?.recentWorkflows ?? []).map((entry) => {
        return [entry.workflowId, entry.lastUsedAt];
      }),
    );
  });
}

/** Only the caller's visible text is eligible, not prompt/history annotations. */
export function workflowIdsInUserMessage(
  message: UserMessageDocument,
  workflows: readonly { readonly id: string; readonly name: string }[],
): string[] {
  const text = message.parts
    .flatMap((part) => {
      return part.type === "text" ? [part.text] : [];
    })
    .join("\n");
  const matchTokens = createWorkflowTokenMatcher(
    workflows.map((workflow) => {
      return workflow.name;
    }),
  );
  const usedNames = new Set(
    matchTokens?.(text).map((token) => {
      return token.name;
    }),
  );
  return workflows.flatMap((workflow) => {
    return usedNames.has(workflow.name) ? [workflow.id] : [];
  });
}
