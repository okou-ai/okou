import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  copyAutomationsQuery,
  copyWebhooksQuery,
  workflowCopyConflict,
  type WorkflowCopyInput,
  type WorkflowCopySource,
} from "./workflow-copy-source";
import {
  copySlugConflict,
  copyConnectorSlugs,
  copyAccountReadPlan,
  type WorkflowCopyPublicationArgs as CopyArgs,
  type CopyWorkflowDatabaseResult as CopyResult,
} from "./workflow-copy-publication-plans";
import {
  copiedAccountSelection,
  type CopyAccountSnapshot,
} from "./workflow-copy-account-publication";
import {
  workflowCopyPublicationSql,
  copyPublicationResultSchema,
} from "./workflow-copy-atomic-publication";

export const readWorkflowCopySnapshot$ = command(
  async (
    { get },
    args: WorkflowCopyInput,
    signal: AbortSignal,
  ): Promise<WorkflowCopySource> => {
    const db = get(db$);
    const automations = await db.select().from(copyAutomationsQuery(args));
    signal.throwIfAborted();
    const webhooks = automations.length
      ? await db.select().from(copyWebhooksQuery(automations))
      : [];
    signal.throwIfAborted();
    return {
      sourceWorkflow: args.sourceWorkflow,
      files: args.sourceFiles,
      sourceAutomations: automations,
      webhooks,
      observation: {
        workflowXmin: args.workflowXmin,
        automations: automations.map((row) => {
          return { id: row.id, xmin: row.observedXmin };
        }),
      },
    };
  },
);

export const commitWorkflowCopy$ = command(
  async ({ set }, args: CopyArgs, signal: AbortSignal): Promise<CopyResult> => {
    const db = set(writeDb$);
    const slugs = copyConnectorSlugs(args.source.sourceAutomations);
    const projections: CopyAccountSnapshot[] = [];
    for (const slug of slugs) {
      const selection = copiedAccountSelection(args, slug);
      const [account] = await db
        .select(selection.columns)
        .from(selection.source);
      signal.throwIfAborted();
      if (!account) {
        throw new Error("Workflow copy account selection is missing");
      }
      const plan =
        slug === "google-forms" ? null : copyAccountReadPlan(args, slug);
      const rows = plan ? await db.select(plan.columns).from(plan.source) : [];
      projections.push({ slug, connectorId: account.connectorId, rows });
      signal.throwIfAborted();
    }
    const rows = parseRawRows(
      copyPublicationResultSchema,
      await db.execute(workflowCopyPublicationSql(args, projections)),
    );
    signal.throwIfAborted();
    const row = rows[0];
    if (!row) {
      throw new Error("Workflow copy publication result is missing");
    }
    if (!row.source_valid) {
      return workflowCopyConflict();
    }
    if (row.slug_taken) {
      return workflowCopyConflict(
        copySlugConflict(args.source.sourceWorkflow.name),
      );
    }
    if (!row.candidate_consumed) {
      return workflowCopyConflict(
        "Workflow attachment preparation changed; retry the copy",
      );
    }
    return {
      kind: "ok",
      inserted: { id: args.targetWorkflowId },
      accountConnectorSlugs: slugs,
    };
  },
);
