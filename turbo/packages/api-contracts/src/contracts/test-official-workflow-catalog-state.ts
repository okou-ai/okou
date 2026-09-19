import { z } from "zod";

import { initContract } from "./base";
import {
  officialWorkflowAcceptedDefinitionSchema,
  officialWorkflowAcceptedRevisionSchema,
  officialWorkflowCatalogReleasePayloadSchema,
} from "./official-workflow-catalog";
import { workflowNameSchema } from "./workflows";

const c = initContract();

export const testOfficialWorkflowCatalogStateActionBodySchema =
  z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("cleanup"),
      })
      .strict(),
    z
      .object({
        action: z.literal("seed-previous-schema-release"),
      })
      .strict(),
    z
      .object({
        action: z.literal("read"),
        definitionName: workflowNameSchema.optional(),
        workflowId: z.uuid().optional(),
        revision: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
      })
      .strict()
      .refine(
        (value) => {
          return (
            value.revision === undefined || value.definitionName !== undefined
          );
        },
        { message: "definitionName is required with revision" },
      ),
    z
      .object({
        action: z.literal("run-reconciliation-worker"),
      })
      .strict(),
    z
      .object({
        action: z.literal("simulate-reconciliation-worker-crash"),
        definitionName: workflowNameSchema,
      })
      .strict(),
    z
      .object({
        action: z.literal("simulate-dormant-materialization-crash"),
        definitionName: workflowNameSchema,
        automationId: z.uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("simulate-current-lifecycle-gap"),
        definitionName: workflowNameSchema,
        automationId: z.uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("simulate-structure-transition-crash"),
        definitionName: workflowNameSchema,
        automationId: z.uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("simulate-dormant-materialization-discard-crash"),
        definitionName: workflowNameSchema,
        automationId: z.uuid(),
      })
      .strict(),
    z
      .object({
        action: z.literal("pause-next-dormant-materialization"),
      })
      .strict(),
    z
      .object({
        action: z.literal("wait-for-dormant-materialization-pause"),
      })
      .strict(),
    z
      .object({
        action: z.literal("resume-dormant-materialization"),
      })
      .strict(),
    z
      .object({
        action: z.literal("pause-next-structure-transition-promotion"),
      })
      .strict(),
    z
      .object({
        action: z.literal("crash-next-structure-transition-promotion"),
      })
      .strict(),
    z
      .object({
        action: z.literal("wait-for-structure-transition-promotion-pause"),
      })
      .strict(),
    z
      .object({
        action: z.literal("resume-structure-transition-promotion"),
      })
      .strict(),
    z
      .object({
        action: z.literal("make-reconciliation-work-due"),
        definitionName: workflowNameSchema,
      })
      .strict(),
  ]);
export type TestOfficialWorkflowCatalogStateActionBody = z.infer<
  typeof testOfficialWorkflowCatalogStateActionBodySchema
>;

const testOfficialWorkflowCatalogStorageStateSchema = z
  .object({
    storageName: z.string(),
    storageId: z.string().uuid(),
    orgId: z.string(),
    userId: z.string(),
    headVersionId: z.string().nullable(),
    versionCount: z.number().int().nonnegative(),
  })
  .strict();

export const testOfficialWorkflowCatalogStateActionResponseSchema = z
  .object({
    ok: z.literal(true),
    catalog: z
      .object({
        releaseId: z.string().regex(/^[0-9a-f]{64}$/),
        payload: officialWorkflowCatalogReleasePayloadSchema,
      })
      .strict()
      .nullable(),
    definition: officialWorkflowAcceptedDefinitionSchema.nullable(),
    revision: officialWorkflowAcceptedRevisionSchema.nullable(),
    storage: testOfficialWorkflowCatalogStorageStateSchema.nullable(),
    counts: z
      .object({
        releases: z.number().int().nonnegative(),
        revisions: z.number().int().nonnegative(),
        storages: z.number().int().nonnegative(),
        storageVersions: z.number().int().nonnegative(),
      })
      .strict(),
    reconciliationWork: z.array(
      z
        .object({
          definitionName: workflowNameSchema,
          requestedReleaseId: z.string().regex(/^[0-9a-f]{64}$/),
          cursorWorkflowId: z.uuid().nullable(),
          state: z.enum(["pending", "running"]),
          leaseId: z.uuid().nullable(),
          attemptCount: z.number().int().nonnegative(),
          lastError: z.string().nullable(),
        })
        .strict(),
    ),
    identities: z.array(
      z
        .object({
          id: z.uuid(),
          workflowId: z.uuid(),
          automationId: z.uuid().nullable(),
          blueprintKey: z.string(),
          state: z.enum([
            "active",
            "reconciling",
            "needs_reconfiguration",
            "failed",
            "removed",
          ]),
          retainedParameterBindings: z.array(z.unknown()).nullable(),
          retainedIntendedEnabled: z.boolean().nullable(),
          retainedAppliedFingerprint: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        })
        .strict(),
    ),
    worker: z
      .object({
        claimed: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
        advanced: z.number().int().nonnegative(),
        retried: z.number().int().nonnegative(),
        installations: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TestOfficialWorkflowCatalogStateActionResponse = z.infer<
  typeof testOfficialWorkflowCatalogStateActionResponseSchema
>;

export const testOfficialWorkflowCatalogStateContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/official-workflow-catalog-state/action",
    body: testOfficialWorkflowCatalogStateActionBodySchema,
    responses: {
      200: testOfficialWorkflowCatalogStateActionResponseSchema,
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Inspect and clean Official Workflow catalog API test state",
  },
});

export type TestOfficialWorkflowCatalogStateContract =
  typeof testOfficialWorkflowCatalogStateContract;
