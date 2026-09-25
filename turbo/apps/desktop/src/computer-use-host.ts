import type { ComputerUsePermissionQuery } from "./computer-use-permissions";
import { createComputerUseDrain } from "./computer-use-lifecycle-deadline";
import {
  ComputerUseCommandBudget,
  systemComputerUseCommandClock,
  type ComputerUseCommandClock,
} from "./computer-use-command-budget";
import { ComputerUseNativeHelperError } from "./computer-use-native";
import os from "node:os";
import type {
  ComputerUseCommand,
  ComputerUseCommandFailure,
  ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import { SUPPORTED_COMPUTER_USE_CAPABILITIES } from "./computer-use-accessibility";
import type {
  ComputerUseHostRuntimeState,
  ComputerUseLocalCommandLogEntry,
  ComputerUsePermissionState,
  ComputerUseRuntimeErrorLogEntry,
  ComputerUseRuntimeRecoveryPhase,
  ComputerUseRuntimeErrorSource,
} from "./computer-use-types";
import {
  COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
  COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
} from "./computer-use-startup-gate";
import { resolveComputerUseApiBaseUrl } from "./desktop-api-base-url";
import type { DesktopClientHeaderInjector } from "./desktop-client-headers";
import type { ComputerUseCommandSession } from "./computer-use-driver";
import type { DesktopAuthRequestOptions } from "./desktop-auth-session";

// The first heartbeat follows registration quickly, before the first command
// poll, so auth or host conflicts surface early. After that the API keeps a
// host online for 90s and only refreshes liveness every 30s.
const HEARTBEAT_FIRST_POLL_MS = 2_000;
const HEARTBEAT_POLL_MS = 15_000;
const COMMAND_COLD_POLL_MS = 5_000;
const COMMAND_BURST_POLL_MS = 500;
const COMMAND_BURST_WINDOW_MS = 10_000;
const COMMAND_ACTIVE_POLL_MS = 1_000;
const COMMAND_ACTIVE_WINDOW_MS = 60_000;
const RECOVERY_RETRY_BASE_MS = 2_000;
const RECOVERY_RETRY_MAX_MS = 60_000;
const RECOVERY_RETRY_AFTER_MAX_MS = 5 * 60_000;
const HEARTBEAT_REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_POLL_REQUEST_TIMEOUT_MS = 30_000;
// Reporting only: one hard cap includes every request and retry backoff.
const COMMAND_REPORTING_TIMEOUT_MS = 5_000;
const COMMAND_COMPLETION_RETRY_DELAY_MS = 2_000;
const COMMAND_COMPLETION_MAX_ATTEMPTS = 3;
const AUTH_ME_PATH = "/api/auth/me";
const ERROR_LOG_LIMIT = 20;
const LOCAL_COMMAND_LOG_LIMIT = 20;
const LOCAL_COMMAND_LOG_OMITTED_RESULT_KEYS = new Set([
  "appState",
  "elements",
  "screenshot",
  "visibleElements",
]);

class ComputerUseCapabilitiesPaused extends Error {}

export type ComputerUseHostFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type ComputerUseSessionFetch = (
  input: string,
  init?: RequestInit,
  options?: DesktopAuthRequestOptions,
) => Promise<Response>;

type MaybePromise<T> = T | Promise<T>;

interface ComputerUseHostRuntimeOptions {
  readonly refreshRegistrationAuth?: boolean;
  readonly commandClock?: ComputerUseCommandClock;
  readonly platformUrl: URL;
  readonly installationId: string;
  readonly hostName: string;
  readonly appVersion: string;
  readonly sessionFetch: ComputerUseSessionFetch;
  readonly hostFetch: ComputerUseHostFetch;
  readonly addClientHeaders: DesktopClientHeaderInjector;
  readonly getPermissions: (
    query?: ComputerUsePermissionQuery,
  ) => MaybePromise<ComputerUsePermissionState>;
  readonly getSupportedCapabilities?: () => readonly string[];
  readonly acquireCommand: () => ComputerUseCommandSession;
  readonly onCommandFailure?: (args: {
    readonly command: ComputerUseCommand;
    readonly failure: ComputerUseCommandFailure;
  }) => void;
  readonly onChange?: () => void;
  readonly setTimeout?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: typeof clearTimeout;
}

interface ComputerUseHostStartResponse {
  readonly hostId: string;
  readonly hostToken: string;
}

interface ComputerUseHostNextIdleResponse {
  readonly status: "idle";
}

interface ComputerUseHostNextCommandResponse {
  readonly status: "command";
  readonly command: ComputerUseCommand;
}

type ComputerUseHostNextResponse =
  | ComputerUseHostNextIdleResponse
  | ComputerUseHostNextCommandResponse;

type RuntimeErrorStateUpdate = Partial<
  Pick<
    ComputerUseHostRuntimeState,
    | "hostId"
    | "lastHeartbeatAt"
    | "lastCommandAt"
    | "recovery"
    | "localCommandLog"
  >
>;

class ComputerUseHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "ComputerUseHttpError";
    this.status = response.status;
    this.retryAfterMs = retryAfterDelayMs(response);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryDelayForAttempt(attempt: number): number {
  return Math.min(
    RECOVERY_RETRY_MAX_MS,
    RECOVERY_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
}

function retryAfterDelayMs(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, RECOVERY_RETRY_AFTER_MAX_MS);
  }

  const retryAtMs = Date.parse(value);
  if (Number.isNaN(retryAtMs)) {
    return null;
  }
  return Math.min(
    Math.max(0, retryAtMs - Date.now()),
    RECOVERY_RETRY_AFTER_MAX_MS,
  );
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableRuntimeError(error: unknown): boolean {
  if (error instanceof ComputerUseHttpError) {
    return isRetryableStatus(error.status);
  }
  if (
    error instanceof Error &&
    error.message === "Computer Use host token is not available"
  ) {
    return false;
  }
  return true;
}

function retryAfterMsFromError(error: unknown): number | null {
  if (error instanceof ComputerUseHttpError) {
    return error.retryAfterMs;
  }
  return null;
}

function commandFailureFromError(
  error: unknown,
): ComputerUseCommandExecutionResult {
  return {
    status: "failed",
    error: {
      code:
        error instanceof ComputerUseNativeHelperError
          ? error.code
          : "accessibility_unavailable",
      message: errorMessage(error),
    },
  };
}

function localCommandLogResult(
  result: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const omittedResultFields: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (LOCAL_COMMAND_LOG_OMITTED_RESULT_KEYS.has(key)) {
      omittedResultFields.push(key);
      continue;
    }
    next[key] = value;
  }
  if (omittedResultFields.length > 0) {
    next.omittedResultFields = omittedResultFields;
  }
  return next;
}

