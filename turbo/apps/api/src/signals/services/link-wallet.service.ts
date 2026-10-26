import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WalletChangedPayload } from "@okouai/api-contracts/contracts/realtime";

import {
  type WalletCreateSpend,
  type WalletSpendListQuery,
  type WalletConnectStatus,
  type WalletConnectionStatus,
  type WalletSpend,
  type WalletSpendCredentials,
  walletSpendSchema,
  walletSpendCredentialsSchema,
} from "@okouai/api-contracts/contracts/wallet";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  linkWalletConnections,
  linkWalletOAuthAttempts,
  linkWalletSpends,
} from "@okouai/db/schema/link-wallet";
import { command, computed } from "ccstate";
import {
  and,
  eq,
  gt,
  gte,
  lt,
  or,
  desc,
  isNull,
  isNotNull,
  sql,
} from "drizzle-orm";
import * as z from "zod";

import { now, nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$, writeDb$ } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { onRejection } from "../utils";
import { linkApprovalEnabled$ } from "./link-approval-config.service";
import {
  requireApprovalThread,
  takeOverWalletApproval$,
} from "./link-wallet-continuation.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  LinkWalletError,
  LINK_WALLET_OAUTH_SCOPES,
  LINK_WALLET_SOURCE_ACTIONS,
  linkActionUrl,
  linkCredentialsSchema,
  linkSpendRequest,
  linkTokenRequest,
  linkWalletConfig,
  linkWalletRedirectUri,
  requestLinkApproval,
  retrieveLinkSpendCredentials,
  revokeLinkToken,
  readLinkWallet,
  type LinkSpend,
} from "./link-wallet-provider.service";
import {
  recordWalletConnectionUsage,
  recordWalletSpendUsage,
} from "./link-wallet-usage";

import type { LinkWalletReadRequest } from "../external/link-wallet-client";
import {
  walletAuthorization,
  requireWalletPermission,
  type WalletPermission,
} from "./link-wallet-grants";

// Honor the consent mode of already-issued OAuth states. The full state hash
// prevents callers from stripping or changing this read-only restriction.
const READ_ONLY_CONSENT_MARKER = "read-only.";

export interface WalletOwner {
  readonly orgId: string;
  readonly userId: string;
  // Initiating-agent provenance for existing chat clients, never wallet ownership.
  readonly agentId?: string | null;
}
interface WalletRunOwner extends WalletOwner {
  readonly agentId: string;
  readonly runId?: string;
  readonly chatThreadId?: string | null;
}
type Connection = typeof linkWalletConnections.$inferSelect;
type Spend = typeof linkWalletSpends.$inferSelect;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function connectionOwner(owner: WalletOwner) {
  return and(
    eq(linkWalletConnections.orgId, owner.orgId),
    eq(linkWalletConnections.userId, owner.userId),
    isNull(linkWalletConnections.agentId),
  );
}
function spendOwner(owner: WalletRunOwner) {
  return and(
    eq(linkWalletSpends.orgId, owner.orgId),
    eq(linkWalletSpends.userId, owner.userId),
    eq(linkWalletSpends.agentId, owner.agentId),
  );
}

export const walletRunOwner$ = computed(
  async (get): Promise<WalletRunOwner> => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "agent") {
      throw new LinkWalletError(
        403,
        "FORBIDDEN",
        "Wallet access requires an agent run",
      );
    }
    const db = get(db$);
    const [run] = await db
      .select({
        agentId: agentRuns.agentId,
        triggerSource: agentRuns.triggerSource,
        chatThreadId: agentRuns.chatThreadId,
        status: agentRuns.status,
      })
      .from(agentRuns)

      .where(
        and(
          eq(agentRuns.id, auth.runId),
          eq(agentRuns.orgId, auth.orgId),
          eq(agentRuns.userId, auth.userId),
        ),
      )
      .limit(1);
    if (
      !run?.agentId ||
      run.triggerSource !== "web" ||
      run.status !== "running"
    ) {
      throw new LinkWalletError(
        403,
        "WALLET_INTERACTIVE_RUN_REQUIRED",
        "Wallet access is limited to a running, user-initiated web chat; automations cannot use it",
      );
    }
    return {
      orgId: auth.orgId,
      userId: auth.userId,
      agentId: run.agentId,
      runId: auth.runId,
      chatThreadId: run.chatThreadId,
    };
  },
);

const connection$ = computed(async (get): Promise<Connection | undefined> => {
  const owner = get(organizationAuthContext$);
  const db = get(db$);
  const [row] = await db
    .select()
    .from(linkWalletConnections)
    .where(connectionOwner(owner))
    .limit(1);
  return row;
});

const connectionCredentials$ = computed(async (get) => {
  const row = await get(connection$);
  if (!row?.encryptedCredentials || row.revokedAt) {
    return undefined;
  }
  return linkCredentialsSchema.parse(
    JSON.parse(
      await decryptStoredSecretValue(row.encryptedCredentials),
    ) as unknown,
  );
});

function walletStatus(
  credentials: z.infer<typeof linkCredentialsSchema> | undefined,
) {
  const authorization = walletAuthorization(credentials);
  return {
    connected: credentials !== undefined,
    nextAction: authorization.capabilities.payments
      ? ("create_spend" as const)
      : ("connect" as const),
    checkoutAvailable: false as const,
    authorization,
  };
}

export const walletStatus$ = computed(async (get) => {
  return walletStatus(await get(connectionCredentials$));
});

