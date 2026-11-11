import {
  array,
  boolean,
  enum as zEnum,
  iso,
  literal,
  number,
  object,
  string,
  type infer as zInfer,
} from "zod";

// This first production cohort is intentionally staff-only.
export const STAFF_ORG = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
export const PROJECT = "hidden-lab-39609750";
export const BRANCH = "br-late-pine-aft7prua";
export const BUCKET = "vm0-s3-user-storages-prod";
export const ENDPOINT =
  "https://98b0b14cee451004596479a689d2071b.r2.cloudflarestorage.com";
export const WORKFLOW = ".github/workflows/single-agent-migration.yml";
export const digestSchema = string().regex(/^[a-f0-9]{64}$/u);
export const commitSchema = string().regex(/^[a-f0-9]{40}$/u);

export const productionBindingSchema = object({
  projectId: literal(PROJECT),
  branchId: literal(BRANCH),
  endpointId: string().min(1),
  commit: commitSchema,
  planRunId: string().regex(/^\d+$/u),
  orgId: literal(STAFF_ORG),
}).strict();
export type ProductionBinding = zInfer<typeof productionBindingSchema>;
export const productionContextSchema = object({
  mode: zEnum(["target", "plan", "apply", "verify", "recover"]),
  repository: literal("okou-ai/okou"),
  ref: literal("refs/heads/main"),
  commit: commitSchema,
  driverCommit: commitSchema,
  orgId: literal(STAFF_ORG),
  runId: string().regex(/^\d+$/u),
  runAttempt: literal(1),
  actor: string().min(1),
  writersDrained: boolean(),
  planRunId: string(),
  planSha256: string(),
  imageSha256: string(),
  prefixesSha256: string(),
}).strict();
export type ProductionContext = zInfer<typeof productionContextSchema>;
export const productionMetadataSchema = object({
  format: literal("single-agent-production-plan-v1"),
  binding: productionBindingSchema,
  createdAt: iso.datetime(),
  inventorySha256: digestSchema,
  planSha256: digestSchema,
  imageSha256: digestSchema,
  prefixesSha256: digestSchema,
  summary: object({}).catchall(number().int().nonnegative()),
}).strict();
export type ProductionMetadata = zInfer<typeof productionMetadataSchema>;
export const liveMembersSchema = array(
  object({ userId: string().min(1), role: string().min(1) }).strict(),
);
