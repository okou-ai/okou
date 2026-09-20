import type {
  ConnectorAccessConfig,
  ConnectorAuthClientConfig,
  ConnectorAuthCodeCallbackOrigin,
  ConnectorAuthCodeGrantConfig,
  ConnectorAuthMethodRuntimeConfig,
  ConnectorBrowserAuthCallbackOrigin,
  ConnectorDeviceAuthStartOptionConfig,
  ConnectorDeviceAuthStartOptions,
  ConnectorDeviceAuthStartOptionsConfig,
  ConnectorEnvBindingValue,
  ConnectorEnvBindings,
  ConnectorGrantConfig,
  ConnectorGrantOutputBindings,
  ConnectorManualGrantFieldConfig,
  ConnectorOpenIdAuthGrantConfig,
  ConnectorOutputValueRef,
  ConnectorPlatformSecretName,
  ConnectorRefreshTokenInputBindings,
  ConnectorRefreshTokenInputValueRef,
  ConnectorRefreshTokenOutputBindings,
  ConnectorRevokeInputBindings,
  ConnectorSecretValueRef,
  ConnectorVariableValueRef,
  DynamicPublicConnectorAuthClientConfig,
  StaticConfidentialConnectorAuthClientConfig,
  StaticPublicConnectorAuthClientConfig,
} from "./connector-config";

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";
const CONNECTOR_VARIABLE_REF_PREFIX = "$vars.";
const DEFAULT_AUTH_CODE_CALLBACK_ORIGIN: ConnectorAuthCodeCallbackOrigin =
  "web";