function walletScopeChange(
  storedScopes: string | null,
  grantedScopes: readonly string[],
  grantedSourceActions: readonly string[],
): WalletConnectionStatus["scopeChange"] {
  if (storedScopes === null) {
    throw new Error("Link wallet connection is missing oauthRequestedScopes");
  }
  const current = [
    ...new Set([
      ...LINK_WALLET_OAUTH_SCOPES,
      ...grantedScopes,
      ...LINK_WALLET_SOURCE_ACTIONS,
      ...grantedSourceActions,
    ]),
  ].sort();
  const stored = [
    ...new Set([
      ...z.array(z.string()).parse(JSON.parse(storedScopes)),
      ...grantedScopes,
      ...grantedSourceActions,
    ]),
  ].sort();
  const addedScopes = current.filter((scope) => {
    return !stored.includes(scope);
  });
  const removedScopes = stored.filter((scope) => {
    return !current.some((requested) => {
      return requested === scope;
    });
  });
  if (addedScopes.length === 0 && removedScopes.length === 0) {
    return null;
  }
  return {
    reason: "permissions_changed",
    addedScopes,
    removedScopes,
    currentScopes: current,
    storedScopes: stored,
  };
}

export const walletSettingsStatus$ = command(
  async (
    { get, set },
    signal: AbortSignal,
  ): Promise<WalletConnectionStatus> => {
    const owner = get(organizationAuthContext$);
    const [row, storedCredentials] = await Promise.all([
      get(connection$),
      get(connectionCredentials$),
    ]);
    signal.throwIfAborted();
    let credentials = storedCredentials;
    if (
      row?.encryptedCredentials &&
      credentials &&
      credentials.expiresAt <= now() + 60_000
    ) {
      // The page waits for this response before fetching cards and transactions.
      // Persist rotation first so those independent requests can safely fan out.
      const refreshed = await set(refreshWalletConnection$, {
        owner,
        connection: { ...row, encryptedCredentials: row.encryptedCredentials },
        refreshToken: credentials.refreshToken,
        readOnly: credentials.readOnly,
      });
      signal.throwIfAborted();
      credentials = refreshed.credentials;
    }
    const status = walletStatus(credentials);
    const db = get(db$);
    const [pending] = await db
      .select({ id: linkWalletConnections.id })
      .from(linkWalletConnections)
      .where(
        and(
          eq(linkWalletConnections.orgId, owner.orgId),
          eq(linkWalletConnections.userId, owner.userId),
          isNotNull(linkWalletConnections.revokedAt),
          isNull(linkWalletConnections.revocationConfirmedAt),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const scopeChange =
      row && !row.revokedAt && status.connected
        ? walletScopeChange(
            row.oauthRequestedScopes,
            status.authorization.scopes,
            status.authorization.sourceActions,
          )
        : null;
    const connectionStatus = scopeChange
      ? "scope-mismatch"
      : status.connected
        ? "connected"
        : row && !row.revokedAt
          ? "reconnect-required"
          : "not-connected";
    return {
      ...status,
      revocationPending: Boolean(pending),
      connectionStatus,
      scopeChange,
    };
  },
);

export const walletConnectStatus$ = command(
  async (
    { get },
    owner: WalletOwner,
    state: string,
  ): Promise<WalletConnectStatus> => {
    const db = get(db$);
    const [attempt] = await db
      .select({
        id: linkWalletOAuthAttempts.id,
        status: linkWalletOAuthAttempts.status,
        expiresAt: linkWalletOAuthAttempts.expiresAt,
        authorizationId: linkWalletConnections.authorizationId,
        revokedAt: linkWalletConnections.revokedAt,
      })
      .from(linkWalletOAuthAttempts)
      .leftJoin(
        linkWalletConnections,
        and(
          eq(linkWalletConnections.orgId, owner.orgId),
          eq(linkWalletConnections.userId, owner.userId),
          eq(linkWalletConnections.authorizationId, linkWalletOAuthAttempts.id),
          isNotNull(linkWalletConnections.encryptedCredentials),
        ),
      )
      .where(
        and(
          eq(linkWalletOAuthAttempts.stateHash, hash(state)),
          eq(linkWalletOAuthAttempts.orgId, owner.orgId),
          eq(linkWalletOAuthAttempts.userId, owner.userId),
          eq(linkWalletOAuthAttempts.scope, "workspace_user"),
        ),
      )
      .limit(1);
    if (!attempt) {
      return { status: "unavailable" };
    }
    if (attempt.status === "completed") {
      return attempt.authorizationId === attempt.id && !attempt.revokedAt
        ? { status: "authorized", authorizationId: attempt.id }
        : { status: "unavailable" };
    }
    if (attempt.status === "failed") {
      return { status: "failed" };
    }
    return {
      status: attempt.expiresAt.getTime() <= now() ? "expired" : "pending",
    };
  },
);

export const startWalletOAuth$ = command(
  async ({ get, set }, owner: WalletOwner, signal: AbortSignal) => {
    const config = linkWalletConfig();
    const current = await get(connection$);
    signal.throwIfAborted();
    const credentials =
      current?.encryptedCredentials && !current.revokedAt
        ? linkCredentialsSchema.parse(
            JSON.parse(
              await decryptStoredSecretValue(current.encryptedCredentials),
            ) as unknown,
          )
        : undefined;
    signal.throwIfAborted();
    const granted = walletAuthorization(credentials);
    const scopes = new Set([...granted.scopes, ...LINK_WALLET_OAUTH_SCOPES]);
    const actions = new Set([
      ...granted.sourceActions,
      ...LINK_WALLET_SOURCE_ACTIONS,
    ]);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const expiresAt = new Date(now() + 30 * 60_000);
    const encryptedVerifier = await encryptStoredSecretValue(verifier);
    signal.throwIfAborted();
    const db = set(writeDb$);
    const authorizationId = randomUUID();
    await db.insert(linkWalletOAuthAttempts).values({
      id: authorizationId,
      ...owner,
      scope: "workspace_user",
      oauthRequestedScopes: JSON.stringify([...scopes].sort()),
      stateHash: hash(state),
      encryptedVerifier,
      expiresAt,
    });
    signal.throwIfAborted();
    const url = new URL("https://login.link.com/auth");
    for (const [key, value] of Object.entries({
      key: config.publishableKey,
      client_id: config.clientId,
      redirect_uri: linkWalletRedirectUri(),
      response_type: "code",
      scope: [...scopes].sort().join(" "),
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(key, value);
    }
    if (actions.size > 0) {
      url.searchParams.set(
        "authorization_details",
        JSON.stringify([{ type: "source", actions: [...actions].sort() }]),
      );
    }
    recordWalletConnectionUsage(owner, authorizationId, "connection_started");
    return { url: url.toString(), expiresAt: expiresAt.toISOString() };
  },
);

export const completeWalletOAuth$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly userId: string;
      readonly state: string;
      readonly code?: string;
      readonly error?: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [attempt] = await db
      .update(linkWalletOAuthAttempts)
      .set({ status: "exchanging" })
      .where(
        and(
          eq(linkWalletOAuthAttempts.status, "pending"),
          eq(linkWalletOAuthAttempts.scope, "workspace_user"),
          eq(linkWalletOAuthAttempts.stateHash, hash(input.state)),
          eq(linkWalletOAuthAttempts.orgId, input.orgId),
          eq(linkWalletOAuthAttempts.userId, input.userId),
          gt(linkWalletOAuthAttempts.expiresAt, nowDate()),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!attempt) {
      throw new LinkWalletError(
        400,
        "WALLET_INVALID_STATE",
        "Wallet authorization expired, belongs to another user or workspace, or was already used",
      );
    }
    if (input.error || !input.code) {
      await set(failWalletOAuth$, attempt);
      signal.throwIfAborted();
      return {
        status: "error" as const,
        message: "Link wallet authorization was not completed",
      };
    }
    const code = input.code;
    const result = await onRejection(
      (async () => {
        if (attempt.oauthRequestedScopes === null) {
          throw new Error("Wallet OAuth attempt is missing requested scopes");
        }
        const verifier = await decryptStoredSecretValue(
          attempt.encryptedVerifier,
        );
        const readOnly = input.state.startsWith(READ_ONLY_CONSENT_MARKER);
        signal.throwIfAborted();
        const token = await linkTokenRequest(
          {
            grant_type: "authorization_code",
            code,
            code_verifier: verifier,
            redirect_uri: linkWalletRedirectUri(),
          },
          signal,
        );
        if (
          readOnly &&
          token.scope.split(/[ ,]+/).includes("payment_methods.agentic")
        ) {
          await revokeWalletToken(token.refresh_token);
          throw new LinkWalletError(
            403,
            "WALLET_SCOPE_REQUIRED",
            "Link returned payment authorization for a read-only request; reconnect with read-only consent",
          );
        }
        return await set(publishWalletOAuth$, {
          attempt,
          token,
          readOnly,
        });
      })(),
      async () => {
        await set(failWalletOAuth$, attempt);
      },
    );
    signal.throwIfAborted();
    return result;
  },
);

async function publishWalletChanged(owner: WalletOwner): Promise<void> {
  await publishUserSignal([owner.userId], "wallet:changed", {
    orgId: owner.orgId,
  } satisfies WalletChangedPayload);
}

/** A received grant must be revoked even after its initiating owner stops. */
async function revokeWalletToken(refreshToken: string): Promise<void> {
  const owner = new AbortController();
  await revokeLinkToken(refreshToken, owner.signal).finally(() => {
    owner.abort();
  });
}

const failWalletOAuth$ = command(
  async ({ set }, attempt: typeof linkWalletOAuthAttempts.$inferSelect) => {
    const [failed] = await set(writeDb$)
      .update(linkWalletOAuthAttempts)
      .set({ status: "failed", encryptedVerifier: "" })
      .where(
        and(
          eq(linkWalletOAuthAttempts.id, attempt.id),
          eq(linkWalletOAuthAttempts.status, "exchanging"),
        ),
      )
      .returning({ id: linkWalletOAuthAttempts.id });
    if (failed) {
      recordWalletConnectionUsage(attempt, attempt.id, "connection_failed");
      await publishWalletChanged(attempt);
    }
  },
);

// Finish publishing or revoking a received grant before observing cancellation.
const publishWalletOAuth$ = command(
  async (
    { set },
    input: {
      readonly attempt: typeof linkWalletOAuthAttempts.$inferSelect;
      readonly token: Awaited<ReturnType<typeof linkTokenRequest>>;
      readonly readOnly: boolean;
    },
  ) => {
    const { attempt, token } = input;
    const encryptedCredentials = await encryptStoredSecretValue(
      JSON.stringify({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: now() + token.expires_in * 1000,
        scope: token.scope,
        authorizationDetails: token.authorization_details,
        readOnly: input.readOnly,
      }),
    );
    const db = set(writeDb$);
    // Consuming the still-live OAuth attempt and publishing the grant is atomic.
    // Disconnect deletes attempts before revoking connections, so an in-flight
    // callback cannot resurrect a grant after the user has disconnected it.
    const result = parseRawRows(
      z.object({ id: z.uuid() }),
      await db.execute(sql`
      WITH authorized AS (
        UPDATE ${linkWalletOAuthAttempts}
        SET status = 'completed', encrypted_verifier = ''
        WHERE id = ${attempt.id} AND status = 'exchanging'
          AND expires_at > ${nowDate()}
        RETURNING org_id, user_id, id
      )
      INSERT INTO ${linkWalletConnections}
        (org_id, user_id, agent_id, authorization_id, encrypted_credentials, oauth_requested_scopes)
      SELECT org_id, user_id, NULL, id, ${encryptedCredentials}, ${attempt.oauthRequestedScopes} FROM authorized
      ON CONFLICT (org_id, user_id) WHERE agent_id IS NULL DO UPDATE
      SET authorization_id = EXCLUDED.authorization_id,
          encrypted_credentials = EXCLUDED.encrypted_credentials, revoked_at = NULL,
          oauth_requested_scopes = EXCLUDED.oauth_requested_scopes,
          revocation_confirmed_at = NULL
      RETURNING id
    `),
    );
    if (result.length === 0) {
      await revokeWalletToken(token.refresh_token);
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CANCELED",
        "Wallet authorization was canceled or expired; connect again",
      );
    }
    recordWalletConnectionUsage(attempt, attempt.id, "connection_completed");
    await publishWalletChanged(attempt);
    return { status: "success" as const, username: null };
  },
);

// Refresh and persistence are one awaited operation. Caller cancellation
// is observed afterward: dropping a response after Link rotates would lose the grant.
const refreshWalletConnection$ = command(
  async (
    { set },
    input: {
      readonly owner: WalletOwner;
      readonly connection: Connection & {
        readonly encryptedCredentials: string;
      };
      readonly refreshToken: string;
      readonly readOnly: boolean;
    },
  ): Promise<{
    connection: Connection;
    token: string;
    credentials: z.infer<typeof linkCredentialsSchema>;
  }> => {
    const { owner, connection } = input;
    const db = set(writeDb$);
    const refreshOwner = new AbortController();
    const refreshed = await onRejection(
      linkTokenRequest(
        { grant_type: "refresh_token", refresh_token: input.refreshToken },
        refreshOwner.signal,
      ).finally(() => {
        refreshOwner.abort();
      }),
      async (error) => {
        if (
          error instanceof LinkWalletError &&
          error.code === "WALLET_RECONNECT_REQUIRED"
        ) {
          await db
            .update(linkWalletConnections)
            .set({ encryptedCredentials: null })
            .where(
              and(
                connectionOwner(owner),
                eq(
                  linkWalletConnections.authorizationId,
                  connection.authorizationId,
                ),
                eq(
                  linkWalletConnections.encryptedCredentials,
                  connection.encryptedCredentials,
                ),
                isNull(linkWalletConnections.revokedAt),
              ),
            );
        }
        return publishWalletChanged(owner);
      },
    );
    if (
      input.readOnly &&
      refreshed.scope.split(/[ ,]+/).includes("payment_methods.agentic")
    ) {
      await revokeWalletToken(refreshed.refresh_token);
      throw new LinkWalletError(
        403,
        "WALLET_SCOPE_REQUIRED",
        "Link changed a read-only grant to payment access; reconnect with read-only consent",
      );
    }
    const credentials = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: now() + refreshed.expires_in * 1000,
      scope: refreshed.scope,
      authorizationDetails: refreshed.authorization_details,
      readOnly: input.readOnly,
    };
    const encryptedCredentials = await encryptStoredSecretValue(
      JSON.stringify(credentials),
    );
    // Persist rotated credentials even if the caller canceled after Link returned.
    // A disconnect or newer OAuth authorization cannot be resurrected by this write.
    const [saved] = await db
      .update(linkWalletConnections)
      .set({ encryptedCredentials })
      .where(
        and(
          connectionOwner(owner),
          eq(linkWalletConnections.authorizationId, connection.authorizationId),
          eq(
            linkWalletConnections.encryptedCredentials,
            connection.encryptedCredentials,
          ),
          isNull(linkWalletConnections.revokedAt),
        ),
      )
      .returning();
    if (!saved) {
      // If disconnect won while refresh was in flight, retain the rotated token
      // only for revocation. It cannot authorize access while revokedAt is set.
      const [revoked] = await db
        .update(linkWalletConnections)
        .set({ encryptedCredentials, revocationConfirmedAt: null })
        .where(
          and(
            connectionOwner(owner),
            eq(
              linkWalletConnections.authorizationId,
              connection.authorizationId,
            ),
            or(
              eq(
                linkWalletConnections.encryptedCredentials,
                connection.encryptedCredentials,
              ),
              isNull(linkWalletConnections.encryptedCredentials),
            ),
            isNotNull(linkWalletConnections.revokedAt),
          ),
        )
        .returning();
      if (revoked) {
        await set(revokeWalletConnection$, {
          ...revoked,
          encryptedCredentials,
        });
      }
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CHANGED",
        "Wallet authorization changed; reconnect before continuing",
      );
    }
    return { connection: saved, token: refreshed.access_token, credentials };
  },
);

