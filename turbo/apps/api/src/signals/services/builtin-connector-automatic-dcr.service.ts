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
import type {
  McpAutomaticOAuthDcrRegistration,
  McpAutomaticOAuthDcrStore,
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

export function builtinConnectorAutomaticDcrStore(args: {
  readonly db: Db;
  readonly owner: BuiltinConnectorAutomaticContractOwner;
  readonly assertCurrentContract: (db: Db) => Promise<void>;
}): McpAutomaticOAuthDcrStore {
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
    async withLock(operation) {
      return await db.transaction(async (tx) => {
        await lockBuiltinConnectorAutomaticLifecycle(tx, owner);
        await args.assertCurrentContract(tx);
        return await operation(
          builtinConnectorAutomaticDcrStore({ ...args, db: tx }),
        );
      });
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
    async create(value, signal) {
      const encryptedClientSecret =
        value.clientSecret === undefined
          ? null
          : await encryptStoredSecretValue(value.clientSecret);
      signal.throwIfAborted();
      const [row] = await db
        .insert(builtinConnectorDcrRegistrations)
        .values({
          ...owner,
          issuer: value.issuer,
          clientId: value.clientId,
          encryptedClientSecret,
          tokenEndpointAuthMethod: value.tokenEndpointAuthMethod,
          registeredScopes: [...value.registeredScopes],
          redirectUri: value.redirectUri,
          issuedAt: value.issuedAt,
          expiresAt: value.expiresAt,
        })
        .returning();
      if (!row) {
        throw new Error(
          "Failed to persist builtin MCP OAuth client registration",
        );
      }
      return registration(row);
    },
  };
}
