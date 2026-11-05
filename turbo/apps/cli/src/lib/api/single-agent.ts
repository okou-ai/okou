import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { getClientConfig, handleError } from "./core/client-factory";
import { decodeSandboxTokenPayload } from "./sandbox-token";

/** Run CLI follows its signed snapshot; non-Run CLI uses the active member. */
export async function singleAgentEnabled(): Promise<boolean> {
  const run = decodeSandboxTokenPayload();
  if (run !== undefined) {
    return run.singleAgent === true;
  }

  const client = initClient(featureSwitchesContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.get({ headers: {} });
  if (result.status !== 200) {
    handleError(result, "Failed to resolve the current My Okou experience");
  }
  return result.body.effectiveSwitches[FeatureSwitchKey.SingleAgent] === true;
}
