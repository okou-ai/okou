import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type {
  BuiltinConnectorExternalCodeSessionCompleteResponse,
  BuiltinConnectorExternalCodeSessionStartResponse,
  BuiltinConnectorResponse,
} from "@okouai/api-contracts/contracts/connector-schemas";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorAuthMethodIdSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorGrantScopes,
  resolveConnectorAuthClient,
  type ConnectorAuthClient,
} from "@okouai/connectors/connector-auth-method";
import {
  completeConnectorExternalCodeAuthorizationWithMethod,
  startConnectorExternalCodeAuthorizationWithMethod,
  type ConnectorAuthProviderGrantResult,
} from "@okouai/connectors/auth-providers";
import { isOAuthProviderHttpError } from "@okouai/connectors/auth-providers/oauth/error";
import { builtinConnectorExternalCodeSessions } from "@okouai/db/schema/connector-external-code-session";
import { command } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { onRejection, settle, throwIfAbort } from "../utils";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  parseBuiltinConnectorExternalCodeProviderState,
  serializeBuiltinConnectorExternalCodeProviderState,
} from "./connector-authorization-provider-state";
import {
  connectorActionResolver,
  type ConnectorActionMethodResolution,
  type ConnectorActionResolver,
  type ResolvedConnectorActionMethod,
} from "./connector-action-resolver.service";
import {
  builtinConnectorById,
  connectorConnectionWriteRejection,
  upsertBuiltinConnectorTokenConnection$,
} from "./connector-data.service";
import { resolveOAuthRequestedScopeSnapshot } from "./connector-oauth-scope-snapshot.service";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "./connected-connector-authorization.service";
import { storedConnectorAccountMutationSelection } from "./connector-account-mutation.service";
import { resolveConnectorConnectionMutation } from "./connector-connection-write.service";

const SUPERSEDABLE_EXTERNAL_CODE_SESSION_STATUSES = ["pending"] as const;
const SUPERSEDED_SESSION_ERROR_CODE = "session_superseded";
const SUPERSEDED_SESSION_ERROR_MESSAGE =
  "External-code authorization session was superseded";
const PROVIDER_STATE_MAX_BYTES = 16 * 1024;
const COMPLETING_SESSION_STALE_AFTER_MS = 30 * 60 * 1000;

const externalCodeSessionSelection = Object.freeze({
  id: builtinConnectorExternalCodeSessions.id,
  orgId: builtinConnectorExternalCodeSessions.orgId,
  userId: builtinConnectorExternalCodeSessions.userId,
  agentId: builtinConnectorExternalCodeSessions.agentId,
  authorizeAgent: builtinConnectorExternalCodeSessions.authorizeAgent,
  connectorSlug: builtinConnectorExternalCodeSessions.connectorSlug,
  authMethod: builtinConnectorExternalCodeSessions.authMethod,
  status: builtinConnectorExternalCodeSessions.status,
  sessionTokenHash: builtinConnectorExternalCodeSessions.sessionTokenHash,
  encryptedProviderState:
    builtinConnectorExternalCodeSessions.encryptedProviderState,
  accountMutation: storedConnectorAccountMutationSelection(
    builtinConnectorExternalCodeSessions.accountMutation,
  ),
  completedConnectorId:
    builtinConnectorExternalCodeSessions.completedConnectorId,
  authorizationUrl: builtinConnectorExternalCodeSessions.authorizationUrl,
  oauthRequestedScopes:
    builtinConnectorExternalCodeSessions.oauthRequestedScopes,
  errorCode: builtinConnectorExternalCodeSessions.errorCode,
  errorMessage: builtinConnectorExternalCodeSessions.errorMessage,
  createdAt: builtinConnectorExternalCodeSessions.createdAt,
  updatedAt: builtinConnectorExternalCodeSessions.updatedAt,
  expiresAt: builtinConnectorExternalCodeSessions.expiresAt,
  completedAt: builtinConnectorExternalCodeSessions.completedAt,
});

