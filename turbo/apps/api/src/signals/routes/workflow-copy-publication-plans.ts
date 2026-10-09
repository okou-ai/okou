import { StorageVersionIdentityConflictError } from "../services/storage-version-registration.service";
import {
  gmailLabelAppliedEventConfigSchema,
  stripeInvoicePaidEventConfigSchema,
} from "@okouai/api-contracts/contracts/workflows";
import {
  workflows,
  workflowAutomations,
  workflowWebhookAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { storages } from "@okouai/db/schema/storage";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, inArray, sql } from "drizzle-orm";

import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { QueryBuilder, alias } from "drizzle-orm/pg-core";
import {
  notionConfigConnectorId,
  notionConfigWithConnectorId,
} from "../services/notion-automation-account.service";
import { GOOGLE_CALENDAR_EVENT_TYPES } from "../services/google-calendar-automation-account.service";
import {
  workflowAutomationAccountConnectorSlug,
  type WorkflowAutomationAccountConnectorSlug,
} from "../services/workflow-automation-account-classification.service";
import {
  officialAccountProjectionReadPlan,
  officialAccountProjectionFromRow,
  type OfficialAutomationAccountProjection,
} from "../services/official-workflow-account-projection";
import { prepareChatThreadInsert } from "../services/chat-thread-create.service";
import {
  workflowUserAutomationThreadOwnerCondition,
  type WorkflowThreadPreparation,
} from "../services/workflow-user-automation-thread.service";
import type { PreparedServerSideVolume } from "../services/storage-volume-publication.service";
import {
  CopyPreparationConflict,
  copySourcePlans,
  type WorkflowCopyInput,
  WorkflowCopySource,
} from "./workflow-copy-source";

export type PreparedCopiedWebhook = Pick<
  typeof workflowWebhookAutomations.$inferInsert,
  "tokenHash" | "encryptedToken" | "encryptedSecret" | "secretLastFour"
>;
export type CopyWorkflowDatabaseResult =
  | {
      readonly kind: "conflict";
      readonly message: string;
    }
  | {
      readonly kind: "ok";
      readonly inserted: {
        readonly id: string;
      };
      readonly accountConnectorSlugs: readonly WorkflowAutomationAccountConnectorSlug[];
    };

export interface WorkflowCopyPublicationArgs extends WorkflowCopyInput {
  readonly targetWorkflowId: string;
  readonly threadPreparation: WorkflowThreadPreparation;
  readonly currentTime: Date;
  readonly inheritedAutonomyBudget: number | undefined;
  readonly source: WorkflowCopySource;
  readonly volume: PreparedServerSideVolume;
  readonly preparedWebhooks: ReadonlyMap<string, PreparedCopiedWebhook>;
}

export function copyConnectorSlugs(
  rows: readonly (typeof workflowAutomations.$inferSelect)[],
) {
  return [
    ...new Set(
      rows
        .map((row) => {
          return workflowAutomationAccountConnectorSlug(row.eventType);
        })
        .filter((slug): slug is WorkflowAutomationAccountConnectorSlug => {
          return slug !== null;
        }),
    ),
  ].sort();
}

