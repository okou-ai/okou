/**
 * User-entered field configuration for manual connector grant methods.
 */
export interface ConnectorManualGrantFieldConfig {
  /**
   * Stable public form id used by catalog clients. This must not be a private
   * credential, storage, env binding, or runtime binding name.
   */
  publicId: string;
  label: string;
  required: boolean;
  placeholder?: string;
  /** Storage type: "secret" (default, encrypted) or "variable" (plain text). */
  storage?: "secret" | "variable";
  /**
   * Optional normalization applied to the user-entered value before it is
   * persisted.
   *
   * - `"host"`: strip the URL scheme, userinfo, path, query, fragment, and
   *   trailing slash, leaving only `host[:port]`. Use this for fields templated
   *   into a firewall base URL's authority position (`https://${{ vars.X }}`),
   *   where the firewall validator rejects values that introduce URL structure
   *   (`/`, `?`, `#`, `@`). Lets a user paste a full backend URL
   *   (e.g. `https://my-project.example.app/`) without breaking the connection.
   */
  normalize?: "host";
}

export type ConnectorAuthClientConfig =
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientIdEnv: string;
      readonly clientSecretEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "confidential";
      readonly clientId: string;
      readonly clientSecret: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly clientIdEnv: string;
    }
  | {
      readonly clientRegistration: "static";
      readonly clientType: "public";
      readonly clientId: string;
    }
  | {
      readonly clientRegistration: "dynamic";
      readonly clientType: "public";
    };

export type StaticConfidentialConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "confidential";
  }
>;

export type StaticPublicConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "static";
    readonly clientType: "public";
  }
>;

export type DynamicPublicConnectorAuthClientConfig = Extract<
  ConnectorAuthClientConfig,
  {
    readonly clientRegistration: "dynamic";
    readonly clientType: "public";
  }
>;

export type PublicConnectorAuthClientConfig =
  | StaticPublicConnectorAuthClientConfig
  | DynamicPublicConnectorAuthClientConfig;

export type ConnectorGrantKind =
  | "none"
  | "automatic"
  | "manual"
  | "auth-code"
  | "openid-auth"
  | "external-code"
  | "device-auth"
  | "managed";

export interface ConnectorNoAuthGrantConfig {
  readonly kind: "none";
}

export interface ConnectorAutomaticGrantConfig {
  readonly kind: "automatic";
  readonly callbackOrigin: "api";
  readonly outputs: ConnectorGrantOutputBindings;
}

export interface ConnectorManualGrantConfig {
  readonly kind: "manual";
  readonly fields: Record<string, ConnectorManualGrantFieldConfig>;
}

export type ConnectorBrowserAuthCallbackOrigin = "web" | "api";
export type ConnectorAuthCodeCallbackOrigin =
  ConnectorBrowserAuthCallbackOrigin;

export interface ConnectorAuthCodeGrantConfig {
  readonly kind: "auth-code";
  readonly scopes: string[];
  readonly callbackOrigin?: ConnectorAuthCodeCallbackOrigin;
  readonly outputs: ConnectorGrantOutputBindings;
}

export interface ConnectorOpenIdAuthGrantConfig {
  readonly kind: "openid-auth";
  readonly callbackOrigin?: ConnectorBrowserAuthCallbackOrigin;
  readonly outputs: ConnectorGrantOutputBindings;
}

export interface ConnectorExternalCodeGrantConfig {
  readonly kind: "external-code";
  readonly scopes: string[];
  readonly outputs: ConnectorGrantOutputBindings;
}

export interface ConnectorDeviceAuthStartSelectOptionChoiceConfig {
  readonly value: string;
  readonly label: string;
}

type ConnectorDeviceAuthStartSelectOptionChoicesConfig = readonly [
  ConnectorDeviceAuthStartSelectOptionChoiceConfig,
  ...ConnectorDeviceAuthStartSelectOptionChoiceConfig[],
];

export interface ConnectorDeviceAuthStartSelectOptionConfig {
  readonly kind: "select";
  /**
   * Stable public start option id used by catalog clients.
   */
  readonly publicId: string;
  readonly label: string;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly options: ConnectorDeviceAuthStartSelectOptionChoicesConfig;
}

export type ConnectorDeviceAuthStartOptionConfig =
  ConnectorDeviceAuthStartSelectOptionConfig;

export type ConnectorDeviceAuthStartOptionsConfig = Readonly<
  Record<string, ConnectorDeviceAuthStartOptionConfig>
>;

export type ConnectorDeviceAuthStartOptions = Readonly<Record<string, string>>;

export interface ConnectorDeviceAuthGrantConfig {
  readonly kind: "device-auth";
  readonly scopes: string[];
  readonly outputs: ConnectorGrantOutputBindings;
  readonly startOptions?: ConnectorDeviceAuthStartOptionsConfig;
}

export interface ConnectorManagedGrantConfig {
  readonly kind: "managed";
}

export type ConnectorGrantConfig =
  | ConnectorNoAuthGrantConfig
  | ConnectorAutomaticGrantConfig
  | ConnectorManualGrantConfig
  | ConnectorAuthCodeGrantConfig
  | ConnectorOpenIdAuthGrantConfig
  | ConnectorExternalCodeGrantConfig
  | ConnectorDeviceAuthGrantConfig
  | ConnectorManagedGrantConfig;

