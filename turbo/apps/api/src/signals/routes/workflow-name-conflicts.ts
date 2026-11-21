import { isUniqueViolation } from "../../lib/pg-errors";

/** Accept only this write's name keys, including the outgoing shared Private key. */
export function isOrdinaryWorkflowNameConflict(
  error: unknown,
  visibility: "public" | "private",
): boolean {
  return isUniqueViolation(
    error,
    visibility === "public"
      ? "idx_workflows_public_name_unique"
      : "idx_workflows_private_owner_name_unique",
  );
}