export { resolveComputerUseApiBaseUrl };

export function buildComputerUseRuntimeBody(args: {
  readonly installationId: string;
  readonly hostName: string;
  readonly appVersion: string;
  readonly permissions: ComputerUsePermissionState;
  readonly supportedCapabilities?: readonly string[];
}): Record<string, unknown> {
  return {
    installationId: args.installationId,
    hostName: args.hostName,
    appVersion: args.appVersion,
    osVersion: `${os.type()} ${os.release()}`,
    supportedCapabilities: [
      ...(args.supportedCapabilities ?? SUPPORTED_COMPUTER_USE_CAPABILITIES),
    ],
    permissions: args.permissions,
  };
}

export function readSystemHostName(fallback: string): string {
  const hostName = os.hostname().trim().replace(/\s+/g, " ");
  return hostName || fallback;
}

export class ComputerUseHostRuntime {
  private readonly apiBaseUrl: string;
  private readonly installationId: string;
  private readonly hostName: string;
  private readonly appVersion: string;
  private readonly sessionFetch: ComputerUseSessionFetch;
  private refreshRegistrationAuth: boolean;
  private readonly hostFetchRequest: ComputerUseHostFetch;
  private readonly addClientHeaders: DesktopClientHeaderInjector;
  private readonly getPermissions: ComputerUseHostRuntimeOptions["getPermissions"];
  private readonly getSupportedCapabilities: () => readonly string[];
  private readonly onCommandFailure: NonNullable<
    ComputerUseHostRuntimeOptions["onCommandFailure"]
  >;
  private readonly onChange: () => void;
  private readonly scheduleTimeout: NonNullable<
    ComputerUseHostRuntimeOptions["setTimeout"]
  >;
  private readonly clearScheduledTimeout: typeof clearTimeout;
  private running = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private commandTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private commandExecutionRunning = false;
  private draining = false;
  private sessionGeneration = 0;
  private pauseGeneration = 0;
  private commandDrained = createComputerUseDrain();
  private readonly commandRequests = new Set<Promise<unknown>>();
  private readonly reportingControllers = new Set<AbortController>();
  private lastCommandActivityAtMs: number | null = null;
  private lastCommandCompletionAtMs: number | null = null;
  private hostToken: string | null = null;
  private nextErrorLogId = 0;
  private state: ComputerUseHostRuntimeState = {
    status: "offline",
    hostId: null,
    lastHeartbeatAt: null,
    lastCommandAt: null,
    lastError: null,
    recovery: null,
    errorLog: [],
    localCommandLog: [],
  };

