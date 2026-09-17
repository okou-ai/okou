import { command } from "ccstate";
import { integrationsTeamsDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { inferMimetype } from "../../lib/mimetype";
import { isAllowedTeamsDownloadUrl } from "../../lib/teams-file-url";
import type { AuthContext } from "../../types/auth";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { db$, type ReadonlyDb } from "../external/db";
import { fetchTeamsFile } from "../external/teams-bot-client";
import {
  decodeTeamsFileToken,
  teamsFileTokenPayloadSchema,
  type TeamsFileTokenPayload,
} from "../services/teams-file-token";
import { teamsDeliveryTargetSchema } from "../services/teams-chat-callback-payload";
import type { RouteEntry } from "../route-entry";
import { safeUriComponentDecode } from "../utils";

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const teamsChatCallbackPayloadSchema = z.object({
  teamsDelivery: teamsDeliveryTargetSchema.optional(),
});

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

function jsonResponse(status: number, message: string, code: string): Response {
  return Response.json({ error: { message, code } }, { status });
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/iu);
  if (utf8Match?.[1]) {
    return decodeFilename(utf8Match[1].trim());
  }

  const quotedMatch = value.match(/filename="([^"]+)"/iu);
  return quotedMatch?.[1] ?? null;
}

function decodeFilename(value: string): string {
  return safeUriComponentDecode(value) ?? value;
}

function filenameFromDownloadUrl(url: string): string | null {
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).pop();
  return segment ? decodeFilename(segment) : null;
}

function extensionFromContentType(contentType: string | null): string | null {
  const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
  return normalized ? (EXTENSION_BY_CONTENT_TYPE[normalized] ?? null) : null;
}

function fallbackFilename(contentType: string | null): string {
  const extension = extensionFromContentType(contentType);
  return extension ? `teams-file.${extension}` : "teams-file";
}

function sanitizeDownloadFilename(filename: string): string {
  return filename.trim().replace(/[/\\]/gu, "_").slice(0, 255) || "teams-file";
}

async function teamsFilePayloadForRun(args: {
  readonly db: ReadonlyDb;
  readonly runId: string;
  readonly fileId: string;
}): Promise<TeamsFileTokenPayload | null> {
  const [callback] = await args.db
    .select({ payload: agentRunCallbacks.payload })
    .from(agentRunCallbacks)
    .where(
      and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      ),
    )
    .limit(1);
  if (!callback) {
    return null;
  }
  const parsed = teamsChatCallbackPayloadSchema.safeParse(callback.payload);
  const file = parsed.success
    ? parsed.data.teamsDelivery?.files?.find((candidate) => {
        return candidate.fileId === args.fileId;
      })
    : undefined;
  return file ? teamsFileTokenPayloadSchema.parse(file) : null;
}

async function resolveTeamsFilePayload(args: {
  readonly db: ReadonlyDb;
  readonly fileId: string;
  readonly runId: string | undefined;
}): Promise<TeamsFileTokenPayload | null> {
  const signedPayload = decodeTeamsFileToken(args.fileId);
  if (signedPayload) {
    return signedPayload;
  }
  return args.runId
    ? await teamsFilePayloadForRun({
        db: args.db,
        runId: args.runId,
        fileId: args.fileId,
      })
    : null;
}

function runIdFromAuth(auth: AuthContext): string | undefined {
  return "runId" in auth ? auth.runId : undefined;
}

function resolveFilename(args: {
  readonly payload: TeamsFileTokenPayload;
  readonly response: Response;
}): string {
  const responseContentType = args.response.headers.get("content-type");
  return sanitizeDownloadFilename(
    args.payload.name ??
      filenameFromContentDisposition(
        args.response.headers.get("content-disposition"),
      ) ??
      filenameFromDownloadUrl(args.payload.url) ??
      fallbackFilename(responseContentType),
  );
}

const download$ = command(async ({ get }, signal: AbortSignal) => {
  const query = get(queryOf(integrationsTeamsDownloadFileContract.download));
  if (!query.file_id) {
    return jsonResponse(400, "file_id is required", "BAD_REQUEST");
  }

  const payload = await resolveTeamsFilePayload({
    db: get(db$),
    fileId: query.file_id,
    runId: runIdFromAuth(get(authContext$)),
  });
  signal.throwIfAborted();
  if (!payload) {
    return jsonResponse(400, "Invalid Microsoft Teams file id", "BAD_REQUEST");
  }
  if (!isAllowedTeamsDownloadUrl(payload.url)) {
    return jsonResponse(
      400,
      "Only Microsoft Teams file attachment URLs can be downloaded",
      "BAD_REQUEST",
    );
  }

  const downloadResult = await fetchTeamsFile(
    {
      tenantId: payload.tenantId,
      url: payload.url,
      downloadMode:
        payload.downloadMode ??
        (payload.contentType === "reference" ? "graph" : undefined),
    },
    signal,
  );
  signal.throwIfAborted();
  if (downloadResult.kind === "teams-error") {
    return jsonResponse(
      502,
      "Failed to download Microsoft Teams file",
      "BAD_GATEWAY",
    );
  }

  const downloadResponse = downloadResult.response;
  if (!downloadResponse.ok) {
    const status = downloadResponse.status === 404 ? 404 : 502;
    return jsonResponse(
      status,
      `Failed to download Microsoft Teams file: ${downloadResponse.status}`,
      status === 404 ? "NOT_FOUND" : "BAD_GATEWAY",
    );
  }
  if (!downloadResponse.body) {
    return jsonResponse(
      502,
      "Microsoft Teams download response has no body",
      "EMPTY_BODY",
    );
  }

  const contentLength = downloadResponse.headers.get("content-length");
  const contentLengthBytes = parseContentLength(contentLength);
  if (
    contentLengthBytes !== undefined &&
    contentLengthBytes > MAX_FILE_SIZE_BYTES
  ) {
    return jsonResponse(
      413,
      `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes`,
      "PAYLOAD_TOO_LARGE",
    );
  }

  const responseContentType = downloadResponse.headers.get("content-type");
  if (responseContentType?.includes("text/html")) {
    return jsonResponse(
      502,
      "Microsoft Teams returned an unexpected HTML file response",
      "BAD_GATEWAY",
    );
  }

  const filename = resolveFilename({ payload, response: downloadResponse });
  const payloadContentType =
    payload.contentType === "reference" ? null : payload.contentType;
  const contentType =
    payloadContentType ?? responseContentType ?? inferMimetype(filename);

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("X-File-Name", encodeURIComponent(filename));
  headers.set("X-File-Mimetype", contentType);
  if (payload.id) {
    headers.set("X-Teams-Attachment-ID", encodeURIComponent(payload.id));
  }
  if (contentLength) {
    headers.set("Content-Length", contentLength);
  }

  return new Response(downloadResponse.body, { status: 200, headers });
});

const teamsWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "teams:write",
} as const;

export const integrationsTeamsDownloadFileRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsDownloadFileContract.download,
    handler: authRoute(teamsWriteAuth, download$),
  },
];
