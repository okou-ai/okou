import {
  stripeInvoiceBillingReasonSchema,
  stripeInvoicePaidEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import {
  stripeWorkflowAutomationHealth,
  stripeWorkflowDeliveries,
} from "@okouai/db/schema/stripe-automation-event";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, or, sql } from "drizzle-orm";
import {
  resolveBuiltinConnectorCredentialAccess,
  builtinConnectorCredentialVariableReadCondition,
} from "./builtin-connector-credential-access.service";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import { variables } from "@okouai/db/schema/variable";
import type { WorkflowSourceAdmissionPlan } from "./workflow-input-queue.service";
import { visibleWorkflowCondition } from "./workflow-data.service";

export type StripeQueueSource = Pick<
  typeof stripeWorkflowDeliveries.$inferSelect,
  | "id"
  | "revision"
  | "automationId"
  | "connectorId"
  | "stripeAccountId"
  | "livemode"
  | "billingReason"
> & { readonly orgId: string; readonly userId: string };

export class StripeDeliveryClaimChangedError extends Error {
  constructor() {
    super("Stripe workflow delivery claim changed");
    this.name = "StripeDeliveryClaimChangedError";
  }
}

export class StripeDeliveryTargetChangedError extends Error {
  constructor(readonly reason: string) {
    super("Stripe workflow delivery target changed");
    this.name = "StripeDeliveryTargetChangedError";
  }
}

function stripeSourceConfigMatches(
  source: StripeQueueSource,
  automation: typeof workflowAutomations.$inferSelect,
  connector: typeof connectors.$inferSelect,
): boolean {
  const config = stripeInvoicePaidEventConfigSchema.safeParse(
    automation.eventConfig,
  );
  const billingReason = stripeInvoiceBillingReasonSchema.safeParse(
    source.billingReason,
  );
  return !(
    !config.success ||
    automation.kind !== "event" ||
    automation.eventType !== "stripe-invoice-paid" ||
    !automation.enabled ||
    !source.livemode ||
    automation.eventConnectorId !== source.connectorId ||
    config.data.connectorId !== source.connectorId ||
    config.data.stripeAccountId !== source.stripeAccountId ||
    connector.externalId !== source.stripeAccountId ||
    connector.needsReconnect ||
    (config.data.billingReasons?.length &&
      (!billingReason.success ||
        !config.data.billingReasons.includes(billingReason.data)))
  );
}

export function stripeSourceCredentialAccess(
  source: StripeQueueSource,
  automation: typeof workflowAutomations.$inferSelect | undefined,
  connector: typeof connectors.$inferSelect | undefined,
  snapshot: ConnectorRuntimeSnapshot,
) {
  if (
    !automation ||
    !connector ||
    automation.orgId !== source.orgId ||
    automation.ownerUserId !== source.userId ||
    connector.orgId !== source.orgId ||
    connector.userId !== source.userId ||
    connector.connectorSlug !== "stripe" ||
    connector.authMethod !== "oauth"
  ) {
    throw new StripeDeliveryTargetChangedError("automation_target_unavailable");
  }
  if (!stripeSourceConfigMatches(source, automation, connector)) {
    throw new StripeDeliveryTargetChangedError("automation_no_longer_matches");
  }
  const access = resolveBuiltinConnectorCredentialAccess({
    snapshot,
    stored: {
      authMethodId: connector.authMethod,
      automaticAuthType: connector.automaticAuthType,
      connectorId: connector.id,
      connectorSlug: "stripe",
      orgId: source.orgId,
      userId: source.userId,
      storageVersion: connector.storageVersion,
    },
  });
  if (
    access.kind !== "ok" ||
    !access.access.runtimeMethod.method.storage.variables.includes(
      "STRIPE_LIVEMODE",
    )
  ) {
    throw new StripeDeliveryTargetChangedError("connector_unavailable");
  }
  return access.access;
}

