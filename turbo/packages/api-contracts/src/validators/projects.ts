import {
  array,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
export const projectSchema = object({
  id: uuid(),
  name: string().trim().min(1).max(120),
  createdAt: string(),
  updatedAt: string(),
});
export type Project = zInfer<typeof projectSchema>;
export const projectEventSchema = object({
  id: uuid(),
  seqId: number().int().positive(),
  projectId: uuid(),
  kind: zEnum(["created", "renamed", "deleted"]),
  name: string().nullable(),
  createdAt: string(),
});
export type ProjectEvent = zInfer<typeof projectEventSchema>;
export const projectSnapshotArchiveSchema = object({
  projects: array(projectSchema),
  latestEventId: uuid().nullable(),
  latestSeqId: number().int().nonnegative(),
});
export const projectEventQueryResultSchema = object({
  snapshot: projectSnapshotArchiveSchema.nullable(),
  events: array(projectEventSchema),
});
