import { randomUUID } from "node:crypto";

import {
  computerUseAuthorizationRequestsContract,
  computerUseAuditEventsContract,
  computerUseCommandContract,
  computerUseHeartbeatContract,
  computerUseHostCommandsContract,
  computerUseHostsContract,
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

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { createDeferredPromise } from "../../../utils";
import { setupApp } from "../../../../__tests__/test-helpers";
import type { ApiTestUser } from "./api-bdd";
import { createRouteMocks } from "./route-test";
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
  readonly appVersion?: string;
  readonly osVersion?: string;
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

interface RecordedComputerUseS3Get {
  readonly bucket: string;
  readonly key: string;
  readonly signal: AbortSignal | undefined;
}

export interface ComputerUseS3ReadBarrier {
  readonly entered: Promise<{
    readonly signal: AbortSignal | undefined;
  }>;
  readonly release: () => void;
}

export interface ComputerUseS3Fake {
  readonly puts: readonly RecordedComputerUseS3Put[];
  readonly gets: readonly RecordedComputerUseS3Get[];
  readonly holdNextGetObject: () => ComputerUseS3ReadBarrier;
  readonly holdNextBody: () => ComputerUseS3ReadBarrier;
  readonly failNextGetObject: (error: unknown) => void;
  readonly failNextBody: (error: unknown) => void;
}

interface PendingComputerUseS3ReadBarrier {
  readonly entered: ReturnType<
    typeof createDeferredPromise<{
      readonly signal: AbortSignal | undefined;
    }>
  >;
  gate: ReturnType<typeof createDeferredPromise<void>> | undefined;
  releaseRequested: boolean;
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
    // Every Desktop registers with its installation; a new one per start
    // unless the test is exercising reactivation of the same installation.
    installationId: options.installationId ?? randomUUID(),
    hostName: options.hostName ?? "BDD Desktop",
    appVersion: options.appVersion ?? "0.1.0",
    osVersion: options.osVersion ?? "macOS 15",
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

function s3RequestSignal(options: unknown): AbortSignal | undefined {
  if (
    typeof options !== "object" ||
    options === null ||
    !("abortSignal" in options)
  ) {
    return undefined;
  }
  const signal = options.abortSignal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function pendingS3ReadBarrier(signal: AbortSignal): {
  readonly pending: PendingComputerUseS3ReadBarrier;
  readonly barrier: ComputerUseS3ReadBarrier;
} {
  const pending: PendingComputerUseS3ReadBarrier = {
    entered: createDeferredPromise(signal),
    gate: undefined,
    releaseRequested: false,
  };
  return {
    pending,
    barrier: {
      entered: pending.entered.promise,
      release: () => {
        if (pending.gate && !pending.gate.settled()) {
          pending.gate.resolve(undefined);
          return;
        }
        pending.releaseRequested = true;
      },
    },
  };
}

async function waitAtS3ReadBarrier(
  pending: PendingComputerUseS3ReadBarrier,
  requestSignal: AbortSignal | undefined,
  contextSignal: AbortSignal,
): Promise<void> {
  const operationSignal = requestSignal
    ? AbortSignal.any([contextSignal, requestSignal])
    : contextSignal;
  pending.gate = createDeferredPromise(operationSignal);
  pending.entered.resolve({ signal: requestSignal });
  if (pending.releaseRequested && !pending.gate.settled()) {
    pending.gate.resolve(undefined);
  }
  await pending.gate.promise;
}

function controlledBodyStream(
  buffer: Buffer,
  requestSignal: AbortSignal | undefined,
  contextSignal: AbortSignal,
  heldBody: PendingComputerUseS3ReadBarrier | undefined,
  bodyFailure: unknown | undefined,
): AsyncIterable<Uint8Array> {
  return (async function* stream(): AsyncIterable<Uint8Array> {
    const splitAt = Math.max(1, Math.floor(buffer.length / 2));
    yield new Uint8Array(buffer.subarray(0, splitAt));
    if (heldBody) {
      await waitAtS3ReadBarrier(heldBody, requestSignal, contextSignal);
    }
    if (bodyFailure !== undefined) {
      throw bodyFailure;
    }
    if (splitAt < buffer.length) {
      yield new Uint8Array(buffer.subarray(splitAt));
    }
  })();
}

export function createComputerUseBddApi(
  context: TestContext,
  run: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => {
    return operation();
  },
) {
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

  function hostsClient(signal?: AbortSignal) {
    return setupApp({ context, routes: computerUseRoutes, signal })(
      computerUseHostsContract,
    );
  }

  function heartbeatClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseHeartbeatContract,
    );
  }

  function commandClient(signal?: AbortSignal) {
    return setupApp({ context, routes: computerUseRoutes, signal })(
      computerUseCommandContract,
    );
  }

  function writeCommandClient(signal?: AbortSignal) {
    return setupApp({ context, routes: computerUseRoutes, signal })(
      computerUseWriteCommandContract,
    );
  }

  function hostCommandsClient() {
    return setupApp({ context, routes: computerUseRoutes })(
      computerUseHostCommandsContract,
    );
  }

  function auditEventsClient(signal?: AbortSignal) {
    return setupApp({ context, routes: computerUseRoutes, signal })(
      computerUseAuditEventsContract,
    );
  }

  function authorizationRequestsClient() {
    return setupApp({ context, routes: computerUseAuthorizationRoutes })(
      computerUseAuthorizationRequestsContract,
    );
  }

  return {
    /**
     * Stateful in-memory S3 fake for screenshot offload and proxy flows.
     * PutObject stores bytes and records the put, GetObject streams stored
     * bytes back, and DeleteObjects removes keys.
     * Installed on the vi mock, so the global afterEach mockReset uninstalls
     * it; install inside the test that needs it.
     */
    installComputerUseS3Fake(): ComputerUseS3Fake {
      const store = new Map<
        string,
        { readonly body: Buffer; readonly contentType: string }
      >();
      const puts: RecordedComputerUseS3Put[] = [];
      const gets: RecordedComputerUseS3Get[] = [];
      let heldGetObject: PendingComputerUseS3ReadBarrier | undefined;
      let heldBody: PendingComputerUseS3ReadBarrier | undefined;
      let getObjectFailure: unknown | undefined;
      let bodyFailure: unknown | undefined;

      const reserveBarrier = (
        phase: "GetObject" | "body",
      ): ComputerUseS3ReadBarrier => {
        const occupied = phase === "GetObject" ? heldGetObject : heldBody;
        if (occupied) {
          throw new Error(`Computer-use S3 ${phase} barrier is already held`);
        }
        const created = pendingS3ReadBarrier(context.signal);
        if (phase === "GetObject") {
          heldGetObject = created.pending;
        } else {
          heldBody = created.pending;
        }
        return created.barrier;
      };

      context.mocks.s3.send.mockImplementation(
        async (command: unknown, options?: unknown) => {
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
            return {};
          }
          if (name === "GetObjectCommand") {
            const signal = s3RequestSignal(options);
            gets.push({ bucket, key, signal });
            const selectedGetObjectBarrier = heldGetObject;
            heldGetObject = undefined;
            if (selectedGetObjectBarrier) {
              await waitAtS3ReadBarrier(
                selectedGetObjectBarrier,
                signal,
                context.signal,
              );
            }
            if (getObjectFailure !== undefined) {
              const error = getObjectFailure;
              getObjectFailure = undefined;
              throw error;
            }
            const stored = store.get(`${bucket}/${key}`);
            if (!stored) {
              throw new Error(
                `Computer-use S3 fake has no object ${bucket}/${key}`,
              );
            }
            const selectedBodyBarrier = heldBody;
            heldBody = undefined;
            const selectedBodyFailure = bodyFailure;
            bodyFailure = undefined;
            return {
              Body:
                selectedBodyBarrier || selectedBodyFailure !== undefined
                  ? controlledBodyStream(
                      stored.body,
                      signal,
                      context.signal,
                      selectedBodyBarrier,
                      selectedBodyFailure,
                    )
                  : bodyStream(stored.body),
            };
          }
          if (name === "DeleteObjectsCommand") {
            for (const deletedKey of deleteObjectKeys(input)) {
              store.delete(`${bucket}/${deletedKey}`);
            }
            return {};
          }
          return {};
        },
      );

      return {
        puts,
        gets,
        holdNextGetObject: () => {
          return reserveBarrier("GetObject");
        },
        holdNextBody: () => {
          return reserveBarrier("body");
        },
        failNextGetObject: (error) => {
          if (getObjectFailure !== undefined) {
            throw new Error("Computer-use S3 GetObject failure is already set");
          }
          getObjectFailure = error;
        },
        failNextBody: (error) => {
          if (bodyFailure !== undefined) {
            throw new Error("Computer-use S3 body failure is already set");
          }
          bodyFailure = error;
        },
      };
    },

    async startComputerUseHost(
      actor: ApiTestUser,
      options: ComputerUseHostStartOptions = {},
    ): Promise<{ readonly hostId: string; readonly hostToken: string }> {
      return await run(async () => {
        const response = await accept(
          hostsClient().start({
            headers: authenticate(actor),
            body: hostRuntimeBody(options),
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestStartComputerUseHost(
      actor: ComputerUseAuth,
      statuses: readonly (200 | 401 | 403 | 409)[],
      options: ComputerUseHostStartOptions = {},
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          hostsClient(signal).start({
            headers: authenticate(actor),
            body: hostRuntimeBody(options),
          }),
          statuses,
        );
      });
    },

    async requestListComputerUseHosts(
      actor: ComputerUseAuth,
      statuses: readonly (200 | 401 | 403)[],
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          hostsClient(signal).list({ headers: authenticate(actor) }),
          statuses,
        );
      });
    },

    async listComputerUseHosts(
      actor: ComputerUseAuth,
      signal?: AbortSignal,
    ): Promise<ComputerUseHostListResponse> {
      return await run(async () => {
        const response = await accept(
          hostsClient(signal).list({ headers: authenticate(actor) }),
          [200],
        );
        return response.body;
      });
    },

    async heartbeatComputerUseHost(
      hostToken: string,
      options: ComputerUseHostStartOptions = {},
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      return await run(async () => {
        const response = await accept(
          heartbeatClient().heartbeat({
            headers: hostHeaders(hostToken),
            body: hostRuntimeBody(options),
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestComputerUseHeartbeat(
      hostToken: string | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          heartbeatClient().heartbeat({
            headers: hostTokenHeaders(hostToken),
            body: hostRuntimeBody(),
          }),
          statuses,
        );
      });
    },

    async stopComputerUseHost(
      hostToken: string,
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      return await run(async () => {
        const response = await accept(
          heartbeatClient().stop({
            headers: hostHeaders(hostToken),
            body: {},
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestStopComputerUseHost(
      hostToken: string | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await run(async () => {
        return await accept(
          heartbeatClient().stop({
            headers: hostTokenHeaders(hostToken),
            body: {},
          }),
          statuses,
        );
      });
    },

    async createComputerUseReadCommand(
      auth: ComputerUseAuth,
      body: ComputerUseReadCommandBody,
      signal?: AbortSignal,
    ): Promise<ComputerUseCommandCreateResponse> {
      return await run(async () => {
        const response = await accept(
          commandClient(signal).create({
            headers: authenticate(auth),
            body: { timeoutMs: 60_000, ...body },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestCreateComputerUseReadCommand(
      auth: ComputerUseAuth,
      body: ComputerUseReadCommandBody,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          commandClient(signal).create({
            headers: authenticate(auth),
            body: { timeoutMs: 60_000, ...body },
          }),
          statuses,
        );
      });
    },

    async createComputerUseWriteCommand(
      auth: ComputerUseAuth,
      body: ComputerUseWriteCommandBody = DEFAULT_WRITE_COMMAND_BODY,
      signal?: AbortSignal,
    ): Promise<ComputerUseCommandCreateResponse> {
      return await run(async () => {
        const response = await accept(
          writeCommandClient(signal).create({
            headers: authenticate(auth),
            body: { timeoutMs: 60_000, ...body },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestCreateComputerUseWriteCommand(
      auth: ComputerUseAuth,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
      body: ComputerUseWriteCommandBody = DEFAULT_WRITE_COMMAND_BODY,
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          writeCommandClient(signal).create({
            headers: authenticate(auth),
            body: { timeoutMs: 60_000, ...body },
          }),
          statuses,
        );
      });
    },

    async readComputerUseCommand(
      auth: ComputerUseAuth,
      commandId: string,
      signal?: AbortSignal,
    ): Promise<ComputerUseCommandResponse> {
      return await run(async () => {
        const response = await accept(
          commandClient(signal).get({
            headers: authenticate(auth),
            params: { commandId },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestReadComputerUseCommand(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          commandClient(signal).get({
            headers: authenticate(auth),
            params: { commandId },
          }),
          statuses,
        );
      });
    },

    async requestComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
      statuses: readonly (200 | 401 | 403 | 404)[],
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          commandClient(signal).getScreenshot({
            headers: authenticate(auth),
            params: { commandId },
          }),
          statuses,
        );
      });
    },

    async downloadComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
      signal?: AbortSignal,
    ): Promise<{
      readonly contentType: string | null;
      readonly contentLength: string | null;
      readonly cacheControl: string | null;
      readonly contentDisposition: string | null;
      readonly bytes: Buffer;
    }> {
      return await run(async () => {
        const response = await accept(
          commandClient(signal).getScreenshot({
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
          contentLength: response.headers.get("content-length"),
          cacheControl: response.headers.get("cache-control"),
          contentDisposition: response.headers.get("content-disposition"),
          bytes: Buffer.from(await body.arrayBuffer()),
        };
      });
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
      return await run(async () => {
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
      });
    },

    async requestClaimNextComputerUseCommand(
      hostToken: string | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await run(async () => {
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
      });
    },

    async completeComputerUseCommand(
      hostToken: string,
      commandId: string,
    ): Promise<void> {
      return await run(async () => {
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
      });
    },

    async completeComputerUseCommandWith(
      hostToken: string,
      commandId: string,
      body: ComputerUseCompleteBody,
    ): Promise<void> {
      return await run(async () => {
        await accept(
          hostCommandsClient().complete({
            headers: hostHeaders(hostToken),
            params: { commandId },
            body,
          }),
          [200],
        );
      });
    },

    async requestCompleteComputerUseCommand(
      hostToken: string | null,
      commandId: string,
      body: ComputerUseCompleteBody,
      statuses: readonly (200 | 400 | 401 | 404 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          hostCommandsClient().complete({
            headers: hostTokenHeaders(hostToken),
            params: { commandId },
            body,
          }),
          statuses,
        );
      });
    },

    async requestListComputerUseAuditEvents(
      actor: ComputerUseAuth,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      },
      statuses: readonly (200 | 401 | 403)[],
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        return await accept(
          auditEventsClient(signal).list({
            headers: authenticate(actor),
            query,
          }),
          statuses,
        );
      });
    },

    async listComputerUseAuditEvents(
      actor: Exclude<ComputerUseAuth, null>,
      query: {
        readonly commandId?: string;
        readonly hostId?: string;
        readonly runId?: string;
        readonly limit?: number;
      } = {},
      signal?: AbortSignal,
    ): Promise<ComputerUseAuditEventListResponse> {
      return await run(async () => {
        const response = await accept(
          auditEventsClient(signal).list({
            headers: authenticate(actor),
            query,
          }),
          [200],
        );
        return response.body;
      });
    },

    async createComputerUseAuthorizationRequest(
      auth: ComputerUseAuth,
    ): Promise<ComputerUseAuthorizationRequestCreateResponse> {
      return await run(async () => {
        const response = await accept(
          authorizationRequestsClient().create({
            headers: authenticate(auth),
            body: {},
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestCreateComputerUseAuthorizationRequest(
      auth: ComputerUseAuth,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          authorizationRequestsClient().create({
            headers: authenticate(auth),
            body: {},
          }),
          statuses,
        );
      });
    },

    async readComputerUseAuthorizationRequest(
      actor: ApiTestUser,
      requestToken: string,
    ): Promise<ComputerUseAuthorizationRequestResponse> {
      return await run(async () => {
        const response = await accept(
          authorizationRequestsClient().get({
            headers: authenticate(actor),
            params: { requestToken },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestReadComputerUseAuthorizationRequest(
      actor: ApiTestUser | null,
      requestToken: string,
      statuses: readonly (200 | 401 | 403 | 404 | 410)[],
    ) {
      return await run(async () => {
        return await accept(
          authorizationRequestsClient().get({
            headers: authenticate(actor),
            params: { requestToken },
          }),
          statuses,
        );
      });
    },

    async applyComputerUseAuthorizationRequest(
      actor: ApiTestUser,
      requestToken: string,
      computerUseHostId: string,
    ): Promise<ComputerUseAuthorizationRequestApplyResponse> {
      return await run(async () => {
        const response = await accept(
          authorizationRequestsClient().apply({
            headers: authenticate(actor),
            params: { requestToken },
            body: { computerUseHostId },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestApplyComputerUseAuthorizationRequest(
      actor: ApiTestUser | null,
      requestToken: string,
      computerUseHostId: string,
      statuses: readonly (200 | 401 | 403 | 404 | 410)[],
    ) {
      return await run(async () => {
        return await accept(
          authorizationRequestsClient().apply({
            headers: authenticate(actor),
            params: { requestToken },
            body: { computerUseHostId },
          }),
          statuses,
        );
      });
    },
  };
}