const walletAccess$ = command(
  async (
    { get, set },
    owner: WalletOwner,
    permission: WalletPermission,
    signal: AbortSignal,
  ): Promise<{
    connection: Connection;
    token: string;
    credentials: z.infer<typeof linkCredentialsSchema>;
  }> => {
    const connection = await get(connection$);
    signal.throwIfAborted();
    if (!connection?.encryptedCredentials || connection.revokedAt) {
      throw new LinkWalletError(
        409,
        "WALLET_CONNECT_REQUIRED",
        "Connect your Link wallet first",
      );
    }
    const encryptedCredentials = connection.encryptedCredentials;
    const plaintext = await decryptStoredSecretValue(encryptedCredentials);
    signal.throwIfAborted();
    const credentials = linkCredentialsSchema.parse(
      JSON.parse(plaintext) as unknown,
    );
    if (credentials.expiresAt > now() + 60_000) {
      requireWalletPermission(credentials, permission);
      return { connection, token: credentials.accessToken, credentials };
    }
    const refreshed = await set(refreshWalletConnection$, {
      owner,
      connection: { ...connection, encryptedCredentials },
      refreshToken: credentials.refreshToken,
      readOnly: credentials.readOnly,
    });
    signal.throwIfAborted();
    requireWalletPermission(refreshed.credentials, permission);
    return refreshed;
  },
);