type BuiltinConnectorExternalCodeSessionRow =
  typeof builtinConnectorExternalCodeSessions.$inferSelect;

function externalCodeRequestedOauthScopes(
  storedScopes: string | null,
  resolvedMethod: ResolvedConnectorActionMethod,
): readonly string[] {
  return resolveOAuthRequestedScopeSnapshot(
    storedScopes,
    connectorGrantScopes(resolvedMethod.method.grant),
  );
}

type BuiltinConnectorExternalCodeSessionOwner = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly orgId: string;
  readonly userId: string;
};

type ResolvedBuiltinConnectorExternalCodeClient = {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly authClient: ConnectorAuthClient;
};

type CompleteSuccess = {
  readonly status: 200;
  readonly body: BuiltinConnectorExternalCodeSessionCompleteResponse;
};

const connectorExternalCodeDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "External-code authorization is not enabled for this connector",
      code: "FORBIDDEN",
    }),
  }),
});

function connectorExternalCodeUnavailable(connectorSlug: ConnectorSlug) {
  return {
    status: 403 as const,
    body: {
      error: {
        message: `${connectorSlug} connector is not available`,
        code: "FORBIDDEN",
      },
    },
  };
}

function externalCodeResolutionError(
  resolution: Exclude<ConnectorActionMethodResolution, { readonly ok: true }>,
  args: {
    readonly connectorSlug: ConnectorSlug;
    readonly authMethodId: ConnectorAuthMethodId;
  },
) {
  switch (resolution.reason) {
    case "unknown_connector": {
      return badRequestMessage(
        `${args.connectorSlug} connector is not supported`,
      );
    }
    case "unknown_auth_method": {
      const hasExternalCode = resolution.catalogConnector.authMethods.some(
        (method) => {
          return method.grantKind === "external-code";
        },
      );
      return badRequestMessage(
        hasExternalCode
          ? `${args.connectorSlug} connector does not have ${args.authMethodId} auth method`
          : connectorMissingExternalCodeGrantMessage(args.connectorSlug),
      );
    }
    case "wrong_grant_kind": {
      return badRequestMessage(
        `${args.connectorSlug} ${args.authMethodId} auth method does not use an external-code grant`,
      );
    }
    case "hidden_auth_method": {
      return connectorExternalCodeDisabled;
    }
    case "missing_executable_capability": {
      return connectorExternalCodeUnavailable(args.connectorSlug);
    }
  }
}

function internalServerError(message: string) {
  return {
    status: 500 as const,
    body: {
      error: {
        message,
        code: "INTERNAL_SERVER_ERROR",
      },
    },
  };
}

function sessionTokenHash(sessionToken: string): string {
  return createHash("sha256").update(sessionToken).digest("hex");
}

function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function connectorMissingExternalCodeGrantMessage(
  connectorSlug: string,
): string {
  return `${connectorSlug} connector does not support an external-code grant`;
}

function resolveRequiredAuthClient(
  resolvedMethod: ResolvedConnectorActionMethod,
):
  | ResolvedBuiltinConnectorExternalCodeClient
  | ReturnType<typeof internalServerError> {
  if (
    resolvedMethod.method.grant.kind !== "external-code" ||
    resolvedMethod.method.client === undefined
  ) {
    return internalServerError("Connector execution is not configured");
  }
  const authClient = resolveConnectorAuthClient(
    resolvedMethod.method.client,
    optionalEnv,
  );
  if (!authClient) {
    return internalServerError(
      `${resolvedMethod.connectorSlug} auth client not configured`,
    );
  }
  return { resolvedMethod, authClient };
}

async function resolveStoredExternalCodeMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: string;
}) {
  const storedAuthMethod = connectorAuthMethodIdSchema.safeParse(
    args.authMethodId,
  );
  if (!storedAuthMethod.success) {
    return internalServerError("Invalid external-code authorization session");
  }
  const resolved = await args.resolver.resolveMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: storedAuthMethod.data,
    expectedGrantKind: "external-code",
  });
  if (!resolved.ok) {
    return connectorExternalCodeUnavailable(args.connectorSlug);
  }
  return resolved;
}

