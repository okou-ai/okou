import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
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
} from "@okouai/api-contracts/contracts/integrations";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";

interface DownloadPhoneFileResult {
  path: string;
  mimetype: string;
  size: number;
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

  handleError(result, "Failed to send AgentPhone message");
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

  handleError(result, "Failed to initialize AgentPhone file upload");
}

export async function completePhoneFileUpload(
  body: PhoneUploadCompleteBody,
): Promise<PhoneUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsPhoneUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete AgentPhone file upload");
}

/**
 * Download an AgentPhone media attachment to a local path.
 */
export async function downloadPhoneFile(
  fileId: string,
  outPath: string,
): Promise<DownloadPhoneFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/integrations/phone/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });

  if (!response.ok) {
    let message = `Failed to download AgentPhone file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // keep generic message when the body is not JSON
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "AgentPhone download response has no body",
      "EMPTY_BODY",
      502,
    );
  }

  const mimetype =
    response.headers.get("x-file-mimetype") ??
    response.headers.get("content-type") ??
    "application/octet-stream";

  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );

  const contentLengthHeader = response.headers.get("content-length");
  const size = contentLengthHeader ? Number(contentLengthHeader) : 0;

  return { path: outPath, mimetype, size };
}