  constructor(options: ComputerUseHostRuntimeOptions) {
    this.commandClock = options.commandClock ?? systemComputerUseCommandClock;
    this.acquireCommand = options.acquireCommand;
    this.apiBaseUrl = resolveComputerUseApiBaseUrl(options.platformUrl);
    this.installationId = options.installationId;
    this.hostName = options.hostName;
    this.appVersion = options.appVersion;
    this.sessionFetch = options.sessionFetch;
    this.refreshRegistrationAuth = options.refreshRegistrationAuth ?? true;
    this.hostFetchRequest = options.hostFetch;
    this.addClientHeaders = options.addClientHeaders;
    this.getPermissions = options.getPermissions;
    this.getSupportedCapabilities =
      options.getSupportedCapabilities ??
      (() => {
        return SUPPORTED_COMPUTER_USE_CAPABILITIES;
      });
    this.onCommandFailure = options.onCommandFailure ?? (() => {});
    this.onChange = options.onChange ?? (() => {});
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.clearScheduledTimeout = options.clearTimeout ?? clearTimeout;
  }

  private readonly acquireCommand: ComputerUseHostRuntimeOptions["acquireCommand"];
  private readonly commandClock: ComputerUseCommandClock;

  async start(
    options: { readonly userInitiated?: boolean } = {},
  ): Promise<void> {
    if (this.running) {
      return;
    }
    // Only a user action can reset a rejected recovery attempt's budget.
    if (options.userInitiated) this.refreshRegistrationAuth = true;
    this.running = true;
    this.sessionGeneration++;
    const generation = this.sessionGeneration;
    this.draining = false;
    try {
      const nextDelay = await this.startHost();
      if (generation !== this.sessionGeneration) return;
      if (nextDelay === null) {
        this.running = false;
        return;
      }
      this.scheduleHeartbeat(nextDelay);
      this.scheduleCommandPoll(this.commandPollDelayMs());
    } catch (error) {
      if (generation === this.sessionGeneration)
        this.handleRuntimeFailure("start", error);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const controller of this.reportingControllers) controller.abort();
    this.sessionGeneration++;
    this.pauseGeneration++;
    this.draining = false;
    this.clearHeartbeatTimer();
    this.clearCommandTimer();
    this.clearRecoveryTimer();
    this.lastCommandActivityAtMs = null;
    this.lastCommandCompletionAtMs = null;
    const hostToken = this.hostToken;
    this.setState({
      status: "offline",
      hostId: null,
      lastError: null,
      recovery: null,
    });
    if (!hostToken) {
      return;
    }
    this.hostToken = null;
    try {
      await this.stopHost(hostToken);
    } catch (error) {
      this.setRuntimeErrorState("stop", error);
    }
  }

  async drainAndStop(): Promise<void> {
    await this.pauseAndDrainCommands();
    await this.stop();
  }

  /** Close admission synchronously, retaining heartbeat and host authorization. */
  async pauseAndDrainCommands(): Promise<() => void> {
    this.draining = true;
    const pause = ++this.pauseGeneration;
    const session = this.sessionGeneration;
    this.clearCommandTimer();
    if (this.state.recovery?.phase === "command_poll")
      this.clearRecoveryTimer();
    if (this.commandExecutionRunning) await this.commandDrained.promise;
    // Request deadlines do not prove that the underlying transport retired.
    await Promise.allSettled([...this.commandRequests]);
    return () => {
      if (
        !this.running ||
        session !== this.sessionGeneration ||
        pause !== this.pauseGeneration
      )
        return;
      this.draining = false;
      this.clearRecoveryState("command_poll");
      this.scheduleCommandPoll(0);
    };
  }

  getState(): ComputerUseHostRuntimeState {
    return this.state;
  }

  private async runtimeBody(
    query?: ComputerUsePermissionQuery,
  ): Promise<Record<string, unknown>> {
    const permissions = await this.getPermissions(query);
    const capabilities = this.getSupportedCapabilities();
    if (capabilities.length === 0) {
      if (this.draining) throw new ComputerUseCapabilitiesPaused();
      await this.stop();
      throw new Error("Computer Use has no available capabilities");
    }
    return buildComputerUseRuntimeBody({
      installationId: this.installationId,
      hostName: this.hostName,
      appVersion: this.appVersion,
      permissions,
      supportedCapabilities: capabilities,
    });
  }

  private setState(update: Partial<ComputerUseHostRuntimeState>): void {
    this.state = { ...this.state, ...update };
    this.onChange();
  }

  private appendRuntimeErrorLog(
    source: ComputerUseRuntimeErrorSource,
    error: unknown,
    hostId = this.state.hostId,
  ): ComputerUseRuntimeErrorLogEntry {
    const message = errorMessage(error);
    const occurredAt = new Date().toISOString();
    const entry: ComputerUseRuntimeErrorLogEntry = {
      id: `${occurredAt}-${this.nextErrorLogId++}`,
      source,
      message,
      occurredAt,
      hostId,
      status: "error",
    };
    this.setState({
      errorLog: [entry, ...this.state.errorLog].slice(0, ERROR_LOG_LIMIT),
    });
    return entry;
  }

