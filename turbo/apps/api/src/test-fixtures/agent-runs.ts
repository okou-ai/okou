import { createStore } from "ccstate";

import { agentRunList } from "../signals/services/agent-runs.service";

export async function listAgentRunsFixture(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly status?: string;
  readonly agent?: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit?: number;
}) {
  // Disposable database fixtures replace the pool between operations, so each
  // listing owns its read store instead of retaining a previous db$ binding.
  return await createStore().get(
    agentRunList({
      userId: args.userId,
      orgId: args.orgId,
      status: args.status,
      agent: args.agent,
      since: args.since,
      until: args.until,
      limit: args.limit ?? 50,
    }),
  );
}
