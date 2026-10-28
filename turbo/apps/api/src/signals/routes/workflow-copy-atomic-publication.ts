import { randomUUID } from "node:crypto";
import { boolean, object } from "zod";
import { explicitModelSettings } from "@okouai/core/auto-run-model";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  workflows,
  workflowWebhookAutomations,
  workflowUserAutomationThreads,
} from "@okouai/db/schema/workflow";
import { and, count, exists, sql, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import {
  chatThreadEventInsertPlan,
  chatThreadServiceTierFromCodex,
} from "../services/chat-thread-event.service";
import { consumeWorkflowAttachmentCandidateSql } from "../services/workflow-attachment-cleanup.service";
import { workflowAutomationAccountConnectorSlug } from "../services/workflow-automation-account-classification.service";
import {
  copyPublicationPlans,
  copyAutomationPlan,
  copyProjectionValues,
  copyNeedsThread,
  type WorkflowCopyPublicationArgs,
} from "./workflow-copy-publication-plans";
import {
  copyAccountReadClauses,
  copyAccountWriteClauses,
  type CopyAccountSnapshot,
} from "./workflow-copy-account-publication";
import { copySourcePublicationClauses } from "./workflow-copy-source-publication";
import {
  copyInsertSql,
  copyInsertManySql,
  copyInsertInputAlias,
} from "./workflow-copy-write-sql";

export const copyPublicationResultSchema = object({
  source_valid: boolean(),
  slug_taken: boolean(),
  candidate_consumed: boolean(),
});
const copied = exists(sql`(SELECT 1 FROM copied_workflow)`);

function copiedAutomationClauses(
  args: WorkflowCopyPublicationArgs,
  accounts: readonly CopyAccountSnapshot[],
) {
  if (args.source.sourceAutomations.length === 0) {
    return { clauses: [], checks: [] };
  }
  const hooks: Readonly<Record<string, unknown>>[] = [];
  const rows = args.source.sourceAutomations.map((source) => {
    const automation = copyAutomationPlan(args, source);
    const id = randomUUID();
    const slug = workflowAutomationAccountConnectorSlug(source.eventType);
    const account = accounts.find((entry) => {
      return entry.slug === slug;
    });
    if (slug !== null && account === undefined) {
      throw new Error("Workflow copy account observation is missing");
    }
    const projected = account
      ? copyProjectionValues(
          {
            automation: {
              id,
              workflowId: args.targetWorkflowId,
              eventType: source.eventType,
              eventConfig: source.eventConfig,
              eventConnectorId: null,
            },
            connectorId: account.connectorId,
          },
          account.slug,
        )
      : null;
    if (automation.webhook) {
      hooks.push({ ...automation.webhook, automationId: id });
    }
    return { ...automation.values, id, eventConnectorId: null, ...projected };
  });
  const input = alias(workflowAutomations, copyInsertInputAlias);
  const eventConfig = sql`CASE WHEN ${input.eventType} = 'google-forms-response-submitted'
    AND ${input.eventConnectorId} IS NOT NULL
    AND ${input.eventConfig}->>'connectorId' IS DISTINCT FROM ${input.eventConnectorId}::text
    THEN jsonb_set(${input.eventConfig}, '{connectorId}', to_jsonb(${input.eventConnectorId}::text))
    ELSE ${input.eventConfig} END`;
  const clauses = [
    sql`copied_automations AS (${copyInsertManySql(workflowAutomations, rows, copied, workflowAutomations.id, { eventConfig })})`,
  ];
  const complete = sql`(SELECT ${count()} FROM copied_automations) = ${rows.length}`;
  const checks = [complete];
  if (hooks.length > 0) {
    clauses.push(
      sql`copied_hooks AS (${copyInsertManySql(
        workflowWebhookAutomations,
        hooks,
        sql`${copied} AND (${complete})`,
        workflowWebhookAutomations.automationId,
      )})`,
    );
    checks.push(sql`(SELECT ${count()} FROM copied_hooks) = ${hooks.length}`);
  }
  return { clauses, checks };
}

function copiedThreadClauses(
  args: WorkflowCopyPublicationArgs,
  beforeEvent: SQL,
) {
  if (!copyNeedsThread(args.source)) {
    return { clauses: [], checks: [] };
  }
  const plan = copyPublicationPlans(args);
  const thread = plan.thread;
  const id = randomUUID();
  const creation = copyInsertSql(
    chatThreads,
    { ...thread.values, id },
    copied,
    chatThreads.id,
  );
  const binding = copyInsertSql(
    workflowUserAutomationThreads,
    { ...plan.bindingValues, chatThreadId: id },
    exists(sql`(SELECT 1 FROM copied_thread)`),
    workflowUserAutomationThreads.id,
  );
  const event = chatThreadEventInsertPlan(
    {
      kind: "created",
      userId: args.userId,
      orgId: args.orgId,
      chatThreadId: id,
      title: args.threadPreparation.title,
      selectedModel: thread.values.selectedModel,
      hidden: thread.values.hidden,
      modelSettings: explicitModelSettings(
        args.threadPreparation.modelSettings,
      ),
      serviceTier: chatThreadServiceTierFromCodex(
        thread.values.codexServiceTier,
      ),
      computerUseHostId: thread.values.computerUseHostId,
      cloudBrowserEnabled: args.threadPreparation.cloudBrowserEnabled,
      createdAt: args.currentTime,
    },
    {
      gate: sql`${exists(sql`(SELECT 1 FROM copied_binding)`)} AND ${beforeEvent}`,
      agentId: sql`${args.targetAgentId}::uuid`,
    },
  );
  return {
    clauses: [
      sql`copied_thread AS (${creation})`,
      sql`copied_binding AS (${binding})`,
      sql`reserved AS (${event.reservation})`,
      sql`copied_event AS (${event.insertion})`,
    ],
    checks: [
      sql`(SELECT ${count()} FROM copied_thread) = 1`,
      sql`(SELECT ${count()} FROM copied_binding) = 1`,
      sql`(SELECT ${count()} FROM copied_event) = 1`,
    ],
  };
}

/** One PostgreSQL statement owns all publication writes and the final sentinel. */
export function workflowCopyPublicationSql(
  args: WorkflowCopyPublicationArgs,
  accounts: readonly CopyAccountSnapshot[],
): SQL {
  const plan = copyPublicationPlans(args);
  const accountReads = copyAccountReadClauses(args, accounts);
  const sourceValid = exists(sql`(SELECT 1 FROM copy_source_valid)`);
  const slug = new QueryBuilder().select().from(plan.slug);
  const admitted = sql`${sourceValid} AND NOT EXISTS (${slug}) AND (${sql.join(accountReads.checks.length ? accountReads.checks : [sql`true`], sql` AND `)})`;
  const consume =
    args.cleanupJobId === null
      ? sql`SELECT true AS consumed WHERE ${admitted}`
      : consumeWorkflowAttachmentCandidateSql(args.cleanupJobId, admitted);
  const workflow = copyInsertSql(
    workflows,
    plan.workflow,
    exists(sql`(SELECT 1 FROM consumed_copy_candidate)`),
    workflows.id,
  );
  const automations = copiedAutomationClauses(args, accounts);
  const projections = copyAccountWriteClauses(
    args,
    accounts,
    sql`${copied} AND (${sql.join([...automations.checks, sql`true`], sql` AND `)})`,
  );
  const beforeEvent = sql`${sql.join([...automations.checks, ...projections.checks, sql`true`], sql` AND `)}`;
  const thread = copiedThreadClauses(args, beforeEvent);
  return sql`WITH ${sql.join(copySourcePublicationClauses(args), sql`,\n`)},
    ${accountReads.clauses.length ? sql`${sql.join(accountReads.clauses, sql`,\n`)},` : sql.empty()}
    consumed_copy_candidate AS (${consume}), copied_workflow AS (${workflow})
    ${[...automations.clauses, ...projections.clauses, ...thread.clauses].length ? sql`, ${sql.join([...automations.clauses, ...projections.clauses, ...thread.clauses], sql`,\n`)}` : sql.empty()}
    SELECT (${sourceValid} AND (${sql.join(accountReads.checks.length ? accountReads.checks : [sql`true`], sql` AND `)})) AS source_valid,
      EXISTS (${slug}) AS slug_taken,
      EXISTS (SELECT 1 FROM consumed_copy_candidate) AS candidate_consumed,
      1 / CASE WHEN NOT EXISTS (SELECT 1 FROM consumed_copy_candidate) OR (
        (SELECT ${count()} FROM copied_workflow) = 1 AND (${beforeEvent})
        AND (${sql.join(thread.checks.length ? thread.checks : [sql`true`], sql` AND `)})
      ) THEN 1 ELSE 0 END AS complete`;
}
