import { API_TEST_CONNECTOR_CATALOG } from "../../../../test-fixtures/connector-catalog";
import type { ConnectorCatalogAuthMethod } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

interface SensitiveStringValues {
  readonly byConnector: ReadonlyMap<string, ReadonlySet<string>>;
  readonly global: ReadonlySet<string>;
}

function addAccessSensitiveValues(
  values: Set<string>,
  access: ConnectorCatalogAuthMethod["access"],
): void {
  if (access.kind === "automatic") {
    for (const valueRef of Object.values(access.inputs)) {
      values.add(valueRef.slice(valueRef.indexOf(".") + 1));
    }
    return;
  }
  for (const [name, binding] of Object.entries(access.envBindings)) {
    values.add(name);
    const valueRef = typeof binding === "string" ? binding : binding.valueRef;
    values.add(valueRef.slice(valueRef.indexOf(".") + 1));
  }
  for (const name of access.platformSecrets ?? []) {
    values.add(name);
  }
  if (access.kind === "refresh-token") {
    for (const valueRef of [
      ...Object.values(access.inputs),
      ...Object.values(access.outputs),
    ]) {
      values.add(valueRef.slice(valueRef.indexOf(".") + 1));
    }
    for (const name of access.refreshableSecrets) {
      values.add(name);
    }
  }
}

function sensitiveStringValues(): SensitiveStringValues {
  const valuesByConnector = new Map<string, Set<string>>();

  for (const connector of API_TEST_CONNECTOR_CATALOG.connectors) {
    const values = new Set<string>();
    for (const method of connector.authMethods) {
      for (const name of [
        ...method.storage.secrets,
        ...method.storage.variables,
      ]) {
        values.add(name);
      }
      if (method.client !== undefined) {
        if ("clientIdEnv" in method.client) {
          values.add(method.client.clientIdEnv);
        }
        if ("clientSecretEnv" in method.client) {
          values.add(method.client.clientSecretEnv);
        }
      }
      if (method.grant.kind === "manual") {
        for (const field of method.grant.fields) {
          values.add(field.privateName);
        }
      } else if ("outputs" in method.grant) {
        for (const valueRef of Object.values(method.grant.outputs)) {
          values.add(valueRef.slice(valueRef.indexOf(".") + 1));
        }
      }
      addAccessSensitiveValues(values, method.access);
      if (method.revoke.kind === "token-revoke") {
        for (const valueRef of Object.values(method.revoke.inputs)) {
          values.add(valueRef.slice(valueRef.indexOf(".") + 1));
        }
      }
    }
    valuesByConnector.set(connector.slug, values);
  }

  return {
    byConnector: valuesByConnector,
    global: new Set(
      [...valuesByConnector.values()].flatMap((values) => {
        return [...values];
      }),
    ),
  };
}

function normalizeSensitiveString(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function shouldCheckDerivedSensitiveValue(path: string): boolean {
  return (
    path.endsWith(".placeholder") ||
    path.endsWith(".defaultValue") ||
    path.endsWith(".value")
  );
}

function isSensitivePropertyName(key: string): boolean {
  return [
    "storage",
    "secrets",
    "variables",
    "envBindings",
    "valueRef",
    "source",
    "target",
    "platformSecrets",
    "client",
    "clientIdEnv",
    "clientSecretEnv",
    "clientSecret",
    "scopes",
    "outputs",
    "inputs",
    "refreshableSecrets",
    "revoke",
    "access",
    "featureFlag",
    "showExperimentalLabel",
    "placeholderValues",
    "baseUrlTemplates",
    "secretPlaceholderNames",
    "manifestKey",
    "bucket",
    "objectKey",
    "signedUrl",
  ].includes(key);
}

function assertNoSensitiveString(
  value: string,
  path: string,
  sensitiveValues: SensitiveStringValues,
  connectorSensitiveValues: ReadonlySet<string> | undefined,
): void {
  const normalizedValue = normalizeSensitiveString(value);
  for (const sensitiveValue of sensitiveValues.global) {
    if (value.includes(sensitiveValue)) {
      throw new Error(
        `Public connector catalog response leaked ${sensitiveValue} at ${path}`,
      );
    }
  }
  if (!connectorSensitiveValues || !shouldCheckDerivedSensitiveValue(path)) {
    return;
  }
  for (const sensitiveValue of connectorSensitiveValues) {
    const normalizedSensitiveValue = normalizeSensitiveString(sensitiveValue);
    if (
      sensitiveValue.includes("_") &&
      normalizedSensitiveValue.length >= 8 &&
      normalizedValue.includes(normalizedSensitiveValue)
    ) {
      throw new Error(
        `Public connector catalog response leaked ${sensitiveValue} at ${path}`,
      );
    }
  }
}

function assertNoSensitiveProperties(
  value: object,
  path: string,
  sensitiveValues: SensitiveStringValues,
  connectorSensitiveValues: ReadonlySet<string> | undefined,
): void {
  const nextConnectorSensitiveValues =
    "slug" in value && typeof value.slug === "string"
      ? sensitiveValues.byConnector.get(value.slug)
      : connectorSensitiveValues;

  for (const [key, child] of Object.entries(value)) {
    if (isSensitivePropertyName(key)) {
      throw new Error(
        `Public connector catalog response leaked private property ${key} at ${path}`,
      );
    }
    assertPublicConnectorCatalogHasNoPrivateFields(
      child,
      `${path}.${key}`,
      sensitiveValues,
      nextConnectorSensitiveValues,
    );
  }
}

export function assertPublicConnectorCatalogHasNoPrivateFields(
  value: unknown,
  path = "$",
  sensitiveValues: SensitiveStringValues = sensitiveStringValues(),
  connectorSensitiveValues?: ReadonlySet<string>,
): void {
  if (typeof value === "string") {
    assertNoSensitiveString(
      value,
      path,
      sensitiveValues,
      connectorSensitiveValues,
    );
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      assertPublicConnectorCatalogHasNoPrivateFields(
        child,
        `${path}[${index}]`,
        sensitiveValues,
        connectorSensitiveValues,
      );
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    assertNoSensitiveProperties(
      value,
      path,
      sensitiveValues,
      connectorSensitiveValues,
    );
  }
}
