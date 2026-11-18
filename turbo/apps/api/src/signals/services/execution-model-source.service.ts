import { createHash } from "node:crypto";

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

export type ModelSourceIdentity =
  | { readonly kind: "built-in"; readonly modelKeyId: string }
  | {
      readonly kind: "member";
      readonly accountId: string;
      readonly externalAccountId: string | null;
      readonly accountIdentity: string | null;
    };
export type ModelSourceCredential =
  ModelSecretReference | ManagedModelKeyReference;
export interface ManagedModelKeyReference {
  readonly kind: "managed-key";
  readonly name: string;
  readonly modelKeyId: string;
}
export interface ModelSecretReference {
  readonly kind: "secret-reference";
  readonly name: string;
}
export interface ModelSourceConfiguration {
  readonly providerType: string;
  readonly authMethod: string | null;
}
export interface ModelSourceSnapshot {
  readonly identity: ModelSourceIdentity;
  readonly configuration: ModelSourceConfiguration;
  readonly credentials: readonly ModelSourceCredential[];
}