async function lockExternalCodeSessionOwner(
  args: BuiltinConnectorExternalCodeSessionOwner & {
    readonly writeDb: Db;
  },
): Promise<void> {
  await args.writeDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('connector_external_code:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.connectorSlug} || ':' || ${args.authMethod}))`,
  );
}

async function markPendingSessionsSuperseded(
  args: BuiltinConnectorExternalCodeSessionOwner & {
    readonly writeDb: Db;
    readonly now: Date;
  },
): Promise<void> {
  await args.writeDb
    .update(builtinConnectorExternalCodeSessions)
    .set({
      status: "error",
      errorCode: SUPERSEDED_SESSION_ERROR_CODE,
      errorMessage: SUPERSEDED_SESSION_ERROR_MESSAGE,
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.orgId, args.orgId),
        eq(builtinConnectorExternalCodeSessions.userId, args.userId),
        eq(
          builtinConnectorExternalCodeSessions.connectorSlug,
          args.connectorSlug,
        ),
        eq(builtinConnectorExternalCodeSessions.authMethod, args.authMethod),
        inArray(builtinConnectorExternalCodeSessions.status, [
          ...SUPERSEDABLE_EXTERNAL_CODE_SESSION_STATUSES,
        ]),
      ),
    );
}

async function loadOwnedSession(
  args: {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: ConnectorSlug;
    readonly sessionId: string;
    readonly sessionToken: string;
  },
  signal: AbortSignal,
): Promise<BuiltinConnectorExternalCodeSessionRow | null> {
  const [session] = await args.writeDb
    .select(externalCodeSessionSelection)
    .from(builtinConnectorExternalCodeSessions)
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.id, args.sessionId),
        eq(builtinConnectorExternalCodeSessions.orgId, args.orgId),
        eq(builtinConnectorExternalCodeSessions.userId, args.userId),
        eq(
          builtinConnectorExternalCodeSessions.connectorSlug,
          args.connectorSlug,
        ),
        eq(
          builtinConnectorExternalCodeSessions.sessionTokenHash,
          sessionTokenHash(args.sessionToken),
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return session ?? null;
}

async function parseEncryptedProviderState(args: {
  readonly session: BuiltinConnectorExternalCodeSessionRow;
  readonly method: ResolvedConnectorActionMethod;
}): Promise<string> {
  const decrypted = await decryptPersistentSecretValue(
    args.session.encryptedProviderState,
    {
      orgId: args.session.orgId,
      userId: args.session.userId,
    },
  );
  return parseBuiltinConnectorExternalCodeProviderState({
    serializedState: decrypted,
    connectorSlug: args.method.connectorSlug,
    authMethod: args.method.authMethodId,
  }).providerState;
}

async function expireSession(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly now: Date;
  },
  signal: AbortSignal,
): Promise<ReturnType<typeof badRequestMessage>> {
  await args.writeDb
    .update(builtinConnectorExternalCodeSessions)
    .set({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "External-code authorization session expired",
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.id, args.session.id),
        or(
          eq(builtinConnectorExternalCodeSessions.status, "pending"),
          eq(builtinConnectorExternalCodeSessions.status, "completing"),
        ),
      ),
    );
  signal.throwIfAborted();
  return badRequestMessage("External-code authorization session expired");
}

function isSessionExpired(
  session: BuiltinConnectorExternalCodeSessionRow,
  now: Date,
): boolean {
  return now > session.expiresAt;
}

function isCompletingSessionStale(
  session: BuiltinConnectorExternalCodeSessionRow,
  now: Date,
): boolean {
  return (
    now.getTime() - session.updatedAt.getTime() >
    COMPLETING_SESSION_STALE_AFTER_MS
  );
}