export interface ConnectorManualGrantFieldNames {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

function manualGrantFieldNames(
  fields: Record<string, ConnectorManualGrantFieldConfig>,
): ConnectorManualGrantFieldNames {
  const secretNames: string[] = [];
  const variableNames: string[] = [];
  for (const [name, cfg] of Object.entries(fields)) {
    if (cfg.storage === "variable") {
      variableNames.push(name);
    } else {
      secretNames.push(name);
    }
  }
  return { secrets: secretNames, variables: variableNames };
}

export function connectorAuthMethodManualGrantFieldNames(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorManualGrantFieldNames | null {
  return method.grant.kind === "manual"
    ? manualGrantFieldNames(method.grant.fields)
    : null;
}

function addConnectorPrivateValueRef(
  valueRef: ConnectorOutputValueRef,
  privateNames: Set<string>,
): void {
  if (isConnectorSecretValueRef(valueRef)) {
    privateNames.add(connectorSecretNameFromValueRef(valueRef));
    return;
  }
  privateNames.add(connectorVariableNameFromValueRef(valueRef));
}

function addAccessPrivateNames(
  access: ConnectorAccessConfig,
  privateNames: Set<string>,
): void {
  if ("envBindings" in access) {
    for (const [envName, binding] of Object.entries(access.envBindings)) {
      privateNames.add(envName);
      addConnectorPrivateValueRef(
        typeof binding === "string" ? binding : binding.valueRef,
        privateNames,
      );
    }
    for (const platformSecret of access.platformSecrets ?? []) {
      privateNames.add(platformSecret);
    }
  }
  if (access.kind === "refresh-token" || access.kind === "automatic") {
    for (const valueRef of Object.values(access.inputs)) {
      addConnectorPrivateValueRef(valueRef, privateNames);
    }
    for (const valueRef of Object.values(access.outputs)) {
      addConnectorPrivateValueRef(valueRef, privateNames);
    }
  }
  if (access.kind === "refresh-token") {
    for (const refreshableSecret of access.refreshableSecrets) {
      privateNames.add(refreshableSecret);
    }
  }
}

/**
 * Returns implementation-owned names that must not leak into public form ids.
 */
export function connectorAuthMethodPrivateNames(
  method: ConnectorAuthMethodRuntimeConfig,
): readonly string[] {
  const privateNames = new Set<string>([
    ...method.storage.secrets,
    ...method.storage.variables,
  ]);

  if (method.grant.kind === "manual") {
    for (const fieldName of Object.keys(method.grant.fields)) {
      privateNames.add(fieldName);
    }
  }
  if ("outputs" in method.grant) {
    for (const valueRef of Object.values(method.grant.outputs)) {
      addConnectorPrivateValueRef(valueRef, privateNames);
    }
  }

  addAccessPrivateNames(method.access, privateNames);

  if (method.revoke.kind === "token-revoke") {
    for (const valueRef of Object.values(method.revoke.inputs)) {
      addConnectorPrivateValueRef(valueRef, privateNames);
    }
  }

  if (method.client !== undefined) {
    if ("clientIdEnv" in method.client) {
      privateNames.add(method.client.clientIdEnv);
    }
    if ("clientSecretEnv" in method.client) {
      privateNames.add(method.client.clientSecretEnv);
    }
  }

  return [...privateNames];
}

function connectorAccessEnvBindings(
  access: ConnectorAccessConfig,
): ConnectorEnvBindings {
  switch (access.kind) {
    case "static":
    case "refresh-token":
      return access.envBindings;
    case "none":
    case "automatic":
      return {};
  }
}

function connectorAccessRuntimeEnvBindings(
  access: ConnectorAccessConfig,
): ConnectorRuntimeEnvBindings {
  return connectorRuntimeEnvBindings(connectorAccessEnvBindings(access));
}

function connectorAccessPlatformSecrets(
  access: ConnectorAccessConfig,
): readonly ConnectorPlatformSecretName[] {
  switch (access.kind) {
    case "static":
    case "refresh-token":
      return access.platformSecrets ?? [];
    case "none":
    case "automatic":
      return [];
  }
}

export type ConnectorAuthMethodAccessMetadata =
  | {
      readonly kind: "automatic";
      readonly envBindings: ConnectorRuntimeEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    }
  | {
      readonly kind: "static";
      readonly envBindings: ConnectorRuntimeEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    }
  | {
      readonly kind: "refresh-token";
      readonly inputs: Readonly<
        Record<string, ConnectorRefreshTokenInputMetadata>
      >;
      readonly outputs: Readonly<
        Record<string, ConnectorRefreshTokenOutputMetadata>
      >;
      readonly refreshableSecrets: readonly string[];
      readonly envBindings: ConnectorRuntimeEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    }
  | {
      readonly kind: "none";
      readonly envBindings: ConnectorRuntimeEnvBindings;
      readonly platformSecrets: readonly ConnectorPlatformSecretName[];
    };

export type ConnectorRefreshTokenAccessMetadata = Extract<
  ConnectorAuthMethodAccessMetadata,
  { readonly kind: "refresh-token" }
>;

export interface ConnectorRefreshTokenInputMetadata {
  readonly valueRef: string;
  readonly source: Extract<
    ConnectorRuntimeBindingSource,
    { readonly kind: "connector-secret" | "connector-variable" }
  >;
}

export interface ConnectorRefreshTokenOutputMetadata {
  readonly valueRef: string;
  readonly target: ConnectorOutputTarget;
}

export interface ConnectorRefreshTokenMetadata {
  readonly inputs: Readonly<Record<string, ConnectorRefreshTokenInputMetadata>>;
  readonly outputs: Readonly<
    Record<string, ConnectorRefreshTokenOutputMetadata>
  >;
  readonly refreshableSecrets: readonly string[];
}

export interface ConnectorGrantOutputMetadata {
  readonly valueRef: string;
  readonly target: ConnectorOutputTarget;
}

export type ConnectorAuthMethodGrantMetadata =
  | {
      readonly kind:
        | "auth-code"
        | "openid-auth"
        | "external-code"
        | "device-auth";
      readonly outputs: Readonly<Record<string, ConnectorGrantOutputMetadata>>;
    }
  | {
      readonly kind: "none" | "manual" | "managed" | "automatic";
      readonly outputs: Readonly<Record<string, ConnectorGrantOutputMetadata>>;
    };

export interface ConnectorRevokeInputMetadata {
  readonly valueRef: string;
  readonly secretName: string;
}

export type ConnectorAuthMethodRevokeMetadata =
  | {
      readonly kind: "token-revoke";
      readonly inputs: Readonly<Record<string, ConnectorRevokeInputMetadata>>;
    }
  | {
      readonly kind: "none";
      readonly inputs: Readonly<Record<string, ConnectorRevokeInputMetadata>>;
    };

export type ConnectorRuntimeBindingSource =
  | {
      readonly kind: "connector-secret";
      readonly name: string;
    }
  | {
      readonly kind: "connector-variable";
      readonly name: string;
    }
  | {
      readonly kind: "platform-secret";
      readonly name: ConnectorPlatformSecretName;
    };

export type ConnectorOutputTarget =
  | {
      readonly kind: "connector-secret";
      readonly name: string;
    }
  | {
      readonly kind: "connector-variable";
      readonly name: string;
    };

export interface ConnectorRuntimeBindingEntry {
  readonly envName: string;
  readonly valueRef: string;
  readonly optional: boolean;
  readonly source: ConnectorRuntimeBindingSource;
}

export interface ConnectorAuthMethodRuntimeMetadata {
  readonly storage: {
    readonly version: number;
    readonly secrets: readonly string[];
    readonly variables: readonly string[];
  };
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
}

function isConnectorSecretValueRef(
  valueRef: ConnectorOutputValueRef,
): valueRef is ConnectorSecretValueRef {
  return valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX);
}

function connectorSecretNameFromValueRef(
  valueRef: ConnectorSecretValueRef,
): string {
  return valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
}

function connectorVariableNameFromValueRef(
  valueRef: ConnectorVariableValueRef,
): string {
  return valueRef.slice(CONNECTOR_VARIABLE_REF_PREFIX.length);
}

function connectorRefreshInputMetadata(
  valueRef: ConnectorRefreshTokenInputValueRef,
): ConnectorRefreshTokenInputMetadata {
  if (isConnectorSecretValueRef(valueRef)) {
    return {
      valueRef,
      source: {
        kind: "connector-secret",
        name: connectorSecretNameFromValueRef(valueRef),
      },
    };
  }

  const variableName = connectorVariableNameFromValueRef(valueRef);
  return {
    valueRef,
    source: { kind: "connector-variable", name: variableName },
  };
}

function connectorRefreshOutputMetadata(
  valueRef: ConnectorOutputValueRef,
): ConnectorRefreshTokenOutputMetadata {
  return {
    valueRef,
    target: connectorOutputTargetFromValueRef(valueRef),
  };
}

function connectorGrantOutputMetadata(
  valueRef: ConnectorOutputValueRef,
): ConnectorGrantOutputMetadata {
  return connectorRefreshOutputMetadata(valueRef);
}

function connectorOutputTargetFromValueRef(
  valueRef: ConnectorOutputValueRef,
): ConnectorOutputTarget {
  if (isConnectorSecretValueRef(valueRef)) {
    return {
      kind: "connector-secret",
      name: connectorSecretNameFromValueRef(valueRef),
    };
  }

  return {
    kind: "connector-variable",
    name: connectorVariableNameFromValueRef(valueRef),
  };
}

function connectorRevokeInputMetadata(
  valueRef: ConnectorSecretValueRef,
): ConnectorRevokeInputMetadata {
  return { valueRef, secretName: connectorSecretNameFromValueRef(valueRef) };
}

function connectorRefreshMetadata(args: {
  readonly inputs: ConnectorRefreshTokenInputBindings;
  readonly outputs: ConnectorRefreshTokenOutputBindings;
  readonly refreshableSecrets: readonly string[];
}): ConnectorRefreshTokenMetadata {
  return {
    inputs: Object.fromEntries(
      Object.entries(args.inputs).map(([name, valueRef]) => {
        return [name, connectorRefreshInputMetadata(valueRef)];
      }),
    ),
    outputs: Object.fromEntries(
      Object.entries(args.outputs).map(([name, valueRef]) => {
        return [name, connectorRefreshOutputMetadata(valueRef)];
      }),
    ),
    refreshableSecrets: [...args.refreshableSecrets],
  };
}

export function connectorAuthMethodAccessMetadata(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthMethodAccessMetadata {
  switch (method.access.kind) {
    case "static": {
      return {
        kind: "static",
        envBindings: connectorAccessRuntimeEnvBindings(method.access),
        platformSecrets: method.access.platformSecrets ?? [],
      };
    }
    case "refresh-token":
      return {
        kind: "refresh-token",
        ...connectorRefreshMetadata(method.access),
        envBindings: connectorAccessRuntimeEnvBindings(method.access),
        platformSecrets: method.access.platformSecrets ?? [],
      };
    case "none":
    case "automatic":
      return {
        kind: method.access.kind,
        envBindings: {},
        platformSecrets: [],
      };
  }
}

function connectorGrantOutputMetadataMap(
  outputs: ConnectorGrantOutputBindings,
): Record<string, ConnectorGrantOutputMetadata> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, valueRef]) => {
      return [name, connectorGrantOutputMetadata(valueRef)];
    }),
  );
}

