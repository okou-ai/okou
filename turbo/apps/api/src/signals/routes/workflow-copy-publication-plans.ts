import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { gmailLabelAppliedEventConfigSchema } from "@okouai/api-contracts/contracts/workflows";
import {
  workflows,
  workflowWebhookAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import {
  pgTextDecoder,
  nullableDriverValueDecoder,
} from "../../lib/db-structured-result";
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
import { officialAccountProjectionReadPlan } from "../services/official-workflow-account-projection";
import { prepareChatThreadInsert } from "../services/chat-thread-create.service";
import type { WorkflowThreadPreparation } from "../services/workflow-user-automation-thread.service";
import type { WorkflowAttachments } from "@okouai/db/jsonb-contracts/workflow";
import {
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
  readonly attachments: WorkflowAttachments;
  readonly contentBundle: ContentBundle;
  readonly targetWorkflowId: string;
  readonly threadPreparation: WorkflowThreadPreparation;
  readonly currentTime: Date;
  readonly inheritedAutonomyBudget: number | undefined;
  readonly source: WorkflowCopySource;
  readonly cleanupJobId: string | null;
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
    attachments: args.attachments,
    contentBundle: args.contentBundle,
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
        isNull(workflows.officialDefinitionName),
      ),
    )
    .limit(1)
    .as("copy_slug");
}
export function copySlugConflict(name: string) {
  return `You already have a private workflow named "/${name}" on this agent. Rename the existing workflow or choose a different name.`;
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
  "google-forms": [],
} as const;
type CopyProjectionRow = Pick<
  typeof workflowAutomations.$inferSelect,
  "id" | "workflowId" | "eventType" | "eventConfig" | "eventConnectorId"
>;

export function copyProjectionValues(
  loaded: {
    readonly automation: CopyProjectionRow;
    readonly connectorId: string | null;
  },
  slug: WorkflowAutomationAccountConnectorSlug,
) {
  const { automation: row, connectorId } = loaded;
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
export function copyPublicationPlans(args: WorkflowCopyPublicationArgs) {
  return {
    slug: workflowCopySlugQuery({
      ...args,
      sourceWorkflow: args.source.sourceWorkflow,
    }),
    workflow: workflowCopyRowValues({
      ...args,
      sourceWorkflow: args.source.sourceWorkflow,
    }),
    thread: workflowCopyThreadPlan(args),
    bindingValues: workflowCopyThreadBindingValues(args),
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
      observedXmin: sql`${workflowAutomations}.xmin::text`
        .mapWith(pgTextDecoder)
        .as("observed_xmin"),
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
      observedXmin: source.observedXmin,
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

export function copyNotionInvalidationValues() {
  const currentTime = nowDate();
  return {
    status: "skipped" as const,
    skipReason:
      "Notion account selection changed before the event was processed",
    processedAt: currentTime,
    updatedAt: currentTime,
  };
}
