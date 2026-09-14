import {
  findManagedSocialKitTool,
  projectPublicSocialResponse,
  socialContract,
  socialKitErrorSchema,
  publicSocialErrorCode,
  publicSocialErrorMessage,
  redactSocialProviderIdentity,
  socialKitRequestSchema,
  socialKitDownloadConflictSchema,
  type SocialKitDownloadListQuery,
  type SocialKitDownloadListResponse,
  type SocialKitDownloadRequest,
  type SocialKitDownloadResponse,
  type SocialKitRequest,
  type SocialKitResponse,
} from "@okouai/api-contracts/contracts/social";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

const SOCIALKIT_API_TIMEOUT_MS = 280_000;

export class SocialDownloadConflictError extends ApiRequestError {
  constructor(
    message: string,
    readonly recovery: {
      readonly downloadId: string;
      readonly resumeCommand: string;
    },
  ) {
    super(message, "DOWNLOAD_IN_PROGRESS", 409);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicSocialDownloadResponse<T extends SocialKitDownloadResponse>(
  response: T,
): T {
  const publicResponse = redactSocialProviderIdentity(response) as T;
  if (!publicResponse.error) {
    return publicResponse;
  }
  return {
    ...publicResponse,
    error: {
      ...publicResponse.error,
      code: publicSocialErrorCode(publicResponse.error.code),
      message: publicSocialErrorMessage(publicResponse.error.message),
    },
  };
}

function handlePublicSocialError(
  result: { readonly status: number; readonly body: unknown },
  defaultMessage: string,
): never {
  const parsed = socialKitErrorSchema.safeParse(result.body);
  const rawError = isRecord(result.body) ? result.body.error : undefined;
  const rawErrorRecord = isRecord(rawError) ? rawError : undefined;
  const code = parsed.success
    ? parsed.data.error.code
    : typeof rawErrorRecord?.code === "string"
      ? rawErrorRecord.code
      : "UNKNOWN";
  const message = parsed.success
    ? parsed.data.error.message
    : typeof rawErrorRecord?.message === "string"
      ? rawErrorRecord.message
      : defaultMessage;
  const reason = parsed.success ? parsed.data.error.reason : undefined;
  handleError(
    {
      status: result.status,
      body: {
        error: {
          ...(reason ? { reason } : {}),
          code: publicSocialErrorCode(code),
          message: publicSocialErrorMessage(message),
        },
      },
    },
    defaultMessage,
  );
}

function effectivePublicSocialRequest(
  body: SocialKitRequest,
): SocialKitRequest {
  const tool = findManagedSocialKitTool(body.tool);
  const collection = tool?.collection;
  if (!collection || collection.effectiveLimit === undefined) {
    return body;
  }
  const requestedLimit = Object.entries(body.input).find(([key]) => {
    return key === "limit";
  })?.[1];
  const limit =
    typeof requestedLimit === "number"
      ? Math.min(requestedLimit, collection.effectiveLimit)
      : collection.defaultLimit;
  return limit === undefined
    ? body
    : socialKitRequestSchema.parse({
        tool: body.tool,
        input: { ...body.input, limit },
      });
}

export async function callSocialKit(
  body: SocialKitRequest,
): Promise<SocialKitResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.request({
    headers: {},
    body: effectivePublicSocialRequest(body),
    fetchOptions: { signal: AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS) },
  });
  if (result.status === 200) {
    const projection = projectPublicSocialResponse(result.body);
    if (!projection.ok) {
      throw new Error("Okou Social returned an inconsistent result");
    }
    return projection.response;
  }
  handlePublicSocialError(result, "Okou Social request failed");
}

export async function createSocialKitDownload(
  body: SocialKitDownloadRequest,
): Promise<SocialKitDownloadResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.createDownload({
    headers: {},
    body,
    fetchOptions: { signal: AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS) },
  });
  if (result.status === 202) {
    return publicSocialDownloadResponse(result.body);
  }
  if (result.status === 409) {
    const conflict = socialKitDownloadConflictSchema.parse(result.body);
    if (
      conflict.error.code === "DOWNLOAD_IN_PROGRESS" &&
      conflict.error.recovery
    ) {
      throw new SocialDownloadConflictError(
        publicSocialErrorMessage(conflict.error.message),
        conflict.error.recovery,
      );
    }
  }
  handlePublicSocialError(result, "Okou Social download failed to start");
}

export async function listSocialKitDownloads(
  query: SocialKitDownloadListQuery,
): Promise<SocialKitDownloadListResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.listDownloads({
    headers: {},
    query,
    fetchOptions: { signal: AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS) },
  });
  if (result.status === 200) {
    return {
      ...result.body,
      downloads: result.body.downloads.map((download) => {
        return publicSocialDownloadResponse(download);
      }),
    };
  }
  handlePublicSocialError(result, "Okou Social download discovery failed");
}

export async function getSocialKitDownload(
  downloadId: string,
  signal: AbortSignal,
): Promise<SocialKitDownloadResponse> {
  const config = await getClientConfig();
  const client = initClient(socialContract, config);
  const result = await client.getDownload({
    headers: {},
    params: { downloadId },
    fetchOptions: {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(SOCIALKIT_API_TIMEOUT_MS),
      ]),
    },
  });
  if (result.status === 200) {
    return publicSocialDownloadResponse(result.body);
  }
  handlePublicSocialError(result, "Okou Social download status failed");
}
