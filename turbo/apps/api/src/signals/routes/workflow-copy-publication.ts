import { settle } from "../utils";
import type { OfficialWorkflowAcceptedRevision } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { workflowAutomations as automations } from "@okouai/db/runtime/workflow-automation";
import {
  workflows,
  workflowWebhookAutomations as hooks,
  workflowUserAutomationThreads as bindings,
} from "@okouai/db/schema/workflow";
import { notionWorkflowPendingEvents } from "@okouai/db/schema/notion-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { workflowAutomationColumns } from "../services/autonomy-budget-schema.service";
import { googleFormsAccountProjectionStatement } from "../services/google-forms-automation-account.service";
import { preparedVolumePublicationSql as volumeSql } from "../services/storage-volume-publication-sql";
import {
  chatThreadCreatedEventSql as createdEventSql,
  createdChatThreadFromRow,
} from "../services/chat-thread-create.service";
import {
  copySourcePlans,
  requireCopyTarget,
  requireCopySource,
  requireCopyDefinition,
  requireCopyRevision,
  requireCopyVisibility,
  copyRevisionQuery,
  officialCopyMaterialization,
  copyWebhooksQuery,
  copySourceResult,
  copyTransactionResult,
  requirePreparedCopyUnchanged,
  type WorkflowCopyInput,
} from "./workflow-copy-source";
import {
  copyPublicationPlans,
  requireCopySlugAvailable,
  requireCopyVolumePublished,
  copyAutomationPlan,
  requireCopiedRow,
  copyConnectorSlugs,
  copyAccountReadPlan,
  copyProjectionValues,
  copyNotionInvalidation,
  copyNeedsThread,
  copyThreadColumns,
  copyBindingConflict,
  type WorkflowCopyPublicationArgs as CopyArgs,
  type CopyWorkflowDatabaseResult as CopyResult,
} from "./workflow-copy-publication-plans";
export const readWorkflowCopySnapshot$ = command(
  async ({ get }, args: WorkflowCopyInput, signal: AbortSignal) => {
    const db = get(db$);
    const snapshotPromise = (async () => {
      const p = copySourcePlans(args, "preparation");
      const [target] = await db.select().from(p.target);
      signal.throwIfAborted();
      requireCopyTarget(target, args.member);
      const [source] = await db.select().from(p.source);
      signal.throwIfAborted();
      const sourceRow = requireCopySource(source, p.official);
      let revision: OfficialWorkflowAcceptedRevision | null = null;
      if (p.official) {
        const [catalogRow] = await db.select().from(p.catalog);
        signal.throwIfAborted();
        const definition = requireCopyDefinition(catalogRow, p.definitionName);
        const query = copyRevisionQuery(definition);
        const [revisionRow] = await db.select().from(query);
        signal.throwIfAborted();
        revision = requireCopyRevision(revisionRow);
      }
      // Official blueprint reads precede visibility; ordinary rows follow it.
      let rows = revision ? await db.select().from(p.automations) : [];
      signal.throwIfAborted();
      const m = revision
        ? officialCopyMaterialization(sourceRow, revision, rows)
        : null;
      const [visibleRow] = await db.select().from(p.visible);
      signal.throwIfAborted();
      const visible = requireCopyVisibility(visibleRow, args, p.official);
      if (!revision) {
        rows = await db.select().from(p.automations);
        signal.throwIfAborted();
      }
      const webhooks = rows.length
        ? await db.select().from(copyWebhooksQuery(rows, "preparation"))
        : [];
      signal.throwIfAborted();
      const storage = m
        ? null
        : ((await db.select().from(p.storage))[0] ?? null);
      signal.throwIfAborted();
      const facts = { webhooks, storage };
      const current = copySourceResult(args, visible, m, rows, facts);

      return current;
    })();
    const snapshot = copyTransactionResult(
      await settle(snapshotPromise, signal),
    );
    signal.throwIfAborted();
    return snapshot;
  },
);