export function workflowCopyRowValues(
  args: WorkflowCopyPublicationArgs,
): typeof workflows.$inferInsert {
  return {
    id: args.targetWorkflowId,
    orgId: args.orgId,
    agentId: args.targetAgentId,
    name: args.sourceWorkflow.name,
    visibility: "private",
    instruction: args.sourceWorkflow.instruction,
    ownerUserId: args.userId,
    displayName: args.sourceWorkflow.displayName,
    description: args.sourceWorkflow.description,
    createdBy: args.userId,
    updatedBy: args.userId,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

export function workflowCopyAutomationValues(
  args: WorkflowCopyPublicationArgs,
  automation: typeof workflowAutomations.$inferSelect,
) {
  return {
    orgId: args.orgId,
    workflowId: args.targetWorkflowId,
    ownerUserId: args.userId,
    kind: automation.kind,
    eventType: automation.eventType,
    eventConfig: automation.eventConfig,
    scheduleType: automation.scheduleType,
    cronExpression: automation.cronExpression,
    intervalSeconds: automation.intervalSeconds,
    atTime: automation.atTime,
    timezone: automation.timezone,
    enabled: automation.enabled,
    nextRunAt: automation.nextRunAt,
    lastRunAt: null,
    lastRunId: null,
    consecutiveFailures: 0,
    autonomyBudget: args.inheritedAutonomyBudget ?? automation.autonomyBudget,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}

export function workflowCopySlugQuery(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly targetAgentId: string;
  readonly sourceWorkflow: WorkflowCopyInput["sourceWorkflow"];
}) {
  return new QueryBuilder()
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, args.orgId),
        eq(workflows.agentId, args.targetAgentId),
        eq(workflows.ownerUserId, args.userId),
        eq(workflows.name, args.sourceWorkflow.name),
        eq(workflows.visibility, "private"),
      ),
    )
    .limit(1)
    .as("copy_slug");
}
export function copySlugConflict(name: string) {
  return `You already have a private workflow named "/${name}" on this agent. Rename the existing workflow or choose a different name.`;
}
export function workflowCopyPreparedStorageQuery(storageId: string) {
  return new QueryBuilder()
    .select({ id: storages.id })
    .from(storages)
    .where(eq(storages.id, storageId))
    .for("update")
    .as("copy_prepared_storage");
}

const copyProjectionEventTypes = {
  gmail: ["gmail-new-message", "gmail-label-applied"],
  "google-calendar": [...GOOGLE_CALENDAR_EVENT_TYPES],
  "google-meet": ["google-meet-transcript-generated"],
  notion: [
    "notion-child-page-created",
    "notion-database-item-created",
    "notion-page-content-updated",
  ],
  stripe: ["stripe-invoice-paid"],
  "google-forms": [],
} as const;
type CopyProjectionRow = Pick<
  typeof workflowAutomations.$inferSelect,
  "id" | "workflowId" | "eventType" | "eventConfig" | "eventConnectorId"
>;
export type CopyStripeBinding = Extract<
  OfficialAutomationAccountProjection,
  { kind: "projected" }
>["stripeBinding"];

export function copyProjectionValues(
  loaded: {
    readonly automation: CopyProjectionRow;
    readonly connectorId: string | null;
  },
  slug: WorkflowAutomationAccountConnectorSlug,
  binding: CopyStripeBinding,
) {
  const { automation: row, connectorId } = loaded;
  if (slug === "stripe" && binding !== null) {
    const config = stripeInvoicePaidEventConfigSchema.parse(row.eventConfig);
    return row.eventConnectorId === connectorId &&
      config.connectorId === binding.connectorId &&
      config.stripeAccountId === binding.stripeAccountId &&
      config.mode === binding.mode
      ? null
      : {
          eventConnectorId: connectorId,
          eventConfig: { ...config, ...binding },
        };
  }
  if (slug === "notion") {
    if (
      row.eventConnectorId === connectorId &&
      (connectorId === null ||
        notionConfigConnectorId(row.eventType, row.eventConfig) === connectorId)
    ) {
      return null;
    }
    const eventConfig =
      connectorId === null
        ? row.eventConfig
        : notionConfigWithConnectorId(
            row.eventType,
            row.eventConfig,
            connectorId,
          );
    return {
      eventConnectorId: connectorId,
      ...(eventConfig === null ? {} : { eventConfig }),
    };
  }
  if (row.eventConnectorId === connectorId) {
    return null;
  }
  if (slug === "gmail") {
    const config =
      row.eventType === "gmail-label-applied"
        ? gmailLabelAppliedEventConfigSchema.parse(row.eventConfig)
        : null;
    return {
      eventConnectorId: connectorId,
      eventConfig: config
        ? {
            provider: config.provider,
            event: config.event,
            labelName: config.labelName,
          }
        : row.eventConfig,
    };
  }
  return { eventConnectorId: connectorId };
}