export type ConnectorAccessKind =
  | "static"
  | "refresh-token"
  | "none"
  | "automatic";

export const CONNECTOR_PLATFORM_SECRET_NAMES = [
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "STEAM_WEB_API_KEY",
] as const;
export type ConnectorPlatformSecretName =
  (typeof CONNECTOR_PLATFORM_SECRET_NAMES)[number];

export type ConnectorSecretValueRef = `$secrets.${string}`;
export type ConnectorVariableValueRef = `$vars.${string}`;
export type ConnectorOutputValueRef =
  | ConnectorSecretValueRef
  | ConnectorVariableValueRef;
export type ConnectorRefreshTokenInputValueRef =
  | ConnectorSecretValueRef
  | ConnectorVariableValueRef;
export type ConnectorEnvBindingValue =
  | ConnectorRefreshTokenInputValueRef
  | {
      readonly valueRef: ConnectorRefreshTokenInputValueRef;
      readonly optional?: boolean;
    };
export type ConnectorEnvBindings = Record<string, ConnectorEnvBindingValue>;

export type ConnectorGrantOutputBindings = Record<
  string,
  ConnectorOutputValueRef
>;
export type ConnectorRevokeInputBindings = Record<
  string,
  ConnectorSecretValueRef
>;

export interface ConnectorStorageConfig {
  /**
   * Positive safe-integer compatibility generation for persisted credentials.
   *
   * Increase this when a storage name or class changes, or when existing
   * values change meaning, format, or validity. Presentation, rollout, skill,
   * icon, and firewall changes do not require an increase by themselves.
   */
  readonly version: number;
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

interface ConnectorEnvBindingAccessConfigBase {
  readonly envBindings: ConnectorEnvBindings;
  /**
   * `$secrets.NAME` backing sources read from platform env instead of connector
   * DB storage. Runtime aliases must still be declared in `envBindings`.
   */
  readonly platformSecrets?: readonly ConnectorPlatformSecretName[];
}

export interface ConnectorStaticAccessConfig extends ConnectorEnvBindingAccessConfigBase {
  readonly kind: "static";
}

export type ConnectorRefreshTokenInputBindings = Record<
  string,
  ConnectorRefreshTokenInputValueRef
>;
export type ConnectorRefreshTokenOutputBindings = Record<
  string,
  ConnectorOutputValueRef
>;

export interface ConnectorRefreshTokenAccessConfig extends ConnectorEnvBindingAccessConfigBase {
  readonly kind: "refresh-token";
  readonly inputs: ConnectorRefreshTokenInputBindings;
  readonly outputs: ConnectorRefreshTokenOutputBindings;
  readonly refreshableSecrets: readonly string[];
}

export interface ConnectorNoAccessConfig {
  readonly kind: "none";
}

export interface ConnectorAutomaticAccessConfig {
  readonly kind: "automatic";
  readonly inputs: ConnectorRefreshTokenInputBindings;
  readonly outputs: ConnectorRefreshTokenOutputBindings;
}

export type ConnectorAccessConfig =
  | ConnectorStaticAccessConfig
  | ConnectorRefreshTokenAccessConfig
  | ConnectorAutomaticAccessConfig
  | ConnectorNoAccessConfig;

export type ConnectorRevokeKind = "none" | "token-revoke";

export type ConnectorRevokeConfig =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "token-revoke";
      readonly inputs: ConnectorRevokeInputBindings;
      /**
       * Revoke the previous credential after a replacement connection commits.
       * Only enable this when the revoke inputs identify the old credential or
       * remote registration without invalidating the replacement connection.
       */
      readonly revokePreviousOnReplace?: boolean;
    };

interface ConnectorAuthMethodRuntimeConfigBase {
  /**
   * Connector-scoped storage names owned by this auth method.
   *
   * These lists are write/delete allowlists, not guarantees that rows currently
   * exist in the DB.
   */
  storage: ConnectorStorageConfig;
}

/**
 * Normalized auth method configuration used to materialize and execute a
 * connector connection lifecycle. External catalogs produce this shape by
 * joining their accepted public and private method data.
 */
export type ConnectorAuthMethodRuntimeConfig =
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client?: never;
      readonly grant: ConnectorAutomaticGrantConfig;
      readonly access: ConnectorAutomaticAccessConfig;
      readonly revoke: Extract<
        ConnectorRevokeConfig,
        { readonly kind: "none" }
      >;
    })
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client?: never;
      readonly grant: ConnectorNoAuthGrantConfig;
      readonly access: ConnectorNoAccessConfig;
      readonly revoke: Extract<
        ConnectorRevokeConfig,
        { readonly kind: "none" }
      >;
    })
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client: ConnectorAuthClientConfig;
      readonly grant: ConnectorAuthCodeGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client?: ConnectorAuthClientConfig;
      readonly grant: ConnectorOpenIdAuthGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client: ConnectorAuthClientConfig;
      readonly grant: ConnectorExternalCodeGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client: PublicConnectorAuthClientConfig;
      readonly grant: ConnectorDeviceAuthGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    })
  | (ConnectorAuthMethodRuntimeConfigBase & {
      readonly client?: ConnectorAuthClientConfig;
      readonly grant: ConnectorManualGrantConfig | ConnectorManagedGrantConfig;
      readonly access: ConnectorAccessConfig;
      readonly revoke: ConnectorRevokeConfig;
    });
