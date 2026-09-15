import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderAccounts,
  modelProviderAccountSecrets,
} from "@okouai/db/schema/model-provider-account";
import { secrets } from "@okouai/db/schema/secret";
import { db } from "../lib/db";
import { createStore } from "ccstate";
import { createTestFixtureAgentRun$ } from "../signals/services/agent-runs-create.service";
import { now, nowDate } from "../lib/time";
import { decryptStoredSecretValue } from "../signals/services/crypto.utils";
import { encryptSecretForTests } from "../signals/routes/__tests__/helpers/encrypt-secret";

type HistoricalWriterOwner = {
  readonly orgId: string | null;
  readonly userId: string;
};
function fixtureOwner(owner: HistoricalWriterOwner) {
  if (
    !owner.orgId ||
    !/^org_[0-9a-f-]{36}$/.test(owner.orgId) ||
    !/^user_[0-9a-f-]{36}$/.test(owner.userId)
  ) {
    throw new Error(
      "Historical writers require a unique test-owned user and organization",
    );
  }
  return { orgId: owner.orgId, userId: owner.userId };
}

/** Infrastructure exception: no API runs the bounded KMS migration. Reproduce
 * its independent encrypted-cell CAS updates in both stores for a test-owned
 * subscription, preserving the complete plaintext and all identity/state. */
export async function reencryptSubscriptionStoresFixture(
  owner: HistoricalWriterOwner,
  type: "claude-code-oauth-token" | "codex-oauth-token",
) {
  const owned = fixtureOwner(owner);
  const mirror = await db()
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, owned.orgId),
        eq(secrets.userId, owned.userId),
        eq(secrets.type, "model-provider"),
        inArray(
          secrets.name,
          type === "claude-code-oauth-token"
            ? ["CLAUDE_CODE_OAUTH_TOKEN"]
            : [
                "CHATGPT_ACCESS_TOKEN",
                "CHATGPT_REFRESH_TOKEN",
                "CHATGPT_ACCOUNT_ID",
                "CHATGPT_ID_TOKEN",
              ],
        ),
      ),
    );
  const accounts = await db()
    .select({ id: modelProviderAccounts.id })
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.orgId, owned.orgId),
        eq(modelProviderAccounts.userId, owned.userId),
        eq(modelProviderAccounts.type, type),
      ),
    );
  if (accounts.length === 0 || mirror.length === 0) {
    throw new Error("Expected both test-owned subscription stores");
  }
  const accountSecrets = await db()
    .select()
    .from(modelProviderAccountSecrets)
    .where(
      inArray(
        modelProviderAccountSecrets.modelProviderAccountId,
        accounts.map((account) => {
          return account.id;
        }),
      ),
    );
  for (const row of mirror) {
    const encryptedValue = encryptSecretForTests(
      await decryptStoredSecretValue(row.encryptedValue, owned),
    );
    await db()
      .update(secrets)
      .set({ encryptedValue })
      .where(
        and(
          eq(secrets.id, row.id),
          eq(secrets.encryptedValue, row.encryptedValue),
        ),
      );
  }
  for (const row of accountSecrets) {
    const encryptedValue = encryptSecretForTests(
      await decryptStoredSecretValue(row.encryptedValue, owned),
    );
    await db()
      .update(modelProviderAccountSecrets)
      .set({ encryptedValue })
      .where(
        and(
          eq(modelProviderAccountSecrets.id, row.id),
          eq(modelProviderAccountSecrets.encryptedValue, row.encryptedValue),
        ),
      );
  }
}

/** Infrastructure exception: current endpoints cannot execute the immutable
 * API 1.595.0 server writer (17de21316e0db0208fea94512b932776f2a3c402).
 * Only these explicitly named fixtures manufacture historical artifact state.
 * Assertions belong to production APIs and actual provider HTTP requests.
 * The Claude writer has TWO AUTOCOMMITS and NO advisory lock. Keeping the
 * provider INSERT/ON CONFLICT + secret FK is essential to its lock graph. */
