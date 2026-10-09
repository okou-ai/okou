import { connectors } from "@okouai/db/schema/connector";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, isNotNull, sql } from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import {
  builtinConnectorCredentialConnectionColumns,
  builtinConnectorCredentialConnectionFromRow,
  type BuiltinConnectorCredentialConnectionResult,
} from "./builtin-connector-credential-runtime.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeAuthSelectionFromRows,
  connectorRuntimeAuthSelectionReadPlan,
} from "./connector-catalog-slug-source.service";
import { workflowAutomationConnectorSelectionSql } from "./workflow-automation-account.service";
import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "./workflow-automation-account-classification.service";

export interface OfficialAccountProjectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly workflowId: string;
  readonly currentEventType: string | null;
  readonly nextEventType: string | null;
}

export type OfficialAutomationAccountProjection =
  | { readonly kind: "not-required" }
  | {
      readonly kind: "projected";
      readonly connectorSlug: WorkflowAutomationAccountConnectorSlug | null;
      readonly eventConnectorId: string | null;
      readonly stripeBinding: {
        readonly connectorId: string;
        readonly stripeAccountId: string;
        readonly mode: "live";
      } | null;
    };

/**
 * Capture the account selection, current catalog, connection and Live-mode
 * variable in one statement. Account rows stay unlocked; concurrent account
 * changes still converge through account reprojection and repair. One snapshot
 * avoids combining the first Stripe selection with a later fallback selection.
 * The owner/workflow selection and default-account indexes bound selection to
 * one value. The catalog pointer, hash/slug entry, connection and connector/name
 * variable keys each permit at most one joined row. Non-Stripe joins stay false.
 */
export function officialAccountProjectionReadPlan(
  args: OfficialAccountProjectionArgs,
) {
  const nextConnectorSlug = workflowAutomationAccountConnectorSlug(
    args.nextEventType,
  );
  const required =
    nextConnectorSlug !== null ||
    workflowAutomationAccountConnectorSlug(args.currentEventType) !== null;
  const selection =
    nextConnectorSlug === null
      ? sql`SELECT NULL::uuid AS "connectorId"`
      : workflowAutomationConnectorSelectionSql({
          ...args,
          connectorSlug: nextConnectorSlug,
        });
  const selectedConnectorId = sql`projection_selection."connectorId"`;
  const stripeRead =
    nextConnectorSlug === "stripe"
      ? isNotNull(selectedConnectorId)
      : sql`FALSE`;
  const catalogPlan = connectorRuntimeAuthSelectionReadPlan({
    connectorSlugs: ["stripe"],
  });
  return {
    args,
    required,
    nextConnectorSlug,
    source: sql`(${selection}) AS projection_selection`,
    columns: {
      connectorId: selectedConnectorId.mapWith(
        nullableDriverValueDecoder(connectors.id),
      ),
      catalog: catalogPlan.columns.current,
      catalogEntry: catalogPlan.columns.entry,
      connection: builtinConnectorCredentialConnectionColumns(),
      livemode: variables.value,
    },
    catalogJoin: and(stripeRead, connectorCatalogCurrentWhere()),
    entryJoin: and(stripeRead, catalogPlan.join),
    connectionJoin: and(
      stripeRead,
      eq(connectors.id, selectedConnectorId),
      eq(connectors.orgId, args.orgId),
      eq(connectors.userId, args.userId),
      eq(connectors.connectorSlug, "stripe"),
    ),
    variableJoin: and(
      eq(variables.connectorId, connectors.id),
      eq(variables.orgId, args.orgId),
      eq(variables.userId, args.userId),
      eq(variables.type, "connector"),
      eq(variables.name, "STRIPE_LIVEMODE"),
    ),
  };
}

function stripeProjectionCandidate(
  loaded: BuiltinConnectorCredentialConnectionResult,
) {
  if (loaded.kind !== "ok") {
    return null;
  }
  const { connection } = loaded;
  if (
    connection.runtimeMethod.authMethodId !== "oauth" ||
    connection.needsReconnect ||
    connection.externalId === null ||
    connection.externalId.trim().length === 0 ||
    !connection.runtimeMethod.method.storage.variables.includes(
      "STRIPE_LIVEMODE",
    )
  ) {
    return null;
  }
  return {
    connection,
    binding: {
      connectorId: connection.connectorId,
      stripeAccountId: connection.externalId,
      mode: "live" as const,
    },
  };
}

type AuthSelectionRow = Parameters<
  typeof connectorRuntimeAuthSelectionFromRows
>[0][number];
type ConnectionRow = Exclude<
  Parameters<typeof builtinConnectorCredentialConnectionFromRow>[1],
  undefined
>;

export function officialAccountProjectionFromRow(
  plan: Pick<
    ReturnType<typeof officialAccountProjectionReadPlan>,
    "args" | "required" | "nextConnectorSlug"
  >,
  row:
    | {
        readonly connectorId: string | null;
        readonly catalog: AuthSelectionRow["current"] | null;
        readonly catalogEntry: AuthSelectionRow["entry"];
        readonly connection: ConnectionRow | null;
        readonly livemode: string | null;
      }
    | undefined,
): OfficialAutomationAccountProjection {
  if (!plan.required) {
    return { kind: "not-required" };
  }
  if (!row) {
    throw new Error("Official Workflow account projection is incomplete");
  }
  let stripeBinding: Extract<
    OfficialAutomationAccountProjection,
    { readonly kind: "projected" }
  >["stripeBinding"] = null;
  if (plan.nextConnectorSlug === "stripe" && row.connectorId !== null) {
    const snapshot = connectorRuntimeAuthSelectionFromRows(
      row.catalog === null
        ? []
        : [{ current: row.catalog, entry: row.catalogEntry }],
      ["stripe"],
      [],
    );
    const loaded = builtinConnectorCredentialConnectionFromRow(
      {
        ...plan.args,
        connectorId: row.connectorId,
        connectorSlug: "stripe",
        snapshot,
      },
      row.connection ?? undefined,
    );
    const candidate = stripeProjectionCandidate(loaded);
    // Credential-value reads fence the canonical storage version even when a
    // grant-less method tolerates a stored connection's older version.
    if (
      candidate !== null &&
      row.connection?.storageVersion === candidate.connection.storageVersion &&
      row.livemode === "true"
    ) {
      stripeBinding = candidate.binding;
    }
  }
  return {
    kind: "projected",
    connectorSlug: plan.nextConnectorSlug,
    eventConnectorId: row.connectorId,
    stripeBinding,
  };
}
