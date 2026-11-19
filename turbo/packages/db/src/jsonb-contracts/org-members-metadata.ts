export type OrgMembersPinnedAgentIds = string[];

export interface OrgMembersRecentWorkflow {
  workflowId: string;
  /** UTC ISO timestamp of the accepted input that used this workflow. */
  lastUsedAt: string;
}

/** At most ten workflows, ordered by last use descending. */
export type OrgMembersRecentWorkflows = OrgMembersRecentWorkflow[];