export async function historicalClaudeSecretFirstFixture(
  owner: HistoricalWriterOwner,
  input: { readonly accessToken: string; readonly workspaceName: string },
) {
  const owned = fixtureOwner(owner);
  const encryptedValue = encryptSecretForTests(input.accessToken);
  const [secret] = await db()
    .insert(secrets)
    .values({
      ...owned,
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      type: "model-provider",
      encryptedValue,
      description: "Historical Claude single-secret writer fixture",
    })
    .onConflictDoUpdate({
      target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
      targetWhere: isNull(secrets.connectorId),
      set: { encryptedValue, updatedAt: nowDate() },
    })
    .returning();
  if (!secret) {
    throw new Error("Expected the historical secret upsert");
  }
  return {
    async completeProviderWrite() {
      const [provider] = await db()
        .insert(modelProviders)
        .values({
          ...owned,
          type: "claude-code-oauth-token",
          secretId: secret.id,
          isDefault: false,
          selectedModel: null,
          workspaceName: input.workspaceName,
        })
        .onConflictDoUpdate({
          target: [
            modelProviders.orgId,
            modelProviders.userId,
            modelProviders.type,
          ],
          set: {
            secretId: secret.id,
            selectedModel: null,
            workspaceName: input.workspaceName,
            needsReconnect: false,
            lastRefreshErrorCode: null,
            updatedAt: nowDate(),
          },
        })
        .returning({ id: modelProviders.id });
      if (!provider) {
        throw new Error("Expected the historical provider upsert");
      }
      return provider.id;
    },
  };
}

/** Actual old Codex connection shape: provider advisory lock, secret upserts,
 * then provider upsert in ONE transaction. No concrete-account writes. */
export async function historicalCodexReconnectFixture(
  owner: HistoricalWriterOwner,
  input: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly accountId: string;
    readonly idToken: string;
    readonly expiresAt: Date;
  },
) {
  const owned = fixtureOwner(owner);
  return await db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${owned.orgId} || ':' || ${owned.userId} || ':codex-oauth-token'))`,
    );
    for (const [name, value] of Object.entries({
      CHATGPT_ACCESS_TOKEN: input.accessToken,
      CHATGPT_REFRESH_TOKEN: input.refreshToken,
      CHATGPT_ACCOUNT_ID: input.accountId,
      CHATGPT_ID_TOKEN: input.idToken,
    })) {
      const encryptedValue = encryptSecretForTests(value);
      await tx
        .insert(secrets)
        .values({ ...owned, name, type: "model-provider", encryptedValue })
        .onConflictDoUpdate({
          target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
          targetWhere: isNull(secrets.connectorId),
          set: { encryptedValue, updatedAt: nowDate() },
        });
    }
    const [provider] = await tx
      .insert(modelProviders)
      .values({
        ...owned,
        type: "codex-oauth-token",
        authMethod: "auth_json",
        tokenExpiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [
          modelProviders.orgId,
          modelProviders.userId,
          modelProviders.type,
        ],
        set: {
          authMethod: "auth_json",
          tokenExpiresAt: input.expiresAt,
          needsReconnect: false,
          lastRefreshErrorCode: null,
          updatedAt: nowDate(),
        },
      })
      .returning({ id: modelProviders.id });
    if (!provider) {
      throw new Error("Expected the historical Codex upsert");
    }
    return provider.id;
  });
}

const refreshResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});
/** Real old sourceId-less refresh: shared lock + provider row + current rotating
 * input, actual provider HTTP, singleton-only output/state transaction. */
export async function historicalCodexRefreshFixture(
  owner: HistoricalWriterOwner,
  signal: AbortSignal,
) {
  const owned = fixtureOwner(owner);
  await db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${owned.orgId} || ':' || ${owned.userId} || ':codex-oauth-token'))`,
    );
    const [provider] = await tx
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, owned.orgId),
          eq(modelProviders.userId, owned.userId),
          eq(modelProviders.type, "codex-oauth-token"),
        ),
      )
      .for("update");
    if (!provider) {
      throw new Error("Historical refresh provider was removed");
    }
    const [secret] = await tx
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.orgId, owned.orgId),
          eq(secrets.userId, owned.userId),
          eq(secrets.type, "model-provider"),
          eq(secrets.name, "CHATGPT_REFRESH_TOKEN"),
        ),
      );
    if (!secret) {
      throw new Error("Historical refresh input was removed");
    }
    const response = await fetch("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        grant_type: "refresh_token",
        refresh_token: await decryptStoredSecretValue(
          secret.encryptedValue,
          owned,
        ),
      }),
      signal,
    });
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ code: z.string() }) })
        .parse(await response.json());
      await tx
        .update(modelProviders)
        .set({
          needsReconnect: true,
          lastRefreshErrorCode: error.error.code,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(modelProviders.id, provider.id));
      return;
    }
    const result = refreshResponse.parse(await response.json());
    for (const [name, value] of Object.entries({
      CHATGPT_ACCESS_TOKEN: result.access_token,
      CHATGPT_REFRESH_TOKEN: result.refresh_token,
    })) {
      const encryptedValue = encryptSecretForTests(value);
      await tx
        .insert(secrets)
        .values({ ...owned, name, type: "model-provider", encryptedValue })
        .onConflictDoUpdate({
          target: [secrets.orgId, secrets.userId, secrets.name, secrets.type],
          targetWhere: isNull(secrets.connectorId),
          set: { encryptedValue, updatedAt: nowDate() },
        });
    }
    await tx
      .update(modelProviders)
      .set({
        tokenExpiresAt: new Date(
          nowDate().getTime() + result.expires_in * 1000,
        ),
        needsReconnect: false,
        lastRefreshErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(modelProviders.id, provider.id));
  });
}

