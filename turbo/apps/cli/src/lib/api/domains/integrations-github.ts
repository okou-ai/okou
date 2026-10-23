import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsGithubDownloadFileContract,
  integrationsGithubUploadCompleteContract,
  integrationsGithubUploadInitContract,
  type GithubUploadCompleteBody,
  type GithubUploadCompleteResponse,
  type GithubUploadInitBody,
  type GithubUploadInitResponse,
} from "@okouai/api-contracts/contracts/integrations";
import {
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { downloadFileViaUrl } from "../download-file-url";

interface DownloadGithubFileResult {
  path: string;
  mimetype: string;
  size: number;
}

export async function initGithubFileUpload(
  body: GithubUploadInitBody,
): Promise<GithubUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsGithubUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize GitHub file upload");
}

export async function completeGithubFileUpload(
  body: GithubUploadCompleteBody,
): Promise<GithubUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsGithubUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete GitHub file upload");
}

export async function downloadGithubFile(
  fileUrl: string,
  outPath: string,
  filename?: string,
): Promise<DownloadGithubFileResult> {
  const url = new URL(
    integrationsGithubDownloadFileContract.fileUrl.path,
    await getBaseUrl(),
  );
  url.searchParams.set("url", fileUrl);
  if (filename) {
    url.searchParams.set("filename", filename);
  }
  return downloadFileViaUrl(url, outPath, {
    maxBytes: 100 * 1024 * 1024,
    acceptContentType: (contentType) => {
      return contentType !== "text/html";
    },
  });
}
