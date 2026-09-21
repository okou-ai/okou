import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  integrationsFeishuUploadCompleteContract,
  integrationsFeishuUploadInitContract,
  integrationsFeishuMessageContract,
  integrationsLarkMessageContract,
  integrationsLarkUploadInitContract,
  integrationsLarkUploadCompleteContract,
  type FeishuResourceType,
  type FeishuUploadCompleteBody,
  type FeishuUploadCompleteResponse,
  type FeishuUploadInitBody,
  type FeishuUploadInitResponse,
  type SendFeishuMessageBody,
  type SendFeishuMessageResponse,
} from "@okouai/api-contracts/contracts/integrations";

import { headersWithCliClientHeaders } from "../client-headers";
import { getActiveToken } from "../config";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";

interface DownloadFeishuFileResult {
  readonly path: string;
  readonly mimetype: string;
  readonly size: number;
}

export async function sendFeishuMessage({
  platform = "feishu",
  ...body
}: SendFeishuMessageBody & {
  readonly platform?: FeishuPlatform;
}): Promise<SendFeishuMessageResponse> {
  const config = await getClientConfig();
  const client = initClient(
    platform === "lark"
      ? integrationsLarkMessageContract
      : integrationsFeishuMessageContract,
    config,
  );
  const result = await client.sendMessage({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(
    result,
    `Failed to send ${FEISHU_PLATFORMS[platform].name} message`,
  );
}

export async function initFeishuFileUpload({
  platform = "feishu",
  ...body
}: FeishuUploadInitBody & {
  readonly platform?: FeishuPlatform;
}): Promise<FeishuUploadInitResponse> {
  const config = await getClientConfig();
  const client = initClient(
    platform === "lark"
      ? integrationsLarkUploadInitContract
      : integrationsFeishuUploadInitContract,
    config,
  );
  const result = await client.init({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(
    result,
    `Failed to initialize ${FEISHU_PLATFORMS[platform].name} file upload`,
  );
}

export async function completeFeishuFileUpload({
  platform = "feishu",
  ...body
}: FeishuUploadCompleteBody & {
  readonly platform?: FeishuPlatform;
}): Promise<FeishuUploadCompleteResponse> {
  const config = await getClientConfig();
  const client = initClient(
    platform === "lark"
      ? integrationsLarkUploadCompleteContract
      : integrationsFeishuUploadCompleteContract,
    config,
  );
  const result = await client.complete({ body, headers: {} });
  if (result.status === 200) {
    return result.body;
  }
  handleError(
    result,
    `Failed to complete ${FEISHU_PLATFORMS[platform].name} file upload`,
  );
}

export async function downloadFeishuFile(
  messageId: string,
  fileKey: string,
  resourceType: FeishuResourceType,
  installationId: string | undefined,
  outPath: string,
  platform: FeishuPlatform = "feishu",
): Promise<DownloadFeishuFileResult> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const url = new URL(`/api/integrations/${platform}/download-file`, baseUrl);
  url.searchParams.set("message_id", messageId);
  url.searchParams.set("file_key", fileKey);
  url.searchParams.set("type", resourceType);
  if (installationId) {
    url.searchParams.set("installation_id", installationId);
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const response = await fetch(url, {
    headers: headersWithCliClientHeaders(headers),
  });
  if (!response.ok) {
    let message = `Failed to download ${FEISHU_PLATFORMS[platform].name} file (HTTP ${response.status})`;
    let code = "UNKNOWN";
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      if (body.error?.message) {
        message = body.error.message;
      }
      if (body.error?.code) {
        code = body.error.code;
      }
    } catch {
      // Keep the generic error when the response body is not JSON.
    }
    throw new ApiRequestError(message, code, response.status);
  }
  if (!response.body) {
    throw new ApiRequestError(
      `${FEISHU_PLATFORMS[platform].name} download response has no body`,
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
  const contentLength = response.headers.get("content-length");
  const size = contentLength ? Number(contentLength) : 0;
  return { path: outPath, mimetype, size };
}