export function connectorAuthMethodGrantMetadata(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthMethodGrantMetadata {
  switch (method.grant.kind) {
    case "auth-code":
    case "openid-auth":
    case "external-code":
    case "device-auth":
    case "automatic":
      return {
        kind: method.grant.kind,
        outputs: connectorGrantOutputMetadataMap(method.grant.outputs),
      };
    case "none":
    case "manual":
    case "managed":
      return {
        kind: method.grant.kind,
        outputs: {},
      };
  }
}

export function getConnectorGrantOutputTarget(
  metadata: ConnectorAuthMethodGrantMetadata,
  outputName: string,
): ConnectorOutputTarget | undefined {
  return metadata.outputs[outputName]?.target;
}

function connectorRevokeInputMetadataMap(
  inputs: ConnectorRevokeInputBindings,
): Record<string, ConnectorRevokeInputMetadata> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, valueRef]) => {
      return [name, connectorRevokeInputMetadata(valueRef)];
    }),
  );
}

export function connectorAuthMethodRevokeMetadata(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthMethodRevokeMetadata {
  switch (method.revoke.kind) {
    case "token-revoke":
      return {
        kind: "token-revoke",
        inputs: connectorRevokeInputMetadataMap(method.revoke.inputs),
      };
    case "none":
      return {
        kind: "none",
        inputs: {},
      };
  }
}

export function getConnectorRefreshOutputTarget(
  metadata: ConnectorAuthMethodAccessMetadata,
  outputName: string,
): ConnectorOutputTarget | undefined {
  return metadata.kind === "refresh-token"
    ? metadata.outputs[outputName]?.target
    : undefined;
}

export function getConnectorRuntimeBindingSecretName(
  metadata: ConnectorAuthMethodRuntimeMetadata,
  envName: string,
): string | undefined {
  const binding = metadata.runtimeBindings.find((entry) => {
    return (
      entry.envName === envName && entry.source.kind === "connector-secret"
    );
  });
  return binding?.source.kind === "connector-secret"
    ? binding.source.name
    : undefined;
}

export function getConnectorRuntimeBindingPlatformSecretName(
  metadata: ConnectorAuthMethodRuntimeMetadata,
  envName: string,
): ConnectorPlatformSecretName | undefined {
  const binding = metadata.runtimeBindings.find((entry) => {
    return entry.envName === envName && entry.source.kind === "platform-secret";
  });
  return binding?.source.kind === "platform-secret"
    ? binding.source.name
    : undefined;
}

export function connectorRefreshMetadataHasRefreshableSecret(
  metadata: ConnectorAuthMethodAccessMetadata,
  secretName: string,
): boolean {
  return (
    metadata.kind === "refresh-token" &&
    metadata.refreshableSecrets.includes(secretName)
  );
}

function connectorPlatformSecretSource(
  secretName: string,
  platformSecrets: readonly ConnectorPlatformSecretName[],
): ConnectorPlatformSecretName | undefined {
  return platformSecrets.find((platformSecret) => {
    return platformSecret === secretName;
  });
}

export type ConnectorRuntimeEnvBindings = Record<
  string,
  ConnectorRefreshTokenInputValueRef
>;

function connectorEnvBindingValueRef(
  binding: ConnectorEnvBindingValue,
): ConnectorRefreshTokenInputValueRef {
  return typeof binding === "string" ? binding : binding.valueRef;
}

function connectorEnvBindingIsOptional(
  binding: ConnectorEnvBindingValue,
): boolean {
  return typeof binding === "string" ? false : (binding.optional ?? false);
}

function connectorRuntimeEnvBindings(
  envBindings: ConnectorEnvBindings,
): ConnectorRuntimeEnvBindings {
  return Object.fromEntries(
    Object.entries(envBindings).map(([envName, binding]) => {
      return [envName, connectorEnvBindingValueRef(binding)];
    }),
  );
}

function connectorRuntimeBindingEntries(args: {
  readonly envBindings: ConnectorEnvBindings;
  readonly platformSecrets: readonly ConnectorPlatformSecretName[];
}): ConnectorRuntimeBindingEntry[] {
  const entries: ConnectorRuntimeBindingEntry[] = [];
  for (const [envName, binding] of Object.entries(args.envBindings)) {
    const valueRef = connectorEnvBindingValueRef(binding);
    const optional = connectorEnvBindingIsOptional(binding);
    if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
      const secretName = valueRef.slice(CONNECTOR_SECRET_REF_PREFIX.length);
      const platformSecret = connectorPlatformSecretSource(
        secretName,
        args.platformSecrets,
      );
      entries.push({
        envName,
        valueRef,
        optional,
        source: platformSecret
          ? { kind: "platform-secret", name: platformSecret }
          : { kind: "connector-secret", name: secretName },
      });
      continue;
    }

    if (valueRef.startsWith(CONNECTOR_VARIABLE_REF_PREFIX)) {
      entries.push({
        envName,
        valueRef,
        optional,
        source: {
          kind: "connector-variable",
          name: valueRef.slice(CONNECTOR_VARIABLE_REF_PREFIX.length),
        },
      });
    }
  }
  return entries;
}

