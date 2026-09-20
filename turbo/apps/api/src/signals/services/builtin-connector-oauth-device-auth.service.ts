import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type {
  BuiltinConnectorResponse,
  BuiltinConnectorOauthDeviceAuthSessionPollResponse,
  BuiltinConnectorOauthDeviceAuthSessionStartResponse,
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
  pollConnectorDeviceAuthorizationWithMethod,
  startConnectorDeviceAuthorizationWithMethod,
} from "@okouai/connectors/auth-providers";
import type {
  OAuthDeviceAuthCompleteResultBase,
  OAuthDeviceAuthPollResultBase,
} from "@okouai/connectors/auth-providers/provider-flow-types";
import { builtinConnectorOauthDeviceAuthorizationSessions } from "@okouai/db/schema/connector-oauth-device-authorization-session";
import { command } from "ccstate";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";

import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  parseBuiltinConnectorOauthDeviceProviderState,
  serializeBuiltinConnectorOauthDeviceProviderState,
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
import { normalizeDeviceAuthStartOptionsWithMethod } from "./connector-catalog-form-fields.service";
import {
  authorizeConnectedConnector$,
  connectorAgentAuthorizationRequested,
  validateConnectorAuthorizationTarget$,
} from "./connected-connector-authorization.service";
import { storedConnectorAccountMutationSelection } from "./connector-account-mutation.service";
import { resolveConnectorConnectionMutation } from "./connector-connection-write.service";

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const POLLING_STALE_MS = 30_000;
const ACTIVE_DEVICE_AUTHORIZATION_SESSION_STATUSES = [
  "awaiting_user_authorization",
  "polling",
] as const;
const SUPERSEDED_SESSION_ERROR_CODE = "session_superseded";
const SUPERSEDED_SESSION_ERROR_MESSAGE =
  "OAuth device authorization session was superseded";

const deviceAuthSessionSelection = Object.freeze({
  id: builtinConnectorOauthDeviceAuthorizationSessions.id,
  orgId: builtinConnectorOauthDeviceAuthorizationSessions.orgId,
  userId: builtinConnectorOauthDeviceAuthorizationSessions.userId,
  agentId: builtinConnectorOauthDeviceAuthorizationSessions.agentId,
  authorizeAgent:
    builtinConnectorOauthDeviceAuthorizationSessions.authorizeAgent,
  connectorSlug: builtinConnectorOauthDeviceAuthorizationSessions.connectorSlug,
  authMethod: builtinConnectorOauthDeviceAuthorizationSessions.authMethod,
  status: builtinConnectorOauthDeviceAuthorizationSessions.status,
  sessionTokenHash:
    builtinConnectorOauthDeviceAuthorizationSessions.sessionTokenHash,
  encryptedProviderState:
    builtinConnectorOauthDeviceAuthorizationSessions.encryptedProviderState,
  accountMutation: storedConnectorAccountMutationSelection(
    builtinConnectorOauthDeviceAuthorizationSessions.accountMutation,
  ),
  completedConnectorId:
    builtinConnectorOauthDeviceAuthorizationSessions.completedConnectorId,
  oauthRequestedScopes:
    builtinConnectorOauthDeviceAuthorizationSessions.oauthRequestedScopes,
  userCode: builtinConnectorOauthDeviceAuthorizationSessions.userCode,
  verificationUri:
    builtinConnectorOauthDeviceAuthorizationSessions.verificationUri,
  verificationUriComplete:
    builtinConnectorOauthDeviceAuthorizationSessions.verificationUriComplete,
  intervalSeconds:
    builtinConnectorOauthDeviceAuthorizationSessions.intervalSeconds,
  errorCode: builtinConnectorOauthDeviceAuthorizationSessions.errorCode,
  errorMessage: builtinConnectorOauthDeviceAuthorizationSessions.errorMessage,
  createdAt: builtinConnectorOauthDeviceAuthorizationSessions.createdAt,
  updatedAt: builtinConnectorOauthDeviceAuthorizationSessions.updatedAt,
  expiresAt: builtinConnectorOauthDeviceAuthorizationSessions.expiresAt,
  completedAt: builtinConnectorOauthDeviceAuthorizationSessions.completedAt,
});

