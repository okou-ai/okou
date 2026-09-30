import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { connectorCatalogActiveSnapshot } from "@okouai/db/schema/connector-catalog";
import { builtinConnectorDcrRegistrations } from "@okouai/db/schema/connector-dcr-registration";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { command } from "ccstate";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  builtinConnectorAutomaticLifecycleLockStatement,
  builtinDcrCatalogCondition,
} from "./builtin-connector-automatic-dcr.service";
import type { ExternalCatalogIdentity } from "./connector-catalog-external-reader.service";

interface AutomaticConnectionOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorSlug: string;
}

export interface AutomaticCallbackAccountSnapshot {
  readonly stateRevision: string;
  readonly rowVersion: string;
}

function automaticConnectionOwnerCondition(owner: AutomaticConnectionOwner) {
  return and(
    eq(connectors.orgId, owner.orgId),
    eq(connectors.userId, owner.userId),
    eq(connectors.connectorSlug, owner.connectorSlug),
  );
}

export const readAutomaticAccountSnapshot$ = command(
  async (
    { set },
    args: AutomaticConnectionOwner & {
      readonly connectionId: string;
      readonly expectedRevision?: string | null;
    },
    signal: AbortSignal,
  ): Promise<AutomaticCallbackAccountSnapshot | null> => {
    if (args.expectedRevision === null) {
      return null;
    }
    const db = set(writeDb$);
    const [account] = await db
      .select({
        stateRevision: sql`${connectors.updatedAt}::text`.mapWith(
          pgTextDecoder,
        ),
        rowVersion: sql`${connectors}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(connectors)
      .where(
        and(
          automaticConnectionOwnerCondition(args),
          eq(connectors.id, args.connectionId),
          args.expectedRevision === undefined
            ? undefined
            : eq(
                connectors.updatedAt,
                sql`${args.expectedRevision}::timestamp`,
              ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return account ?? null;
  },
);

export interface AutomaticConnectionPublication extends AutomaticConnectionOwner {
  readonly catalogIdentity: ExternalCatalogIdentity;
  readonly account: ConnectorAccountMutationIntent;
  readonly expected: AutomaticCallbackAccountSnapshot | null;
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
      input.identity === null || input.scopes === null
        ? null
        : JSON.stringify(input.scopes),
    tokenExpiresAt: input.expiresAt,
    needsReconnect: false,
    reconnectReason: null,
  };
}

function automaticBoundRegistrationCondition(
  input: AutomaticConnectionPublication,
) {
  if (!input.binding?.dcrRegistrationId) {
    throw new Error("Automatic DCR publication requires its registration");
  }
  return and(
    eq(builtinConnectorDcrRegistrations.id, input.binding.dcrRegistrationId),
    eq(builtinConnectorDcrRegistrations.orgId, input.orgId),
    eq(builtinConnectorDcrRegistrations.connectorSlug, input.connectorSlug),
    eq(builtinConnectorDcrRegistrations.authMethod, input.binding.authMethod),
    eq(
      builtinConnectorDcrRegistrations.contractHash,
      input.binding.contractHash,
    ),
    eq(builtinConnectorDcrRegistrations.issuer, input.binding.issuer),
    eq(builtinConnectorDcrRegistrations.clientId, input.binding.clientId),
    eq(
      builtinConnectorDcrRegistrations.tokenEndpointAuthMethod,
      input.binding.tokenEndpointAuthMethod,
    ),
    or(
      isNull(builtinConnectorDcrRegistrations.expiresAt),
      gt(builtinConnectorDcrRegistrations.expiresAt, nowDate()),
    ),
  );
}

function automaticReconnectCondition(input: AutomaticConnectionPublication) {
  if (input.account.intent !== "reconnect" || input.expected === null) {
    throw new Error("Automatic reconnect requires its observed account");
  }
  return and(
    automaticConnectionOwnerCondition(input),
    eq(connectors.id, input.account.connectionId),
    eq(connectors.updatedAt, sql`${input.expected.stateRevision}::timestamp`),
    sql`${connectors}.xmin::text = ${input.expected.rowVersion}`,
  );
}

/** Provider exchange and encryption finish before this finite publication. */
export const publishAutomaticConnection$ = command(
  async (
    { set },
    input: AutomaticConnectionPublication,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "connected"; readonly connectionId: string }
    | {
        readonly kind: "error";
        readonly reason: "stale-contract" | "invalid-account";
      }
  > => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      // Plain MVCC check, as main's assertCurrentContract; no row lock.
      const [catalog] = await tx
        .select({ sourceId: connectorCatalogActiveSnapshot.sourceId })
        .from(connectorCatalogActiveSnapshot)
        .where(builtinDcrCatalogCondition(input.catalogIdentity))
        .limit(1);
      if (!catalog) {
        return { kind: "error", reason: "stale-contract" };
      }
      await tx.execute(builtinConnectorAutomaticLifecycleLockStatement(input));
      if (input.binding?.registrationMethod === "dcr") {
        const [registration] = await tx
          .select({ id: builtinConnectorDcrRegistrations.id })
          .from(builtinConnectorDcrRegistrations)
          .where(automaticBoundRegistrationCondition(input))
          .limit(1);
        if (!registration) {
          return { kind: "error", reason: "stale-contract" };
        }
      }
      const metadata = automaticConnectionMetadata(input);
      let connection: { readonly id: string } | undefined;
      if (input.account.intent === "reconnect") {
        [connection] = await tx
          .update(connectors)
          .set({ ...metadata, updatedAt: sql`clock_timestamp()` })
          .where(automaticReconnectCondition(input))
          .returning({ id: connectors.id });
      } else {
        // No sibling locks: the default is tried first against
        // idx_connectors_org_user_slug_default, which only admits it while
        // no default is committed (and waits for an in-flight one); otherwise
        // the account becomes a non-default sibling.
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

export const publishAutomaticAuthorizationState$ = command(
  async (
    { set },
    args: AutomaticConnectionOwner & {
      readonly catalogIdentity: ExternalCatalogIdentity;
      readonly account: ConnectorAccountMutationIntent;
      readonly expected: AutomaticCallbackAccountSnapshot | null;
      readonly state: typeof connectorOauthStates.$inferInsert;
      readonly authorizationUrl: string;
    },
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: "authorization";
        readonly authorizationUrl: string;
        readonly oauthAttemptId: string;
      }
    | {
        readonly kind: "error";
        readonly reason: "invalid-account" | "stale-contract";
      }
  > => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const [catalog] = await tx
        .select({ sourceId: connectorCatalogActiveSnapshot.sourceId })
        .from(connectorCatalogActiveSnapshot)
        .where(builtinDcrCatalogCondition(args.catalogIdentity))
        .limit(1);
      if (!catalog) {
        return { kind: "error", reason: "stale-contract" };
      }
      await tx.execute(builtinConnectorAutomaticLifecycleLockStatement(args));
      if (args.account.intent === "reconnect") {
        if (!args.expected) {
          return { kind: "error", reason: "invalid-account" };
        }
        const [account] = await tx
          .select({ id: connectors.id })
          .from(connectors)
          .where(
            and(
              automaticConnectionOwnerCondition(args),
              eq(connectors.id, args.account.connectionId),
              eq(
                connectors.updatedAt,
                sql`${args.expected.stateRevision}::timestamp`,
              ),
              sql`${connectors}.xmin::text = ${args.expected.rowVersion}`,
            ),
          )
          .limit(1);
        if (!account) {
          return { kind: "error", reason: "invalid-account" };
        }
      }
      const [state] = await tx
        .insert(connectorOauthStates)
        .values(args.state)
        .returning({ id: connectorOauthStates.id });
      if (!state) {
        throw new Error("Failed to create Automatic OAuth state");
      }
      signal.throwIfAborted();
      return {
        kind: "authorization",
        authorizationUrl: args.authorizationUrl,
        oauthAttemptId: state.id,
      };
    });
  },
);
