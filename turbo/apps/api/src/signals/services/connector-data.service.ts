import { awardCompletedGetStartedQuest } from "./get-started-rewards.service";
import { command, computed, type Computed } from "ccstate";
import {
  connectorReconnectReasonSchema,
  type ConnectorListResponse,
  type ConnectorProvidedBinding,
  type ConnectorReconnectReason,
  type ConnectorResponse,
  type ScopeDiffResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ConnectorSearchItem } from "@okouai/api-contracts/contracts/connectors";
import {
  connectorAuthMethodGrantMetadata,
  connectorAuthMethodOwnedSecretNames,
  connectorAuthMethodRevokeMetadata,
  connectorAuthMethodRuntimeMetadata,
  connectorAuthMethodScopeDiff,
  type ConnectorOutputTarget,
} from "@okouai/connectors/connector-auth-method";
import { revokeConnectorAuthMethodAccessTokenWithMethod } from "@okouai/connectors/auth-providers";
import type {
  ConnectorAuthMethodRuntimeConfig,
  ConnectorManualGrantFieldConfig,
} from "@okouai/connectors/connector-config";
import {
  getAllFeatureStates,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { optionalEnv } from "../../lib/env";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import { bestEffort, settle, settleIncludingAbort } from "../utils";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import { lockConnectorState } from "./auth-state-lock.service";
import {
  userFeatureSwitchContext,
  userFeatureSwitchOverrides,
} from "./feature-switches.service";
import {
  connectorCredentialReconnectReasonWithMethod,
  connectorCredentialStatusWithMethod,
} from "./connector-credential-status.service";
import {
  connectorCredentialSecretReadCondition,
  connectorCredentialStorageIsCompatible,
  resolveConnectorCredentialAccess,
  resolveStoredConnectorRuntimeMethod,
  type ConnectorCredentialAccess,
} from "./connector-credential-access.service";
import { publishBuiltinConnectorInvalidationAfterCommit } from "./connector-client-invalidation.service";
import {
  deleteConnectorCredentialStorageConnection,
  upsertConnectorOwnedSecret,
  upsertConnectorOwnedVariable,
} from "./connector-credential-storage-write.service";
import { normalizeManualGrantSubmittedValuesWithMethod } from "./connector-catalog-form-fields.service";
import type { ConnectorCatalogConnection } from "./connector-catalog-connection";
import {
  isConnectorCatalogUnavailableError,
  searchConnectorCatalog,
} from "./connector-catalog-reader.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeMethod,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  prepareGmailWatchStopForConnector,
  reconcileGmailWatchesForUser,
  stopPreparedGmailWatch,
  type PendingGmailWatchStop,
} from "./gmail-automation-event.service";
import {
  prepareGoogleCalendarWatchStopForConnector,
  reconcileGoogleCalendarWatchesForUser,
  stopPreparedGoogleCalendarWatches,
  type PendingGoogleCalendarWatchStop,
} from "./google-calendar-automation-event.service";
import {
  prepareGoogleFormsWatchStopForConnector,
  reconcileGoogleFormsWatchesForUser,
  stopPreparedGoogleFormsWatches,
  type PendingGoogleFormsWatchStop,
} from "./google-forms-automation-event.service";
import {
  deletePreparedGoogleMeetSubscriptionWithLifecycleLock,
  prepareGoogleMeetSubscriptionDeleteForConnector,
  reconcileGoogleMeetSubscriptionsForUser,
  type PendingGoogleMeetSubscriptionDelete,
} from "./google-meet-automation-event.service";
import { reconcileConnectorAccountState } from "./connector-account-state.service";
import { prepareConnectorAccountDeletion } from "./connector-account-lifecycle.service";
import { resolveConnectorAccount } from "./connector-account-resolution.service";
import {
  replaceConnectorConnection,
  resolveConnectorConnectionMutation,
  type ConnectorConnectionMutationResolution,
  type StoredConnectorConnectionRow as StoredConnectorRow,
} from "./connector-connection-write.service";
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

interface ConnectorTokenOutputMetadata {
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
  readonly isRefreshable: boolean;
}

type ConnectorTokenOutputValues = Readonly<
  Record<string, string | null | undefined>
>;

interface PreparedManualGrantConnect {
  readonly secretValues: readonly PreparedManualGrantField[];
  readonly variableValues: readonly PreparedManualGrantField[];
  readonly configuredSecretNames: readonly string[];
  readonly configuredVariableNames: readonly string[];
}

type PreparedManualGrantConnectResult =
  | { readonly ok: true; readonly prepared: PreparedManualGrantConnect }
  | { readonly ok: false; readonly message: string };

type ConnectManualGrantConnectorResult =
  | { readonly status: "connected"; readonly connector: ConnectorResponse }
  | { readonly status: "invalid"; readonly message: string }
  | ConnectorConnectionMutationFailure;

type ConnectNoAuthConnectorResult =
  | {
      readonly status: "connected";
      readonly connector: ConnectorResponse;
    }
  | ConnectorConnectionMutationFailure;

