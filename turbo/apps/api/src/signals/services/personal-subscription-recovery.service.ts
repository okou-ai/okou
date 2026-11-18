import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";

export function failedRunAccountIdentityCondition(args: {
  readonly runId: string;
  readonly accountId: string;
  readonly providerType: string;
  readonly userId: string;
  readonly orgId: string;
}) {
  return and(
    eq(agentRuns.id, args.runId),
    eq(agentRuns.userId, args.userId),
    eq(agentRuns.orgId, args.orgId),
    eq(agentRuns.modelProviderId, args.accountId),
    eq(agentRuns.modelProvider, args.providerType),
    eq(agentRuns.modelProviderCredentialScope, "member"),
    inArray(agentRuns.status, ["failed", "timeout"]),
  );
}