export function connectorAuthMethodRuntimeMetadata(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorAuthMethodRuntimeMetadata {
  const platformSecrets = connectorAccessPlatformSecrets(method.access);
  return {
    storage: {
      version: method.storage.version,
      secrets: [...method.storage.secrets],
      variables: [...method.storage.variables],
    },
    runtimeBindings: connectorRuntimeBindingEntries({
      envBindings: connectorAccessEnvBindings(method.access),
      platformSecrets,
    }),
  };
}

export function connectorAuthMethodEnvBindings(
  method: ConnectorAuthMethodRuntimeConfig,
): ConnectorRuntimeEnvBindings {
  return connectorAccessRuntimeEnvBindings(method.access);
}

export function connectorOpenIdAuthGrantCallbackOrigin(
  grant: ConnectorOpenIdAuthGrantConfig,
): ConnectorBrowserAuthCallbackOrigin {
  return grant.callbackOrigin ?? "api";
}
export function connectorAuthCodeGrantCallbackOrigin(
  grant: ConnectorAuthCodeGrantConfig,
): ConnectorAuthCodeCallbackOrigin {
  return grant.callbackOrigin ?? DEFAULT_AUTH_CODE_CALLBACK_ORIGIN;
}
export type ConnectorDeviceAuthStartOptionsParseResult =
  | {
      readonly success: true;
      readonly options: ConnectorDeviceAuthStartOptions;
    }
  | {
      readonly success: false;
      readonly message: string;
    };

function parseConnectorDeviceAuthStartOption(args: {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly optionName: string;
  readonly config: ConnectorDeviceAuthStartOptionConfig;
  readonly requestedValue: string | undefined;
}): ConnectorDeviceAuthStartOptionsParseResult {
  const value = args.requestedValue ?? args.config.defaultValue;
  if (value === undefined) {
    if (args.config.required) {
      return {
        success: false,
        message: `${args.connectorSlug} ${args.authMethodId} device-auth start option ${args.optionName} is required`,
      };
    }
    return { success: true, options: {} };
  }

  switch (args.config.kind) {
    case "select": {
      if (
        !args.config.options.some((option) => {
          return option.value === value;
        })
      ) {
        return {
          success: false,
          message: `${args.connectorSlug} ${args.authMethodId} device-auth start option ${args.optionName} must be one of: ${args.config.options
            .map((option) => {
              return option.value;
            })
            .join(", ")}`,
        };
      }
      return { success: true, options: { [args.optionName]: value } };
    }
  }
}

function connectorDeviceAuthStartOptionValue(
  options: ConnectorDeviceAuthStartOptions | undefined,
  optionName: string,
): string | undefined {
  if (!options || !Object.hasOwn(options, optionName)) {
    return undefined;
  }
  return options[optionName];
}

export function parseConnectorDeviceAuthStartOptionsConfig(args: {
  readonly connectorSlug: string;
  readonly authMethodId: string;
  readonly startOptions: ConnectorDeviceAuthStartOptionsConfig | undefined;
  readonly options: ConnectorDeviceAuthStartOptions | undefined;
}): ConnectorDeviceAuthStartOptionsParseResult {
  const configuredOptions = args.startOptions;
  const requestedOptionKeys = Object.keys(args.options ?? {});

  if (!configuredOptions || Object.keys(configuredOptions).length === 0) {
    if (requestedOptionKeys.length === 0) {
      return { success: true, options: {} };
    }
    return {
      success: false,
      message: `${args.connectorSlug} ${args.authMethodId} device-auth start options are not supported: ${requestedOptionKeys.join(", ")}`,
    };
  }

  for (const optionName of requestedOptionKeys) {
    if (!Object.hasOwn(configuredOptions, optionName)) {
      return {
        success: false,
        message: `${args.connectorSlug} ${args.authMethodId} device-auth start option ${optionName} is not supported`,
      };
    }
  }

  const normalizedOptions: Record<string, string> = {};
  for (const [optionName, config] of Object.entries(configuredOptions)) {
    const parsedOption = parseConnectorDeviceAuthStartOption({
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethodId,
      optionName,
      config,
      requestedValue: connectorDeviceAuthStartOptionValue(
        args.options,
        optionName,
      ),
    });
    if (!parsedOption.success) {
      return parsedOption;
    }
    for (const [parsedOptionName, parsedOptionValue] of Object.entries(
      parsedOption.options,
    )) {
      normalizedOptions[parsedOptionName] = parsedOptionValue;
    }
  }

  return { success: true, options: normalizedOptions };
}
export function connectorGrantScopes(
  grant: ConnectorGrantConfig | undefined,
): readonly string[] {
  switch (grant?.kind) {
    case "auth-code":
    case "external-code":
    case "device-auth":
      return grant.scopes;
    case "openid-auth":
    case "none":
    case "automatic":
    case "manual":
    case "managed":
    case undefined:
      return [];
  }
}
export type ConnectorEnvReader = (name: string) => string | undefined;

export type StaticConfidentialConnectorAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "confidential";
  readonly clientId: string;
  readonly clientSecret: string;
};

