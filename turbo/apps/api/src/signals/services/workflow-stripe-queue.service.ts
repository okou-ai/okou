import {
  stripeInvoiceBillingReasonSchema,
  stripeInvoicePaidEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import {
  stripeWorkflowAutomationHealth,
  stripeWorkflowDeliveries,
} from "@okouai/db/schema/stripe-automation-event";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { variables } from "@okouai/db/schema/variable";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import {
  builtinConnectorCredentialVariableReadCondition,
  resolveBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-access.service";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
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

function stripeSourceCredentialAccess(
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
  chatThreadId: string,
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

/** One invoice trigger validates its current owner/source and commits queue + receipt. */
export async function persistStripeWorkflowSource(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly source: StripeQueueSource;
    readonly snapshot: ConnectorRuntimeSnapshot;
  },
  signal: AbortSignal,
): Promise<void> {
  const { source } = args;
  const snapshot = args.snapshot;
  const [connector] = await tx
    .select()
    .from(connectors)
    .where(eq(connectors.id, source.connectorId))
    .limit(1);
  const [automation] = await tx
    .select()
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, source.automationId))
    .limit(1);
  const access = stripeSourceCredentialAccess(
    source,
    automation,
    connector,
    snapshot,
  );
  const overrides = await tx
    .select({
      userId: userFeatureSwitches.userId,
      switches: userFeatureSwitches.switches,
    })
    .from(userFeatureSwitches)
    .where(
      and(
        eq(userFeatureSwitches.orgId, source.orgId),
        inArray(userFeatureSwitches.userId, [
          source.userId,
          ORG_SENTINEL_USER_ID,
        ]),
      ),
    );
  if (
    !isFeatureEnabled(FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations, {
      orgId: source.orgId,
      userId: source.userId,
      overrides: userFeatureSwitchOverridesFromRows(overrides, source.userId),
    })
  ) {
    throw new StripeDeliveryTargetChangedError("feature_disabled");
  }
  const [livemode] = await tx
    .select({ value: variables.value })
    .from(variables)
    .where(
      builtinConnectorCredentialVariableReadCondition({
        groups: [{ access, names: ["STRIPE_LIVEMODE"] }],
      }),
    )
    .limit(1);
  if (livemode?.value !== "true") {
    throw new StripeDeliveryTargetChangedError("connector_unavailable");
  }
  if (
    (await tx.execute(stripeSourceAccessSql(source, args.chatThreadId)))
      .rowCount === 0
  ) {
    throw new StripeDeliveryTargetChangedError("automation_access_revoked");
  }
  if (
    (
      await tx.execute(
        stripeDeliveryReceiptSql(source, args.chatThreadId, nowDate()),
      )
    ).rowCount === 0
  ) {
    throw new StripeDeliveryClaimChangedError();
  }
  signal.throwIfAborted();
}