export function workflowCopyThreadPlan(args: WorkflowCopyPublicationArgs) {
  const pin = args.threadPreparation.initialModel;
  return prepareChatThreadInsert({
    orgId: args.orgId,
    userId: args.userId,
    agentId: args.targetAgentId,
    title: args.threadPreparation.title,
    modelSettings: args.threadPreparation.modelSettings,
    cloudBrowserEnabled: args.threadPreparation.cloudBrowserEnabled,
    selectedModel: pin.selectedModel,
    codexServiceTier: pin.serviceTier === "priority" ? "fast" : null,
    lastMessageAt: args.currentTime,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  });
}
export function copyThreadColumns() {
  return {
    id: chatThreads.id,
    userId: chatThreads.userId,
    title: chatThreads.title,
    selectedModel: chatThreads.selectedModel,
    modelSettings: chatThreads.modelSettings,
    codexServiceTier: chatThreads.codexServiceTier,
    computerUseHostId: chatThreads.computerUseHostId,
    cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    createdAt: chatThreads.createdAt,
  };
}
export function workflowCopyThreadBindingValues(
  args: WorkflowCopyPublicationArgs,
) {
  return {
    orgId: args.orgId,
    userId: args.userId,
    workflowId: args.targetWorkflowId,
    createdAt: args.currentTime,
    updatedAt: args.currentTime,
  };
}
export function copyBindingConflict() {
  return {
    target: [
      workflowUserAutomationThreads.orgId,
      workflowUserAutomationThreads.userId,
      workflowUserAutomationThreads.workflowId,
    ],
  };
}

export function copyPublicationPlans(args: WorkflowCopyPublicationArgs) {
  return {
    ...copySourcePlans(args),
    slug: workflowCopySlugQuery({
      ...args,
      sourceWorkflow: args.source.sourceWorkflow,
    }),
    preparedStorage: workflowCopyPreparedStorageQuery(
      args.volume.version.storageId,
    ),
    workflow: workflowCopyRowValues({
      ...args,
      sourceWorkflow: args.source.sourceWorkflow,
    }),
    thread: workflowCopyThreadPlan(args),
    bindingValues: workflowCopyThreadBindingValues(args),
    binding: new QueryBuilder()
      .select({ chatThreadId: workflowUserAutomationThreads.chatThreadId })
      .from(workflowUserAutomationThreads)
      .where(
        workflowUserAutomationThreadOwnerCondition({
          ...args,
          workflowId: args.targetWorkflowId,
        }),
      )
      .limit(1)
      .as("copy_binding"),
    bindingCondition: workflowUserAutomationThreadOwnerCondition({
      ...args,
      workflowId: args.targetWorkflowId,
    }),
    idColumns: { id: workflows.id },
    storageError: `Prepared workflow storage not found: ${args.targetWorkflowId}`,
    workflowError: "Failed to copy workflow",
    automationError: "Failed to copy workflow automation",
    threadError: "Failed to create workflow automation chat thread",
  };
}
export function copyAutomationPlan(
  args: WorkflowCopyPublicationArgs,
  automation: typeof workflowAutomations.$inferSelect,
) {
  const webhook =
    automation.kind === "event" && automation.eventType === "webhook-received"
      ? args.preparedWebhooks.get(automation.id)
      : null;
  if (webhook === undefined) {
    throw new Error("Missing prepared webhook credentials");
  }
  return {
    values: workflowCopyAutomationValues(args, automation),
    webhook: webhook
      ? { ...webhook, createdAt: args.currentTime, updatedAt: args.currentTime }
      : null,
  };
}
export function requireCopiedRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}
export function copyNeedsThread(source: WorkflowCopySource) {
  return source.sourceAutomations.some((row) => {
    return row.kind === "event";
  });
}

