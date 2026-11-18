import type { SecretConnectorMetadata } from "@okouai/api-contracts/contracts/runners";
import {
  FirewallBaseUrlResolutionError,
  type FirewallPolicies,
} from "@okouai/connectors/firewall-types";
import { expandVariablesInString } from "@okouai/core/variable-expander";
import { computed, type Computed } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { settle } from "../utils";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { PermissionManifest } from "./agent-run-contracts";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  compactRecord,
  type CustomConnectorRuntimeContext,
} from "./connector-runtime-preparation.service";
import { DEFAULT_FIREWALL_SECRET_PLACEHOLDER } from "./connector-server-firewall-catalog.service";
import { buildPermissionManifest } from "./permission-manifest.service";
import type { Environment } from "./run-environment";
import {
  type BuiltinConnectorRuntimeContext,
  type ConnectorEnvBindingSet,
  type ConnectedAccountsError,
  emptyBuiltinConnectorRuntimeContext,
  storedConnectorContextFromSnapshot,
  type RunConnectorCatalogSelection,
  type StoredConnectorMaterializationSnapshot,
  type StoredConnectorSecretRow,
} from "./thread-connected-accounts.signals";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";

type ConnectorRuntimeError =
  | ReturnType<typeof badRequestMessage>
  | ThreadModelError
  | ConnectedAccountsError;

function isConnectorRuntimeError(
  value: unknown,
): value is ConnectorRuntimeError {
  return typeof value === "object" && value !== null && "status" in value;
}

interface ConnectorEnvironmentSources {
  readonly runVariables$: Computed<Promise<Record<string, string> | undefined>>;
  readonly permissionPolicies$: AgentRunContextSignals["permissionPolicies$"];
}

/**
 * The connector source of the Run environment: selected accounts become
 * placeholder environment entries, firewalls and runtime targets.
 */
export function createConnectorEnvironmentSignals(
  bootstrap: ConnectorEnvironmentSources,
  threadContext: Pick<
    ThreadContext,
    "connectorSelection$" | "connectorSnapshot$" | "dispatchTiming$"
  >,
) {
  const runtimeInputs = createConnectorRuntimeInputSignals(
    bootstrap,
    threadContext,
  );
  return createConnectorEnvironmentSignal(runtimeInputs);
}

type ConnectorRuntimeInputSignals = ReturnType<
  typeof createConnectorRuntimeInputSignals
>;

/** Admission validates policies and fixes diagnostic account bindings without
 * decrypting credentials or assembling a runtime environment. */
export function createConnectorAdmissionSignals(
  bootstrap: Parameters<typeof createConnectorRuntimeInputSignals>[0],
  threadContext: Parameters<typeof createConnectorRuntimeInputSignals>[1],
) {
  const inputs = createConnectorRuntimeInputSignals(bootstrap, threadContext);
  return computed(async (get) => {
    const input = await get(inputs.inputs$);
    if (isConnectorRuntimeError(input)) {
      return input;
    }
    const permissions = await input.timing.measure(
      "api_dispatch_prepare_context_build_permission_manifest",
      "nested",
      async () => {
        return await buildPreparedPermissionManifest(input);
      },
    );
    if (isConnectorRuntimeError(permissions)) {
      return permissions;
    }
    return {
      permissions,
      runtimeTargets: [
        ...(permissions?.builtinRuntimeTargets ?? []),
        ...input.customConnectorContext.targets,
      ],
    };
  });
}

function createConnectorRuntimeInputSignals(
  execution: ConnectorEnvironmentSources,
  threadContext: Pick<
    ThreadContext,
    "connectorSelection$" | "connectorSnapshot$" | "dispatchTiming$"
  >,
) {
  const { connectorSelection$, connectorSnapshot$, dispatchTiming$ } =
    threadContext;
  const inputs$ = computed(
    async (
      get,
    ): Promise<RunPreparedConnectorInputs | ConnectorRuntimeError> => {
      const [selection, snapshot, vars, policies] = await Promise.all([
        get(connectorSelection$),
        get(connectorSnapshot$),
        get(execution.runVariables$),
        get(execution.permissionPolicies$),
      ]);
      if (isConnectorRuntimeError(selection)) {
        return selection;
      }
      if (isConnectorRuntimeError(snapshot)) {
        return snapshot;
      }
      return {
        timing: get(dispatchTiming$),
        connectorCatalogSelection: selection.connectorCatalogSelection,
        vars,
        permissionPolicies: policies ?? undefined,
        ...snapshot,
      };
    },
  );
  return { inputs$ };
}

