import { integrationsEmailUploadContract } from "@okouai/api-contracts/contracts/integrations-email";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { getClientConfig, handleError } from "../core/client-factory";

export async function completeEmailFileUpload(body: {
  readonly uploadId: string;
  readonly text?: string;
}) {
  const client = initClient(
    integrationsEmailUploadContract,
    await getClientConfig(),
  );
  const response = await client.complete({ headers: {}, body });
  if (response.status === 200) return response.body;
  handleError(response, "Failed to queue the Email attachment");
}