type BuiltinConnectorDeviceAuthSessionRow =
  typeof builtinConnectorOauthDeviceAuthorizationSessions.$inferSelect;

function deviceRequestedOauthScopes(
  storedScopes: string | null,
  resolvedMethod: ResolvedConnectorActionMethod,
): readonly string[] {
  return resolveOAuthRequestedScopeSnapshot(
    storedScopes,
    connectorGrantScopes(resolvedMethod.method.grant),
  );
}

type PendingPollBody = Extract<
  BuiltinConnectorOauthDeviceAuthSessionPollResponse,
  { status: "pending" }
>;

type PendingSuccess = {
  readonly status: 200;
  readonly body: PendingPollBody;
};

type PollSuccess = {
  readonly status: 200;
  readonly body: BuiltinConnectorOauthDeviceAuthSessionPollResponse;
};

function deviceAuthStartResponse(args: {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly connectorSlug: ConnectorSlug;
  readonly startResult: Awaited<
    ReturnType<typeof startConnectorDeviceAuthorizationWithMethod>
  >;
  readonly intervalSeconds: number;
}): BuiltinConnectorOauthDeviceAuthSessionStartResponse {
  return {
    sessionId: args.sessionId,
    sessionToken: args.sessionToken,
    connectorSlug: args.connectorSlug,
    status: "pending",
    userCode: args.startResult.userCode,
    verificationUri: args.startResult.verificationUri,
    verificationUriComplete: args.startResult.verificationUriComplete,
    expiresIn: args.startResult.expiresIn,
    interval: args.intervalSeconds,
  };
}

const DEVICE_AUTH_POLL_STATE_MAX_BYTES = 4096;

function validatedDeviceAuthPollState(
  pollState: string | undefined,
): string | undefined {
  if (pollState === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(pollState, "utf8") > DEVICE_AUTH_POLL_STATE_MAX_BYTES) {
    throw new Error(
      `Connector OAuth device authorization provider poll state exceeds ${DEVICE_AUTH_POLL_STATE_MAX_BYTES} bytes`,
    );
  }
  return pollState;
}

type ResolvedBuiltinConnectorDeviceAuthClient = {
  readonly resolvedMethod: ResolvedConnectorActionMethod;
  readonly authClient: ConnectorAuthClient;
};

type PollClaimedSessionArgs = ResolvedBuiltinConnectorDeviceAuthClient & {
  readonly writeDb: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly session: BuiltinConnectorDeviceAuthSessionRow;
  readonly claimStartedAt: Date;
  readonly persistConnector: (args: {
    readonly result: OAuthDeviceAuthCompleteResultBase;
  }) => Promise<
    | { readonly ok: true; readonly connector: BuiltinConnectorResponse }
    | { readonly ok: false; readonly message: string }
  >;
};

type BuiltinConnectorDeviceAuthSessionOwner = {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly orgId: string;
  readonly userId: string;
};

const connectorOauthDeviceAuthDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "OAuth device authorization is not enabled for this connector",
      code: "FORBIDDEN",
    }),
  }),
});

