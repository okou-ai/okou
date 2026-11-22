import { isUniqueViolation } from "../../lib/pg-errors";

/** Accept only this write's name keys, scoped to the workspace or private owner. */
export function isOrdinaryWorkflowNameConflict(
  error: unknown,
  visibility: "public" | "private",
): boolean {
  return visibility === "public"
    ? isUniqueViolation(error, "idx_workflows_public_org_name_unique")
    : isUniqueViolation(
        error,
        "idx_workflows_ordinary_private_owner_name_unique",
      );
}
