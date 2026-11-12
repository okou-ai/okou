import {
  integrationsEmailContract,
  integrationsEmailUploadContract,
} from "@okouai/api-contracts/contracts/integrations-email";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { getClientConfig, handleError } from "../core/client-factory";

export async function getEmailBinding() {
  const client = initClient(integrationsEmailContract, await getClientConfig());
  const response = await client.getBinding({ headers: {} });
  if (response.status === 200) return response.body;
  handleError(response, "Failed to read the Email workspace");
}

export async function switchEmailWorkspace(workspaceId: string) {
  const client = initClient(integrationsEmailContract, await getClientConfig());
  const response = await client.switchWorkspace({
    headers: {},
    body: { workspaceId },
  });
  if (response.status === 200) return response.body;
  handleError(response, "Failed to switch the Email workspace");
}

export async function logoutEmail() {
  const client = initClient(integrationsEmailContract, await getClientConfig());
  const response = await client.logout({ headers: {} });
  if (response.status === 200) return response.body;
  handleError(response, "Failed to disconnect the Email sender");
}

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
