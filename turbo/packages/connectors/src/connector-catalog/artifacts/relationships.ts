import { isDeepStrictEqual } from "node:util";

import {
  extractFirewallTemplateReferences,
  normalizeFirewallFixedHost,
  type FirewallBaseHostPolicy,
  type FirewallConfig,
} from "../../firewall-types";

import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
  ConnectorCatalogAuthMethod,
} from "./artifacts";
import {
  firewallAuthInjectsCredentials,
  firewallBaseVariableNames,
  firewallTemplateReferences,
  parseFirewallBaseUrl,
  validateFirewallGeneratorResult,
} from "./firewall";
import {
  catalogSourceSchema,
  connectorSourceSchema,
  validateCatalogSourceSemantics,
  validateConnectorSourceSemantics,
  type ConnectorGrantSource,
} from "./source";

import { ConnectorCatalogRelationshipError } from "./relationship-error";

const MODEL_PROVIDER_FIREWALL_PREFIX = "model-provider:";

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

interface ConnectorCatalogFirewallPermission {
  readonly name: string;
  readonly description?: string;
}

export function deriveConnectorCatalogFirewallPermissions(
  apis: FirewallConfig["apis"],
): readonly ConnectorCatalogFirewallPermission[] {
  const permissions = new Map<string, ConnectorCatalogFirewallPermission>();
  for (const api of apis) {
    for (const permission of api.permissions ?? []) {
      if (!permissions.has(permission.name)) {
        permissions.set(permission.name, {
          name: permission.name,
          ...(permission.description === undefined
            ? {}
            : { description: permission.description }),
        });
      }
    }
  }
  return [...permissions.values()].sort((left, right) => {
    return compareStrings(left.name, right.name);
  });
}

