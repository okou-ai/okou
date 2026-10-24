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