async function claimSession(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly claimStartedAt: Date;
  },
  signal: AbortSignal,
): Promise<BuiltinConnectorExternalCodeSessionRow | null> {
  const [claimedSession] = await args.writeDb
    .update(builtinConnectorExternalCodeSessions)
    .set({ status: "completing", updatedAt: args.claimStartedAt })
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.id, args.session.id),
        eq(builtinConnectorExternalCodeSessions.status, "pending"),
      ),
    )
    .returning(externalCodeSessionSelection);
  signal.throwIfAborted();
  return claimedSession ?? null;
}

async function claimStillCurrent(
  args: {
    readonly writeDb: Db;
    readonly sessionId: string;
    readonly claimStartedAt: Date;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [currentClaim] = await args.writeDb
    .select({
      status: builtinConnectorExternalCodeSessions.status,
      updatedAt: builtinConnectorExternalCodeSessions.updatedAt,
    })
    .from(builtinConnectorExternalCodeSessions)
    .where(eq(builtinConnectorExternalCodeSessions.id, args.sessionId))
    .limit(1);
  signal.throwIfAborted();

  return (
    currentClaim?.status === "completing" &&
    currentClaim.updatedAt.getTime() === args.claimStartedAt.getTime()
  );
}

async function markClaimPending(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly errorMessage?: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await args.writeDb
    .update(builtinConnectorExternalCodeSessions)
    .set({
      status: "pending",
      errorCode: args.errorMessage ? "provider_rejected" : null,
      errorMessage: args.errorMessage ?? null,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.id, args.session.id),
        eq(builtinConnectorExternalCodeSessions.status, "completing"),
        eq(builtinConnectorExternalCodeSessions.updatedAt, args.claimStartedAt),
      ),
    );
  signal.throwIfAborted();
}

async function markClaimError(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly errorMessage: string;
  },
  signal: AbortSignal,
): Promise<void> {
  const completedAt = nowDate();
  await args.writeDb
    .update(builtinConnectorExternalCodeSessions)
    .set({
      status: "error",
      errorCode: "complete_failed",
      errorMessage: args.errorMessage,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.id, args.session.id),
        eq(builtinConnectorExternalCodeSessions.status, "completing"),
        eq(builtinConnectorExternalCodeSessions.updatedAt, args.claimStartedAt),
      ),
    );
  signal.throwIfAborted();
}

async function markClaimComplete(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly connector: BuiltinConnectorResponse;
  },
  signal: AbortSignal,
): Promise<CompleteSuccess> {
  const completedAt = nowDate();
  const [completedSession] = await args.writeDb
    .update(builtinConnectorExternalCodeSessions)
    .set({
      status: "complete",
      completedConnectorId: args.connector.id,
      errorCode: null,
      errorMessage: null,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(builtinConnectorExternalCodeSessions.id, args.session.id),
        eq(builtinConnectorExternalCodeSessions.status, "completing"),
        eq(builtinConnectorExternalCodeSessions.updatedAt, args.claimStartedAt),
      ),
    )
    .returning({ id: builtinConnectorExternalCodeSessions.id });
  signal.throwIfAborted();

  if (!completedSession) {
    throw new Error("External-code authorization session is no longer active");
  }
  return {
    status: 200,
    body: { status: "complete", connector: args.connector },
  };
}