/** The connector source's contribution to the Run environment. */
function createConnectorEnvironmentSignal(
  inputs: ConnectorRuntimeInputSignals,
) {
  const { inputs$ } = inputs;
  const environment$ = computed(
    async (get): Promise<Environment | ConnectorRuntimeError> => {
      const input = await get(inputs$);
      if (isConnectorRuntimeError(input)) {
        return input;
      }
      const manifest = await input.timing.measure(
        "api_dispatch_prepare_context_build_permission_manifest",
        "nested",
        async () => {
          return await buildPreparedPermissionManifest(input);
        },
      );
      if (isConnectorRuntimeError(manifest)) {
        return manifest;
      }
      const builtin = storedConnectorExecutionContextFromSnapshot(
        input.storedConnectorSnapshot,
        manifest?.environmentSecretPlaceholders,
      );
      const custom = input.customConnectorContext;
      return {
        vars: builtin.vars,
        environment: expandStoredConnectorEnvironment({
          environment: builtin.storedEnvironment,
          vars: builtin.vars,
          environmentSecretPlaceholders: builtin.environmentSecretPlaceholders,
        }),
        platformEnvironment: undefined,
        secrets: undefined,
        secretConnectorMap: builtin.secretConnectorMap,
        secretConnectorMetadataMap: builtin.secretConnectorMetadataMap,
        firewalls: manifest?.firewalls ?? [],
        networkPolicies: manifest?.networkPolicies ?? {},
        environmentSecretPlaceholders: builtin.environmentSecretPlaceholders,
        billableFirewalls: manifest?.billableFirewalls ?? [],
        runtimeTargets: [
          ...(manifest?.builtinRuntimeTargets ?? []),
          ...custom.targets,
        ],
        reservedSecretAliases: Object.keys(custom.reservedSecretAliases ?? {}),
      };
    },
  );
  return environment$;
}

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";

const CONNECTOR_VAR_REF_PREFIX = "$vars.";

function connectorEnvironmentTemplate(
  envName: string,
  valueRef: string,
): string {
  if (valueRef.startsWith(CONNECTOR_SECRET_REF_PREFIX)) {
    return `\${{ secrets.${envName} }}`;
  }
  if (valueRef.startsWith(CONNECTOR_VAR_REF_PREFIX)) {
    return `\${{ vars.${envName} }}`;
  }
  return valueRef;
}

function addConnectorEnvironmentTemplate(
  environment: Record<string, string>,
  envName: string,
  valueRef: string,
): void {
  if (envName in environment) {
    return;
  }
  environment[envName] = connectorEnvironmentTemplate(envName, valueRef);
}

interface ResolvedStoredConnectorMetadata {
  readonly vars: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap: Record<string, SecretConnectorMetadata>;
  readonly environment: Record<string, string>;
  readonly environmentSecretPlaceholders: Record<string, string>;
}

function storedConnectorPlaceholdersBySource(
  runtimeBindings: ConnectorEnvBindingSet["runtimeBindings"],
  declaredPlaceholders: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  const placeholders = new Map<string, string>();
  for (const { envName, source } of runtimeBindings) {
    const placeholder = declaredPlaceholders?.[envName];
    if (
      source.kind === "connector-secret" &&
      placeholder !== undefined &&
      !placeholders.has(source.name)
    ) {
      placeholders.set(source.name, placeholder);
    }
  }
  return placeholders;
}

function resolveStoredConnectorMetadata(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorVariables: Record<string, string>,
  availableSecretNames: ReadonlySet<string>,
  declaredPlaceholders: Readonly<Record<string, string>> | undefined,
): ResolvedStoredConnectorMetadata {
  const vars: Record<string, string> = {};
  const secretConnectorMap: Record<string, string> = {};
  const secretConnectorMetadataMap: Record<string, SecretConnectorMetadata> =
    {};
  const environment: Record<string, string> = {};
  const environmentSecretPlaceholders = { ...declaredPlaceholders };

  for (const { access, connectorSlug, runtimeBindings, isMcp } of bindingSets) {
    if (isMcp) {
      // Resolve MCP bindings from the matched account at the firewall boundary.
      // Global aliases could otherwise collide with another connector or a
      // caller-owned sandbox secret.
      continue;
    }
    const placeholdersBySource = storedConnectorPlaceholdersBySource(
      runtimeBindings,
      declaredPlaceholders,
    );
    for (const { envName, valueRef, optional, source } of runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          if (availableSecretNames.has(source.name) || !optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
            // A placeholder carries no authority. Unusable connector auth stays
            // a request-time failure, never a reason to decrypt at Run startup.
            environmentSecretPlaceholders[envName] =
              declaredPlaceholders?.[envName] ??
              placeholdersBySource.get(source.name) ??
              DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
          }
          break;
        }
        case "connector-variable": {
          const variableValue = connectorVariables[source.name];
          if (variableValue !== undefined) {
            vars[envName] = variableValue;
          }
          if (variableValue !== undefined || !optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
          }
          break;
        }
        case "platform-secret": {
          break;
        }
      }
    }

    // Firewall auth templates can only reference env aliases from envBindings;
    // store the alias that points at the connector runtime secret, not the
    // backing secret name. Refreshability is resolved later from access metadata.
    for (const { envName, source } of runtimeBindings) {
      if (source.kind === "connector-secret") {
        secretConnectorMap[envName] = connectorSlug;
        secretConnectorMetadataMap[envName] = {
          sourceType: "connector",
          sourceId: access.connectorId,
        };
      } else if (source.kind === "platform-secret") {
        secretConnectorMap[envName] = connectorSlug;
        secretConnectorMetadataMap[envName] = { sourceType: "platform-secret" };
      }
    }
  }

  return {
    vars,
    secretConnectorMap,
    secretConnectorMetadataMap,
    environment,
    environmentSecretPlaceholders,
  };
}

