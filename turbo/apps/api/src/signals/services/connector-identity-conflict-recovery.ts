import {
  connectorConnectionExternalPrincipal,
  connectorConnectionPrincipalValue,
} from "./connector-account-mutation.service";
import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { isUniqueViolation } from "../../lib/pg-errors";
import { writeDb$ } from "../external/db";

/** Temporary outgoing-writer bridge; remove in #50784 after preparation drains. */
export const connectorIdentityConflictAccount$ = command(
  async (
    { set },
    args: {
      readonly error: unknown;
      readonly orgId: string;
      readonly userId: string;
      readonly target: ConnectorAccountTarget;
      readonly externalId: string | undefined;
      readonly issuer?: string;
      readonly externalUsername?: string | null;
    },
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    if (
      !args.externalId ||
      !isUniqueViolation(
        args.error,
        args.target.kind === "builtin"
          ? "idx_connectors_builtin_external_identity"
          : "idx_connectors_custom_external_identity",
      )
    ) {
      return undefined;
    }
    signal.throwIfAborted();
    const [account] = await set(writeDb$)
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          args.target.kind === "builtin"
            ? eq(connectors.connectorSlug, args.target.connectorSlug)
            : eq(connectors.customConnectorId, args.target.customConnectorId),
          eq(connectors.externalId, args.externalId),
          eq(connectors.externalIssuer, args.issuer ?? ""),
          eq(
            connectorConnectionExternalPrincipal(),
            connectorConnectionPrincipalValue(
              args.target.kind === "builtin" ? args.target.connectorSlug : null,
              args.externalUsername,
            ),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return account?.id;
  },
);
