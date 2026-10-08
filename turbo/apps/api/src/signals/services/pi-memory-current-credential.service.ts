import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../external/db";

export interface PiMemoryCurrentCredential {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
  readonly id: string | null;
  readonly scope: "org" | "member";
}

/** Historical run credentials are provenance only. Choose one current route
 * for the memory owner before either background stage starts. */
export async function selectPiMemoryCurrentCredential(
  db: Pick<Db, "select">,
  owner: { readonly orgId: string; readonly userId: string },
): Promise<PiMemoryCurrentCredential> {
  // A member has at most one Codex provider row per organization; the ID order
  // keeps the read deterministic. No historical source decides this ranking.
  const providers = await db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      userId: modelProviders.userId,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, owner.orgId),
        eq(modelProviders.userId, owner.userId),
        eq(modelProviders.type, "codex-oauth-token"),
      ),
    )
    .orderBy(asc(modelProviders.type), asc(modelProviders.id));
  for (const provider of providers) {
    if (provider.type === "codex-oauth-token") {
      // Reconnect state lives on the account row, checked below.
      if (provider.userId !== owner.userId) {
        continue;
      }
      const [account] = await db
        .select({ id: modelProviderAccounts.id })
        .from(modelProviderAccounts)
        .where(
          and(
            eq(modelProviderAccounts.modelProviderId, provider.id),
            eq(modelProviderAccounts.orgId, owner.orgId),
            eq(modelProviderAccounts.userId, owner.userId),
            eq(modelProviderAccounts.type, provider.type),
            eq(modelProviderAccounts.isActive, true),
            eq(modelProviderAccounts.needsReconnect, false),
            isNotNull(modelProviderAccounts.externalAccountId),
            isNull(modelProviderAccounts.disconnectedAt),
          ),
        )
        .limit(1);
      if (account) {
        return {
          orgId: owner.orgId,
          userId: owner.userId,
          type: provider.type,
          id: account.id,
          scope: "member",
        };
      }
      continue;
    }
  }
  return {
    orgId: owner.orgId,
    userId: owner.userId,
    type: "built-in",
    id: null,
    scope: "org",
  };
}
