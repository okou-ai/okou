import {
  stripeInvoicePaidEventConfigSchema,
  stripeInvoiceBillingReasonSchema,
} from "@okouai/api-contracts/contracts/workflows";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agents } from "@okouai/db/schema/agent";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { connectors } from "@okouai/db/schema/connector";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import {
  stripeWorkflowDeliveries,
  stripeWorkflowAutomationHealth,
} from "@okouai/db/schema/stripe-automation-event";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { variables } from "@okouai/db/schema/variable";
import {
  workflowAutomations,
  workflowUserAutomationThreads,
  workflows,
} from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  builtinConnectorCredentialVariableReadCondition,
  resolveBuiltinConnectorCredentialAccess,
} from "./builtin-connector-credential-access.service";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import {
  loadConnectorRuntimeSnapshot$,
  type ConnectorRuntimeSnapshot,
} from "./connector-catalog-runtime.service";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
import type { PreparedWorkflowAutomationQueueInput } from "./workflow-chat-event-queue.service";
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
  INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
    SELECT ${chatThreadId}::uuid, ${source.orgId}, ${timestamp} FROM delivered
    ON CONFLICT (chat_thread_id) DO UPDATE SET claim_id = NULL, claim_expires_at = NULL`;
}

/** One invoice trigger validates its current owner/source and commits queue + receipt. */
export const enqueueStripeWorkflowInput$ = command(
  async (
    { set },
    args: {
      readonly input: PreparedWorkflowAutomationQueueInput;
      readonly source: StripeQueueSource;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const snapshot = await set(loadConnectorRuntimeSnapshot$, signal);
    const { input, source } = args;
    return await db.transaction(async (tx) => {
      await tx
        .insert(chatAutomationContext)
        .values(input.context)
        .onConflictDoNothing();
      const [event] = parseRawRows(
        chatEventAppendResultSchema,
        await tx.execute(
          appendCanonicalChatEventsSql([input.event], input.conflict),
        ),
      );
      if (!event) {
        if (input.conflict === "none") {
          throw new Error("Workflow queue event insert returned no row");
        }
        return null;
      }
      // Target validation reads the current rows without row locks. The
      // delivery receipt below is the conditional write that decides this
      // publication (zero rows rolls the append back). A concurrent disable,
      // reconnect or feature change is not serialized with it: an input that
      // commits just before that change is admitted, exactly as if it had
      // arrived a moment earlier.
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
        !isFeatureEnabled(
          FeatureSwitchKey.StripeInvoicePaidWorkflowAutomations,
          {
            orgId: source.orgId,
            userId: source.userId,
            overrides: userFeatureSwitchOverridesFromRows(
              overrides,
              source.userId,
            ),
          },
        )
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
        (
          await tx.execute(
            stripeSourceAccessSql(source, input.event.chatThreadId),
          )
        ).rowCount === 0
      ) {
        throw new StripeDeliveryTargetChangedError("automation_access_revoked");
      }
      if (
        (
          await tx.execute(
            stripeDeliveryReceiptSql(
              source,
              input.event.chatThreadId,
              nowDate(),
            ),
          )
        ).rowCount === 0
      ) {
        throw new StripeDeliveryClaimChangedError();
      }
      signal.throwIfAborted();
      return event.id;
    });
  },
);