/** Old rollback deletion really cascades concrete credentials. No reupgrade
 * reader can recover those deleted bytes or their original run identity. */
export async function historicalDeleteSubscriptionFixture(
  owner: HistoricalWriterOwner,
  type: "codex-oauth-token" | "claude-code-oauth-token",
) {
  const owned = fixtureOwner(owner);
  await db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('model_provider_state:' || ${owned.orgId} || ':' || ${owned.userId} || ':' || ${type}))`,
    );
    await tx
      .delete(secrets)
      .where(
        and(
          eq(secrets.orgId, owned.orgId),
          eq(secrets.userId, owned.userId),
          eq(secrets.type, "model-provider"),
          inArray(
            secrets.name,
            type === "claude-code-oauth-token"
              ? ["CLAUDE_CODE_OAUTH_TOKEN"]
              : [
                  "CHATGPT_ACCESS_TOKEN",
                  "CHATGPT_REFRESH_TOKEN",
                  "CHATGPT_ACCOUNT_ID",
                  "CHATGPT_ID_TOKEN",
                ],
          ),
        ),
      );
    await tx
      .delete(modelProviders)
      .where(
        and(
          eq(modelProviders.orgId, owned.orgId),
          eq(modelProviders.userId, owned.userId),
          eq(modelProviders.type, type),
        ),
      );
  });
}

/** Infrastructure exception: current public model-first requests cannot name a
 * concrete provider ID. Replay a captured legacy internal admission through the
 * existing run fixture adapter; assert its claimed/authenticated runtime through
 * production APIs, never the capture helper's private return value. */
export async function createHistoricalPinnedSubscriptionRunFixture(
  args: {
    readonly owner: HistoricalWriterOwner;
    readonly agentId: string;
    readonly accountId: string;
    readonly sessionId?: string;
    readonly type: "claude-code-oauth-token" | "codex-oauth-token";
    readonly model: string;
  },
  signal: AbortSignal,
) {
  const owned = fixtureOwner(args.owner);
  return await createStore().set(
    createTestFixtureAgentRun$,
    {
      auth: { ...owned, tokenType: "session", orgRole: "admin" },
      body: {
        ...(args.sessionId
          ? { sessionId: args.sessionId }
          : { agentId: args.agentId }),
        prompt: "continue an exact historical subscription selection",
      },
      apiStartTime: now(),
      piExecution: false,
      modelProviderId: args.accountId,
      modelProviderCredentialScope: "member",
      selectedModelOverride: args.model,
      agentRunModelPin: {
        modelProvider: args.type,
        modelProviderId: args.accountId,
        modelProviderCredentialScope: "member",
        selectedModel: args.model,
      },
    },
    signal,
  );
}
