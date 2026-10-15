import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { MIMEType } from "node:util";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  MAX_WECHAT_FILE_SIZE_BYTES,
  integrationsWechatUploadInitContract,
  integrationsWechatUploadMaterializeContract,
  integrationsWechatUploadCompleteContract,
  integrationsWechatDownloadFileContract,
  type WechatUploadInitBody,
  type WechatUploadInitResponse,
  type WechatUploadMaterializeBody,
  type WechatUploadMaterializeResponse,
  type WechatUploadCompleteBody,
  type WechatUploadCompleteResponse,
  type WechatDownloadFileQuery,
} from "@okouai/api-contracts/contracts/integrations-wechat-files";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import {
  ApiRequestError,
  getBaseUrl,
  getClientConfig,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import { headersWithCliClientHeaders } from "../client-headers";

export async function initWechatFileUpload(
  body: WechatUploadInitBody,
): Promise<WechatUploadInitResponse> {
  const validated = integrationsWechatUploadInitContract.init.body.parse(body);
  const client = initClient(integrationsWechatUploadInitContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.init({ body: validated, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to initialize Wechat file upload");
}

export async function materializeWechatFileUpload(
  body: WechatUploadMaterializeBody,
): Promise<WechatUploadMaterializeResponse> {
  const client = initClient(integrationsWechatUploadMaterializeContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.materialize({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to publish Wechat file");
}

export async function completeWechatFileUpload(
  body: WechatUploadCompleteBody,
): Promise<WechatUploadCompleteResponse> {
  const client = initClient(integrationsWechatUploadCompleteContract, {
    ...(await getClientConfig()),
    validateResponse: true,
  });
  const result = await client.complete({ body, headers: {} });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to complete Wechat file delivery");
}

interface DownloadWechatFileResult {
  readonly path: string;
  readonly mimetype: string;
  readonly size: number;
}

function downloadLength(response: Response): number {
  const header = response.headers.get("content-length");
  if (!header || !/^\d+$/u.test(header)) {
    throw new Error("Wechat download response has no valid content length");
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error("Wechat download response has no valid content length");
  }
  if (length > MAX_WECHAT_FILE_SIZE_BYTES) {
    throw new Error("Wechat file exceeds the 10 MiB limit");
  }
  return length;
}

/** Credentials go only to the API; the server resolves provider attachment URLs. */
export async function downloadWechatFile(
  query: WechatDownloadFileQuery,
  outPath: string,
): Promise<DownloadWechatFileResult> {
  const validated =
    integrationsWechatDownloadFileContract.download.query.parse(query);
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  const url = new URL(
    integrationsWechatDownloadFileContract.download.path,
    await getBaseUrl(),
  );
  for (const [key, value] of Object.entries(validated)) {
    url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: headersWithCliClientHeaders({
      Authorization: `Bearer ${token}`,
    }),
    redirect: "error",
    signal: controller.signal,
  });
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(await response.json());
    if (error.success) {
      throw new ApiRequestError(
        error.data.error.message,
        error.data.error.code,
        response.status,
      );
    }
    throw new ApiRequestError(
      `Failed to download Wechat file (HTTP ${response.status})`,
      "UNKNOWN",
      response.status,
    );
  }
  if (!response.body) {
    throw new Error("Wechat download response has no body");
  }

  const temporaryPath = `${outPath}.${randomUUID()}.part`;
  const reader = response.body.getReader();
  try {
    const expectedLength = downloadLength(response);
    const contentType = response.headers.get("content-type");
    if (!contentType || contentType.length > 255) {
      throw new Error("Wechat download response has no valid content type");
    }
    const mimetype = new MIMEType(contentType).essence;
    const file = await open(temporaryPath, "wx", 0o600);
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_WECHAT_FILE_SIZE_BYTES || size > expectedLength) {
          throw new Error("Wechat download exceeds its declared size");
        }
        await file.writeFile(chunk.value);
      }
      if (size !== expectedLength) {
        throw new Error("Wechat download is incomplete");
      }
    } finally {
      await file.close();
    }
    await rename(temporaryPath, outPath);
    return { path: outPath, mimetype, size };
  } finally {
    controller.abort();
    reader.releaseLock();
    await rm(temporaryPath, { force: true });
  }
}
