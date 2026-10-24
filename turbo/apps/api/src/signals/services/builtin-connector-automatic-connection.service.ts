import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { command } from "ccstate";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { pgTextDecoder } from "../../lib/db-structured-result";

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
  ): Promise<readonly { readonly connectionId: string }[]> => {
    const db = set(writeDb$);
    const metadata = automaticConnectionMetadata(input);
    const values = {
      orgId: input.orgId,
      userId: input.userId,
      connectorSlug: input.connectorSlug,
      customConnectorId: null,
      displayName:
        input.account.intent === "reconnect"
          ? null
          : (input.account.displayName ?? null),
      ...metadata,
    };
    const preferred = db.$with("automatic_default_account").as(
      db
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
        .returning({ id: connectors.id }),
    );
    // Select-insert requires all Drizzle table fields. Keep the existing DB
    // defaults for account identity and timestamps with a bound column subset.
    const sibling = db.$with("automatic_sibling_account", { id: connectors.id })
      .as(sql`INSERT INTO ${connectors}
        (org_id, user_id, connector_slug, custom_connector_id, display_name,
         auth_method, automatic_auth_type, storage_version, external_id,
         external_username, external_email, oauth_scopes, oauth_granted_scopes,
         token_expires_at, needs_reconnect, reconnect_reason, is_default)
        SELECT ${values.orgId}, ${values.userId}, ${values.connectorSlug}, NULL,
          ${values.displayName}, ${metadata.authMethod}, ${metadata.automaticAuthType},
          ${metadata.storageVersion}, ${metadata.externalId},
          ${metadata.externalUsername}, ${metadata.externalEmail}, NULL,
          ${metadata.oauthGrantedScopes},
          ${sql.param(metadata.tokenExpiresAt, connectors.tokenExpiresAt)},
          false, NULL, false
        WHERE NOT EXISTS (SELECT 1 FROM ${preferred})
        RETURNING id`);
    const snapshot = db.$with("automatic_account_snapshot").as(
      db
        .select({
          id: connectors.id,
          version: sql`${connectors}.xmin::text`
            .mapWith(pgTextDecoder)
            .as("row_version"),
        })
        .from(connectors)
        .where(
          and(
            automaticConnectionOwnerCondition(input),
            input.account.intent === "reconnect"
              ? eq(connectors.id, input.account.connectionId)
              : sql`false`,
          ),
        )
        .limit(1),
    );
    const connection =
      input.account.intent === "reconnect"
        ? db.$with("automatic_published_account").as(
            db
              .update(connectors)
              .set({ ...metadata, updatedAt: sql`clock_timestamp()` })
              .where(
                and(
                  automaticConnectionOwnerCondition(input),
                  eq(connectors.id, input.account.connectionId),
                  // Two references keep this read CTE materialized: both the ID
                  // and tuple version belong to the statement's original row.
                  inArray(
                    connectors.id,
                    db.select({ id: snapshot.id }).from(snapshot),
                  ),
                  // Reject a parent that changed while this UPDATE waited. Its
                  // children may be newer than this statement's snapshot, even
                  // when this attempt has no credentials to insert.
                  sql`${connectors}.xmin::text = (SELECT ${snapshot.version} FROM ${snapshot})`,
                ),
              )
              .returning({ id: connectors.id }),
          )
        : db.$with("automatic_published_account").as(
            db
              .select({ id: preferred.id })
              .from(preferred)
              .unionAll(db.select({ id: sibling.id }).from(sibling)),
          );
    const removedSecrets = db.$with("automatic_removed_secrets").as(
      db
        .delete(secrets)
        .where(
          inArray(
            secrets.connectorId,
            db.select({ id: connection.id }).from(connection),
          ),
        )
        .returning({ id: secrets.id }),
    );
    const removedVariables = db.$with("automatic_removed_variables").as(
      db
        .delete(variables)
        .where(
          and(
            inArray(
              variables.connectorId,
              db.select({ id: connection.id }).from(connection),
            ),
            gte(db.select({ count: count() }).from(removedSecrets), 0),
          ),
        )
        .returning({ id: variables.id }),
    );
    const removedBindings = db.$with("automatic_removed_bindings").as(
      db
        .delete(builtinConnectorAccountOauthBindings)
        .where(
          and(
            inArray(
              builtinConnectorAccountOauthBindings.connectorAccountId,
              db.select({ id: connection.id }).from(connection),
            ),
            gte(db.select({ count: count() }).from(removedVariables), 0),
          ),
        )
        .returning({
          id: builtinConnectorAccountOauthBindings.connectorAccountId,
        }),
    );
    const tokens =
      input.credentials.length > 0
        ? sql`VALUES ${sql.join(
            input.credentials.map((credential) => {
              return sql`(${credential.name}::text, ${credential.encryptedValue}::text)`;
            }),
            sql`, `,
          )}`
        : sql`SELECT NULL::text, NULL::text WHERE false`;
    const insertedSecrets = db.$with("automatic_inserted_secrets", {
      id: secrets.id,
    }).as(sql`INSERT INTO ${secrets}
        (name, encrypted_value, description, type, connector_id, org_id, user_id)
        SELECT token.name, token.encrypted_value, 'Automatic MCP OAuth token',
          'connector', ${connection.id}, ${input.orgId}, ${input.userId}
        FROM ${connection} CROSS JOIN (${tokens}) AS token(name, encrypted_value)
        WHERE ${gte(db.select({ count: count() }).from(removedBindings), 0)}
        RETURNING id`);
    const binding = input.binding;
    const insertedBinding = db
      .$with("automatic_inserted_binding", {
        id: builtinConnectorAccountOauthBindings.connectorAccountId,
      })
      .as(
        binding === null
          ? sql`SELECT NULL::uuid AS connector_account_id WHERE false`
          : sql`INSERT INTO ${builtinConnectorAccountOauthBindings}
          (connector_account_id, org_id, user_id, connector_slug, auth_method,
           storage_version, endpoint, issuer, resource, resource_metadata_url,
           token_endpoint, client_id, token_endpoint_auth_method,
           registration_method, dcr_registration_id)
          SELECT ${connection.id}, ${binding.orgId}, ${binding.userId},
            ${binding.connectorSlug}, ${binding.authMethod}, ${binding.storageVersion},
            ${binding.endpoint}, ${binding.issuer}, ${binding.resource},
            ${binding.resourceMetadataUrl ?? null}, ${binding.tokenEndpoint},
            ${binding.clientId}, ${binding.tokenEndpointAuthMethod},
            ${binding.registrationMethod}, ${binding.dcrRegistrationId ?? null}
          FROM ${connection}
          WHERE ${gte(db.select({ count: count() }).from(insertedSecrets), 0)}
            AND ${gte(db.select({ count: count() }).from(removedBindings), 0)}
          RETURNING connector_account_id`,
      );
    signal.throwIfAborted();
    return await db
      .with(
        ...(input.account.intent === "reconnect"
          ? [snapshot]
          : [preferred, sibling]),
        connection,
        removedSecrets,
        removedVariables,
        removedBindings,
        insertedSecrets,
        insertedBinding,
      )
      .select({ connectionId: connection.id })
      .from(connection)
      .where(
        and(
          gte(db.select({ count: count() }).from(removedBindings), 0),
          gte(db.select({ count: count() }).from(insertedSecrets), 0),
          gte(db.select({ count: count() }).from(insertedBinding), 0),
        ),
      );
  },
);
