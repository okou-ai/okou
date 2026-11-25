import type {
  ConnectorAuthProviderAuthMethodId,
  ConnectorAuthProviderConnectorSlug,
  ConnectorAuthProviderGrantOutputValuesFor,
} from "./provider-capabilities";

export interface ConnectorAuthProviderGrantUserInfo {
  readonly id: string;
  /** Provider-owned authorization scope when a user can grant multiple connections. */
  readonly identityNamespace?: string;
  readonly username: string | null;
  readonly email: string | null;
}

export function requireConnectorGrantUserId(
  id: string | null | undefined,
  providerName: string,
): string {
  if (!id) {
    throw new Error(`No user id in ${providerName} user info response`);
  }
  return id;
}

export type ConnectorAuthProviderGrantOutputValues = Readonly<
  Record<string, string | null | undefined>
>;

export interface ConnectorAuthProviderGrantResult<
  Outputs extends ConnectorAuthProviderGrantOutputValues =
    ConnectorAuthProviderGrantOutputValues,
> {
  readonly outputs: Outputs;
  /** Seconds until the granted credentials expire. */
  readonly expiresIn?: number;
  /**
   * Effective scopes granted for these credentials. Provider-reported scopes
   * take precedence; an omitted response uses the effective authorization
   * request.
   */
  readonly scopes: readonly string[];
  readonly userInfo: ConnectorAuthProviderGrantUserInfo;
  readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
}

export type ConnectorAuthProviderGrantResultForMethod<
  ConnectorSlug extends ConnectorAuthProviderConnectorSlug,
  AuthMethodId extends ConnectorAuthProviderAuthMethodId<ConnectorSlug>,
> = ConnectorAuthProviderGrantResult<
  ConnectorAuthProviderGrantOutputValuesFor<ConnectorSlug, AuthMethodId>
>;
