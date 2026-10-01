/**
 * Run connector context preparation shared by execution owners: connector
 * scope, account candidates, stored builtin connector snapshots and secrets,
 * and custom connector runtime rows. Moved verbatim out of the legacy
 * execution graph; exact source reads stay in execution-connector-sources.
 */
import { onRejection, safeSync } from "../utils";
import { now, nowDate } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import {
  measureApiDispatchTiming,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { extractAndGroupVariables } from "@okouai/core/variable-expander";
import type { SecretConnectorMetadata } from "@okouai/api-contracts/contracts/runners";
import type { AgentExecutionConfig as agentRunCreateAgentExecutionConfig } from "./agent-execution-config";
import {
  type ConnectorSlug,
  connectorSlugSchema,
  type ConnectorAuthMethodId,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { decryptStoredSecretValue } from "./crypto.utils";
import {
  type ConnectorRuntimeSelection,
  getConnectorRuntimeConnector,
  type ConnectorRuntimeMethod,
} from "./connector-catalog-runtime.service";
import {
  customConnectorValueMarkerKey,
  customConnectorManualAuthReferencesMemberField,
  customConnectorMissingRequiredFieldKeys,
} from "./custom-connector.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import type {
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type BuiltinConnectorCredentialAccess,
  resolveBuiltinConnectorCredentialAccess,
  type BuiltinConnectorCredentialReadGroup,
} from "./builtin-connector-credential-access.service";
import {
  type ConnectorRuntimeBindingEntry,
  connectorAuthMethodRuntimeMetadata,
} from "@okouai/connectors/connector-auth-method";
import {
  type ConnectorCredentialStatus,
  builtinConnectorRuntimeCredentialStatusWithMethod,
} from "./connector-credential-status.service";
import {
  type CustomConnectorRuntimeStorageRow,
  customConnectorRuntimeStorageSnapshot,
} from "./custom-connector-credential-access.service";
import {
  type CustomConnectorRuntimeContext,
  compactRecord,
  type CustomConnectorRuntimeDataRows,
  type BuildCustomConnectorRuntimeContextArgs,
  orderedCustomConnectorRuntimeRows,
  buildCustomConnectorRuntimeContext,
  customConnectorRuntimeSkill,
} from "./connector-runtime-preparation.service";
import {
  BuiltinConnectorRuntimeContext,
  ConnectorScopeSource,
  type ExplicitConnectorScope,
  CreateRunBody,
  EffectiveConnectorScope,
  PermissionManifest,
  ResolvedModelProviderEnvironment,
  firstAgent,
} from "./execution-launch-persistence.service";
import { countBucket } from "./execution-storage-manifest.service";

const CONNECTOR_SECRET_REF_PREFIX = "$secrets.";

const CONNECTOR_VAR_REF_PREFIX = "$vars.";

const EAGER_STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY = 4;

export interface ThreadConnectorSelectionIds {
  /** Candidates are ordered from run-scoped source to persisted preference. */
  readonly connectorIdCandidatesBySlug: ReadonlyMap<
    ConnectorSlug,
    readonly string[]
  >;
  readonly connectorIdCandidatesByCustomConnectorId: ReadonlyMap<
    string,
    readonly string[]
  >;
}

export type RunConnectorCatalogSelection =
  | { readonly kind: "empty" }
  | {
      readonly kind: "scoped";
      readonly selection: ConnectorRuntimeSelection;
    };

export function isEmptyRunConnectorScope(scope: {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}): boolean {
  return (
    scope.allowedConnectorSlugs.length === 0 &&
    scope.allowedCustomConnectorIds.length === 0
  );
}

export function emptyCustomConnectorRuntimeContext(): CustomConnectorRuntimeContext {
  return {
    firewalls: [],
    reservedSecretAliases: undefined,
    permissionPolicies: undefined,
    targets: [],
    customConnectorIdByFirewallName: {},
    customConnectorSourceIdByFirewallName: {},
    mcpConnectorSlugs: [],
    skills: [],
  };
}

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

export function environmentTemplates(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly additionalEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const environment = firstAgent(args.content)?.environment;
  return mergeRecords(args.additionalEnvironment, environment);
}

export function effectiveStoredConnectorEnvironment(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  if (!args.storedConnectorEnvironment) {
    return undefined;
  }

  const overrides = mergeRecords(
    args.additionalEnvironment,
    firstAgent(args.content)?.environment,
  );
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

export function mergeRecords<T>(
  ...records: readonly (Record<string, T> | undefined)[]
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
  for (const record of records) {
    if (record) {
      Object.assign(merged, record);
    }
  }
  return compactRecord(merged);
}

interface StoredConnectorRuntimeRow {
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly access: BuiltinConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly isMcp: boolean;
  readonly needsReconnect: boolean;
  readonly tokenExpiresAt: Date | null;
}

interface StoredConnectorRuntimeRowCandidate {
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly connectorId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly connectorStateRevision: bigint;
  readonly needsReconnect: boolean;
  readonly orgId: string;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly userId: string;
}

export interface StoredConnectorMaterializationSnapshotRow extends StoredConnectorRuntimeRowCandidate {
  readonly secretNames: readonly string[];
  readonly variableValues: Readonly<Record<string, string>>;
}

interface ConnectorEnvBindingSet {
  readonly access: BuiltinConnectorCredentialAccess;
  readonly connectorSlug: ConnectorSlug;
  readonly connectorStateRevision: bigint;
  readonly authMethod: ConnectorAuthMethodId;
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
  readonly isMcp: boolean;
}

interface StoredConnectorRequirements {
  readonly secretNames: Set<string>;
  readonly variableNames: Set<string>;
}

interface StoredConnectorMaterializationPlan {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
}

interface StoredConnectorSecretRow {
  readonly name: string;
}

export interface StoredConnectorEncryptedSecretRow extends StoredConnectorSecretRow {
  readonly encryptedValue: string;
}

export interface StoredConnectorMaterializationSnapshot {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly secretRows: readonly StoredConnectorSecretRow[];
  readonly variableValues: Record<string, string>;
}

interface ResolvedStoredConnectorMetadata {
  readonly vars: Record<string, string>;
  readonly secretConnectorMap: Record<string, string>;
  readonly secretConnectorMetadataMap: Record<string, SecretConnectorMetadata>;
  readonly environment: Record<string, string>;
}

function emptyBuiltinConnectorRuntimeContext(): BuiltinConnectorRuntimeContext {
  return {
    secrets: undefined,
    vars: undefined,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: [],
    mcpConnectorSlugs: [],
    connectorSourceIdBySlug: {},
    storedEnvironment: undefined,
  };
}

export function allowedStoredConnectorRows(
  rows: readonly StoredConnectorRuntimeRowCandidate[],
  allowedConnectorSlugs: readonly ConnectorSlug[],
  snapshot: ConnectorRuntimeSelection,
  now: Date,
): readonly StoredConnectorRuntimeRow[] {
  const validRows = rows.flatMap((row) => {
    const accessResult = resolveBuiltinConnectorCredentialAccess({
      snapshot,
      stored: {
        automaticAuthType: row.automaticAuthType,
        authMethodId: row.authMethod,
        connectorId: row.connectorId,
        connectorSlug: row.connectorSlug,
        orgId: row.orgId,
        storageVersion: row.storageVersion,
        userId: row.userId,
      },
    });
    if (accessResult.kind !== "ok") {
      return [];
    }
    const { access } = accessResult;
    return [
      {
        access,
        connectorSlug: access.runtimeMethod.connectorSlug,
        connectorStateRevision: row.connectorStateRevision,
        authMethod: access.runtimeMethod.authMethodId,
        automaticAuthType: row.automaticAuthType,
        runtimeMethod: access.runtimeMethod,
        isMcp:
          getConnectorRuntimeConnector(snapshot, row.connectorSlug)
            ?.catalogConnector.mcp !== undefined,
        needsReconnect: row.needsReconnect,
        tokenExpiresAt: row.tokenExpiresAt,
      },
    ];
  });
  return validRows.filter((row) => {
    return (
      allowedConnectorSlugs.includes(row.connectorSlug) &&
      storedConnectorRuntimeCredentialStatus(row, now) === "available"
    );
  });
}

function storedConnectorRuntimeCredentialStatus(
  row: StoredConnectorRuntimeRow,
  now: Date,
): ConnectorCredentialStatus {
  return builtinConnectorRuntimeCredentialStatusWithMethod({
    method: row.runtimeMethod.method,
    automaticAuthType: row.automaticAuthType,
    storedNeedsReconnect: row.needsReconnect,
    tokenExpiresAt: row.tokenExpiresAt,
    now,
  });
}

function connectorEnvBindingSets(
  rows: readonly StoredConnectorRuntimeRow[],
): readonly ConnectorEnvBindingSet[] {
  return rows.map((row) => {
    const metadata = connectorAuthMethodRuntimeMetadata(
      row.runtimeMethod.method,
    );
    return {
      access: row.access,
      connectorSlug: row.connectorSlug,
      connectorStateRevision: row.connectorStateRevision,
      authMethod: row.authMethod,
      runtimeBindings: metadata.runtimeBindings,
      isMcp: row.isMcp,
    };
  });
}

function storedConnectorCredentialNames(args: {
  readonly runtimeBindings: readonly ConnectorRuntimeBindingEntry[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly string[] {
  return [
    ...new Set(
      args.runtimeBindings.flatMap(({ source }) => {
        if (
          (args.kind === "secret" && source.kind !== "connector-secret") ||
          (args.kind === "variable" && source.kind !== "connector-variable") ||
          (args.names !== undefined && !args.names.has(source.name))
        ) {
          return [];
        }
        return [source.name];
      }),
    ),
  ];
}

function storedConnectorRequirementsByConnector(
  bindingSets: readonly ConnectorEnvBindingSet[],
): ReadonlyMap<string, StoredConnectorRequirements> {
  return new Map(
    bindingSets.map((bindingSet) => {
      return [
        bindingSet.access.connectorId,
        {
          secretNames: new Set(
            storedConnectorCredentialNames({
              runtimeBindings: bindingSet.runtimeBindings,
              kind: "secret",
            }),
          ),
          variableNames: new Set(
            storedConnectorCredentialNames({
              runtimeBindings: bindingSet.runtimeBindings,
              kind: "variable",
            }),
          ),
        },
      ] as const;
    }),
  );
}

export function storedConnectorCredentialReadGroups(args: {
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly kind: "secret" | "variable";
  readonly names?: ReadonlySet<string>;
}): readonly BuiltinConnectorCredentialReadGroup[] {
  return args.bindingSets.flatMap((bindingSet) => {
    const names = storedConnectorCredentialNames({
      runtimeBindings: bindingSet.runtimeBindings,
      kind: args.kind,
      ...(args.names === undefined ? {} : { names: args.names }),
    });
    return names.length === 0
      ? []
      : [
          {
            access: bindingSet.access,
            connectorStateRevision: bindingSet.connectorStateRevision,
            names,
          },
        ];
  });
}

async function mapWithBoundedConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (values.length === 0) {
    return [];
  }

  const indexedValues = values.map((value, index) => {
    return { index, value };
  });
  const results: ({ readonly value: TOutput } | undefined)[] = Array.from({
    length: values.length,
  });
  const workerCount = Math.min(Math.max(1, concurrency), indexedValues.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    while (!stopped) {
      const item = indexedValues[nextIndex];
      nextIndex += 1;
      if (!item) {
        return;
      }

      const value = await onRejection(mapper(item.value, item.index), () => {
        stopped = true;
      });
      results[item.index] = { value };
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      await worker();
    }),
  );

  return indexedValues.map((item) => {
    const result = results[item.index];
    if (!result) {
      throw new Error("Missing bounded concurrency result");
    }
    return result.value;
  });
}

export async function decryptStoredConnectorSecretRows(
  rows: readonly StoredConnectorEncryptedSecretRow[],
  args: {
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): Promise<Record<string, string>> {
  if (rows.length === 0) {
    return {};
  }

  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_context_decrypt_stored_connector_secrets",
    "nested",
    async () => {
      const decryptedRows = await mapWithBoundedConcurrency(
        rows,
        EAGER_STORED_CONNECTOR_SECRET_DECRYPT_CONCURRENCY,
        async (row) => {
          return {
            name: row.name,
            value: await decryptStoredSecretValue(
              row.encryptedValue,
              args.featureSwitchContext,
            ),
          };
        },
      );
      return Object.fromEntries(
        decryptedRows.map((row) => {
          return [row.name, row.value];
        }),
      );
    },
    {
      ...args.timingDimensions,
      stored_connector_secret_count_bucket: countBucket(rows.length),
    },
  );
}

function storedConnectorRuntimeVariables(
  bindingSets: readonly ConnectorEnvBindingSet[],
  connectorVariables: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const { runtimeBindings } of bindingSets) {
    for (const { envName, source } of runtimeBindings) {
      if (source.kind !== "connector-variable") {
        continue;
      }
      const value = connectorVariables[source.name];
      if (value !== undefined) {
        vars[envName] = value;
      }
    }
  }
  return vars;
}

function connectorSourceIdsBySlug(
  bindingSets: readonly ConnectorEnvBindingSet[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    bindingSets.map((bindingSet) => {
      return [bindingSet.connectorSlug, bindingSet.access.connectorId];
    }),
  );
}

export function resolveStoredConnectorSecrets(
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

export function storedConnectorContextFromSnapshot(
  snapshot: StoredConnectorMaterializationSnapshot | null,
): BuiltinConnectorRuntimeContext {
  if (!snapshot) {
    return emptyBuiltinConnectorRuntimeContext();
  }
  return {
    secrets: undefined,
    vars: compactRecord(
      storedConnectorRuntimeVariables(
        snapshot.bindingSets,
        snapshot.variableValues,
      ),
    ),
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: snapshot.allowedConnectorRows.map((row) => {
      return row.connectorSlug;
    }),
    mcpConnectorSlugs: snapshot.allowedConnectorRows.flatMap((row) => {
      return row.isMcp ? [row.connectorSlug] : [];
    }),
    connectorSourceIdBySlug: connectorSourceIdsBySlug(snapshot.bindingSets),
    storedEnvironment: undefined,
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

export function storedConnectorExecutionContextFromSnapshot(
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

export function referencedEnvironmentSecretAliases(
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

export function eagerStoredConnectorSecretNames(args: {
  readonly snapshot: StoredConnectorMaterializationSnapshot;
  readonly storedEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
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

export function eagerStoredConnectorSecretInputs(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
}): {
  readonly eagerStoredEnvironment: Record<string, string> | undefined;
  readonly referencedEnvironmentSecretAliases: ReadonlySet<string>;
} {
  const additionalEnvironment = args.modelProvider?.environment;
  return {
    eagerStoredEnvironment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
    }),
    referencedEnvironmentSecretAliases: referencedEnvironmentSecretAliases(
      environmentTemplates({
        content: args.content,
        additionalEnvironment,
      }),
    ),
  };
}

function buildStoredConnectorMaterializationPlan(args: {
  readonly connectorRows: readonly StoredConnectorRuntimeRowCandidate[];
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
}): StoredConnectorMaterializationPlan | null {
  const allowedConnectorRows = allowedStoredConnectorRows(
    args.connectorRows,
    args.allowedConnectorSlugs,
    args.connectorCatalogSnapshot,
    nowDate(),
  );
  if (allowedConnectorRows.length === 0) {
    return null;
  }

  const bindingSets = connectorEnvBindingSets(allowedConnectorRows);
  return {
    allowedConnectorRows,
    bindingSets,
  };
}

export function materializeStoredConnectorSnapshotRows(
  args: {
    readonly rows: readonly StoredConnectorMaterializationSnapshotRow[];
    readonly allowedConnectorSlugs: readonly ConnectorSlug[];
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
    readonly timingDimensions: ApiDispatchTimingDimensions;
  },
  timing?: ApiDispatchTimingCollector,
): StoredConnectorMaterializationSnapshot | null {
  const startedAt = now();
  const result = safeSync(() => {
    const plan = buildStoredConnectorMaterializationPlan({
      connectorRows: args.rows,
      allowedConnectorSlugs: args.allowedConnectorSlugs,
      connectorCatalogSnapshot: args.connectorCatalogSnapshot,
    });
    if (!plan) {
      return null;
    }

    const requirementsByConnector = storedConnectorRequirementsByConnector(
      plan.bindingSets,
    );
    const secretRows: StoredConnectorSecretRow[] = [];
    const variableValues: Record<string, string> = {};
    for (const row of args.rows) {
      const requirements = requirementsByConnector.get(row.connectorId);
      if (!requirements) {
        continue;
      }
      for (const name of row.secretNames) {
        if (requirements.secretNames.has(name)) {
          secretRows.push({ name });
        }
      }
      for (const [name, value] of Object.entries(row.variableValues)) {
        if (requirements.variableNames.has(name)) {
          variableValues[name] = value;
        }
      }
    }

    return {
      allowedConnectorRows: plan.allowedConnectorRows,
      bindingSets: plan.bindingSets,
      secretRows,
      variableValues,
    } satisfies StoredConnectorMaterializationSnapshot;
  });
  if ("error" in result) {
    timing?.recordElapsed(
      "api_dispatch_prepare_context_materialize_stored_connector_snapshot",
      "nested",
      startedAt,
      now(),
      {
        ...args.timingDimensions,
        stored_connector_candidate_count_bucket: countBucket(args.rows.length),
      },
    );
    throw result.error;
  }
  const snapshot = result.ok;
  timing?.recordElapsed(
    "api_dispatch_prepare_context_materialize_stored_connector_snapshot",
    "nested",
    startedAt,
    now(),
    {
      ...args.timingDimensions,
      stored_connector_candidate_count_bucket: countBucket(args.rows.length),
      stored_connector_count_bucket: countBucket(
        snapshot?.allowedConnectorRows.length ?? 0,
      ),
      stored_connector_secret_count_bucket: countBucket(
        snapshot?.secretRows.length ?? 0,
      ),
    },
  );
  return snapshot;
}

interface StoredConnectorMaterializationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorIdCandidatesBySlug:
    | ReadonlyMap<ConnectorSlug, readonly string[]>
    | undefined;
  readonly scopeSource: ConnectorScopeSource;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
}

function customConnectorRequiredMemberCredentialsAreComplete(
  row: CustomConnectorRuntimeDataRows[number],
): boolean {
  return (
    customConnectorMissingRequiredFieldKeys({
      fields: row.connector.fields,
      markers: row.values,
    }).length === 0
  );
}

export function customConnectorNewRunRowIsAdmissible(
  row: CustomConnectorRuntimeDataRows[number],
): boolean {
  return (
    row.credentialAccess.kind === "current" &&
    row.credentialAccess.runtimeAvailable &&
    (row.connector.authMode !== "manual" ||
      customConnectorManualAuthReferencesMemberField(row.connector)) &&
    customConnectorRequiredMemberCredentialsAreComplete(row)
  );
}

export async function buildNewRunCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  const orderedRows = orderedCustomConnectorRuntimeRows(args.rows);
  // Active targets call the shared builder directly so credential loss does
  // not remove their pinned firewall. Only new runs apply this admission gate.
  const context = await buildCustomConnectorRuntimeContext({
    ...args,
    rows: orderedRows.filter(customConnectorNewRunRowIsAdmissible),
  });
  return {
    ...context,
    skills: orderedRows.flatMap((row) => {
      const skill = customConnectorRuntimeSkill(row);
      return skill ? [skill] : [];
    }),
  };
}

export function storedConnectorTimingDimensions(args: {
  readonly scopeSource: ConnectorScopeSource;
  readonly connectorCount?: number;
}): ApiDispatchTimingDimensions {
  return {
    connector_scope_source: args.scopeSource,
    ...(args.connectorCount !== undefined
      ? { stored_connector_count_bucket: countBucket(args.connectorCount) }
      : {}),
  };
}

export interface PreparedConnectorContext {
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
}

export function connectorScopeForRuntimeSnapshot(
  scope: EffectiveConnectorScope,
  snapshot: ConnectorRuntimeSelection,
): EffectiveConnectorScope {
  return {
    ...scope,
    allowedConnectorSlugs: scope.allowedConnectorSlugs.filter(
      (connectorSlug) => {
        const connector = getConnectorRuntimeConnector(snapshot, connectorSlug);
        return (
          connector !== undefined &&
          [...connector.methods.values()].some((method) => {
            return method.executable;
          })
        );
      },
    ),
  };
}

export function connectorScopeFromCreateArgs(args: {
  readonly connectorScope: ExplicitConnectorScope;
}): EffectiveConnectorScope {
  const source = isEmptyRunConnectorScope(args.connectorScope)
    ? "empty"
    : (args.connectorScope.source ?? "explicit");
  return {
    allowedConnectorSlugs: args.connectorScope.allowedConnectorSlugs,
    allowedCustomConnectorIds: args.connectorScope.allowedCustomConnectorIds,
    customConnectorGrants: args.connectorScope.customConnectorGrants,
    source,
  };
}

export interface RunPreparedConnectorInputs {
  readonly db: ReadonlyDb;
  readonly connectorScope: EffectiveConnectorScope;
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<CreateRunBody, "permissionPolicies" | "vars" | "secrets">;
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
}

export interface RunConnectorSelection {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly threadConnectorSelectionIds: ThreadConnectorSelectionIds | undefined;
  readonly connectorScope: EffectiveConnectorScope;
}

export interface RunConnectorReadInput {
  readonly db: ReadonlyDb;
  readonly timing: ApiDispatchTimingCollector;
  readonly args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId?: string;
    /** Exact connector that delivered this run's durable integration input. */
    readonly connectorSourceId?: string;
    readonly includeOkouTokenSecret?: boolean;
  };
}

export interface RunConnectorContextSnapshot {
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}

export interface RunConnectorPreparation {
  readonly selection: RunConnectorSelection;
  readonly stored: StoredConnectorMaterializationArgs | null;
  readonly custom: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[];
    readonly connectorIdCandidatesByCustomConnectorId:
      | ReadonlyMap<string, readonly string[]>
      | undefined;
    readonly customConnectorGrants:
      | readonly AgentCustomConnectorGrant[]
      | undefined;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  } | null;
}

interface RunThreadConnectorSelectionRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

export function runConnectorTargetFromRow(
  row: Pick<
    RunThreadConnectorSelectionRow,
    "connectorSlug" | "customConnectorId"
  >,
): ConnectorAccountTarget {
  if (row.connectorSlug !== null && row.customConnectorId === null) {
    return {
      kind: "builtin",
      connectorSlug: connectorSlugSchema.parse(row.connectorSlug),
    };
  }
  if (row.customConnectorId !== null && row.connectorSlug === null) {
    return { kind: "custom", customConnectorId: row.customConnectorId };
  }
  throw new Error("Expected exactly one thread connector selection target");
}

export function runConnectorTargetIsAuthorized(
  scope: EffectiveConnectorScope,
  target: ConnectorAccountTarget,
): boolean {
  return target.kind === "builtin"
    ? scope.allowedConnectorSlugs.includes(
        connectorSlugSchema.parse(target.connectorSlug),
      )
    : scope.allowedCustomConnectorIds.includes(target.customConnectorId);
}

export function runThreadConnectorCandidates(
  selections: readonly ConnectorAccountSelection[],
  source: ConnectorAccountSelection | null,
): ThreadConnectorSelectionIds {
  const candidates = new Map<string, readonly ConnectorAccountSelection[]>();
  for (const selection of selections) {
    candidates.set(connectorAccountTargetKey(selection.target), [selection]);
  }
  if (source) {
    const key = connectorAccountTargetKey(source.target);
    const selected = candidates.get(key)?.[0];
    candidates.set(
      key,
      selected && selected.connectionId !== source.connectionId
        ? [source, selected]
        : [source],
    );
  }
  const connectorIdCandidatesBySlug = new Map<
    ConnectorSlug,
    readonly string[]
  >();
  const connectorIdCandidatesByCustomConnectorId = new Map<
    string,
    readonly string[]
  >();
  for (const values of candidates.values()) {
    const first = values[0];
    if (!first) {
      continue;
    }
    const ids = values.map((value) => {
      return value.connectionId;
    });
    if (first.target.kind === "builtin") {
      connectorIdCandidatesBySlug.set(
        connectorSlugSchema.parse(first.target.connectorSlug),
        ids,
      );
    } else {
      connectorIdCandidatesByCustomConnectorId.set(
        first.target.customConnectorId,
        ids,
      );
    }
  }
  return {
    connectorIdCandidatesBySlug,
    connectorIdCandidatesByCustomConnectorId,
  };
}

interface RunConnectorAccountRequest {
  readonly target: ConnectorAccountTarget;
  readonly sourceIds: readonly string[];
}

interface RunConnectorAccountRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
  readonly isDefault: boolean;
}

export function runConnectorAccountRequests(
  scope: EffectiveConnectorScope,
  selections: ThreadConnectorSelectionIds | undefined,
): readonly RunConnectorAccountRequest[] {
  return [
    ...scope.allowedConnectorSlugs.map(
      (connectorSlug): RunConnectorAccountRequest => {
        return {
          target: { kind: "builtin", connectorSlug },
          sourceIds:
            selections?.connectorIdCandidatesBySlug?.get(connectorSlug) ?? [],
        };
      },
    ),
    ...scope.allowedCustomConnectorIds.map(
      (customConnectorId): RunConnectorAccountRequest => {
        return {
          target: { kind: "custom", customConnectorId },
          sourceIds:
            selections?.connectorIdCandidatesByCustomConnectorId?.get(
              customConnectorId,
            ) ?? [],
        };
      },
    ),
  ];
}

export function runConnectorAccountCandidatesFromRows(args: {
  readonly requests: readonly RunConnectorAccountRequest[];
  readonly rows: readonly RunConnectorAccountRow[];
}): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(
    args.rows.map((row) => {
      return [row.connectorId, row];
    }),
  );
  const defaultsByTarget = new Map<string, string[]>();
  for (const row of args.rows) {
    if (!row.isDefault) {
      continue;
    }
    const key = connectorAccountTargetKey(runConnectorTargetFromRow(row));
    const ids = defaultsByTarget.get(key) ?? [];
    ids.push(row.connectorId);
    defaultsByTarget.set(key, ids);
  }
  return new Map(
    args.requests.map((request) => {
      const key = connectorAccountTargetKey(request.target);
      const explicit = request.sourceIds.filter((id) => {
        const row = byId.get(id);
        return (
          row !== undefined &&
          connectorAccountTargetKey(runConnectorTargetFromRow(row)) === key
        );
      });
      const defaults = defaultsByTarget.get(key) ?? [];
      return [
        key,
        [...new Set([...explicit, ...(defaults.length === 1 ? defaults : [])])],
      ];
    }),
  );
}

export function customConnectorCandidateRuntimeRows(args: {
  readonly connector: CustomConnectorRuntimeDataRows[number]["connector"];
  readonly candidateIds: readonly string[];
  readonly storageRows: readonly CustomConnectorRuntimeStorageRow[];
}): CustomConnectorRuntimeDataRows {
  const { connector } = args;
  const declaredFields = new Set(
    connector.fields.map(customConnectorValueMarkerKey),
  );
  const ids: readonly (string | undefined)[] = args.candidateIds.length
    ? args.candidateIds
    : [undefined];
  return ids.map((id) => {
    const storage = customConnectorRuntimeStorageSnapshot(
      [connector],
      args.storageRows,
      new Map(id ? [[connector.id, id]] : []),
    );
    const credentialAccess = storage.accesses.get(connector.id);
    if (!credentialAccess) {
      throw new Error("Expected custom connector credential access");
    }
    return {
      connector,
      credentialAccess,
      values: storage.values.filter((value) => {
        return declaredFields.has(customConnectorValueMarkerKey(value));
      }),
    };
  });
}
