import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";

export const JOB_KIND = "workflow-storage-retirement";
export const HANDLER_VERSION = 1;
export const hash = string().regex(/^[a-f0-9]{64}$/u);
const count = number().int().nonnegative();
export const sourceSchema = object({
  id: uuid(),
  orgId: string().min(1),
  name: string(),
  prefix: string(),
  head: string().nullable(),
  xmin: string(),
  versions: array(
    object({
      id: string(),
      key: string(),
      xmin: string(),
      fingerprint: hash,
    }).strict(),
  ),
}).strict();
export type Source = zInfer<typeof sourceSchema>;
const workflowSchema = object({
  id: uuid(),
  orgId: string(),
  official: boolean(),
  instructionHash: hash,
  fingerprint: hash,
  attachments: zUnknown(),
});
export const baselineSchema = workflowSchema.omit({ attachments: true });
export type Baseline = zInfer<typeof baselineSchema>;
export const inventorySchema = object({
  storages: count,
  versions: count,
  pendingPublications: count,
  unconvertedWorkflows: count,
  unfinishedJobs: count,
});
export const observationSchema = object({
  capturedAt: string(),
  cutoverInstalled: boolean(),
  sources: array(sourceSchema),
  workflows: array(workflowSchema),
  inventory: inventorySchema,
});
export type Observation = zInfer<typeof observationSchema>;
export const jobSchema = object({
  id: uuid(),
  prefix: string().min(1),
}).strict();
export type TargetJob = zInfer<typeof jobSchema>;
export const readySchema = object({
  source: sourceSchema,
  jobs: array(jobSchema).min(1),
}).strict();
export type Ready = zInfer<typeof readySchema>;
export const planSchema = object({
  format: literal(1),
  kind: literal(JOB_KIND),
  bucket: string().min(1),
  endpoint: url(),
  databaseScope: hash,
  capturedAt: string(),
  inventory: inventorySchema,
  workflows: array(baselineSchema),
  ready: array(readySchema).max(100),
  blocked: array(
    object({ id: uuid(), reasons: array(string()).min(1) }).strict(),
  ),
  nextAfter: uuid().nullable(),
}).strict();
export type Plan = zInfer<typeof planSchema>;

export class RetirementError extends Error {
  constructor(readonly classification: string) {
    super(classification);
    this.name = "RetirementError";
  }
}

export function checksum(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safePath(value: string): boolean {
  return (
    !value.includes("\\") &&
    [...value].every((character) => {
      return character >= " " && character !== "\u007f";
    }) &&
    value.split("/").length >= 2 &&
    value.split("/").every((part) => {
      return part !== "" && part !== "." && part !== "..";
    }) &&
    !value.startsWith("workflow-attachments/") &&
    !value.startsWith("__system__/")
  );
}

/** A historical slug identifies Storage, never a current same-named Workflow. */
export function sourceWorkflowId(source: Source): string | null {
  const identity = source.name.slice("custom-skill@".length);
  if (
    source.orgId === "__system__" ||
    source.name !== `custom-skill@${identity}`
  )
    throw new RetirementError("UnsupportedWorkflowStorageIdentity");
  if (uuid().safeParse(identity).success) return identity;
  // The original publisher accepted 2–64 lowercase alphanumeric/hyphen slugs.
  if (identity.length <= 64 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u.test(identity))
    return null;
  throw new RetirementError("UnsupportedWorkflowStorageIdentity");
}

/** Read captured locations; never derive, widen or repair a historical root. */
export function cleanupPrefixes(source: Source): string[] {
  sourceWorkflowId(source);
  if (!/^\d+$/u.test(source.xmin))
    throw new RetirementError("UnsupportedWorkflowStorageIdentity");
  const ownedRoot = (prefix: string) => {
    return (
      safePath(prefix) &&
      [source.id, source.name].includes(prefix.split("/").at(-1) ?? "")
    );
  };
  if (!ownedRoot(source.prefix))
    throw new RetirementError("UnrecognizedLegacyPrefix");
  const ids = new Set<string>();
  const prefixes = new Set([source.prefix]);
  for (const version of source.versions) {
    const suffix = `/${version.id}`;
    if (
      !hash.safeParse(version.id).success ||
      ids.has(version.id) ||
      !/^\d+$/u.test(version.xmin) ||
      !version.key.endsWith(suffix) ||
      !ownedRoot(version.key.slice(0, -suffix.length))
    )
      throw new RetirementError("UnrecognizedLegacyVersionDirectory");
    ids.add(version.id);
    if (!version.key.startsWith(`${source.prefix}/`)) prefixes.add(version.key);
  }
  if (source.head !== null && !ids.has(source.head))
    throw new RetirementError("ForeignOrMissingStorageHead");
  return [...prefixes].sort();
}

export function jobInput(bucket: string, source: Source, job: TargetJob) {
  return {
    bucket,
    storageId: source.id,
    storageName: source.name,
    storagePrefix: source.prefix,
    prefix: job.prefix,
    versionIds: source.versions.map((version) => {
      return version.id;
    }),
  };
}

export function validatePlan(plan: Plan): void {
  const storageIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const row of plan.ready) {
    if (storageIds.has(row.source.id))
      throw new RetirementError("DuplicateStorageIdentity");
    storageIds.add(row.source.id);
    if (
      !isDeepStrictEqual(
        cleanupPrefixes(row.source),
        row.jobs
          .map((job) => {
            return job.prefix;
          })
          .sort(),
      )
    )
      throw new RetirementError("CleanupTargetsDifferFromCapturedDirectories");
    for (const job of row.jobs) {
      if (jobIds.has(job.id)) throw new RetirementError("DuplicateJobIdentity");
      jobIds.add(job.id);
    }
  }
  if (
    new Set(
      plan.workflows.map((row) => {
        return row.id;
      }),
    ).size !== plan.workflows.length
  )
    throw new RetirementError("DuplicateWorkflowBaseline");
}

export function workflowBaseline(observation: Observation): Baseline[] {
  if (!observation.cutoverInstalled)
    throw new RetirementError("WorkflowClaimCutoverRequired");
  if (observation.inventory.pendingPublications !== 0)
    throw new RetirementError("WorkflowPublicationsRemain");
  return observation.workflows.map((workflow) => {
    if (!workflow.official) {
      const parsed = workflowAttachmentsSchema.safeParse(workflow.attachments);
      if (!parsed.success)
        throw new RetirementError("InvalidOrUnconvertedWorkflowAttachments");
      if (
        parsed.data.kind === "bundle" &&
        !parsed.data.objectKey.startsWith(
          `workflow-attachments/${workflow.orgId}/${workflow.id}/`,
        )
      )
        throw new RetirementError("ForeignWorkflowAttachmentOwner");
    }
    return baselineSchema.parse(workflow);
  });
}

export function workflowChanges(before: Baseline[], after: Baseline[]) {
  const current = new Map(
    after.map((row) => {
      return [row.id, row];
    }),
  );
  const changes: {
    id: string;
    change: "created" | "deleted" | "changed";
    instructionChanged: boolean;
  }[] = [];
  for (const row of before) {
    const next = current.get(row.id);
    if (!next || row.fingerprint !== next.fingerprint)
      changes.push({
        id: row.id,
        change: next ? "changed" : "deleted",
        instructionChanged:
          !next || next.instructionHash !== row.instructionHash,
      });
    current.delete(row.id);
  }
  for (const row of current.values())
    changes.push({ id: row.id, change: "created", instructionChanged: false });
  return changes;
}
