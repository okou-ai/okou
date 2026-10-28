import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
} from "./artifacts";
import {
  isPrivateTokenLikeKey,
  privateTokenMatches,
} from "./private-token-patterns";
import { deriveConnectorCatalogFirewallPermissions } from "./relationships";

const forbiddenPublicPropertyNamePattern =
  /^(access|client|clientId|clientIdEnv|clientSecret|clientSecretEnv|envBindings|featureFlag|inputs|objectKey|outputs|platformSecrets|privateName|refreshableSecrets|revoke|r2Key|scopes|secret|secrets|showExperimentalLabel|skillRef|sourcePath|storage|storageName|storageVersionPrefix|variables|valueRef|versionId)$/u;

function normalizeSensitiveString(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
}

function shouldCheckDerivedSensitiveValue(path: string): boolean {
  return (
    path.endsWith(".placeholder") ||
    path.endsWith(".defaultValue") ||
    path.endsWith(".value")
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addSensitiveValue(value: string, values: Set<string>): void {
  values.add(value);
  for (const match of privateTokenMatches(value)) {
    values.add(match);
  }
}

function addValueRef(valueRef: string, values: Set<string>): void {
  addSensitiveValue(valueRef, values);
  const separator = valueRef.indexOf(".");
  addSensitiveValue(valueRef.slice(separator + 1), values);
}

function addBindingValues(
  bindings: Readonly<Record<string, string | undefined>>,
  values: Set<string>,
): void {
  for (const valueRef of Object.values(bindings)) {
    if (valueRef !== undefined) {
      addValueRef(valueRef, values);
    }
  }
}

function addAccessSensitiveValues(
  access: ConnectorCatalogAuthMethod["access"],
  values: Set<string>,
): void {
  for (const [name, binding] of Object.entries(
    "envBindings" in access ? access.envBindings : {},
  )) {
    addSensitiveValue(name, values);
    addValueRef(
      typeof binding === "string" ? binding : binding.valueRef,
      values,
    );
  }
  for (const name of "platformSecrets" in access
    ? (access.platformSecrets ?? [])
    : []) {
    addSensitiveValue(name, values);
  }
  if (access.kind === "refresh-token" || access.kind === "automatic") {
    addBindingValues(access.inputs, values);
    addBindingValues(access.outputs, values);
  }
  if (access.kind === "refresh-token") {
    for (const name of access.refreshableSecrets) {
      addSensitiveValue(name, values);
    }
  }
}

function connectorCatalogSensitiveValues(
  connector: ConnectorCatalogArtifactConnector,
): ReadonlySet<string> {
  const values = new Set<string>();
  if (connector.skill.kind === "bundled") {
    addSensitiveValue(connector.skill.storageName, values);
    addSensitiveValue(connector.skill.versionId, values);
    addSensitiveValue(connector.skill.storageVersionPrefix, values);
  }
  for (const authMethod of connector.authMethods) {
    for (const name of authMethod.storage.secrets) {
      addSensitiveValue(name, values);
    }
    for (const name of authMethod.storage.variables) {
      addSensitiveValue(name, values);
    }
    if (authMethod.client?.clientRegistration === "static") {
      if (authMethod.client.clientType === "confidential") {
        if ("clientIdEnv" in authMethod.client) {
          addSensitiveValue(authMethod.client.clientIdEnv, values);
          addSensitiveValue(authMethod.client.clientSecretEnv, values);
        } else {
          addSensitiveValue(authMethod.client.clientId, values);
          addSensitiveValue(authMethod.client.clientSecret, values);
        }
      } else {
        addSensitiveValue(authMethod.client.clientId, values);
      }
    }
    if (authMethod.grant.kind === "manual") {
      for (const field of authMethod.grant.fields) {
        addSensitiveValue(field.privateName, values);
      }
    } else if ("outputs" in authMethod.grant) {
      addBindingValues(authMethod.grant.outputs, values);
    }
    addAccessSensitiveValues(authMethod.access, values);
    if (authMethod.revoke.kind === "token-revoke") {
      addBindingValues(authMethod.revoke.inputs, values);
    }
  }
  return values;
}

interface SensitiveValues {
  readonly exact: ReadonlySet<string>;
  readonly derived: readonly string[];
}

function prepareSensitiveValues(exact: ReadonlySet<string>): SensitiveValues {
  const derived: string[] = [];
  for (const value of exact) {
    if (value.includes("_")) {
      const normalized = normalizeSensitiveString(value);
      if (normalized.length >= 8) {
        derived.push(normalized);
      }
    }
  }
  return { exact, derived };
}

function assertNoSensitiveString(args: {
  readonly value: string;
  readonly path: string;
  readonly sensitiveValues: SensitiveValues;
}): void {
  for (const sensitiveValue of args.sensitiveValues.exact) {
    if (sensitiveValue.length === 0) {
      continue;
    }
    if (args.value.includes(sensitiveValue)) {
      throw new Error(
        `Public connector catalog projection leaked private value at ${args.path}`,
      );
    }
  }
  if (
    args.sensitiveValues.derived.length > 0 &&
    shouldCheckDerivedSensitiveValue(args.path)
  ) {
    const normalizedValue = normalizeSensitiveString(args.value);
    for (const sensitiveValue of args.sensitiveValues.derived) {
      if (normalizedValue.includes(sensitiveValue)) {
        throw new Error(
          `Public connector catalog projection leaked private value at ${args.path}`,
        );
      }
    }
  }
}

function assertPublicValueHasNoPrivateFields(
  value: unknown,
  sensitiveValues: SensitiveValues,
  path = "$",
): void {
  if (typeof value === "string") {
    assertNoSensitiveString({ value, path, sensitiveValues });
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertPublicValueHasNoPrivateFields(
        child,
        sensitiveValues,
        `${path}[${index}]`,
      );
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const allowsPublicMapKeys = path.endsWith(".byPermission");
  for (const [key, child] of Object.entries(value)) {
    if (
      !allowsPublicMapKeys &&
      (forbiddenPublicPropertyNamePattern.test(key) ||
        isPrivateTokenLikeKey(key))
    ) {
      throw new Error(
        `Public connector catalog projection leaked private property ${key} at ${path}`,
      );
    }
    assertPublicValueHasNoPrivateFields(
      child,
      sensitiveValues,
      `${path}.${key}`,
    );
  }
}

function publicFirewall(connector: ConnectorCatalogArtifactConnector): unknown {
  if (connector.firewall.kind === "none") {
    return connector.firewall;
  }
  return {
    kind: "generated",
    permissions: deriveConnectorCatalogFirewallPermissions(
      connector.firewall.config.apis,
    ),
    categories: connector.firewall.categories,
    defaultAllowed: connector.firewall.defaultAllowed,
    defaultUnknownPolicy: connector.firewall.defaultUnknownPolicy,
  };
}

function publicGrant(
  method: ConnectorCatalogArtifactConnector["authMethods"][number],
) {
  switch (method.grant.kind) {
    case "manual": {
      return {
        kind: method.grant.kind,
        fields: method.grant.fields.map((field) => {
          return {
            id: field.publicId,
            label: field.label,
            required: field.required,
            placeholder: field.placeholder,
            inputType: field.storage === "secret" ? "password" : "text",
          };
        }),
      };
    }
    case "device-auth": {
      return {
        kind: method.grant.kind,
        startOptions: method.grant.startOptions.map((option) => {
          return {
            id: option.publicId,
            kind: option.kind,
            label: option.label,
            required: option.required,
            defaultValue: option.defaultValue,
            options: option.options,
          };
        }),
      };
    }
    case "auth-code":
    case "external-code":
    case "openid-auth":
    case "none":
    case "automatic": {
      return { kind: method.grant.kind };
    }
  }
}

function publicConnector(connector: ConnectorCatalogArtifactConnector) {
  return {
    slug: connector.slug,
    label: connector.label,
    description: connector.description,
    category: connector.category,
    generation: connector.generation,
    tags: connector.tags,
    ...(connector.mcp === undefined ? {} : { mcp: connector.mcp }),
    authMethods: connector.authMethods.map((method) => {
      return {
        id: method.id,
        label: method.label,
        description: method.description,
        visible: method.visible,
        grant: publicGrant(method),
      };
    }),
    icon: connector.icon,
    firewall: publicFirewall(connector),
  };
}

export function validateConnectorCatalogPublicProjection(
  artifact: ConnectorCatalogArtifact,
): void {
  assertPublicValueHasNoPrivateFields(
    {
      artifactSchemaVersion: artifact.artifactSchemaVersion,
      catalogVersion: artifact.catalogVersion,
      categoryMetadata: artifact.categoryMetadata,
    },
    { exact: new Set(), derived: [] },
  );
  for (const connector of artifact.connectors) {
    // A connector slug is public identity even when a private storage name
    // produces the same credential-like token. Exclude only the exact slug.
    const sensitiveValues = new Set(connectorCatalogSensitiveValues(connector));
    sensitiveValues.delete(connector.slug);
    assertPublicValueHasNoPrivateFields(
      publicConnector(connector),
      prepareSensitiveValues(sensitiveValues),
      `$.connectors[${connector.slug}]`,
    );
  }
}
