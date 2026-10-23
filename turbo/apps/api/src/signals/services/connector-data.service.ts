import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { isOneClickConnectorGrantKind } from "@okouai/api-contracts/contracts/connector-catalog";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorCredentialReconnectReasonSchema,
  type BuiltinConnectorListResponse,
  type BuiltinConnectorResponse,
  type ConnectorCredentialReconnectReason,
  type ScopeDiffResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import type { BuiltinConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import { revokeConnectorAuthMethodAccessTokenWithMethod } from "@okouai/connectors/auth-providers";
import {
  connectorAuthMethodGrantMetadata,
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodRuntimeMetadata,
  connectorAuthMethodScopeDiff,
  type ConnectorOutputTarget,
} from "@okouai/connectors/connector-auth-method";
import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorManualGrantFieldConfig,
} from "@okouai/connectors/connector-config";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { connectors } from "@okouai/db/schema/connector";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { mailDrafts } from "@okouai/db/schema/mail-draft";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { command, computed, type Computed } from "ccstate";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import * as z from "zod";
import {
  completedGetStartedQuestSql,
  memberRewardWalletQuery,
} from "./get-started-member-reward";
import { slackRewardWalletEntitlement } from "./slack-installation-reward";

import { pgTextDecoder } from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { immutableConnectorRuntimeSelection } from "./connector-catalog-entries.service";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db } from "../external/db";
import { bestEffort, settle, settleIncludingAbort } from "../utils";
import {
  builtinConnectorCredentialStorageIsCompatible,
  builtinConnectorTokenRevokeReadPlan,
  builtinConnectorTokenRevokeInputsFromRows,
  resolveBuiltinConnectorCredentialAccess,
  resolveStoredBuiltinConnectorRuntimeMethod,
} from "./builtin-connector-credential-access.service";
import {
  connectorAccountFieldMarkers,
  prepareConnectorAccountDeletionWithTargetLocked,
} from "./connector-account-lifecycle.service";
import {
  connectorAccountSetup,
  connectorAccountSetupMarkerKey,
  connectorAccountStatus,
} from "./connector-account-setup";
import {
  builtinDeletionReadPlan,
  builtinDeletionFromRows,
  builtinDeletionResult,
  type BuiltinDeletionAccount,
} from "./connector-account-resolution.service";
import {
  connectorAccountEmailWhere,
  connectorAccountPrincipalWatchTables,
  connectorAccountReconciliationIdentity,
} from "./connector-account-state.service";
import { normalizeManualGrantSubmittedValuesWithMethod } from "./connector-catalog-form-fields.service";
import {
  connectorCatalogSearchFromSnapshot,
  loadAcceptedConnectorCatalogSnapshot,
} from "./connector-catalog-external-reader.service";
import { isConnectorCatalogUnavailableError } from "./connector-catalog-reader.service";
import type {
  ConnectorRuntimeMethod,
  ConnectorRuntimeLookup,
  ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionFromRows,
  connectorRuntimeSlugSelectionReadPlan,
} from "./connector-catalog-slug-source.service";
import { publishBuiltinConnectorInvalidationAfterCommit } from "./connector-client-invalidation.service";
import {
  replaceConnectorConnectionOutcome,
  resolveConnectorConnectionMutation,
  type ConnectorConnectionMutationResolution,
  type StoredConnectorConnectionRow as StoredConnectorRow,
} from "./connector-connection-write.service";
import {
  builtinConnectorCredentialReconnectReasonWithMethod,
  builtinConnectorCredentialStatusWithMethod,
} from "./connector-credential-status.service";
import {
  deleteConnectorCredentialStorageConnection,
  connectorOwnedSecretWrite,
  connectorOwnedVariableWrite,
  manualGrantUserSecretDeletion,
  manualGrantUserVariableDeletion,
} from "./connector-credential-storage-write.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  userFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import { reconcileGmailWatchesForUser$ } from "./gmail-automation-watch.service";
import { gmailAutomationResolvedLabelInvalidationWrite } from "./gmail-automation-account.service";
import {
  notionPendingEventsReconnectScope,
  notionPendingEventsSkipWrite,
} from "./notion-automation-account.service";
import {
  prepareGoogleCalendarWatchStopForConnector$,
  stopPreparedGoogleCalendarWatches,
  type PendingGoogleCalendarWatchStop,
  reconcileGoogleCalendarWatchesForUser$,
} from "./google-calendar-automation-watch.service";

import {
  prepareGoogleFormsWatchStopForConnector$,
  stopPreparedGoogleFormsWatches,
  type PendingGoogleFormsWatchStop,
  reconcileGoogleFormsWatchesForUser$,
} from "./google-forms-automation-watch.service";

import {
  deletePreparedGoogleMeetSubscriptionIfUnadopted$,
  prepareGoogleMeetSubscriptionDeleteForConnector$,
  reconcileGoogleMeetSubscriptionsForUser$,
  type PendingGoogleMeetSubscriptionDelete,
} from "./google-meet-automation-watch.service";

import { reprojectWorkflowAutomationsForOwner } from "./workflow-automation-account-projection.service";

const log = logger("api:connector-data");
const oauthScopesSchema = z.array(z.string());
const DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS = 15 * 60;
interface ExternalUserInfo {
  readonly id: string;
  readonly username: string | null;
  readonly email: string | null;
}

interface PreparedManualGrantField {
  readonly name: string;
  readonly value: string;
}

interface BuiltinConnectorTokenOutputMetadata {
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
  readonly isRefreshable: boolean;
}

type BuiltinConnectorTokenOutputValues = Readonly<
  Record<string, string | null | undefined>
>;

interface PreparedManualGrantConnect {
  readonly secretValues: readonly PreparedManualGrantField[];
  readonly variableValues: readonly PreparedManualGrantField[];
  readonly configuredSecretNames: readonly string[];
  readonly configuredVariableNames: readonly string[];
}
type PreparedManualGrantConnectResult =
  | {
      readonly ok: true;
      readonly prepared: PreparedManualGrantConnect;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };
type ConnectManualGrantConnectorResult =
  | {
      readonly status: "connected";
      readonly connector: BuiltinConnectorResponse;
    }
  | {
      readonly status: "invalid";
      readonly message: string;
    }
  | ConnectorConnectionMutationFailure;

type ConnectNoAuthConnectorResult =
  | {
      readonly status: "connected";
      readonly connector: BuiltinConnectorResponse;
    }
  | ConnectorConnectionMutationFailure;
type ConnectorConnectionMutationFailure =
  | {
      readonly status: "accountNotFound";
    }
  | {
      readonly status: "accountAmbiguous";
    }
  | {
      readonly status: "siblingDisabled";
    };

type ConnectorConnectionWriteFailureStatus =
  ConnectorConnectionMutationFailure["status"] | "identityMismatch";

export function connectorConnectionWriteFailureMessage(
  status: ConnectorConnectionWriteFailureStatus,
): string {
  switch (status) {
    case "accountNotFound": {
      return "Connector account not found";
    }
    case "identityMismatch": {
      return "Authorized account does not match the connector account";
    }
    case "accountAmbiguous": {
      return "Multiple connector accounts require an exact choice";
    }
    case "siblingDisabled": {
      return "This connector does not support additional accounts";
    }
  }
}
export function connectorConnectionWriteRejection(
  status: ConnectorConnectionWriteFailureStatus,
): {
  readonly ok: false;
  readonly message: string;
} {
  return { ok: false, message: connectorConnectionWriteFailureMessage(status) };
}
function connectorConnectionMutationFailure(
  resolution: Exclude<
    ConnectorConnectionMutationResolution,
    {
      readonly kind: "ready";
    }
  >,
): ConnectorConnectionMutationFailure {
  switch (resolution.kind) {
    case "missing": {
      return { status: "accountNotFound" };
    }
    case "ambiguous": {
      return { status: "accountAmbiguous" };
    }
    case "sibling-disabled": {
      return { status: "siblingDisabled" };
    }
  }
}

interface EncryptedManualGrantSecret {
  readonly name: string;
  readonly encryptedValue: string;
}

interface EncryptedBuiltinConnectorTokenSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

interface PreparedBuiltinConnectorTokenVariable {
  readonly name: string;
  readonly value: string;
}

interface PreparedBuiltinConnectorTokenState {
  readonly secrets: readonly EncryptedBuiltinConnectorTokenSecret[];
  readonly variables: readonly PreparedBuiltinConnectorTokenVariable[];
}

interface BuiltinConnectorTokenOutputRequirements {
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
}

interface BuiltinConnectorWithRuntimeMethod {
  readonly response: BuiltinConnectorResponse;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly oauthRequestedScopes: readonly string[] | null;
}

type PendingBuiltinConnectorTokenRevoke = {
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly encryptedInputs: Readonly<Record<string, string>>;
  readonly featureSwitchContext: FeatureSwitchContext;
};

/**
 * External catalog availability must not turn persisted connector reads or
 * local cleanup into server failures. Callers use a missing snapshot to skip
 * runtime-dependent presentation and provider revocation only.
 */
export const readStoredBuiltinConnectorRuntimeSnapshot$ = command(
  async (
    { get },
    connectorSlugs: readonly ConnectorSlug[],
    // Account deletion retains its enclosing post-read cancellation check
    // by omitting this optional signal.
    signal?: AbortSignal,
  ): Promise<ConnectorRuntimeSelection | null> => {
    const result = await settle(
      (async () => {
        const plan = connectorRuntimeSlugSelectionReadPlan({ connectorSlugs });
        const rows = await get(db$)
          .select(plan.columns)
          .from(connectorCatalog)
          .leftJoin(connectorCatalogEntries, plan.join)
          .where(connectorCatalogCurrentWhere());
        return connectorRuntimeSlugSelectionFromRows(plan.selection, rows);
      })(),
      signal,
    );
    signal?.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    if (!isConnectorCatalogUnavailableError(result.error)) {
      throw result.error;
    }
    log.warn(
      "Connector catalog unavailable while resolving stored connectors",
      {
        error: result.error,
      },
    );
    return null;
  },
);

/**
 * Loads only the catalog entries for the given stored connectors from the
 * immutable entries, instead of decoding the full catalog. Empty stored
 * sets retain the local null contract; a missing current row fails fast. This
 * list is presentation, so a stored connection without an entry is omitted.
 */
