import { computed, type Computed } from "ccstate";
import type { OfficialWorkflowAcceptedRevision } from "@okouai/api-contracts/contracts/official-workflow-catalog";
import { and, eq } from "drizzle-orm";
import {
  officialWorkflowCatalogState,
  officialWorkflowCatalogReleases,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { db$ } from "../external/db";
import {
  acceptedRevisionFromRow,
  acceptedOfficialWorkflowCatalogReadPlan,
  acceptedCatalogFromRow,
  type AcceptedOfficialWorkflowCatalog,
} from "./official-workflow-catalog-read.service";
import {
  acceptedDefinitionForName,
  OfficialWorkflowRunAdmissionError,
  type OfficialWorkflowCandidate,
} from "./official-workflow-run.service";

export function createOfficialWorkflowCatalog() {
  return computed(async (get) => {
    const plan = acceptedOfficialWorkflowCatalogReadPlan();
    const [row] = await get(db$)
      .select(plan.columns)
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, plan.join)
      .where(plan.condition)
      .limit(1);
    return acceptedCatalogFromRow(row);
  });
}

/** Catalog and exact published revisions are independent of model routing/mount paths. */
export function createOfficialWorkflowFacts(
  officialTarget$: Computed<Promise<OfficialWorkflowCandidate | undefined>>,
  catalog$: ReturnType<typeof createOfficialWorkflowCatalog>,
) {
  return computed(async (get) => {
    const target = await get(officialTarget$);
    if (!target) {
      return null;
    }
    const catalog = await get(catalog$);
    if (!catalog) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    const definition = acceptedDefinitionForName(
      catalog.payload.definitions,
      target.definitionName,
    );
    if (!definition) {
      throw new OfficialWorkflowRunAdmissionError();
    }
    const rows = await get(db$)
      .select({
        definitionName: officialWorkflowDefinitionRevisions.definitionName,
        revision: officialWorkflowDefinitionRevisions.revision,
        payload: officialWorkflowDefinitionRevisions.payload,
        contentBundle: officialWorkflowDefinitionRevisions.contentBundle,
      })
      .from(officialWorkflowDefinitionRevisions)
      .where(
        and(
          eq(
            officialWorkflowDefinitionRevisions.definitionName,
            definition.name,
          ),
          eq(officialWorkflowDefinitionRevisions.revision, definition.revision),
        ),
      );
    return {
      catalog,
      revisions: new Map(
        rows.map((revision) => {
          return [
            JSON.stringify([revision.definitionName, revision.revision]),
            acceptedRevisionFromRow(revision),
          ];
        }),
      ),
    };
  });
}

export type OfficialWorkflowContextFacts = {
  readonly catalog: AcceptedOfficialWorkflowCatalog;
  readonly revisions: ReadonlyMap<
    string,
    OfficialWorkflowAcceptedRevision | null
  >;
} | null;
