import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
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
import { builtinConnectorStateLockStatement } from "./auth-state-lock.service";
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

export const readAutomaticCallbackAccount$ = command(
  async (
    { set },
    args: AutomaticConnectionOwner & {
      readonly connectionId: string;
      readonly expectedRevision: string | null;
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
          eq(connectors.updatedAt, sql`${args.expectedRevision}::timestamp`),
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
  readonly binding: Omit<
    typeof builtinConnectorAccountOauthBindings.$inferInsert,
    "connectorAccountId" | "createdAt"
  >;
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
    authMethod: input.binding.authMethod,
    automaticAuthType: "oauth" as const,
    storageVersion: input.binding.storageVersion,
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
  if (!input.binding.dcrRegistrationId) {
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
export const publishAutomaticCallbackConnection$ = command(
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
      const [catalog] = await tx
        .select({ sourceId: connectorCatalogActiveSnapshot.sourceId })
        .from(connectorCatalogActiveSnapshot)
        .where(builtinDcrCatalogCondition(input.catalogIdentity))
        .for("share")
        .limit(1);
      if (!catalog) {
        return { kind: "error", reason: "stale-contract" };
      }
      await tx.execute(builtinConnectorAutomaticLifecycleLockStatement(input));
      await tx.execute(builtinConnectorStateLockStatement(input));
      if (input.binding.registrationMethod === "dcr") {
        const [registration] = await tx
          .select({ id: builtinConnectorDcrRegistrations.id })
          .from(builtinConnectorDcrRegistrations)
          .where(automaticBoundRegistrationCondition(input))
          .for("key share")
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
        const existing = await tx
          .select({ id: connectors.id })
          .from(connectors)
          .where(automaticConnectionOwnerCondition(input))
          .orderBy(connectors.id)
          .for("update")
          .limit(1);
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
          .values({ ...values, isDefault: existing.length === 0 })
          .onConflictDoNothing()
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
      await tx
        .insert(builtinConnectorAccountOauthBindings)
        .values({ ...input.binding, connectorAccountId: connectionId });
      signal.throwIfAborted();
      return { kind: "connected", connectionId };
    });
  },
);
