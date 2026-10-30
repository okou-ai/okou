import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsAgentPhoneContract,
  type AgentPhoneGroupHistoryQuery,
  type SendAgentPhoneGroupMessageBody,
} from "@okouai/api-contracts/contracts/integrations-agentphone";
import {
  integrationsPhoneMessageContract,
  integrationsPhoneUploadCompleteContract,
  integrationsPhoneUploadInitContract,
  type PhoneUploadCompleteBody,
  type PhoneUploadCompleteResponse,
  type PhoneUploadInitBody,
  type PhoneUploadInitResponse,
  type SendPhoneMessageBody,
  type SendPhoneMessageResponse,
  type SendPhoneReactionBody,
} from "@okouai/api-contracts/contracts/integrations";
import {
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { downloadFileFromApi } from "../download-file-url";

interface DownloadPhoneFileResult {
  path: string;
  mimetype: string;
  size: number;
}

export async function readAgentPhoneGroupHistory(
  query: AgentPhoneGroupHistoryQuery,
) {
  const config = await getClientConfig();
  const client = initClient(integrationsAgentPhoneContract, config);
  const result = await client.groupHistory({ query, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to read iMessage group history");
}

export async function sendPhoneMessage(
  body: SendPhoneMessageBody,
): Promise<SendPhoneMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsPhoneMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send phone message");
}

export async function sendAgentPhoneGroupMessage(
  body: SendAgentPhoneGroupMessageBody,
) {
  const config = await getClientConfig();
  const client = initClient(integrationsAgentPhoneContract, config);
  const result = await client.groupMessage({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to send iMessage group message");
}

export async function sendPhoneReaction(body: SendPhoneReactionBody) {
  const config = await getClientConfig();
  const client = initClient(integrationsPhoneMessageContract, config);
  const result = await client.sendReaction({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to add iMessage reaction");
}

export async function initPhoneFileUpload(
  body: PhoneUploadInitBody,
): Promise<PhoneUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsPhoneUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize phone file upload");
}

export async function completePhoneFileUpload(
  body: PhoneUploadCompleteBody & { groupId?: string },
): Promise<PhoneUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsPhoneUploadCompleteContract, config);

  const result = body.groupId
    ? await client.completeGroup({
        body: { ...body, groupId: body.groupId },
        headers: {},
      })
    : await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete phone file upload");
}

/**
 * Download an AgentPhone media attachment to a local path.
 */
export async function downloadPhoneFile(
  fileId: string,
  outPath: string,
): Promise<DownloadPhoneFileResult> {
  const url = new URL(
    "/api/integrations/phone/download-file",
    await getBaseUrl(),
  );
  url.searchParams.set("file_id", fileId);
  return downloadFileFromApi(url, outPath, { maxBytes: 100 * 1024 * 1024 });
}
