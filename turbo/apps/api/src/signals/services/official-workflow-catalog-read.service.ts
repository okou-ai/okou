import {
  officialWorkflowAcceptedRevisionSchema,
  officialWorkflowCatalogReleasePayloadSchema,
  officialWorkflowDefinitionRevisionPayloadSchema,
  type OfficialWorkflowAcceptedRevision,
  type OfficialWorkflowCatalogReleasePayload,
  type OfficialWorkflowDefinitionRevisionPayload,
} from "@okouai/api-contracts/contracts/official-workflow-catalog";
import {
  contentBundleSchema,
  type ContentBundle,
} from "@okouai/api-contracts/contracts/content-bundle";
import {
  officialWorkflowCatalogReleases,
  officialWorkflowCatalogState,
  officialWorkflowDefinitionRevisions,
} from "@okouai/db/schema/official-workflow-catalog";
import { command } from "ccstate";
import { array, string } from "zod";
import { and, eq, isNotNull } from "drizzle-orm";

import { db$ } from "../external/db";

export const OFFICIAL_WORKFLOW_CATALOG_AUTHORITY = "official" as const;

export interface AcceptedOfficialWorkflowCatalog {
  readonly releaseId: string;
  readonly payload: OfficialWorkflowCatalogReleasePayload;
  readonly hiddenThreadDefinitionNames: readonly string[];
}

interface OfficialWorkflowRevisionRow {
  readonly definitionName: string;
  readonly revision: string;
  readonly payload: unknown;
  readonly contentBundle: unknown;
}

function revisionDefinition(
  row: OfficialWorkflowRevisionRow,
): OfficialWorkflowDefinitionRevisionPayload {
  const definition = officialWorkflowDefinitionRevisionPayloadSchema.parse(
    row.payload,
  );
  if (
    definition.name !== row.definitionName ||
    definition.revision !== row.revision
  ) {
    throw new Error("Official Workflow revision row identity is inconsistent");
  }
  return definition;
}

export function acceptedRevisionFromRow(
  row: OfficialWorkflowRevisionRow,
): OfficialWorkflowAcceptedRevision {
  return officialWorkflowAcceptedRevisionSchema.parse({
    definition: revisionDefinition(row),
    contentBundle: row.contentBundle,
  });
}

export function acceptedOfficialWorkflowCatalogReadPlan() {
  return {
    columns: {
      releaseId: officialWorkflowCatalogState.acceptedReleaseId,
      payload: officialWorkflowCatalogReleases.payload,
      hiddenThreadDefinitionNames:
        officialWorkflowCatalogReleases.hiddenThreadDefinitionNames,
    },
    join: eq(
      officialWorkflowCatalogReleases.id,
      officialWorkflowCatalogState.acceptedReleaseId,
    ),
    condition: eq(
      officialWorkflowCatalogState.authority,
      OFFICIAL_WORKFLOW_CATALOG_AUTHORITY,
    ),
  };
}

export function acceptedCatalogFromRow(
  row:
    | {
        readonly releaseId: string;
        readonly payload: unknown;
        readonly hiddenThreadDefinitionNames?: unknown;
      }
    | undefined,
): AcceptedOfficialWorkflowCatalog | null {
  if (!row) {
    return null;
  }
  return {
    releaseId: row.releaseId,
    payload: officialWorkflowCatalogReleasePayloadSchema.parse(row.payload),
    hiddenThreadDefinitionNames: array(string()).parse(
      row.hiddenThreadDefinitionNames ?? [],
    ),
  };
}

export const readAcceptedOfficialWorkflowCatalog$ = command(
  async (
    { get },
    signal: AbortSignal,
  ): Promise<AcceptedOfficialWorkflowCatalog | null> => {
    const db = get(db$);
    const plan = acceptedOfficialWorkflowCatalogReadPlan();
    const [row] = await db
      .select(plan.columns)
      .from(officialWorkflowCatalogState)
      .innerJoin(officialWorkflowCatalogReleases, plan.join)
      .where(plan.condition)
      .limit(1);
    signal.throwIfAborted();
    return acceptedCatalogFromRow(row);
  },
);

/** Pure native-query inputs for an owner that reads an exact immutable revision. */
export function acceptedOfficialWorkflowRevisionReadPlan(args: {
  readonly name: string;
  readonly revision: string;
}) {
  return {
    columns: {
      definitionName: officialWorkflowDefinitionRevisions.definitionName,
      revision: officialWorkflowDefinitionRevisions.revision,
      payload: officialWorkflowDefinitionRevisions.payload,
      contentBundle: officialWorkflowDefinitionRevisions.contentBundle,
    },
    deliveryCondition: isNotNull(
      officialWorkflowDefinitionRevisions.contentBundle,
    ),
    condition: and(
      eq(officialWorkflowDefinitionRevisions.definitionName, args.name),
      eq(officialWorkflowDefinitionRevisions.revision, args.revision),
    ),
  };
}

export const readAcceptedOfficialWorkflowRevision$ = command(
  async (
    { get },
    args: { readonly name: string; readonly revision: string },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowAcceptedRevision | null> => {
    const db = get(db$);
    const plan = acceptedOfficialWorkflowRevisionReadPlan(args);
    const [row] = await db
      .select(plan.columns)
      .from(officialWorkflowDefinitionRevisions)
      .where(plan.condition)
      .limit(1);
    signal.throwIfAborted();
    return row ? acceptedRevisionFromRow(row) : null;
  },
);

export interface OfficialWorkflowRevisionForPublication {
  readonly definition: OfficialWorkflowDefinitionRevisionPayload;
  readonly contentBundle: ContentBundle | null;
}

/** A newly selected source may reuse an immutable revision not yet bundled. */
export const readOfficialWorkflowRevisionForPublication$ = command(
  async (
    { get },
    args: { readonly name: string; readonly revision: string },
    signal: AbortSignal,
  ): Promise<OfficialWorkflowRevisionForPublication | null> => {
    const plan = acceptedOfficialWorkflowRevisionReadPlan(args);
    const [row] = await get(db$)
      .select(plan.columns)
      .from(officialWorkflowDefinitionRevisions)
      .where(plan.condition)
      .limit(1);
    signal.throwIfAborted();
    return row
      ? {
          definition: revisionDefinition(row),
          contentBundle:
            row.contentBundle === null
              ? null
              : contentBundleSchema.parse(row.contentBundle),
        }
      : null;
  },
);
