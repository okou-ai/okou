import {
  desktopShellContract,
  type DesktopShellRequest,
} from "@okouai/api-contracts/contracts/desktop-shell";
import { randomUUID } from "node:crypto";

import {
  computerUseAuthorizationRequestsContract,
  computerUseAuditEventsContract,
  computerUseCommandContract,
  computerUseSessionHostsContract,
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
import { desktopShellAuthorizationContract } from "@okouai/api-contracts/contracts/desktop-shell-authorization";
import { desktopShellAuthorizationRoutes } from "../../desktop-shell-authorization";

interface AuthHeaders {
  readonly authorization?: string;
}

/**
 * Computer-use routes accept either a Clerk session actor or a bearer token
 * (agent run tokens for command routes). `null` issues an unauthenticated
 * request.
 */
type ComputerUseAuth = ApiTestUser | { readonly bearer: string } | null;

export interface ComputerUseTestConnection {
  readonly actor: ApiTestUser;
  readonly hostId: string;
  readonly connectionGeneration: number;
}

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
  readonly realtime?: true;
}

interface ComputerUseWriteCommandBody {
  readonly kind: ComputerUseWriteCommandKind;
  readonly app: string;
  readonly timeoutMs?: number;
  readonly realtime?: true;
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

export interface ComputerUseS3Barrier {
  readonly entered: Promise<{
    readonly signal: AbortSignal | undefined;
  }>;
  readonly release: () => void;
}

export interface ComputerUseS3Fake {
  readonly puts: readonly RecordedComputerUseS3Put[];
  readonly holdNextPutObject: () => ComputerUseS3Barrier;
  readonly failNextPutObject: (error: unknown) => void;
}

interface PendingComputerUseS3Barrier {
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

function hostRuntimeBody(options: ComputerUseHostStartOptions = {}) {
  return {
    // Every Desktop registers with its installation; a new one per start
    // unless the test is exercising reactivation of the same installation.
    installationId: options.installationId ?? randomUUID(),
    hostName: options.hostName ?? "BDD Desktop",
    appVersion: options.appVersion ?? "0.52.1",
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

function objectBytes(body: unknown): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  return Buffer.from(typeof body === "string" ? body : "");
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

function pendingS3Barrier(signal: AbortSignal): {
  readonly pending: PendingComputerUseS3Barrier;
  readonly barrier: ComputerUseS3Barrier;
} {
  const pending: PendingComputerUseS3Barrier = {
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

async function waitAtS3Barrier(
  pending: PendingComputerUseS3Barrier,
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

  function authenticateHost(actor: ComputerUseAuth): AuthHeaders {
    if (!actor || "bearer" in actor) {
      return authenticate(actor);
    }
    const sessionId = `sess_${actor.userId}`;
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: true,
      toAuth: () => {
        return { ...actor, sessionId };
      },
    });
    context.mocks.clerk.sessions.getSession.mockResolvedValue({
      id: sessionId,
      userId: actor.userId,
      status: "active",
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            organization: { id: actor.orgId ?? "" },
            publicUserData: { userId: actor.userId },
            role: actor.orgRole ?? "org:admin",
          },
        ],
        totalCount: 1,
      },
    );
    return { authorization: "Bearer clerk-session" };
  }

  function hostRequest(connection: ComputerUseTestConnection | null) {
    return {
      headers: authenticateHost(connection?.actor ?? null),
      params: { hostId: connection?.hostId ?? randomUUID() },
      body: { connectionGeneration: connection?.connectionGeneration ?? 1 },
    };
  }

  function hostsClient(signal?: AbortSignal) {
    return setupApp({ context, routes: computerUseRoutes, signal })(
      computerUseHostsContract,
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

  function sessionHostsClient(signal?: AbortSignal) {
    return setupApp({ context, routes: computerUseRoutes, signal })(
      computerUseSessionHostsContract,
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
    async requestDesktopShellAccess(
      auth: ComputerUseAuth,
      reason: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 410)[] = [200],
    ) {
      return await run(() => {
        return accept(
          setupApp({ context, routes: desktopShellAuthorizationRoutes })(
            desktopShellAuthorizationContract,
          ).create({ headers: authenticate(auth), body: { reason } }),
          statuses,
        );
      });
    },
    async readDesktopShellAccess(
      auth: ComputerUseAuth,
      id: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 410)[] = [200],
    ) {
      return await run(() => {
        return accept(
          setupApp({ context, routes: desktopShellAuthorizationRoutes })(
            desktopShellAuthorizationContract,
          ).get({ headers: authenticate(auth), params: { id } }),
          statuses,
        );
      });
    },
    async actDesktopShellAccess(
      auth: ComputerUseAuth,
      id: string,
      action: "approve" | "deny" | "revoke",
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409 | 410)[] = [200],
    ) {
      return await run(() => {
        return accept(
          setupApp({ context, routes: desktopShellAuthorizationRoutes })(
            desktopShellAuthorizationContract,
          )[action]({ headers: authenticate(auth), params: { id }, body: {} }),
          statuses,
        );
      });
    },
    /**
     * S3 fake for screenshot offload. Records uploaded bytes
     * and supports upload barriers and upload failures.
     * Installed on the vi mock, so the global afterEach mockReset uninstalls
     * it; install inside the test that needs it.
     */
    installComputerUseS3Fake(): ComputerUseS3Fake {
      const puts: RecordedComputerUseS3Put[] = [];
      let heldPutObject: PendingComputerUseS3Barrier | undefined;
      let putObjectFailure: unknown | undefined;

      context.mocks.s3.send.mockImplementation(
        async (command: unknown, options?: unknown) => {
          const name = commandName(command);
          const input = commandInput(command);
          const bucket = typeof input.Bucket === "string" ? input.Bucket : "";
          const key = typeof input.Key === "string" ? input.Key : "";

          if (name === "PutObjectCommand") {
            const selectedPutObjectBarrier = heldPutObject;
            heldPutObject = undefined;
            if (selectedPutObjectBarrier) {
              await waitAtS3Barrier(
                selectedPutObjectBarrier,
                s3RequestSignal(options),
                context.signal,
              );
            }
            if (putObjectFailure !== undefined) {
              const error = putObjectFailure;
              putObjectFailure = undefined;
              throw error;
            }
            const body = objectBytes(input.Body);
            const contentType =
              typeof input.ContentType === "string" ? input.ContentType : "";
            puts.push({ bucket, key, body, contentType });
            return {};
          }
          return {};
        },
      );

      return {
        puts,
        holdNextPutObject: () => {
          if (heldPutObject) {
            throw new Error(
              "Computer-use S3 PutObject barrier is already held",
            );
          }
          const created = pendingS3Barrier(context.signal);
          heldPutObject = created.pending;
          return created.barrier;
        },
        failNextPutObject: (error) => {
          if (putObjectFailure !== undefined) {
            throw new Error("Computer-use S3 PutObject failure is already set");
          }
          putObjectFailure = error;
        },
      };
    },

    async startComputerUseHost(
      actor: ApiTestUser,
      options: ComputerUseHostStartOptions = {},
    ) {
      return await run(async () => {
        const response = await accept(
          sessionHostsClient().register({
            headers: authenticateHost(actor),
            body: hostRuntimeBody(options),
          }),
          [200],
        );
        return { ...response.body, connection: { ...response.body, actor } };
      });
    },

    async requestStartComputerUseHost(
      actor: ComputerUseAuth,
      statuses: readonly (200 | 401 | 403 | 409)[],
      options: ComputerUseHostStartOptions = {},
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        const response = await accept(
          sessionHostsClient(signal).register({
            headers: authenticateHost(actor),
            body: hostRuntimeBody(options),
          }),
          statuses,
        );
        if (response.status !== 200) {
          return response;
        }
        if (!actor || "bearer" in actor) {
          throw new Error("Expected a Clerk session host owner");
        }
        return {
          ...response,
          body: { ...response.body, connection: { ...response.body, actor } },
        };
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
      connection: ComputerUseTestConnection,
      options: ComputerUseHostStartOptions = {},
    ): Promise<{
      readonly ok: true;
      readonly hostId: string;
      readonly hasPendingCommands: boolean;
    }> {
      return await run(async () => {
        const response = await accept(
          sessionHostsClient().heartbeat({
            ...hostRequest(connection),
            body: {
              ...hostRuntimeBody(options),
              connectionGeneration: connection.connectionGeneration,
            },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestComputerUseHeartbeat(
      connection: ComputerUseTestConnection | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          sessionHostsClient().heartbeat({
            ...hostRequest(connection),
            body: {
              ...hostRuntimeBody(),
              connectionGeneration: connection?.connectionGeneration ?? 1,
            },
          }),
          statuses,
        );
      });
    },

    async stopComputerUseHost(
      connection: ComputerUseTestConnection,
    ): Promise<{ readonly ok: true; readonly hostId: string }> {
      return await run(async () => {
        const response = await accept(
          sessionHostsClient().stop({
            ...hostRequest(connection),
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestStopComputerUseHost(
      connection: ComputerUseTestConnection | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          sessionHostsClient().stop({
            ...hostRequest(connection),
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

    async requestCreateDesktopShellCommand(
      auth: ComputerUseAuth,
      body: DesktopShellRequest,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 409)[],
    ) {
      return await run(() => {
        return accept(
          setupApp({ context, routes: computerUseRoutes })(
            desktopShellContract,
          ).create({ headers: authenticate(auth), body }),
          statuses,
        );
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
          commandClient(signal).screenshotUrl({
            headers: authenticate(auth),
            params: { commandId },
          }),
          statuses,
        );
      });
    },

    async resolveComputerUseScreenshot(
      auth: ComputerUseAuth,
      commandId: string,
      signal?: AbortSignal,
    ) {
      return await run(async () => {
        const response = await accept(
          commandClient(signal).screenshotUrl({
            headers: authenticate(auth),
            params: { commandId },
          }),
          [200],
        );
        return {
          ...response.body,
          cacheControl: response.headers.get("cache-control"),
        };
      });
    },

    async claimNextComputerUseCommand(
      connection: ComputerUseTestConnection,
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
          sessionHostsClient().next({
            ...hostRequest(connection),
            body: {
              connectionGeneration: connection.connectionGeneration,
              supportedCapabilities: [...supportedCapabilities],
            },
          }),
          [200],
        );
        return response.body;
      });
    },

    async requestClaimNextComputerUseCommand(
      connection: ComputerUseTestConnection | null,
      statuses: readonly (200 | 401 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          sessionHostsClient().next({
            ...hostRequest(connection),
            body: {
              connectionGeneration: connection?.connectionGeneration ?? 1,
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
      connection: ComputerUseTestConnection,
      commandId: string,
    ): Promise<void> {
      return await run(async () => {
        await accept(
          sessionHostsClient().complete({
            ...hostRequest(connection),
            params: { hostId: connection.hostId, commandId },
            body: {
              connectionGeneration: connection.connectionGeneration,
              status: "succeeded",
              result: { app: "Safari", opened: true },
            },
          }),
          [200],
        );
      });
    },

    async completeComputerUseCommandWith(
      connection: ComputerUseTestConnection,
      commandId: string,
      body: ComputerUseCompleteBody,
      signal?: AbortSignal,
    ): Promise<void> {
      return await run(async () => {
        await accept(
          sessionHostsClient(signal).complete({
            ...hostRequest(connection),
            params: { hostId: connection.hostId, commandId },
            body: {
              ...body,
              connectionGeneration: connection.connectionGeneration,
            },
          }),
          [200],
        );
      });
    },

    async requestCompleteComputerUseCommand(
      connection: ComputerUseTestConnection | null,
      commandId: string,
      body: ComputerUseCompleteBody,
      statuses: readonly (200 | 400 | 401 | 404 | 409)[],
    ) {
      return await run(async () => {
        return await accept(
          sessionHostsClient().complete({
            ...hostRequest(connection),
            params: { hostId: connection?.hostId ?? randomUUID(), commandId },
            body: {
              ...body,
              connectionGeneration: connection?.connectionGeneration ?? 1,
            },
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