async function persistClaimedConnector(
  args: BuiltinConnectorExternalCodeSessionOwner & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly token: ConnectorAuthProviderGrantResult;
    readonly persistConnector: (
      args: { readonly token: ConnectorAuthProviderGrantResult },
      signal: AbortSignal,
    ) => Promise<
      | { readonly ok: true; readonly connector: BuiltinConnectorResponse }
      | { readonly ok: false; readonly message: string }
    >;
  },
  signal: AbortSignal,
): Promise<CompleteSuccess | ReturnType<typeof conflict>> {
  return await args.writeDb.transaction(async (tx) => {
    await lockExternalCodeSessionOwner({
      ...args,
      writeDb: tx,
    });
    if (
      !(await claimStillCurrent(
        {
          writeDb: tx,
          sessionId: args.session.id,
          claimStartedAt: args.claimStartedAt,
        },
        signal,
      ))
    ) {
      throw new Error(
        "External-code authorization session is no longer active",
      );
    }

    const persisted = await args.persistConnector(
      { token: args.token },
      signal,
    );
    signal.throwIfAborted();
    if (!persisted.ok) {
      await markClaimError(
        {
          writeDb: tx,
          session: args.session,
          claimStartedAt: args.claimStartedAt,
          errorMessage: persisted.message,
        },
        signal,
      );
      return conflict(persisted.message);
    }

    return await markClaimComplete(
      {
        writeDb: tx,
        session: args.session,
        claimStartedAt: args.claimStartedAt,
        connector: persisted.connector,
      },
      signal,
    );
  });
}

function terminalErrorResponse(
  session: BuiltinConnectorExternalCodeSessionRow,
) {
  switch (session.status) {
    case "expired": {
      return badRequestMessage(
        session.errorMessage ?? "External-code authorization session expired",
      );
    }
    case "error": {
      return badRequestMessage(
        session.errorMessage ?? "External-code authorization session failed",
      );
    }
    case "complete":
    case "pending":
    case "completing": {
      return null;
    }
  }
}

async function completeSessionResponse(
  args: {
    readonly connectorLoader: () => Promise<BuiltinConnectorResponse | null>;
  },
  signal: AbortSignal,
): Promise<CompleteSuccess> {
  const connector = await args.connectorLoader();
  signal.throwIfAborted();
  if (!connector) {
    throw new Error("Completed external-code connector not found");
  }
  return { status: 200, body: { status: "complete", connector } };
}

const authorizeExternalCodeSessionConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: BuiltinConnectorExternalCodeSessionRow;
      readonly connectorSlug: ConnectorSlug;
    },
    signal: AbortSignal,
  ) => {
    if (!args.session.authorizeAgent) {
      return null;
    }
    const authorization = await set(
      authorizeConnectedConnector$,
      {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.session.agentId,
        connectorSlug: args.connectorSlug,
      },
      signal,
    );
    return authorization.status === "agentNotFound"
      ? badRequestMessage(authorization.message)
      : null;
  },
);

const completedExternalCodeSessionResponse$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: BuiltinConnectorExternalCodeSessionRow;
      readonly method: ResolvedConnectorActionMethod;
    },
    signal: AbortSignal,
  ) => {
    const response = await completeSessionResponse(
      {
        connectorLoader: () => {
          if (!args.session.completedConnectorId) {
            throw new Error(
              "Completed external-code session is missing its connector ID",
            );
          }
          return get(
            builtinConnectorById({
              orgId: args.orgId,
              userId: args.userId,
              connectorSlug: args.method.connectorSlug,
              connectorId: args.session.completedConnectorId,
              snapshot: args.method.snapshot,
            }),
          );
        },
      },
      signal,
    );
    const error = await set(
      authorizeExternalCodeSessionConnector$,
      { ...args, connectorSlug: args.method.connectorSlug },
      signal,
    );
    return error ?? response;
  },
);

