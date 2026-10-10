import { command } from "ccstate";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectors } from "@okouai/db/schema/connector";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import type {
  McpAutomaticOAuthDcrRegistration,
  McpAutomaticOAuthDcrRegistrationInput,
  McpAutomaticOAuthDcrClientStore,
  McpAutomaticOAuthDcrStore,
} from "./mcp-automatic-oauth.service";

export interface BuiltinConnectorAutomaticContractOwner {
  readonly orgId: string;
  readonly connectorSlug: string;
  readonly authMethod: string;
}

function ownerCondition(owner: BuiltinConnectorAutomaticContractOwner) {
  return and(
    eq(builtinConnectorDcrRegistrations.orgId, owner.orgId),
    eq(builtinConnectorDcrRegistrations.connectorSlug, owner.connectorSlug),
    eq(builtinConnectorDcrRegistrations.authMethod, owner.authMethod),
  );
}

function registration(
  row: typeof builtinConnectorDcrRegistrations.$inferSelect,
): McpAutomaticOAuthDcrRegistration {
  return { ...row, hasClientSecret: row.encryptedClientSecret !== null };
}

/**
 * Accounts precede bindings, matching account writers. Each deleted binding
 * consumes its updated account's identity; registration deletion requires all
 * of its snapshot bindings to have been removed. RETURNING carries these real
 * dependencies, including the empty-binding case, within one atomic statement.
 */
export function retireBuiltinDcrRegistrationSql(
  owner: BuiltinConnectorAutomaticContractOwner,
  id: string,
) {
  const boundToRegistration = and(
    eq(builtinConnectorAccountOauthBindings.dcrRegistrationId, id),
    eq(builtinConnectorAccountOauthBindings.orgId, owner.orgId),
    eq(builtinConnectorAccountOauthBindings.connectorSlug, owner.connectorSlug),
    eq(builtinConnectorAccountOauthBindings.authMethod, owner.authMethod),
  );
  return sql`
    WITH reconnected_accounts AS (
      UPDATE ${connectors}
      SET needs_reconnect = true,
          reconnect_reason = 'authorization_expired_or_revoked',
          updated_at = ${sql.param(nowDate(), connectors.updatedAt)}
      WHERE ${inArray(
        connectors.id,
        sql`(SELECT ${builtinConnectorAccountOauthBindings.connectorAccountId}
            FROM ${builtinConnectorAccountOauthBindings}
            WHERE ${boundToRegistration})`,
      )}
      RETURNING ${connectors.id}
    ), removed_bindings AS (
      DELETE FROM ${builtinConnectorAccountOauthBindings}
      WHERE ${boundToRegistration}
        AND ${inArray(
          builtinConnectorAccountOauthBindings.connectorAccountId,
          sql`(SELECT id FROM reconnected_accounts)`,
        )}
      RETURNING ${builtinConnectorAccountOauthBindings.connectorAccountId}
    )
    DELETE FROM ${builtinConnectorDcrRegistrations}
    WHERE ${and(eq(builtinConnectorDcrRegistrations.id, id), ownerCondition(owner))}
      AND NOT EXISTS (
        SELECT ${builtinConnectorAccountOauthBindings.connectorAccountId}
        FROM ${builtinConnectorAccountOauthBindings}
        WHERE ${boundToRegistration}
        EXCEPT SELECT connector_account_id FROM removed_bindings
      )
  `;
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
      .orderBy(
        desc(builtinConnectorDcrRegistrations.issuedAt),
        desc(builtinConnectorDcrRegistrations.id),
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

export const createBuiltinDcrRegistration$ = command(
  async (
    { set },
    args: {
      readonly owner: BuiltinConnectorAutomaticContractOwner;
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
): McpAutomaticOAuthDcrClientStore {
  const { db, owner } = args;
  return {
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
    await db.execute(retireBuiltinDcrRegistrationSql(owner, id));
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
