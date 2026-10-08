import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";

/** Only canonical upstream identity is hashed; credentials never enter this value. */
export function personalSubscriptionAccountIdentity(account: {
  readonly type: string;
  readonly externalAccountId: string | null;
  readonly accountEmail: string | null;
  readonly workspaceName: string | null;
}): string | null {
  const externalId = account.externalAccountId?.trim();
  const email = account.accountEmail?.trim().toLowerCase();
  const workspace = account.workspaceName?.trim().toLowerCase();
  const identity = externalId
    ? [account.type, "external", externalId]
    : account.type === "claude-code-oauth-token" && email && workspace
      ? [account.type, "legacy", email, workspace]
      : null;
  return identity
    ? createHash("sha256").update(JSON.stringify(identity)).digest("hex")
    : null;
}

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
