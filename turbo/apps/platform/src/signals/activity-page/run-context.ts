import {
  runContextStorageMounts,
  type RunContextResponse,
  type RunContextStorageMount,
} from "@okouai/api-contracts/contracts/run-routes";

export type ActivityRunContext = Omit<
  RunContextResponse,
  "storageMounts" | "volumes" | "artifact"
> & { storageMounts: RunContextStorageMount[] };

export function normalizeActivityRunContext(
  context: RunContextResponse,
): ActivityRunContext {
  const { volumes: _volumes, artifact: _artifact, ...canonical } = context;
  return { ...canonical, storageMounts: runContextStorageMounts(context) };
}
