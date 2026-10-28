import { settle } from "../utils";
import type { OfficialWorkflowAcceptedRevision } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { command } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
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
  workflowCopyConflict,
  CopyPreparationConflict,
  OFFICIAL_COPY_RECONFIGURE_MESSAGE,
  type WorkflowCopyInput,
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
  async ({ get }, args: WorkflowCopyInput, signal: AbortSignal) => {
    const db = get(db$);
    const snapshotPromise = (async () => {
      const p = copySourcePlans(args);
      const parents = await db.select().from(p.parents);
      const target = parents.find((row) => {
        return row.id === args.targetAgentId;
      });
      signal.throwIfAborted();
      requireCopyTarget(target, args.member);
      const [source] = await db.select().from(p.source);
      signal.throwIfAborted();
      const sourceRow = requireCopySource(source?.workflow, p.official);
      if (!source) {
        throw new Error("Workflow copy source observation is missing");
      }
      let acceptedReleaseId: string | null = null;
      let revision: OfficialWorkflowAcceptedRevision | null = null;
      if (p.official) {
        const [catalogRow] = await db.select().from(p.catalog);
        signal.throwIfAborted();
        if (!catalogRow) {
          throw new CopyPreparationConflict(OFFICIAL_COPY_RECONFIGURE_MESSAGE);
        }
        const definition = requireCopyDefinition(catalogRow, p.definitionName);
        acceptedReleaseId = catalogRow.releaseId;
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
        ? await db.select().from(copyWebhooksQuery(rows))
        : [];
      signal.throwIfAborted();
      const facts = {
        webhooks,
        observation: {
          workflowXmin: source.observedXmin,
          parents: parents.map(({ id, xmin }) => {
            return { id, xmin };
          }),
          automations: rows.map((row) => {
            return { id: row.id, xmin: row.observedXmin };
          }),
          acceptedReleaseId,
        },
      };
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
