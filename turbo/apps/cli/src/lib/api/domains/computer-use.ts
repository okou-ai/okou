import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import type {
  ComputerUseAuthorizationRequestCreateResponse,
  ComputerUseCommandCreateResponse,
  ComputerUseCommandResponse,
  ComputerUseReadCommandKind,
  ComputerUseWriteCommandKind,
} from "@okouai/api-contracts/contracts/computer-use";
import {
  computerUseAuthorizationRequestsContract,
  computerUseCommandContract,
  computerUseWriteCommandContract,
} from "@okouai/api-contracts/contracts/computer-use";
import {
  ApiRequestError,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";
import {
  cliClientHeaderApi,
  headersWithCliClientHeaders,
} from "../client-headers";

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function getComputerUseClientConfig() {
  const baseUrl = (await getBaseUrl()).replace(/\/$/, "");
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return {
    baseUrl,
    baseHeaders: buildHeaders(token),
    jsonQuery: false as const,
    api: cliClientHeaderApi,
  };
}

interface ComputerUseCommandParams<
  Kind extends ComputerUseReadCommandKind | ComputerUseWriteCommandKind,
> {
  readonly kind: Kind;
  readonly app?: string;
  readonly snapshotId?: string;
  readonly elementId?: string;
  readonly elementIndex?: number;
  readonly x?: number;
  readonly y?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
  readonly direction?: "up" | "down" | "left" | "right";
  readonly pages?: number;
  readonly value?: string;
  readonly text?: string;
  readonly key?: string;
  readonly action?: string;
  readonly timeoutMs?: number;
}

function commandBody<
  Kind extends ComputerUseReadCommandKind | ComputerUseWriteCommandKind,
>(params: ComputerUseCommandParams<Kind>) {
  return {
    kind: params.kind,
    timeoutMs: params.timeoutMs ?? 15_000,
    realtime: true as const,
    ...(params.app ? { app: params.app } : {}),
    ...(params.snapshotId ? { snapshotId: params.snapshotId } : {}),
    ...(params.elementId ? { elementId: params.elementId } : {}),
    ...(params.elementIndex !== undefined
      ? { elementIndex: params.elementIndex }
      : {}),
    ...(params.x !== undefined ? { x: params.x } : {}),
    ...(params.y !== undefined ? { y: params.y } : {}),
    ...(params.button ? { button: params.button } : {}),
    ...(params.clickCount !== undefined
      ? { clickCount: params.clickCount }
      : {}),
    ...(params.direction ? { direction: params.direction } : {}),
    ...(params.pages !== undefined ? { pages: params.pages } : {}),
    ...(params.value !== undefined ? { value: params.value } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.key ? { key: params.key } : {}),
    ...(params.action ? { action: params.action } : {}),
  };
}

export async function createComputerUseReadCommand(
  params: ComputerUseCommandParams<ComputerUseReadCommandKind>,
): Promise<ComputerUseCommandCreateResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(computerUseCommandContract, config);
  const result = await client.create({ body: commandBody(params) });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create computer-use command");
}

export async function createComputerUseWriteCommand(
  params: ComputerUseCommandParams<ComputerUseWriteCommandKind>,
): Promise<ComputerUseCommandCreateResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(computerUseWriteCommandContract, config);
  const result = await client.create({ body: commandBody(params) });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create computer-use write command");
}

export async function getComputerUseCommand(
  commandId: string,
  signal: AbortSignal,
): Promise<ComputerUseCommandResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(computerUseCommandContract, config);
  const result = await client.get({
    params: { commandId },
    fetchOptions: { signal },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get computer-use command");
}

export async function createComputerUseAuthorizationRequest(): Promise<ComputerUseAuthorizationRequestCreateResponse> {
  const config = await getComputerUseClientConfig();
  const client = initClient(computerUseAuthorizationRequestsContract, config);
  const result = await client.create({ body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create computer-use authorization request");
}

/**
 * Download a command screenshot through the authenticated API proxy. The bytes
 * never traverse a public URL; the API authorizes by command ownership and
 * streams the object back. Used when the command result carries an
 * object-storage pointer instead of an inline data URL.
 */
export async function fetchComputerUseScreenshot(
  commandId: string,
  signal?: AbortSignal,
): Promise<{ readonly buffer: Buffer; readonly mimeType: string }> {
  const config = await getComputerUseClientConfig();
  const response = await fetch(
    `${config.baseUrl}/api/computer-use/commands/${encodeURIComponent(
      commandId,
    )}/screenshot`,
    { headers: headersWithCliClientHeaders(config.baseHeaders), signal },
  );

  if (!response.ok) {
    throw new ApiRequestError(
      "Failed to download computer-use screenshot",
      "REQUEST_FAILED",
      response.status,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const mimeType =
    response.headers.get("content-type") ?? "application/octet-stream";
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}
