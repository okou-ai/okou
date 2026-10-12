import { isUniqueViolation } from "../../lib/pg-errors";

/** Accept only this write's name keys, including the outgoing shared Private key. */
export function isOrdinaryWorkflowNameConflict(
  error: unknown,
  visibility: "public" | "private",
): boolean {
  return visibility === "public"
    ? isUniqueViolation(error, "idx_workflows_public_agent_name_unique")
    : isUniqueViolation(
        error,
        "idx_workflows_private_owner_agent_name_unique",
      ) ||
        isUniqueViolation(
          error,
          "idx_workflows_ordinary_private_owner_agent_name_unique",
        );
}