/** Finite source visibility read; the SQL builder never executes a database handle. */
function stripeSourceAccessSql(
  source: StripeQueueSource,
  chatThreadId: string,
) {
  return sql`SELECT ${workflows.id} FROM ${workflows}
    JOIN ${agents} ON ${agents.id} = ${workflows.agentId}
    JOIN ${workflowAutomations} ON ${workflowAutomations.workflowId} = ${workflows.id}
    JOIN ${orgMembersCache} ON ${orgMembersCache.orgId} = ${source.orgId} AND ${orgMembersCache.userId} = ${source.userId}
    JOIN ${workflowUserAutomationThreads} ON ${workflowUserAutomationThreads.orgId} = ${source.orgId}
      AND ${workflowUserAutomationThreads.userId} = ${source.userId}
      AND ${workflowUserAutomationThreads.workflowId} = ${workflows.id}
    WHERE ${workflowAutomations.id} = ${source.automationId}
      AND ${workflows.orgId} = ${source.orgId}
      AND ${workflowUserAutomationThreads.chatThreadId} = ${chatThreadId}
      AND (${workflowAutomations.officialBlueprintKey} IS NULL OR ${workflowAutomations.officialReconciliationStatus} = 'current')
      AND ${visibleWorkflowCondition({ userId: source.userId, role: "member" })}
      AND ${or(eq(agents.visibility, "public"), eq(agents.owner, source.userId))}
    LIMIT 1`;
}

/** The existing delivery revision is the receipt for this single queue publication. */
function stripeDeliveryReceiptSql(
  source: StripeQueueSource,
  currentTime: Date,
) {
  const timestamp = sql`${currentTime.toISOString()}::timestamp`;
  return sql`WITH delivered AS (
    UPDATE ${stripeWorkflowDeliveries}
    SET status = 'delivered', claim_expires_at = NULL, delivered_at = ${timestamp}, last_error = NULL, updated_at = ${timestamp}
    WHERE ${stripeWorkflowDeliveries.id} = ${source.id}
      AND ${stripeWorkflowDeliveries.status} = 'pending' AND ${stripeWorkflowDeliveries.revision} = ${source.revision}
    RETURNING id
  ), health AS (
    UPDATE ${stripeWorkflowAutomationHealth}
    SET latest_delivery_status = 'delivered', latest_delivery_status_at = ${timestamp}, updated_at = ${timestamp}
    WHERE ${stripeWorkflowAutomationHealth.automationId} = ${source.automationId}
      AND ${stripeWorkflowAutomationHealth.latestDeliveryId} = ${source.id}
      AND EXISTS (SELECT 1 FROM delivered)
  )
  SELECT id FROM delivered`;
}

/** Current SQL authority must still match the independently prepared facts. */
export function stripeQueueAdmissionPlan(args: {
  readonly source: StripeQueueSource;
  readonly chatThreadId: string;
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly connector: typeof connectors.$inferSelect;
  readonly access: ReturnType<typeof stripeSourceCredentialAccess>;
  readonly currentTime: Date;
}): WorkflowSourceAdmissionPlan {
  const { source, automation, connector } = args;
  return {
    steps: [
      {
        statement: sql`SELECT 1 FROM ${workflowAutomations} JOIN ${connectors}
        ON ${connectors.id} = ${source.connectorId}::uuid
        WHERE ${and(
          eq(workflowAutomations.id, source.automationId),
          eq(workflowAutomations.orgId, source.orgId),
          eq(workflowAutomations.ownerUserId, source.userId),
          eq(workflowAutomations.kind, "event"),
          eq(workflowAutomations.eventType, "stripe-invoice-paid"),
          eq(workflowAutomations.enabled, true),
          eq(workflowAutomations.eventConnectorId, source.connectorId),
          sql`${workflowAutomations.eventConfig} IS NOT DISTINCT FROM ${JSON.stringify(automation.eventConfig)}::jsonb`,
          eq(connectors.orgId, source.orgId),
          eq(connectors.userId, source.userId),
          eq(connectors.connectorSlug, "stripe"),
          eq(connectors.authMethod, "oauth"),
          eq(connectors.externalId, source.stripeAccountId),
          eq(connectors.needsReconnect, false),
          sql`${connectors.automaticAuthType} IS NOT DISTINCT FROM ${connector.automaticAuthType}`,
          eq(connectors.storageVersion, connector.storageVersion),
        )} LIMIT 1`,
        failure: {
          kind: "stripe-target",
          reason: "automation_no_longer_matches",
        },
      },
      {
        statement: sql`SELECT 1 FROM ${variables} WHERE ${and(
          builtinConnectorCredentialVariableReadCondition({
            groups: [{ access: args.access, names: ["STRIPE_LIVEMODE"] }],
          }),
          eq(variables.value, "true"),
        )} LIMIT 1`,
        failure: { kind: "stripe-target", reason: "connector_unavailable" },
      },
      {
        statement: stripeSourceAccessSql(source, args.chatThreadId),
        failure: { kind: "stripe-target", reason: "automation_access_revoked" },
      },
      {
        statement: stripeDeliveryReceiptSql(source, args.currentTime),
        failure: { kind: "stripe-claim" },
      },
    ],
  };
}
