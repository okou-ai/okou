import type { SecretConnectorMetadata } from "@okouai/api-contracts/contracts/runners";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { expandVariablesInString } from "@okouai/core/variable-expander";
import { computed } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { safeSync, settle } from "../utils";
import {
  type AgentRunContextSignals,
  createEagerConnectorCredentialContext,
  type EagerConnectorCredentialObservation,
} from "./agent-run-context.signals";
import type { PermissionManifest } from "./agent-run-contracts";
import type {
  ApiDispatchTimingCollector,
  ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import {
  compactRecord,
  type CustomConnectorRuntimeContext,
  mergeRecords,
} from "./connector-runtime-preparation.service";
import { countBucket } from "./dispatch-count-bucket";
import { buildPermissionManifest } from "./permission-manifest.service";
import type { Environment } from "./run-environment";
import type { RunRequestBody } from "./run-body-environment";
import {
  type BuiltinConnectorRuntimeContext,
  type ConnectorEnvBindingSet,
  type ConnectedAccountsError,
  type EffectiveConnectorScope,
  emptyBuiltinConnectorRuntimeContext,
  storedConnectorContextFromSnapshot,
  type RunConnectorCatalogSelection,
  storedConnectorCredentialNames,
  type StoredConnectorMaterializationSnapshot,
  type StoredConnectorSecretRow,
  storedConnectorTimingDimensions,
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

/**
 * The connector source of the Run environment: selected accounts become
 * environment entries, decrypted secrets, firewalls and runtime targets.
 */
export function createConnectorEnvironmentSignals(
  bootstrap: AgentRunContextSignals,
  threadContext: ThreadContext,
) {
  const runtimeInputs = createConnectorRuntimeInputSignals(
    bootstrap,
    threadContext,
  );
  const secretPlan = createEagerSecretPlanSignals(runtimeInputs);
  const connectorSecrets = createConnectorSecretSignals(
    threadContext,
    secretPlan,
  );
  return createConnectorEnvironmentSignal(threadContext, connectorSecrets);
}

type ConnectorRuntimeInputSignals = ReturnType<
  typeof createConnectorRuntimeInputSignals
>;

function createConnectorRuntimeInputSignals(
  execution: AgentRunContextSignals,
  threadContext: ThreadContext,
) {
  const { connectorSelection$, connectorSnapshot$, dispatchTiming$ } =
    threadContext;
  const inputs$ = computed(
    async (
      get,
    ): Promise<RunPreparedConnectorInputs | ConnectorRuntimeError> => {
      const [selection, snapshot, body, policies, features] = await Promise.all(
        [
          get(connectorSelection$),
          get(connectorSnapshot$),
          get(execution.bodyEnvironment$),
          get(execution.permissionPolicies$),
          get(execution.featureSwitches$),
        ],
      );
      if (isConnectorRuntimeError(selection)) {
        return selection;
      }
      if (isConnectorRuntimeError(snapshot)) {
        return snapshot;
      }
      return {
        timing: get(dispatchTiming$),
        connectorScope: selection.connectorScope,
        connectorCatalogSelection: selection.connectorCatalogSelection,
        body: { ...body, permissionPolicies: policies ?? undefined },
        ...snapshot,
        featureSwitchContext: features,
      };
    },
  );
  return { inputs$ };
}

type EagerSecretPlanSignals = ReturnType<typeof createEagerSecretPlanSignals>;

function createEagerSecretPlanSignals(inputs: ConnectorRuntimeInputSignals) {
  const { inputs$ } = inputs;
  const permissionManifest$ = computed(async (get) => {
    const input = await get(inputs$);
    return isConnectorRuntimeError(input)
      ? input
      : await input.timing.measure(
          "api_dispatch_prepare_context_build_permission_manifest",
          "nested",
          async () => {
            return await buildPreparedPermissionManifest(input);
          },
        );
  });
  const eagerSecretPlan$ = computed(async (get) => {
    const [input, permissionManifest] = await Promise.all([
      get(inputs$),
      get(permissionManifest$),
    ]);
    if (isConnectorRuntimeError(input)) {
      return input;
    }
    if (isConnectorRuntimeError(permissionManifest)) {
      return permissionManifest;
    }
    const snapshot = input.storedConnectorSnapshot;
    const connectorContext =
      storedConnectorExecutionContextFromSnapshot(snapshot);
    // Decrypt every secret the connector environment needs; later sources
    // override aliases only when environments are merged.
    const names = snapshot
      ? eagerStoredConnectorSecretNames({
          snapshot,
          storedEnvironment: connectorContext.storedEnvironment,
          environmentSecretPlaceholders:
            permissionManifest?.environmentSecretPlaceholders,
        })
      : new Set<string>();
    return {
      input,
      connectorContext,
      permissionManifest,
      names,
      bindingSets:
        snapshot?.bindingSets.filter((bindingSet) => {
          return !bindingSet.isMcp;
        }) ?? [],
      timingDimensions: storedConnectorTimingDimensions({
        scopeSource: input.connectorScope.source,
        connectorCount: snapshot?.allowedConnectorRows.length ?? 0,
      }),
    };
  });
  return { eagerSecretPlan$ };
}

type ConnectorSecretSignals = ReturnType<typeof createConnectorSecretSignals>;

function createConnectorSecretSignals(
  threadContext: ThreadContext,
  plan: EagerSecretPlanSignals,
) {
  const { selectedConnectorSources$ } = threadContext;
  const { eagerSecretPlan$ } = plan;
  const encryptedRows$ = computed(
    async (get): Promise<readonly StoredConnectorEncryptedSecretRow[]> => {
      const [plan, sources] = await Promise.all([
        get(eagerSecretPlan$),
        get(selectedConnectorSources$),
      ]);
      if (isConnectorRuntimeError(plan) || plan.names.size === 0) {
        return [];
      }
      // Account identity, revision and values were captured in one statement.
      // Only catalog-owned names from the selected binding sets may escape it.
      const keys = new Set(
        plan.bindingSets.flatMap((bindingSet) => {
          return storedConnectorCredentialNames({
            runtimeBindings: bindingSet.runtimeBindings,
            kind: "secret",
            names: plan.names,
          }).map((name) => {
            return JSON.stringify([bindingSet.access.connectorId, name]);
          });
        }),
      );
      return sources.flatMap((result) => {
        return result.kind === "available"
          ? result.snapshot.credentials.filter((credential) => {
              return keys.has(
                JSON.stringify([
                  result.snapshot.source.sourceId,
                  credential.name,
                ]),
              );
            })
          : [];
      });
    },
  );
  const eagerCredentialContext$ = computed(async (get) => {
    const resolveStartedAt = performance.now();
    return createEagerConnectorCredentialContext(
      await get(encryptedRows$),
      resolveStartedAt,
    );
  });
  // Stored connector secrets, decrypted once per graph; KMS decryption has no
  // side effects (Ethan 2026-10-02).
  const decryptedSecrets$ = computed(async (get) => {
    const [plan, rows] = await Promise.all([
      get(eagerSecretPlan$),
      get(encryptedRows$),
    ]);
    if (isConnectorRuntimeError(plan)) {
      return {};
    }
    const { credentials: decrypted, observation } = await get(
      (await get(eagerCredentialContext$)).credentials$,
    );
    if (observation) {
      recordEagerDecryptObservation(plan, observation);
    }
    return Object.fromEntries(
      rows.map((row) => {
        const result = decrypted.get(row.id);
        if (!result) {
          throw new Error(
            "Selected connector credential is missing from bootstrap",
          );
        }
        if (!result.ok) {
          throw result.error;
        }
        return [row.name, result.value];
      }),
    );
  });
  const connectorContext$ = computed(
    async (get): Promise<PreparedConnectorContext | ConnectorRuntimeError> => {
      const [plan, secrets] = await Promise.all([
        get(eagerSecretPlan$),
        get(decryptedSecrets$),
      ]);
      if (isConnectorRuntimeError(plan)) {
        return plan;
      }
      return {
        connectorContext: {
          ...plan.connectorContext,
          secrets: compactRecord({
            ...plan.connectorContext.secrets,
            ...resolveStoredConnectorSecrets(plan.bindingSets, secrets),
          }),
        },
        permissionManifest: plan.permissionManifest,
      };
    },
  );
  return { connectorContext$ };
}

/** The connector source's contribution to the Run environment. */
function createConnectorEnvironmentSignal(
  threadContext: ThreadContext,
  connectorSecrets: ConnectorSecretSignals,
) {
  const { connectorSnapshot$ } = threadContext;
  const { connectorContext$ } = connectorSecrets;
  const environment$ = computed(
    async (get): Promise<Environment | ConnectorRuntimeError> => {
      const [prepared, snapshot] = await Promise.all([
        get(connectorContext$),
        get(connectorSnapshot$),
      ]);
      if (isConnectorRuntimeError(prepared)) {
        return prepared;
      }
      if (isConnectorRuntimeError(snapshot)) {
        return snapshot;
      }
      const builtin = prepared.connectorContext;
      const manifest = prepared.permissionManifest;
      const custom = snapshot.customConnectorContext;
      return {
        vars: builtin.vars,
        environment: expandStoredConnectorEnvironment({
          environment: builtin.storedEnvironment,
          vars: builtin.vars,
          secrets: builtin.secrets,
          environmentSecretPlaceholders:
            manifest?.environmentSecretPlaceholders,
        }),
        platformEnvironment: undefined,
        secrets: builtin.secrets,
        secretConnectorMap: builtin.secretConnectorMap,
        secretConnectorMetadataMap: builtin.secretConnectorMetadataMap,
        firewalls: manifest?.firewalls ?? [],
        networkPolicies: manifest?.networkPolicies ?? {},
        environmentSecretPlaceholders: manifest?.environmentSecretPlaceholders,
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

/** Record the completed eager resolve and decrypt intervals once. */
function recordEagerDecryptObservation(
  plan: {
    readonly input: { readonly timing: ApiDispatchTimingCollector };
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  observation: EagerConnectorCredentialObservation,
): void {
  safeSync(() => {
    const dimensions = {
      ...plan.timingDimensions,
      connector_context_schema: "selected_eager_v1",
      connector_context_builtin_decrypt_count: observation.builtinDecryptCount,
      connector_context_observation:
        observation.builtinResolve && observation.builtinDecrypt
          ? "complete"
          : "partial",
      connector_context_builtin_decrypt_count_bucket: countBucket(
        observation.builtinDecryptCount,
      ),
    };
    for (const [actionType, duration] of [
      [
        "api_dispatch_prepare_context_connector_context_builtin_resolve",
        observation.builtinResolve,
      ],
      [
        "api_dispatch_prepare_context_connector_context_builtin_decrypt",
        observation.builtinDecrypt,
      ],
    ] as const) {
      if (duration) {
        plan.input.timing.recordDuration(
          actionType,
          "nested",
          duration.durationMs,
          duration.finishedAt,
          dimensions,
        );
      }
    }
  });
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

interface StoredConnectorEncryptedSecretRow extends StoredConnectorSecretRow {
  readonly id: string;
  readonly encryptedValue: string;
}

interface ResolvedStoredConnectorMetadata {
  readonly vars: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap: Record<string, SecretConnectorMetadata>;
  readonly environment: Record<string, string>;
}

function resolveStoredConnectorSecrets(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorSecrets: Record<string, string>,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const { runtimeBindings } of bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      if (source.kind !== "connector-secret") {
        continue;
      }
      const secretValue = connectorSecrets[source.name];
      if (secretValue !== undefined) {
        secrets[envName] = secretValue;
      }
    }
  }
  return secrets;
}

function resolveStoredConnectorMetadata(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorVariables: Record<string, string>,
  availableSecretNames: ReadonlySet<string>,
): ResolvedStoredConnectorMetadata {
  const vars: Record<string, string> = {};
  const secretConnectorMap: Record<string, string> = {};
  const secretConnectorMetadataMap: Record<string, SecretConnectorMetadata> =
    {};
  const environment: Record<string, string> = {};

  for (const { access, connectorSlug, runtimeBindings, isMcp } of bindingSets) {
    if (isMcp) {
      // Resolve MCP bindings from the matched account at the firewall boundary.
      // Global aliases could otherwise collide with another connector or a
      // caller-owned sandbox secret.
      continue;
    }
    for (const { envName, valueRef, optional, source } of runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          if (availableSecretNames.has(source.name) || !optional) {
            addConnectorEnvironmentTemplate(environment, envName, valueRef);
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
): BuiltinConnectorRuntimeContext {
  if (!snapshot) {
    return emptyBuiltinConnectorRuntimeContext();
  }
  const resolved = resolveStoredConnectorMetadata(
    snapshot.bindingSets,
    snapshot.variableValues,
    availableStoredConnectorSecretNames(snapshot.secretRows),
  );
  return {
    ...storedConnectorContextFromSnapshot(snapshot),
    vars: compactRecord(resolved.vars),
    secretConnectorMap: compactRecord(resolved.secretConnectorMap),
    secretConnectorMetadataMap: compactRecord(
      resolved.secretConnectorMetadataMap,
    ),
    storedEnvironment: compactRecord(resolved.environment),
  };
}

function eagerStoredConnectorSecretNames(args: {
  readonly snapshot: StoredConnectorMaterializationSnapshot;
  readonly storedEnvironment: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
}): ReadonlySet<string> {
  const names = new Set<string>();

  for (const { runtimeBindings, isMcp } of args.snapshot.bindingSets) {
    if (isMcp) {
      continue;
    }
    for (const { envName, source } of runtimeBindings) {
      if (
        source.kind !== "connector-secret" ||
        args.storedEnvironment?.[envName] === undefined ||
        args.environmentSecretPlaceholders?.[envName] !== undefined
      ) {
        continue;
      }
      names.add(source.name);
    }
  }
  return names;
}

interface PreparedConnectorContext {
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
}

interface RunPreparedConnectorInputs {
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<
    RunRequestBody,
    "permissionPolicies" | "vars" | "secrets"
  >;
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}

async function buildPreparedPermissionManifest(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<
    RunRequestBody,
    "permissionPolicies" | "vars" | "secrets"
  >;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | ConnectorRuntimeError> {
  const result = await settle(
    buildPermissionManifest({
      connectorCatalogSelection: args.connectorCatalogSelection,
      modelProvider: null,
      permissionPolicies: args.body.permissionPolicies,
      vars: args.body.vars,
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
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
}): Record<string, string> | undefined {
  if (!args.environment) {
    return undefined;
  }

  const expanded: Record<string, string> = {};
  const secretSources = mergeRecords(
    args.secrets,
    args.environmentSecretPlaceholders,
  );
  for (const [key, value] of Object.entries(args.environment)) {
    const expansion = expandVariablesInString(value, {
      vars: args.vars,
      secrets: secretSources,
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
