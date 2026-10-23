import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsTeamsMessageContract,
  integrationsTeamsUploadCompleteContract,
  integrationsTeamsUploadInitContract,
  type SendTeamsMessageBody,
  type SendTeamsMessageResponse,
  type TeamsUploadCompleteBody,
  type TeamsUploadCompleteResponse,
  type TeamsUploadInitBody,
  type TeamsUploadInitResponse,
} from "@okouai/api-contracts/contracts/integrations";
import {
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { downloadFileFromApi } from "../download-file-url";

export async function sendTeamsMessage(
  body: SendTeamsMessageBody,
): Promise<SendTeamsMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTeamsMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send Microsoft Teams message");
}

export async function initTeamsFileUpload(
  body: TeamsUploadInitBody,
): Promise<TeamsUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTeamsUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize Microsoft Teams file upload");
}

export async function completeTeamsFileUpload(
  body: TeamsUploadCompleteBody,
): Promise<TeamsUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsTeamsUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete Microsoft Teams file upload");
}

interface DownloadTeamsFileResult {
  path: string;
  mimetype: string;
  size: number;
}

export async function downloadTeamsFile(
  fileId: string,
  outPath: string,
): Promise<DownloadTeamsFileResult> {
  const url = new URL(
    "/api/integrations/teams/download-file",
    await getBaseUrl(),
  );
  url.searchParams.set("file_id", fileId);
  return downloadFileFromApi(url, outPath, {
    maxBytes: 100 * 1024 * 1024,
    acceptContentType: (contentType) => {
      return contentType !== "text/html";
    },
  });
}
