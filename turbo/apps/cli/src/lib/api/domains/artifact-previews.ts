import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getActiveToken } from "../config";
import { getClientConfig, handleError } from "../core/client-factory";

export async function artifactPreviewsEnabled(): Promise<boolean> {
  // Anonymous source-selection packets have no account rollout to opt into.
  if (!(await getActiveToken())) return false;
  const client = initClient(featureSwitchesContract, await getClientConfig());
  const response = await client.get();
  if (response.status !== 200) {
    handleError(response, "Could not read artifact preview availability");
  }
  return (
    response.body.effectiveSwitches[FeatureSwitchKey.ArtifactPreviews] === true
  );
}
