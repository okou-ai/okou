export type OrgMembersPinnedAgentIds = string[];

export interface OrgMembersRecentWorkflow {
  workflowId: string;
  /** Accepted-input UTC time; imported legacy IDs use epoch-based order markers. */
  lastUsedAt: string;
}

/** At most ten workflows, ordered by last use descending. */
export type OrgMembersRecentWorkflows = OrgMembersRecentWorkflow[];
