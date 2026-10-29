import { command } from "ccstate";
import { and, eq, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  discriminatedUnion as zDiscriminatedUnion,
  literal as zLiteral,
  object as zObject,
  uuid as zUuid,
  string as zString,
  type infer as zInfer,
} from "zod";
import {
  workflowAttachmentsSchema,
  type WorkflowSkillDocument,
} from "@okouai/api-contracts/contracts/workflow-attachments";
import type { StoredExecutionContext } from "@okouai/api-contracts/contracts/runners";
import { SEED_SKILLS } from "@okouai/core/seed-skills";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import { agents } from "@okouai/db/schema/agent";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { storagePublicationTokens } from "@okouai/db/schema/storage-publication-fence";
import { env } from "../../lib/env";
import { generatePresignedGetUrl } from "../external/s3";
import { assertWorkflowAttachmentOwner } from "./workflow-attachment-cleanup.service";

const claimedWorkflowIdentitySchema = zObject({
  id: zUuid(),
  name: zString(),
});
export const claimedWorkflowSchema = zDiscriminatedUnion("delivery", [
  claimedWorkflowIdentitySchema.extend({ delivery: zLiteral("download") }),
  claimedWorkflowIdentitySchema.extend({
    delivery: zLiteral("inline"),
    orgId: zString(),
    description: zString().nullable(),
    instruction: zString().nullable(),
    attachments: workflowAttachmentsSchema,
  }),
]);
export type ClaimedWorkflow = zInfer<typeof claimedWorkflowSchema>;

export interface WorkflowClaimInput {
  readonly delivery: "inline" | "download";
  readonly selection: StoredExecutionContext["customWorkflowSelection"];
  readonly skillRoot: string;
  readonly invokedWorkflowId: string | null;
  readonly invokedWorkflowName: string | null;
  readonly ambiguousMountPaths: readonly string[];
}

export function workflowClaimInput(
  context: StoredExecutionContext,
  prompt: string,
  delivery: WorkflowClaimInput["delivery"],
): WorkflowClaimInput {
  const skillRoot =
    context.cliAgentType === "pi"
      ? "/home/user/.pi/agent/skills"
      : context.cliAgentType === "codex"
        ? "/home/user/.codex/skills"
        : "/home/user/.claude/skills";
  const ordinaryMount = /^custom-skill@[a-f0-9-]{36}$/u;
  for (const mount of context.storageMounts) {
    if (
      mount.name.startsWith("custom-skill@") &&
      !ordinaryMount.test(mount.name)
    ) {
      throw new Error("Unsupported legacy Workflow identity");
    }
  }
  const otherMounts = context.storageMounts.filter((mount) => {
    return !ordinaryMount.test(mount.name);
  });
  const slash =
    /^\/([a-z0-9][a-z0-9-]{0,62}[a-z0-9])(?:\s|$)/u.exec(prompt.trim())?.[1] ??
    null;
  return {
    delivery,
    selection: context.customWorkflowSelection,
    skillRoot,
    invokedWorkflowId:
      context.customWorkflowSelection?.invokedWorkflowId ??
      (context.customWorkflowSelection?.invokedWorkflowId === undefined &&
      slash !== null
        ? (context.storageMounts
            .find((mount) => {
              return (
                ordinaryMount.test(mount.name) &&
                mount.mountPath === `${skillRoot}/${slash}`
              );
            })
            ?.name.slice("custom-skill@".length) ?? null)
        : null),
    invokedWorkflowName: slash,
    // Stage 1 captured Agent identity, but not source precedence. A collision
    // with an unclassified old mount is rejected rather than guessed by slug.
    ambiguousMountPaths:
      context.customWorkflowSelection?.protectedMountPaths === undefined
        ? otherMounts.map((mount) => {
            return mount.mountPath;
          })
        : [],
  };
}

/**
 * Data only: consumed by the existing successful Run/thread claim statement.
 * The outgoing Stage 1 writer commits body + reservation before its package.
 * Its exact pending token blocks a mixed-generation claim during API drain.
 * Remove that token read with the Stage 3 publication bridge retirement.
 */
