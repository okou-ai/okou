import { and, eq, inArray, sql } from "drizzle-orm";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectors } from "@okouai/db/schema/connector";
import type { Db } from "../external/db";
import { nowDate } from "../../lib/time";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  McpAutomaticOAuthError,
  type McpAutomaticOAuthDcrRegistration,
  type McpAutomaticOAuthDcrStore,
} from "./mcp-automatic-oauth.service";

export interface BuiltinConnectorAutomaticContractOwner {
  readonly orgId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly contractHash: string;
}

/** Reconnects can cross method contracts, so take this lock before any account row. */
export async function lockBuiltinConnectorAutomaticLifecycle(
  db: Db,
  owner: Pick<
    BuiltinConnectorAutomaticContractOwner,
    "orgId" | "connectorSlug"
  >,
): Promise<void> {
  await db.execute(
    // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
    sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(["connector-mcp-oauth", owner.orgId, owner.connectorSlug])}))`,
  );
}

function ownerCondition(owner: BuiltinConnectorAutomaticContractOwner) {
  return and(
    eq(builtinConnectorDcrRegistrations.orgId, owner.orgId),
    eq(builtinConnectorDcrRegistrations.connectorSlug, owner.connectorSlug),
    eq(builtinConnectorDcrRegistrations.authMethod, owner.authMethod),
    eq(builtinConnectorDcrRegistrations.contractHash, owner.contractHash),
  );
}

function registration(
  row: typeof builtinConnectorDcrRegistrations.$inferSelect,
): McpAutomaticOAuthDcrRegistration {
  return { ...row, hasClientSecret: row.encryptedClientSecret !== null };
}

/** Lifecycle coordination precedes owner target locks, which precede their account rows. */
async function retireRegistration(
  db: Db,
  owner: BuiltinConnectorAutomaticContractOwner,
  id: string,
): Promise<void> {
  const [owned] = await db
    .select({ id: builtinConnectorDcrRegistrations.id })
    .from(builtinConnectorDcrRegistrations)
    .where(
      and(eq(builtinConnectorDcrRegistrations.id, id), ownerCondition(owner)),
    )
    .limit(1);
  if (!owned) {
    return;
  }
  // Ordinary delete/default operations lock a user's target before sibling
  // rows. Join that order for every linked owner before locking their accounts.
  // The lifecycle lock prevents new Automatic bindings while these locks wait.
  const accountOwners = await db
    .selectDistinct({ userId: builtinConnectorAccountOauthBindings.userId })
    .from(builtinConnectorAccountOauthBindings)
    .where(eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id))
    .orderBy(builtinConnectorAccountOauthBindings.userId);
  for (const accountOwner of accountOwners) {
    await lockConnectorAccountTarget(db, {
      orgId: owner.orgId,
      userId: accountOwner.userId,
      target: { kind: "builtin", connectorSlug: owner.connectorSlug },
    });
  }
  const accounts = await db
    .select({ id: connectors.id })
    .from(connectors)
    .innerJoin(
      builtinConnectorAccountOauthBindings,
      eq(
        builtinConnectorAccountOauthBindings.connectorAccountId,
        connectors.id,
      ),
    )
    .where(eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id))
    .orderBy(connectors.id)
    .for("update", { of: connectors });
  if (accounts.length > 0) {
    await db
      .update(connectors)
      .set({
        needsReconnect: true,
        reconnectReason: "authorization_expired_or_revoked",
        updatedAt: nowDate(),
      })
      .where(
        and(
          inArray(
            connectors.id,
            accounts.map((account) => {
              return account.id;
            }),
          ),
          // A reconnect to another method may have committed while the row
          // lock waited. Recheck its current binding after acquiring that lock.
          inArray(
            connectors.id,
            db
              .select({
                id: builtinConnectorAccountOauthBindings.connectorAccountId,
              })
              .from(builtinConnectorAccountOauthBindings)
              .where(
                eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id),
              ),
          ),
        ),
      );
  }
  await db
    .delete(builtinConnectorAccountOauthBindings)
    .where(eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id));
  await db
    .delete(builtinConnectorDcrRegistrations)
    .where(
      and(eq(builtinConnectorDcrRegistrations.id, id), ownerCondition(owner)),
    );
}

interface BuiltinDcrStoreArgs {
  readonly db: Db;
  readonly owner: BuiltinConnectorAutomaticContractOwner;
  readonly assertCurrentContract: () => Promise<void>;
}

async function publishBuiltinDcrRegistration(
  args: BuiltinDcrStoreArgs,
  value: Parameters<McpAutomaticOAuthDcrStore["publish"]>[0],
  expectedRegistrationId: string | null,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<McpAutomaticOAuthDcrStore["publish"]>>> {
  const { db, owner } = args;
  const encryptedClientSecret =
    value.clientSecret === undefined
      ? null
      : await encryptStoredSecretValue(value.clientSecret);
  signal.throwIfAborted();
  await args.assertCurrentContract();
  const candidate = {
    ...owner,
    issuer: value.issuer,
    clientId: value.clientId,
    encryptedClientSecret,
    tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
    registeredScopes: [...value.registeredScopes],
    redirectUri: value.redirectUri,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
  const issuerCondition = and(
    ownerCondition(owner),
    eq(builtinConnectorDcrRegistrations.issuer, value.issuer),
  );
  return await db.transaction(async (tx) => {
    // Outgoing Automatic OAuth writers still rely on lifecycle coordination.
    // Remove only after those writers drain and rollback targets implement
    // conditional publication and exact registration retirement.
    await lockBuiltinConnectorAutomaticLifecycle(tx, owner);
    const [current] = await tx
      .select()
      .from(builtinConnectorDcrRegistrations)
      .where(issuerCondition)
      .for("update")
      .limit(1);
    if (current && current.id !== expectedRegistrationId) {
      return registration(current);
    }
    if (current) {
      const bindingCondition = eq(
        builtinConnectorAccountOauthBindings.dcrRegistrationId,
        current.id,
      );
      const accountOwners = await tx
        .selectDistinct({
          userId: builtinConnectorAccountOauthBindings.userId,
        })
        .from(builtinConnectorAccountOauthBindings)
        .where(bindingCondition)
        .orderBy(builtinConnectorAccountOauthBindings.userId);
      if (
        accountOwners.length > 0 &&
        (current.expiresAt === null || current.expiresAt > nowDate())
      ) {
        throw new McpAutomaticOAuthError(
          { kind: "incompatible", reason: "registration-conflict" },
          "Existing MCP OAuth registration acquired a linked account during preparation",
        );
      }
      for (const accountOwner of accountOwners) {
        await lockConnectorAccountTarget(tx, {
          orgId: owner.orgId,
          userId: accountOwner.userId,
          target: { kind: "builtin", connectorSlug: owner.connectorSlug },
        });
      }
      await tx
        .update(connectors)
        .set({
          needsReconnect: true,
          reconnectReason: "authorization_expired_or_revoked",
          updatedAt: nowDate(),
        })
        .where(
          inArray(
            connectors.id,
            tx
              .select({
                id: builtinConnectorAccountOauthBindings.connectorAccountId,
              })
              .from(builtinConnectorAccountOauthBindings)
              .where(bindingCondition),
          ),
        );
      await tx
        .delete(builtinConnectorAccountOauthBindings)
        .where(bindingCondition);
      await tx
        .delete(builtinConnectorDcrRegistrations)
        .where(
          and(
            ownerCondition(owner),
            eq(builtinConnectorDcrRegistrations.id, current.id),
          ),
        );
    }
    const [inserted] = await tx
      .insert(builtinConnectorDcrRegistrations)
      .values(candidate)
      .onConflictDoNothing()
      .returning();
    const [winner] = inserted
      ? [inserted]
      : await tx
          .select()
          .from(builtinConnectorDcrRegistrations)
          .where(issuerCondition)
          .limit(1);
    if (!winner) {
      throw new Error(
        "Failed to persist builtin MCP OAuth client registration",
      );
    }
    return registration(winner);
  });
}

export function builtinConnectorAutomaticDcrStore(
  args: BuiltinDcrStoreArgs,
): McpAutomaticOAuthDcrStore {
  const { db, owner } = args;
  return {
    async readByIssuer(issuer) {
      const [row] = await db
        .select()
        .from(builtinConnectorDcrRegistrations)
        .where(
          and(
            ownerCondition(owner),
            eq(builtinConnectorDcrRegistrations.issuer, issuer),
          ),
        )
        .limit(1);
      return row ? registration(row) : null;
    },
    async readBoundClient(id) {
      const [row] = await db
        .select()
        .from(builtinConnectorDcrRegistrations)
        .where(
          and(
            ownerCondition(owner),
            eq(builtinConnectorDcrRegistrations.id, id),
          ),
        )
        .limit(1);
      if (!row) {
        return null;
      }
      return {
        ...registration(row),
        clientSecret:
          row.encryptedClientSecret === null
            ? undefined
            : await decryptStoredSecretValue(row.encryptedClientSecret),
      };
    },
    async hasLinkedAccounts(id) {
      const [account] = await db
        .select({ id: builtinConnectorAccountOauthBindings.connectorAccountId })
        .from(builtinConnectorAccountOauthBindings)
        .where(eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id))
        .limit(1);
      return account !== undefined;
    },
    async retire(id) {
      await retireRegistration(db, owner, id);
    },
    async publish(value, expectedRegistrationId, signal) {
      return await publishBuiltinDcrRegistration(
        args,
        value,
        expectedRegistrationId,
        signal,
      );
    },
  };
}
