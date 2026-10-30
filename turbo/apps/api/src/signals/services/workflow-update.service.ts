import type { WorkflowUpdateRequest } from "@okouai/api-contracts/contracts/workflows";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { storagePublicationTokens } from "@okouai/db/schema/storage-publication-fence";
import { command } from "ccstate";
import { and, eq, exists, isNull, or, sql, type SQL } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import type { WorkflowRow, WorkflowMember } from "./workflow-data.service";
import {
  prepareWorkflowAttachments$,
  publishWorkflowContentBundle$,
  type PreparedWorkflowAttachments,
} from "./workflow-attachments.service";
import {
  consumeWorkflowAttachmentCandidateSql,
  restoreWorkflowAttachmentCandidateSql,
  retireWorkflowAttachmentSql,
} from "./workflow-attachment-cleanup.service";

interface UpdateWorkflowInput {
  readonly workflow: WorkflowRow;
  readonly observedXmin: string;
  readonly body: WorkflowUpdateRequest;
  readonly updatedByUserId: string;
  readonly member: WorkflowMember;
}

/** Outgoing Stage 1 publication takes the Workflow row before its token. */
function retireLegacyWorkflowPublication(
  workflow: WorkflowRow,
  admitted: SQL,
): SQL {
  return sql`DELETE FROM ${storagePublicationTokens}
    WHERE ${and(
      eq(storagePublicationTokens.orgId, workflow.orgId),
      eq(storagePublicationTokens.agentId, workflow.agentId),
      eq(storagePublicationTokens.publicationKey, `workflow:${workflow.id}`),
      admitted,
    )}
    RETURNING token`;
}

function replacedWorkflowAttachments(
  current: WorkflowRow["attachments"],
  prepared: PreparedWorkflowAttachments | null,
) {
  return prepared !== null &&
    JSON.stringify(prepared.attachments) !== JSON.stringify(current)
    ? current
    : null;
}

const prepareWorkflowUpdateContent$ = command(
  async (
    { set },
    args: Pick<UpdateWorkflowInput, "workflow" | "body" | "updatedByUserId">,
    signal: AbortSignal,
  ) => {
    const { workflow, body } = args;
    const prepared =
      body.files === undefined
        ? null
        : await set(
            prepareWorkflowAttachments$,
            {
              orgId: workflow.orgId,
              workflowId: workflow.id,
              userId: args.updatedByUserId,
              files: body.files,
              current: workflow.attachments,
            },
            signal,
          );
    signal.throwIfAborted();
    const attachments = prepared?.attachments ?? workflow.attachments;
    if (attachments === null) {
      throw new Error("Workflow attachments have not been migrated");
    }
    const contentBundle = await set(
      publishWorkflowContentBundle$,
      {
        orgId: workflow.orgId,
        workflowId: workflow.id,
        name: body.name ?? workflow.name,
        description:
          body.description === undefined
            ? workflow.description
            : body.description,
        instruction:
          body.instruction === undefined
            ? workflow.instruction
            : body.instruction,
        attachments,
        ...(body.files === undefined ? {} : { files: body.files }),
      },
      signal,
    );
    return { prepared, contentBundle };
  },
);

export const updateWorkflow$ = command(
  async (
    { set },
    args: UpdateWorkflowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { workflow, body } = args;
    if (workflow.officialDefinitionName !== null) {
      throw new Error("Official Workflow content and structure are read-only");
    }
    if (workflow.attachments === null && body.files === undefined) {
      throw new Error("Workflow attachments have not been migrated");
    }
    const { prepared, contentBundle } = await set(
      prepareWorkflowUpdateContent$,
      args,
      signal,
    );
    const db = set(writeDb$);
    const candidateId = prepared?.cleanupJobId ?? null;
    const candidate = db
      .$with("consumed_attachment_candidate", {})
      .as(consumeWorkflowAttachmentCandidateSql(candidateId));
    const updated = db.$with("updated_workflow").as(
      db
        .update(workflows)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.displayName !== undefined && {
            displayName: body.displayName,
          }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.instruction !== undefined && {
            instruction: body.instruction,
          }),
          ...(prepared !== null && { attachments: prepared.attachments }),
          contentBundle,
          updatedBy: args.updatedByUserId,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(workflows.id, workflow.id),
            eq(workflows.orgId, workflow.orgId),
            eq(workflows.agentId, workflow.agentId),
            eq(workflows.ownerUserId, workflow.ownerUserId),
            eq(workflows.visibility, workflow.visibility),
            isNull(workflows.officialDefinitionName),
            // Even value-preserving Stage 1 metadata writes create a new row
            // version. Their token can be invisible to this statement's snapshot.
            sql`${workflows}.xmin::text = ${args.observedXmin}`,
            exists(
              db
                .select({ id: agents.id })
                .from(agents)
                .where(
                  and(
                    eq(agents.id, workflow.agentId),
                    eq(agents.orgId, workflow.orgId),
                    workflow.visibility === "private"
                      ? eq(workflows.ownerUserId, args.member.userId)
                      : or(
                          eq(agents.owner, args.member.userId),
                          and(
                            eq(agents.visibility, "public"),
                            sql`${args.member.role === "admin"}`,
                          ),
                        ),
                  ),
                ),
            ),
            exists(
              db
                .select({ consumed: sql`true`.mapWith(pgBooleanDecoder) })
                .from(sql`${candidate}`),
            ),
          ),
        )
        .returning({ id: workflows.id }),
    );
    const retired = db.$with("retired_attachments", {}).as(
      retireWorkflowAttachmentSql(
        {
          orgId: workflow.orgId,
          userId: workflow.ownerUserId,
          workflowId: workflow.id,
        },
        replacedWorkflowAttachments(workflow.attachments, prepared),
        exists(db.select({ id: updated.id }).from(updated)),
      ),
    );
    const restored = db
      .$with("restored_attachment_candidate", {})
      .as(
        restoreWorkflowAttachmentCandidateSql(
          candidateId,
          db.select({ id: updated.id }).from(updated).getSQL(),
        ),
      );
    const legacy = db
      .$with("retired_workflow_publication", {})
      .as(
        retireLegacyWorkflowPublication(
          workflow,
          exists(db.select({ id: updated.id }).from(updated)),
        ),
      );
    const rows = await db
      .with(candidate, updated, retired, restored, legacy)
      .select({ id: updated.id })
      .from(updated);
    signal.throwIfAborted();
    return rows.length === 1;
  },
);