function availableStoredConnectorSecretNames(
  rows: readonly StoredConnectorSecretRow[],
): ReadonlySet<string> {
  return new Set(
    rows.map((row) => {
      return row.name;
    }),
  );
}

function storedConnectorExecutionContextFromSnapshot(
  snapshot: StoredConnectorMaterializationSnapshot | null,
  declaredPlaceholders: Readonly<Record<string, string>> | undefined,
): BuiltinConnectorRuntimeContext & {
  readonly environmentSecretPlaceholders: Record<string, string> | undefined;
} {
  if (!snapshot) {
    return {
      ...emptyBuiltinConnectorRuntimeContext(),
      environmentSecretPlaceholders: compactRecord({ ...declaredPlaceholders }),
    };
  }
  const resolved = resolveStoredConnectorMetadata(
    snapshot.bindingSets,
    snapshot.variableValues,
    availableStoredConnectorSecretNames(snapshot.secretRows),
    declaredPlaceholders,
  );
  return {
    ...storedConnectorContextFromSnapshot(snapshot),
    vars: compactRecord(resolved.vars),
    secretConnectorMap: compactRecord(resolved.secretConnectorMap),
    secretConnectorMetadataMap: compactRecord(
      resolved.secretConnectorMetadataMap,
    ),
    storedEnvironment: compactRecord(resolved.environment),
    environmentSecretPlaceholders: compactRecord(
      resolved.environmentSecretPlaceholders,
    ),
  };
}

interface RunPreparedConnectorInputs {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly vars: Record<string, string> | undefined;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}

async function buildPreparedPermissionManifest(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly vars: Record<string, string> | undefined;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | ConnectorRuntimeError> {
  const result = await settle(
    buildPermissionManifest({
      connectorCatalogSelection: args.connectorCatalogSelection,
      modelProvider: null,
      permissionPolicies: args.permissionPolicies,
      vars: args.vars,
      connectorVars: args.storedConnectorMetadataContext.vars,
      connectorSlugs: args.storedConnectorMetadataContext.connectorSlugs,
      connectorSourceIdBySlug:
        args.storedConnectorMetadataContext.connectorSourceIdBySlug,
      customConnectorFirewalls: args.customConnectorContext.firewalls,
      customConnectorPermissionPolicies:
        args.customConnectorContext.permissionPolicies,
      customConnectorIdByFirewallName:
        args.customConnectorContext.customConnectorIdByFirewallName,
      customConnectorSourceIdByFirewallName:
        args.customConnectorContext.customConnectorSourceIdByFirewallName,
      timing: args.timing,
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof FirewallBaseUrlResolutionError) {
    return badRequestMessage(result.error.message);
  }
  throw result.error;
}

function expandStoredConnectorEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
}): Record<string, string> | undefined {
  if (!args.environment) {
    return undefined;
  }

  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.environment)) {
    const expansion = expandVariablesInString(value, {
      vars: args.vars,
      secrets: args.environmentSecretPlaceholders,
    });
    if (expansion.missingVars.length > 0) {
      throw new Error(
        `Stored connector environment is missing required values: ${formatMissingReferences(expansion.missingVars)}`,
      );
    }
    expanded[key] = expansion.result;
  }
  return compactRecord(expanded);
}

function formatMissingReferences(
  refs: readonly { readonly source: string; readonly name: string }[],
): string {
  return refs
    .map((ref) => {
      return `${ref.source}.${ref.name}`;
    })
    .join(", ");
}