async function completeClaimedExternalCodeSession(
  args: ResolvedBuiltinConnectorExternalCodeClient & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly code: string;
    readonly session: BuiltinConnectorExternalCodeSessionRow;
    readonly claimStartedAt: Date;
    readonly persistConnector: (
      args: { readonly token: ConnectorAuthProviderGrantResult },
      signal: AbortSignal,
    ) => Promise<
      | { readonly ok: true; readonly connector: BuiltinConnectorResponse }
      | { readonly ok: false; readonly message: string }
    >;
  },
  signal: AbortSignal,
) {
  const providerResult = await settle(
    (async () => {
      const providerState = await parseEncryptedProviderState({
        session: args.session,
        method: args.resolvedMethod,
      });
      return await completeConnectorExternalCodeAuthorizationWithMethod(
        {
          connectorSlug: args.resolvedMethod.connectorSlug,
          authMethodId: args.resolvedMethod.authMethodId,
          method: args.resolvedMethod.method,
          authorizationScopes: externalCodeRequestedOauthScopes(
            args.session.oauthRequestedScopes,
            args.resolvedMethod,
          ),
          authClient: args.authClient,
          code: args.code,
          providerState,
        },
        signal,
      );
    })(),
    signal,
  );
  if (!providerResult.ok) {
    if (shouldRestorePendingAfterProviderError(providerResult.error)) {
      await markClaimPending(
        {
          writeDb: args.writeDb,
          session: args.session,
          claimStartedAt: args.claimStartedAt,
          errorMessage: errorMessage(providerResult.error),
        },
        signal,
      );
      const badRequest = providerBadRequest(providerResult.error);
      if (badRequest) {
        return badRequest;
      }
    } else {
      await markClaimError(
        {
          writeDb: args.writeDb,
          session: args.session,
          claimStartedAt: args.claimStartedAt,
          errorMessage: errorMessage(providerResult.error),
        },
        signal,
      );
    }
    throw providerResult.error;
  }

  // The provider code may already be consumed; finish DB commit even if the
  // client disconnects after provider success.
  const commitSignal = new AbortController().signal;
  const persistedConnector = await onRejection(
    persistClaimedConnector(
      {
        connectorSlug: args.resolvedMethod.connectorSlug,
        authMethod: args.resolvedMethod.authMethodId,
        writeDb: args.writeDb,
        orgId: args.orgId,
        userId: args.userId,
        session: args.session,
        claimStartedAt: args.claimStartedAt,
        persistConnector: args.persistConnector,
        token: providerResult.value,
      },
      commitSignal,
    ),
    async (error) => {
      throwIfAbort(error);
      await markClaimError(
        {
          writeDb: args.writeDb,
          session: args.session,
          claimStartedAt: args.claimStartedAt,
          errorMessage: errorMessage(error),
        },
        commitSignal,
      );
    },
  );
  return persistedConnector;
}

function providerBadRequest(error: unknown) {
  if (
    isOAuthProviderHttpError(error) &&
    (error.oauthError === "invalid_grant" ||
      (error.status >= 400 && error.status < 500 && error.status !== 429))
  ) {
    return badRequestMessage(
      "External-code authorization code was rejected. Check it and try again.",
    );
  }
  return null;
}

function shouldRestorePendingAfterProviderError(error: unknown): boolean {
  return isOAuthProviderHttpError(error);
}

function providerStateWithinLimit(providerState: string): string {
  if (Buffer.byteLength(providerState, "utf8") > PROVIDER_STATE_MAX_BYTES) {
    throw new Error(
      `External-code provider state exceeds ${PROVIDER_STATE_MAX_BYTES} bytes`,
    );
  }
  return providerState;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "External-code completion failed";
}

