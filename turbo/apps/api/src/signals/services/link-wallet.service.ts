import { createHash, randomBytes } from "node:crypto";

import {
  type WalletCreateSpend,
  type WalletSpend,
  walletSpendSchema,
} from "@okouai/api-contracts/contracts/wallet";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/runtime/agent-session";
import {
  linkWalletConnections,
  linkWalletOAuthAttempts,
  linkWalletSpends,
} from "@okouai/db/schema/link-wallet";
import { command, computed } from "ccstate";
import { and, eq, gt, isNull, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { now, nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { organizationAuthContext$ } from "../auth/auth-context";
import { db$, writeDb$ } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  LinkWalletError,
  linkActionUrl,
  linkCredentialsSchema,
  linkSpendRequest,
  linkTokenRequest,
  linkWalletConfig,
  linkWalletRedirectUri,
  requestLinkApproval,
  revokeLinkToken,
  type LinkSpend,
} from "./link-wallet-provider.service";

export interface WalletOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
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
    eq(linkWalletConnections.agentId, owner.agentId),
  );
}
function spendOwner(owner: WalletOwner) {
  return and(
    eq(linkWalletSpends.orgId, owner.orgId),
    eq(linkWalletSpends.userId, owner.userId),
    eq(linkWalletSpends.agentId, owner.agentId),
  );
}

export const walletRunOwner$ = computed(async (get): Promise<WalletOwner> => {
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
      agentId: agentSessions.agentId,
      triggerSource: agentRuns.triggerSource,
      status: agentRuns.status,
    })
    .from(agentRuns)
    .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
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
  return { orgId: auth.orgId, userId: auth.userId, agentId: run.agentId };
});

const connection$ = computed(async (get): Promise<Connection | undefined> => {
  const owner = await get(walletRunOwner$);
  const db = get(db$);
  const [row] = await db
    .select()
    .from(linkWalletConnections)
    .where(connectionOwner(owner))
    .limit(1);
  return row;
});

export const walletStatus$ = computed(async (get) => {
  const row = await get(connection$);
  const connected = Boolean(row?.encryptedCredentials && !row.revokedAt);
  return {
    connected,
    nextAction: connected ? ("create_spend" as const) : ("connect" as const),
    checkoutAvailable: false as const,
  };
});

export const startWalletOAuth$ = command(
  async ({ set }, owner: WalletOwner, signal: AbortSignal) => {
    const config = linkWalletConfig();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const expiresAt = new Date(now() + 30 * 60_000);
    const encryptedVerifier = await encryptStoredSecretValue(verifier);
    signal.throwIfAborted();
    const db = set(writeDb$);
    await db.insert(linkWalletOAuthAttempts).values({
      ...owner,
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
      scope: "payment_methods.agentic userinfo:read",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    })) {
      url.searchParams.set(key, value);
    }
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
      return {
        status: "error" as const,
        message: "Link wallet authorization was not completed",
      };
    }
    const verifier = await decryptStoredSecretValue(attempt.encryptedVerifier);
    signal.throwIfAborted();
    const token = await linkTokenRequest(
      {
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: verifier,
        redirect_uri: linkWalletRedirectUri(),
      },
      signal,
    );
    const result = await set(publishWalletOAuth$, { attempt, token });
    signal.throwIfAborted();
    return result;
  },
);