export const commitWorkflowCopy$ = command(
  async ({ set }, args: CopyArgs, signal: AbortSignal): Promise<CopyResult> => {
    const db = set(writeDb$);
    const p = copyPublicationPlans(args);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0044; new non-billing transactions are prohibited.
    const publication = db.transaction(async (tx) => {
      if (p.official) {
        await tx.select().from(p.catalogLock);
      }
      // Preserve catalog -> parent Agent -> source row lock order.
      await tx.select().from(p.parents);
      const [target] = await tx.select().from(p.target);
      requireCopyTarget(target, args.member);
      const [locked] = await tx.select().from(p.source);
      const sourceRow = requireCopySource(locked, p.official);
      let revision: OfficialWorkflowAcceptedRevision | null = null;
      if (p.official) {
        const [catalogRow] = await tx.select().from(p.catalog);
        const definition = requireCopyDefinition(catalogRow, p.definitionName);
        const query = copyRevisionQuery(definition);
        const [revisionRow] = await tx.select().from(query);
        revision = requireCopyRevision(revisionRow);
      }
      // Official blueprint locks precede visibility; ordinary rows follow it.
      let rows = revision ? await tx.select().from(p.automations) : [];
      const m = revision
        ? officialCopyMaterialization(sourceRow, revision, rows)
        : null;
      const [visibleRow] = await tx.select().from(p.visible);
      const visible = requireCopyVisibility(visibleRow, args, p.official);
      if (!revision) {
        rows = await tx.select().from(p.automations);
      }
      const webhooks = rows.length
        ? await tx.select().from(copyWebhooksQuery(rows))
        : [];
      const storage = m
        ? null
        : ((await tx.select().from(p.storage))[0] ?? null);
      const facts = { webhooks, storage };
      const current = copySourceResult(args, visible, m, rows, facts);

      requirePreparedCopyUnchanged(current.source, args.source);
      const [slugRow] = await tx.select().from(p.slug);
      requireCopySlugAvailable(slugRow, current.source.sourceWorkflow.name);
      // Orphan cleanup takes this storage lock before checking Workflow absence.
      const [storageRow] = await tx.select().from(p.preparedStorage);
      requireCopiedRow(storageRow, p.storageError);
      const [workflowRow] = await tx
        .insert(workflows)
        .values(p.workflow)
        .returning(p.idColumns);
      const inserted = requireCopiedRow(workflowRow, p.workflowError);
      for (const automation of current.source.sourceAutomations) {
        const c = copyAutomationPlan(args, automation);
        const [row] = await tx
          .insert(automations)
          .values(c.values)
          .returning(workflowAutomationColumns());
        const copy = requireCopiedRow(row, p.automationError);
        if (c.webhook) {
          await tx
            .insert(hooks)
            .values({ ...c.webhook, automationId: copy.id });
        }
      }
      const slugs = copyConnectorSlugs(current.source.sourceAutomations);
      for (const slug of slugs) {
        if (slug === "google-forms") {
          await tx.execute(googleFormsAccountProjectionStatement(args));
          signal.throwIfAborted();
          continue;
        }
        const plan = copyAccountReadPlan(args, slug);
        const projected = await tx.select(plan.columns).from(plan.source);
        for (const row of projected) {
          const values = copyProjectionValues(row, slug);
          if (values) {
            await tx
              .update(automations)
              .set(values)
              .where(eq(automations.id, row.automation.id));
            if (slug === "notion") {
              const invalidation = copyNotionInvalidation(row.automation.id);
              await tx
                .update(notionWorkflowPendingEvents)
                .set(invalidation.values)
                .where(invalidation.condition);
            }
          }
        }
        signal.throwIfAborted();
      }
      const { rowCount } = await tx.execute(volumeSql(args.volume, nowDate()));
      requireCopyVolumePublished(rowCount, args.volume.version.versionId);
      signal.throwIfAborted();
      // The shared user/org event sequence remains the final publication lock.
      if (copyNeedsThread(current.source)) {
        await tx
          .insert(bindings)
          .values(p.bindingValues)
          .onConflictDoNothing(copyBindingConflict());
        const [existing] = await tx.select().from(p.binding);
        if (!existing?.chatThreadId) {
          const plan = p.thread;
          const [threadRow] = await tx
            .with(...plan.defaults)
            .insert(chatThreads)
            .values(plan.values)
            .onConflictDoNothing()
            .returning(copyThreadColumns());
          const created = requireCopiedRow(threadRow, p.threadError);
          const thread = createdChatThreadFromRow(created, plan.values.agentId);
          await tx.execute(createdEventSql({ orgId: args.orgId, thread }));
          await tx
            .update(bindings)
            .set({ chatThreadId: thread.id, updatedAt: args.currentTime })
            .where(p.bindingCondition);
        }
      }
      signal.throwIfAborted();
      return { kind: "ok" as const, inserted, accountConnectorSlugs: slugs };
    });
    return copyTransactionResult(await settle(publication, signal));
  },
);
