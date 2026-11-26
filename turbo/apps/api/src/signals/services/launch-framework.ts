import {
  getFrameworkForType,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";

/** The CLI harness a non-Pi run launches for its model provider. */
export type LaunchFramework =
  ReturnType<typeof getFrameworkForType> | "antigravity";

/**
 * The public provider framework keeps its Claude-compatible fallback for
 * Antigravity, so prompts and clients are unchanged; only the launch uses the
 * dedicated `agy` harness.
 */
export function launchFrameworkForProviderType(
  type: ModelProviderType,
): LaunchFramework {
  return type === "antigravity" ? "antigravity" : getFrameworkForType(type);
}
