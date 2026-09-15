import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { cronComputerUseScreenshotCleanupContract } from "@okouai/api-contracts/contracts/cron";
import {
  computerUseAuthorizationRequestsContract,
  computerUseAuditEventsContract,
  computerUseCommandContract,
  computerUseHeartbeatContract,
  computerUseHostCommandsContract,
  computerUseHostsContract,
  computerUsePluginCommandContract,
  computerUseWriteCommandContract,
  type ComputerUseAuthorizationRequestApplyResponse,
  type ComputerUseAuthorizationRequestCreateResponse,
  type ComputerUseAuthorizationRequestResponse,
  type ComputerUseAuditEventListResponse,
  type ComputerUseCommandCreateResponse,
  type ComputerUseCommandError,
  type ComputerUseCommandResponse,
  type ComputerUseCommandResult,
  type ComputerUseHostListResponse,
  type ComputerUseReadCommandKind,
  type ComputerUseWriteCommandKind,
} from "@okouai/api-contracts/contracts/computer-use";
import type { ComputerUseAnyPluginCallBody } from "@okouai/api-contracts/contracts/computer-use-plugins";

import { now } from "../../../../lib/time";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
import { cronComputerUseScreenshotCleanupRoutesForTest } from "../../cron-computer-use-screenshot-cleanup";
import { computerUseRoutes } from "../../computer-use";
import { computerUseAuthorizationRoutes } from "../../computer-use-authorization";

interface AuthHeaders {
  readonly authorization?: string;
}

interface RequiredAuthHeaders {
  readonly authorization: string;
}

/**
 * Computer-use routes accept either a Clerk session actor or a bearer token
 * (agent run tokens for command routes). `null` issues an unauthenticated
 * request.
 */
type ComputerUseAuth = ApiTestUser | { readonly bearer: string } | null;

interface ComputerUseHostStartOptions {
  readonly permissions?: {
    readonly accessibility: boolean;
    readonly screenRecording: boolean;
  };
  readonly installationId?: string;
  readonly hostName?: string;
  readonly supportedCapabilities?: readonly string[];
}

interface ComputerUseReadCommandBody {
  readonly kind: ComputerUseReadCommandKind;
  readonly app?: string;
  readonly timeoutMs?: number;
}

interface ComputerUseWriteCommandBody {
  readonly kind: ComputerUseWriteCommandKind;
  readonly app: string;
  readonly timeoutMs?: number;
  readonly snapshotId?: string;
  readonly elementIndex?: number;
  readonly button?: "left" | "right" | "middle";
  readonly clickCount?: number;
}

type OptionalTimeout<Body> = Body extends unknown
  ? Omit<Body, "timeoutMs"> & { readonly timeoutMs?: number }
  : never;

type ComputerUsePluginCommandBody =
  OptionalTimeout<ComputerUseAnyPluginCallBody>;

type ComputerUseCompleteBody =
  | {
      readonly status: "succeeded";
      readonly result: ComputerUseCommandResult;
    }
  | {
      readonly status: "failed";
      readonly error: ComputerUseCommandError;
    };

interface RecordedComputerUseS3Put {
  readonly bucket: string;
  readonly key: string;
  readonly body: Buffer;
  readonly contentType: string;
}

function bufferFromBinaryChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  throw new Error("Expected a binary computer-use plugin content chunk");
}

function hasArrayBufferMethod(
  body: unknown,
): body is { readonly arrayBuffer: () => Promise<ArrayBuffer> } {
  return (
    typeof body === "object" &&
    body !== null &&
    "arrayBuffer" in body &&
    typeof body.arrayBuffer === "function"
  );
}

function hasWebStreamReader(body: unknown): body is {
  readonly getReader: () => {
    readonly read: () => Promise<{
      readonly done?: boolean;
      readonly value?: unknown;
    }>;
    readonly releaseLock?: () => void;
  };
} {
  return (
    typeof body === "object" &&
    body !== null &&
    "getReader" in body &&
    typeof body.getReader === "function"
  );
}

function isAsyncIterable(body: unknown): body is AsyncIterable<unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof body[Symbol.asyncIterator] === "function"
  );
}