  private setRuntimeErrorState(
    source: ComputerUseRuntimeErrorSource,
    error: unknown,
    update: RuntimeErrorStateUpdate = {},
  ): void {
    const hostId =
      "hostId" in update ? (update.hostId ?? null) : this.state.hostId;
    const entry = this.appendRuntimeErrorLog(source, error, hostId);
    this.setState({
      ...update,
      status: "error",
      hostId,
      lastError: entry.message,
      recovery: null,
    });
  }

  private deactivateInvalidHostToken(
    source: ComputerUseRuntimeErrorSource,
  ): void {
    this.hostToken = null;
    this.running = false;
    for (const controller of this.reportingControllers) controller.abort();
    this.clearHeartbeatTimer();
    this.clearCommandTimer();
    this.clearRecoveryTimer();
    const entry = this.appendRuntimeErrorLog(
      source,
      COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
      null,
    );
    this.setState({
      status: "unauthenticated",
      hostId: null,
      lastError: entry.message,
      recovery: null,
    });
  }

  private setRuntimeRecoveryState(
    phase: ComputerUseRuntimeRecoveryPhase,
    error: unknown,
    retryDelayMs: number,
  ): void {
    const entry = this.appendRuntimeErrorLog(phase, error);
    const lastRetryAt = new Date();
    this.setState({
      status: "recovering",
      lastError: entry.message,
      recovery: {
        phase,
        attempt:
          this.state.recovery?.phase === phase
            ? this.state.recovery.attempt + 1
            : 1,
        lastRetryAt: lastRetryAt.toISOString(),
        nextRetryAt: new Date(
          lastRetryAt.getTime() + retryDelayMs,
        ).toISOString(),
        retryDelayMs,
      },
    });
  }

  private startLocalCommandLogEntry(
    command: ComputerUseCommand,
    startedAt: string,
    driver: ComputerUseCommandSession["identity"],
  ): void {
    const app = command.payload.app;
    const entry: ComputerUseLocalCommandLogEntry = {
      ...(command.kind !== "plugin.call" && driver ? { driver } : {}),
      commandId: command.id,
      kind: command.kind,
      app: typeof app === "string" ? app : null,
      status: "running",
      payload: command.payload,
      result: null,
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    };
    this.setState({
      localCommandLog: [
        entry,
        ...this.state.localCommandLog.filter((candidate) => {
          return candidate.commandId !== command.id;
        }),
      ].slice(0, LOCAL_COMMAND_LOG_LIMIT),
    });
  }

  private finishLocalCommandLogEntry(args: {
    readonly commandId: string;
    readonly status: "succeeded" | "failed";
    readonly result: Record<string, unknown> | null;
    readonly error: Record<string, unknown> | null;
    readonly completedAt: string;
    readonly durationMs: number;
  }): void {
    this.setState({
      localCommandLog: this.state.localCommandLog.map((entry) => {
        if (entry.commandId !== args.commandId) {
          return entry;
        }
        return {
          ...entry,
          status: args.status,
          result: args.result ? localCommandLogResult(args.result) : null,
          error: args.error,
          completedAt: args.completedAt,
          durationMs: args.durationMs,
        };
      }),
    });
  }