export type StaticConfidentialConnectorAuthClientIdentity = {
  readonly clientRegistration: "static";
  readonly clientType: "confidential";
  readonly clientId: string;
};

export type StaticPublicConnectorAuthClient = {
  readonly clientRegistration: "static";
  readonly clientType: "public";
  readonly clientId: string;
};

export type DynamicPublicConnectorAuthClient = {
  readonly clientRegistration: "dynamic";
  readonly clientType: "public";
};

export type StaticConnectorAuthClient =
  | StaticConfidentialConnectorAuthClient
  | StaticPublicConnectorAuthClient;

export type ConnectorAuthClient =
  | StaticConnectorAuthClient
  | DynamicPublicConnectorAuthClient;

export type ConnectorAuthClientIdentity =
  | StaticConfidentialConnectorAuthClientIdentity
  | StaticPublicConnectorAuthClient
  | DynamicPublicConnectorAuthClient;

export type ConnectorAuthClientForConfig<
  Client extends ConnectorAuthClientConfig,
> = Client extends StaticConfidentialConnectorAuthClientConfig
  ? StaticConfidentialConnectorAuthClient
  : Client extends StaticPublicConnectorAuthClientConfig
    ? StaticPublicConnectorAuthClient
    : Client extends DynamicPublicConnectorAuthClientConfig
      ? DynamicPublicConnectorAuthClient
      : never;