const revokeWalletConnection$ = command(
  async (
    { set },
    connection: Connection & { readonly encryptedCredentials: string },
  ) => {
    const credentials = linkCredentialsSchema.parse(
      JSON.parse(
        await decryptStoredSecretValue(connection.encryptedCredentials),
      ) as unknown,
    );
    await revokeWalletToken(credentials.refreshToken);
    const db = set(writeDb$);
    const [confirmed] = await db
      .update(linkWalletConnections)
      .set({ encryptedCredentials: null, revocationConfirmedAt: nowDate() })
      .where(
        and(
          eq(linkWalletConnections.id, connection.id),
          eq(linkWalletConnections.authorizationId, connection.authorizationId),
          eq(
            linkWalletConnections.encryptedCredentials,
            connection.encryptedCredentials,
          ),
          isNotNull(linkWalletConnections.revokedAt),
        ),
      )
      .returning({ id: linkWalletConnections.id });
    if (!confirmed) {
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CHANGED",
        "Wallet authorization changed during revocation; check status before continuing",
      );
    }
    await publishWalletChanged(connection);
  },
);

const cancelWalletOAuthAttempts$ = command(
  async ({ set }, owner: WalletOwner) => {
    await set(writeDb$)
      .delete(linkWalletOAuthAttempts)
      .where(
        and(
          eq(linkWalletOAuthAttempts.orgId, owner.orgId),
          eq(linkWalletOAuthAttempts.userId, owner.userId),
        ),
      );
  },
);