  private clearHeartbeatTimer(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    this.clearScheduledTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearCommandTimer(): void {
    if (!this.commandTimer) {
      return;
    }
    this.clearScheduledTimeout(this.commandTimer);
    this.commandTimer = null;
  }

  private clearRecoveryTimer(): void {
    if (!this.recoveryTimer) {
      return;
    }
    this.clearScheduledTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  private scheduleRecovery(
    phase: ComputerUseRuntimeRecoveryPhase,
    error: unknown,
  ): void {
    if (!this.running) {
      return;
    }
    this.clearRecoveryTimer();
    const nextAttempt =
      this.state.recovery?.phase === phase
        ? this.state.recovery.attempt + 1
        : 1;
    const retryDelayMs =
      retryAfterMsFromError(error) ?? retryDelayForAttempt(nextAttempt);
    this.setRuntimeRecoveryState(phase, error, retryDelayMs);
    this.recoveryTimer = this.scheduleTimeout(() => {
      this.recoveryTimer = null;
      void this.recoverRuntime(phase);
    }, retryDelayMs);
  }

  private handleRuntimeFailure(
    phase: ComputerUseRuntimeRecoveryPhase,
    error: unknown,
  ): "scheduled_recovery" | "stopped" {
    if (!this.running) {
      return "stopped";
    }
    if (!isRetryableRuntimeError(error)) {
      this.setRuntimeErrorState(phase, error);
      this.running = false;
      this.clearHeartbeatTimer();
      this.clearCommandTimer();
      this.clearRecoveryTimer();
      return "stopped";
    }

    if (phase !== "command_poll") {
      this.clearCommandTimer();
    }
    this.scheduleRecovery(phase, error);
    return "scheduled_recovery";
  }

  private clearRecoveryState(phase: ComputerUseRuntimeRecoveryPhase): void {
    if (this.state.recovery?.phase !== phase) {
      return;
    }
    this.clearRecoveryTimer();
    this.setState({
      status: "online",
      lastError: null,
      recovery: null,
    });
  }

  private async recoverRuntime(
    phase: ComputerUseRuntimeRecoveryPhase,
  ): Promise<void> {
    if (!this.running) {
      return;
    }
    if (phase === "start") {
      await this.recoverStart();
      return;
    }
    if (phase === "heartbeat") {
      await this.recoverHeartbeat();
      return;
    }
    await this.commandLoop();
  }

  private async recoverStart(): Promise<void> {
    const generation = this.sessionGeneration;
    try {
      const nextDelay = await this.startHost();
      if (generation !== this.sessionGeneration) return;
      if (nextDelay === null) {
        this.running = false;
        return;
      }
      this.scheduleHeartbeat(nextDelay);
      this.scheduleCommandPoll(this.commandPollDelayMs());
    } catch (error) {
      if (generation === this.sessionGeneration)
        this.handleRuntimeFailure("start", error);
    }
  }

  private async recoverHeartbeat(): Promise<void> {
    const generation = this.sessionGeneration;
    try {
      const online = this.hostToken && (await this.heartbeat());
      if (generation !== this.sessionGeneration) return;
      if (!online) {
        this.running = false;
        this.clearCommandTimer();
        return;
      }
      this.scheduleHeartbeat(HEARTBEAT_POLL_MS);
      this.scheduleCommandPoll(0);
    } catch (error) {
      if (generation === this.sessionGeneration)
        this.handleRuntimeFailure("heartbeat", error);
    }
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (!this.running) {
      return;
    }
    this.heartbeatTimer = this.scheduleTimeout(() => {
      this.heartbeatTimer = null;
      void this.heartbeatLoop();
    }, delayMs);
  }

  private scheduleCommandPoll(delayMs: number): void {
    if (!this.running || this.draining || this.commandTimer) {
      return;
    }
    this.commandTimer = this.scheduleTimeout(() => {
      this.commandTimer = null;
      void this.commandLoop();
    }, delayMs);
  }

  private async heartbeatLoop(): Promise<void> {
    const generation = this.sessionGeneration;
    try {
      // A bounded native replacement keeps this host registration. Never send
      // an empty legacy capability list during its activation gap.
      if (this.draining && this.getSupportedCapabilities().length === 0) {
        this.scheduleHeartbeat(HEARTBEAT_POLL_MS);
        return;
      }
      const online = this.hostToken && (await this.heartbeat());
      if (generation !== this.sessionGeneration) return;
      if (!online) {
        this.running = false;
        this.clearCommandTimer();
        return;
      }
      this.scheduleHeartbeat(HEARTBEAT_POLL_MS);
    } catch (error) {
      if (
        error instanceof ComputerUseCapabilitiesPaused &&
        generation === this.sessionGeneration
      ) {
        this.scheduleHeartbeat(HEARTBEAT_POLL_MS);
        return;
      }
      if (generation === this.sessionGeneration)
        this.handleRuntimeFailure("heartbeat", error);
    }
  }

  private async commandLoop(): Promise<void> {
    if (
      !this.running ||
      this.draining ||
      !this.hostToken ||
      this.commandExecutionRunning
    ) {
      return;
    }
    this.commandExecutionRunning = true;
    const generation = this.sessionGeneration;
    this.commandDrained = createComputerUseDrain();
    let commandSession: ComputerUseCommandSession | undefined;
    let scheduleNextPoll = true;
    let pollImmediately = false;
    try {
      commandSession = this.acquireCommand();
      pollImmediately =
        (await this.claimAndExecuteCommand(commandSession)) === "completed";
    } catch (error) {
      scheduleNextPoll =
        generation === this.sessionGeneration &&
        this.handleRuntimeFailure("command_poll", error) !==
          "scheduled_recovery";
    } finally {
      // Keep the generation leased even if a request's Promise.race timed out.
      await Promise.allSettled([...this.commandRequests]);
      commandSession?.release();
      this.commandExecutionRunning = false;
      this.commandDrained.resolve();
      if (
        scheduleNextPoll &&
        generation === this.sessionGeneration &&
        this.running &&
        !this.draining &&
        this.hostToken &&
        this.state.recovery?.phase !== "command_poll"
      ) {
        this.scheduleCommandPoll(
          pollImmediately ? 0 : this.commandPollDelayMs(),
        );
      }
    }
  }

  private commandPollDelayMs(): number {
    const now = Date.now();
    if (
      this.lastCommandCompletionAtMs !== null &&
      now - this.lastCommandCompletionAtMs < COMMAND_BURST_WINDOW_MS
    ) {
      return COMMAND_BURST_POLL_MS;
    }
    if (
      this.lastCommandActivityAtMs !== null &&
      now - this.lastCommandActivityAtMs < COMMAND_ACTIVE_WINDOW_MS
    ) {
      return COMMAND_ACTIVE_POLL_MS;
    }
    return COMMAND_COLD_POLL_MS;
  }

  private async startHost(): Promise<number | null> {
    const generation = this.sessionGeneration;
    this.setState({ status: "connecting", lastError: null });
    const runtimeBody = await this.runtimeBody();
    if (!this.running || generation !== this.sessionGeneration) return null;
    const response = await this.sessionFetch(
      `${this.apiBaseUrl}/api/computer-use/hosts/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runtimeBody),
      },
      // Auth refresh retires this runtime; its replacement owns registration.
      // Keep the original response readable so a late success can be stopped.
      {
        retryAfterRefresh: false,
        refreshOn401: this.refreshRegistrationAuth,
      },
    );
    if (!this.running || generation !== this.sessionGeneration) {
      if (response.ok) {
        const body = (await response.json()) as ComputerUseHostStartResponse;
        await this.stopHost(body.hostToken);
      }
      return null;
    }
    if (response.status === 401) {
      if (!this.refreshRegistrationAuth) {
        this.setRuntimeErrorState(
          "start",
          "Computer Use registration was rejected after authentication refreshed. Sign in and retry.",
          { hostId: null },
        );
        return null;
      }
      const authenticated = await this.hasAuthenticatedSession();
      if (!this.running || generation !== this.sessionGeneration) return null;
      if (authenticated) {
        this.setState({
          status: "needs_organization",
          lastError: COMPUTER_USE_NEEDS_ORGANIZATION_MESSAGE,
          recovery: null,
        });
      } else {
        this.setState({
          status: "unauthenticated",
          lastError: COMPUTER_USE_UNAUTHENTICATED_MESSAGE,
          recovery: null,
        });
      }
      return null;
    }
    if (response.status === 403) {
      this.setState({
        status: "disabled",
        lastError: "Computer Use is disabled for this account.",
        recovery: null,
      });
      return null;
    }
    if (response.status === 409) {
      this.setRuntimeErrorState(
        "start",
        "Computer Use is already active in another Desktop session.",
        { hostId: null },
      );
      return null;
    }
    if (!response.ok) {
      throw new ComputerUseHttpError(
        `Failed to start Computer Use host: ${response.status}`,
        response,
      );
    }

    const body = (await response.json()) as ComputerUseHostStartResponse;
    if (!this.running || generation !== this.sessionGeneration) {
      await this.stopHost(body.hostToken);
      return null;
    }
    this.hostToken = body.hostToken;
    // A later reconnect is a new episode once this registration succeeds.
    this.refreshRegistrationAuth = true;
    this.lastCommandActivityAtMs = null;
    this.lastCommandCompletionAtMs = null;
    this.clearRecoveryTimer();
    this.setState({
      status: "online",
      hostId: body.hostId,
      lastHeartbeatAt: new Date().toISOString(),
      lastError: null,
      recovery: null,
    });
    return HEARTBEAT_FIRST_POLL_MS;
  }

  private async hasAuthenticatedSession(): Promise<boolean> {
    const response = await this.sessionFetch(
      `${this.apiBaseUrl}${AUTH_ME_PATH}`,
      {
        method: "GET",
      },
    );
    return response.ok;
  }

  private async runHostRequestWithTimeout<T>(args: {
    readonly label: string;
    readonly timeoutMs: number;
    readonly request: (signal: AbortSignal) => Promise<T>;
    readonly commandRequest?: boolean;
    readonly onLateResponse?: (response: T) => Promise<void>;
  }): Promise<T> {
    const { label, timeoutMs, request } = args;
    const timeoutMessage = () => {
      return new Error(`Computer Use ${label} timed out after ${timeoutMs}ms`);
    };
    const controller = new AbortController();
    const requestPromise = request(controller.signal)
      .then(async (response) => {
        if (controller.signal.aborted) await args.onLateResponse?.(response);
        return response;
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          throw timeoutMessage();
        }
        throw error;
      });
    if (args.commandRequest) {
      this.commandRequests.add(requestPromise);
      void requestPromise.then(
        () => this.commandRequests.delete(requestPromise),
        () => this.commandRequests.delete(requestPromise),
      );
    }
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = this.scheduleTimeout(() => {
        controller.abort();
        reject(timeoutMessage());
      }, timeoutMs);
    });

    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } finally {
      if (timer) {
        this.clearScheduledTimeout(timer);
        timer = null;
      }
    }
  }

  private async heartbeat(): Promise<boolean> {
    const generation = this.sessionGeneration;
    const deadline = performance.now() + HEARTBEAT_REQUEST_TIMEOUT_MS;
    const response = await this.runHostRequestWithTimeout({
      label: "heartbeat",
      timeoutMs: HEARTBEAT_REQUEST_TIMEOUT_MS,
      request: async (signal) => {
        const body = await this.runtimeBody({ signal, deadline });
        if (!this.running || generation !== this.sessionGeneration)
          throw new Error("Computer Use heartbeat was superseded");
        return await this.hostFetch("/api/computer-use/heartbeat", {
          method: "POST",
          body: JSON.stringify(body),
          signal,
        });
      },
    });
    if (!this.running || generation !== this.sessionGeneration) return false;
    if (response.status === 401) {
      this.deactivateInvalidHostToken("heartbeat");
      return false;
    }
    if (response.status === 409) {
      this.hostToken = null;
      this.setRuntimeErrorState(
        "heartbeat",
        "Computer Use is already active in another Desktop session.",
        { hostId: null },
      );
      return false;
    }
    if (!response.ok) {
      throw new ComputerUseHttpError(
        `Computer Use heartbeat failed: ${response.status}`,
        response,
      );
    }
    const commandPollRecovery =
      this.state.recovery?.phase === "command_poll"
        ? this.state.recovery
        : null;
    this.setState({
      status: commandPollRecovery ? "recovering" : "online",
      lastHeartbeatAt: new Date().toISOString(),
      lastError: commandPollRecovery ? this.state.lastError : null,
      recovery: commandPollRecovery,
    });
    return true;
  }

  private async claimAndExecuteCommand(
    commandSession: ComputerUseCommandSession,
  ): Promise<"idle" | "completed"> {
    const generation = this.sessionGeneration;
    if (this.getSupportedCapabilities().length === 0) {
      await this.stop();
      return "idle";
    }
    const claimStartedAt = this.commandClock.monotonicNow();
    const next = await this.runHostRequestWithTimeout<{
      response: Response;
      body: ComputerUseHostNextResponse | null;
    }>({
      label: "command poll",
      timeoutMs: COMMAND_POLL_REQUEST_TIMEOUT_MS,
      commandRequest: true,
      onLateResponse: async ({ response, body: late }) => {
        if (
          !response.ok ||
          late?.status !== "command" ||
          !this.running ||
          generation !== this.sessionGeneration
        )
          return;
        await this.completeCommandWithRetry(
          late.command.id,
          {
            status: "failed",
            error: {
              code: "command_timeout",
              message:
                "Claim arrived after the polling deadline; no native action was dispatched",
            },
          },
          generation,
        );
      },
      request: async (signal) => {
        const response = await this.hostFetch(
          "/api/computer-use/host/commands/next",
          {
            method: "POST",
            body: JSON.stringify({
              supportedCapabilities: [...this.getSupportedCapabilities()],
            }),
            signal,
          },
        );
        // Keep body consumption inside the poll deadline and late-claim owner.
        const body = response.ok
          ? ((await response.json()) as ComputerUseHostNextResponse)
          : null;
        return { response, body };
      },
    });
    if (!this.running || generation !== this.sessionGeneration) return "idle";
    if (next.response.status === 401) {
      this.deactivateInvalidHostToken("command_poll");
      return "idle";
    }
    if (!next.response.ok) {
      throw new ComputerUseHttpError(
        `Computer Use command claim failed: ${next.response.status}`,
        next.response,
      );
    }
    const body = next.body;
    if (!body)
      throw new Error("Computer Use claim response is missing its body");
    if (body.status === "idle") {
      if (
        !this.running ||
        generation !== this.sessionGeneration ||
        !this.hostToken
      ) {
        return "idle";
      }
      this.clearRecoveryState("command_poll");
      return "idle";
    }

    const startedAtMs = this.commandClock.wallNow();
    this.lastCommandActivityAtMs = startedAtMs;
    const startedAt = new Date(startedAtMs).toISOString();
    this.startLocalCommandLogEntry(
      body.command,
      startedAt,
      commandSession.identity,
    );

    let completed: ComputerUseCommandExecutionResult;
    const budget = new ComputerUseCommandBudget(
      body.command,
      claimStartedAt,
      this.commandClock,
    );
    try {
      completed = await budget.run(
        async () => {
          commandSession.beginCommand?.(budget);
          const permissions = await commandSession.getPermissions(body.command);
          if (!this.running || generation !== this.sessionGeneration)
            throw new Error(
              "Computer Use command was superseded; completion is unknown",
            );
          return commandSession.executeCommand(body.command, permissions);
        },
        () => commandSession.abort?.(),
      );
    } catch (error) {
      completed = commandFailureFromError(error);
    }
    const completedAtMs = this.commandClock.wallNow();
    this.finishLocalCommandLogEntry({
      commandId: body.command.id,
      status: completed.status,
      result: completed.status === "succeeded" ? completed.result : null,
      error: completed.status === "failed" ? completed.error : null,
      completedAt: new Date(completedAtMs).toISOString(),
      durationMs: completedAtMs - startedAtMs,
    });
    if (completed.status === "failed") {
      this.onCommandFailure({ command: body.command, failure: completed });
    }
    if (
      !this.running ||
      generation !== this.sessionGeneration ||
      !this.hostToken
    ) {
      return "idle";
    }
    await this.completeCommandWithRetry(body.command.id, completed, generation);
    if (
      !this.running ||
      generation !== this.sessionGeneration ||
      !this.hostToken
    ) {
      return "idle";
    }
    const commandActivityAtMs = Date.now();
    this.lastCommandActivityAtMs = commandActivityAtMs;
    this.lastCommandCompletionAtMs = commandActivityAtMs;
    this.setState({
      status: "online",
      lastCommandAt: new Date(commandActivityAtMs).toISOString(),
      lastError: null,
      recovery: null,
    });
    return "completed";
  }

  private async completeCommandWithRetry(
    commandId: string,
    completed: ComputerUseCommandExecutionResult,
    generation: number,
  ): Promise<void> {
    if (!this.running || generation !== this.sessionGeneration) return;
    const controller = new AbortController();
    this.reportingControllers.add(controller);
    const timeout = new Error(
      "Computer Use command reporting timed out after 5000ms",
    );
    const deadline =
      this.commandClock.monotonicNow() + COMMAND_REPORTING_TIMEOUT_MS;
    const expired = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
    const timer = this.commandClock.setTimeout(
      () => controller.abort(timeout),
      COMMAND_REPORTING_TIMEOUT_MS,
    );
    let lastError: unknown = timeout;
    try {
      for (
        let attempt = 1;
        attempt <= COMMAND_COMPLETION_MAX_ATTEMPTS;
        attempt++
      ) {
        if (!this.running || generation !== this.sessionGeneration) return;
        if (this.commandClock.monotonicNow() >= deadline) throw timeout;
        controller.signal.throwIfAborted();
        try {
          // A timed-out reporting transport has no native authority. Observe its
          // late settlement, but never let it hold the command lease past this cap.
          const response = await Promise.race([
            this.hostFetch(
              `/api/computer-use/host/commands/${commandId}/complete`,
              {
                method: "POST",
                body: JSON.stringify(completed),
                signal: controller.signal,
              },
            ),
            expired,
          ]);
          if (!this.running || generation !== this.sessionGeneration) return;
          if (this.commandClock.monotonicNow() >= deadline) throw timeout;
          controller.signal.throwIfAborted();
          if (response.ok || response.status === 409) return;
          if (response.status === 401) {
            this.deactivateInvalidHostToken("command_poll");
            return;
          }
          lastError = new ComputerUseHttpError(
            `Computer Use command completion failed: ${response.status}`,
            response,
          );
        } catch (error) {
          lastError = error;
          controller.signal.throwIfAborted();
        }
        if (attempt < COMMAND_COMPLETION_MAX_ATTEMPTS) {
          const remaining = deadline - this.commandClock.monotonicNow();
          if (remaining <= COMMAND_COMPLETION_RETRY_DELAY_MS) break;
          let retryTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              new Promise<void>((resolve) => {
                retryTimer = this.commandClock.setTimeout(
                  resolve,
                  COMMAND_COMPLETION_RETRY_DELAY_MS,
                );
              }),
              expired,
            ]);
          } finally {
            this.commandClock.clearTimeout(retryTimer);
          }
        }
      }
      throw lastError;
    } finally {
      this.commandClock.clearTimeout(timer);
      this.reportingControllers.delete(controller);
      // Also cancel fetches when a monotonic deadline is observed before its
      // timer runs. This signal can only cancel delivery, never resume execution.
      controller.abort(timeout);
    }
  }

  private hostFetch(path: string, init: RequestInit): Promise<Response> {
    if (!this.hostToken) {
      throw new Error("Computer Use host token is not available");
    }
    return this.hostFetchRequest(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: this.hostHeaders(this.hostToken, init.headers),
    });
  }

  private async stopHost(hostToken: string): Promise<void> {
    const response = await this.hostFetchRequest(
      `${this.apiBaseUrl}/api/computer-use/host/stop`,
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: this.hostHeaders(hostToken),
      },
    );
    if (response.status === 401) {
      return;
    }
    if (!response.ok) {
      throw new Error(`Computer Use host stop failed: ${response.status}`);
    }
  }

  private hostHeaders(hostToken: string, initHeaders?: HeadersInit): Headers {
    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${hostToken}`,
    });
    if (initHeaders) {
      const callerHeaders = new Headers(initHeaders);
      for (const [key, value] of callerHeaders) {
        headers.set(key, value);
      }
    }
    this.addClientHeaders(headers);
    return headers;
  }
}