function sourceGrant(method: ConnectorCatalogAuthMethod): ConnectorGrantSource {
  switch (method.grant.kind) {
    case "manual": {
      return {
        kind: method.grant.kind,
        fields: method.grant.fields.map((field) => {
          return {
            privateName: field.privateName,
            publicId: field.publicId,
            label: field.label,
            required: field.required,
            ...(field.placeholder === null
              ? {}
              : { placeholder: field.placeholder }),
            storage: field.storage,
            ...(field.normalize === undefined
              ? {}
              : { normalize: field.normalize }),
          };
        }),
      };
    }
    case "device-auth": {
      return {
        kind: method.grant.kind,
        scopes: method.grant.scopes,
        outputs: method.grant.outputs,
        startOptions: method.grant.startOptions.map((option) => {
          return {
            privateName: option.privateName,
            publicId: option.publicId,
            kind: option.kind,
            label: option.label,
            required: option.required,
            ...(option.defaultValue === null
              ? {}
              : { defaultValue: option.defaultValue }),
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
      return method.grant;
    }
  }
}

function validateConnectorSemantics(artifact: ConnectorCatalogArtifact): void {
  const catalogSource = catalogSourceSchema.parse({
    catalogVersion: artifact.catalogVersion,
    categoryMetadata: artifact.categoryMetadata,
  });
  validateCatalogSourceSemantics(catalogSource);

  const categoryIds = new Set(
    artifact.categoryMetadata.categories.map((category) => {
      return category.id;
    }),
  );
  const secretOwners = new Map<string, string>();
  const variableOwners = new Map<string, string>();
  const skillStorageOwners = new Map<string, string>();
  const skillVersionOwners = new Map<string, string>();

  for (const connector of artifact.connectors) {
    if (connector.slug.startsWith(MODEL_PROVIDER_FIREWALL_PREFIX)) {
      throw new ConnectorCatalogRelationshipError(
        "reserved-connector-ownership",
        `Connector catalog uses reserved ownership: ${connector.slug}`,
      );
    }
    if (!categoryIds.has(connector.category)) {
      throw new ConnectorCatalogRelationshipError(
        "unknown-category",
        `Unknown category for connector ${connector.slug}`,
      );
    }
    const source = connectorSourceSchema.parse({
      label: connector.label,
      description: connector.description,
      category: connector.category,
      generation: connector.generation,
      tags: connector.tags,
      ...(connector.mcp === undefined ? {} : { mcp: connector.mcp }),
      ...(connector.replaces === undefined
        ? {}
        : { replaces: connector.replaces }),
      authMethods: connector.authMethods.map((method) => {
        return {
          id: method.id,
          label: method.label,
          description: method.description,
          visible: method.visible,
          ...(method.client === undefined ? {} : { client: method.client }),
          storage: method.storage,
          grant: sourceGrant(method),
          access: method.access,
          revoke: method.revoke,
        };
      }),
    });
    validateConnectorSourceSemantics({
      connectorSlug: connector.slug,
      source,
    });

    if (connector.skill.kind === "bundled") {
      const storageOwner = skillStorageOwners.get(connector.skill.storageName);
      if (storageOwner !== undefined) {
        throw new ConnectorCatalogRelationshipError(
          "duplicate-skill-storage-owner",
          `Connector skill storage ${connector.skill.storageName} is claimed by ${storageOwner} and ${connector.slug}`,
        );
      }
      skillStorageOwners.set(connector.skill.storageName, connector.slug);

      const versionOwner = skillVersionOwners.get(connector.skill.versionId);
      if (versionOwner !== undefined) {
        throw new ConnectorCatalogRelationshipError(
          "duplicate-skill-version-owner",
          `Connector skill version ${connector.skill.versionId} is claimed by ${versionOwner} and ${connector.slug}`,
        );
      }
      skillVersionOwners.set(connector.skill.versionId, connector.slug);
    }

    for (const method of connector.authMethods) {
      for (const secretName of method.storage.secrets) {
        const owner = secretOwners.get(secretName);
        if (owner !== undefined && owner !== connector.slug) {
          throw new ConnectorCatalogRelationshipError(
            "duplicate-storage-secret-owner",
            `Connector storage secret ${secretName} is claimed by ${owner} and ${connector.slug}`,
          );
        }
        secretOwners.set(secretName, connector.slug);
      }
      for (const variableName of method.storage.variables) {
        const owner = variableOwners.get(variableName);
        if (owner !== undefined && owner !== connector.slug) {
          throw new ConnectorCatalogRelationshipError(
            "duplicate-storage-variable-owner",
            `Connector storage variable ${variableName} is claimed by ${owner} and ${connector.slug}`,
          );
        }
        variableOwners.set(variableName, connector.slug);
      }
    }
  }
}

export function connectorCatalogFirewallConfig(
  connector: ConnectorCatalogArtifactConnector,
): FirewallConfig | null {
  return connector.firewall.kind === "none"
    ? null
    : {
        name: connector.slug,
        ...connector.firewall.config,
      };
}

function validateFirewallBindings(args: {
  readonly connector: ConnectorCatalogArtifactConnector;
  readonly firewall: FirewallConfig;
}): void {
  const knownEnvironmentNames = new Set<string>();
  for (const method of args.connector.authMethods) {
    for (const name of Object.keys(
      "envBindings" in method.access ? method.access.envBindings : {},
    )) {
      knownEnvironmentNames.add(name);
    }
    for (const name of "platformSecrets" in method.access
      ? (method.access.platformSecrets ?? [])
      : []) {
      knownEnvironmentNames.add(name);
    }
  }
  const references = firewallTemplateReferences(args.firewall.apis);
  const unknown = [...references.secrets, ...references.vars].filter((name) => {
    return !knownEnvironmentNames.has(name);
  });
  if (unknown.length > 0) {
    throw new ConnectorCatalogRelationshipError(
      "unknown-firewall-binding",
      `Firewall references unknown connector bindings: ${sortedUniqueStrings(unknown).join(", ")}`,
    );
  }
}

function validateBaseUrlTemplates(
  connectorSlug: string,
  firewall: FirewallConfig,
): void {
  const templates = new Map<string, FirewallBaseHostPolicy | undefined>();
  for (const api of firewall.apis) {
    if (!api.base.includes("${{")) {
      continue;
    }
    parseFirewallBaseUrl(api.base);
    if (
      templates.has(api.base) &&
      !isDeepStrictEqual(templates.get(api.base), api.hostPolicy)
    ) {
      throw new ConnectorCatalogRelationshipError(
        "conflicting-firewall-host-policies",
        `Firewall base URL host policies conflict: ${connectorSlug} (${api.base})`,
      );
    }
    templates.set(api.base, api.hostPolicy);
  }
}

export interface ConnectorCatalogFirewallBaseUrlTemplate {
  readonly base: string;
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

export interface ConnectorCatalogFirewallRoutingApi {
  readonly base: string;
  readonly environmentNames: readonly string[];
  readonly routes: readonly {
    readonly permissionName: string;
    readonly rule: string;
  }[];
}

export interface ConnectorCatalogFirewallRouting {
  readonly fixedHosts: readonly string[];
  readonly baseUrlVarNames: readonly string[];
  readonly baseUrlTemplates: readonly ConnectorCatalogFirewallBaseUrlTemplate[];
  readonly apis: readonly ConnectorCatalogFirewallRoutingApi[];
}

export function deriveConnectorCatalogFirewallRouting(
  firewall: FirewallConfig,
): ConnectorCatalogFirewallRouting {
  return {
    fixedHosts: sortedUniqueStrings(
      firewall.apis.flatMap((api) => {
        const parsed = parseFirewallBaseUrl(api.base);
        return api.base.includes("${{") ? [] : [parsed.host];
      }),
    ),
    baseUrlVarNames: sortedUniqueStrings(
      firewall.apis.flatMap((api) => {
        return firewallBaseVariableNames(api.base);
      }),
    ),
    baseUrlTemplates: firewall.apis
      .filter((api) => {
        return api.base.includes("${{");
      })
      .map((api) => {
        return {
          base: api.base,
          credentialed: firewallAuthInjectsCredentials(api.auth),
          ...(api.hostPolicy === undefined
            ? {}
            : { hostPolicy: api.hostPolicy }),
        };
      })
      .sort((left, right) => {
        return compareStrings(left.base, right.base);
      }),
    apis: firewall.apis.map((api) => {
      const references = extractFirewallTemplateReferences([api]);
      return {
        base: api.base,
        environmentNames: sortedUniqueStrings([
          ...references.secrets,
          ...references.vars,
        ]),
        routes: (api.permissions ?? []).flatMap((permission) => {
          return permission.rules.map((rule) => {
            return { permissionName: permission.name, rule };
          });
        }),
      };
    }),
  };
}

function validateGenericMcpFirewall(
  firewall: Extract<
    ConnectorCatalogArtifactConnector["firewall"],
    { kind: "generated" }
  >,
  api: FirewallConfig["apis"][number],
): void {
  if (
    Object.keys(api.auth).length !== 0 ||
    (api.permissions?.length ?? 0) !== 0 ||
    Object.keys(firewall.config.placeholders ?? {}).length !== 0 ||
    firewall.categories !== null ||
    firewall.defaultAllowed !== null ||
    firewall.defaultUnknownPolicy !== "allow"
  ) {
    throw new ConnectorCatalogRelationshipError(
      "mcp-firewall-contract",
      "MCP generic auth requires runtime-owned credentials and service-level transport access",
    );
  }
}

function validateMcpFirewall(
  connector: ConnectorCatalogArtifactConnector,
): void {
  if (connector.mcp === undefined) {
    return;
  }
  const api =
    connector.firewall.kind === "generated"
      ? connector.firewall.config.apis[0]
      : undefined;
  if (
    connector.firewall.kind !== "generated" ||
    connector.firewall.config.apis.length !== 1 ||
    api === undefined ||
    api.base !== connector.mcp.endpoint ||
    api.hostPolicy !== undefined
  ) {
    throw new ConnectorCatalogRelationshipError(
      "mcp-firewall-contract",
      "MCP firewall must target exactly its fixed endpoint",
    );
  }
  if (
    connector.authMethods.some((method) => {
      return method.grant.kind === "none" || method.grant.kind === "automatic";
    })
  ) {
    validateGenericMcpFirewall(connector.firewall, api);
  }
}

function validateFirewallSemantics(artifact: ConnectorCatalogArtifact): void {
  for (const connector of artifact.connectors) {
    validateMcpFirewall(connector);
    if (connector.firewall.kind === "none") {
      continue;
    }
    const firewall = connectorCatalogFirewallConfig(connector);
    if (firewall === null) {
      throw new ConnectorCatalogRelationshipError(
        "missing-generated-firewall",
        "Generated connector firewall is unavailable",
      );
    }
    validateFirewallGeneratorResult({
      firewall,
      categories: connector.firewall.categories,
      defaultAllowed: connector.firewall.defaultAllowed,
      defaultUnknownPolicy: connector.firewall.defaultUnknownPolicy,
    });
    validateFirewallBindings({ connector, firewall });
    validateBaseUrlTemplates(connector.slug, firewall);

    const routing = deriveConnectorCatalogFirewallRouting(firewall);
    for (const rawHost of routing.fixedHosts) {
      const host = normalizeFirewallFixedHost(rawHost);
      if (!host) {
        throw new ConnectorCatalogRelationshipError(
          "invalid-firewall-fixed-host",
          `Firewall fixed host is invalid: ${connector.slug}`,
        );
      }
    }
  }
}

export function validateConnectorCatalogArtifact(
  artifact: ConnectorCatalogArtifact,
): void {
  validateConnectorSemantics(artifact);
  validateFirewallSemantics(artifact);
}
