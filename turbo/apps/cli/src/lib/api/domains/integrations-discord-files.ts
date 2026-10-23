import { isAllowedUploadType } from "@okouai/core/upload-content-type";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  MAX_DISCORD_FILE_SIZE_BYTES,
  integrationsDiscordUploadInitContract,
  integrationsDiscordUploadMaterializeContract,
  integrationsDiscordUploadCompleteContract,
  integrationsDiscordDownloadFileContract,
  type DiscordUploadInitBody,
  type DiscordUploadInitResponse,
  type DiscordUploadMaterializeBody,
  type DiscordUploadMaterializeResponse,
  type DiscordUploadCompleteBody,
  type DiscordUploadCompleteResponse,
  type DiscordDownloadFileQuery,
} from "@okouai/api-contracts/contracts/integrations-discord-files";
import {
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { downloadFileViaUrl } from "../download-file-url";

export async function initDiscordFileUpload(
  body: DiscordUploadInitBody,
): Promise<DiscordUploadInitResponse> {
  const validated = integrationsDiscordUploadInitContract.init.body.parse(body);
  const client = initClient(integrationsDiscordUploadInitContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.init({ body: validated, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to initialize Discord file upload");
}

export async function materializeDiscordFileUpload(
  body: DiscordUploadMaterializeBody,
): Promise<DiscordUploadMaterializeResponse> {
  const client = initClient(integrationsDiscordUploadMaterializeContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.materialize({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to publish Discord file");
}

export async function completeDiscordFileUpload(
  body: DiscordUploadCompleteBody,
): Promise<DiscordUploadCompleteResponse> {
  const client = initClient(integrationsDiscordUploadCompleteContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.complete({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to complete Discord file delivery");
}

interface DownloadDiscordFileResult {
  readonly path: string;
  readonly mimetype: string;
  readonly size: number;
}

/** Credentials go only to the API, never to the resolved attachment URL. */
export async function downloadDiscordFile(
  query: DiscordDownloadFileQuery,
  outPath: string,
): Promise<DownloadDiscordFileResult> {
  const validated =
    integrationsDiscordDownloadFileContract.fileUrl.query.parse(query);
  const url = new URL(
    integrationsDiscordDownloadFileContract.fileUrl.path,
    await getBaseUrl(),
  );
  for (const [key, value] of Object.entries(validated)) {
    url.searchParams.set(key, value);
  }
  return downloadFileViaUrl(url, outPath, {
    maxBytes: MAX_DISCORD_FILE_SIZE_BYTES,
    matchMetadataContentType: true,
    acceptContentType: isAllowedUploadType,
  });
}