async function binaryResponseBodyToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (hasArrayBufferMethod(body)) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (hasWebStreamReader(body)) {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      chunks.push(bufferFromBinaryChunk(result.value));
    }
    reader.releaseLock?.();
    return Buffer.concat(chunks);
  }
  if (isAsyncIterable(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(bufferFromBinaryChunk(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Expected a binary computer-use plugin content body");
}

interface ComputerUseS3Fake {
  readonly puts: readonly RecordedComputerUseS3Put[];
  readonly deletedKeys: readonly string[];
}

const DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES = [
  "apps.list",
  "app.state",
  "app.open",
  "element.click",
  "element.scroll",
  "element.set_value",
  "element.perform_action",
  "keyboard.type_text",
  "keyboard.press_key",
] as const;

const DEFAULT_WRITE_COMMAND_BODY = {
  kind: "app.open",
  app: "Safari",
  timeoutMs: 60_000,
} as const satisfies ComputerUseWriteCommandBody;

function hostHeaders(hostToken: string): RequiredAuthHeaders {
  return { authorization: `Bearer ${hostToken}` };
}

function hostTokenHeaders(hostToken: string | null): AuthHeaders {
  return hostToken === null ? {} : hostHeaders(hostToken);
}

function hostRuntimeBody(options: ComputerUseHostStartOptions = {}) {
  return {
    ...(options.installationId
      ? { installationId: options.installationId }
      : {}),
    hostName: options.hostName ?? "BDD Desktop",
    appVersion: "0.1.0",
    osVersion: "macOS 15",
    supportedCapabilities: [
      ...(options.supportedCapabilities ??
        DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES),
    ],
    permissions: options.permissions ?? {
      accessibility: true,
      screenRecording: true,
    },
  };
}

function commandName(command: unknown): string {
  return typeof command === "object" && command !== null
    ? command.constructor.name
    : "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (
    typeof command === "object" &&
    command !== null &&
    "input" in command &&
    typeof command.input === "object" &&
    command.input !== null
  ) {
    return command.input as Record<string, unknown>;
  }
  return {};
}

function deleteObjectKeys(input: Record<string, unknown>): string[] {
  const request = input.Delete;
  if (
    typeof request !== "object" ||
    request === null ||
    !("Objects" in request) ||
    !Array.isArray(request.Objects)
  ) {
    return [];
  }
  const keys: string[] = [];
  for (const object of request.Objects) {
    if (
      typeof object === "object" &&
      object !== null &&
      "Key" in object &&
      typeof object.Key === "string"
    ) {
      keys.push(object.Key);
    }
  }
  return keys;
}

function objectBytes(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  return Buffer.from(typeof body === "string" ? body : "");
}

function bodyStream(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* stream(): AsyncIterable<Uint8Array> {
    yield new Uint8Array(buffer);
  })();
}

/**
 * Mint an agent run token directly, the same auth boundary production crosses
 * when agent-runs-create issues a token whose chat thread granted a
 * computer-use host (`generateOkouToken`). Precedent: the run-token helpers
 * in api-bdd-github.ts. Returns the runId so audit events created by the
 * token's commands can be read back through the audit-events list API.
 */
export function computerUseToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly Capability[];
  readonly runId?: string;
  readonly computerUseHostId?: string;
}): { readonly token: string; readonly runId: string } {
  const seconds = Math.floor(now() / 1000);
  const runId = args.runId ?? `run_${randomUUID()}`;
  const token = signSandboxJwtForTests({
    scope: "okou",
    userId: args.userId,
    orgId: args.orgId,
    runId,
    capabilities: [...args.capabilities],
    ...(args.computerUseHostId
      ? { computerUseHostId: args.computerUseHostId }
      : {}),
    iat: seconds,
    exp: seconds + 3600,
  });
  return { token, runId };
}