export function workflowClaimSelectionSql(input: WorkflowClaimInput): SQL {
  const selection = input.selection;
  const automationId = selection?.automationId ?? null;
  const protectedPaths = selection?.protectedMountPaths ?? [];
  const eligible = and(
    eq(workflows.orgId, sql`locked_run."orgId"`),
    eq(workflows.agentId, sql`locked_run."agentId"`),
    eq(agents.orgId, sql`locked_run."orgId"`),
    or(
      eq(agents.visibility, "public"),
      eq(agents.owner, sql`locked_run."userId"`),
    ),
    isNull(workflows.officialDefinitionName),
    or(
      eq(workflows.visibility, "public"),
      eq(workflows.ownerUserId, sql`locked_run."userId"`),
    ),
    notInArray(workflows.name, [...SEED_SKILLS]),
    sql`NOT (${JSON.stringify(protectedPaths)}::jsonb ? (${input.skillRoot} || '/' || ${workflows.name}))`,
  );
  const inlineFields =
    input.delivery === "inline"
      ? sql`, ${workflows.orgId} AS "orgId", ${workflows.description} AS description,
        ${workflows.instruction} AS instruction, ${workflows.attachments} AS attachments`
      : sql``;
  return sql`selected_workflows AS MATERIALIZED (
      SELECT DISTINCT ON (${workflows.name}) ${workflows.id} AS id, ${workflows.name} AS name,
        ${input.delivery}::text AS delivery, (${workflows.attachments} IS NOT NULL) AS available${inlineFields}
      FROM ${workflows} INNER JOIN ${agents} ON ${eq(agents.id, workflows.agentId)} CROSS JOIN locked_run
      WHERE ${eligible}
      ORDER BY ${workflows.name}, (${workflows.visibility} = 'private' AND ${workflows.ownerUserId} = locked_run."userId") DESC, ${workflows.createdAt}, ${workflows.id}
    ), workflow_selection AS MATERIALIZED (
      SELECT COALESCE(jsonb_agg(to_jsonb(selected_workflows)), '[]'::jsonb) AS documents,
        COALESCE(bool_and(available AND NOT (${JSON.stringify(input.ambiguousMountPaths)}::jsonb ? (${input.skillRoot} || '/' || name))), true) AS available
      FROM selected_workflows
    ), workflow_admission AS MATERIALIZED (
      SELECT * FROM workflow_selection, locked_run
      WHERE workflow_selection.available AND (
        locked_run."agentId" IS NULL OR (
          locked_run."agentId" = ${selection?.agentId ?? null}::uuid
          AND (NOT ${selection?.protectedMountPaths === undefined}
            OR locked_run."triggerSource" NOT IN ('automation-schedule', 'automation-event')
            OR locked_run."workflowAutomationId" IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM ${storagePublicationTokens} INNER JOIN selected_workflows
              ON ${storagePublicationTokens.publicationKey} = 'workflow:' || selected_workflows.id::text
            WHERE ${and(eq(storagePublicationTokens.orgId, sql`locked_run."orgId"`), eq(storagePublicationTokens.agentId, sql`locked_run."agentId"`))}
          )
          AND EXISTS (SELECT 1 FROM ${agents} WHERE ${and(eq(agents.id, sql`locked_run."agentId"`), eq(agents.orgId, sql`locked_run."orgId"`), or(eq(agents.visibility, "public"), eq(agents.owner, sql`locked_run."userId"`)))})
          -- A mutable slug must still resolve to the captured invocation identity.
          AND (${input.invokedWorkflowId}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM selected_workflows WHERE id = ${input.invokedWorkflowId}::uuid AND name = ${input.invokedWorkflowName}
          ))
          AND (COALESCE(${automationId}::uuid, locked_run."workflowAutomationId") IS NULL OR EXISTS (
            SELECT 1 FROM ${workflowAutomations} INNER JOIN ${workflows} ON ${eq(workflows.id, workflowAutomations.workflowId)}
            WHERE ${and(eq(workflowAutomations.id, sql`COALESCE(${automationId}::uuid, locked_run."workflowAutomationId")`), eq(workflowAutomations.orgId, sql`locked_run."orgId"`), eq(workflowAutomations.ownerUserId, sql`locked_run."userId"`), eq(workflows.agentId, sql`locked_run."agentId"`), eq(workflows.orgId, sql`locked_run."orgId"`))}
              AND ((${workflows.officialDefinitionName} IS NOT NULL AND ${workflows.officialInstallationState} = 'installed') OR EXISTS (SELECT 1 FROM selected_workflows WHERE id = ${workflows.id}))
          ))
        )
      )
    )`;
}

/** Temporary outgoing-reader producer; remove in the second release (#43642). */
export const materializeClaimedWorkflowDocuments$ = command(
  async (
    { get },
    input: {
      readonly workflows: readonly ClaimedWorkflow[];
      readonly skillRoot: string;
    },
    signal: AbortSignal,
  ): Promise<WorkflowSkillDocument[]> => {
    return await Promise.all(
      input.workflows.map(async (workflow) => {
        if (workflow.delivery !== "inline") {
          throw new Error("Inline Workflow claim is missing its document");
        }
        const descriptor = workflow.attachments;
        let attachments: WorkflowSkillDocument["attachments"] = null;
        if (descriptor.kind === "bundle") {
          assertWorkflowAttachmentOwner(
            workflow.orgId,
            workflow.id,
            descriptor.objectKey,
          );
          const archiveUrl = await get(
            generatePresignedGetUrl(
              env("R2_USER_STORAGES_BUCKET_NAME"),
              descriptor.objectKey,
            ),
          );
          signal.throwIfAborted();
          attachments = {
            archiveUrl,
            archiveSha256: descriptor.archiveSha256,
            archiveSize: descriptor.archiveBytes,
          };
        }
        return {
          workflowId: workflow.id,
          mountPath: `${input.skillRoot}/${workflow.name}`,
          skillMd: synthesizeWorkflowSkillMd(workflow),
          attachments,
        };
      }),
    );
  },
);
