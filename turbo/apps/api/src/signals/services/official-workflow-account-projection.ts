import { connectors } from "@okouai/db/schema/connector";
import { sql } from "drizzle-orm";

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
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
    };

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
  return {
    required,
    nextConnectorSlug,
    source: sql`(${selection}) AS projection_selection`,
    columns: {
      connectorId: sql`projection_selection."connectorId"`.mapWith(
        nullableDriverValueDecoder(connectors.id),
      ),
    },
  };
}

export function officialAccountProjectionFromRow(
  plan: Pick<
    ReturnType<typeof officialAccountProjectionReadPlan>,
    "required" | "nextConnectorSlug"
  >,
  row: { readonly connectorId: string | null } | undefined,
): OfficialAutomationAccountProjection {
  if (!plan.required) {
    return { kind: "not-required" };
  }
  if (!row) {
    throw new Error("Official Workflow account projection is incomplete");
  }
  return {
    kind: "projected",
    connectorSlug: plan.nextConnectorSlug,
    eventConnectorId: row.connectorId,
  };
}