export const disconnectWallet$ = command(
  async ({ set }, owner: WalletOwner, signal: AbortSignal) => {
    const db = set(writeDb$);
    await set(cancelWalletOAuthAttempts$, owner);
    signal.throwIfAborted();
    // Disable locally before provider I/O, retaining encrypted material solely so
    // a failed provider revocation can be retried through this same endpoint.
    const connections = await db
      .update(linkWalletConnections)
      .set({ revokedAt: nowDate() })
      .where(
        and(
          eq(linkWalletConnections.orgId, owner.orgId),
          eq(linkWalletConnections.userId, owner.userId),
        ),
      )
      .returning();
    signal.throwIfAborted();
    await publishWalletChanged(owner);
    signal.throwIfAborted();
    for (const connection of connections) {
      if (connection.revocationConfirmedAt) {
        continue;
      }
      if (!connection.encryptedCredentials) {
        throw new LinkWalletError(
          503,
          "WALLET_REVOCATION_UNCONFIRMED",
          "Wallet access is disabled locally, but Link revocation could not be confirmed; retry after the in-flight operation or revoke access in Link settings",
        );
      }
      await set(revokeWalletConnection$, {
        ...connection,
        encryptedCredentials: connection.encryptedCredentials,
      });
      signal.throwIfAborted();
      recordWalletConnectionUsage(
        owner,
        connection.authorizationId,
        "connection_revoked",
      );
    }
    return { disconnected: true as const };
  },
);

function validateSpend(row: Spend, remote: LinkSpend): void {
  if (
    (row.providerSpendId && remote.id !== row.providerSpendId) ||
    remote.amount !== row.amount ||
    remote.currency !== row.currency ||
    remote.merchant_name !== row.merchantName ||
    remote.merchant_url !== row.merchantUrl
  ) {
    throw new LinkWalletError(
      409,
      "WALLET_APPROVAL_MISMATCH",
      "The purchase no longer matches its amount, currency or merchant; obtain new approval",
    );
  }
}

function spendNextAction(
  state: string,
  resolution: string | null | undefined,
): WalletSpend["nextAction"] {
  switch (state) {
    case "approved": {
      return "retrieve_credentials";
    }
    case "succeeded": {
      return "verify_order";
    }
    case "submitted": {
      return "payment_pending";
    }
    case "pending_approval": {
      return "wait_for_user";
    }
    case "creating":
    case "created": {
      return "check_status";
    }
    case "requires_action": {
      return resolution === "auto_resume"
        ? "wait_for_user"
        : "new_approval_required";
    }
    default: {
      return "stop";
    }
  }
}