async function createExternalCodeSession(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string | undefined;
    readonly authorizeAgent: true | undefined;
    readonly connectorSlug: ConnectorSlug;
    readonly authMethod: ConnectorAuthMethodId;
    readonly account: ConnectorAccountMutationIntent;
    readonly sessionToken: string;
    readonly encryptedProviderState: string;
    readonly authorizationUrl: string;
    readonly oauthRequestedScopes: readonly string[];
    readonly now: Date;
    readonly expiresAt: Date;
  },
  signal: AbortSignal,
) {
  return await db.transaction(async (tx) => {
    await lockExternalCodeSessionOwner({
      connectorSlug: args.connectorSlug,
      authMethod: args.authMethod,
      writeDb: tx,
      orgId: args.orgId,
      userId: args.userId,
    });
    const mutationResolution = await resolveConnectorConnectionMutation(tx, {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "builtin", connectorSlug: args.connectorSlug },
      mutation: args.account,
      allowSiblings: true,
    });
    signal.throwIfAborted();
    if (mutationResolution.kind !== "ready") {
      return mutationResolution;
    }
    await markPendingSessionsSuperseded({
      connectorSlug: args.connectorSlug,
      authMethod: args.authMethod,
      writeDb: tx,
      orgId: args.orgId,
      userId: args.userId,
      now: args.now,
    });
    const [session] = await tx
      .insert(builtinConnectorExternalCodeSessions)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
        authorizeAgent: connectorAgentAuthorizationRequested(args),
        connectorSlug: args.connectorSlug,
        authMethod: args.authMethod,
        status: "pending",
        sessionTokenHash: sessionTokenHash(args.sessionToken),
        encryptedProviderState: args.encryptedProviderState,
        accountMutation: args.account,
        authorizationUrl: args.authorizationUrl,
        oauthRequestedScopes: JSON.stringify(args.oauthRequestedScopes),
        createdAt: args.now,
        updatedAt: args.now,
        expiresAt: args.expiresAt,
      })
      .returning({ id: builtinConnectorExternalCodeSessions.id });
    if (!session) {
      throw new Error("Failed to create external-code authorization session");
    }
    return { kind: "created" as const, session };
  });
}

export const startBuiltinConnectorExternalCodeSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | undefined;
      readonly authorizeAgent: true | undefined;
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly account: ConnectorAccountMutationIntent;
    },
    signal: AbortSignal,
  ) => {
    const agentTarget = await set(
      validateConnectorAuthorizationTarget$,
      args,
      signal,
    );
    if (!agentTarget.ok) {
      return badRequestMessage(agentTarget.message);
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolved = await resolver.resolveNewActionMethod({
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethod,
      expectedGrantKind: "external-code",
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return externalCodeResolutionError(resolved, {
        connectorSlug: args.connectorSlug,
        authMethodId: args.authMethod,
      });
    }
    const resolvedClient = resolveRequiredAuthClient(resolved);
    if ("status" in resolvedClient) {
      return resolvedClient;
    }

    const startResult = await startConnectorExternalCodeAuthorizationWithMethod(
      {
        connectorSlug: resolved.connectorSlug,
        authMethodId: resolved.authMethodId,
        method: resolved.method,
        authClient: resolvedClient.authClient,
      },
    );
    signal.throwIfAborted();

    const sessionToken = generateSessionToken();
    const now = nowDate();
    const expiresAt = new Date(now.getTime() + startResult.expiresIn * 1000);
    const encryptedProviderState = await encryptPersistentSecretValue(
      serializeBuiltinConnectorExternalCodeProviderState({
        connectorSlug: resolved.connectorSlug,
        authMethod: resolved.authMethodId,
        providerState: providerStateWithinLimit(startResult.providerState),
      }),
      {
        orgId: args.orgId,
        userId: args.userId,
      },
    );
    signal.throwIfAborted();

    const sessionResult = await createExternalCodeSession(
      set(writeDb$),
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: resolved.connectorSlug,
        authMethod: resolved.authMethodId,
        agentId: args.agentId,
        authorizeAgent: args.authorizeAgent,
        account: args.account,
        sessionToken,
        encryptedProviderState,
        authorizationUrl: startResult.authorizationUrl,
        oauthRequestedScopes: connectorGrantScopes(resolved.method.grant),
        now,
        expiresAt,
      },
      signal,
    );
    signal.throwIfAborted();

    if (sessionResult.kind !== "created") {
      return sessionResult.kind === "missing"
        ? notFound("Connector account not found")
        : conflict(
            sessionResult.kind === "ambiguous"
              ? "Multiple connector accounts require an exact choice"
              : "This connector does not support additional accounts",
          );
    }

    const body: BuiltinConnectorExternalCodeSessionStartResponse = {
      sessionId: sessionResult.session.id,
      sessionToken,
      connectorSlug: resolved.connectorSlug,
      status: "pending",
      authorizationUrl: startResult.authorizationUrl,
      expiresIn: startResult.expiresIn,
    };
    return { status: 200 as const, body };
  },
);

const persistExternalCodeConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
      readonly oauthRequestedScopes: string | null;
      readonly account: ConnectorAccountMutationIntent;
      readonly token: ConnectorAuthProviderGrantResult;
    },
    signal: AbortSignal,
  ) => {
    const connectorResult = await set(
      upsertBuiltinConnectorTokenConnection$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runtimeMethod: args.resolvedMethod.runtimeMethod,
        snapshot: args.resolvedMethod.snapshot,
        outputs: args.token.outputs,
        userInfo: args.token.userInfo,
        oauthRequestedScopes: externalCodeRequestedOauthScopes(
          args.oauthRequestedScopes,
          args.resolvedMethod,
        ),
        oauthGrantedScopes: args.token.scopes,
        expiresIn: args.token.expiresIn,
        extraConnectorSecrets: args.token.extraConnectorSecrets,
        account: args.account,
      },
      signal,
    );
    if (connectorResult.status !== "connected") {
      return connectorConnectionWriteRejection(connectorResult.status);
    }
    return { ok: true as const, connector: connectorResult.connector };
  },
);

export const completeBuiltinConnectorExternalCodeSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: ConnectorSlug;
      readonly sessionId: string;
      readonly sessionToken: string;
      readonly code: string;
    },
    signal: AbortSignal,
  ) => {
    const writeDb = set(writeDb$);
    const session = await loadOwnedSession(
      {
        writeDb,
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.connectorSlug,
        sessionId: args.sessionId,
        sessionToken: args.sessionToken,
      },
      signal,
    );
    if (!session) {
      return notFound("External-code authorization session not found");
    }
    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolveStoredExternalCodeMethod({
      resolver,
      connectorSlug: args.connectorSlug,
      authMethodId: session.authMethod,
    });
    signal.throwIfAborted();
    if ("status" in resolvedMethod) {
      return resolvedMethod;
    }
    const resolvedClient = resolveRequiredAuthClient(resolvedMethod);
    if ("status" in resolvedClient) {
      return resolvedClient;
    }

    if (session.status === "complete") {
      return await set(
        completedExternalCodeSessionResponse$,
        { ...args, session, method: resolvedMethod },
        signal,
      );
    }

    const terminal = terminalErrorResponse(session);
    if (terminal) {
      return terminal;
    }

    const now = nowDate();
    if (session.status === "completing") {
      if (
        isSessionExpired(session, now) &&
        isCompletingSessionStale(session, now)
      ) {
        return await expireSession({ writeDb, session, now }, signal);
      }
      return badRequestMessage(
        "External-code authorization session is already completing",
      );
    }
    if (isSessionExpired(session, now)) {
      return await expireSession({ writeDb, session, now }, signal);
    }

    const claimStartedAt = now;
    const claimedSession = await claimSession(
      {
        writeDb,
        session,
        claimStartedAt,
      },
      signal,
    );
    if (!claimedSession) {
      return badRequestMessage(
        "External-code authorization session is no longer active",
      );
    }

    const response = await completeClaimedExternalCodeSession(
      {
        ...resolvedClient,
        writeDb,
        orgId: args.orgId,
        userId: args.userId,
        code: args.code,
        session: claimedSession,
        claimStartedAt,
        persistConnector: async ({ token }, persistSignal: AbortSignal) => {
          return await set(
            persistExternalCodeConnector$,
            {
              orgId: args.orgId,
              userId: args.userId,
              resolvedMethod,
              oauthRequestedScopes: claimedSession.oauthRequestedScopes,
              account: claimedSession.accountMutation,
              token,
            },
            persistSignal,
          );
        },
      },
      signal,
    );
    if (response.status !== 200) {
      return response;
    }
    const authorizationError = await set(
      authorizeExternalCodeSessionConnector$,
      { ...args, session, connectorSlug: resolvedMethod.connectorSlug },
      signal,
    );
    return authorizationError ?? response;
  },
);