type ConnectorConnectionMutationFailure =
  | { readonly status: "accountNotFound" }
  | { readonly status: "accountAmbiguous" }
  | { readonly status: "siblingDisabled" };

type ConnectorConnectionWriteFailureStatus =
  | ConnectorConnectionMutationFailure["status"]
  | "identityMismatch";

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
): { readonly ok: false; readonly message: string } {
  return { ok: false, message: connectorConnectionWriteFailureMessage(status) };
}

function connectorConnectionMutationFailure(
  resolution: Exclude<
    ConnectorConnectionMutationResolution,
    { readonly kind: "ready" }
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

interface EncryptedConnectorTokenSecret {
  readonly name: string;
  readonly encryptedValue: string;
  readonly description: string;
}

interface PreparedConnectorTokenVariable {
  readonly name: string;
  readonly value: string;
}

interface PreparedConnectorTokenState {
  readonly secrets: readonly EncryptedConnectorTokenSecret[];
  readonly variables: readonly PreparedConnectorTokenVariable[];
}

interface ConnectorTokenOutputRequirements {
  readonly requiredOutputNames: readonly string[];
  readonly requiredExtraSecretNames: readonly string[];
}

interface ConnectorWithRuntimeMethod {
  readonly response: ConnectorResponse;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly oauthRequestedScopes: readonly string[] | null;
}

type PendingConnectorTokenRevoke = {
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly encryptedInputs: Readonly<Record<string, string>>;
  readonly featureSwitchContext: FeatureSwitchContext;
};

/**
 * External catalog availability must not turn persisted connector reads or
 * local cleanup into server failures. Callers use a missing snapshot to skip
 * runtime-dependent presentation and provider revocation only.
 */
export async function loadStoredConnectorRuntimeSnapshot(
  db: ReadonlyDb,
): Promise<ConnectorRuntimeSnapshot | null> {
  const result = await settle(loadConnectorRuntimeSnapshot(db));
  if (result.ok) {
    return result.value;
  }
  if (!isConnectorCatalogUnavailableError(result.error)) {
    throw result.error;
  }
  log.warn("Connector catalog unavailable while resolving stored connectors", {
    error: result.error,
  });
  return null;
}

function parseOauthScopes(value: string | null): string[] | null {
  return value ? oauthScopesSchema.parse(JSON.parse(value)) : null;
}

function parseStoredReconnectReason(
  value: string | null,
): ConnectorReconnectReason | null {
  if (value === null) {
    return null;
  }
  const parsed = connectorReconnectReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function storedConnectorRowToResponse(
  row: StoredConnectorRow,
  runtimeMethod: ConnectorRuntimeMethod,
  now: Date,
): ConnectorResponse {
  const storageCompatible = connectorCredentialStorageIsCompatible({
    runtimeMethod,
    storageVersion: row.storageVersion,
  });
  const credentialStatus = connectorCredentialStatusWithMethod({
    method: runtimeMethod.method,
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
          connectorCredentialReconnectReasonWithMethod({
            method: runtimeMethod.method,
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

function storedConnectorRowWithRuntimeMethod(args: {
  readonly connectorSlug: string;
  readonly now: Date;
  readonly row: StoredConnectorRow;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): ConnectorWithRuntimeMethod | null {
  const runtimeMethod = resolveStoredConnectorRuntimeMethod({
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
    response: storedConnectorRowToResponse(args.row, runtimeMethod, args.now),
    runtimeMethod,
    oauthRequestedScopes: parseOauthScopes(args.row.oauthScopes),
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
    readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
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
      message: `Missing required manual grant field(s): ${formatManualGrantFieldList(
        missingRequiredNames,
      )}`,
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

interface ConnectorListState {
  readonly response: ConnectorListResponse;
  readonly catalogConnections: readonly ConnectorCatalogConnection[];
}

function connectorListState(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ConnectorListState>> {
  return computed(async (get): Promise<ConnectorListState> => {
    const db = get(db$);
    const storedRowsPromise = db
      .select({
        id: connectors.id,
        connectorSlug: sql`${connectors.connectorSlug}`
          .mapWith(pgTextDecoder)
          .as("connector_slug"),
        authMethod: connectors.authMethod,
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
    const [storedRows, snapshot] = await Promise.all([
      storedRowsPromise,
      loadStoredConnectorRuntimeSnapshot(db),
    ]);
    const now = nowDate();
    const storedConnectors: ConnectorWithRuntimeMethod[] =
      snapshot === null
        ? []
        : storedRows.flatMap((row) => {
            const connector = storedConnectorRowWithRuntimeMethod({
              connectorSlug: row.connectorSlug,
              now,
              row,
              snapshot,
            });
            return connector === null ? [] : [connector];
          });
    const connectorProvidedBindings =
      snapshot === null
        ? []
        : connectorProvidedBindingsForStoredConnectors(
            storedConnectors,
            snapshot,
          );

    return {
      response: {
        connectors: storedConnectors.map((connector) => {
          return connector.response;
        }),
        connectorProvidedBindings,
      },
      catalogConnections: storedConnectors.map((connector) => {
        return {
          response: connector.response,
          oauthRequestedScopes: connector.oauthRequestedScopes,
        };
      }),
    };
  });
}

export function connectorList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<ConnectorListResponse>> {
  return computed(async (get): Promise<ConnectorListResponse> => {
    return (await get(connectorListState(args))).response;
  });
}

export function connectorCatalogConnectionList(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly ConnectorCatalogConnection[]>> {
  return computed(
    async (get): Promise<readonly ConnectorCatalogConnection[]> => {
      return (await get(connectorListState(args))).catalogConnections;
    },
  );
}

function connectorProvidedBindingsForStoredConnectors(
  storedConnectors: readonly ConnectorWithRuntimeMethod[],
  snapshot: ConnectorRuntimeSnapshot,
): ConnectorProvidedBinding[] {
  const provided: ConnectorProvidedBinding[] = [];
  for (const connector of storedConnectors) {
    if (
      connector.response.connectionStatus !== "connected" ||
      getConnectorRuntimeConnector(snapshot, connector.response.slug)
        ?.catalogConnector.mcp !== undefined
    ) {
      continue;
    }
    const metadata = connectorAuthMethodRuntimeMetadata(
      connector.runtimeMethod.method,
    );
    for (const { envName, optional, source } of metadata.runtimeBindings) {
      switch (source.kind) {
        case "connector-secret": {
          provided.push({
            connectorSlug: connector.response.slug,
            authMethod: connector.response.authMethod,
            namespace: "secrets",
            name: envName,
            optional,
            source,
          });
          break;
        }
        case "connector-variable": {
          provided.push({
            connectorSlug: connector.response.slug,
            authMethod: connector.response.authMethod,
            namespace: "vars",
            name: envName,
            optional,
            source,
          });
          break;
        }
        case "platform-secret": {
          break;
        }
      }
    }
  }
  return provided;
}

type StoredConnectorSelection =
  | { readonly kind: "default" }
  | { readonly kind: "exact"; readonly connectorId: string };

function storedConnector(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly selection: StoredConnectorSelection;
}): Computed<Promise<ConnectorWithRuntimeMethod | null>> {
  return computed(async (get): Promise<ConnectorWithRuntimeMethod | null> => {
    const db = get(db$);
    const oauthRows = await db
      .select({
        id: connectors.id,
        authMethod: connectors.authMethod,
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
          eq(connectors.connectorSlug, args.connectorSlug),
          args.selection.kind === "exact"
            ? eq(connectors.id, args.selection.connectorId)
            : eq(connectors.isDefault, true),
        ),
      )
      .limit(1);

    const oauthRow = oauthRows[0];
    if (oauthRow) {
      return storedConnectorRowWithRuntimeMethod({
        connectorSlug: args.connectorSlug,
        now: nowDate(),
        row: oauthRow,
        snapshot: args.snapshot,
      });
    }

    return null;
  });
}

export function connectorBySlug(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly snapshot?: ConnectorRuntimeSnapshot;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const snapshot =
      args.snapshot ?? (await loadStoredConnectorRuntimeSnapshot(get(db$)));
    if (snapshot === null) {
      return null;
    }
    const connector = await get(
      storedConnector({
        ...args,
        snapshot,
        selection: { kind: "default" },
      }),
    );
    return connector?.response ?? null;
  });
}

export function connectorById(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly connectorId: string;
  readonly snapshot: ConnectorRuntimeSnapshot;
}): Computed<Promise<ConnectorResponse | null>> {
  return computed(async (get): Promise<ConnectorResponse | null> => {
    const connector = await get(
      storedConnector({
        ...args,
        selection: { kind: "exact", connectorId: args.connectorId },
      }),
    );
    return connector?.response ?? null;
  });
}

async function loadPendingConnectorTokenRevoke(
  args: {
    readonly access: ConnectorCredentialAccess;
    readonly db: Db | ReadonlyDb;
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<PendingConnectorTokenRevoke | null> {
  const revokeMetadata = connectorAuthMethodRevokeMetadata(
    args.access.runtimeMethod.method,
  );
  if (revokeMetadata?.kind !== "token-revoke") {
    return null;
  }

  const inputEntries = Object.entries(revokeMetadata.inputs);
  if (inputEntries.length === 0) {
    return {
      runtimeMethod: args.access.runtimeMethod,
      encryptedInputs: {},
      featureSwitchContext: args.featureSwitchContext,
    };
  }

  const secretNames = inputEntries.map(([, input]) => {
    return input.secretName;
  });
  const secretRows = await args.db
    .select({ name: secrets.name, encryptedValue: secrets.encryptedValue })
    .from(secrets)
    .where(
      connectorCredentialSecretReadCondition({
        db: args.db,
        groups: [{ access: args.access, names: secretNames }],
      }),
    );
  signal.throwIfAborted();

  const encryptedValuesByName = new Map(
    secretRows.flatMap((row) => {
      return row.encryptedValue ? [[row.name, row.encryptedValue]] : [];
    }),
  );
  const encryptedInputs: Record<string, string> = {};
  for (const [inputName, input] of inputEntries) {
    const encryptedValue = encryptedValuesByName.get(input.secretName);
    if (!encryptedValue) {
      return null;
    }
    encryptedInputs[inputName] = encryptedValue;
  }

  return {
    runtimeMethod: args.access.runtimeMethod,
    encryptedInputs,
    featureSwitchContext: args.featureSwitchContext,
  };
}

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
    readonly pending: PendingConnectorTokenRevoke;
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

async function reconcileAccountBoundAutomationWatches(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.connectorSlug === "gmail") {
    await bestEffort(
      reconcileGmailWatchesForUser({ db, ...args }, signal),
      signal,
    );
  } else if (args.connectorSlug === "google-calendar") {
    await bestEffort(
      reconcileGoogleCalendarWatchesForUser({ db, ...args }, signal),
      signal,
    );
  } else if (args.connectorSlug === "google-forms") {
    await bestEffort(
      reconcileGoogleFormsWatchesForUser({ db, ...args }, signal),
      signal,
    );
  } else if (args.connectorSlug === "google-meet") {
    await bestEffort(
      reconcileGoogleMeetSubscriptionsForUser({ db, ...args }, signal),
      signal,
    );
  }
}

type ConnectorAccountForDeletion =
  | { readonly kind: "missing" }
  | {
      readonly kind: "resolved";
      readonly connector: {
        readonly id: string;
        readonly authMethod: string;
        readonly storageVersion: number;
      };
    };

async function loadConnectorAccountForDeletion(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly sourceId: string;
  },
  signal: AbortSignal,
): Promise<ConnectorAccountForDeletion> {
  const resolution = await resolveConnectorAccount(db, {
    orgId: args.orgId,
    userId: args.userId,
    request: {
      target: { kind: "builtin", connectorSlug: args.connectorSlug },
      selection: { kind: "exact", sourceId: args.sourceId },
    },
  });
  signal.throwIfAborted();
  if (resolution.kind !== "resolved") {
    return { kind: "missing" };
  }

  const [connector] = await db
    .select({
      id: connectors.id,
      authMethod: connectors.authMethod,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(eq(connectors.id, resolution.account.connectorId))
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  return connector ? { kind: "resolved", connector } : { kind: "missing" };
}

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
  return await prepareConnectorAccountDeletion(
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

type DeleteConnectorLocalStateResult =
  | "missing"
  | {
      readonly kind: "deleted";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    };

interface DeleteConnectorLocalStateArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly sourceId: string;
  readonly snapshot?: ConnectorRuntimeSnapshot | null;
}

interface PendingConnectorAutomationCleanup {
  readonly pendingGmailWatchStop: PendingGmailWatchStop | null;
  readonly pendingGoogleCalendarWatchStop: PendingGoogleCalendarWatchStop | null;
  readonly pendingGoogleFormsWatchStop: PendingGoogleFormsWatchStop | null;
  readonly pendingGoogleMeetSubscriptionDelete: PendingGoogleMeetSubscriptionDelete | null;
}

async function prepareConnectorAutomationCleanup(
  tx: Tx,
  args: DeleteConnectorLocalStateArgs,
  connectorId: string,
  signal: AbortSignal,
): Promise<PendingConnectorAutomationCleanup> {
  const cleanupArgs = {
    db: tx,
    orgId: args.orgId,
    userId: args.userId,
    connectorId,
  };
  const pendingGmailWatchStop =
    args.connectorSlug === "gmail"
      ? await prepareGmailWatchStopForConnector(cleanupArgs, signal)
      : null;
  const pendingGoogleCalendarWatchStop =
    args.connectorSlug === "google-calendar"
      ? await prepareGoogleCalendarWatchStopForConnector(cleanupArgs, signal)
      : null;
  const pendingGoogleFormsWatchStop =
    args.connectorSlug === "google-forms"
      ? await prepareGoogleFormsWatchStopForConnector(cleanupArgs, signal)
      : null;
  const pendingGoogleMeetSubscriptionDelete =
    args.connectorSlug === "google-meet"
      ? await prepareGoogleMeetSubscriptionDeleteForConnector(
          cleanupArgs,
          signal,
        )
      : null;
  return {
    pendingGmailWatchStop,
    pendingGoogleCalendarWatchStop,
    pendingGoogleFormsWatchStop,
    pendingGoogleMeetSubscriptionDelete,
  };
}

async function deleteConnectorAccountLocalState(
  tx: Tx,
  args: DeleteConnectorLocalStateArgs,
  snapshot: ConnectorRuntimeSnapshot | null,
  featureSwitchContext: FeatureSwitchContext | null,
  signal: AbortSignal,
) {
  await lockConnectorState(tx, {
    orgId: args.orgId,
    userId: args.userId,
    connectorSlug: args.connectorSlug,
  });
  signal.throwIfAborted();

  const account = await loadConnectorAccountForDeletion(tx, args, signal);
  if (account.kind !== "resolved") {
    return {
      kind: account.kind,
      pendingTokenRevoke: null,
      pendingGmailWatchStop: null,
      pendingGoogleCalendarWatchStop: null,
      pendingGoogleMeetSubscriptionDelete: null,
      pendingGoogleFormsWatchStop: null,
    };
  }
  const existing = account.connector;
  const deletion = await prepareBuiltinConnectorAccountDeletion(
    tx,
    {
      ...args,
      connectionId: existing.id,
    },
    signal,
  );
  signal.throwIfAborted();
  if (deletion.kind !== "ready") {
    return {
      kind: deletion.kind,
      pendingTokenRevoke: null,
      pendingGmailWatchStop: null,
      pendingGoogleCalendarWatchStop: null,
      pendingGoogleMeetSubscriptionDelete: null,
      pendingGoogleFormsWatchStop: null,
    };
  }

  let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
  if (snapshot !== null && featureSwitchContext !== null) {
    const accessResult = resolveConnectorCredentialAccess({
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
      pendingTokenRevoke = await loadPendingConnectorTokenRevoke(
        {
          access: accessResult.access,
          db: tx,
          featureSwitchContext,
        },
        signal,
      );
    }
  }
  signal.throwIfAborted();

  const pendingAutomationCleanup = await prepareConnectorAutomationCleanup(
    tx,
    args,
    existing.id,
    signal,
  );
  await deleteConnectorCredentialStorageConnection(
    tx,
    { connectorId: existing.id },
    signal,
  );
  return {
    kind: "deleted" as const,
    pendingTokenRevoke,
    ...pendingAutomationCleanup,
    deletion,
  };
}

async function stopPendingConnectorAutomationCleanup(
  db: Db,
  pending: PendingConnectorAutomationCleanup,
  signal: AbortSignal,
): Promise<unknown> {
  let capturedAbort: unknown = null;
  if (pending.pendingGmailWatchStop !== null) {
    const stopped = await settleIncludingAbort(
      bestEffort(
        stopPreparedGmailWatch(
          { db, pending: pending.pendingGmailWatchStop },
          signal,
        ),
        signal,
      ),
    );
    if (signal.aborted) {
      capturedAbort ??= signal.reason;
    }
    if (!stopped.ok) {
      capturedAbort ??= stopped.error;
    }
  }
  capturedAbort ??= await stopPendingGoogleCalendarAutomationCleanup(
    pending.pendingGoogleCalendarWatchStop,
    signal,
  );
  if (pending.pendingGoogleMeetSubscriptionDelete !== null) {
    const deleted = await settleIncludingAbort(
      bestEffort(
        deletePreparedGoogleMeetSubscriptionWithLifecycleLock(
          {
            db,
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
  if (pending.pendingGoogleFormsWatchStop !== null) {
    const stopped = await settleIncludingAbort(
      bestEffort(
        stopPreparedGoogleFormsWatches(
          pending.pendingGoogleFormsWatchStop,
          signal,
        ),
        signal,
      ),
    );
    if (signal.aborted) {
      capturedAbort ??= signal.reason;
    }
    if (!stopped.ok) {
      capturedAbort ??= stopped.error;
    }
  }
  return capturedAbort;
}

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

export const deleteConnectorLocalState$ = command(
  async (
    { get, set },
    args: DeleteConnectorLocalStateArgs,
    signal: AbortSignal,
  ): Promise<DeleteConnectorLocalStateResult> => {
    const writeDb = set(writeDb$);
    const snapshot =
      args.snapshot === undefined
        ? await loadStoredConnectorRuntimeSnapshot(get(db$))
        : args.snapshot;
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

    let postCommitAbort: unknown = null;
    const deleteResult = await writeDb.transaction(async (tx) => {
      return await deleteConnectorAccountLocalState(
        tx,
        args,
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

    const automationCleanupAbort = await stopPendingConnectorAutomationCleanup(
      writeDb,
      deleteResult,
      signal,
    );
    postCommitAbort ??= automationCleanupAbort;
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
        reconcileGmailWatchesForUser(
          { db: writeDb, orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.connectorSlug === "google-calendar") {
      await bestEffort(
        reconcileGoogleCalendarWatchesForUser(
          { db: writeDb, orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.connectorSlug === "google-forms") {
      await bestEffort(
        reconcileGoogleFormsWatchesForUser(
          { db: writeDb, orgId: args.orgId, userId: args.userId },
          signal,
        ),
        signal,
      );
    }
    if (args.connectorSlug === "google-meet") {
      await bestEffort(
        reconcileGoogleMeetSubscriptionsForUser(
          { db: writeDb, orgId: args.orgId, userId: args.userId },
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

async function deleteUserSecretNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
  },
  signal: AbortSignal,
): Promise<void> {
  for (const name of args.names) {
    await db
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, args.orgId),
          eq(secrets.userId, args.userId),
          eq(secrets.name, name),
          eq(secrets.type, "user"),
        ),
      );
    signal.throwIfAborted();
  }
}

async function deleteVariableNames(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
  },
  signal: AbortSignal,
): Promise<void> {
  for (const name of args.names) {
    await db
      .delete(variables)
      .where(
        and(
          eq(variables.orgId, args.orgId),
          eq(variables.userId, args.userId),
          eq(variables.type, "user"),
          eq(variables.name, name),
        ),
      );
    signal.throwIfAborted();
  }
}

async function loadPendingConnectorTokenRevokeForLocalConnect(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly snapshot: ConnectorRuntimeSnapshot;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly existing: Pick<
      StoredConnectorRow,
      "id" | "authMethod" | "storageVersion"
    > | null;
  },
  signal: AbortSignal,
): Promise<PendingConnectorTokenRevoke | null> {
  if (!args.existing) {
    return null;
  }

  let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
  const accessResult = resolveConnectorCredentialAccess({
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
    pendingTokenRevoke = await loadPendingConnectorTokenRevoke(
      {
        access: accessResult.access,
        db,
        featureSwitchContext: args.featureSwitchContext,
      },
      signal,
    );
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
    await upsertConnectorOwnedSecret(db, {
      connectorId: args.connectorId,
      storage: args.method.storage,
      orgId: args.orgId,
      userId: args.userId,
      name: field.name,
      encryptedValue: field.encryptedValue,
      description: null,
      updatedDescription: null,
    });
    signal.throwIfAborted();
  }

  for (const field of args.variableValues) {
    await upsertConnectorOwnedVariable(db, {
      connectorId: args.connectorId,
      storage: args.method.storage,
      orgId: args.orgId,
      userId: args.userId,
      name: field.name,
      value: field.value,
      description: null,
      updatedDescription: null,
    });
    signal.throwIfAborted();
  }
}

async function commitManualGrantConnector(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly runtimeMethod: ConnectorRuntimeMethod;
    readonly snapshot: ConnectorRuntimeSnapshot;
    readonly account: ConnectorAccountMutationIntent;
    readonly prepared: PreparedManualGrantConnect;
    readonly encryptedSecrets: readonly EncryptedManualGrantSecret[];
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly status: "connected";
      readonly connectorRow: StoredConnectorRow;
      readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
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
  const connectorRow = await replaceConnectorConnection(
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
  await deleteUserSecretNames(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      names: args.prepared.configuredSecretNames,
    },
    signal,
  );
  await deleteVariableNames(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      names: args.prepared.configuredVariableNames,
    },
    signal,
  );
  return { status: "connected", connectorRow, pendingTokenRevoke };
}

export const connectManualGrantConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSnapshot;
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
      connector: storedConnectorRowToResponse(
        committed.connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
    };
  },
);

export const connectNoAuthConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSnapshot;
      readonly account: ConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ): Promise<ConnectNoAuthConnectorResult> => {
    const featureSwitchContext = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();

    const writeDb = set(writeDb$);
    let pendingTokenRevoke: PendingConnectorTokenRevoke | null = null;
    let connectorRow: StoredConnectorRow | null = null;
    let mutationFailure: ConnectorConnectionMutationFailure | null = null;
    let postCommitAbort: unknown = null;

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

      connectorRow = await replaceConnectorConnection(
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
      connector: storedConnectorRowToResponse(
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
}): Promise<EncryptedConnectorTokenSecret> {
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
}): ConnectorTokenOutputMetadata | undefined {
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
  }
}

function requiredConnectorTokenOutputRequirements(args: {
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly outputTargets: Readonly<Record<string, ConnectorOutputTarget>>;
}): ConnectorTokenOutputRequirements {
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
  readonly outputs: ConnectorTokenOutputValues;
  readonly requiredOutputNames: readonly string[];
  readonly extraSecrets: readonly (readonly [string, string])[];
  readonly requiredExtraSecretNames: readonly string[];
}): void {
  const missingOutputNames = args.requiredOutputNames.filter((outputName) => {
    return !args.outputs[outputName];
  });
  if (missingOutputNames.length > 0) {
    throw new Error(
      `${args.connectorSlug} connector provider did not return required token output(s): ${formatManualGrantFieldList(
        missingOutputNames,
      )}`,
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
      `${args.connectorSlug} connector provider did not return required connector secret(s): ${formatManualGrantFieldList(
        missingExtraSecretNames,
      )}`,
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
): Promise<readonly EncryptedConnectorTokenSecret[]> {
  const encryptedSecrets: EncryptedConnectorTokenSecret[] = [];
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
    readonly outputs: ConnectorTokenOutputValues;
    readonly extraSecrets: readonly (readonly [string, string])[];
    readonly featureSwitchContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<PreparedConnectorTokenState> {
  validateConnectorTokenOutputRequirements({
    connectorSlug: args.connectorSlug,
    outputs: args.outputs,
    requiredOutputNames: args.requiredOutputNames,
    extraSecrets: args.extraSecrets,
    requiredExtraSecretNames: args.requiredExtraSecretNames,
  });

  const encryptedConnectorTokenSecrets: EncryptedConnectorTokenSecret[] = [];
  const connectorTokenVariables: PreparedConnectorTokenVariable[] = [];
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

async function upsertConnectorTokenSecrets(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly orgId: string;
    readonly userId: string;
    readonly secrets: readonly EncryptedConnectorTokenSecret[];
  },
  signal: AbortSignal,
): Promise<void> {
  if (args.secrets.length === 0) {
    return;
  }

  for (const secret of args.secrets) {
    await upsertConnectorOwnedSecret(args.db, {
      connectorId: args.connectorId,
      storage: args.method.storage,
      orgId: args.orgId,
      userId: args.userId,
      name: secret.name,
      encryptedValue: secret.encryptedValue,
      description: secret.description,
      updatedDescription: secret.description,
    });
    signal.throwIfAborted();
  }
}

async function upsertConnectorTokenVariables(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly orgId: string;
    readonly userId: string;
    readonly variables: readonly PreparedConnectorTokenVariable[];
  },
  signal: AbortSignal,
): Promise<void> {
  for (const variable of args.variables) {
    await upsertConnectorOwnedVariable(args.db, {
      connectorId: args.connectorId,
      storage: args.method.storage,
      orgId: args.orgId,
      userId: args.userId,
      name: variable.name,
      value: variable.value,
      description: null,
      updatedDescription: null,
    });
    signal.throwIfAborted();
  }
}

async function upsertPreparedConnectorTokenState(
  args: {
    readonly db: Db;
    readonly connectorId: string;
    readonly method: ConnectorAuthMethodRuntimeConfig;
    readonly orgId: string;
    readonly userId: string;
    readonly state: PreparedConnectorTokenState;
  },
  signal: AbortSignal,
): Promise<void> {
  await upsertConnectorTokenSecrets(
    {
      db: args.db,
      connectorId: args.connectorId,
      method: args.method,
      orgId: args.orgId,
      userId: args.userId,
      secrets: args.state.secrets,
    },
    signal,
  );
  await upsertConnectorTokenVariables(
    {
      db: args.db,
      connectorId: args.connectorId,
      method: args.method,
      orgId: args.orgId,
      userId: args.userId,
      variables: args.state.variables,
    },
    signal,
  );
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
    readonly snapshot: ConnectorRuntimeSnapshot;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly existing: StoredConnectorRow | null;
  },
  signal: AbortSignal,
): Promise<PendingConnectorTokenRevoke | null> {
  if (!args.existing) {
    return null;
  }
  const accessResult = resolveConnectorCredentialAccess({
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
  return await loadPendingConnectorTokenRevoke(
    {
      access: accessResult.access,
      db,
      featureSwitchContext: args.featureSwitchContext,
    },
    signal,
  );
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

interface CommitConnectorTokenConnectionArgs {
  readonly db: Tx;
  readonly orgId: string;
  readonly userId: string;
  readonly runtimeMethod: ConnectorRuntimeMethod;
  readonly snapshot: ConnectorRuntimeSnapshot;
  readonly connectorTokenState: PreparedConnectorTokenState;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly userInfo: ExternalUserInfo;
  readonly oauthRequestedScopes: readonly string[];
  readonly oauthGrantedScopes: readonly string[];
  readonly tokenExpiresAt: Date | null;
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

async function prepareGoogleCalendarPrincipalReplacementWatchStop(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly existing: StoredConnectorRow | null;
    readonly nextPrincipalId: string;
  },
  signal: AbortSignal,
): Promise<PendingGoogleCalendarWatchStop | null> {
  if (
    args.existing === null ||
    args.connectorSlug !== "google-calendar" ||
    args.existing.externalId === args.nextPrincipalId
  ) {
    return null;
  }
  return await prepareGoogleCalendarWatchStopForConnector(
    {
      db,
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.existing.id,
    },
    signal,
  );
}

async function prepareConnectorTokenConnectionCleanup(
  args: CommitConnectorTokenConnectionArgs,
  existing: StoredConnectorRow | null,
  signal: AbortSignal,
): Promise<{
  readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
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
    await prepareGoogleCalendarPrincipalReplacementWatchStop(
      args.db,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        existing,
        nextPrincipalId: args.userInfo.id,
      },
      signal,
    );
  return { pendingTokenRevoke, pendingGoogleCalendarWatchStop };
}

async function commitConnectorTokenConnection(
  args: CommitConnectorTokenConnectionArgs,
  signal: AbortSignal,
): Promise<
  | {
      readonly status: "connected";
      readonly connectorRow: StoredConnectorRow;
      readonly created: boolean;
      readonly pendingTokenRevoke: PendingConnectorTokenRevoke | null;
      readonly pendingGoogleCalendarWatchStop: PendingGoogleCalendarWatchStop | null;
    }
  | ConnectorConnectionMutationFailure
  | { readonly status: "identityMismatch" }
> {
  const mutation = args.account;
  const resolution = await resolveConnectorConnectionMutation(args.db, {
    orgId: args.orgId,
    userId: args.userId,
    target: {
      kind: "builtin",
      connectorSlug: args.runtimeMethod.connectorSlug,
    },
    mutation,
    allowSiblings: true,
    matchExternalId: authorizedExternalIdForMutation({
      mutation,
      matchExistingExternalIdentity: args.matchExistingExternalIdentity,
      externalId: args.userInfo.id,
    }),
  });
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
    await reconcileConnectorAccountState(
      args.db,
      {
        connectorId: existingConnector.id,
        previousPrincipalId: existingConnector.externalId,
        nextPrincipalId: args.userInfo.id,
        previousEmail: existingConnector.externalEmail,
        nextEmail: args.userInfo.email,
      },
      signal,
    );
  }
  const connectorRow = await replaceConnectorConnection(
    args.db,
    {
      orgId: args.orgId,
      userId: args.userId,
      authMethod: args.runtimeMethod.authMethodId,
      storageVersion: args.runtimeMethod.method.storage.version,
      tokenExpiresAt: args.tokenExpiresAt,
      target: {
        kind: "builtin",
        connectorSlug: args.runtimeMethod.connectorSlug,
        identity: {
          kind: "external",
          externalId: args.userInfo.id,
          externalUsername: args.userInfo.username,
          externalEmail: args.userInfo.email,
          oauthRequestedScopes: args.oauthRequestedScopes,
          oauthGrantedScopes: args.oauthGrantedScopes,
        },
      },
      resolution: resolution.mutation,
      insertConnectionId: args.insertConnectionId,
      writeCredentials: async ({ db, connectorId }, writeSignal) => {
        await upsertPreparedConnectorTokenState(
          {
            db,
            connectorId,
            method: args.runtimeMethod.method,
            orgId: args.orgId,
            userId: args.userId,
            state: args.connectorTokenState,
          },
          writeSignal,
        );
      },
    },
    signal,
  );
  if (
    ["auth-code", "external-code", "device-auth"].includes(
      args.runtimeMethod.method.grant.kind,
    )
  ) {
    await awardCompletedGetStartedQuest(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      questKey: "connector",
      sourceKey: `builtin:${args.runtimeMethod.connectorSlug}`,
    });
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

export const upsertConnectorTokenConnection$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runtimeMethod: ConnectorRuntimeMethod;
      readonly snapshot: ConnectorRuntimeSnapshot;
      readonly outputs: ConnectorTokenOutputValues;
      readonly userInfo: ExternalUserInfo;
      readonly oauthRequestedScopes: readonly string[];
      readonly oauthGrantedScopes: readonly string[];
      readonly expiresIn?: number;
      readonly extraConnectorSecrets?: Readonly<Record<string, string>>;
      readonly account: ConnectorAccountMutationIntent;
      readonly matchExistingExternalIdentity?: boolean;
      readonly insertConnectionId?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly status: "connected";
        readonly connector: ConnectorResponse;
        readonly created: boolean;
      }
    | ConnectorConnectionMutationFailure
    | { readonly status: "identityMismatch" }
  > => {
    const writeDb = set(writeDb$);
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

    let postCommitAbort: unknown = null;
    const connectionResult = await writeDb.transaction(async (tx) => {
      return await commitConnectorTokenConnection(
        {
          db: tx,
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
        },
        signal,
      );
    });
    if (signal.aborted) {
      postCommitAbort ??= signal.reason;
    }
    if (connectionResult.status !== "connected") {
      return connectionResult;
    }

    const automationCleanupAbort =
      await stopPendingGoogleCalendarAutomationCleanup(
        connectionResult.pendingGoogleCalendarWatchStop,
        signal,
      );
    postCommitAbort ??= automationCleanupAbort;

    await finalizeConnectorStateChangeAfterCommit(
      {
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
        pendingTokenRevoke: connectionResult.pendingTokenRevoke,
        postCommitAbort,
      },
      signal,
    );
    await reconcileAccountBoundAutomationWatches(
      writeDb,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.runtimeMethod.connectorSlug,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "connected",
      connector: storedConnectorRowToResponse(
        connectionResult.connectorRow,
        args.runtimeMethod,
        nowDate(),
      ),
      created: connectionResult.created,
    };
  },
);

export function connectorScopeDiff(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
  readonly selection: StoredConnectorSelection;
  readonly snapshot?: ConnectorRuntimeSnapshot;
}): Computed<Promise<ScopeDiffResponse | null>> {
  return computed(async (get): Promise<ScopeDiffResponse | null> => {
    const snapshot =
      args.snapshot ?? (await loadStoredConnectorRuntimeSnapshot(get(db$)));
    if (snapshot === null) {
      return null;
    }
    const connector = await get(
      storedConnector({
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.connectorSlug,
        snapshot,
        selection: args.selection,
      }),
    );
    return connector === null
      ? null
      : connectorAuthMethodScopeDiff(
          connector.runtimeMethod.method,
          connector.oauthRequestedScopes,
        );
  });
}

export function connectorSearch(args: {
  readonly orgId: string | undefined;
  readonly userId: string;
  readonly keyword: string | undefined;
}): Computed<Promise<ConnectorSearchItem[]>> {
  return computed(async (get) => {
    const overrides = args.orgId
      ? await get(userFeatureSwitchOverrides(args.orgId, args.userId))
      : {};
    const featureStates = getAllFeatureStates({
      userId: args.userId,
      orgId: args.orgId,
      overrides,
    });
    return searchConnectorCatalog({
      db: get(db$),
      keyword: args.keyword,
      featureStates,
    });
  });
}