function publicSpend(row: Spend, remote?: LinkSpend): WalletSpend {
  const state = remote?.status ?? row.status;
  const next = remote?.status_details?.requires_action?.next_action;
  const action = next
    ? {
        type: next.type,
        resolution: next.resolution,
        url: next.action_url ? linkActionUrl(next.action_url) : null,
      }
    : null;
  const nextAction = spendNextAction(
    state,
    action?.resolution ?? row.actionResolution,
  );
  return walletSpendSchema.parse({
    id: row.id,
    intentId: row.intentId,
    status: state,
    amount: row.amount,
    currency: row.currency,
    merchantName: row.merchantName,
    merchantUrl: row.merchantUrl,
    context: row.context,
    test: row.test,
    approvalUrl: state === "pending_approval" ? row.approvalUrl : null,
    expiresAt: row.expiresAt.toISOString(),
    autoContinue:
      Boolean(row.approvalThreadId) &&
      row.expiresAt.getTime() > now() &&
      ["check_status", "wait_for_user", "retrieve_credentials"].includes(
        nextAction,
      ),
    createdAt: row.createdAt.toISOString(),
    payment: remote?.payment_status_details,
    paymentHistory: remote?.payment_history,
    nextAction,
    action,
  });
}

const saveProviderSpend$ = command(
  async ({ set }, row: Spend, remote: LinkSpend): Promise<Spend> => {
    validateSpend(row, remote);
    const approvalUrl = remote.approval_url
      ? linkActionUrl(remote.approval_url)
      : row.approvalUrl;
    const db = set(writeDb$);
    const [saved] = await db
      .update(linkWalletSpends)
      .set({
        providerSpendId: remote.id,
        status: remote.status,
        approvalUrl,
        actionResolution:
          remote.status_details?.requires_action?.next_action.resolution ??
          null,
      })
      .where(eq(linkWalletSpends.id, row.id))
      .returning();
    if (!saved) {
      throw new LinkWalletError(
        404,
        "WALLET_SPEND_NOT_FOUND",
        "Spend request not found",
      );
    }
    recordWalletSpendUsage(saved, "spend_status_observed", remote.status);
    if (
      saved.approvalThreadId &&
      (saved.status !== row.status ||
        saved.actionResolution !== row.actionResolution)
    ) {
      await publishUserSignal([saved.userId], "wallet:changed", {
        orgId: saved.orgId,
      } satisfies WalletChangedPayload);
    }
    return saved;
  },
);

function validateSpendIntent(
  existing: Spend | undefined,
  input: WalletCreateSpend,
  owner: WalletRunOwner,
  authorizationId: string,
): asserts existing is Spend {
  if (
    !existing ||
    existing.authorizationId !== authorizationId ||
    existing.amount !== input.amount ||
    existing.currency !== input.currency ||
    existing.merchantName !== input.merchantName ||
    existing.merchantUrl !== input.merchantUrl ||
    existing.context !== input.context ||
    existing.test !== input.test
  ) {
    throw new LinkWalletError(
      409,
      "WALLET_INTENT_CONFLICT",
      "This purchase intent is bound to different approval details; do not change or blindly replace it",
    );
  }
  requireApprovalThread(existing, owner);
}

export const createWalletSpend$ = command(
  async (
    { set },
    owner: WalletRunOwner,
    input: WalletCreateSpend,
    signal: AbortSignal,
  ): Promise<WalletSpend> => {
    const access = await set(walletAccess$, owner, "payments", signal);
    signal.throwIfAborted();
    const autoContinue =
      Boolean(owner.runId && owner.chatThreadId) &&
      (await set(linkApprovalEnabled$, owner, signal));
    signal.throwIfAborted();
    const db = set(writeDb$);
    const [created] = await db
      .insert(linkWalletSpends)
      .values({
        orgId: owner.orgId,
        userId: owner.userId,
        agentId: owner.agentId,
        ...input,
        approvalThreadId: autoContinue ? owner.chatThreadId : null,
        approvalRunId: autoContinue ? owner.runId : null,
        connectionId: access.connection.id,
        authorizationId: access.connection.authorizationId,
        expiresAt: new Date(now() + 30 * 60_000),
      })
      .onConflictDoNothing({
        target: [
          linkWalletSpends.orgId,
          linkWalletSpends.userId,
          linkWalletSpends.agentId,
          linkWalletSpends.intentId,
        ],
      })
      .returning();
    signal.throwIfAborted();
    if (created) {
      recordWalletSpendUsage(created, "spend_requested", "creating");
    }
    const [existing] = created
      ? [created]
      : await db
          .select()
          .from(linkWalletSpends)
          .where(
            and(
              spendOwner(owner),
              eq(linkWalletSpends.intentId, input.intentId),
            ),
          )
          .limit(1);
    signal.throwIfAborted();
    validateSpendIntent(
      existing,
      input,
      owner,
      access.connection.authorizationId,
    );
    if (existing.providerSpendId) {
      const spend = await set(
        readProviderSpend$,
        existing,
        access,
        "resume_approval",
        signal,
      );
      return { ...spend, autoContinue: spend.autoContinue && autoContinue };
    }
    if (existing.expiresAt.getTime() <= now()) {
      return publicSpend({ ...existing, status: "expired" });
    }
    const remote = await linkSpendRequest(
      access.token,
      {
        operation: "spend_create",
        intentId: existing.intentId,
        body: {
          idempotency_key: `okou_wallet_${existing.id}`,
          amount: existing.amount,
          currency: existing.currency,
          merchant_name: existing.merchantName,
          merchant_url: existing.merchantUrl,
          context: existing.context,
          credential_type: "card",
          request_approval: true,
          test: existing.test,
          totals: [
            { type: "total", display_text: "Total", amount: existing.amount },
          ],
        },
      },
      signal,
    );
    let saved = await set(saveProviderSpend$, existing, remote);
    signal.throwIfAborted();
    if (
      ["created", "pending_approval"].includes(remote.status) &&
      !saved.approvalUrl
    ) {
      const approvalUrl = await requestLinkApproval(
        access.token,
        remote.id,
        existing.intentId,
        signal,
      );
      saved = await set(saveProviderSpend$, saved, {
        ...remote,
        status: "pending_approval",
        approval_url: approvalUrl,
      });
      signal.throwIfAborted();
    }
    const spend = publicSpend(saved, {
      ...remote,
      status:
        saved.status === "pending_approval"
          ? "pending_approval"
          : remote.status,
    });
    return { ...spend, autoContinue: spend.autoContinue && autoContinue };
  },
);