/** One statement captures each provider's owner-wide selected accounts. */
export function copyAccountReadPlan(
  args: WorkflowCopyPublicationArgs,
  slug: Exclude<WorkflowAutomationAccountConnectorSlug, "google-forms">,
) {
  const defaults = alias(connectors, "copy_default_account");
  const selectedId = sql`CASE WHEN ${chatThreadConnectorSelections.connectorSlug} IS NOT NULL
    THEN ${chatThreadConnectorSelections.connectorId} ELSE ${defaults.id} END`;
  const source = new QueryBuilder()
    .select({
      id: workflowAutomations.id,
      workflowId: workflowAutomations.workflowId,
      eventType: workflowAutomations.eventType,
      eventConfig: workflowAutomations.eventConfig,
      eventConnectorId: workflowAutomations.eventConnectorId,
      connectorId: selectedId
        .mapWith(nullableDriverValueDecoder(connectors.id))
        .as("connectorId"),
    })
    .from(workflowAutomations)
    .leftJoin(
      workflowUserAutomationThreads,
      and(
        eq(workflowUserAutomationThreads.orgId, workflowAutomations.orgId),
        eq(
          workflowUserAutomationThreads.userId,
          workflowAutomations.ownerUserId,
        ),
        eq(
          workflowUserAutomationThreads.workflowId,
          workflowAutomations.workflowId,
        ),
      ),
    )
    .leftJoin(
      chatThreadConnectorSelections,
      and(
        eq(
          chatThreadConnectorSelections.chatThreadId,
          workflowUserAutomationThreads.chatThreadId,
        ),
        eq(chatThreadConnectorSelections.connectorSlug, slug),
      ),
    )
    .leftJoin(
      defaults,
      and(
        eq(defaults.orgId, args.orgId),
        eq(defaults.userId, args.userId),
        eq(defaults.connectorSlug, slug),
        eq(defaults.isDefault, true),
      ),
    )
    .where(
      and(
        eq(workflowAutomations.orgId, args.orgId),
        eq(workflowAutomations.ownerUserId, args.userId),
        eq(workflowAutomations.kind, "event"),
        inArray(workflowAutomations.eventType, [
          ...copyProjectionEventTypes[slug],
        ]),
      ),
    )
    .as("projection_selection");
  const eventType = copyProjectionEventTypes[slug][0];
  const plan = officialAccountProjectionReadPlan({
    ...args,
    workflowId: args.source.sourceWorkflow.id,
    currentEventType: eventType,
    nextEventType: eventType,
  });
  return {
    ...plan,
    source,
    columns: {
      ...plan.columns,
      automation: {
        id: source.id,
        workflowId: source.workflowId,
        eventType: source.eventType,
        eventConfig: source.eventConfig,
        eventConnectorId: source.eventConnectorId,
      },
    },
  };
}

export function cachedCopyStripeBinding(
  plan: ReturnType<typeof copyAccountReadPlan>,
  row: Parameters<typeof officialAccountProjectionFromRow>[1],
  cache: Map<string, CopyStripeBinding>,
): CopyStripeBinding {
  if (plan.nextConnectorSlug !== "stripe" || !row?.connectorId) {
    return null;
  }
  const cached = cache.get(row.connectorId);
  if (cached !== undefined) {
    return cached;
  }
  const projection = officialAccountProjectionFromRow(plan, row);
  const binding =
    projection.kind === "projected" ? projection.stripeBinding : null;
  cache.set(row.connectorId, binding);
  return binding;
}

export function copyNotionInvalidation(automationId: string) {
  const currentTime = nowDate();
  return {
    values: {
      status: "skipped" as const,
      skipReason:
        "Notion account selection changed before the event was processed",
      processedAt: currentTime,
      updatedAt: currentTime,
    },
    condition: and(
      eq(notionWorkflowPendingEvents.automationId, automationId),
      inArray(notionWorkflowPendingEvents.status, ["pending", "running"]),
    ),
  };
}

export function requireCopySlugAvailable(
  row: { readonly id: string } | undefined,
  name: string,
): void {
  if (row) {
    throw new CopyPreparationConflict(copySlugConflict(name));
  }
}
export function requireCopyVolumePublished(
  count: number | null,
  versionId: string,
): void {
  if (count !== 1) {
    throw new StorageVersionIdentityConflictError(versionId);
  }
}
export function checkCopyStripeAbort(
  slug: WorkflowAutomationAccountConnectorSlug,
  signal: AbortSignal,
): void {
  if (slug === "stripe") {
    signal.throwIfAborted();
  }
}