function loadStoredBuiltinConnectorRuntimeSelection(
  connectorSlugs: readonly string[],
): Computed<Promise<ConnectorRuntimeLookup | null>> {
  return computed(async (get) => {
    const requestedConnectorSlugs = connectorSlugs.flatMap((connectorSlug) => {
      const slug = connectorSlugSchema.safeParse(connectorSlug);
      return slug.success ? [slug.data] : [];
    });
    if (requestedConnectorSlugs.length === 0) {
      return null;
    }
    return await get(
      immutableConnectorRuntimeSelection({
        requestedConnectorSlugs,
      }),
    );
  });
}

function parseOauthScopes(value: string | null): string[] | null {
  return value ? oauthScopesSchema.parse(JSON.parse(value)) : null;
}

function parseStoredReconnectReason(
  value: string | null,
): ConnectorCredentialReconnectReason | null {
  if (value === null) {
    return null;
  }
  const parsed = connectorCredentialReconnectReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function storedBuiltinConnectorRowToResponse(
  row: StoredConnectorRow,
  runtimeMethod: ConnectorRuntimeMethod,
  now: Date,
): BuiltinConnectorResponse {
  const storageCompatible = builtinConnectorCredentialStorageIsCompatible({
    runtimeMethod,
    automaticAuthType: row.automaticAuthType,
    storageVersion: row.storageVersion,
  });
  const credentialStatus = builtinConnectorCredentialStatusWithMethod({
    method: runtimeMethod.method,
    automaticAuthType: row.automaticAuthType,
    storedNeedsReconnect: row.needsReconnect,
    tokenExpiresAt: row.tokenExpiresAt,
    now,
  });
  const connectionStatus =
    !storageCompatible || credentialStatus === "reconnect-required"
      ? "reconnect-required"
      : "connected";
  return {
    id: row.id,
    slug: runtimeMethod.connectorSlug,
    authMethod: runtimeMethod.authMethodId,
    externalId: row.externalId,
    externalUsername: row.externalUsername,
    externalEmail: row.externalEmail,
    oauthScopes: parseOauthScopes(row.oauthGrantedScopes),
    connectionStatus,
    reconnectReason: !storageCompatible
      ? null
      : connectionStatus === "reconnect-required"
        ? (parseStoredReconnectReason(row.reconnectReason) ??
          builtinConnectorCredentialReconnectReasonWithMethod({
            method: runtimeMethod.method,
            automaticAuthType: row.automaticAuthType,
            storedNeedsReconnect: row.needsReconnect,
            tokenExpiresAt: row.tokenExpiresAt,
            now,
          }))
        : null,
    tokenExpiresAt: row.tokenExpiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function storedBuiltinConnectorRowWithRuntimeMethod(args: {
  readonly connectorSlug: string;
  readonly now: Date;
  readonly row: StoredConnectorRow;
  readonly snapshot: ConnectorRuntimeLookup;
}): BuiltinConnectorWithRuntimeMethod | null {
  const runtimeMethod = resolveStoredBuiltinConnectorRuntimeMethod({
    snapshot: args.snapshot,
    stored: {
      connectorId: args.row.id,
      connectorSlug: args.connectorSlug,
      authMethodId: args.row.authMethod,
    },
  });
  if (runtimeMethod === undefined) {
    return null;
  }
  return {
    response: storedBuiltinConnectorRowToResponse(
      args.row,
      runtimeMethod,
      args.now,
    ),
    runtimeMethod,
    oauthRequestedScopes: parseOauthScopes(args.row.oauthScopes),
  };
}

function builtinConnectorAccountResponse(
  connector: BuiltinConnectorWithRuntimeMethod,
  row: StoredConnectorRow,
  snapshot: ConnectorRuntimeLookup | null,
  markers: ReadonlyMap<string, ReadonlySet<string>>,
): BuiltinConnectorResponse {
  const account = {
    ...row,
    connectorSlug: connector.runtimeMethod.connectorSlug,
    definitionAuthMode: null,
    definitionMcpTransport: null,
    definitionStorageVersion: null,
    definitionFields: [],
  };
  const setup = connectorAccountSetup(
    account,
    snapshot,
    markers.get(connectorAccountSetupMarkerKey(account)) ?? new Set(),
  );
  const status = connectorAccountStatus(connector.response, setup);
  return {
    ...connector.response,
    connectionStatus: status.connectionStatus,
    reconnectReason: status.reconnectReason,
  };
}

function manualGrantFieldsForAuthMethod(
  method: ConnectorAuthMethodRuntimeConfig,
): Record<string, ConnectorManualGrantFieldConfig> | null {
  return method?.grant.kind === "manual" ? method.grant.fields : null;
}

function sanitizeManualGrantValue(value: string): string {
  return value.replace(/\s+/gu, "");
}

/**
 * Normalize a host/domain field value to bare `host[:port]`.
 *
 * Strips the URL scheme, userinfo, path, query, fragment, and any trailing
 * slash, so a user can paste a full backend URL (e.g.
 * `https://my-project.example.app/`) into a field that is templated into a
 * firewall base URL's authority position (`https://${{ vars.X }}`), where the
 * firewall validator rejects values that introduce URL structure.
 */
function normalizeManualGrantHost(value: string): string {
  // Strip a leading scheme (e.g. "https://").
  let host = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, "");
  // Keep only the authority: drop path, query, and fragment.
  host = host.split(/[/?#]/u)[0] ?? host;
  // Drop userinfo ("user@host" -> "host").
  const atIndex = host.lastIndexOf("@");
  if (atIndex !== -1) {
    host = host.slice(atIndex + 1);
  }
  return host;
}

function formatManualGrantFieldList(names: readonly string[]): string {
  return [...names].sort().join(", ");
}

function throwCapturedAbort(error: unknown): void {
  if (error !== null) {
    throw error;
  }
}

async function finalizeConnectorStateChangeAfterCommit(
  args: {
    readonly userId: string;
    readonly connectorSlug: ConnectorSlug;
    readonly pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null;
    readonly postCommitAbort: unknown;
  },
  signal: AbortSignal,
): Promise<void> {
  let postCommitAbort = args.postCommitAbort;
  if (args.pendingTokenRevoke) {
    await revokePendingConnectorToken(
      {
        pending: args.pendingTokenRevoke,
      },
      signal,
    );
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }
  }

  await publishBuiltinConnectorInvalidationAfterCommit(
    {
      userId: args.userId,
      connectorSlug: args.connectorSlug,
      ...(postCommitAbort === null
        ? {}
        : { previouslyCapturedAbort: { reason: postCommitAbort } }),
    },
    signal,
  );
}
function prepareManualGrantConnect(
  runtimeMethod: ConnectorRuntimeMethod,
  values: Readonly<Record<string, string>>,
): PreparedManualGrantConnectResult {
  const normalizedValuesResult = normalizeManualGrantSubmittedValuesWithMethod({
    connectorSlug: runtimeMethod.connectorSlug,
    authMethodId: runtimeMethod.authMethodId,
    method: runtimeMethod.method,
    values,
  });
  if (!normalizedValuesResult.ok) {
    return {
      ok: false,
      message: normalizedValuesResult.message,
    };
  }
  const fields = manualGrantFieldsForAuthMethod(runtimeMethod.method);
  if (!fields) {
    return {
      ok: false,
      message: `${runtimeMethod.connectorSlug} ${runtimeMethod.authMethodId} auth method does not use a manual grant`,
    };
  }
  const sanitizedValues = new Map<string, string>();
  for (const [name, value] of Object.entries(normalizedValuesResult.values)) {
    sanitizedValues.set(name, sanitizeManualGrantValue(value));
  }
  const secretValues: PreparedManualGrantField[] = [];
  const variableValues: PreparedManualGrantField[] = [];
  const configuredSecretNames: string[] = [];
  const configuredVariableNames: string[] = [];
  const missingRequiredNames: string[] = [];
  for (const [name, config] of Object.entries(fields)) {
    const storage = config.storage ?? "secret";
    if (storage === "variable") {
      configuredVariableNames.push(name);
    } else {
      configuredSecretNames.push(name);
    }
    const sanitized = sanitizedValues.get(name) ?? "";
    const value =
      sanitized && config.normalize === "host"
        ? normalizeManualGrantHost(sanitized)
        : sanitized;
    if (!value) {
      if (config.required) {
        missingRequiredNames.push(config.publicId);
      }
      continue;
    }
    const target = storage === "variable" ? variableValues : secretValues;
    target.push({ name, value });
  }
  if (missingRequiredNames.length > 0) {
    return {
      ok: false,
      message: `Missing required manual grant field(s): ${formatManualGrantFieldList(missingRequiredNames)}`,
    };
  }
  return {
    ok: true,
    prepared: {
      secretValues,
      variableValues,
      configuredSecretNames,
      configuredVariableNames,
    },
  };
}

async function encryptManualGrantSecrets(
  args: {
    readonly secretValues: readonly PreparedManualGrantField[];
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<readonly EncryptedManualGrantSecret[]> {
  const encryptedSecrets: EncryptedManualGrantSecret[] = [];
  for (const field of args.secretValues) {
    encryptedSecrets.push({
      name: field.name,
      encryptedValue: await encryptStoredSecretValue(
        field.value,
        args.featureSwitchContext,
      ),
    });
    signal.throwIfAborted();
  }
  return encryptedSecrets;
}

export function builtinConnectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<BuiltinConnectorListResponse>> {
  const storedRows$ = computed(async (get) => {
    const db = get(db$);
    return await db
      .select({
        id: connectors.id,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
        authMethod: connectors.authMethod,
        automaticAuthType: connectors.automaticAuthType,
        displayName: connectors.displayName,
        isDefault: connectors.isDefault,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        oauthScopes: connectors.oauthScopes,
        oauthGrantedScopes: connectors.oauthGrantedScopes,
        needsReconnect: connectors.needsReconnect,
        reconnectReason: connectors.reconnectReason,
        storageVersion: connectors.storageVersion,
        tokenExpiresAt: connectors.tokenExpiresAt,
        createdAt: connectors.createdAt,
        updatedAt: connectors.updatedAt,
      })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          isNotNull(connectors.connectorSlug),
          eq(connectors.isDefault, true),
        ),
      );
  });
  const markerScope$ = computed(async (get) => {
    return {
      ...args,
      connectionIds: (await get(storedRows$)).map((row) => {
        return row.id;
      }),
    };
  });
  const markers$ = connectorAccountFieldMarkers(markerScope$);
  return computed(async (get): Promise<BuiltinConnectorListResponse> => {
    const storedRows = await get(storedRows$);
    const snapshot = await get(
      loadStoredBuiltinConnectorRuntimeSelection(
        storedRows.map((row) => {
          return row.connectorSlug;
        }),
      ),
    );
    const now = nowDate();
    const storedConnectors =
      snapshot === null
        ? []
        : storedRows.flatMap((row) => {
            const connector = storedBuiltinConnectorRowWithRuntimeMethod({
              connectorSlug: row.connectorSlug,
              now,
              row,
              snapshot,
            });
            return connector === null ? [] : [{ ...connector, storedRow: row }];
          });
    const markers =
      storedConnectors.length > 0
        ? await get(markers$)
        : new Map<string, ReadonlySet<string>>();
    return {
      connectors: storedConnectors.map((connector) => {
        return builtinConnectorAccountResponse(
          connector,
          connector.storedRow,
          snapshot,
          markers,
        );
      }),
    };
  });
}

function storedBuiltinConnectorColumns() {
  return {
    id: connectors.id,
    authMethod: connectors.authMethod,
    automaticAuthType: connectors.automaticAuthType,
    displayName: connectors.displayName,
    isDefault: connectors.isDefault,
    externalId: connectors.externalId,
    externalUsername: connectors.externalUsername,
    externalEmail: connectors.externalEmail,
    oauthScopes: connectors.oauthScopes,
    oauthGrantedScopes: connectors.oauthGrantedScopes,
    needsReconnect: connectors.needsReconnect,
    reconnectReason: connectors.reconnectReason,
    storageVersion: connectors.storageVersion,
    tokenExpiresAt: connectors.tokenExpiresAt,
    createdAt: connectors.createdAt,
    updatedAt: connectors.updatedAt,
  };
}

/** Completed-session reads use runtime values and must stop before authorization on abort. */
export const readBuiltinConnectorById$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: string;
      readonly connectorId: string;
      readonly snapshot: ConnectorRuntimeLookup;
    },
    signal: AbortSignal,
  ): Promise<BuiltinConnectorResponse | null> => {
    // Preserve row projection before the completed session's cancellation check.
    const connector = await (async () => {
      const [row] = await get(db$)
        .select(storedBuiltinConnectorColumns())
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, args.connectorSlug),
            eq(connectors.id, args.connectorId),
          ),
        )
        .limit(1);
      return row
        ? storedBuiltinConnectorRowWithRuntimeMethod({
            connectorSlug: args.connectorSlug,
            now: nowDate(),
            row,
            snapshot: args.snapshot,
          })
        : null;
    })();
    signal.throwIfAborted();
    return connector?.response ?? null;
  },
);