const walletSpendAccess$ = command(
  async ({ set }, owner: WalletRunOwner, id: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [row] = await db
      .select()
      .from(linkWalletSpends)
      .where(and(spendOwner(owner), eq(linkWalletSpends.id, id)))
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      throw new LinkWalletError(
        404,
        "WALLET_SPEND_NOT_FOUND",
        "Spend request not found",
      );
    }
    const access = await set(walletAccess$, owner, "payments", signal);
    signal.throwIfAborted();
    if (row.authorizationId !== access.connection.authorizationId) {
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CHANGED",
        "This purchase belongs to an earlier wallet authorization; do not retry payment",
      );
    }
    return { row, access };
  },
);

export const getWalletSpend$ = command(
  async (
    { set },
    owner: WalletRunOwner,
    id: string,
    cancel: boolean,
    signal: AbortSignal,
  ): Promise<WalletSpend> => {
    const { row, access } = await set(walletSpendAccess$, owner, id, signal);
    signal.throwIfAborted();
    if (cancel) {
      requireApprovalThread(row, owner);
    }
    const result = await set(
      readProviderSpend$,
      row,
      access,
      cancel ? "cancel" : "inspect",
      signal,
    );
    signal.throwIfAborted();
    await set(
      verifyWalletReadAccess$,
      owner,
      access.connection.authorizationId,
      "payments",
      signal,
    );
    if (result.status === "approved" || cancel) {
      await set(takeOverWalletApproval$, row, owner, signal);
      signal.throwIfAborted();
    }
    if (!owner.runId) {
      return result;
    }
    const autoContinue =
      Boolean(
        result.autoContinue &&
        result.status !== "approved" &&
        row.approvalThreadId === owner.chatThreadId,
      ) && (await set(linkApprovalEnabled$, owner, signal));
    signal.throwIfAborted();
    return { ...result, autoContinue };
  },
);

export const getWalletSpendCredentials$ = command(
  async (
    { set },
    owner: WalletRunOwner,
    id: string,
    signal: AbortSignal,
  ): Promise<WalletSpendCredentials> => {
    const { row, access } = await set(walletSpendAccess$, owner, id, signal);
    if (!row.providerSpendId) {
      throw new LinkWalletError(
        409,
        "WALLET_SPEND_NOT_APPROVED",
        "The purchase is still being created; check its existing status before retrieving credentials",
      );
    }
    const approved = await linkSpendRequest(
      access.token,
      {
        operation: "spend_read",
        id: row.providerSpendId,
        intentId: row.intentId,
      },
      signal,
    );
    await set(saveProviderSpend$, row, approved);
    signal.throwIfAborted();
    requireApproved(approved);
    await set(takeOverWalletApproval$, row, owner, signal);
    signal.throwIfAborted();

    const result = await retrieveLinkSpendCredentials(
      access.token,
      row.providerSpendId,
      row.intentId,
      signal,
    );
    const saved = await set(saveProviderSpend$, row, result.spend);
    signal.throwIfAborted();
    requireApproved(result.spend);
    if (!result.card) {
      throw new LinkWalletError(
        409,
        "WALLET_CREDENTIALS_UNAVAILABLE",
        "Link has not made card credentials available for this approved purchase; check the same request before retrying",
      );
    }
    if (result.card.validUntil && Date.parse(result.card.validUntil) <= now()) {
      throw new LinkWalletError(
        409,
        "WALLET_CREDENTIALS_EXPIRED",
        "The payment credentials have expired; obtain a new purchase approval",
      );
    }
    // A disconnect or replacement consent during provider I/O must not release
    // credentials from the old grant. Card data is never stored in our database.
    const [current] = await set(writeDb$)
      .select({ id: linkWalletConnections.id })
      .from(linkWalletConnections)
      .where(
        and(
          connectionOwner(owner),
          eq(linkWalletConnections.authorizationId, row.authorizationId),
          isNull(linkWalletConnections.revokedAt),
          isNotNull(linkWalletConnections.encryptedCredentials),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CHANGED",
        "Wallet authorization changed while retrieving credentials; check wallet status before continuing",
      );
    }
    const credentials = walletSpendCredentialsSchema.parse({
      spend: { ...publicSpend(saved, result.spend), autoContinue: false },
      card: result.card,
    });
    recordWalletSpendUsage(
      saved,
      "credentials_retrieved",
      credentials.spend.status,
    );
    return credentials;
  },
);

function requireApproved(spend: LinkSpend): void {
  if (spend.status !== "approved") {
    throw new LinkWalletError(
      409,
      "WALLET_SPEND_NOT_APPROVED",
      `Payment credentials require an approved purchase; current Link status: ${spend.status}. Check the existing request before continuing`,
    );
  }
}

