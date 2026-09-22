import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";

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
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/integrations/teams/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });

  if (!response.ok) {
    let message = `Failed to download Microsoft Teams file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // Keep the generic HTTP message when the server returned non-JSON.
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "Microsoft Teams download response has no body",
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
