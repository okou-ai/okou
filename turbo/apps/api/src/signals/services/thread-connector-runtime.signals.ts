import type { SecretConnectorMetadata } from "@okouai/api-contracts/contracts/runners";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import { FirewallBaseUrlResolutionError } from "@okouai/connectors/firewall-types";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { extractAndGroupVariables } from "@okouai/core/variable-expander";
import { computed } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { settle } from "../utils";
import { createEagerConnectorCredentialContext } from "./agent-run-context.signals";
import type {
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  compactRecord,
  type CustomConnectorRuntimeContext,
} from "./connector-runtime-preparation.service";
import { expandConnectorServerFirewallPolicies } from "./connector-server-firewall-catalog.service";
import { buildPermissionManifest } from "./permission-manifest.service";
import {
  pendingOkouTokenSecrets,
  resolveRunBodyEnvironment,
  type RunRequestBody,
  selectedAgentRunVariables,
} from "./run-body-environment";
import {
  type BuiltinConnectorRuntimeContext,
  type ConnectorEnvBindingSet,
  type ConnectedAccounts,
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
 * Turns the selected connector accounts into runtime environment, credentials
 * and the permission manifest for the execution identity.
 */
export function createConnectorRuntimeSignals(
  threadContext: ThreadContext,
  connectedAccounts: ConnectedAccounts,
) {
  const execution$ = threadContext.executionBootstrap$;
  const runtimeInputs = createConnectorRuntimeInputSignals(
    execution$,
    threadContext.dispatchTiming$,
    threadContext.modelRoute$,
    connectedAccounts,
  );
  const secretPlan = createEagerSecretPlanSignals(runtimeInputs);
  const connectorSecrets = createConnectorSecretSignals(
    connectedAccounts,
    secretPlan,
  );
  return {
    bodyEnvironment$: runtimeInputs.bodyEnvironment$,
    permissionPolicies$: runtimeInputs.permissionPolicies$,
    eagerSecretPlan$: secretPlan.eagerSecretPlan$,
    eagerCredentialContext$: connectorSecrets.eagerCredentialContext$,
    connectorContext$: connectorSecrets.connectorContext$,
  };
}

type ConnectorRuntimeInputSignals = ReturnType<
  typeof createConnectorRuntimeInputSignals
>;

function createConnectorRuntimeInputSignals(
  execution$: ThreadContext["executionBootstrap$"],
  dispatchTiming$: ThreadContext["dispatchTiming$"],
  modelRoute$: ThreadContext["modelRoute$"],
  connectedAccounts: ConnectedAccounts,
) {
  const { connectorCatalog$, connectorScope$, connectorSelection$ } =
    connectedAccounts;
  const { connectorSnapshot$ } = connectedAccounts;
  const bodyEnvironment$ = computed(async (get) => {
    const execution = await get(execution$);
    const [agent, environment] = await Promise.all([
      get(execution.agent$),
      get(execution.environment$),
    ]);
    if (!agent) {
      throw new Error("Agent disappeared after preparation authorization");
    }
    return resolveRunBodyEnvironment({
      runVars: selectedAgentRunVariables(agent.id),
      runSecrets: pendingOkouTokenSecrets(undefined),
      persistedEnvironment: environment,
      canonicalOkouRuntime: true,
    });
  });
  const permissionPolicies$ = computed(async (get) => {
    const execution = await get(execution$);
    const [grants, catalog, scope] = await Promise.all([
      get(execution.permissionGrants$),
      get(connectorCatalog$),
      get(connectorScope$),
    ]);
    return await get(dispatchTiming$).measure(
      "api_dispatch_pre_create_agent_resolve_firewall_metadata",
      "nested",
      async () => {
        const stored = permissionGrantsToFirewallPolicies(
          grants.map(({ connectorSlug, permission, action }) => {
            return { connectorSlug, permission, action };
          }),
        );
        return catalog.kind === "empty"
          ? stored
          : await expandConnectorServerFirewallPolicies({
              catalog: catalog.selection.serverFirewalls,
              stored,
              connectorSlugs: [...scope.allowedConnectorSlugs],
            });
      },
    );
  });
  const inputs$ = computed(
    async (
      get,
    ): Promise<RunPreparedConnectorInputs | ConnectorRuntimeError> => {
      const execution = await get(execution$);
      const [selection, snapshot, modelProvider, body, policies, features] =
        await Promise.all([
          get(connectorSelection$),
          get(connectorSnapshot$),
          get(modelRoute$),
          get(bodyEnvironment$),
          get(permissionPolicies$),
          get(execution.featureSwitches$),
        ]);
      if (isConnectorRuntimeError(modelProvider)) {
        return modelProvider;
      }
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
        modelProvider,
        ...snapshot,
        featureSwitchContext: features,
      };
    },
  );
  return { bodyEnvironment$, permissionPolicies$, inputs$ };
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
    const eagerInputs = eagerStoredConnectorSecretInputs({
      modelProvider: input.modelProvider,
      connectorContext,
    });
    const names = snapshot
      ? eagerStoredConnectorSecretNames({
          snapshot,
          referencedEnvironmentSecretAliases:
            eagerInputs.referencedEnvironmentSecretAliases,
          storedEnvironment: eagerInputs.eagerStoredEnvironment,
          environmentSecretPlaceholders:
            permissionManifest?.environmentSecretPlaceholders,
          overriddenSecretAliases: overriddenRuntimeSecretAliases([
            input.modelProvider?.secrets,
            input.modelProvider?.secretConnectorMap,
            input.body.secrets,
          ]),
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

function createConnectorSecretSignals(
  connectedAccounts: ConnectedAccounts,
  plan: EagerSecretPlanSignals,
) {
  const { selectedStoredConnectorSources$ } = connectedAccounts;
  const { eagerSecretPlan$ } = plan;
  const encryptedRows$ = computed(
    async (get): Promise<readonly StoredConnectorEncryptedSecretRow[]> => {
      const [plan, sources] = await Promise.all([
        get(eagerSecretPlan$),
        get(selectedStoredConnectorSources$),
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
    const { credentials: decrypted } = await get(
      (await get(eagerCredentialContext$)).credentials$,
    );
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
  return { eagerCredentialContext$, connectorContext$ };
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

export function effectiveStoredConnectorEnvironment(args: {
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  if (!args.storedConnectorEnvironment) {
    return undefined;
  }

  const overrides = args.additionalEnvironment;
  if (!overrides) {
    return args.storedConnectorEnvironment;
  }

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.storedConnectorEnvironment)) {
    if (overrides[key] === undefined) {
      environment[key] = value;
    }
  }
  return compactRecord(environment);
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

function referencedEnvironmentSecretAliases(
  environment: Record<string, string> | undefined,
): ReadonlySet<string> {
  if (!environment) {
    return new Set();
  }
  return new Set(
    extractAndGroupVariables(environment).secrets.map((ref) => {
      return ref.name;
    }),
  );
}

function eagerStoredConnectorSecretNames(args: {
  readonly snapshot: StoredConnectorMaterializationSnapshot;
  readonly storedEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
  readonly environmentSecretPlaceholders:
    Readonly<Record<string, string>> | undefined;
  readonly overriddenSecretAliases: ReadonlySet<string>;
}): ReadonlySet<string> {
  const names = new Set<string>();

  for (const { runtimeBindings, isMcp } of args.snapshot.bindingSets) {
    if (isMcp) {
      continue;
    }
    for (const { envName, source } of runtimeBindings) {
      const isNeededByStoredEnvironment =
        args.storedEnvironment?.[envName] !== undefined;
      const isNeededByExplicitEnvironment =
        args.referencedEnvironmentSecretAliases.has(envName);
      if (
        source.kind !== "connector-secret" ||
        (!isNeededByStoredEnvironment && !isNeededByExplicitEnvironment) ||
        args.environmentSecretPlaceholders?.[envName] !== undefined ||
        args.overriddenSecretAliases.has(envName)
      ) {
        continue;
      }
      names.add(source.name);
    }
  }
  return names;
}

function eagerStoredConnectorSecretInputs(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
}): {
  readonly eagerStoredEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
} {
  const additionalEnvironment = args.modelProvider?.environment;
  return {
    eagerStoredEnvironment: effectiveStoredConnectorEnvironment({
      additionalEnvironment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
    }),
    referencedEnvironmentSecretAliases: referencedEnvironmentSecretAliases(
      additionalEnvironment,
    ),
  };
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
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}

function overriddenRuntimeSecretAliases(
  records: readonly (Record<string, string> | undefined)[],
): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      aliases.add(key);
    }
  }
  return aliases;
}

async function buildPreparedPermissionManifest(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<
    RunRequestBody,
    "permissionPolicies" | "vars" | "secrets"
  >;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | ConnectorRuntimeError> {
  const result = await settle(
    buildPermissionManifest({
      connectorCatalogSelection: args.connectorCatalogSelection,
      modelProvider: args.modelProvider,
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
