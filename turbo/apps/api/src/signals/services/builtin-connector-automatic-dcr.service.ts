import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectors } from "@okouai/db/schema/connector";
import { connectorCatalogActiveSnapshot } from "@okouai/db/schema/connector-catalog";
import type { ExternalCatalogIdentity } from "./connector-catalog-view";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  McpAutomaticOAuthError,
  type McpAutomaticOAuthDcrRegistration,
  type McpAutomaticOAuthDcrRegistrationInput,
  type McpAutomaticOAuthDcrStore,
} from "./mcp-automatic-oauth.service";

export interface BuiltinConnectorAutomaticContractOwner {
  readonly orgId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
  readonly contractHash: string;
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

/**
 * Retires one exact registration in the caller's transaction without explicit
 * row locks. Accounts are written first, the order account writers use; the
 * binding condition selects only accounts still bound to this registration,
 * and deleting its bindings before the registration satisfies the binding
 * foreign key. Every statement is conditional on the exact id and owner, so a
 * registration already retired by another writer is a no-op.
 */
async function retireRegistration(
  db: Db,
  owner: BuiltinConnectorAutomaticContractOwner,
  id: string,
): Promise<void> {
  const boundToRegistration = and(
    eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id),
    eq(builtinConnectorAccountOauthBindings.orgId, owner.orgId),
    eq(builtinConnectorAccountOauthBindings.connectorSlug, owner.connectorSlug),
    eq(builtinConnectorAccountOauthBindings.authMethod, owner.authMethod),
    eq(builtinConnectorAccountOauthBindings.contractHash, owner.contractHash),
  );
  await db
    .update(connectors)
    .set({
      needsReconnect: true,
      reconnectReason: "authorization_expired_or_revoked",
      updatedAt: nowDate(),
    })
    .where(
      inArray(
        connectors.id,
        db
          .select({
            id: builtinConnectorAccountOauthBindings.connectorAccountId,
          })
          .from(builtinConnectorAccountOauthBindings)
          .where(boundToRegistration),
      ),
    );
  await db
    .delete(builtinConnectorAccountOauthBindings)
    .where(boundToRegistration);
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

function builtinDcrCatalogCondition(identity: ExternalCatalogIdentity) {
  return and(
    eq(connectorCatalogActiveSnapshot.sourceId, identity.sourceId),
    eq(connectorCatalogActiveSnapshot.schemaVersion, identity.schemaVersion),
    eq(connectorCatalogActiveSnapshot.catalogVersion, identity.catalogVersion),
    eq(connectorCatalogActiveSnapshot.catalogDigest, identity.catalogDigest),
  );
}

export const createBuiltinDcrRegistration$ = command(
  async (
    { set },
    args: {
      readonly owner: BuiltinConnectorAutomaticContractOwner;
      readonly catalogIdentity: ExternalCatalogIdentity;
      readonly value: McpAutomaticOAuthDcrRegistrationInput;
    },
    signal: AbortSignal,
  ): Promise<McpAutomaticOAuthDcrRegistration> => {
    const db = set(writeDb$);
    const { owner, value } = args;
    const encryptedClientSecret =
      value.clientSecret === undefined
        ? null
        : await encryptStoredSecretValue(value.clientSecret);
    signal.throwIfAborted();
    // A registration is created only for the current catalog.
    const [catalog] = await db
      .select({ sourceId: connectorCatalogActiveSnapshot.sourceId })
      .from(connectorCatalogActiveSnapshot)
      .where(builtinDcrCatalogCondition(args.catalogIdentity))
      .limit(1);
    signal.throwIfAborted();
    if (!catalog) {
      throw new McpAutomaticOAuthError(
        { kind: "binding-drift", reason: "binding-drift" },
        "Builtin MCP credential catalog changed during client registration",
      );
    }
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
    signal.throwIfAborted();
    if (!row) {
      throw new Error(
        "Failed to persist builtin MCP OAuth client registration",
      );
    }
    return registration(row);
  },
);

export function builtinConnectorAutomaticDcrStore(
  args: BuiltinDcrStoreArgs,
): Omit<McpAutomaticOAuthDcrStore, "create"> {
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
      await retireRegistration(tx, owner, id);
    });
    signal.throwIfAborted();
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
