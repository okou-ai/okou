import type { AvailableRunModel } from "@okouai/api-contracts/contracts/model-providers";

/** Member controls use the caller-specific server projection. */
export function memberRunModelAllowedForPlan(
  runModel: AvailableRunModel,
): boolean {
  return runModel.memberEffective.availability !== "plan_restricted";
}
