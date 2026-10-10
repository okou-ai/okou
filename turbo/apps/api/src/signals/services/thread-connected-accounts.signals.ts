import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import type {
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type ConnectorAuthMethodId,
  type ConnectorSlug,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";
import { isIntegrationManagedCustomConnectorProviderAdapter } from "@okouai/api-contracts/contracts/custom-connectors";
import type { SecretConnectorMetadata } from "@okouai/api-contracts/contracts/runners";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@okouai/connectors/connector-auth-method";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { computed, type Computed } from "ccstate";
import { asc, eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import { now, nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { safeSync } from "../utils";
import { agentConnectorScopeFromRows } from "./agent-connector-scope.service";
import type {
  AgentRunContextSignals,
  BootstrapConnectorObservation,
} from "./agent-run-context.signals";
import type {
  ApiDispatchTimingCollector,
  ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import {
  type BuiltinConnectorCredentialAccess,
  resolveBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-access.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import {
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSelection,
  connectorScopeForRuntimeSnapshot,
  getConnectorRuntimeConnector,
} from "./connector-catalog-runtime.service";
import {
  builtinConnectorRuntimeCredentialStatusWithMethod,
  type ConnectorCredentialStatus,
} from "./connector-credential-status.service";
import {
  buildCustomConnectorRuntimeContext,
  type BuildCustomConnectorRuntimeContextArgs,
  compactRecord,
  type CustomConnectorRuntimeContext,
  type CustomConnectorRuntimeDataRows,
  loadEffectiveCustomConnectorPermissionBundle,
  resolveCustomConnectorBaseUrlVars,
} from "./connector-runtime-preparation.service";
import {
  customConnectorAccountAuthMethodIsCompatible,
  type CustomConnectorRuntimeStorageRow,
  customConnectorRuntimeStorageSnapshot,
} from "./custom-connector-credential-access.service";
import type { CustomConnectorPermissionBundle } from "./custom-connector-permission-bundle.service";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
  CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
  customConnectorManualAuthReferencesMemberField,
  customConnectorMissingRequiredFieldKeys,
  customConnectorValueMarkerKey,
} from "./custom-connector.service";
import { countBucket } from "./dispatch-count-bucket";
import type {
  ConnectorSourceResult,
  ConnectorSourceSnapshot,
} from "./execution-connector-sources.service";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

type ExecutionBootstrap$ = Computed<Promise<AgentRunContextSignals>>;
type ExecutionThread$ = Computed<
  Promise<PickedThreadInputEvent["thread"] | null>
>;
/** The integration account that delivered the picked input, if any. */
type ConnectorSourceId$ = Computed<Promise<string | undefined>>;
type DispatchTiming$ = Computed<ApiDispatchTimingCollector>;

export type ConnectedAccountsError = ReturnType<typeof badRequestMessage>;

function isConnectedAccountsError(
  value: unknown,
): value is ConnectedAccountsError {
  return typeof value === "object" && value !== null && "status" in value;
}

/** Connector accounts selected for one picked event's execution identity. */
export interface ConnectedAccounts {
  readonly connectorScope$: Computed<Promise<EffectiveConnectorScope>>;
  readonly connectorCatalog$: Computed<Promise<RunConnectorCatalogSelection>>;
  readonly connectorSelection$: Computed<
    Promise<RunConnectorSelection | ConnectedAccountsError>
  >;
  readonly connectorSnapshot$: Computed<
    Promise<RunConnectorContextSnapshot | ConnectedAccountsError>
  >;
  readonly threadSelections$: Computed<
    Promise<readonly ConnectorAccountSelection[]>
  >;
  readonly selectedStoredConnectorSources$: Computed<
    Promise<readonly ConnectorSourceResult[]>
  >;
}

/**
 * Selects connector accounts from the thread choice, the run's source account,
 * and account defaults, then materializes their runtime snapshot.
 */
export function createConnectedAccountsSignals(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  execution$: ExecutionBootstrap$,
  executionThread$: ExecutionThread$,
  connectorSourceId$: ConnectorSourceId$,
  dispatchTiming$: DispatchTiming$,
): ConnectedAccounts {
  const inputs = createConnectorInputSignals(
    pickedEvent$,
    execution$,
    executionThread$,
    dispatchTiming$,
  );
  const accounts = createThreadAccountSignals(
    execution$,
    connectorSourceId$,
    inputs,
  );
  const prepared = createConnectorPreparationSignals(inputs, accounts);
  const storedRows = createStoredConnectorRowSignals(
    execution$,
    accounts,
    prepared,
  );
  const stored = createStoredConnectorSnapshotSignals(
    execution$,
    inputs,
    storedRows,
  );
  const customStorage = createCustomConnectorStorageSignals(
    execution$,
    inputs,
    accounts,
  );
  const customBundles = createCustomConnectorBundleSignals(
    inputs,
    accounts,
    prepared,
    customStorage,
  );
  const custom = createCustomConnectorContextSignals(
    inputs,
    accounts,
    prepared,
    customStorage,
    customBundles,
  );
  const { connectorInput$, connectorScope$ } = inputs;
  const { preparation$ } = prepared;
  const { storedConnectorSnapshot$ } = stored;
  const { customConnectorContext$ } = custom;
  const connectorSnapshot$ = computed(
    async (
      get,
    ): Promise<RunConnectorContextSnapshot | ConnectedAccountsError> => {
      const input = await get(connectorInput$);
      const scope = await get(connectorScope$);
      return await input.timing.measure(
        "api_dispatch_prepare_context_load_connector_contexts",
        "nested",
        async () => {
          const [preparation, storedConnectorSnapshot, customConnectorContext] =
            await Promise.all([
              get(preparation$),
              get(storedConnectorSnapshot$),
              get(customConnectorContext$),
            ]);
          if (isConnectedAccountsError(preparation)) {
            return preparation;
          }
          if (isConnectedAccountsError(storedConnectorSnapshot)) {
            return storedConnectorSnapshot;
          }
          if (isConnectedAccountsError(customConnectorContext)) {
            return customConnectorContext;
          }
          return {
            storedConnectorSnapshot,
            storedConnectorMetadataContext: storedConnectorContextFromSnapshot(
              storedConnectorSnapshot,
            ),
            customConnectorContext,
          };
        },
        storedConnectorTimingDimensions({
          scopeSource: scope.source,
        }),
      );
    },
  );
  return {
    connectorScope$: inputs.connectorScope$,
    connectorCatalog$: inputs.connectorCatalog$,
    connectorSelection$: prepared.connectorSelection$,
    connectorSnapshot$,
    threadSelections$: accounts.threadSelections$,
    selectedStoredConnectorSources$: stored.selectedStoredConnectorSources$,
  };
}

type ConnectorInputSignals = ReturnType<typeof createConnectorInputSignals>;

function createConnectorInputSignals(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  execution$: ExecutionBootstrap$,
  executionThread$: ExecutionThread$,
  dispatchTiming$: DispatchTiming$,
) {
  const connectorInput$ = computed(async (get) => {
    const [event, execution] = await Promise.all([
      get(pickedEvent$),
      get(execution$),
    ]);
    if (!event) {
      throw new Error("Connected accounts require a picked event");
    }
    return {
      orgId: execution.orgId,
      userId: execution.userId,
      chatThreadId: event.chatThreadId,
      timing: get(dispatchTiming$),
    };
  });
  const connectorScope$ = computed(
    async (get): Promise<EffectiveConnectorScope> => {
      const selection = await get((await get(execution$)).connectorSelection$);
      const scope = agentConnectorScopeFromRows({
        connectorRows: selection.builtinConnectorSlugs.map((connectorSlug) => {
          return { connectorSlug };
        }),
        customConnectorRows: selection.customConnectors,
      });
      return {
        allowedConnectorSlugs: scope.allowedConnectorSlugs,
        allowedCustomConnectorIds: scope.allowedCustomConnectorIds,
        customConnectorGrants: scope.customConnectorGrants,
        source: isEmptyRunConnectorScope(scope) ? "empty" : "stored_agent",
      };
    },
  );
  const connectorCatalog$ = computed(
    async (get): Promise<RunConnectorCatalogSelection> => {
      const [catalog, scope] = await Promise.all([
        get((await get(execution$)).catalog$),
        get(connectorScope$),
      ]);
      if (isEmptyRunConnectorScope(scope)) {
        return { kind: "empty" };
      }
      if (!catalog) {
        throw new Error("Scoped connector catalog is missing from bootstrap");
      }
      return { kind: "scoped", selection: catalog };
    },
  );
  const featureSwitchContext$ = computed(async (get) => {
    return await get((await get(execution$)).featureSwitches$);
  });
  const customConnectorDefinitions$ = computed(async (get) => {
    const { timing } = await get(connectorInput$);
    return await timing.measure(
      "api_dispatch_prepare_context_load_custom_connector_rows",
      "nested",
      async () => {
        return await get((await get(execution$)).customConnectorDefinitions$);
      },
    );
  });
  const ownedThread$ = computed(async (get) => {
    const thread = await get(executionThread$);
    if (!thread) {
      return null;
    }
    const execution = await get(execution$);
    const agent = await get(execution.agent$);
    return agent?.orgId === execution.orgId
      ? { agentId: thread.agentId }
      : null;
  });
  return {
    connectorInput$,
    connectorScope$,
    connectorCatalog$,
    featureSwitchContext$,
    customConnectorDefinitions$,
    ownedThread$,
  };
}

type ThreadAccountSignals = ReturnType<typeof createThreadAccountSignals>;

function createThreadAccountSignals(
  execution$: ExecutionBootstrap$,
  connectorSourceId$: ConnectorSourceId$,
  inputs: ConnectorInputSignals,
) {
  const { connectorInput$, connectorScope$, ownedThread$ } = inputs;
  const threadSelections$ = computed(
    async (get): Promise<readonly ConnectorAccountSelection[]> => {
      const { chatThreadId } = await get(connectorInput$);
      if (!(await get(ownedThread$))) {
        return [];
      }
      const rows = await get(db$)
        .select({
          connectorId: chatThreadConnectorSelections.connectorId,
          connectorSlug: chatThreadConnectorSelections.connectorSlug,
          customConnectorId: chatThreadConnectorSelections.customConnectorId,
        })
        .from(chatThreadConnectorSelections)
        .where(eq(chatThreadConnectorSelections.chatThreadId, chatThreadId))
        .orderBy(
          asc(chatThreadConnectorSelections.connectorSlug),
          asc(chatThreadConnectorSelections.customConnectorId),
        );
      const scope = await get(connectorScope$);
      return rows
        .map((row) => {
          return {
            connectionId: row.connectorId,
            target: runConnectorTargetFromRow(row),
          };
        })
        .filter((selection) => {
          return runConnectorTargetIsAuthorized(scope, selection.target);
        });
    },
  );
  const accountRows$ = computed(async (get) => {
    return (await get((await get(execution$)).connectors$)).connectorAccounts;
  });
  const selectionIds$ = computed(
    async (
      get,
    ): Promise<ThreadConnectorSelectionIds | ConnectedAccountsError> => {
      const [thread, selections, accountRows, scope, connectorSourceId] =
        await Promise.all([
          get(ownedThread$),
          get(threadSelections$),
          get(accountRows$),
          get(connectorScope$),
          get(connectorSourceId$),
        ]);
      if (!thread) {
        return badRequestMessage("Chat thread is no longer available");
      }
      const byId = new Map(
        accountRows.map((row) => {
          return [row.connectorId, row];
        }),
      );
      const projectedSelections = selections.filter((selection) => {
        const row = byId.get(selection.connectionId);
        return (
          row !== undefined &&
          connectorAccountTargetKey(runConnectorTargetFromRow(row)) ===
            connectorAccountTargetKey(selection.target) &&
          (row.customConnectorId === null ||
            (row.customDefinitionId !== null &&
              !isIntegrationManagedCustomConnectorProviderAdapter(
                row.providerAdapter,
              )))
        );
      });
      const sourceRow = connectorSourceId
        ? byId.get(connectorSourceId)
        : undefined;
      const sourceTarget = sourceRow
        ? runConnectorTargetFromRow(sourceRow)
        : undefined;
      const source =
        sourceRow &&
        sourceTarget &&
        runConnectorTargetIsAuthorized(scope, sourceTarget)
          ? { connectionId: sourceRow.connectorId, target: sourceTarget }
          : null;
      return runThreadConnectorCandidates(projectedSelections, source);
    },
  );
  const accountCandidates$ = computed(async (get) => {
    const [selections, rows, scope] = await Promise.all([
      get(selectionIds$),
      get(accountRows$),
      get(connectorScope$),
    ]);
    return isConnectedAccountsError(selections)
      ? new Map<string, readonly string[]>()
      : runConnectorAccountCandidatesFromRows({
          requests: runConnectorAccountRequests(scope, selections),
          rows,
        });
  });
  return { threadSelections$, selectionIds$, accountCandidates$ };
}

type ConnectorPreparationSignals = ReturnType<
  typeof createConnectorPreparationSignals
>;

function createConnectorPreparationSignals(
  inputs: ConnectorInputSignals,
  accounts: ThreadAccountSignals,
) {
  const { connectorInput$, connectorScope$, connectorCatalog$ } = inputs;
  const { selectionIds$ } = accounts;
  const connectorSelection$ = computed(
    async (get): Promise<RunConnectorSelection | ConnectedAccountsError> => {
      const [connectorCatalogSelection, threadConnectorSelectionIds] =
        await Promise.all([get(connectorCatalog$), get(selectionIds$)]);
      if (isConnectedAccountsError(threadConnectorSelectionIds)) {
        return threadConnectorSelectionIds;
      }
      const scope = await get(connectorScope$);
      return {
        connectorCatalogSelection,
        threadConnectorSelectionIds,
        connectorScope:
          connectorCatalogSelection.kind === "scoped"
            ? connectorScopeForRuntimeSnapshot(
                scope,
                connectorCatalogSelection.selection,
              )
            : scope,
      };
    },
  );
  const preparation$ = computed(
    async (get): Promise<RunConnectorPreparation | ConnectedAccountsError> => {
      const input = await get(connectorInput$);
      const selection = await get(connectorSelection$);
      if (isConnectedAccountsError(selection)) {
        return selection;
      }
      const {
        connectorCatalogSelection,
        connectorScope,
        threadConnectorSelectionIds,
      } = selection;
      if (connectorCatalogSelection.kind === "empty") {
        return { selection, stored: null, custom: null };
      }
      const connectorCatalogSnapshot = connectorCatalogSelection.selection;
      // Thread runs always carry the Okou token, so MCP connectors stay allowed.
      const allowedConnectorSlugs = [
        ...new Set(connectorScope.allowedConnectorSlugs),
      ];
      return {
        selection,
        stored:
          allowedConnectorSlugs.length === 0
            ? null
            : {
                orgId: input.orgId,
                userId: input.userId,
                allowedConnectorSlugs,
                connectorIdCandidatesBySlug:
                  threadConnectorSelectionIds.connectorIdCandidatesBySlug,
                scopeSource: connectorScope.source,
                connectorCatalogSnapshot,
              },
        custom:
          connectorScope.allowedCustomConnectorIds.length === 0
            ? null
            : {
                orgId: input.orgId,
                userId: input.userId,
                allowedCustomConnectorIds:
                  connectorScope.allowedCustomConnectorIds,
                connectorIdCandidatesByCustomConnectorId:
                  threadConnectorSelectionIds.connectorIdCandidatesByCustomConnectorId,
                customConnectorGrants: connectorScope.customConnectorGrants,
                connectorCatalogSnapshot,
              },
      };
    },
  );
  return { connectorSelection$, preparation$ };
}

type StoredConnectorRowSignals = ReturnType<
  typeof createStoredConnectorRowSignals
>;

function createStoredConnectorRowSignals(
  execution$: ExecutionBootstrap$,
  accounts: ThreadAccountSignals,
  prepared: ConnectorPreparationSignals,
) {
  const { accountCandidates$ } = accounts;
  const { preparation$ } = prepared;
  const storedConnectorRows$ = computed(
    async (
      get,
    ): Promise<readonly StoredConnectorMaterializationSnapshotRow[]> => {
      const bootstrap = await get((await get(execution$)).connectors$);
      const byId = new Map(
        bootstrap.connectorSources.flatMap((result) => {
          return result.kind === "available"
            ? [[result.snapshot.source.sourceId, result.snapshot] as const]
            : [];
        }),
      );
      return bootstrap.connectorAccounts.flatMap((row) => {
        const source = byId.get(row.connectorId);
        return row.connectorSlug !== null && source
          ? [
              {
                ...row,
                connectorSlug: row.connectorSlug,
                secretNames: source.credentials.map((credential) => {
                  return credential.name;
                }),
                variableValues: source.variables,
              },
            ]
          : [];
      });
    },
  );
  const selectedStoredConnectorRows$ = computed(async (get) => {
    const [preparation, rows, candidates] = await Promise.all([
      get(preparation$),
      get(storedConnectorRows$),
      get(accountCandidates$),
    ]);
    if (isConnectedAccountsError(preparation)) {
      return preparation;
    }
    const args = preparation.stored;
    if (!args) {
      return null;
    }
    const available = new Set(
      allowedStoredConnectorRows(
        rows,
        args.allowedConnectorSlugs,
        args.connectorCatalogSnapshot,
        nowDate(),
      ).map((row) => {
        return row.access.connectorId;
      }),
    );
    const selectedIds = new Set(
      args.allowedConnectorSlugs.flatMap((connectorSlug) => {
        const ids =
          candidates.get(
            connectorAccountTargetKey({ kind: "builtin", connectorSlug }),
          ) ?? [];
        const id = ids.find((candidate) => {
          return available.has(candidate);
        });
        return id ? [id] : [];
      }),
    );
    return {
      args,
      rows: rows.filter((row) => {
        return selectedIds.has(row.connectorId);
      }),
    };
  });
  return { selectedStoredConnectorRows$ };
}

function createStoredConnectorSnapshotSignals(
  execution$: ExecutionBootstrap$,
  inputs: ConnectorInputSignals,
  storedRows: StoredConnectorRowSignals,
) {
  const { connectorInput$ } = inputs;
  const { selectedStoredConnectorRows$ } = storedRows;
  const selectedStoredConnectorSources$ = computed(async (get) => {
    const selected = await get(selectedStoredConnectorRows$);
    if (!selected || isConnectedAccountsError(selected)) {
      return [];
    }
    const ids = new Set(
      selected.rows.map((row) => {
        return row.connectorId;
      }),
    );
    return (
      await get((await get(execution$)).connectors$)
    ).connectorSources.filter((result) => {
      const source =
        result.kind === "available" ? result.snapshot.source : result.source;
      return source.kind === "builtin" && ids.has(source.sourceId);
    });
  });
  const storedConnectorSnapshot$ = computed(
    async (
      get,
    ): Promise<
      StoredConnectorMaterializationSnapshot | null | ConnectedAccountsError
    > => {
      const [selected, sources] = await Promise.all([
        get(selectedStoredConnectorRows$),
        get(selectedStoredConnectorSources$),
      ]);
      if (!selected || isConnectedAccountsError(selected)) {
        return selected;
      }
      const available = new Map(
        sources.flatMap((result) => {
          return result.kind === "available"
            ? [[result.snapshot.source.sourceId, result.snapshot] as const]
            : [];
        }),
      );
      const rows = selected.rows.flatMap((row) => {
        const source = available.get(row.connectorId);
        return source
          ? [
              {
                ...row,
                variableValues: source.variables,
                secretNames: source.credentials.map((credential) => {
                  return credential.name;
                }),
              },
            ]
          : [];
      });
      return materializeStoredConnectorSnapshotRows(
        {
          rows,
          allowedConnectorSlugs: selected.args.allowedConnectorSlugs,
          connectorCatalogSnapshot: selected.args.connectorCatalogSnapshot,
          timingDimensions: storedConnectorTimingDimensions({
            scopeSource: selected.args.scopeSource,
          }),
        },
        (await get(connectorInput$)).timing,
      );
    },
  );
  return { selectedStoredConnectorSources$, storedConnectorSnapshot$ };
}

type CustomConnectorStorageSignals = ReturnType<
  typeof createCustomConnectorStorageSignals
>;

function createCustomConnectorStorageSignals(
  execution$: ExecutionBootstrap$,
  inputs: ConnectorInputSignals,
  accounts: ThreadAccountSignals,
) {
  const { connectorInput$, connectorScope$ } = inputs;
  const { accountCandidates$ } = accounts;
  const customConnectorSources$ = computed(async (get) => {
    const [candidates, scope] = await Promise.all([
      get(accountCandidates$),
      get(connectorScope$),
    ]);
    // Every candidate is an exact saved source; Thread still owns choosing the
    // first admissible candidate per connector below.
    const sources = scope.allowedCustomConnectorIds.flatMap(
      (customConnectorId) => {
        return (
          candidates.get(
            connectorAccountTargetKey({ kind: "custom", customConnectorId }),
          ) ?? []
        ).map((sourceId) => {
          return { kind: "custom" as const, customConnectorId, sourceId };
        });
      },
    );
    const ids = new Set(
      sources.map((source) => {
        return source.sourceId;
      }),
    );
    const context = await get((await get(execution$)).connectors$);
    return {
      sources: context.connectorSources.filter((result) => {
        const source =
          result.kind === "available" ? result.snapshot.source : result.source;
        return source.kind === "custom" && ids.has(source.sourceId);
      }),
      observation: context.observation,
      scopeSource: scope.source,
      requestedCustomCount: scope.allowedCustomConnectorIds.length,
    };
  });
  const customConnectorStorageRows$ = computed(
    async (get): Promise<readonly CustomConnectorRuntimeStorageRow[]> => {
      const { timing } = await get(connectorInput$);
      const startedAt = now();
      const result = await get(customConnectorSources$);
      const finishedAt = now();
      safeSync(() => {
        const dimensions = connectorContextTimingDimensions(result);
        timing.recordElapsed(
          "api_dispatch_prepare_context_load_custom_connector_value_rows",
          "nested",
          startedAt,
          finishedAt,
          dimensions,
        );
        recordConnectorContextObservation(
          timing,
          result.observation,
          dimensions,
        );
      });
      const projectionStartedAt = performance.now();
      const rows = result.sources.flatMap((source) => {
        return source.kind === "available"
          ? customConnectorSourceStorageRows(source.snapshot)
          : [];
      });
      safeSync(() => {
        timing.recordDuration(
          "api_dispatch_prepare_context_project_custom_connector_value_rows",
          "nested",
          performance.now() - projectionStartedAt,
          now(),
          connectorContextTimingDimensions(result),
        );
      });
      return rows;
    },
  );
  return { customConnectorStorageRows$ };
}

type CustomConnectorBundleSignals = ReturnType<
  typeof createCustomConnectorBundleSignals
>;

function createCustomConnectorBundleSignals(
  inputs: ConnectorInputSignals,
  accounts: ThreadAccountSignals,
  prepared: ConnectorPreparationSignals,
  customStorage: CustomConnectorStorageSignals,
) {
  const { customConnectorDefinitions$ } = inputs;
  const { accountCandidates$ } = accounts;
  const { preparation$ } = prepared;
  const { customConnectorStorageRows$ } = customStorage;
  const customConnectorPermissionBundles$ = computed(async (get) => {
    const [preparation, connectors, storageRows, candidates] =
      await Promise.all([
        get(preparation$),
        get(customConnectorDefinitions$),
        get(customConnectorStorageRows$),
        get(accountCandidates$),
      ]);
    if (isConnectedAccountsError(preparation) || !preparation.custom) {
      return new Map<
        string,
        CustomConnectorPermissionBundle | null | undefined
      >();
    }
    const snapshot = preparation.custom.connectorCatalogSnapshot;
    const entries = await Promise.all(
      connectors.map(async (connector) => {
        const rows = customConnectorCandidateRuntimeRows({
          connector,
          storageRows,
          candidateIds:
            candidates.get(
              connectorAccountTargetKey({
                kind: "custom",
                customConnectorId: connector.id,
              }),
            ) ?? [],
        });
        const row = rows.find((candidate) => {
          return (
            customConnectorNewRunRowIsAdmissible(candidate) &&
            resolveCustomConnectorBaseUrlVars({
              row: candidate,
              provided: undefined,
              hasProvided: false,
            }) !== undefined
          );
        });
        if (!row) {
          return [connector.id, null] as const;
        }
        const bundle = await loadEffectiveCustomConnectorPermissionBundle({
          row,
          snapshot,
        });
        return [connector.id, bundle] as const;
      }),
    );
    return new Map(entries);
  });
  return { customConnectorPermissionBundles$ };
}

function createCustomConnectorContextSignals(
  inputs: ConnectorInputSignals,
  accounts: ThreadAccountSignals,
  prepared: ConnectorPreparationSignals,
  customStorage: CustomConnectorStorageSignals,
  customBundles: CustomConnectorBundleSignals,
) {
  const {
    connectorInput$,
    featureSwitchContext$,
    customConnectorDefinitions$,
  } = inputs;
  const { accountCandidates$ } = accounts;
  const { preparation$ } = prepared;
  const { customConnectorStorageRows$ } = customStorage;
  const { customConnectorPermissionBundles$ } = customBundles;
  const customConnectorContext$ = computed(
    async (
      get,
    ): Promise<CustomConnectorRuntimeContext | ConnectedAccountsError> => {
      const [
        preparation,
        connectors,
        storageRows,
        candidates,
        featureSwitchContext,
        permissionBundlesByConnectorId,
      ] = await Promise.all([
        get(preparation$),
        get(customConnectorDefinitions$),
        get(customConnectorStorageRows$),
        get(accountCandidates$),
        get(featureSwitchContext$),
        get(customConnectorPermissionBundles$),
      ]);
      if (isConnectedAccountsError(preparation)) {
        return preparation;
      }
      if (!preparation.custom) {
        return emptyCustomConnectorRuntimeContext();
      }
      const args = preparation.custom;
      const chosenRows = await Promise.all(
        connectors.map(async (connector) => {
          const rows = customConnectorCandidateRuntimeRows({
            connector,
            storageRows,
            candidateIds:
              candidates.get(
                connectorAccountTargetKey({
                  kind: "custom",
                  customConnectorId: connector.id,
                }),
              ) ?? [],
          });
          for (const row of rows) {
            const context = await buildNewRunCustomConnectorRuntimeContext({
              rows: [row],
              permissionBundlesByConnectorId,
              featureSwitchContext,
              connectorCatalogSnapshot: args.connectorCatalogSnapshot,
              grants: args.customConnectorGrants,
            });
            if (context.targets.length > 0) {
              return row;
            }
          }
          return {
            connector,
            values: [],
            credentialAccess: { kind: "absent" as const },
          };
        }),
      );
      return await (
        await get(connectorInput$)
      ).timing.measure(
        "api_dispatch_prepare_context_build_custom_connector_firewalls",
        "nested",
        async () => {
          return await buildNewRunCustomConnectorRuntimeContext({
            rows: chosenRows,
            permissionBundlesByConnectorId,
            featureSwitchContext,
            connectorCatalogSnapshot: args.connectorCatalogSnapshot,
            grants: args.customConnectorGrants,
          });
        },
      );
    },
  );
  return { customConnectorContext$ };
}

function customConnectorSourceStorageRows(
  snapshot: ConnectorSourceSnapshot,
): readonly CustomConnectorRuntimeStorageRow[] {
  const { source, connection, customBinding: binding } = snapshot;
  if (source.kind !== "custom" || !binding) {
    return [];
  }
  const credentialId = (name: string) => {
    return (
      snapshot.credentials.find((credential) => {
        return credential.name === name;
      })?.id ?? null
    );
  };
  const base = {
    id: source.sourceId,
    updatedAt: connection.updatedAt,
    customConnectorId: source.customConnectorId,
    storedAuthMethod: connection.authMethod,
    storedStorageVersion: connection.storageVersion,
    storedNeedsReconnect: connection.needsReconnect,
    tokenExpiresAt: connection.tokenExpiresAt,
    definitionAuthMethod: binding.definitionAuthMode,
    definitionMcpTransport: binding.definitionMcpTransport,
    definitionStorageVersion: binding.definitionStorageVersion,
    oauthAccessTokenId: credentialId(
      CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
    ),
    oauthRefreshTokenId: credentialId(
      CUSTOM_CONNECTOR_OAUTH_REFRESH_TOKEN_SECRET_NAME,
    ),
    automaticOAuthBindingId: binding.automaticOAuthBindingId,
  };
  // Saved values only count for a compatible auth method at the exact current
  // definition storage version; secrets never apply to unauthenticated access.
  const current =
    customConnectorAccountAuthMethodIsCompatible(
      binding.definitionAuthMode,
      connection.authMethod,
    ) && connection.storageVersion === binding.definitionStorageVersion;
  const values = current
    ? [
        ...(connection.authMethod === "none"
          ? []
          : snapshot.credentials.map((credential) => {
              return {
                kind: "secret" as const,
                key: credential.name,
                storedValue: credential.encryptedValue,
              };
            })),
        ...Object.entries(snapshot.variables).map(([key, storedValue]) => {
          return { kind: "variable" as const, key, storedValue };
        }),
      ]
    : [];
  return values.length === 0
    ? [{ ...base, kind: null, key: null, storedValue: null }]
    : values.map((value) => {
        return { ...base, ...value };
      });
}

export type ConnectorScopeSource = "explicit" | "stored_agent" | "empty";

export interface EffectiveConnectorScope {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
  readonly customConnectorGrants:
    readonly AgentCustomConnectorGrant[] | undefined;
  readonly source: ConnectorScopeSource;
}

interface ThreadConnectorSelectionIds {
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

export function isEmptyRunConnectorScope(scope: {
  readonly allowedConnectorSlugs: readonly ConnectorSlug[];
  readonly allowedCustomConnectorIds: readonly string[];
}): boolean {
  return (
    scope.allowedConnectorSlugs.length === 0 &&
    scope.allowedCustomConnectorIds.length === 0
  );
}

function emptyCustomConnectorRuntimeContext(): CustomConnectorRuntimeContext {
  return {
    firewalls: [],
    reservedSecretAliases: undefined,
    permissionPolicies: undefined,
    targets: [],
    customConnectorIdByFirewallName: {},
    customConnectorSourceIdByFirewallName: {},
  };
}

export interface BuiltinConnectorRuntimeContext {
  readonly secrets: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly secretConnectorMetadataMap:
    Record<string, SecretConnectorMetadata> | undefined;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly mcpConnectorSlugs: readonly ConnectorSlug[];
  readonly connectorSourceIdBySlug: Readonly<Record<string, string>>;
  readonly storedEnvironment: Record<string, string> | undefined;
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

interface StoredConnectorMaterializationSnapshotRow extends StoredConnectorRuntimeRowCandidate {
  readonly secretNames: readonly string[];
  readonly variableValues: Readonly<Record<string, string>>;
}

export interface ConnectorEnvBindingSet {
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

export interface StoredConnectorSecretRow {
  readonly name: string;
}

export interface StoredConnectorMaterializationSnapshot {
  readonly allowedConnectorRows: readonly StoredConnectorRuntimeRow[];
  readonly bindingSets: readonly ConnectorEnvBindingSet[];
  readonly secretRows: readonly StoredConnectorSecretRow[];
  readonly variableValues: Record<string, string>;
}

export function emptyBuiltinConnectorRuntimeContext(): BuiltinConnectorRuntimeContext {
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

function allowedStoredConnectorRows(
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

export function storedConnectorCredentialNames(args: {
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

function materializeStoredConnectorSnapshotRows(
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
    ReadonlyMap<ConnectorSlug, readonly string[]> | undefined;
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

function customConnectorNewRunRowIsAdmissible(
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

async function buildNewRunCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  // Active targets call the shared builder directly so credential loss does
  // not remove their pinned firewall. Only new runs apply this admission gate.
  return await buildCustomConnectorRuntimeContext({
    ...args,
    rows: args.rows.filter(customConnectorNewRunRowIsAdmissible),
  });
}

function connectorContextTimingDimensions(args: {
  readonly observation: BootstrapConnectorObservation | undefined;
  readonly scopeSource: ConnectorScopeSource;
  readonly requestedCustomCount: number;
  readonly sources: readonly unknown[];
}): ApiDispatchTimingDimensions {
  const observation = args.observation;
  return {
    connector_context_schema: "shared_v2",
    connector_value_rows_semantics: "shared_context_wait_v1",
    connector_scope_source: args.scopeSource,
    connector_context_requested_custom_count_bucket: countBucket(
      args.requestedCustomCount,
    ),
    connector_context_candidate_custom_count_bucket: countBucket(
      args.sources.length,
    ),
    connector_context_observation: !observation
      ? "missing"
      : observation.query && observation.materialize && observation.sources
        ? "complete"
        : "partial",
    ...(observation
      ? {
          connector_context_returned_row_count_bucket: countBucket(
            observation.returnedRowCount,
          ),
          connector_context_account_count_bucket: countBucket(
            observation.accountCount,
          ),
          connector_context_custom_account_count_bucket: countBucket(
            observation.customAccountCount,
          ),
          connector_context_stored_value_count_bucket: countBucket(
            observation.storedValueCount,
          ),
          connector_context_pool_capture:
            observation.acquisitions.length === 1
              ? "single"
              : observation.acquisitions.length === 0
                ? "missing"
                : "multiple",
        }
      : {}),
  };
}

function recordConnectorContextObservation(
  timing: ApiDispatchTimingCollector,
  observation: BootstrapConnectorObservation | undefined,
  dimensions: ApiDispatchTimingDimensions,
): void {
  if (!observation) {
    return;
  }
  const stages = [
    [
      "api_dispatch_prepare_context_connector_context_environment_query",
      observation.query,
    ],
    [
      "api_dispatch_prepare_context_connector_context_environment_materialize",
      observation.materialize,
    ],
    [
      "api_dispatch_prepare_context_connector_context_sources_materialize",
      observation.sources,
    ],
  ] as const;
  for (const [actionType, duration] of stages) {
    if (duration) {
      timing.recordDuration(
        actionType,
        "nested",
        duration.durationMs,
        duration.finishedAt,
        dimensions,
      );
    }
  }
  // This canonical statement should acquire exactly one client. Do not invent
  // zero wait or combine multiple acquisition intervals if coverage differs.
  const [acquisition] = observation.acquisitions;
  if (observation.acquisitions.length === 1 && acquisition) {
    timing.recordDuration(
      "api_dispatch_prepare_context_connector_context_pool_acquire",
      "nested",
      acquisition.durationMs,
      acquisition.finishedAt,
      { ...dimensions, connector_context_pool_acquire_path: acquisition.path },
    );
  }
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

export interface RunConnectorSelection {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly threadConnectorSelectionIds: ThreadConnectorSelectionIds;
  readonly connectorScope: EffectiveConnectorScope;
}

export interface RunConnectorContextSnapshot {
  readonly storedConnectorSnapshot: StoredConnectorMaterializationSnapshot | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}

interface RunConnectorPreparation {
  readonly selection: RunConnectorSelection;
  readonly stored: StoredConnectorMaterializationArgs | null;
  readonly custom: {
    readonly orgId: string;
    readonly userId: string;
    readonly allowedCustomConnectorIds: readonly string[];
    readonly connectorIdCandidatesByCustomConnectorId:
      ReadonlyMap<string, readonly string[]> | undefined;
    readonly customConnectorGrants:
      readonly AgentCustomConnectorGrant[] | undefined;
    readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  } | null;
}

interface RunThreadConnectorSelectionRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

function runConnectorTargetFromRow(
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

function runConnectorTargetIsAuthorized(
  scope: EffectiveConnectorScope,
  target: ConnectorAccountTarget,
): boolean {
  return target.kind === "builtin"
    ? scope.allowedConnectorSlugs.includes(
        connectorSlugSchema.parse(target.connectorSlug),
      )
    : scope.allowedCustomConnectorIds.includes(target.customConnectorId);
}

function runThreadConnectorCandidates(
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

function runConnectorAccountRequests(
  scope: EffectiveConnectorScope,
  selections: ThreadConnectorSelectionIds,
): readonly RunConnectorAccountRequest[] {
  return [
    ...scope.allowedConnectorSlugs.map(
      (connectorSlug): RunConnectorAccountRequest => {
        return {
          target: { kind: "builtin", connectorSlug },
          sourceIds:
            selections.connectorIdCandidatesBySlug.get(connectorSlug) ?? [],
        };
      },
    ),
    ...scope.allowedCustomConnectorIds.map(
      (customConnectorId): RunConnectorAccountRequest => {
        return {
          target: { kind: "custom", customConnectorId },
          sourceIds:
            selections.connectorIdCandidatesByCustomConnectorId.get(
              customConnectorId,
            ) ?? [],
        };
      },
    ),
  ];
}

function runConnectorAccountCandidatesFromRows(args: {
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

function customConnectorCandidateRuntimeRows(args: {
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

export type RunConnectorCatalogSelection =
  | { readonly kind: "empty" }
  | {
      readonly kind: "scoped";
      readonly selection: ConnectorRuntimeSelection;
    };