function connectorOauthDeviceAuthUnavailable(connectorSlug: ConnectorSlug) {
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

function deviceAuthResolutionError(
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
    case "unknown_auth_method":
    case "wrong_grant_kind": {
      const hasDeviceAuth = resolution.catalogConnector.authMethods.some(
        (method) => {
          return method.grantKind === "device-auth";
        },
      );
      if (!hasDeviceAuth) {
        const hasAuthCode = resolution.catalogConnector.authMethods.some(
          (method) => {
            return method.grantKind === "auth-code";
          },
        );
        return badRequestMessage(
          hasAuthCode
            ? `${args.connectorSlug} connector does not support a device-auth grant`
            : `${args.connectorSlug} connector does not use an auth-code or device-auth grant`,
        );
      }
      if (resolution.reason === "unknown_auth_method") {
        return badRequestMessage(
          `${args.connectorSlug} connector does not have ${args.authMethodId} auth method`,
        );
      }
      return badRequestMessage(
        `${args.connectorSlug} ${args.authMethodId} auth method does not use a device-auth grant`,
      );
    }
    case "hidden_auth_method": {
      return connectorOauthDeviceAuthDisabled;
    }
    case "missing_executable_capability": {
      return connectorOauthDeviceAuthUnavailable(args.connectorSlug);
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

function terminalErrorBody(
  session: BuiltinConnectorDeviceAuthSessionRow,
): BuiltinConnectorOauthDeviceAuthSessionPollResponse {
  if (
    session.status !== "denied" &&
    session.status !== "expired" &&
    session.status !== "error"
  ) {
    throw new Error(
      `Unsupported terminal OAuth device status ${session.status}`,
    );
  }
  return {
    status: session.status,
    errorCode: session.errorCode ?? undefined,
    errorMessage: session.errorMessage ?? undefined,
  };
}

function pendingBody(
  session: Pick<BuiltinConnectorDeviceAuthSessionRow, "intervalSeconds">,
): PendingPollBody {
  return { status: "pending", interval: session.intervalSeconds };
}

function pendingResponse(
  session: Pick<BuiltinConnectorDeviceAuthSessionRow, "intervalSeconds">,
): PendingSuccess {
  return { status: 200, body: pendingBody(session) };
}

function shouldWaitBeforeProviderPoll(
  session: BuiltinConnectorDeviceAuthSessionRow,
  now: Date,
): boolean {
  return (
    session.status === "awaiting_user_authorization" &&
    session.updatedAt.getTime() > now.getTime() - session.intervalSeconds * 1000
  );
}

function isFreshPollingSession(
  session: BuiltinConnectorDeviceAuthSessionRow,
  now: Date,
): boolean {
  return (
    session.status === "polling" &&
    session.updatedAt.getTime() > now.getTime() - POLLING_STALE_MS
  );
}

function resolveRequiredAuthClient(
  resolvedMethod: ResolvedConnectorActionMethod,
):
  | ResolvedBuiltinConnectorDeviceAuthClient
  | ReturnType<typeof internalServerError> {
  if (
    resolvedMethod.method.grant.kind !== "device-auth" ||
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

async function resolveRequestedDeviceAuthMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
}) {
  const resolved = await args.resolver.resolveNewActionMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: args.authMethodId,
    expectedGrantKind: "device-auth",
  });
  if (!resolved.ok) {
    return deviceAuthResolutionError(resolved, args);
  }
  return resolved;
}

async function resolveStoredDeviceAuthMethod(args: {
  readonly resolver: ConnectorActionResolver;
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: string;
}) {
  const storedAuthMethod = connectorAuthMethodIdSchema.safeParse(
    args.authMethodId,
  );
  if (!storedAuthMethod.success) {
    return internalServerError("Invalid OAuth device authorization session");
  }
  const resolved = await args.resolver.resolveMethod({
    connectorSlug: args.connectorSlug,
    authMethodId: storedAuthMethod.data,
    expectedGrantKind: "device-auth",
  });
  if (!resolved.ok) {
    return connectorOauthDeviceAuthUnavailable(args.connectorSlug);
  }
  return resolved;
}

async function lockDeviceAuthSessionOwner(
  args: BuiltinConnectorDeviceAuthSessionOwner & {
    readonly writeDb: Db;
  },
): Promise<void> {
  await args.writeDb.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('oauth_device_authorization:' || ${args.orgId} || ':' || ${args.userId} || ':' || ${args.connectorSlug} || ':' || ${args.authMethod}))`,
  );
}

async function markActiveSessionsSuperseded(
  args: BuiltinConnectorDeviceAuthSessionOwner & {
    readonly writeDb: Db;
    readonly now: Date;
  },
): Promise<void> {
  await args.writeDb
    .update(builtinConnectorOauthDeviceAuthorizationSessions)
    .set({
      status: "error",
      errorCode: SUPERSEDED_SESSION_ERROR_CODE,
      errorMessage: SUPERSEDED_SESSION_ERROR_MESSAGE,
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(builtinConnectorOauthDeviceAuthorizationSessions.orgId, args.orgId),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.userId,
          args.userId,
        ),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.connectorSlug,
          args.connectorSlug,
        ),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.authMethod,
          args.authMethod,
        ),
        inArray(builtinConnectorOauthDeviceAuthorizationSessions.status, [
          ...ACTIVE_DEVICE_AUTHORIZATION_SESSION_STATUSES,
        ]),
      ),
    );
}

async function markClaimAwaiting(
  args: {
    readonly writeDb: Db;
    readonly sessionId: string;
    readonly claimStartedAt: Date;
    readonly intervalSeconds: number;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [session] = await args.writeDb
    .update(builtinConnectorOauthDeviceAuthorizationSessions)
    .set({
      status: "awaiting_user_authorization",
      intervalSeconds: args.intervalSeconds,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(builtinConnectorOauthDeviceAuthorizationSessions.id, args.sessionId),
        eq(builtinConnectorOauthDeviceAuthorizationSessions.status, "polling"),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.updatedAt,
          args.claimStartedAt,
        ),
      ),
    )
    .returning({ id: builtinConnectorOauthDeviceAuthorizationSessions.id });
  signal.throwIfAborted();
  return Boolean(session);
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
): Promise<BuiltinConnectorDeviceAuthSessionRow | null> {
  const [session] = await args.writeDb
    .select(deviceAuthSessionSelection)
    .from(builtinConnectorOauthDeviceAuthorizationSessions)
    .where(
      and(
        eq(builtinConnectorOauthDeviceAuthorizationSessions.id, args.sessionId),
        eq(builtinConnectorOauthDeviceAuthorizationSessions.orgId, args.orgId),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.userId,
          args.userId,
        ),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.connectorSlug,
          args.connectorSlug,
        ),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.sessionTokenHash,
          sessionTokenHash(args.sessionToken),
        ),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return session ?? null;
}

async function expireSession(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorDeviceAuthSessionRow;
    readonly now: Date;
  },
  signal: AbortSignal,
): Promise<PollSuccess> {
  const [expiredSession] = await args.writeDb
    .update(builtinConnectorOauthDeviceAuthorizationSessions)
    .set({
      status: "expired",
      errorCode: "expired_token",
      errorMessage: "OAuth device authorization session expired",
      updatedAt: args.now,
      completedAt: args.now,
    })
    .where(
      and(
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.id,
          args.session.id,
        ),
        or(
          eq(
            builtinConnectorOauthDeviceAuthorizationSessions.status,
            "awaiting_user_authorization",
          ),
          eq(
            builtinConnectorOauthDeviceAuthorizationSessions.status,
            "polling",
          ),
        ),
      ),
    )
    .returning(deviceAuthSessionSelection);
  signal.throwIfAborted();

  if (!expiredSession) {
    return await claimNoLongerCurrentResponse(
      {
        writeDb: args.writeDb,
        session: args.session,
      },
      signal,
    );
  }
  return { status: 200, body: terminalErrorBody(expiredSession) };
}

async function claimSession(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorDeviceAuthSessionRow;
    readonly claimStartedAt: Date;
  },
  signal: AbortSignal,
): Promise<BuiltinConnectorDeviceAuthSessionRow | null> {
  const staleBefore = new Date(
    args.claimStartedAt.getTime() - POLLING_STALE_MS,
  );
  const [claimedSession] = await args.writeDb
    .update(builtinConnectorOauthDeviceAuthorizationSessions)
    .set({ status: "polling", updatedAt: args.claimStartedAt })
    .where(
      and(
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.id,
          args.session.id,
        ),
        or(
          eq(
            builtinConnectorOauthDeviceAuthorizationSessions.status,
            "awaiting_user_authorization",
          ),
          and(
            eq(
              builtinConnectorOauthDeviceAuthorizationSessions.status,
              "polling",
            ),
            lt(
              builtinConnectorOauthDeviceAuthorizationSessions.updatedAt,
              staleBefore,
            ),
          ),
        ),
      ),
    )
    .returning(deviceAuthSessionSelection);
  signal.throwIfAborted();
  return claimedSession ?? null;
}

async function parseEncryptedProviderState(args: {
  readonly session: BuiltinConnectorDeviceAuthSessionRow;
  readonly connectorSlug: ConnectorSlug;
}) {
  const decrypted = await decryptPersistentSecretValue(
    args.session.encryptedProviderState,
    {
      orgId: args.session.orgId,
      userId: args.session.userId,
    },
  );
  return parseBuiltinConnectorOauthDeviceProviderState({
    serializedState: decrypted,
    connectorSlug: args.connectorSlug,
  });
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
      status: builtinConnectorOauthDeviceAuthorizationSessions.status,
      updatedAt: builtinConnectorOauthDeviceAuthorizationSessions.updatedAt,
    })
    .from(builtinConnectorOauthDeviceAuthorizationSessions)
    .where(
      eq(builtinConnectorOauthDeviceAuthorizationSessions.id, args.sessionId),
    )
    .limit(1);
  signal.throwIfAborted();

  return (
    currentClaim?.status === "polling" &&
    currentClaim.updatedAt.getTime() === args.claimStartedAt.getTime()
  );
}

async function claimNoLongerCurrentResponse(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorDeviceAuthSessionRow;
  },
  signal: AbortSignal,
): Promise<PollSuccess> {
  const [currentSession] = await args.writeDb
    .select(deviceAuthSessionSelection)
    .from(builtinConnectorOauthDeviceAuthorizationSessions)
    .where(
      eq(builtinConnectorOauthDeviceAuthorizationSessions.id, args.session.id),
    )
    .limit(1);
  signal.throwIfAborted();

  if (
    currentSession?.status === "denied" ||
    currentSession?.status === "expired" ||
    currentSession?.status === "error"
  ) {
    return { status: 200, body: terminalErrorBody(currentSession) };
  }
  return pendingResponse(args.session);
}

async function markClaimTerminal(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorDeviceAuthSessionRow;
    readonly claimStartedAt: Date;
    readonly result: Extract<
      OAuthDeviceAuthPollResultBase,
      {
        readonly status: "denied" | "expired" | "error";
      }
    >;
  },
  signal: AbortSignal,
): Promise<PollSuccess> {
  const completedAt = nowDate();
  const [terminalSession] = await args.writeDb
    .update(builtinConnectorOauthDeviceAuthorizationSessions)
    .set({
      status: args.result.status,
      errorCode: args.result.error,
      errorMessage: args.result.errorDescription,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.id,
          args.session.id,
        ),
        eq(builtinConnectorOauthDeviceAuthorizationSessions.status, "polling"),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.updatedAt,
          args.claimStartedAt,
        ),
      ),
    )
    .returning(deviceAuthSessionSelection);
  signal.throwIfAborted();

  if (!terminalSession) {
    return await claimNoLongerCurrentResponse(
      {
        writeDb: args.writeDb,
        session: args.session,
      },
      signal,
    );
  }
  return { status: 200, body: terminalErrorBody(terminalSession) };
}

async function markClaimComplete(
  args: {
    readonly writeDb: Db;
    readonly session: BuiltinConnectorDeviceAuthSessionRow;
    readonly claimStartedAt: Date;
    readonly connector: BuiltinConnectorResponse;
  },
  signal: AbortSignal,
): Promise<PollSuccess> {
  const completedAt = nowDate();
  const [completedSession] = await args.writeDb
    .update(builtinConnectorOauthDeviceAuthorizationSessions)
    .set({
      status: "complete",
      completedConnectorId: args.connector.id,
      updatedAt: completedAt,
      completedAt,
    })
    .where(
      and(
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.id,
          args.session.id,
        ),
        eq(builtinConnectorOauthDeviceAuthorizationSessions.status, "polling"),
        eq(
          builtinConnectorOauthDeviceAuthorizationSessions.updatedAt,
          args.claimStartedAt,
        ),
      ),
    )
    .returning(deviceAuthSessionSelection);
  signal.throwIfAborted();

  if (!completedSession) {
    return await claimNoLongerCurrentResponse(
      {
        writeDb: args.writeDb,
        session: args.session,
      },
      signal,
    );
  }
  return {
    status: 200,
    body: { status: "complete", connector: args.connector },
  };
}

async function completeClaimedSession(
  args: BuiltinConnectorDeviceAuthSessionOwner & {
    readonly writeDb: Db;
    readonly orgId: string;
    readonly userId: string;
    readonly session: BuiltinConnectorDeviceAuthSessionRow;
    readonly claimStartedAt: Date;
    readonly result: OAuthDeviceAuthCompleteResultBase;
    readonly persistConnector: (args: {
      readonly result: OAuthDeviceAuthCompleteResultBase;
    }) => Promise<
      | { readonly ok: true; readonly connector: BuiltinConnectorResponse }
      | { readonly ok: false; readonly message: string }
    >;
  },
  signal: AbortSignal,
): Promise<PollSuccess> {
  return await args.writeDb.transaction(async (tx) => {
    await lockDeviceAuthSessionOwner({
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
      return await claimNoLongerCurrentResponse(
        {
          writeDb: tx,
          session: args.session,
        },
        signal,
      );
    }

    const persisted = await args.persistConnector({ result: args.result });
    signal.throwIfAborted();
    if (!persisted.ok) {
      return await markClaimTerminal(
        {
          writeDb: tx,
          session: args.session,
          claimStartedAt: args.claimStartedAt,
          result: {
            status: "error",
            error: "connector_account_rejected",
            errorDescription: persisted.message,
          },
        },
        signal,
      );
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

async function completeSessionResponse(
  args: {
    readonly connectorLoader: () => Promise<BuiltinConnectorResponse | null>;
  },
  signal: AbortSignal,
): Promise<PollSuccess> {
  const connector = await args.connectorLoader();
  signal.throwIfAborted();
  if (!connector) {
    throw new Error("Completed OAuth connector not found");
  }
  return { status: 200, body: { status: "complete", connector } };
}

const authorizeDeviceSessionConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: BuiltinConnectorDeviceAuthSessionRow;
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

const completedDeviceSessionResponse$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly session: BuiltinConnectorDeviceAuthSessionRow;
      readonly method: ResolvedConnectorActionMethod;
    },
    signal: AbortSignal,
  ) => {
    const response = await completeSessionResponse(
      {
        connectorLoader: () => {
          if (!args.session.completedConnectorId) {
            throw new Error(
              "Completed OAuth device session is missing its connector ID",
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
      authorizeDeviceSessionConnector$,
      { ...args, connectorSlug: args.method.connectorSlug },
      signal,
    );
    return error ?? response;
  },
);

async function runClaimedSession(
  args: PollClaimedSessionArgs,
  signal: AbortSignal,
): Promise<PollSuccess> {
  const providerState = await parseEncryptedProviderState({
    session: args.session,
    connectorSlug: args.resolvedMethod.connectorSlug,
  });
  const requestedScopes = deviceRequestedOauthScopes(
    args.session.oauthRequestedScopes,
    args.resolvedMethod,
  );
  const pollResult = await pollConnectorDeviceAuthorizationWithMethod({
    connectorSlug: args.resolvedMethod.connectorSlug,
    authMethodId: args.resolvedMethod.authMethodId,
    method: args.resolvedMethod.method,
    authClient: args.authClient,
    deviceCode: providerState.deviceCode,
    scopes: requestedScopes,
    ...(providerState.pollState === undefined
      ? {}
      : { pollState: providerState.pollState }),
  });
  signal.throwIfAborted();

  if (pollResult.status === "pending" || pollResult.status === "slow_down") {
    const intervalSeconds =
      pollResult.status === "pending"
        ? (pollResult.interval ?? args.session.intervalSeconds)
        : args.session.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS;
    const restored = await markClaimAwaiting(
      {
        writeDb: args.writeDb,
        sessionId: args.session.id,
        claimStartedAt: args.claimStartedAt,
        intervalSeconds,
      },
      signal,
    );
    if (!restored) {
      return await claimNoLongerCurrentResponse(
        {
          writeDb: args.writeDb,
          session: args.session,
        },
        signal,
      );
    }
    return {
      status: 200,
      body: { status: "pending", interval: intervalSeconds },
    };
  }

  if (pollResult.status !== "complete") {
    return await markClaimTerminal(
      {
        writeDb: args.writeDb,
        session: args.session,
        claimStartedAt: args.claimStartedAt,
        result: pollResult,
      },
      signal,
    );
  }

  return await completeClaimedSession(
    {
      connectorSlug: args.resolvedMethod.connectorSlug,
      authMethod: args.resolvedMethod.authMethodId,
      writeDb: args.writeDb,
      orgId: args.orgId,
      userId: args.userId,
      session: args.session,
      claimStartedAt: args.claimStartedAt,
      persistConnector: args.persistConnector,
      result: pollResult,
    },
    signal,
  );
}

async function pollClaimedSession(
  args: PollClaimedSessionArgs,
  signal: AbortSignal,
): Promise<PollSuccess> {
  const result = await settle(runClaimedSession(args, signal), signal);
  if (result.ok) {
    return result.value;
  }

  const restored = await markClaimAwaiting(
    {
      writeDb: args.writeDb,
      sessionId: args.session.id,
      claimStartedAt: args.claimStartedAt,
      intervalSeconds: args.session.intervalSeconds,
    },
    signal,
  );
  if (!restored) {
    return await claimNoLongerCurrentResponse(
      {
        writeDb: args.writeDb,
        session: args.session,
      },
      signal,
    );
  }
  throw result.error;
}

async function createDeviceAuthSession(
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
    readonly oauthRequestedScopes: readonly string[];
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete: string | undefined;
    readonly intervalSeconds: number;
    readonly now: Date;
    readonly expiresAt: Date;
  },
  signal: AbortSignal,
) {
  return await db.transaction(async (tx) => {
    await lockDeviceAuthSessionOwner({
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
    await markActiveSessionsSuperseded({
      connectorSlug: args.connectorSlug,
      authMethod: args.authMethod,
      writeDb: tx,
      orgId: args.orgId,
      userId: args.userId,
      now: args.now,
    });
    const [session] = await tx
      .insert(builtinConnectorOauthDeviceAuthorizationSessions)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        agentId: args.agentId,
        authorizeAgent: connectorAgentAuthorizationRequested(args),
        connectorSlug: args.connectorSlug,
        authMethod: args.authMethod,
        status: "awaiting_user_authorization",
        sessionTokenHash: sessionTokenHash(args.sessionToken),
        encryptedProviderState: args.encryptedProviderState,
        accountMutation: args.account,
        oauthRequestedScopes: JSON.stringify(args.oauthRequestedScopes),
        userCode: args.userCode,
        verificationUri: args.verificationUri,
        verificationUriComplete: args.verificationUriComplete,
        intervalSeconds: args.intervalSeconds,
        createdAt: args.now,
        updatedAt: args.now,
        expiresAt: args.expiresAt,
      })
      .returning({ id: builtinConnectorOauthDeviceAuthorizationSessions.id });
    if (!session) {
      throw new Error("Failed to create OAuth device authorization session");
    }
    return { kind: "created" as const, session };
  });
}

export const startBuiltinConnectorOauthDeviceAuthSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly agentId: string | undefined;
      readonly authorizeAgent: true | undefined;
      readonly connectorSlug: ConnectorSlug;
      readonly authMethod: ConnectorAuthMethodId;
      readonly options?: Readonly<Record<string, string>>;
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
    const resolvedMethod = await resolveRequestedDeviceAuthMethod({
      resolver,
      connectorSlug: args.connectorSlug,
      authMethodId: args.authMethod,
    });
    signal.throwIfAborted();
    if ("status" in resolvedMethod) {
      return resolvedMethod;
    }

    const resolvedClient = resolveRequiredAuthClient(resolvedMethod);
    if ("status" in resolvedClient) {
      return resolvedClient;
    }

    const normalizedStartOptions = normalizeDeviceAuthStartOptionsWithMethod({
      connectorSlug: resolvedMethod.connectorSlug,
      authMethodId: resolvedMethod.authMethodId,
      method: resolvedMethod.method,
      options: args.options,
    });
    if (!normalizedStartOptions.ok) {
      return badRequestMessage(normalizedStartOptions.message);
    }

    const startResult = await startConnectorDeviceAuthorizationWithMethod({
      connectorSlug: resolvedMethod.connectorSlug,
      authMethodId: resolvedMethod.authMethodId,
      method: resolvedMethod.method,
      authClient: resolvedClient.authClient,
      options: normalizedStartOptions.options,
    });
    signal.throwIfAborted();

    const sessionToken = generateSessionToken();
    const intervalSeconds =
      startResult.interval ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const now = nowDate();
    const expiresAt = new Date(now.getTime() + startResult.expiresIn * 1000);
    const pollState = validatedDeviceAuthPollState(startResult.pollState);
    const encryptedProviderState = await encryptPersistentSecretValue(
      serializeBuiltinConnectorOauthDeviceProviderState({
        connectorSlug: resolvedMethod.connectorSlug,
        deviceCode: startResult.deviceCode,
        pollState,
      }),
      {
        orgId: args.orgId,
        userId: args.userId,
      },
    );
    signal.throwIfAborted();

    const sessionResult = await createDeviceAuthSession(
      set(writeDb$),
      {
        orgId: args.orgId,
        userId: args.userId,
        connectorSlug: resolvedMethod.connectorSlug,
        authMethod: resolvedMethod.authMethodId,
        agentId: args.agentId,
        authorizeAgent: args.authorizeAgent,
        account: args.account,
        sessionToken,
        encryptedProviderState,
        oauthRequestedScopes: connectorGrantScopes(resolvedMethod.method.grant),
        userCode: startResult.userCode,
        verificationUri: startResult.verificationUri,
        verificationUriComplete: startResult.verificationUriComplete,
        intervalSeconds,
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

    const body = deviceAuthStartResponse({
      sessionId: sessionResult.session.id,
      sessionToken,
      connectorSlug: resolvedMethod.connectorSlug,
      startResult,
      intervalSeconds,
    });
    return { status: 200 as const, body };
  },
);

export const pollBuiltinConnectorOauthDeviceAuthSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectorSlug: ConnectorSlug;
      readonly sessionId: string;
      readonly sessionToken: string;
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
      return notFound("OAuth device authorization session not found");
    }

    const resolver = await get(connectorActionResolver());
    signal.throwIfAborted();
    const resolvedMethod = await resolveStoredDeviceAuthMethod({
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
        completedDeviceSessionResponse$,
        { ...args, session, method: resolvedMethod },
        signal,
      );
    }

    if (
      session.status === "denied" ||
      session.status === "expired" ||
      session.status === "error"
    ) {
      return { status: 200 as const, body: terminalErrorBody(session) };
    }

    const now = nowDate();
    if (shouldWaitBeforeProviderPoll(session, now)) {
      return pendingResponse(session);
    }

    if (isFreshPollingSession(session, now)) {
      return pendingResponse(session);
    }

    if (now > session.expiresAt) {
      return await expireSession({ writeDb, session, now }, signal);
    }

    const claimStartedAt = nowDate();
    const claimedSession = await claimSession(
      {
        writeDb,
        session,
        claimStartedAt,
      },
      signal,
    );
    if (!claimedSession) {
      return await claimNoLongerCurrentResponse({ writeDb, session }, signal);
    }

    const response = await pollClaimedSession(
      {
        ...resolvedClient,
        writeDb,
        orgId: args.orgId,
        userId: args.userId,
        session: claimedSession,
        claimStartedAt,
        persistConnector: async ({ result }) => {
          const connectorResult = await set(
            upsertBuiltinConnectorTokenConnection$,
            {
              orgId: args.orgId,
              userId: args.userId,
              runtimeMethod: resolvedMethod.runtimeMethod,
              snapshot: resolvedMethod.snapshot,
              outputs: result.token.outputs,
              userInfo: result.token.userInfo,
              oauthRequestedScopes: deviceRequestedOauthScopes(
                claimedSession.oauthRequestedScopes,
                resolvedMethod,
              ),
              oauthGrantedScopes: result.token.scopes,
              expiresIn: result.token.expiresIn,
              extraConnectorSecrets: result.token.extraConnectorSecrets,
              account: claimedSession.accountMutation,
            },
            signal,
          );
          if (connectorResult.status !== "connected") {
            return connectorConnectionWriteRejection(connectorResult.status);
          }
          return { ok: true, connector: connectorResult.connector };
        },
      },
      signal,
    );
    if (response.body.status !== "complete") {
      return response;
    }
    const authorizationError = await set(
      authorizeDeviceSessionConnector$,
      { ...args, session, connectorSlug: resolvedMethod.connectorSlug },
      signal,
    );
    return authorizationError ?? response;
  },
);
