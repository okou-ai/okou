import { modelProviders } from "@okouai/db/schema/model-provider";
import { and, eq } from "drizzle-orm";

interface PersonalProviderIdentityScope {
  readonly orgId: string;
  readonly userId: string;
  readonly type: string;
}

export function logicalProviderIdentityCondition(
  scope: PersonalProviderIdentityScope,
) {
  return and(
    eq(modelProviders.orgId, scope.orgId),
    eq(modelProviders.userId, scope.userId),
    eq(modelProviders.type, scope.type),
  );
}

export function logicalProviderIdentityValues(
  scope: PersonalProviderIdentityScope,
) {
  return {
    orgId: scope.orgId,
    userId: scope.userId,
    type: scope.type,
  };
}

export interface PersonalProviderAccountMetadata {
  readonly externalAccountId?: string | null;
  readonly accountEmail?: string | null;
  readonly tokenExpiresAt?: Date | null;
  readonly workspaceName?: string | null;
  readonly planType?: string | null;
  readonly subscriptionResetPeriod?: string | null;
  readonly subscriptionNextResetAt?: Date | null;
}

export function hasClaudeIdentity(
  identity: PersonalProviderAccountMetadata,
): boolean {
  return Boolean(
    identity.externalAccountId ||
    (identity.accountEmail && identity.workspaceName),
  );
}

export function claudeAccountIdentityToApply(
  account: PersonalProviderAccountMetadata & { readonly id: string },
  identities: ReadonlyMap<string, PersonalProviderAccountMetadata> | null,
): PersonalProviderAccountMetadata | null {
  const metadata = identities?.get(account.id);
  return !metadata || hasClaudeIdentity(account) ? null : metadata;
}

export function claudeAccountIdentityValues(
  metadata: PersonalProviderAccountMetadata,
) {
  return {
    externalAccountId: metadata.externalAccountId ?? null,
    accountEmail: metadata.accountEmail ?? null,
    workspaceName: metadata.workspaceName ?? null,
  };
}
