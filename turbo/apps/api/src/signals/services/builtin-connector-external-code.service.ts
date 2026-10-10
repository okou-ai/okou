import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type {
  BuiltinConnectorExternalCodeSessionCompleteResponse,
  BuiltinConnectorExternalCodeSessionStartResponse,
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
import { connectors } from "@okouai/db/schema/connector";
import { command } from "ccstate";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
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

const SUPERSEDABLE_EXTERNAL_CODE_SESSION_STATUSES = ["pending"] as const;
const SUPERSEDED_SESSION_ERROR_CODE = "session_superseded";
const SUPERSEDED_SESSION_ERROR_MESSAGE =
  "External-code authorization session was superseded";
const PROVIDER_STATE_MAX_BYTES = 16 * 1024;
const COMPLETING_SESSION_STALE_AFTER_MS = 30 * 60 * 1000;
const createdExternalCodeSessionSchema = z.object({ id: z.uuid() });

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

const expireExternalCodeSession$ = command(
  async (
    { set },
    args: {
      readonly session: BuiltinConnectorExternalCodeSessionRow;
      readonly now: Date;
    },
    signal: AbortSignal,
  ): Promise<ReturnType<typeof badRequestMessage>> => {
    const writeDb = set(writeDb$);
    await writeDb
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
  },
);

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

const markExternalCodeClaimError$ = command(
  async (
    { set },
    args: {
      readonly sessionId: string;
      readonly claimStartedAt: Date;
      readonly errorMessage: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const completedAt = nowDate();
    const writeDb = set(writeDb$);
    await writeDb
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
          eq(builtinConnectorExternalCodeSessions.id, args.sessionId),
          eq(builtinConnectorExternalCodeSessions.status, "completing"),
          eq(
            builtinConnectorExternalCodeSessions.updatedAt,
            args.claimStartedAt,
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

const persistClaimedExternalCodeConnector$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly resolvedMethod: ResolvedConnectorActionMethod;
      readonly session: BuiltinConnectorExternalCodeSessionRow;
      readonly claimStartedAt: Date;
      readonly token: ConnectorAuthProviderGrantResult;
    },
    signal: AbortSignal,
  ): Promise<CompleteSuccess | ReturnType<typeof conflict>> => {
    const [currentClaim] = await get(db$)
      .select({
        status: builtinConnectorExternalCodeSessions.status,
        updatedAt: builtinConnectorExternalCodeSessions.updatedAt,
      })
      .from(builtinConnectorExternalCodeSessions)
      .where(eq(builtinConnectorExternalCodeSessions.id, args.session.id))
      .limit(1);
    signal.throwIfAborted();
    if (
      currentClaim?.status !== "completing" ||
      currentClaim.updatedAt.getTime() !== args.claimStartedAt.getTime()
    ) {
      throw new Error(
        "External-code authorization session is no longer active",
      );
    }

    const persisted = await set(
      persistExternalCodeConnector$,
      {
        orgId: args.orgId,
        userId: args.userId,
        resolvedMethod: args.resolvedMethod,
        oauthRequestedScopes: args.session.oauthRequestedScopes,
        account: args.session.accountMutation,
        token: args.token,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!persisted.ok) {
      await set(
        markExternalCodeClaimError$,
        {
          sessionId: args.session.id,
          claimStartedAt: args.claimStartedAt,
          errorMessage: persisted.message,
        },
        signal,
      );
      return conflict(persisted.message);
    }

    const completedAt = nowDate();
    const writeDb = set(writeDb$);
    const [completedSession] = await writeDb
      .update(builtinConnectorExternalCodeSessions)
      .set({
        status: "complete",
        completedConnectorId: persisted.connector.id,
        errorCode: null,
        errorMessage: null,
        updatedAt: completedAt,
        completedAt,
      })
      .where(
        and(
          eq(builtinConnectorExternalCodeSessions.id, args.session.id),
          eq(builtinConnectorExternalCodeSessions.status, "completing"),
          eq(
            builtinConnectorExternalCodeSessions.updatedAt,
            args.claimStartedAt,
          ),
        ),
      )
      .returning({ id: builtinConnectorExternalCodeSessions.id });
    signal.throwIfAborted();
    if (!completedSession) {
      throw new Error(
        "External-code authorization session is no longer active",
      );
    }
    return {
      status: 200,
      body: { status: "complete", connector: persisted.connector },
    };
  },
);

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
  ): Promise<CompleteSuccess | ReturnType<typeof badRequestMessage>> => {
    if (!args.session.completedConnectorId) {
      throw new Error(
        "Completed external-code session is missing its connector ID",
      );
    }
    const connector = await get(
      builtinConnectorById({
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: args.method.connectorSlug,
        connectorId: args.session.completedConnectorId,
        snapshot: args.method.snapshot,
      }),
    );
    signal.throwIfAborted();
    if (!connector) {
      throw new Error("Completed external-code connector not found");
    }
    const error = await set(
      authorizeExternalCodeSessionConnector$,
      { ...args, connectorSlug: args.method.connectorSlug },
      signal,
    );
    return error ?? { status: 200, body: { status: "complete", connector } };
  },
);

const completeClaimedExternalCodeSession$ = command(
  async (
    { set },
    args: ResolvedBuiltinConnectorExternalCodeClient & {
      readonly orgId: string;
      readonly userId: string;
      readonly code: string;
      readonly session: BuiltinConnectorExternalCodeSessionRow;
      readonly claimStartedAt: Date;
    },
    signal: AbortSignal,
  ) => {
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
        const message = errorMessage(providerResult.error);
        const writeDb = set(writeDb$);
        await writeDb
          .update(builtinConnectorExternalCodeSessions)
          .set({
            status: "pending",
            errorCode: message ? "provider_rejected" : null,
            errorMessage: message,
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(builtinConnectorExternalCodeSessions.id, args.session.id),
              eq(builtinConnectorExternalCodeSessions.status, "completing"),
              eq(
                builtinConnectorExternalCodeSessions.updatedAt,
                args.claimStartedAt,
              ),
            ),
          );
        signal.throwIfAborted();
        const badRequest = providerBadRequest(providerResult.error);
        if (badRequest) {
          return badRequest;
        }
      } else {
        await set(
          markExternalCodeClaimError$,
          {
            sessionId: args.session.id,
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
    return await onRejection(
      set(
        persistClaimedExternalCodeConnector$,
        {
          orgId: args.orgId,
          userId: args.userId,
          resolvedMethod: args.resolvedMethod,
          session: args.session,
          claimStartedAt: args.claimStartedAt,
          token: providerResult.value,
        },
        commitSignal,
      ),
      async (error) => {
        throwIfAbort(error);
        await set(
          markExternalCodeClaimError$,
          {
            sessionId: args.session.id,
            claimStartedAt: args.claimStartedAt,
            errorMessage: errorMessage(error),
          },
          commitSignal,
        );
      },
    );
  },
);

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

const createExternalCodeSession$ = command(
  async (
    { set },
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
  ) => {
    const writeDb = set(writeDb$);
    if (args.account.intent === "reconnect") {
      const [existing] = await writeDb
        .select({ id: connectors.id })
        .from(connectors)
        .where(
          and(
            eq(connectors.id, args.account.connectionId),
            eq(connectors.orgId, args.orgId),
            eq(connectors.userId, args.userId),
            eq(connectors.connectorSlug, args.connectorSlug),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!existing) {
        return { kind: "missing" as const };
      }
    }

    const createSession = writeDb
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
    const supersedePendingSessions = writeDb
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
          ne(
            builtinConnectorExternalCodeSessions.id,
            sql`(SELECT id FROM created_external_code_session)`,
          ),
        ),
      );
    const [session] = parseRawRows(
      createdExternalCodeSessionSchema,
      await writeDb.execute(sql`
        WITH created_external_code_session AS (
          ${createSession.getSQL()}
        ), superseded_external_code_sessions AS (
          ${supersedePendingSessions.getSQL()}
        )
        SELECT id FROM created_external_code_session
      `),
    );
    signal.throwIfAborted();
    if (!session) {
      throw new Error("Failed to create external-code authorization session");
    }
    return { kind: "created" as const, session };
  },
);

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

    const resolver = await get(connectorActionResolver([args.connectorSlug]));
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

    const sessionResult = await set(
      createExternalCodeSession$,
      {
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
        authorizeAgent: args.authorizeAgent,
        connectorSlug: resolved.connectorSlug,
        authMethod: resolved.authMethodId,
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
    if (sessionResult.kind === "missing") {
      return notFound("Connector account not found");
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
    const { orgId, userId, connectorSlug, sessionId, sessionToken } = args;
    const [session] = await get(db$)
      .select(externalCodeSessionSelection)
      .from(builtinConnectorExternalCodeSessions)
      .where(
        and(
          eq(builtinConnectorExternalCodeSessions.id, sessionId),
          eq(builtinConnectorExternalCodeSessions.orgId, orgId),
          eq(builtinConnectorExternalCodeSessions.userId, userId),
          eq(builtinConnectorExternalCodeSessions.connectorSlug, connectorSlug),
          eq(
            builtinConnectorExternalCodeSessions.sessionTokenHash,
            sessionTokenHash(sessionToken),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!session) {
      return notFound("External-code authorization session not found");
    }
    const resolver = await get(connectorActionResolver([args.connectorSlug]));
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
        return await set(expireExternalCodeSession$, { session, now }, signal);
      }
      return badRequestMessage(
        "External-code authorization session is already completing",
      );
    }
    if (isSessionExpired(session, now)) {
      return await set(expireExternalCodeSession$, { session, now }, signal);
    }

    const claimStartedAt = now;
    const [claimedSession] = await writeDb
      .update(builtinConnectorExternalCodeSessions)
      .set({ status: "completing", updatedAt: claimStartedAt })
      .where(
        and(
          eq(builtinConnectorExternalCodeSessions.id, session.id),
          eq(builtinConnectorExternalCodeSessions.status, "pending"),
        ),
      )
      .returning(externalCodeSessionSelection);
    signal.throwIfAborted();
    if (!claimedSession) {
      return badRequestMessage(
        "External-code authorization session is no longer active",
      );
    }

    const response = await set(
      completeClaimedExternalCodeSession$,
      {
        ...resolvedClient,
        orgId: args.orgId,
        userId: args.userId,
        code: args.code,
        session: claimedSession,
        claimStartedAt,
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