async function decryptConnectorRevokeInputs(args: {
  readonly encryptedInputs: Readonly<Record<string, string>>;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<Readonly<Record<string, string>>> {
  const inputs: Record<string, string> = {};
  for (const [name, encryptedValue] of Object.entries(args.encryptedInputs)) {
    inputs[name] = await decryptStoredSecretValue(
      encryptedValue,
      args.featureSwitchContext,
    );
  }
  return inputs;
}

async function revokePendingConnectorToken(
  args: {
    readonly pending: PendingBuiltinConnectorTokenRevoke;
  },
  signal: AbortSignal,
): Promise<void> {
  // Provider revocation is best-effort; local cleanup still owns visible state.
  await bestEffort(
    revokeConnectorAuthMethodAccessTokenWithMethod(
      {
        connectorSlug: args.pending.runtimeMethod.connectorSlug,
        authMethodId: args.pending.runtimeMethod.authMethodId,
        method: args.pending.runtimeMethod.method,
        readEnv: optionalEnv,
        loadInputs: () => {
          return decryptConnectorRevokeInputs({
            encryptedInputs: args.pending.encryptedInputs,
            featureSwitchContext: args.pending.featureSwitchContext,
          });
        },
      },
      signal,
    ),
  );
}
const reconcileAccountBoundAutomationWatches$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.connectorSlug === "gmail") {
      await bestEffort(
        set(reconcileGmailWatchesForUser$, { ...args }, signal),
        signal,
      );
    } else if (args.connectorSlug === "google-calendar") {
      await bestEffort(
        set(reconcileGoogleCalendarWatchesForUser$, { ...args }, signal),
        signal,
      );
    } else if (args.connectorSlug === "google-forms") {
      await bestEffort(
        set(reconcileGoogleFormsWatchesForUser$, { ...args }, signal),
        signal,
      );
    } else if (args.connectorSlug === "google-meet") {
      await bestEffort(
        set(reconcileGoogleMeetSubscriptionsForUser$, { ...args }, signal),
        signal,
      );
    }
  },
);
async function prepareBuiltinConnectorAccountDeletion(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly connectionId: string;
  },
  signal: AbortSignal,
) {
  return await prepareConnectorAccountDeletionWithTargetLocked(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug: args.connectorSlug },
      connectionId: args.connectionId,
    },
    signal,
  );
}

type DeleteBuiltinConnectorLocalStateResult =
  | "missing"
  | {
      readonly kind: "deleted";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    };

interface DeleteBuiltinConnectorLocalStateArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly sourceId: string;
}

interface PendingConnectorAutomationCleanup {
  readonly pendingGoogleCalendarWatchStop: PendingGoogleCalendarWatchStop | null;
  readonly pendingGoogleMeetSubscriptionDelete: PendingGoogleMeetSubscriptionDelete | null;
}

/**
 * Meet subscription deletion is prepared outside the account deletion
 * transaction, like Calendar and Forms; remote cleanup is best effort.
 */
const prepareDeletedConnectorMeetCleanup$ = command(
  async (
    { set },
    args: DeleteBuiltinConnectorLocalStateArgs,
    signal: AbortSignal,
  ): Promise<PendingGoogleMeetSubscriptionDelete | null> => {
    return args.connectorSlug === "google-meet"
      ? await set(
          prepareGoogleMeetSubscriptionDeleteForConnector$,
          {
            orgId: args.orgId,
            userId: args.userId,
            connectorId: args.sourceId,
          },
          signal,
        )
      : null;
  },
);