const readProviderSpend$ = command(
  async (
    { set },
    row: Spend,
    access: { readonly token: string },
    operation: "inspect" | "cancel" | "resume_approval",
    signal: AbortSignal,
  ): Promise<WalletSpend> => {
    if (!row.providerSpendId) {
      return publicSpend(row);
    }
    // Never request include=card or any payment token. Approval is not payment.
    let remote = await linkSpendRequest(
      access.token,
      {
        operation: "spend_read",
        id: row.providerSpendId,
        intentId: row.intentId,
      },
      signal,
    );
    validateSpend(row, remote);
    if (operation === "cancel") {
      if (
        !["created", "pending_approval", "approved"].includes(remote.status)
      ) {
        throw new LinkWalletError(
          409,
          "WALLET_CANNOT_CANCEL",
          "This request cannot safely be canceled; inspect its existing outcome",
        );
      }
      remote = await linkSpendRequest(
        access.token,
        {
          operation: "spend_cancel",
          id: row.providerSpendId,
          intentId: row.intentId,
        },
        signal,
      );
    }
    let saved = await set(saveProviderSpend$, row, remote);
    signal.throwIfAborted();
    if (
      operation === "resume_approval" &&
      ["created", "pending_approval"].includes(remote.status) &&
      !saved.approvalUrl
    ) {
      const approvalUrl = await requestLinkApproval(
        access.token,
        remote.id,
        row.intentId,
        signal,
      );
      saved = await set(saveProviderSpend$, saved, {
        ...remote,
        status: "pending_approval",
        approval_url: approvalUrl,
      });
      signal.throwIfAborted();
      remote = { ...remote, status: "pending_approval" };
    }
    return publicSpend(saved, remote);
  },
);

const verifyWalletReadAccess$ = command(
  async (
    { get },
    owner: WalletOwner,
    authorizationId: string,
    permission: WalletPermission,
    signal: AbortSignal,
  ) => {
    const [current] = await get(db$)
      .select({
        encryptedCredentials: linkWalletConnections.encryptedCredentials,
      })
      .from(linkWalletConnections)
      .where(
        and(
          connectionOwner(owner),
          eq(linkWalletConnections.authorizationId, authorizationId),
          isNull(linkWalletConnections.revokedAt),
          isNotNull(linkWalletConnections.encryptedCredentials),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!current?.encryptedCredentials) {
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CHANGED",
        "Wallet authorization changed during the query; check wallet status before retrying",
      );
    }
    const credentials = linkCredentialsSchema.parse(
      JSON.parse(
        await decryptStoredSecretValue(current.encryptedCredentials),
      ) as unknown,
    );
    signal.throwIfAborted();
    requireWalletPermission(credentials, permission);
  },
);

export const readWallet$ = command(
  async (
    { set },
    owner: WalletOwner,
    request: LinkWalletReadRequest,
    signal: AbortSignal,
  ) => {
    const permission =
      request.operation === "transactions_read"
        ? "transactions"
        : request.operation === "user_info_read"
          ? "userInfo"
          : "paymentMethods";
    const access = await set(walletAccess$, owner, permission, signal);
    signal.throwIfAborted();
    const data = await readLinkWallet(access.token, request, signal);
    signal.throwIfAborted();
    await set(
      verifyWalletReadAccess$,
      owner,
      access.connection.authorizationId,
      permission,
      signal,
    );
    return data;
  },
);

export const listWalletSpends$ = command(
  async (
    { get, set },
    owner: WalletRunOwner,
    query: WalletSpendListQuery,
    signal: AbortSignal,
  ) => {
    const access = await set(walletAccess$, owner, "spendHistory", signal);
    signal.throwIfAborted();
    const db = get(db$);
    const limit = query.limit ?? 20;
    const [cursor] = query.startingAfter
      ? await db
          .select({
            id: linkWalletSpends.id,
            createdAt: linkWalletSpends.createdAt,
          })
          .from(linkWalletSpends)
          .where(
            and(
              spendOwner(owner),
              eq(linkWalletSpends.id, query.startingAfter),
            ),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    if (query.startingAfter && !cursor) {
      throw new LinkWalletError(
        400,
        "WALLET_INVALID_CURSOR",
        "The pagination cursor is not available for this wallet",
      );
    }
    const rows = await db
      .select()
      .from(linkWalletSpends)
      .where(
        and(
          spendOwner(owner),
          query.startDate
            ? gte(
                linkWalletSpends.createdAt,
                new Date(`${query.startDate}T00:00:00Z`),
              )
            : undefined,
          query.endDate
            ? lt(
                linkWalletSpends.createdAt,
                new Date(
                  new Date(`${query.endDate}T00:00:00Z`).getTime() + 86_400_000,
                ),
              )
            : undefined,
          query.status ? eq(linkWalletSpends.status, query.status) : undefined,
          query.mode && query.mode !== "all"
            ? eq(linkWalletSpends.test, query.mode === "test")
            : undefined,
          cursor
            ? or(
                lt(linkWalletSpends.createdAt, cursor.createdAt),
                and(
                  eq(linkWalletSpends.createdAt, cursor.createdAt),
                  lt(linkWalletSpends.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(linkWalletSpends.createdAt), desc(linkWalletSpends.id))
      .limit(limit + 1);
    signal.throwIfAborted();
    await set(
      verifyWalletReadAccess$,
      owner,
      access.connection.authorizationId,
      "spendHistory",
      signal,
    );
    const data = rows.slice(0, limit).map((row) => {
      return {
        id: row.id,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        merchantName: row.merchantName,
        test: row.test,
        createdAt: row.createdAt.toISOString(),
        statusSource: "recorded" as const,
        canRefresh:
          row.authorizationId === access.connection.authorizationId &&
          walletAuthorization(access.credentials).capabilities.payments,
      };
    });
    return {
      data,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null,
    };
  },
);