export type ConnectorAuthClientIdentityForConfig<
  Client extends ConnectorAuthClientConfig,
> = Client extends StaticConfidentialConnectorAuthClientConfig
  ? StaticConfidentialConnectorAuthClientIdentity
  : Client extends StaticPublicConnectorAuthClientConfig
    ? StaticPublicConnectorAuthClient
    : Client extends DynamicPublicConnectorAuthClientConfig
      ? DynamicPublicConnectorAuthClient
      : never;

export function isStaticConnectorAuthClient(
  authClient: ConnectorAuthClient,
): authClient is StaticConnectorAuthClient {
  return authClient.clientRegistration === "static";
}

export function isStaticConfidentialConnectorAuthClient(
  authClient: ConnectorAuthClient,
): authClient is StaticConfidentialConnectorAuthClient {
  return (
    isStaticConnectorAuthClient(authClient) &&
    authClient.clientType === "confidential"
  );
}

export function connectorAuthClientIdentity(
  authClient: StaticConfidentialConnectorAuthClient,
): StaticConfidentialConnectorAuthClientIdentity;
export function connectorAuthClientIdentity(
  authClient: StaticPublicConnectorAuthClient,
): StaticPublicConnectorAuthClient;
export function connectorAuthClientIdentity(
  authClient: DynamicPublicConnectorAuthClient,
): DynamicPublicConnectorAuthClient;
export function connectorAuthClientIdentity(
  authClient: ConnectorAuthClient,
): ConnectorAuthClientIdentity;
export function connectorAuthClientIdentity(
  authClient: ConnectorAuthClient,
): ConnectorAuthClientIdentity {
  switch (authClient.clientRegistration) {
    case "dynamic":
      return authClient;
    case "static":
      return {
        clientRegistration: "static",
        clientType: authClient.clientType,
        clientId: authClient.clientId,
      };
  }
}