async function deleteBuiltinConnectorAccountLocalState(
  tx: Tx,
  args: DeleteBuiltinConnectorLocalStateArgs & {
    readonly account: { readonly connectionId: string };
    readonly deletion: Extract<
      Awaited<ReturnType<typeof prepareBuiltinConnectorAccountDeletion>>,
      { kind: "ready" }
    >;
  },
  snapshot: ConnectorRuntimeSelection | null,
  featureSwitchContext: FeatureSwitchContext | null,
  signal: AbortSignal,
) {
  const { account, deletion } = args;
  const [existing] = await tx
    .select({
      id: connectors.id,
      authMethod: connectors.authMethod,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(eq(connectors.id, account.connectionId))
    .limit(1);
  signal.throwIfAborted();
  if (!existing) {
    throw new Error("Claimed connector account disappeared before deletion");
  }

  let pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null = null;
  if (snapshot !== null && featureSwitchContext !== null) {
    const accessResult = resolveBuiltinConnectorCredentialAccess({
      snapshot,
      stored: {
        authMethodId: existing.authMethod,
        connectorId: existing.id,
        connectorSlug: args.connectorSlug,
        orgId: args.orgId,
        storageVersion: existing.storageVersion,
        userId: args.userId,
      },
    });
    if (
      accessResult.kind === "ok" &&
      accessResult.access.runtimeMethod.method.revoke.kind === "token-revoke"
    ) {
      const revokeArgs = {
        access: accessResult.access,
        featureSwitchContext,
      };
      const revokeSignal = signal;
      pendingTokenRevoke =
        await (async (): Promise<PendingBuiltinConnectorTokenRevoke | null> => {
          const read = builtinConnectorTokenRevokeReadPlan(revokeArgs.access);
          if (read.kind === "none") {
            return null;
          }
          if (read.kind === "empty") {
            return {
              runtimeMethod: revokeArgs.access.runtimeMethod,
              encryptedInputs: {},
              featureSwitchContext: revokeArgs.featureSwitchContext,
            };
          }
          const secretRows = await tx
            .select(read.columns)
            .from(read.from)
            .where(read.where);
          revokeSignal.throwIfAborted();
          const encryptedInputs = builtinConnectorTokenRevokeInputsFromRows(
            read.inputEntries,
            secretRows,
          );
          if (encryptedInputs === null) {
            return null;
          }
          return {
            runtimeMethod: revokeArgs.access.runtimeMethod,
            encryptedInputs,
            featureSwitchContext: revokeArgs.featureSwitchContext,
          };
        })();
    }
  }
  signal.throwIfAborted();

  const lateSelectionCount = await deleteConnectorCredentialStorageConnection(
    tx,
    { connectorId: existing.id },
    signal,
  );
  return {
    kind: "deleted" as const,
    pendingTokenRevoke,
    deletion: {
      ...deletion,
      resolvedSelectionCount:
        deletion.resolvedSelectionCount + lateSelectionCount,
    },
  };
}

const stopDeletedWatches$ = command(
  async (
    { set },
    pending: PendingConnectorAutomationCleanup,
    signal: AbortSignal,
  ): Promise<unknown> => {
    let capturedAbort: unknown = null;
    capturedAbort ??= await stopPendingGoogleCalendarAutomationCleanup(
      pending.pendingGoogleCalendarWatchStop,
      signal,
    );
    if (pending.pendingGoogleMeetSubscriptionDelete !== null) {
      const deleted = await settleIncludingAbort(
        bestEffort(
          set(
            deletePreparedGoogleMeetSubscriptionIfUnadopted$,
            {
              pending: pending.pendingGoogleMeetSubscriptionDelete,
            },
            signal,
          ),
          signal,
        ),
      );
      if (signal.aborted) {
        capturedAbort ??= signal.reason;
      }
      if (!deleted.ok) {
        capturedAbort ??= deleted.error;
      }
    }
    return capturedAbort;
  },
);

async function stopPendingGoogleCalendarAutomationCleanup(
  pending: PendingGoogleCalendarWatchStop | null,
  signal: AbortSignal,
): Promise<unknown> {
  if (pending === null) {
    return null;
  }
  const stopped = await settleIncludingAbort(
    bestEffort(stopPreparedGoogleCalendarWatches(pending), signal),
  );
  if (signal.aborted) {
    return signal.reason;
  }
  return stopped.ok ? null : stopped.error;
}
async function stopPendingGoogleFormsAutomationCleanup(
  pending: PendingGoogleFormsWatchStop | null,
  signal: AbortSignal,
): Promise<unknown> {
  if (pending === null) {
    return null;
  }
  const stopped = await settleIncludingAbort(
    bestEffort(stopPreparedGoogleFormsWatches(pending, signal), signal),
  );
  if (signal.aborted) {
    return signal.reason;
  }
  return stopped.ok ? null : stopped.error;
}
const prepareDeletedConnectorCalendarCleanup$ = command(
  async (
    { set },
    args: DeleteBuiltinConnectorLocalStateArgs,
    signal: AbortSignal,
  ): Promise<PendingGoogleCalendarWatchStop | null> => {
    return args.connectorSlug === "google-calendar"
      ? await set(
          prepareGoogleCalendarWatchStopForConnector$,
          {
            orgId: args.orgId,
            userId: args.userId,
            connectorId: args.sourceId,
          },
          signal,
        )
      : null;
  },
);

const prepareDeletedConnectorWatches$ = command(
  async (
    { set },
    args: DeleteBuiltinConnectorLocalStateArgs,
    signal: AbortSignal,
  ): Promise<PendingConnectorAutomationCleanup> => {
    const pendingGoogleCalendarWatchStop = await set(
      prepareDeletedConnectorCalendarCleanup$,
      args,
      signal,
    );
    const pendingGoogleMeetSubscriptionDelete = await set(
      prepareDeletedConnectorMeetCleanup$,
      args,
      signal,
    );
    return {
      pendingGoogleCalendarWatchStop,
      pendingGoogleMeetSubscriptionDelete,
    };
  },
);

const prepareBuiltinConnectorLocalDeletion$ = command(
  async (
    { get, set },
    args: DeleteBuiltinConnectorLocalStateArgs,
    signal: AbortSignal,
  ) => {
    const snapshot = await set(readStoredBuiltinConnectorRuntimeSnapshot$, [
      args.connectorSlug,
    ]);
    signal.throwIfAborted();
    const featureSwitchOverrides =
      snapshot === null
        ? null
        : await get(userFeatureSwitchOverrides(args.orgId, args.userId));
    signal.throwIfAborted();
    const featureSwitchContext =
      featureSwitchOverrides === null
        ? null
        : ({
            orgId: args.orgId,
            userId: args.userId,
            overrides: featureSwitchOverrides,
          } satisfies FeatureSwitchContext);
    const automationCleanup = await set(
      prepareDeletedConnectorWatches$,
      args,
      signal,
    );
    const formsCleanup =
      args.connectorSlug === "google-forms"
        ? await set(
            prepareGoogleFormsWatchStopForConnector$,
            {
              orgId: args.orgId,
              userId: args.userId,
              connectorId: args.sourceId,
            },
            signal,
          )
        : null;
    return { snapshot, featureSwitchContext, automationCleanup, formsCleanup };
  },
);

const finalizeBuiltinConnectorLocalDeletion$ = command(
  async (
    { set },
    input: {
      readonly args: DeleteBuiltinConnectorLocalStateArgs;
      readonly deleteResult: Awaited<
        ReturnType<typeof deleteBuiltinConnectorAccountLocalState>
      >;
      readonly automationCleanup: PendingConnectorAutomationCleanup;
      readonly formsCleanup: Parameters<
        typeof stopPendingGoogleFormsAutomationCleanup
      >[0];
      readonly postCommitAbort: unknown;
    },
    signal: AbortSignal,
  ): Promise<DeleteBuiltinConnectorLocalStateResult> => {
    const { args, deleteResult, automationCleanup, formsCleanup } = input;
    let postCommitAbort = input.postCommitAbort;
    const cleanupAbort = await set(
      stopDeletedWatches$,
      automationCleanup,
      signal,
    );
    postCommitAbort ??= cleanupAbort;
    postCommitAbort ??= await stopPendingGoogleFormsAutomationCleanup(
      formsCleanup,
      signal,
    );
    await finalizeConnectorStateChangeAfterCommit(
      {
        userId: args.userId,
        connectorSlug: args.connectorSlug,
        pendingTokenRevoke: deleteResult.pendingTokenRevoke,
        postCommitAbort,
      },
      signal,
    );
    if (args.connectorSlug === "gmail") {
      await bestEffort(
        set(
          reconcileGmailWatchesForUser$,
          { orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.connectorSlug === "google-calendar") {
      await bestEffort(
        set(
          reconcileGoogleCalendarWatchesForUser$,
          { orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.connectorSlug === "google-forms") {
      await bestEffort(
        set(
          reconcileGoogleFormsWatchesForUser$,
          { orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.connectorSlug === "google-meet") {
      await bestEffort(
        set(
          reconcileGoogleMeetSubscriptionsForUser$,
          { orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    signal.throwIfAborted();
    return {
      kind: "deleted",
      resolvedSelectionCount: deleteResult.deletion.resolvedSelectionCount,
      promotedDefaultConnectionId:
        deleteResult.deletion.promotedDefaultConnectionId,
    };
  },
);

export const deleteBuiltinConnectorLocalState$ = command(
  async (
    { set },
    args: DeleteBuiltinConnectorLocalStateArgs,
    signal: AbortSignal,
  ): Promise<DeleteBuiltinConnectorLocalStateResult> => {
    const writeDb = set(writeDb$);
    const { snapshot, featureSwitchContext, automationCleanup, formsCleanup } =
      await set(prepareBuiltinConnectorLocalDeletion$, args, signal);
    let postCommitAbort: unknown = null;
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0116; new non-billing transactions are prohibited.
    const deleteResult = await writeDb.transaction(async (tx) => {
      // Plain resolution read: prepareBuiltinConnectorAccountDeletion's
      // exact-identity write claims the row (missing if a concurrent delete won)
      // and holds it until commit, so the details read afterwards are current.
      const account = await (async (): Promise<BuiltinDeletionAccount> => {
        const read = builtinDeletionReadPlan(args);
        const rows = await Promise.all([
          read.exactWhere
            ? tx.select(read.columns).from(connectors).where(read.exactWhere)
            : [],
          read.defaultWhere
            ? tx.select(read.columns).from(connectors).where(read.defaultWhere)
            : [],
        ]);
        const resolution = builtinDeletionFromRows(read, rows);
        signal.throwIfAborted();
        return builtinDeletionResult(resolution);
      })();
      if (account.kind !== "resolved") {
        return {
          kind: account.kind,
          pendingTokenRevoke: null,
        };
      }
      const deletion = await prepareBuiltinConnectorAccountDeletion(
        tx,
        {
          ...args,
          connectionId: account.connectionId,
        },
        signal,
      );
      if (deletion.kind !== "ready") {
        signal.throwIfAborted();
        return {
          kind: deletion.kind,
          pendingTokenRevoke: null,
        };
      }
      signal.throwIfAborted();
      return await deleteBuiltinConnectorAccountLocalState(
        tx,
        { ...args, account, deletion },
        snapshot,
        featureSwitchContext,
        signal,
      );
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }
    if (deleteResult.kind !== "deleted") {
      throwCapturedAbort(postCommitAbort);
      return deleteResult.kind;
    }
    return await set(
      finalizeBuiltinConnectorLocalDeletion$,
      { args, deleteResult, automationCleanup, formsCleanup, postCommitAbort },
      signal,
    );
  },
);

async function loadPendingConnectorTokenRevokeForLocalConnect(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly snapshot: ConnectorRuntimeSelection;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly existing: Pick<
      StoredConnectorRow,
      "id" | "authMethod" | "storageVersion"
    > | null;
  },
  signal: AbortSignal,
): Promise<PendingBuiltinConnectorTokenRevoke | null> {
  if (!args.existing) {
    return null;
  }

  let pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null = null;
  const accessResult = resolveBuiltinConnectorCredentialAccess({
    snapshot: args.snapshot,
    stored: {
      authMethodId: args.existing.authMethod,
      connectorId: args.existing.id,
      connectorSlug: args.connectorSlug,
      orgId: args.orgId,
      storageVersion: args.existing.storageVersion,
      userId: args.userId,
    },
  });
  if (
    accessResult.kind === "ok" &&
    accessResult.access.runtimeMethod.method.revoke.kind === "token-revoke"
  ) {
    const revokeArgs = {
      access: accessResult.access,
      featureSwitchContext: args.featureSwitchContext,
    };
    const revokeSignal = signal;
    pendingTokenRevoke =
      await (async (): Promise<PendingBuiltinConnectorTokenRevoke | null> => {
        const read = builtinConnectorTokenRevokeReadPlan(revokeArgs.access);
        if (read.kind === "none") {
          return null;
        }
        if (read.kind === "empty") {
          return {
            runtimeMethod: revokeArgs.access.runtimeMethod,
            encryptedInputs: {},
            featureSwitchContext: revokeArgs.featureSwitchContext,
          };
        }
        const secretRows = await db
          .select(read.columns)
          .from(read.from)
          .where(read.where);
        revokeSignal.throwIfAborted();
        const encryptedInputs = builtinConnectorTokenRevokeInputsFromRows(
          read.inputEntries,
          secretRows,
        );
        if (encryptedInputs === null) {
          return null;
        }
        return {
          runtimeMethod: revokeArgs.access.runtimeMethod,
          encryptedInputs,
          featureSwitchContext: revokeArgs.featureSwitchContext,
        };
      })();
  }

  return pendingTokenRevoke;
}

async function writeManualGrantCredentials(
  db: Db,
  args: {
    readonly connectorId: string;
    readonly encryptedSecrets: readonly EncryptedManualGrantSecret[];
    readonly method: ConnectorRuntimeMethod["method"];
    readonly orgId: string;
    readonly userId: string;
    readonly variableValues: readonly PreparedManualGrantField[];
  },
  signal: AbortSignal,
): Promise<void> {
  for (const field of args.encryptedSecrets) {
    const credential = {
      connectorId: args.connectorId,
      storage: args.method.storage,
      orgId: args.orgId,
      userId: args.userId,
      name: field.name,
      encryptedValue: field.encryptedValue,
      description: null,
      updatedDescription: null,
    };
    const write = connectorOwnedSecretWrite(credential);
    const [row] = await db
      .insert(secrets)
      .values(write.values)
      .onConflictDoUpdate(write.conflict)
      .returning({ id: secrets.id });
    if (!row) {
      throw new Error(
        `Connector secret ${credential.name} is owned by another row`,
      );
    }
    signal.throwIfAborted();
  }

  for (const field of args.variableValues) {
    const credential = {
      connectorId: args.connectorId,
      storage: args.method.storage,
      orgId: args.orgId,
      userId: args.userId,
      name: field.name,
      value: field.value,
      description: null,
      updatedDescription: null,
    };
    const write = connectorOwnedVariableWrite(credential);
    const [row] = await db
      .insert(variables)
      .values(write.values)
      .onConflictDoUpdate(write.conflict)
      .returning({ id: variables.id });
    if (!row) {
      throw new Error(
        `Connector variable ${credential.name} is owned by another row`,
      );
    }
    signal.throwIfAborted();
  }
}

interface CommitManualGrantConnectorArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly snapshot: ConnectorRuntimeSelection;
  readonly account: ConnectorAccountMutationIntent;
  readonly prepared: PreparedManualGrantConnect;
  readonly encryptedSecrets: readonly EncryptedManualGrantSecret[];
  readonly featureSwitchContext: FeatureSwitchContext;
}

async function commitManualGrantConnector(
  db: Tx,
  args: CommitManualGrantConnectorArgs,
  signal: AbortSignal,
): Promise<
  | {
      readonly status: "connected";
      readonly connectorRow: StoredConnectorRow;
      readonly pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null;
    }
  | ConnectorConnectionMutationFailure
> {
  const resolution = await resolveConnectorConnectionMutation(db, {
    orgId: args.orgId,
    userId: args.userId,
    target: {
      kind: "builtin",
      connectorSlug: args.runtimeMethod.connectorSlug,
    },
    mutation: args.account,
    allowSiblings: true,
  });
  signal.throwIfAborted();
  if (resolution.kind !== "ready") {
    return connectorConnectionMutationFailure(resolution);
  }

  const pendingTokenRevoke =
    await loadPendingConnectorTokenRevokeForLocalConnect(
      db,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        snapshot: args.snapshot,
        featureSwitchContext: args.featureSwitchContext,
        existing:
          resolution.mutation.kind === "update"
            ? resolution.mutation.existing
            : null,
      },
      signal,
    );
  const written = await replaceConnectorConnectionOutcome(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      authMethod: args.runtimeMethod.authMethodId,
      storageVersion: args.runtimeMethod.method.storage.version,
      tokenExpiresAt: null,
      target: {
        kind: "builtin",
        connectorSlug: args.runtimeMethod.connectorSlug,
        identity: { kind: "local" },
      },
      resolution: resolution.mutation,
      writeCredentials: async (
        { db: credentialDb, connectorId },
        writeSignal,
      ) => {
        await writeManualGrantCredentials(
          credentialDb,
          {
            connectorId,
            encryptedSecrets: args.encryptedSecrets,
            method: args.runtimeMethod.method,
            orgId: args.orgId,
            userId: args.userId,
            variableValues: args.prepared.variableValues,
          },
          writeSignal,
        );
      },
    },
    signal,
  );
  if (written.kind !== "written") {
    return connectorConnectionMutationFailure(written);
  }
  const connectorRow = written.row;
  const secretCleanup = {
    orgId: args.orgId,
    userId: args.userId,
    names: args.prepared.configuredSecretNames,
  };
  const secretCleanupSignal = signal;
  await (async (): Promise<void> => {
    for (const name of secretCleanup.names) {
      const deletion = manualGrantUserSecretDeletion({
        orgId: secretCleanup.orgId,
        userId: secretCleanup.userId,
        name,
      });
      await db.delete(deletion.from).where(deletion.where);
      secretCleanupSignal.throwIfAborted();
    }
  })();
  const variableCleanup = {
    orgId: args.orgId,
    userId: args.userId,
    names: args.prepared.configuredVariableNames,
  };
  const variableCleanupSignal = signal;
  await (async (): Promise<void> => {
    for (const name of variableCleanup.names) {
      const deletion = manualGrantUserVariableDeletion({
        orgId: variableCleanup.orgId,
        userId: variableCleanup.userId,
        name,
      });
      await db.delete(deletion.from).where(deletion.where);
      variableCleanupSignal.throwIfAborted();
    }
  })();
  return { status: "connected", connectorRow, pendingTokenRevoke };
}

export const connectManualGrantBuiltinConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSelection;
      readonly values: Readonly<Record<string, string>>;
      readonly account: ConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<ConnectManualGrantConnectorResult> => {
    const preparedResult = prepareManualGrantConnect(
      args.runtimeMethod,
      args.values,
    );
    if (!preparedResult.ok) {
      return { status: "invalid", message: preparedResult.message };
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const encryptedSecrets = await encryptManualGrantSecrets(
      {
        secretValues: preparedResult.prepared.secretValues,
        featureSwitchContext,
      },
      signal,
    );
    signal.throwIfAborted();
    let postCommitAbort: unknown = null;
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0117; new non-billing transactions are prohibited.
    const committed = await set(writeDb$).transaction(async (tx) => {
      return await commitManualGrantConnector(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          runtimeMethod: args.runtimeMethod,
          snapshot: args.snapshot,
          account: args.account,
          prepared: preparedResult.prepared,
          encryptedSecrets,
          featureSwitchContext,
        },
        signal,
      );
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (committed.status !== "connected") {
      return committed;
    }

    await finalizeConnectorStateChangeAfterCommit(
      {
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        pendingTokenRevoke: committed.pendingTokenRevoke,
        postCommitAbort,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: storedBuiltinConnectorRowToResponse(
        committed.connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
    };
  },
);

export const connectNoAuthBuiltinConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSelection;
      readonly account: ConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<ConnectNoAuthConnectorResult> => {
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    let pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null = null;
    let connectorRow: StoredConnectorRow | null = null;
    let mutationFailure: ConnectorConnectionMutationFailure | null = null;
    let postCommitAbort: unknown = null;

    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0118; new non-billing transactions are prohibited.
    await writeDb.transaction(async (tx) => {
      const resolution = await resolveConnectorConnectionMutation(tx, {
        orgId: args.orgId,
        userId: args.userId,
        target: {
          kind: "builtin",
          connectorSlug: args.runtimeMethod.connectorSlug,
        },
        mutation: args.account,
        allowSiblings: true,
      });
      signal.throwIfAborted();
      if (resolution.kind !== "ready") {
        mutationFailure = connectorConnectionMutationFailure(resolution);
        return;
      }

      pendingTokenRevoke = await loadPendingConnectorTokenRevokeForLocalConnect(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectorSlug: args.runtimeMethod.connectorSlug,
          snapshot: args.snapshot,
          featureSwitchContext,
          existing:
            resolution.mutation.kind === "update"
              ? resolution.mutation.existing
              : null,
        },
        signal,
      );

      const written = await replaceConnectorConnectionOutcome(
        tx,
        {
          orgId: args.orgId,
          userId: args.userId,
          authMethod: args.runtimeMethod.authMethodId,
          storageVersion: args.runtimeMethod.method.storage.version,
          tokenExpiresAt: null,
          target: {
            kind: "builtin",
            connectorSlug: args.runtimeMethod.connectorSlug,
            identity: { kind: "local" },
          },
          resolution: resolution.mutation,
          writeCredentials: () => {
            return Promise.resolve();
          },
        },
        signal,
      );
      if (written.kind !== "written") {
        mutationFailure = connectorConnectionMutationFailure(written);
        return;
      }
      connectorRow = written.row;
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }

    if (mutationFailure) {
      return mutationFailure;
    }

    if (!connectorRow) {
      throw new Error("Expected no-auth connector write to return a row");
    }

    await finalizeConnectorStateChangeAfterCommit(
      {
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        pendingTokenRevoke,
        postCommitAbort,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: storedBuiltinConnectorRowToResponse(
        connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
    };
  },
);

async function encryptedConnectorTokenSecret(args: {
  readonly name: string;
  readonly value: string;
  readonly description: string;
  readonly featureSwitchContext: FeatureSwitchContext;
}): Promise<EncryptedBuiltinConnectorTokenSecret> {
  return {
    name: args.name,
    encryptedValue: await encryptStoredSecretValue(
      args.value,
      args.featureSwitchContext,
    ),
    description: args.description,
  };
}

function connectorTokenExpiresAt(args: {
  readonly isRefreshable: boolean;
  readonly expiresIn: number | undefined;
}): Date | null {
  const fallbackSecs = args.isRefreshable
    ? DEFAULT_ACCESS_TOKEN_EXPIRES_IN_SECS
    : null;
  const expiresInSecs = args.expiresIn ?? fallbackSecs;
  return expiresInSecs === null
    ? null
    : new Date(nowDate().getTime() + expiresInSecs * 1000);
}

function connectorTokenOutputMetadataForAuthMethod(args: {
  readonly runtimeMethod: ConnectorRuntimeMethod;
}): BuiltinConnectorTokenOutputMetadata | undefined {
  const method = args.runtimeMethod.method;
  const grantMetadata = connectorAuthMethodGrantMetadata(method);

  switch (method.grant.kind) {
    case "auth-code":
    case "openid-auth":
    case "external-code":
    case "device-auth": {
      const outputTargets = Object.fromEntries(
        Object.entries(grantMetadata.outputs).map(([outputName, output]) => {
          return [outputName, output.target];
        }),
      );
      const outputRequirements = requiredConnectorTokenOutputRequirements({
        method,
        outputTargets,
      });
      return {
        outputTargets,
        requiredOutputNames: outputRequirements.requiredOutputNames,
        requiredExtraSecretNames: outputRequirements.requiredExtraSecretNames,
        isRefreshable: method.access.kind === "refresh-token",
      };
    }

    case "manual":
    case "managed":
    case "none": {
      return undefined;
    }
    case "automatic": {
      return undefined;
    }
  }
}

function requiredConnectorTokenOutputRequirements(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
}): BuiltinConnectorTokenOutputRequirements {
  const runtimeMetadata = connectorAuthMethodRuntimeMetadata(args.method);

  const outputNameByTargetKey = new Map(
    Object.entries(args.outputTargets).map(([outputName, target]) => {
      return [connectorOutputTargetKey(target), outputName];
    }),
  );
  const requiredOutputNames = new Set<string>();
  const requiredExtraSecretNames = new Set<string>();
  for (const binding of runtimeMetadata.runtimeBindings) {
    if (binding.optional) {
      continue;
    }
    switch (binding.source.kind) {
      case "connector-secret": {
        const outputName = outputNameByTargetKey.get(
          connectorOutputTargetKey(binding.source),
        );
        if (outputName) {
          requiredOutputNames.add(outputName);
        } else {
          requiredExtraSecretNames.add(binding.source.name);
        }
        break;
      }
      case "connector-variable": {
        const outputName = outputNameByTargetKey.get(
          connectorOutputTargetKey(binding.source),
        );
        if (outputName) {
          requiredOutputNames.add(outputName);
        }
        break;
      }
      case "platform-secret": {
        break;
      }
    }
  }
  return {
    requiredOutputNames: [...requiredOutputNames],
    requiredExtraSecretNames: [...requiredExtraSecretNames],
  };
}

function connectorOutputTargetKey(target: ConnectorOutputTarget): string {
  return `${target.kind}:${target.name}`;
}
function validateConnectorTokenOutputRequirements(args: {
  readonly connectorSlug: string;
  readonly outputs: BuiltinConnectorTokenOutputValues;
  readonly requiredOutputNames: readonly string[];
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly requiredExtraSecretNames: readonly string[];
}): void {
  const missingOutputNames = args.requiredOutputNames.filter((outputName) => {
    return !args.outputs[outputName];
  });
  if (missingOutputNames.length > 0) {
    throw new Error(
      `${args.connectorSlug} connector provider did not return required token output(s): ${formatManualGrantFieldList(missingOutputNames)}`,
    );
  }
  const extraSecretValues = new Map(args.extraSecrets);
  const missingExtraSecretNames = args.requiredExtraSecretNames.filter(
    (secretName) => {
      return !extraSecretValues.get(secretName);
    },
  );
  if (missingExtraSecretNames.length > 0) {
    throw new Error(
      `${args.connectorSlug} connector provider did not return required connector secret(s): ${formatManualGrantFieldList(missingExtraSecretNames)}`,
    );
  }
}

function allowedConnectorTokenSecretNames(
  method: ConnectorAuthMethodRuntimeConfig,
): Set<string> {
  return new Set(connectorAuthMethodOwnedSecretNames(method));
}

function isPrimaryConnectorTokenSecret(args: {
  readonly name: string;
  readonly primaryOutputSecretNames: ReadonlySet<string>;
}): boolean {
  return args.primaryOutputSecretNames.has(args.name);
}
function validateExtraConnectorTokenSecrets(args: {
  readonly connectorSlug: string;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly extraConnectorSecrets: Readonly<Record<string, string>> | undefined;
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
}): readonly (readonly [string, string])[] {
  const extraSecrets = Object.entries(args.extraConnectorSecrets ?? {});
  if (extraSecrets.length === 0) {
    return [];
  }
  const allowedSecretNames = allowedConnectorTokenSecretNames(args.method);
  const primaryOutputSecretNames = connectorOutputSecretNames(
    args.outputTargets,
  );
  for (const [name] of extraSecrets) {
    if (
      isPrimaryConnectorTokenSecret({
        name,
        primaryOutputSecretNames,
      })
    ) {
      throw new Error(
        `${args.connectorSlug} connector provider returned mapped token output ${name} in extra connector secrets`,
      );
    }
    if (!allowedSecretNames.has(name)) {
      throw new Error(
        `${args.connectorSlug} connector provider returned unsupported connector secret ${name}`,
      );
    }
  }
  return extraSecrets;
}

function connectorOutputSecretNames(
  outputTargets: Readonly<Record<string, ConnectorOutputTarget>>,
): Set<string> {
  const secretNames = new Set<string>();
  for (const target of Object.values(outputTargets)) {
    if (target.kind === "connector-secret") {
      secretNames.add(target.name);
    }
  }
  return secretNames;
}

async function encryptExtraConnectorTokenSecrets(
  args: {
    readonly connectorSlug: string;
    readonly extraSecrets: readonly (readonly [string, string])[];
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<readonly EncryptedBuiltinConnectorTokenSecret[]> {
  const encryptedSecrets: EncryptedBuiltinConnectorTokenSecret[] = [];
  for (const [name, value] of args.extraSecrets) {
    encryptedSecrets.push(
      await encryptedConnectorTokenSecret({
        name,
        value,
        description: `Connector token secret for ${args.connectorSlug}: ${name}`,
        featureSwitchContext: args.featureSwitchContext,
      }),
    );
    signal.throwIfAborted();
  }
  return encryptedSecrets;
}
async function prepareConnectorTokenState(
  args: {
    readonly connectorSlug: string;
    readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
    readonly requiredOutputNames: readonly string[];
    readonly requiredExtraSecretNames: readonly string[];
    readonly outputs: BuiltinConnectorTokenOutputValues;
    readonly extraSecrets: readonly (readonly [string, string])[];
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<PreparedBuiltinConnectorTokenState> {
  validateConnectorTokenOutputRequirements({
    connectorSlug: args.connectorSlug,
    outputs: args.outputs,
    requiredOutputNames: args.requiredOutputNames,
    extraSecrets: args.extraSecrets,
    requiredExtraSecretNames: args.requiredExtraSecretNames,
  });
  const encryptedConnectorTokenSecrets: EncryptedBuiltinConnectorTokenSecret[] =
    [];
  const connectorTokenVariables: PreparedBuiltinConnectorTokenVariable[] = [];
  for (const [outputName, value] of Object.entries(args.outputs)) {
    if (!value) {
      continue;
    }
    const target = args.outputTargets[outputName];
    if (!target) {
      throw new Error(
        `${args.connectorSlug} connector provider returned undeclared token output ${outputName}`,
      );
    }
    if (target.kind === "connector-secret") {
      encryptedConnectorTokenSecrets.push(
        await encryptedConnectorTokenSecret({
          name: target.name,
          value,
          description: `Connector token output for ${args.connectorSlug}: ${target.name}`,
          featureSwitchContext: args.featureSwitchContext,
        }),
      );
    } else {
      connectorTokenVariables.push({ name: target.name, value });
    }
    signal.throwIfAborted();
  }
  encryptedConnectorTokenSecrets.push(
    ...(await encryptExtraConnectorTokenSecrets(
      {
        connectorSlug: args.connectorSlug,
        extraSecrets: args.extraSecrets,
        featureSwitchContext: args.featureSwitchContext,
      },
      signal,
    )),
  );
  return {
    secrets: encryptedConnectorTokenSecrets,
    variables: connectorTokenVariables,
  };
}

async function upsertPreparedConnectorTokenState(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly orgId: string;
    readonly userId: string;
    readonly state: PreparedBuiltinConnectorTokenState;
  },
  signal: AbortSignal,
): Promise<void> {
  const tokenSecretsWriteArgs: {
    readonly db: Db;
    readonly connectorId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly orgId: string;
    readonly userId: string;
    readonly secrets: readonly EncryptedBuiltinConnectorTokenSecret[];
  } = {
    db: args.db,
    connectorId: args.connectorId,
    method: args.method,
    orgId: args.orgId,
    userId: args.userId,
    secrets: args.state.secrets,
  };
  const tokenSecretsWriteSignal = signal;
  await (async (): Promise<void> => {
    if (tokenSecretsWriteArgs.secrets.length === 0) {
      return;
    }

    for (const secret of tokenSecretsWriteArgs.secrets) {
      const db = tokenSecretsWriteArgs.db;
      const credential = {
        connectorId: tokenSecretsWriteArgs.connectorId,
        storage: tokenSecretsWriteArgs.method.storage,
        orgId: tokenSecretsWriteArgs.orgId,
        userId: tokenSecretsWriteArgs.userId,
        name: secret.name,
        encryptedValue: secret.encryptedValue,
        description: secret.description,
        updatedDescription: secret.description,
      };
      const write = connectorOwnedSecretWrite(credential);
      const [row] = await db
        .insert(secrets)
        .values(write.values)
        .onConflictDoUpdate(write.conflict)
        .returning({ id: secrets.id });
      if (!row) {
        throw new Error(
          `Connector secret ${credential.name} is owned by another row`,
        );
      }
      tokenSecretsWriteSignal.throwIfAborted();
    }
  })();
  const tokenVariablesWriteArgs: {
    readonly db: Db;
    readonly connectorId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly orgId: string;
    readonly userId: string;
    readonly variables: readonly PreparedBuiltinConnectorTokenVariable[];
  } = {
    db: args.db,
    connectorId: args.connectorId,
    method: args.method,
    orgId: args.orgId,
    userId: args.userId,
    variables: args.state.variables,
  };
  const tokenVariablesWriteSignal = signal;
  await (async (): Promise<void> => {
    for (const variable of tokenVariablesWriteArgs.variables) {
      const db = tokenVariablesWriteArgs.db;
      const credential = {
        connectorId: tokenVariablesWriteArgs.connectorId,
        storage: tokenVariablesWriteArgs.method.storage,
        orgId: tokenVariablesWriteArgs.orgId,
        userId: tokenVariablesWriteArgs.userId,
        name: variable.name,
        value: variable.value,
        description: null,
        updatedDescription: null,
      };
      const write = connectorOwnedVariableWrite(credential);
      const [row] = await db
        .insert(variables)
        .values(write.values)
        .onConflictDoUpdate(write.conflict)
        .returning({ id: variables.id });
      if (!row) {
        throw new Error(
          `Connector variable ${credential.name} is owned by another row`,
        );
      }
      tokenVariablesWriteSignal.throwIfAborted();
    }
  })();
}

function isExplicitReconnectIdentityMismatch(args: {
  readonly account: ConnectorAccountMutationIntent;
  readonly existing: StoredConnectorRow | null;
  readonly nextExternalId: string;
}): boolean {
  return (
    args.account.intent === "reconnect" &&
    args.existing?.externalId !== null &&
    args.existing?.externalId !== undefined &&
    args.existing.externalId !== args.nextExternalId
  );
}

async function loadPendingConnectorTokenRevokeForTokenConnect(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly snapshot: ConnectorRuntimeSelection;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly existing: StoredConnectorRow | null;
  },
  signal: AbortSignal,
): Promise<PendingBuiltinConnectorTokenRevoke | null> {
  if (!args.existing) {
    return null;
  }
  const accessResult = resolveBuiltinConnectorCredentialAccess({
    snapshot: args.snapshot,
    stored: {
      authMethodId: args.existing.authMethod,
      connectorId: args.existing.id,
      connectorSlug: args.connectorSlug,
      orgId: args.orgId,
      storageVersion: args.existing.storageVersion,
      userId: args.userId,
    },
  });
  if (
    accessResult.kind !== "ok" ||
    accessResult.access.runtimeMethod.method.revoke.kind !== "token-revoke" ||
    accessResult.access.runtimeMethod.method.revoke.revokePreviousOnReplace !==
      true
  ) {
    return null;
  }
  const revokeArgs = {
    access: accessResult.access,
    featureSwitchContext: args.featureSwitchContext,
  };
  const revokeSignal = signal;
  return await (async (): Promise<PendingBuiltinConnectorTokenRevoke | null> => {
    const read = builtinConnectorTokenRevokeReadPlan(revokeArgs.access);
    if (read.kind === "none") {
      return null;
    }
    if (read.kind === "empty") {
      return {
        runtimeMethod: revokeArgs.access.runtimeMethod,
        encryptedInputs: {},
        featureSwitchContext: revokeArgs.featureSwitchContext,
      };
    }
    const secretRows = await db
      .select(read.columns)
      .from(read.from)
      .where(read.where);
    revokeSignal.throwIfAborted();
    const encryptedInputs = builtinConnectorTokenRevokeInputsFromRows(
      read.inputEntries,
      secretRows,
    );
    if (encryptedInputs === null) {
      return null;
    }
    return {
      runtimeMethod: revokeArgs.access.runtimeMethod,
      encryptedInputs,
      featureSwitchContext: revokeArgs.featureSwitchContext,
    };
  })();
}

function authorizedExternalIdForMutation(args: {
  readonly mutation: ConnectorAccountMutationIntent;
  readonly matchExistingExternalIdentity: boolean | undefined;
  readonly externalId: string;
}): string | undefined {
  return args.matchExistingExternalIdentity && args.mutation.intent === "add"
    ? args.externalId
    : undefined;
}

export interface PreparedBuiltinConnectorTokenConnection {
  readonly calendarCleanup: readonly {
    readonly connectorId: string;
    readonly externalId: string | null;
    readonly pending: PendingGoogleCalendarWatchStop | null;
  }[];
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorTokenState: PreparedBuiltinConnectorTokenState;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly userInfo: ExternalUserInfo;
  readonly oauthRequestedScopes: readonly string[];
  readonly oauthGrantedScopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
  readonly account: ConnectorAccountMutationIntent;
  readonly matchExistingExternalIdentity?: boolean;
  readonly insertConnectionId?: string;
}

interface CommitBuiltinConnectorTokenConnectionArgs extends PreparedBuiltinConnectorTokenConnection {
  readonly db: Tx;
}

interface ResolvedBuiltinConnectorTokenConnectionArgs extends CommitBuiltinConnectorTokenConnectionArgs {
  readonly resolution: ConnectorConnectionMutationResolution;
}

export interface CommittedBuiltinConnectorTokenConnection {
  readonly status: "connected";
  readonly connectorRow: StoredConnectorRow;
  readonly created: boolean;
  readonly pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null;
  readonly pendingGoogleCalendarWatchStop: PendingGoogleCalendarWatchStop | null;
}

type BuiltinConnectorTokenConnectionCommitResult =
  | CommittedBuiltinConnectorTokenConnection
  | ConnectorConnectionMutationFailure
  | { readonly status: "identityMismatch" };

function builtinConnectorTokenConnectionValues(
  connection: PreparedBuiltinConnectorTokenConnection,
) {
  return {
    metadata: {
      orgId: connection.orgId,
      userId: connection.userId,
      authMethod: connection.runtimeMethod.authMethodId,
      storageVersion: connection.runtimeMethod.method.storage.version,
      tokenExpiresAt: connection.tokenExpiresAt,
      target: {
        kind: "builtin" as const,
        connectorSlug: connection.runtimeMethod.connectorSlug,
        identity: {
          kind: "external" as const,
          externalId: connection.userInfo.id,
          externalUsername: connection.userInfo.username,
          externalEmail: connection.userInfo.email,
          oauthRequestedScopes: connection.oauthRequestedScopes,
          oauthGrantedScopes: connection.oauthGrantedScopes,
        },
      },
    },
    credentials: {
      method: connection.runtimeMethod.method,
      orgId: connection.orgId,
      userId: connection.userId,
      state: connection.connectorTokenState,
    },
    quest: {
      orgId: connection.orgId,
      userId: connection.userId,
      questKey: "connector" as const,
      sourceKey: `builtin:${connection.runtimeMethod.connectorSlug}`,
    },
  };
}

interface BuiltinConnectorTokenConnectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly snapshot: ConnectorRuntimeSelection;
  readonly outputs: BuiltinConnectorTokenOutputValues;
  readonly userInfo: ExternalUserInfo;
  readonly oauthRequestedScopes: readonly string[];
  readonly oauthGrantedScopes: readonly string[];
  readonly expiresIn?: number;
  readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
  readonly account: ConnectorAccountMutationIntent;
  readonly matchExistingExternalIdentity?: boolean;
  readonly insertConnectionId?: string;
}

async function reprojectConnectedWorkflowAutomations(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await reprojectWorkflowAutomationsForOwner(
    args.db,
    {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug: args.connectorSlug },
    },
    signal,
  );
}

async function prepareConnectorTokenConnectionCleanup(
  args: CommitBuiltinConnectorTokenConnectionArgs,
  existing: StoredConnectorRow | null,
  signal: AbortSignal,
): Promise<{
  readonly pendingTokenRevoke: PendingBuiltinConnectorTokenRevoke | null;
  readonly pendingGoogleCalendarWatchStop: PendingGoogleCalendarWatchStop | null;
}> {
  const pendingTokenRevoke =
    await loadPendingConnectorTokenRevokeForTokenConnect(
      args.db,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        snapshot: args.snapshot,
        featureSwitchContext: args.featureSwitchContext,
        existing,
      },
      signal,
    );
  const pendingGoogleCalendarWatchStop =
    existing && existing.externalId !== args.userInfo.id
      ? (args.calendarCleanup.find((candidate) => {
          return (
            candidate.connectorId === existing.id &&
            candidate.externalId === existing.externalId
          );
        })?.pending ?? null)
      : null;
  return { pendingTokenRevoke, pendingGoogleCalendarWatchStop };
}

export function builtinConnectorTokenMutationValues(
  args: Pick<
    PreparedBuiltinConnectorTokenConnection,
    | "orgId"
    | "userId"
    | "runtimeMethod"
    | "account"
    | "matchExistingExternalIdentity"
    | "userInfo"
  >,
): Parameters<typeof resolveConnectorConnectionMutation>[1] {
  return {
    orgId: args.orgId,
    userId: args.userId,
    target: {
      kind: "builtin",
      connectorSlug: args.runtimeMethod.connectorSlug,
    },
    mutation: args.account,
    allowSiblings: true,
    matchExternalId: authorizedExternalIdForMutation({
      mutation: args.account,
      matchExistingExternalIdentity: args.matchExistingExternalIdentity,
      externalId: args.userInfo.id,
    }),
  };
}
export async function commitBuiltinConnectorTokenConnection(
  args: ResolvedBuiltinConnectorTokenConnectionArgs,
  signal: AbortSignal,
): Promise<BuiltinConnectorTokenConnectionCommitResult> {
  const resolution = args.resolution;
  signal.throwIfAborted();
  if (resolution.kind !== "ready") {
    return connectorConnectionMutationFailure(resolution);
  }
  const existingConnector =
    resolution.mutation.kind === "update" ? resolution.mutation.existing : null;
  if (
    isExplicitReconnectIdentityMismatch({
      account: args.account,
      existing: existingConnector,
      nextExternalId: args.userInfo.id,
    })
  ) {
    return { status: "identityMismatch" };
  }
  const { pendingTokenRevoke, pendingGoogleCalendarWatchStop } =
    await prepareConnectorTokenConnectionCleanup(
      args,
      existingConnector,
      signal,
    );
  if (existingConnector !== null) {
    const db = args.db;
    const ref = connectorAccountReconciliationIdentity(
      existingConnector,
      args.userInfo,
    );
    await (async () => {
      if (ref.previousPrincipalId === ref.nextPrincipalId) {
        if (ref.nextEmail !== null && ref.previousEmail !== ref.nextEmail) {
          await db
            .update(gmailWatchStates)
            .set({ emailAddress: ref.nextEmail, updatedAt: nowDate() })
            .where(eq(gmailWatchStates.connectorId, ref.connectorId));
          signal.throwIfAborted();
          if (ref.previousEmail !== null) {
            await db
              .update(googleCalendarWatchStates)
              .set({ needsRewatch: true, updatedAt: nowDate() })
              .where(
                connectorAccountEmailWhere(ref.connectorId, ref.previousEmail),
              );
            signal.throwIfAborted();
          }
        }
        return;
      }
      const labelDb = db;
      const labelConnectorId = ref.connectorId;
      await (async () => {
        const write =
          gmailAutomationResolvedLabelInvalidationWrite(labelConnectorId);
        await labelDb.update(write.table).set(write.values).where(write.where);
      })();
      signal.throwIfAborted();
      const pendingEventDb = db;
      const invalidatedConnectorId = ref.connectorId;
      await (async () => {
        const scope = notionPendingEventsReconnectScope(invalidatedConnectorId);
        await (async () => {
          const write = notionPendingEventsSkipWrite(
            scope.condition,
            scope.reason,
          );
          await pendingEventDb
            .update(write.table)
            .set(write.values)
            .where(write.where);
        })();
      })();
      signal.throwIfAborted();
      for (const table of connectorAccountPrincipalWatchTables) {
        await db.delete(table).where(eq(table.connectorId, ref.connectorId));
        signal.throwIfAborted();
      }
      await db
        .update(mailDrafts)
        .set({ connectorId: null })
        .where(eq(mailDrafts.connectorId, ref.connectorId));
      signal.throwIfAborted();
    })();
  }
  const { db, ...connection } = args;
  const values = builtinConnectorTokenConnectionValues(connection);
  const written = await replaceConnectorConnectionOutcome(
    db,
    {
      ...values.metadata,
      resolution: resolution.mutation,
      insertConnectionId: args.insertConnectionId,
      writeCredentials: async ({ db, connectorId }, writeSignal) => {
        await upsertPreparedConnectorTokenState(
          {
            db,
            connectorId,
            ...values.credentials,
          },
          writeSignal,
        );
      },
    },
    signal,
  );
  if (written.kind !== "written") {
    return connectorConnectionMutationFailure(written);
  }
  const connectorRow = written.row;
  if (isOneClickConnectorGrantKind(args.runtimeMethod.method.grant.kind)) {
    await args.db.execute(completedGetStartedQuestSql(values.quest, nowDate()));
  }
  await reprojectConnectedWorkflowAutomations(
    { ...args, connectorSlug: args.runtimeMethod.connectorSlug },
    signal,
  );
  return {
    status: "connected",
    connectorRow,
    created: existingConnector === null,
    pendingTokenRevoke,
    pendingGoogleCalendarWatchStop,
  };
}
export const prepareBuiltinConnectorTokenConnection$ = command(
  async (
    { get, set },
    args: BuiltinConnectorTokenConnectionArgs,
    signal: AbortSignal,
  ): Promise<PreparedBuiltinConnectorTokenConnection> => {
    const outputMetadata = connectorTokenOutputMetadataForAuthMethod({
      runtimeMethod: args.runtimeMethod,
    });
    if (!outputMetadata) {
      throw new Error(
        `${args.runtimeMethod.connectorSlug} connector auth method ${args.runtimeMethod.authMethodId} does not expose token outputs`,
      );
    }
    const tokenExpiresAt = connectorTokenExpiresAt({
      isRefreshable: outputMetadata.isRefreshable,
      expiresIn: args.expiresIn,
    });
    const extraSecrets = validateExtraConnectorTokenSecrets({
      connectorSlug: args.runtimeMethod.connectorSlug,
      method: args.runtimeMethod.method,
      extraConnectorSecrets: args.extraConnectorSecrets,
      outputTargets: outputMetadata.outputTargets,
    });
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const connectorTokenState = await prepareConnectorTokenState(
      {
        connectorSlug: args.runtimeMethod.connectorSlug,
        outputTargets: outputMetadata.outputTargets,
        requiredOutputNames: outputMetadata.requiredOutputNames,
        requiredExtraSecretNames: outputMetadata.requiredExtraSecretNames,
        outputs: args.outputs,
        extraSecrets,
        featureSwitchContext,
      },
      signal,
    );
    signal.throwIfAborted();
    const calendarCleanup: {
      connectorId: string;
      externalId: string | null;
      pending: PendingGoogleCalendarWatchStop | null;
    }[] = [];
    if (args.runtimeMethod.connectorSlug === "google-calendar") {
      const db = set(writeDb$);
      const accounts = await db
        .select({
          connectorId: connectors.id,
          externalId: connectors.externalId,
        })
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, "google-calendar"),
          ),
        );
      signal.throwIfAborted();
      for (const account of accounts) {
        if (account.externalId === args.userInfo.id) {
          continue;
        }
        const pending = await set(
          prepareGoogleCalendarWatchStopForConnector$,
          {
            orgId: args.orgId,
            userId: args.userId,
            connectorId: account.connectorId,
          },
          signal,
        );
        calendarCleanup.push({ ...account, pending });
      }
    }
    return {
      calendarCleanup,
      orgId: args.orgId,
      userId: args.userId,
      runtimeMethod: args.runtimeMethod,
      snapshot: args.snapshot,
      connectorTokenState,
      featureSwitchContext,
      userInfo: args.userInfo,
      oauthRequestedScopes: args.oauthRequestedScopes,
      oauthGrantedScopes: args.oauthGrantedScopes,
      tokenExpiresAt,
      account: args.account,
      matchExistingExternalIdentity: args.matchExistingExternalIdentity,
      insertConnectionId: args.insertConnectionId,
    };
  },
);
export const finalizeBuiltinConnectorTokenConnection$ = command(
  async (
    { set },
    args: {
      readonly prepared: PreparedBuiltinConnectorTokenConnection;
      readonly connectionResult: CommittedBuiltinConnectorTokenConnection;
      readonly postCommitAbort: unknown;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly status: "connected";
    readonly connector: BuiltinConnectorResponse;
    readonly created: boolean;
  }> => {
    const { prepared, connectionResult } = args;
    let postCommitAbort = args.postCommitAbort;
    const automationCleanupAbort =
      await stopPendingGoogleCalendarAutomationCleanup(
        connectionResult.pendingGoogleCalendarWatchStop,
        signal,
      );
    postCommitAbort ??= automationCleanupAbort;
    await finalizeConnectorStateChangeAfterCommit(
      {
        userId: prepared.userId,
        connectorSlug: prepared.runtimeMethod.connectorSlug,
        pendingTokenRevoke: connectionResult.pendingTokenRevoke,
        postCommitAbort,
      },
      signal,
    );
    await set(
      reconcileAccountBoundAutomationWatches$,
      {
        orgId: prepared.orgId,
        userId: prepared.userId,
        connectorSlug: prepared.runtimeMethod.connectorSlug,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: "connected",
      connector: storedBuiltinConnectorRowToResponse(
        connectionResult.connectorRow,
        prepared.runtimeMethod,
        nowDate(),
      ),
      created: connectionResult.created,
    };
  },
);
export const upsertBuiltinConnectorTokenConnection$ = command(
  async (
    { set },
    args: BuiltinConnectorTokenConnectionArgs,
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const prepared = await set(
      prepareBuiltinConnectorTokenConnection$,
      args,
      signal,
    );
    let postCommitAbort: unknown = null;
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0119; new non-billing transactions are prohibited.
    const connectionResult = await writeDb.transaction(async (tx) => {
      const [insertedWallet] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({ orgId: prepared.orgId })
        .onConflictDoNothing()
        .returning({ orgId: orgMetadata.orgId });
      await tx.select().from(memberRewardWalletQuery(prepared.orgId));
      if (insertedWallet) {
        await tx
          .insert(orgPlanEntitlements)
          .values(slackRewardWalletEntitlement(prepared.orgId))
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      const write = { ...prepared, db: tx };
      const mutationInput = write;
      const mutationSignal = signal;
      const resolution = await (async () => {
        const { db, ...connection } = mutationInput;
        const resolution = await resolveConnectorConnectionMutation(
          db,
          builtinConnectorTokenMutationValues(connection),
        );
        mutationSignal.throwIfAborted();
        return resolution;
      })();
      const connected = await commitBuiltinConnectorTokenConnection(
        { ...write, resolution },
        signal,
      );
      return connected;
    });
    if (signal.aborted) {
      postCommitAbort = signal.reason;
    }
    if (connectionResult.status !== "connected") {
      throwCapturedAbort(postCommitAbort);
      return connectionResult;
    }
    return await set(
      finalizeBuiltinConnectorTokenConnection$,
      { prepared, connectionResult, postCommitAbort },
      signal,
    );
  },
);

interface BuiltinConnectorScopeDiffScope {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly connectorId: string;
}

export function builtinConnectorScopeDiff(
  scope$: Computed<BuiltinConnectorScopeDiffScope>,
): Computed<Promise<ScopeDiffResponse | null>> {
  const catalog$ = computed(async (get) => {
    const args = get(scope$);
    const plan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: [args.connectorSlug],
    });
    const rows = await get(db$)
      .select(plan.columns)
      .from(connectorCatalog)
      .leftJoin(connectorCatalogEntries, plan.join)
      .where(connectorCatalogCurrentWhere());
    return connectorRuntimeSlugSelectionFromRows(plan.selection, rows);
  });

  const snapshot$ = computed(async (get) => {
    const result = await settle(get(catalog$));
    if (result.ok) {
      return result.value;
    }
    if (!isConnectorCatalogUnavailableError(result.error)) {
      throw result.error;
    }
    log.warn(
      "Connector catalog unavailable while resolving stored connectors",
      {
        error: result.error,
      },
    );
    return null;
  });

  const connector$ = computed(
    async (get): Promise<BuiltinConnectorWithRuntimeMethod | null> => {
      const args = get(scope$);
      const snapshot = await get(snapshot$);
      if (snapshot === null) {
        return null;
      }
      const oauthRows = await get(db$)
        .select(storedBuiltinConnectorColumns())
        .from(connectors)
        .where(
          and(
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, args.connectorSlug),
            eq(connectors.id, args.connectorId),
          ),
        )
        .limit(1);

      const oauthRow = oauthRows[0];
      if (oauthRow) {
        return storedBuiltinConnectorRowWithRuntimeMethod({
          connectorSlug: args.connectorSlug,
          now: nowDate(),
          row: oauthRow,
          snapshot,
        });
      }

      return null;
    },
  );

  return computed(async (get): Promise<ScopeDiffResponse | null> => {
    const connector = await get(connector$);
    return connector === null
      ? null
      : connectorAuthMethodScopeDiff(
          connector.runtimeMethod.method,
          connector.oauthRequestedScopes,
        );
  });
}

export function builtinConnectorSearch(args: {
  readonly orgId: string | undefined;
  readonly userId: string;
  readonly keyword: string | undefined;
}): Computed<Promise<BuiltinConnectorSearchItem[]>> {
  return computed(async (get) => {
    const overrides = args.orgId
      ? await get(userFeatureSwitchOverrides(args.orgId, args.userId))
      : {};
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });
    const catalogSearchDb = get(db$);
    const catalogSearchKeyword = args.keyword;
    return (async () => {
      return await (async () => {
        const viewArgs = { keyword: catalogSearchKeyword, featureStates };
        const snapshot = await loadAcceptedConnectorCatalogSnapshot(
          catalogSearchDb,
          undefined,
          "display",
        );
        return connectorCatalogSearchFromSnapshot({
          ...viewArgs,
          catalog: snapshot,
        });
      })();
    })();
  });
}