export function createComputerUseBddApi(context: TestContext) {
  const mocks = createRouteMocks(context);

  function authenticate(auth: ComputerUseAuth): AuthHeaders {
    if (auth === null) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }
    if ("bearer" in auth) {
      return { authorization: `Bearer ${auth.bearer}` };
    }
    mocks.clerk.session(auth.userId, auth.orgId, auth.orgRole);
    return { authorization: "Bearer clerk-session" };
  }

  function hostsClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseHostsContract,
    );
  }

  function heartbeatClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseHeartbeatContract,
    );
  }

  function commandClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseCommandContract,
    );
  }

  function writeCommandClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseWriteCommandContract,
    );
  }

  function pluginCommandClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUsePluginCommandContract,
    );
  }

  function hostCommandsClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseHostCommandsContract,
    );
  }

  function auditEventsClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseAuditEventsContract,
    );
  }

  function authorizationRequestsClient() {
    return setupApp({ context, routes: computerUseAuthorizationRoutes })(
      computerUseAuthorizationRequestsContract,
    );
  }

  function cleanupCronClient(commandIds: readonly string[]) {
    return setupApp({
      context,
      routes: cronComputerUseScreenshotCleanupRoutesForTest(commandIds),
    })(cronComputerUseScreenshotCleanupContract);
  }

  return {
    /**
     * Stateful in-memory S3 fake for the screenshot offload, proxy, and
     * retention flows. PutObject stores bytes and records the put, GetObject
     * streams stored bytes back, DeleteObjects records and removes keys.
     * Installed on the vi mock, so the global afterEach mockReset uninstalls
     * it; install inside the test that needs it.
     */
    installComputerUseS3Fake(): ComputerUseS3Fake {
      const store = new Map<
        string,
        { readonly body: Buffer; readonly contentType: string }
      >();
      const puts: RecordedComputerUseS3Put[] = [];
      const deletedKeys: string[] = [];

      context.mocks.s3.send.mockImplementation((command: unknown) => {
        const name = commandName(command);
        const input = commandInput(command);
        const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
        const key = typeof input.Key === "string" ? input.Key : "";

        if (name === "PutObjectCommand") {
          const body = objectBytes(input.Body);
          const contentType =
            typeof input.ContentType === "string" ? input.ContentType : "";
          store.set(`${bucket}/${key}`, { body, contentType });
          puts.push({ bucket, key, body, contentType });
          return Promise.resolve({});
        }
        if (name === "GetObjectCommand") {
          const stored = store.get(`${bucket}/${key}`);
          if (!stored) {
            return Promise.reject(
              new Error(`Computer-use S3 fake has no object ${bucket}/${key}`),
            );
          }
          return Promise.resolve({ Body: bodyStream(stored.body) });
        }
        if (name === "DeleteObjectsCommand") {
          for (const deletedKey of deleteObjectKeys(input)) {
            deletedKeys.push(deletedKey);
            store.delete(`${bucket}/${deletedKey}`);
          }
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      return { puts, deletedKeys };
    },

    async startComputerUseHost(
      actor: ApiTestUser,
      options: ComputerUseHostStartOptions = {},
    ): Promise<{ readonly hostId: string; readonly hostToken: string }> {
      const response = await accept(
        hostsClient().start({
          headers: authenticate(actor),
          body: hostRuntimeBody(options),
        }),
        [200],
      );
      return response.body;
    },

    async requestStartComputerUseHost(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 409)[],
    ) {
      return await accept(
        hostsClient().start({
          headers: authenticate(actor),
          body: hostRuntimeBody(),
        }),
        statuses,
      );
    },

    async requestListComputerUseHosts(
      actor: ComputerUseAuth,
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        hostsClient().list({ headers: authenticate(actor) }),
        statuses,
      );
    },

    async listComputerUseHosts(
      actor: ComputerUseAuth,
    ): Promise<ComputerUseHostListResponse> {
      const response = await accept(
        hostsClient().list({ headers: authenticate(actor) }),
        [200],
      );
      return response.body;
    },

    async heartbeatComputerUseHost(
      hostToken: string,
      options: ComputerUseHostStartOptions = {},
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      const response = await accept(
        heartbeatClient().heartbeat({
          headers: hostHeaders(hostToken),
          body: hostRuntimeBody(options),
        }),
        [200],
      );
      return response.body;
    },

    async requestComputerUseHeartbeat(
      hostToken: string | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return await accept(
        heartbeatClient().heartbeat({
          headers: hostTokenHeaders(hostToken),
          body: hostRuntimeBody(),
        }),
        statuses,
      );
    },

    async stopComputerUseHost(
      hostToken: string,
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      const response = await accept(
        heartbeatClient().stop({
          headers: hostHeaders(hostToken),
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestStopComputerUseHost(
      hostToken: string | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        heartbeatClient().stop({
          headers: hostTokenHeaders(hostToken),
          body: {},
        }),
        statuses,
      );
    },

    async createComputerUseReadCommand(
      auth: ComputerUseAuth,
      body: ComputerUseReadCommandBody,
    ): Promise<ComputerUseCommandCreateResponse> {
      const response = await accept(
        commandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 60_000, ...body },
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUseReadCommand(
      auth: ComputerUseAuth,
      body: ComputerUseReadCommandBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        commandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 60_000, ...body },
        }),
        statuses,
      );
    },

    async createComputerUseWriteCommand(
      auth: ComputerUseAuth,
      body: ComputerUseWriteCommandBody = DEFAULT_WRITE_COMMAND_BODY,
    ): Promise<ComputerUseCommandCreateResponse> {
      const response = await accept(
        writeCommandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 60_000, ...body },
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUseWriteCommand(
      auth: ComputerUseAuth,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
      body: ComputerUseWriteCommandBody = DEFAULT_WRITE_COMMAND_BODY,
    ) {
      return await accept(
        writeCommandClient().create({
          headers: authenticate(auth),
          body: { timeoutMs: 60_000, ...body },
        }),
        statuses,
      );
    },

    async createComputerUsePluginCommand(
      auth: ComputerUseAuth,
      body: ComputerUsePluginCommandBody,
    ): Promise<ComputerUseCommandCreateResponse> {
      const response = await accept(
        pluginCommandClient().create({
          headers: authenticate(auth),
          body: { ...body, timeoutMs: body.timeoutMs ?? 60_000 },
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUsePluginCommand(
      auth: ComputerUseAuth,
      body: ComputerUsePluginCommandBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        pluginCommandClient().create({
          headers: authenticate(auth),
          body: { ...body, timeoutMs: body.timeoutMs ?? 60_000 },
        }),
        statuses,
      );
    },

    async readComputerUseCommand(
      auth: ComputerUseAuth,
      commandId: string,
    ): Promise<ComputerUseCommandResponse> {
      const response = await accept(
        commandClient().get({
          headers: authenticate(auth),
          params: { commandId },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadComputerUseCommand(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        commandClient().get({
          headers: authenticate(auth),
          params: { commandId },
        }),
        statuses,
      );
    },

    async requestComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        commandClient().getScreenshot({
          headers: authenticate(auth),
          params: { commandId },
        }),
        statuses,
      );
    },

    async requestComputerUsePluginContent(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
    ) {
      return await accept(
        commandClient().getPluginContent({
          headers: authenticate(auth),
          params: { commandId },
        }),
        statuses,
      );
    },

    async downloadComputerUsePluginContent(
      auth: ComputerUseAuth,
      commandId: string,
    ): Promise<{
      readonly contentType: string | null;
      readonly fileName: string | null;
      readonly bytes: Buffer;
    }> {
      const response = await accept(
        commandClient().getPluginContent({
          headers: authenticate(auth),
          params: { commandId },
        }),
        [200],
      );
      const body: unknown = response.body;
      const bytes = await binaryResponseBodyToBuffer(body);
      const contentDisposition = response.headers.get("content-disposition");
      return {
        contentType: response.headers.get("content-type"),
        fileName: contentDisposition
          ? (/filename="([^"]+)"/.exec(contentDisposition)?.[1] ?? null)
          : null,
        bytes,
      };
    },

    async downloadComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
    ): Promise<{
      readonly contentType: string | null;
      readonly bytes: Buffer;
    }> {
      const response = await accept(
        commandClient().getScreenshot({
          headers: authenticate(auth),
          params: { commandId },
        }),
        [200],
      );
      const body: unknown = response.body;
      if (!(body instanceof Blob)) {
        throw new Error("Expected a binary computer-use screenshot body");
      }
      return {
        contentType: response.headers.get("content-type"),
        bytes: Buffer.from(await body.arrayBuffer()),
      };
    },

    async claimNextComputerUseCommand(
      hostToken: string,
      supportedCapabilities: readonly string[] = [
        ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
      ],
    ): Promise<
      | { readonly status: "idle" }
      | {
          readonly status: "command";
          readonly command: ComputerUseCommandResponse;
        }
    > {
      const response = await accept(
        hostCommandsClient().next({
          headers: hostHeaders(hostToken),
          body: {
            supportedCapabilities: [...supportedCapabilities],
          },
        }),
        [200],
      );
      return response.body;
    },

    async requestClaimNextComputerUseCommand(
      hostToken: string | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        hostCommandsClient().next({
          headers: hostTokenHeaders(hostToken),
          body: {
            supportedCapabilities: [
              ...DEFAULT_SUPPORTED_COMPUTER_USE_CAPABILITIES,
            ],
          },
        }),
        statuses,
      );
    },

    async completeComputerUseCommand(
      hostToken: string,
      commandId: string,
    ): Promise<void> {
      await accept(
        hostCommandsClient().complete({
          headers: hostHeaders(hostToken),
          params: { commandId },
          body: {
            status: "succeeded",
            result: { app: "Safari", opened: true },
          },
        }),
        [200],
      );
    },

    async completeComputerUseCommandWith(
      hostToken: string,
      commandId: string,
      body: ComputerUseCompleteBody,
    ): Promise<void> {
      await accept(
        hostCommandsClient().complete({
          headers: hostHeaders(hostToken),
          params: { commandId },
          body,
        }),
        [200],
      );
    },

    async requestCompleteComputerUseCommand(
      hostToken: string | null,
      commandId: string,
      body: ComputerUseCompleteBody,
      statuses: readonly (200 | 400 | 401 | 404 | 409)[],
    ) {
      return await accept(
        hostCommandsClient().complete({
          headers: hostTokenHeaders(hostToken),
          params: { commandId },
          body,
        }),
        statuses,
      );
    },

    async requestListComputerUseAuditEvents(
      actor: ApiTestUser | null,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      },
      statuses: readonly (200 | 401 | 403)[],
    ) {
      return await accept(
        auditEventsClient().list({
          headers: authenticate(actor),
          query,
        }),
        statuses,
      );
    },

    async listComputerUseAuditEvents(
      actor: ApiTestUser,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<ComputerUseAuditEventListResponse> {
      const response = await accept(
        auditEventsClient().list({
          headers: authenticate(actor),
          query,
        }),
        [200],
      );
      return response.body;
    },

    async createComputerUseAuthorizationRequest(
      auth: ComputerUseAuth,
    ): Promise<ComputerUseAuthorizationRequestCreateResponse> {
      const response = await accept(
        authorizationRequestsClient().create({
          headers: authenticate(auth),
          body: {},
        }),
        [200],
      );
      return response.body;
    },

    async requestCreateComputerUseAuthorizationRequest(
      auth: ComputerUseAuth,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await accept(
        authorizationRequestsClient().create({
          headers: authenticate(auth),
          body: {},
        }),
        statuses,
      );
    },

    async readComputerUseAuthorizationRequest(
      actor: ApiTestUser,
      requestToken: string,
    ): Promise<ComputerUseAuthorizationRequestResponse> {
      const response = await accept(
        authorizationRequestsClient().get({
          headers: authenticate(actor),
          params: { requestToken },
        }),
        [200],
      );
      return response.body;
    },

    async requestReadComputerUseAuthorizationRequest(
      actor: ApiTestUser | null,
      requestToken: string,
      statuses: readonly (200 | 401 | 403 | 404 | 410)[],
    ) {
      return await accept(
        authorizationRequestsClient().get({
          headers: authenticate(actor),
          params: { requestToken },
        }),
        statuses,
      );
    },

    async applyComputerUseAuthorizationRequest(
      actor: ApiTestUser,
      requestToken: string,
      computerUseHostId: string,
    ): Promise<ComputerUseAuthorizationRequestApplyResponse> {
      const response = await accept(
        authorizationRequestsClient().apply({
          headers: authenticate(actor),
          params: { requestToken },
          body: { computerUseHostId },
        }),
        [200],
      );
      return response.body;
    },

    async requestApplyComputerUseAuthorizationRequest(
      actor: ApiTestUser | null,
      requestToken: string,
      computerUseHostId: string,
      statuses: readonly (200 | 401 | 403 | 404 | 410)[],
    ) {
      return await accept(
        authorizationRequestsClient().apply({
          headers: authenticate(actor),
          params: { requestToken },
          body: { computerUseHostId },
        }),
        statuses,
      );
    },

    async runComputerUseScreenshotCleanupCron(
      auth: "valid" | "invalid" | "missing",
      commandIds: readonly string[],
    ) {
      const headers =
        auth === "missing"
          ? {}
          : {
              authorization:
                auth === "valid"
                  ? "Bearer test-cron-secret"
                  : "Bearer wrong-secret",
            };
      return await accept(
        cleanupCronClient(commandIds).cleanup({ headers }),
        [200, 401],
      );
    },
  };
}