export function resolveConnectorAuthClient<
  Client extends ConnectorAuthClientConfig,
>(
  client: Client,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClientForConfig<Client> | undefined;
export function resolveConnectorAuthClient(
  client: ConnectorAuthClientConfig,
  readEnv: ConnectorEnvReader,
): ConnectorAuthClient | undefined {
  if (client.clientRegistration === "dynamic") {
    return { clientRegistration: "dynamic", clientType: "public" };
  }

  if ("clientId" in client) {
    if (client.clientType === "confidential") {
      return {
        clientRegistration: "static",
        clientType: "confidential",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      };
    }
    return {
      clientRegistration: "static",
      clientType: "public",
      clientId: client.clientId,
    };
  }

  const clientId = readEnv(client.clientIdEnv);
  if (!clientId) {
    return undefined;
  }

  if (client.clientType === "public") {
    return { clientRegistration: "static", clientType: "public", clientId };
  }

  const clientSecret = readEnv(client.clientSecretEnv);
  if (!clientSecret) {
    return undefined;
  }

  return {
    clientRegistration: "static",
    clientType: "confidential",
    clientId,
    clientSecret,
  };
}
export function connectorAuthMethodOwnedSecretNames(
  method: ConnectorAuthMethodRuntimeConfig | undefined,
): string[] {
  return method ? [...method.storage.secrets] : [];
}

export function connectorAuthMethodOwnedVariableNames(
  method: ConnectorAuthMethodRuntimeConfig | undefined,
): string[] {
  return method ? [...method.storage.variables] : [];
}
function hasRequiredGrantScopes(
  requiredScopes: readonly string[],
  storedScopes: readonly string[] | null,
): boolean {
  if (requiredScopes.length === 0) return true;
  if (!storedScopes) return false;
  const storedSet = new Set(storedScopes);
  return requiredScopes.every((s) => {
    return storedSet.has(s);
  });
}

/** Compare the current authorization request with its stored request snapshot. */
export interface ScopeDiff {
  addedScopes: string[];
  removedScopes: string[];
  currentScopes: string[];
  storedScopes: string[];
}

function scopeDiff(
  currentScopes: readonly string[],
  storedScopes: readonly string[] | null,
): ScopeDiff {
  const stored = storedScopes ?? [];
  const storedSet = new Set(stored);
  const currentSet = new Set(currentScopes);

  return {
    addedScopes: currentScopes.filter((s) => {
      return !storedSet.has(s);
    }),
    removedScopes: stored.filter((s) => {
      return !currentSet.has(s);
    }),
    currentScopes: [...currentScopes],
    storedScopes: [...stored],
  };
}
export function connectorAuthMethodScopeDiff(
  method: ConnectorAuthMethodRuntimeConfig,
  storedScopes: readonly string[] | null,
): ScopeDiff {
  return scopeDiff(connectorGrantScopes(method.grant), storedScopes);
}

export function connectorAuthMethodHasRequiredScopes(
  method: ConnectorAuthMethodRuntimeConfig,
  storedScopes: readonly string[] | null,
): boolean {
  return hasRequiredGrantScopes(
    connectorGrantScopes(method.grant),
    storedScopes,
  );
}
