import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";

interface AutomaticConnectionOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
}

function automaticConnectionOwnerCondition(owner: AutomaticConnectionOwner) {
  return and(
    eq(connectors.orgId, owner.orgId),
    eq(connectors.userId, owner.userId),
    eq(connectors.connectorSlug, owner.connectorSlug),
  );
}

export const automaticAccountExists$ = command(
  async (
    { set },
    args: AutomaticConnectionOwner & { readonly connectionId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [account] = await set(writeDb$)
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          automaticConnectionOwnerCondition(args),
          eq(connectors.id, args.connectionId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return account !== undefined;
  },
);

export interface AutomaticConnectionPublication extends AutomaticConnectionOwner {
  readonly account: ConnectorAccountMutationIntent;
  readonly authMethod: string;
  readonly storageVersion: number;
  readonly binding: Omit<
    typeof builtinConnectorAccountOauthBindings.$inferInsert,
    "connectorAccountId" | "createdAt"
  > | null;
  readonly identity: {
    readonly id: string;
    readonly username: string | null;
    readonly email: string | null;
  } | null;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[] | null;
  readonly credentials: readonly {
    readonly name: string;
    readonly encryptedValue: string;
  }[];
}

function automaticConnectionMetadata(input: AutomaticConnectionPublication) {
  return {
    authMethod: input.authMethod,
    automaticAuthType:
      input.binding === null ? ("none" as const) : ("oauth" as const),
    storageVersion: input.storageVersion,
    externalId: input.identity?.id ?? null,
    externalUsername: input.identity?.username ?? null,
    externalEmail: input.identity?.email ?? null,
    oauthScopes: null,
    oauthGrantedScopes:
      input.scopes === null ? null : JSON.stringify(input.scopes),
    tokenExpiresAt: input.expiresAt,
    needsReconnect: false,
    reconnectReason: null,
  };
}

/** Provider exchange and encryption finish before this local write. */
export const publishAutomaticConnection$ = command(
  async (
    { set },
    input: AutomaticConnectionPublication,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "connected"; readonly connectionId: string }
    | { readonly kind: "error"; readonly reason: "invalid-account" }
  > => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const metadata = automaticConnectionMetadata(input);
      let connection: { readonly id: string } | undefined;
      if (input.account.intent === "reconnect") {
        [connection] = await tx
          .update(connectors)
          .set({ ...metadata, updatedAt: sql`clock_timestamp()` })
          .where(
            and(
              automaticConnectionOwnerCondition(input),
              eq(connectors.id, input.account.connectionId),
            ),
          )
          .returning({ id: connectors.id });
      } else {
        // The first account becomes the default; once a default exists,
        // idx_connectors_org_user_slug_default rejects it and the account is
        // created as a non-default sibling.
        const values = {
          orgId: input.orgId,
          userId: input.userId,
          connectorSlug: input.connectorSlug,
          customConnectorId: null,
          displayName: input.account.displayName ?? null,
          ...metadata,
        };
        [connection] = await tx
          .insert(connectors)
          .values({ ...values, isDefault: true })
          .onConflictDoNothing({
            target: [
              connectors.orgId,
              connectors.userId,
              connectors.connectorSlug,
            ],
            where: sql`${connectors.connectorSlug} IS NOT NULL AND ${connectors.isDefault} = true`,
          })
          .returning({ id: connectors.id });
        if (!connection) {
          [connection] = await tx
            .insert(connectors)
            .values({ ...values, isDefault: false })
            .returning({ id: connectors.id });
        }
      }
      if (!connection) {
        return { kind: "error", reason: "invalid-account" };
      }
      const connectionId = connection.id;
      await tx.delete(secrets).where(eq(secrets.connectorId, connectionId));
      await tx.delete(variables).where(eq(variables.connectorId, connectionId));
      await tx
        .delete(builtinConnectorAccountOauthBindings)
        .where(
          eq(
            builtinConnectorAccountOauthBindings.connectorAccountId,
            connectionId,
          ),
        );
      if (input.credentials.length > 0) {
        await tx.insert(secrets).values(
          input.credentials.map((credential) => {
            return {
              ...credential,
              connectorId: connectionId,
              orgId: input.orgId,
              userId: input.userId,
              description: "Automatic MCP OAuth token",
              type: "connector" as const,
            };
          }),
        );
      }
      if (input.binding !== null) {
        await tx
          .insert(builtinConnectorAccountOauthBindings)
          .values({ ...input.binding, connectorAccountId: connectionId });
      }
      signal.throwIfAborted();
      return { kind: "connected", connectionId };
    });
  },
);
