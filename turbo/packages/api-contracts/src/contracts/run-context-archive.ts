import { array, object, string, type infer as zInfer } from "zod";

import {
  runContextResponseSchema,
  runContextStorageMountSchema,
  type RunContextStorageMount,
} from "../validators/run-routes";

const retainedStorageSchema = object({
  storageMounts: array(runContextStorageMountSchema).optional(),
  volumes: array(
    object({
      name: string(),
      mountPath: string(),
      vasStorageName: string(),
      vasVersionId: string(),
    }),
  ).optional(),
  artifact: object({
    mountPath: string(),
    vasStorageName: string(),
    vasVersionId: string(),
  })
    .nullable()
    .optional(),
});

export type RetainedRunContextStorage = zInfer<typeof retainedStorageSchema>;

// Earlier Axiom snapshots and downloaded logs retain these captured fields.
// Keep this persisted-format conversion while those records/files remain
// supported; API drain and rollback floors do not retire them (#41332).
export function runContextStorageMounts(
  context: RetainedRunContextStorage,
): RunContextStorageMount[] {
  if (context.storageMounts !== undefined) {
    return context.storageMounts;
  }
  if (context.volumes === undefined || context.artifact === undefined) {
    throw new Error("Run context is missing Storage mount observations");
  }
  return [
    ...context.volumes.map((volume) => {
      return {
        name: volume.vasStorageName,
        version: volume.vasVersionId,
        mountPath: volume.mountPath,
        writeback: false,
      };
    }),
    ...(context.artifact === null
      ? []
      : [
          {
            name: context.artifact.vasStorageName,
            version: context.artifact.vasVersionId,
            mountPath: context.artifact.mountPath,
            writeback: true,
          },
        ]),
  ];
}

export const runContextArchiveSchema = runContextResponseSchema
  .omit({ storageMounts: true })
  .extend(retainedStorageSchema.shape)
  .refine(
    (context) => {
      return (
        context.storageMounts !== undefined ||
        (context.volumes !== undefined && context.artifact !== undefined)
      );
    },
    {
      message: "Run context is missing Storage mount observations",
      path: ["storageMounts"],
    },
  )
  .transform((context) => {
    const { volumes: _volumes, artifact: _artifact, ...canonical } = context;
    return { ...canonical, storageMounts: runContextStorageMounts(context) };
  });
