import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  instructionsContract,
  type InstructionsRequest,
} from "@okouai/api-contracts/contracts/instructions";
import { getClientConfig, handleError } from "../core/client-factory";

async function client() {
  return initClient(instructionsContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
}

export async function getInstructions() {
  const result = await (await client()).get({ headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read personal Instructions");
}

export async function updateInstructions(body: InstructionsRequest) {
  const result = await (await client()).update({ body });
  if (result.status === 200) return result.body;
  if (result.status === 409) {
    throw new Error(
      "Instructions changed since that version. Run okou instructions view --json, review the latest content, then retry with its version. Your edit was not saved.",
    );
  }
  handleError(result, "Failed to save personal Instructions");
}
