import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsSlackMessageContract,
  integrationsSlackUploadInitContract,
  integrationsSlackUploadMaterializeContract,
  integrationsSlackUploadCompleteContract,
  type SendSlackMessageBody,
  type SendSlackMessageResponse,
  type SlackUploadInitBody,
  type SlackUploadInitResponse,
  type SlackUploadMaterializeBody,
  type SlackUploadMaterializeResponse,
  type SlackUploadCompleteBody,
  type SlackUploadCompleteResponse,
} from "@okouai/api-contracts/contracts/integrations";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";
import {
  integrationsSlackReadContract,
  type SlackChannelListQuery,
  type SlackChannelListResponse,
  type SlackHistoryQuery,
  type SlackHistoryResponse,
  type SlackRepliesQuery,
  type SlackRepliesResponse,
} from "@okouai/api-contracts/contracts/integrations-slack-read";

export async function listSlackChannels(
  query: SlackChannelListQuery,
): Promise<SlackChannelListResponse> {
  const client = initClient(
    integrationsSlackReadContract,
    await getClientConfig(),
  );
  const result = await client.listChannels({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to list Slack channels");
}

export async function readSlackHistory(
  query: SlackHistoryQuery,
): Promise<SlackHistoryResponse> {
  const client = initClient(
    integrationsSlackReadContract,
    await getClientConfig(),
  );
  const result = await client.history({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read Slack history");
}

export async function readSlackReplies(
  query: SlackRepliesQuery,
): Promise<SlackRepliesResponse> {
  const client = initClient(
    integrationsSlackReadContract,
    await getClientConfig(),
  );
  const result = await client.replies({ query, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to read Slack thread replies");
}

export async function sendSlackMessage(
  body: SendSlackMessageBody,
): Promise<SendSlackMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackMessageContract, config);

  const result = await client.sendMessage({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to send Slack message");
}

export async function initSlackFileUpload(
  body: SlackUploadInitBody,
): Promise<SlackUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadInitContract, config);

  const result = await client.init({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to initialize Slack file upload");
}

export async function completeSlackFileUpload(
  body: SlackUploadCompleteBody,
): Promise<SlackUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadCompleteContract, config);

  const result = await client.complete({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to complete Slack file upload");
}

export async function materializeSlackFileUpload(
  body: SlackUploadMaterializeBody,
): Promise<SlackUploadMaterializeResponse> {
  const config = await getClientConfig();
  const client = initClient(integrationsSlackUploadMaterializeContract, config);

  const result = await client.materialize({ body, headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to materialize Slack file upload");
}

interface DownloadSlackFileResult {
  path: string;
  mimetype: string;
  size: number;
}

/**
 * Download a Slack file to a local path, streaming the response body to disk.
 * Uses the org bot token on the server side; the CLI just authenticates via
 * OKOU_TOKEN and writes the bytes. Response is binary, so this bypasses the
 * typed contract client.
 */
export async function downloadSlackFile(
  fileId: string,
  outPath: string,
): Promise<DownloadSlackFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL("/api/integrations/slack/download-file", baseUrl);
  url.searchParams.set("file_id", fileId);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });

  if (!response.ok) {
    let message = `Failed to download Slack file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) message = body.error.message;
      if (body.error?.code) code = body.error.code;
    } catch {
      // ignore parse errors — keep generic message
    }
    throw new ApiRequestError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiRequestError(
      "Slack download response has no body",
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
