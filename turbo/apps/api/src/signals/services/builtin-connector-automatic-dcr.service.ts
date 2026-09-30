import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectors } from "@okouai/db/schema/connector";
import { connectorCatalogActiveSnapshot } from "@okouai/db/schema/connector-catalog";
import type { ExternalCatalogIdentity } from "./connector-catalog-external-reader.service";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
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

export function builtinConnectorAutomaticLifecycleLockStatement(
  owner: Pick<
    BuiltinConnectorAutomaticContractOwner,
    "orgId" | "connectorSlug"
  >,
) {
  // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
  return sql`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(["connector-mcp-oauth", owner.orgId, owner.connectorSlug])}))`;
}

/** Reconnects can cross method contracts, so take this lock before any account row. */
export async function lockBuiltinConnectorAutomaticLifecycle(
  db: Db,
  owner: Pick<
    BuiltinConnectorAutomaticContractOwner,
    "orgId" | "connectorSlug"
  >,
): Promise<void> {
  await db.execute(builtinConnectorAutomaticLifecycleLockStatement(owner));
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
  // Linked accounts lock in id order, the order account-set writers use for
  // sibling rows. The lifecycle lock prevents new Automatic bindings meanwhile.
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
}

export const readBuiltinDcrRegistrationByIssuer$ = command(
  async (
    { set },
    args: {
      readonly owner: BuiltinConnectorAutomaticContractOwner;
      readonly issuer: string;
    },
    signal: AbortSignal,
  ): Promise<McpAutomaticOAuthDcrRegistration | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select()
      .from(builtinConnectorDcrRegistrations)
      .where(
        and(
          ownerCondition(args.owner),
          eq(builtinConnectorDcrRegistrations.issuer, args.issuer),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return row ? registration(row) : null;
  },
);

export const hasBuiltinDcrLinkedAccounts$ = command(
  async (
    { set },
    registrationId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [account] = await db
      .select({ id: builtinConnectorAccountOauthBindings.connectorAccountId })
      .from(builtinConnectorAccountOauthBindings)
      .where(
        eq(
          builtinConnectorAccountOauthBindings.dcrRegistrationId,
          registrationId,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return account !== undefined;
  },
);

export function builtinDcrCatalogCondition(identity: ExternalCatalogIdentity) {
  return and(
    eq(connectorCatalogActiveSnapshot.sourceId, identity.sourceId),
    eq(connectorCatalogActiveSnapshot.schemaVersion, identity.schemaVersion),
    eq(connectorCatalogActiveSnapshot.catalogVersion, identity.catalogVersion),
    eq(connectorCatalogActiveSnapshot.catalogDigest, identity.catalogDigest),
  );
}

async function prepareBuiltinDcrRegistration(
  owner: BuiltinConnectorAutomaticContractOwner,
  value: Parameters<McpAutomaticOAuthDcrStore["publish"]>[0],
  signal: AbortSignal,
) {
  const encryptedClientSecret =
    value.clientSecret === undefined
      ? null
      : await encryptStoredSecretValue(value.clientSecret);
  signal.throwIfAborted();
  return {
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
}

export const publishBuiltinDcrRegistration$ = command(
  async (
    { set },
    args: {
      readonly owner: BuiltinConnectorAutomaticContractOwner;
      readonly catalogIdentity: ExternalCatalogIdentity;
      readonly value: Parameters<McpAutomaticOAuthDcrStore["publish"]>[0];
      readonly expectedRegistrationId: string | null;
    },
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<McpAutomaticOAuthDcrStore["publish"]>>> => {
    const db = set(writeDb$);
    const { owner, value, expectedRegistrationId } = args;
    const candidate = await prepareBuiltinDcrRegistration(owner, value, signal);
    const issuerCondition = and(
      ownerCondition(owner),
      eq(builtinConnectorDcrRegistrations.issuer, value.issuer),
    );
    return await db.transaction(async (tx) => {
      const [catalog] = await tx
        .select({ sourceId: connectorCatalogActiveSnapshot.sourceId })
        .from(connectorCatalogActiveSnapshot)
        .where(builtinDcrCatalogCondition(args.catalogIdentity))
        .for("share")
        .limit(1);
      if (!catalog) {
        throw new McpAutomaticOAuthError(
          { kind: "binding-drift", reason: "binding-drift" },
          "Builtin MCP credential catalog changed during client registration",
        );
      }
      // Outgoing Automatic OAuth writers still rely on lifecycle coordination.
      // Remove only after those writers drain and rollback targets implement
      // conditional publication and exact registration retirement.
      await tx.execute(builtinConnectorAutomaticLifecycleLockStatement(owner));
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
        // Expired registration: lock its linked accounts in id order, the order
        // account-set writers use, before invalidating them.
        await tx
          .select({ id: connectors.id })
          .from(connectors)
          .innerJoin(
            builtinConnectorAccountOauthBindings,
            eq(
              builtinConnectorAccountOauthBindings.connectorAccountId,
              connectors.id,
            ),
          )
          .where(bindingCondition)
          .orderBy(connectors.id)
          .for("update", { of: connectors });
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
  },
);

export function builtinConnectorAutomaticDcrStore(
  args: BuiltinDcrStoreArgs,
): Omit<McpAutomaticOAuthDcrStore, "publish"> {
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
  };
}

/** Exact registration invalidation owns its SQL independently of provider I/O. */
export const retireBuiltinDcrRegistration$ = command(
  async (
    { set },
    args: {
      readonly owner: BuiltinConnectorAutomaticContractOwner;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { owner, id } = args;
    await db.transaction(async (tx) => {
      await tx.execute(builtinConnectorAutomaticLifecycleLockStatement(owner));
      const [owned] = await tx
        .select({ id: builtinConnectorDcrRegistrations.id })
        .from(builtinConnectorDcrRegistrations)
        .where(
          and(
            eq(builtinConnectorDcrRegistrations.id, id),
            ownerCondition(owner),
          ),
        )
        .for("update")
        .limit(1);
      if (!owned) {
        return;
      }
      // Linked accounts lock in id order, the order account-set writers use for
      // sibling rows. The lifecycle lock prevents new Automatic bindings meanwhile.
      const accounts = await tx
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
        await tx
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
                tx
                  .select({
                    id: builtinConnectorAccountOauthBindings.connectorAccountId,
                  })
                  .from(builtinConnectorAccountOauthBindings)
                  .where(
                    eq(
                      builtinConnectorAccountOauthBindings.dcrRegistrationId,
                      id,
                    ),
                  ),
              ),
            ),
          );
      }
      await tx
        .delete(builtinConnectorAccountOauthBindings)
        .where(eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id));
      await tx
        .delete(builtinConnectorDcrRegistrations)
        .where(
          and(
            eq(builtinConnectorDcrRegistrations.id, id),
            ownerCondition(owner),
          ),
        );
      signal.throwIfAborted();
    });
  },
);

export const readBuiltinDcrBoundClient$ = command(
  async (
    { set },
    args: {
      readonly owner: BuiltinConnectorAutomaticContractOwner;
      readonly id: string;
    },
    signal: AbortSignal,
  ): Promise<
    Awaited<ReturnType<McpAutomaticOAuthDcrStore["readBoundClient"]>>
  > => {
    const db = set(writeDb$);
    const [row] = await db
      .select()
      .from(builtinConnectorDcrRegistrations)
      .where(
        and(
          ownerCondition(args.owner),
          eq(builtinConnectorDcrRegistrations.id, args.id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    const clientSecret =
      row.encryptedClientSecret === null
        ? undefined
        : await decryptStoredSecretValue(row.encryptedClientSecret);
    signal.throwIfAborted();
    return { ...registration(row), clientSecret };
  },
);