// Finish publishing or revoking a received grant before observing cancellation.
const publishWalletOAuth$ = command(
  async (
    { set },
    input: {
      readonly attempt: typeof linkWalletOAuthAttempts.$inferSelect;
      readonly token: {
        readonly access_token: string;
        readonly refresh_token: string;
        readonly expires_in: number;
      };
    },
  ) => {
    const { attempt, token } = input;
    const encryptedCredentials = await encryptStoredSecretValue(
      JSON.stringify({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: now() + token.expires_in * 1000,
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
        DELETE FROM ${linkWalletOAuthAttempts}
        WHERE id = ${attempt.id} AND status = 'exchanging'
          AND expires_at > ${nowDate()}
        RETURNING org_id, user_id, agent_id, id
      )
      INSERT INTO ${linkWalletConnections}
        (org_id, user_id, agent_id, authorization_id, encrypted_credentials)
      SELECT org_id, user_id, agent_id, id, ${encryptedCredentials} FROM authorized
      ON CONFLICT (org_id, user_id, agent_id) DO UPDATE
      SET authorization_id = EXCLUDED.authorization_id,
          encrypted_credentials = EXCLUDED.encrypted_credentials, revoked_at = NULL,
          revocation_confirmed_at = NULL
      RETURNING id
    `),
    );
    if (result.length === 0) {
      await revokeLinkToken(token.refresh_token, AbortSignal.timeout(15_000));
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CANCELED",
        "Wallet authorization was canceled or expired; connect again",
      );
    }
    return { status: "success" as const, username: null };
  },
);

// Refresh and persistence are one awaited, bounded operation. Caller cancellation
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
    },
  ): Promise<{ connection: Connection; token: string }> => {
    const { owner, connection } = input;
    const db = set(writeDb$);
    // Consume the one-time refresh credential before the remote effect. Only a
    // returned row may use it; failures require reconnecting, never blind reuse.
    const [consumed] = await db
      .update(linkWalletConnections)
      .set({ encryptedCredentials: null })
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
    if (!consumed) {
      throw new LinkWalletError(
        409,
        "WALLET_RECONNECT_REQUIRED",
        "Wallet authorization changed; check status or reconnect",
      );
    }
    const refreshed = await linkTokenRequest(
      { grant_type: "refresh_token", refresh_token: input.refreshToken },
      AbortSignal.timeout(15_000),
    );
    const encryptedCredentials = await encryptStoredSecretValue(
      JSON.stringify({
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: now() + refreshed.expires_in * 1000,
      }),
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
          isNull(linkWalletConnections.encryptedCredentials),
          isNull(linkWalletConnections.revokedAt),
        ),
      )
      .returning();
    if (!saved) {
      // If disconnect won while refresh was in flight, retain the rotated token
      // only for revocation. It cannot authorize access while revokedAt is set.
      const [revoked] = await db
        .update(linkWalletConnections)
        .set({ encryptedCredentials })
        .where(
          and(
            connectionOwner(owner),
            eq(
              linkWalletConnections.authorizationId,
              connection.authorizationId,
            ),
            isNull(linkWalletConnections.encryptedCredentials),
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
    return { connection: saved, token: refreshed.access_token };
  },
);

const walletAccess$ = command(
  async (
    { get, set },
    owner: WalletOwner,
    signal: AbortSignal,
  ): Promise<{ connection: Connection; token: string }> => {
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
      return { connection, token: credentials.accessToken };
    }
    const refreshed = await set(refreshWalletConnection$, {
      owner,
      connection: { ...connection, encryptedCredentials },
      refreshToken: credentials.refreshToken,
    });
    signal.throwIfAborted();
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
    await revokeLinkToken(
      credentials.refreshToken,
      AbortSignal.timeout(15_000),
    );
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
  },
);

export const disconnectWallet$ = command(
  async ({ set }, owner: WalletOwner, signal: AbortSignal) => {
    const db = set(writeDb$);
    await db
      .delete(linkWalletOAuthAttempts)
      .where(
        and(
          eq(linkWalletOAuthAttempts.orgId, owner.orgId),
          eq(linkWalletOAuthAttempts.userId, owner.userId),
          eq(linkWalletOAuthAttempts.agentId, owner.agentId),
        ),
      );
    signal.throwIfAborted();
    // Disable locally before provider I/O, retaining encrypted material solely so
    // a failed provider revocation can be retried through this same endpoint.
    const [connection] = await db
      .update(linkWalletConnections)
      .set({ revokedAt: nowDate() })
      .where(connectionOwner(owner))
      .returning();
    signal.throwIfAborted();
    if (connection && !connection.revocationConfirmedAt) {
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
  const nextAction =
    state === "approved"
      ? "secure_checkout_unavailable"
      : state === "succeeded"
        ? "verify_order"
        : state === "submitted"
          ? "payment_pending"
          : state === "pending_approval"
            ? "wait_for_user"
            : state === "creating" || state === "created"
              ? "check_status"
              : state === "requires_action"
                ? action?.resolution === "auto_resume"
                  ? "wait_for_user"
                  : "new_approval_required"
                : "stop";
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
      .set({ providerSpendId: remote.id, status: remote.status, approvalUrl })
      .where(eq(linkWalletSpends.id, row.id))
      .returning();
    if (!saved) {
      throw new LinkWalletError(
        404,
        "WALLET_SPEND_NOT_FOUND",
        "Spend request not found",
      );
    }
    return saved;
  },
);

export const createWalletSpend$ = command(
  async (
    { set },
    owner: WalletOwner,
    input: WalletCreateSpend,
    signal: AbortSignal,
  ): Promise<WalletSpend> => {
    const access = await set(walletAccess$, owner, signal);
    signal.throwIfAborted();
    const db = set(writeDb$);
    const [created] = await db
      .insert(linkWalletSpends)
      .values({
        ...owner,
        ...input,
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
    if (
      !existing ||
      existing.authorizationId !== access.connection.authorizationId ||
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
    if (existing.providerSpendId) {
      return await set(readProviderSpend$, existing, access, false, signal);
    }
    if (existing.expiresAt.getTime() <= now()) {
      return publicSpend({ ...existing, status: "expired" });
    }
    const remote = await linkSpendRequest(
      access.token,
      "",
      "POST",
      {
        idempotency_key: `okou_wallet_${existing.id}`,
        amount: existing.amount,
        currency: existing.currency,
        merchant_name: existing.merchantName,
        merchant_url: existing.merchantUrl,
        context: existing.context,
        credential_type: "card",
        request_approval: true,
        test: existing.test,
        expires_at: Math.floor(existing.expiresAt.getTime() / 1000),
        totals: [
          { type: "total", display_text: "Total", amount: existing.amount },
        ],
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
        signal,
      );
      saved = await set(saveProviderSpend$, saved, {
        ...remote,
        status: "pending_approval",
        approval_url: approvalUrl,
      });
      signal.throwIfAborted();
    }
    return publicSpend(saved, {
      ...remote,
      status:
        saved.status === "pending_approval"
          ? "pending_approval"
          : remote.status,
    });
  },
);

export const getWalletSpend$ = command(
  async (
    { set },
    owner: WalletOwner,
    id: string,
    cancel: boolean,
    signal: AbortSignal,
  ): Promise<WalletSpend> => {
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
    const access = await set(walletAccess$, owner, signal);
    signal.throwIfAborted();
    if (row.authorizationId !== access.connection.authorizationId) {
      throw new LinkWalletError(
        409,
        "WALLET_AUTHORIZATION_CHANGED",
        "This purchase belongs to an earlier wallet authorization; do not retry payment",
      );
    }
    return await set(readProviderSpend$, row, access, cancel, signal);
  },
);

const readProviderSpend$ = command(
  async (
    { set },
    row: Spend,
    access: { readonly token: string },
    cancel: boolean,
    signal: AbortSignal,
  ): Promise<WalletSpend> => {
    if (!row.providerSpendId) {
      return publicSpend(row);
    }
    // Never request include=card or any payment token. Approval is not payment.
    let remote = await linkSpendRequest(
      access.token,
      `/${encodeURIComponent(row.providerSpendId)}`,
      "GET",
      undefined,
      signal,
    );
    validateSpend(row, remote);
    if (cancel) {
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
        `/${encodeURIComponent(row.providerSpendId)}/cancel`,
        "POST",
        undefined,
        signal,
      );
    }
    let saved = await set(saveProviderSpend$, row, remote);
    signal.throwIfAborted();
    if (
      !cancel &&
      ["created", "pending_approval"].includes(remote.status) &&
      !saved.approvalUrl
    ) {
      const approvalUrl = await requestLinkApproval(
        access.token,
        remote.id,
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
