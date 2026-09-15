import { spawn } from "node:child_process";
import type { ComputerUseCommandBudget } from "./computer-use-command-budget";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  resolveNativeHelperPath,
  type ResolveNativeHelperPathOptions,
} from "./native-helper-path";
import type {
  AccessibilityAppStateSnapshot,
  ComputerUseCommandFailure,
  ComputerUseCoordinateBounds,
  ComputerUseMouseButton,
} from "./computer-use-accessibility";
import type {
  ComputerUseAutomationPermissionStatus,
  ComputerUseAutomationPermissionTarget,
  ComputerUseAutomationPermissionTargetState,
  ComputerUsePermissionState,
} from "./computer-use-types";

const COMPUTER_USE_HELPER_NAME = "computer-use-helper";

type ComputerUseNativeErrorCode = ComputerUseCommandFailure["error"]["code"];

export type ComputerUseNativeForegroundRecoveryPolicy =
  | "never"
  | "on-window-unavailable"
  | "always";

export interface ComputerUseNativeClickPointRequest {
  readonly app: string;
  readonly snapshotId: string;
  readonly x: number;
  readonly y: number;
  readonly screenshotSource: "window" | "screen";
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly sourceBounds?: ComputerUseCoordinateBounds;
  readonly windowId?: number;
  readonly windowFrame?: ComputerUseCoordinateBounds;
  readonly button: ComputerUseMouseButton;
  readonly clickCount: number;
  readonly foregroundRecovery?: ComputerUseNativeForegroundRecoveryPolicy;
}

export type ComputerUseNativeActionResult = Record<string, unknown>;

export type ComputerUseNativeClickPointResult =
  ComputerUseNativeActionResult & {
    readonly screenX: number;
    readonly screenY: number;
  };

export type ComputerUseNativePressKeyResult = ComputerUseNativeActionResult & {
  readonly normalizedKey: string;
};

export type ComputerUseNativeTypeTextResult = ComputerUseNativeActionResult & {
  readonly role?: string;
  readonly description?: string;
};

export interface ComputerUseNativeAppRecord {
  readonly name: string;
  readonly bundleId?: string;
  readonly appPath?: string;
  readonly running?: boolean;
  readonly pid?: number;
}

export interface ComputerUseNativeBackend {
  readonly isCleanupPending?: () => boolean;
  readonly setCommandBudget?: (budget: ComputerUseCommandBudget | null) => void;
  readonly isAvailable?: () => boolean;
  readonly forceStop?: () => Promise<void>;
  readonly dispose: (reason?: ComputerUseNativeShutdownReason) => Promise<void>;
  readonly getPermissions: () => Promise<ComputerUsePermissionState>;
  readonly requestAccessibilityPermission: () => Promise<ComputerUsePermissionState>;
  readonly requestScreenRecordingPermission: () => Promise<ComputerUsePermissionState>;
  readonly probeAutomationPermission: (
    target: ComputerUseAutomationPermissionTarget,
  ) => Promise<ComputerUseAutomationPermissionTargetState>;
  readonly listApps: () => Promise<readonly ComputerUseNativeAppRecord[]>;
  readonly getAppState: (
    app: string,
    snapshotId: string,
    settle?: boolean,
  ) => Promise<AccessibilityAppStateSnapshot>;
  readonly openApp: (app: string) => Promise<ComputerUseNativeActionResult>;
  readonly clickElement: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly button: ComputerUseMouseButton;
    readonly clickCount: number;
    readonly foregroundRecovery?: ComputerUseNativeForegroundRecoveryPolicy;
  }) => Promise<ComputerUseNativeActionResult>;
  readonly clickPoint: (
    args: ComputerUseNativeClickPointRequest,
  ) => Promise<ComputerUseNativeClickPointResult>;
  readonly setElementValue: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly value: string;
  }) => Promise<ComputerUseNativeActionResult>;
  readonly performElementAction: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly action: string;
  }) => Promise<ComputerUseNativeActionResult>;
  readonly typeText: (args: {
    readonly app: string;
    readonly snapshotId?: string;
    readonly text: string;
    readonly foregroundRecovery?: ComputerUseNativeForegroundRecoveryPolicy;
  }) => Promise<ComputerUseNativeTypeTextResult>;
  readonly pressKey: (args: {
    readonly app: string;
    readonly snapshotId?: string;
    readonly key: string;
    readonly foregroundRecovery?: ComputerUseNativeForegroundRecoveryPolicy;
  }) => Promise<ComputerUseNativePressKeyResult>;
  readonly scrollElement: (args: {
    readonly app: string;
    readonly elementId?: string;
    readonly elementIndex?: number;
    readonly snapshotId?: string;
    readonly direction: string;
    readonly pages: number;
  }) => Promise<ComputerUseNativeActionResult>;
}

type ComputerUseNativeRequest = Record<string, unknown> & {
  readonly kind: string;
};

interface ComputerUseNativeSuccessResponse {
  readonly status: "succeeded";
  readonly result?: unknown;
}

interface ComputerUseNativeFailureResponse {
  readonly status: "failed";
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

type ComputerUseNativeResponse =
  | ComputerUseNativeSuccessResponse
  | ComputerUseNativeFailureResponse;

interface RunComputerUseHelperOptions {
  readonly helperPath?: string;
  readonly mode?: "serve" | "oneshot";
  readonly requestTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
  readonly onRuntimeError?: ComputerUseNativeRuntimeErrorReporter;
}

export type ComputerUseNativeShutdownReason =
  | "dispose"
  | "app_quit"
  | "update_relaunch";

export type ComputerUseNativeTerminationReason =
  | ComputerUseNativeShutdownReason
  | "timeout_replace"
  | "unexpected_exit";

export class ComputerUseNativeHelperError extends Error {
  constructor(
    readonly code: ComputerUseNativeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseNativeHelperError";
  }
}

/** Only a read-only native probe deadline is eligible for lifecycle recovery. */
export class ComputerUseNativePermissionTimeoutError extends ComputerUseNativeHelperError {
  constructor() {
    super(
      "accessibility_unavailable",
      "Native Computer Use runtime timed out running permissions.state",
    );
  }
}

interface NativeRuntimePhase {
  readonly phase:
    | "spawn"
    | "spawned"
    | "dispatch"
    | "response"
    | "timeout"
    | "protocol"
    | "write"
    | "close";
  readonly elapsedMs: number;
  readonly requestSequence?: number;
}

export interface ComputerUseNativeRuntimeErrorContext {
  readonly helperPath: string;
  readonly mode: "serve" | "oneshot";
  readonly requestKind: string;
  readonly stage:
    | "spawn"
    | "exit"
    | "timeout"
    | "write"
    | "protocol"
    | "shutdown";
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderr?: string;
  readonly terminationReason?: ComputerUseNativeTerminationReason;
  readonly pendingRequestCount?: number;
  readonly queuedRequestCount?: number;
  readonly processSequence?: number;
  readonly requestSequence?: number;
  readonly elapsedMs?: number;
  readonly helperUptimeMs?: number;
  /** Timer overshoot is observed scheduling delay, not proof of OS sleep. */
  readonly timerDelayMs?: number;
  readonly exitKnown?: boolean;
  readonly phases?: readonly NativeRuntimePhase[];
  readonly stderrBytes?: number;
}

type ComputerUseNativeRuntimeErrorReporter = (
  error: Error,
  context: ComputerUseNativeRuntimeErrorContext,
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseErrorCode(value: unknown): ComputerUseNativeErrorCode {
  if (
    value === "permission_denied" ||
    value === "accessibility_unavailable" ||
    value === "automation_permission_denied" ||
    value === "element_action_unsupported" ||
    value === "element_not_editable" ||
    value === "window_unavailable" ||
    value === "screen_recording_unavailable" ||
    value === "app_not_found" ||
    value === "app_open_failed" ||
    value === "unsupported_command"
  ) {
    return value;
  }
  return "accessibility_unavailable";
}

function responseErrorMessage(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "Native Computer Use helper failed";
}

function parseHelperResponse(output: string): ComputerUseNativeResponse {
  const parsed = JSON.parse(output) as unknown;
  if (!isRecord(parsed)) {
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Native Computer Use helper returned a non-object response",
    );
  }

  if (parsed.status === "succeeded") {
    return { status: "succeeded", result: parsed.result };
  }
  if (parsed.status === "failed") {
    return {
      status: "failed",
      error: isRecord(parsed.error) ? parsed.error : undefined,
    };
  }

  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    "Native Computer Use helper returned an invalid response status",
  );
}

function runtimeErrorFromUnknown(error: unknown): Error {
  return error instanceof Error
    ? error
    : new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        String(error),
      );
}

function resultRecord(result: unknown, kind: string): Record<string, unknown> {
  if (isRecord(result)) {
    return result;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid result for ${kind}`,
  );
}

function resultOptionalNumber(
  result: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = result[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function resultAppRecords(
  result: Record<string, unknown>,
): readonly ComputerUseNativeAppRecord[] {
  const value = result.apps;
  if (!Array.isArray(value)) {
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Native Computer Use helper returned invalid apps",
    );
  }

  return value.map((entry) => {
    if (typeof entry === "string" && entry.trim().length > 0) {
      return { name: entry };
    }
    if (!isRecord(entry)) {
      throw new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        "Native Computer Use helper returned invalid app entry",
      );
    }

    const name = resultRequiredString(entry, "name");
    const bundleId = resultOptionalString(entry, "bundleId");
    const appPath = resultOptionalString(entry, "appPath");
    const pid = resultOptionalNumber(entry, "pid");
    const running = entry.running;
    return {
      name,
      ...(bundleId ? { bundleId } : {}),
      ...(appPath ? { appPath } : {}),
      ...(typeof running === "boolean" ? { running } : {}),
      ...(pid !== undefined ? { pid } : {}),
    };
  });
}

function resultAccessibilityAppStateSnapshot(
  result: Parameters<typeof resultRequiredString>[0],
): AccessibilityAppStateSnapshot {
  resultRequiredString(result, "app");
  resultRequiredString(result, "snapshotId");
  const elements = result.elements;
  if (!Array.isArray(elements)) {
    throw new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Native Computer Use helper returned invalid accessibility elements",
    );
  }
  for (const element of elements) {
    if (!isRecord(element)) {
      throw new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        "Native Computer Use helper returned invalid accessibility element",
      );
    }
  }
  return result as typeof result & {
    readonly app: string;
    readonly snapshotId: string;
    readonly elements: AccessibilityAppStateSnapshot["elements"];
  };
}

function resultOptionalString(
  result: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = result[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function resultRequiredString(
  result: Record<string, unknown>,
  key: string,
): string {
  const value = result[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid ${key}`,
  );
}

function resultRequiredNumber(
  result: Record<string, unknown>,
  key: string,
): number {
  const value = result[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    `Native Computer Use helper returned invalid ${key}`,
  );
}

function resultPermissions(
  result: Record<string, unknown>,
): ComputerUsePermissionState {
  if (
    typeof result.accessibility === "boolean" &&
    typeof result.screenRecording === "boolean"
  ) {
    return {
      accessibility: result.accessibility,
      screenRecording: result.screenRecording,
    };
  }
  throw new ComputerUseNativeHelperError(
    "accessibility_unavailable",
    "Native Computer Use helper returned invalid permissions",
  );
}

function resultAutomationPermissionStatus(
  value: unknown,
): ComputerUseAutomationPermissionStatus {
  if (
    value === "unknown" ||
    value === "granted" ||
    value === "denied" ||
    value === "not_installed" ||
    value === "not_running"
  ) {
    return value;
  }
  return "unknown";
}

function resultAutomationPermissionTargetState(
  result: Record<string, unknown>,
): ComputerUseAutomationPermissionTargetState {
  return {
    status: resultAutomationPermissionStatus(result.status),
    updatedAt: resultOptionalString(result, "updatedAt") ?? null,
    reason: resultOptionalString(result, "reason") ?? null,
  };
}

export function resolveComputerUseHelperPath(
  options: ResolveNativeHelperPathOptions = {},
): string {
  return resolveNativeHelperPath(COMPUTER_USE_HELPER_NAME, options);
}

async function runComputerUseHelper(
  request: ComputerUseNativeRequest,
  options: RunComputerUseHelperOptions = {},
): Promise<Record<string, unknown>> {
  const helperPath = options.helperPath ?? resolveComputerUseHelperPath();
  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let childHadError = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      childHadError = true;
      const helperError = new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        `Unable to start native Computer Use helper: ${error.message}`,
      );
      options.onRuntimeError?.(helperError, {
        helperPath,
        mode: "oneshot",
        requestKind: request.kind,
        stage: "spawn",
      });
      reject(helperError);
    });
    child.on("close", (code, signal) => {
      if (childHadError) {
        return;
      }
      if (code !== 0) {
        const helperError = new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          stderr.trim() ||
            `Native Computer Use helper exited with status ${code ?? "null"}`,
        );
        options.onRuntimeError?.(helperError, {
          helperPath,
          mode: "oneshot",
          requestKind: request.kind,
          stage: "exit",
          exitCode: code,
          signal,
          stderr: stderr.trim(),
        });
        reject(helperError);
        return;
      }

      const response = (() => {
        try {
          return parseHelperResponse(stdout.trim());
        } catch (error) {
          const helperError = runtimeErrorFromUnknown(error);
          options.onRuntimeError?.(helperError, {
            helperPath,
            mode: "oneshot",
            requestKind: request.kind,
            stage: "protocol",
            stderr: stderr.trim(),
          });
          reject(helperError);
          return null;
        }
      })();
      if (!response) {
        return;
      }
      if (response.status === "failed") {
        reject(
          new ComputerUseNativeHelperError(
            responseErrorCode(response.error?.code),
            responseErrorMessage(response.error?.message),
          ),
        );
        return;
      }

      try {
        resolve(resultRecord(response.result ?? {}, request.kind));
      } catch (error) {
        const helperError = runtimeErrorFromUnknown(error);
        options.onRuntimeError?.(helperError, {
          helperPath,
          mode: "oneshot",
          requestKind: request.kind,
          stage: "protocol",
          stderr: stderr.trim(),
        });
        reject(helperError);
      }
    });

    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

type ComputerUseNativeRuntimeClientState = "open" | "closing" | "closed";

interface ComputerUseNativeRuntimeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closePromise: Promise<void>;
  readonly resolveClose: () => void;
  stdoutBuffer: string;
  readonly sequence: number;
  readonly startedAt: number;
  readonly phases: NativeRuntimePhase[];
  stderrBytes: number;
  closed: boolean;
  terminalErrorReported: boolean;
  stopReason: ComputerUseNativeTerminationReason | null;
  sentSignal: NodeJS.Signals | null;
}

interface PendingRuntimeRequest {
  readonly kind: string;
  readonly runtime: ComputerUseNativeRuntimeProcess;
  readonly sequence: number;
  readonly dispatchedAt: number;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
}

function runtimePayload(
  request: ComputerUseNativeRequest,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (key !== "kind" && value !== undefined) {
      payload[key] = value;
    }
  }
  return payload;
}

// macOS funnels screen capture through a single WindowServer broker that fails
// transiently when two captures overlap, so the helper must run one request at
// a time. This is the backstop that keeps a wedged helper from blocking the
// whole serialized queue forever. A timeout invalidates this backend; only the
// generation owner may construct a replacement after proving retirement.
export const COMPUTER_USE_NATIVE_PERMISSION_TIMEOUT_MS = 60_000;
const DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS =
  COMPUTER_USE_NATIVE_PERMISSION_TIMEOUT_MS;
const DEFAULT_RUNTIME_SHUTDOWN_GRACE_MS = 1_000;

function boundedElapsed(start: number): number {
  return Math.min(120_000, Math.max(0, Math.round(performance.now() - start)));
}

class ComputerUseNativeRuntimeClient {
  private runtime: ComputerUseNativeRuntimeProcess | null = null;
  private readonly retiringRuntimes =
    new Set<ComputerUseNativeRuntimeProcess>();
  private requestCounter = 0;
  private processCounter = 0;
  private state: ComputerUseNativeRuntimeClientState = "open";
  private readonly pending = new Map<string, PendingRuntimeRequest>();
  private queueTail: Promise<void> = Promise.resolve();
  private queuedRequestCount = 0;
  private disposePromise: Promise<void> | null = null;

  constructor(
    private readonly helperPath: string,
    private readonly requestTimeoutMs: number,
    private readonly shutdownGraceMs: number,
    private readonly onRuntimeError:
      | ComputerUseNativeRuntimeErrorReporter
      | undefined,
  ) {}

  isAvailable(): boolean {
    return this.state === "open";
  }

  isCleanupPending(): boolean {
    return (
      this.retiringRuntimes.size > 0 ||
      (this.state === "closing" && !!this.runtime && !this.runtime.closed)
    );
  }

  request(request: ComputerUseNativeRequest): Promise<Record<string, unknown>> {
    if (this.state !== "open") {
      return Promise.reject(this.closedError());
    }
    // Serialize every request so at most one capture is in flight. The tail
    // tracks completion only and swallows the outcome so a single rejected
    // request never poisons the chain for the requests queued behind it.
    this.queuedRequestCount += 1;
    const run = this.queueTail.then(async () => {
      this.queuedRequestCount -= 1;
      // Disposal may start while this request is waiting behind another one.
      // Re-check at dispatch time so a queued request cannot respawn a helper
      // after shutdown has begun.
      if (this.state !== "open") {
        throw this.closedError();
      }
      return this.dispatch(request);
    });
    this.queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private dispatch(
    request: ComputerUseNativeRequest,
  ): Promise<Record<string, unknown>> {
    const runtime = this.ensureRuntime();
    const id = `desktop_${(this.requestCounter += 1).toString()}`;
    const sequence = this.requestCounter;
    const dispatchedAt = performance.now();
    this.recordPhase(runtime, "dispatch", sequence);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending || pending.runtime !== runtime) {
          return;
        }
        // Mark timeout ownership before signaling. The generation owner must
        // prove retirement before allowing a replacement process.
        runtime.stopReason = "timeout_replace";
        const helperError =
          request.kind === "permissions.state"
            ? new ComputerUseNativePermissionTimeoutError()
            : new ComputerUseNativeHelperError(
                "accessibility_unavailable",
                `Native Computer Use runtime timed out running ${request.kind}`,
              );
        this.recordPhase(runtime, "timeout", sequence);
        this.reportRuntimeError(helperError, {
          mode: "serve",
          requestKind: request.kind,
          stage: "timeout",
          terminationReason: "timeout_replace",
          ...this.runtimeEvidence(runtime, pending),
          timerDelayMs: boundedElapsed(dispatchedAt + this.requestTimeoutMs),
        });
        this.failRuntime(runtime, helperError);
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        kind: request.kind,
        runtime,
        sequence,
        dispatchedAt,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const failedWrite = (error: Error | null | undefined) => {
        const pending = this.pending.get(id);
        if (error && pending?.runtime === runtime) {
          const helperError = new ComputerUseNativeHelperError(
            "accessibility_unavailable",
            "Unable to write to native Computer Use runtime",
          );
          this.recordPhase(runtime, "write", sequence);
          this.reportRuntimeError(helperError, {
            mode: "serve",
            requestKind: request.kind,
            stage: "write",
            ...this.runtimeEvidence(runtime, pending),
          });
          this.failRuntime(runtime, helperError);
        }
      };
      try {
        runtime.child.stdin.write(
          `${JSON.stringify({ id, kind: request.kind, payload: runtimePayload(request) })}\n`,
          failedWrite,
        );
      } catch (error) {
        failedWrite(runtimeErrorFromUnknown(error));
      }
    });
  }

  dispose(reason: ComputerUseNativeShutdownReason = "dispose"): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.state = "closing";
    this.rejectAll(this.closedError());
    const runtime = this.runtime;
    const runtimes = new Set(this.retiringRuntimes);
    if (runtime) runtimes.add(runtime);
    this.disposePromise = Promise.all(
      [...runtimes].map((owned) => this.stopRuntime(owned, reason)),
    )
      .then(() => {})
      .finally(() => {
        if (this.runtime === runtime) {
          this.runtime = null;
        }
        this.state = "closed";
      });
    return this.disposePromise;
  }

  private ensureRuntime(): ComputerUseNativeRuntimeProcess {
    if (this.runtime) {
      return this.runtime;
    }
    if (this.state !== "open") {
      throw this.closedError();
    }
    const child = spawn(this.helperPath, ["serve"], {
      // Electron handles SIGTERM asynchronously. Give the long-lived helper
      // its own process group so a terminal/updater signal cannot kill it
      // before the JS before-quit handler records shutdown ownership.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const runtime: ComputerUseNativeRuntimeProcess = {
      child,
      closePromise,
      resolveClose,
      stdoutBuffer: "",
      sequence: ++this.processCounter,
      startedAt: performance.now(),
      phases: [],
      stderrBytes: 0,
      closed: false,
      terminalErrorReported: false,
      stopReason: null,
      sentSignal: null,
    };
    this.runtime = runtime;
    this.recordPhase(runtime, "spawn");
    child.once("spawn", () => this.recordPhase(runtime, "spawned"));

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.handleStdout(runtime, chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Count, never retain arbitrary helper stderr (which can contain app data).
      runtime.stderrBytes = Math.min(
        4096,
        runtime.stderrBytes + Buffer.byteLength(chunk),
      );
    });
    // Shutdown can close the pipe while a write callback is still pending.
    // The callback below owns request errors; this listener prevents the
    // stream's expected error event from becoming an uncaught exception.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      this.markRuntimeClosed(runtime);
      if (this.runtime === runtime) {
        this.runtime = null;
      }
      if (runtime.stopReason || runtime.terminalErrorReported) {
        return;
      }
      runtime.terminalErrorReported = true;
      const helperError = new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        `Unable to start native Computer Use runtime: ${error.message}`,
      );
      this.reportRuntimeError(helperError, {
        mode: "serve",
        requestKind: "runtime",
        stage: "spawn",
        ...this.runtimeEvidence(runtime),
      });
      this.failRuntime(runtime, helperError);
    });
    child.on("close", (code, signal) => {
      this.markRuntimeClosed(runtime);
      if (this.runtime === runtime) {
        this.runtime = null;
      }
      if (
        runtime.terminalErrorReported ||
        this.isExpectedExit(runtime, code, signal)
      ) {
        return;
      }
      runtime.terminalErrorReported = true;
      const helperError = new ComputerUseNativeHelperError(
        "accessibility_unavailable",
        signal
          ? `Native Computer Use runtime terminated by ${signal}`
          : `Native Computer Use runtime exited with status ${code ?? "null"}`,
      );
      this.reportRuntimeError(helperError, {
        mode: "serve",
        requestKind: "runtime",
        stage: "exit",
        exitCode: code,
        signal,
        ...this.runtimeEvidence(runtime),
        terminationReason: "unexpected_exit",
      });
      this.failRuntime(runtime, helperError);
    });
    return runtime;
  }

  private handleStdout(
    runtime: ComputerUseNativeRuntimeProcess,
    chunk: string,
  ): void {
    if (
      runtime.terminalErrorReported ||
      runtime.closed ||
      this.runtime !== runtime
    )
      return;
    runtime.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = runtime.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = runtime.stdoutBuffer.slice(0, newlineIndex).trim();
      runtime.stdoutBuffer = runtime.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleResponseLine(runtime, line);
      }
    }
  }

  private handleResponseLine(
    runtime: ComputerUseNativeRuntimeProcess,
    line: string,
  ): void {
    let requestKind = "runtime";
    let correlated: PendingRuntimeRequest | undefined;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed) || typeof parsed.id !== "string") {
        throw new ComputerUseNativeHelperError(
          "accessibility_unavailable",
          "Native Computer Use runtime returned an uncorrelated response",
        );
      }
      const pending = this.pending.get(parsed.id);
      if (!pending || pending.runtime !== runtime) {
        return;
      }
      requestKind = pending.kind;
      correlated = pending;
      this.recordPhase(runtime, "response", pending.sequence);
      const response = parseHelperResponse(line);
      if (response.status === "failed") {
        if (
          pending.kind === "permissions.state" &&
          response.error?.code === "target_app_unresponsive"
        ) {
          const error = new ComputerUseNativePermissionTimeoutError();
          this.reportRuntimeError(error, {
            mode: "serve",
            requestKind,
            stage: "timeout",
            ...this.runtimeEvidence(runtime, pending),
          });
          this.failRuntime(runtime, error);
          return;
        }
        this.pending.delete(parsed.id);
        pending.reject(
          new ComputerUseNativeHelperError(
            responseErrorCode(response.error?.code),
            responseErrorMessage(response.error?.message),
          ),
        );
        return;
      }
      const result = resultRecord(response.result ?? {}, pending.kind);
      if (
        pending.kind === "permissions.state" ||
        pending.kind === "permissions.request_accessibility" ||
        pending.kind === "permissions.request_screen_recording"
      ) {
        resultPermissions(result);
      }
      // Keep correlation and settlement ownership until every validation succeeds.
      this.pending.delete(parsed.id);
      pending.resolve(result);
    } catch (error) {
      const helperError =
        error instanceof ComputerUseNativeHelperError
          ? error
          : new ComputerUseNativeHelperError(
              "accessibility_unavailable",
              "Native Computer Use runtime returned malformed JSON",
            );
      this.recordPhase(runtime, "protocol", correlated?.sequence);
      this.reportRuntimeError(helperError, {
        mode: "serve",
        requestKind,
        stage: "protocol",
        ...this.runtimeEvidence(runtime, correlated),
      });
      this.failRuntime(runtime, helperError);
    }
  }

  private async stopRuntime(
    runtime: ComputerUseNativeRuntimeProcess,
    reason: ComputerUseNativeShutdownReason,
  ): Promise<void> {
    runtime.stopReason = reason;
    if (runtime.closed) {
      return;
    }

    // The serve protocol treats stdin EOF as a graceful shutdown request.
    // Escalate only when the helper does not honor that contract in time.
    try {
      runtime.child.stdin.end();
    } catch {
      // A concurrently closing pipe is equivalent to EOF for shutdown.
    }
    if (await this.waitForRuntimeClose(runtime)) {
      return;
    }
    this.signalRuntime(runtime, "SIGTERM");
    if (await this.waitForRuntimeClose(runtime)) {
      return;
    }
    this.signalRuntime(runtime, "SIGKILL");
    if (await this.waitForRuntimeClose(runtime)) {
      return;
    }

    runtime.terminalErrorReported = true;
    const error = new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Native Computer Use runtime did not exit after SIGKILL",
    );
    this.reportRuntimeError(error, {
      mode: "serve",
      requestKind: "runtime",
      stage: "shutdown",
      terminationReason: reason,
      ...this.runtimeEvidence(runtime),
    });
    throw error;
  }

  private signalRuntime(
    runtime: ComputerUseNativeRuntimeProcess,
    signal: NodeJS.Signals,
  ): boolean {
    if (runtime.closed) {
      return false;
    }
    // Record causality before signaling. On POSIX, target the detached process
    // group so helper-owned subprocesses cannot outlive the runtime.
    runtime.sentSignal = signal;
    try {
      if (process.platform !== "win32" && runtime.child.pid) {
        process.kill(-runtime.child.pid, signal);
        return true;
      }
      return runtime.child.kill(signal);
    } catch {
      return false;
    }
  }

  private async waitForRuntimeClose(
    runtime: ComputerUseNativeRuntimeProcess,
  ): Promise<boolean> {
    if (runtime.closed) {
      return true;
    }
    if (this.shutdownGraceMs <= 0) {
      return false;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      runtime.closePromise.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.shutdownGraceMs);
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    return closed;
  }

  private isExpectedExit(
    runtime: ComputerUseNativeRuntimeProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): boolean {
    if (!runtime.stopReason) {
      return false;
    }
    if (code === 0) {
      return true;
    }
    if (runtime.sentSignal && signal === runtime.sentSignal) {
      return true;
    }
    return (
      (runtime.stopReason === "dispose" ||
        runtime.stopReason === "app_quit" ||
        runtime.stopReason === "update_relaunch") &&
      (signal === "SIGTERM" || signal === "SIGINT")
    );
  }

  private markRuntimeClosed(runtime: ComputerUseNativeRuntimeProcess): void {
    this.retiringRuntimes.delete(runtime);
    if (runtime.closed) {
      return;
    }
    runtime.closed = true;
    this.recordPhase(runtime, "close");
    runtime.stdoutBuffer = "";
    runtime.resolveClose();
  }

  private recordPhase(
    runtime: ComputerUseNativeRuntimeProcess,
    phase: NativeRuntimePhase["phase"],
    requestSequence?: number,
  ): void {
    runtime.phases.push({
      phase,
      elapsedMs: boundedElapsed(runtime.startedAt),
      ...(requestSequence === undefined ? {} : { requestSequence }),
    });
    if (runtime.phases.length > 12) runtime.phases.shift();
  }

  private runtimeEvidence(
    runtime: ComputerUseNativeRuntimeProcess,
    pending?: PendingRuntimeRequest,
  ) {
    return {
      processSequence: runtime.sequence,
      requestSequence: pending?.sequence,
      elapsedMs: pending ? boundedElapsed(pending.dispatchedAt) : undefined,
      helperUptimeMs: boundedElapsed(runtime.startedAt),
      exitKnown: runtime.closed,
      stderrBytes: runtime.stderrBytes,
      phases: [...runtime.phases],
    };
  }

  private failRuntime(
    runtime: ComputerUseNativeRuntimeProcess,
    error: Error,
  ): void {
    // A poisoned process cannot be replaced inside an old generation. Its owner
    // must retire all leases and snapshots before constructing a new backend.
    this.state = "closing";
    runtime.terminalErrorReported = true;
    runtime.stdoutBuffer = "";
    if (!runtime.closed) {
      this.retiringRuntimes.add(runtime);
      this.signalRuntime(runtime, "SIGKILL");
    }
    this.rejectRuntime(runtime, error);
  }

  private reportRuntimeError(
    error: Error,
    context: Omit<ComputerUseNativeRuntimeErrorContext, "helperPath">,
  ): void {
    this.onRuntimeError?.(error, {
      ...context,
      helperPath: this.helperPath,
      pendingRequestCount: context.pendingRequestCount ?? this.pending.size,
      queuedRequestCount: context.queuedRequestCount ?? this.queuedRequestCount,
    });
  }

  private rejectRuntime(
    runtime: ComputerUseNativeRuntimeProcess,
    error: Error,
  ): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.runtime === runtime) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private closedError(): ComputerUseNativeHelperError {
    return new ComputerUseNativeHelperError(
      "accessibility_unavailable",
      "Native Computer Use runtime is closed",
    );
  }
}

export function createComputerUseNativeBackend(
  options: RunComputerUseHelperOptions = {},
): ComputerUseNativeBackend {
  let commandBudget: ComputerUseCommandBudget | null = null;
  const helperPath = options.helperPath ?? resolveComputerUseHelperPath();
  const runtime =
    options.mode === "oneshot"
      ? null
      : new ComputerUseNativeRuntimeClient(
          helperPath,
          options.requestTimeoutMs ?? DEFAULT_RUNTIME_REQUEST_TIMEOUT_MS,
          options.shutdownGraceMs ?? DEFAULT_RUNTIME_SHUTDOWN_GRACE_MS,
          options.onRuntimeError,
        );
  const run = async (
    request: ComputerUseNativeRequest,
  ): Promise<Record<string, unknown>> => {
    // I/O continuations can run before the host's expiry timer. Check the same
    // grant at every helper dispatch, including post-action observation.
    if (commandBudget && commandBudget.remaining() <= 0) {
      throw new ComputerUseNativeHelperError(
        "command_timeout",
        "Computer Use total command budget expired before native dispatch; prior action completion may be unknown, do not replay",
      );
    }
    return runtime
      ? await runtime.request(request)
      : await runComputerUseHelper(request, { ...options, helperPath });
  };

  return {
    isAvailable: () => runtime?.isAvailable() ?? true,
    isCleanupPending: () => runtime?.isCleanupPending() ?? false,
    forceStop: async () => {
      await runtime?.dispose();
    },
    setCommandBudget: (budget) => {
      commandBudget = budget;
    },
    dispose: async (reason) => {
      await runtime?.dispose(reason);
    },
    getPermissions: async () => {
      const result = await run({ kind: "permissions.state" });
      return resultPermissions(result);
    },
    requestAccessibilityPermission: async () => {
      const result = await run({ kind: "permissions.request_accessibility" });
      return resultPermissions(result);
    },
    requestScreenRecordingPermission: async () => {
      const result = await run({
        kind: "permissions.request_screen_recording",
      });
      return resultPermissions(result);
    },
    probeAutomationPermission: async (target) => {
      const result = await run({
        kind: "permissions.probe_automation",
        target,
      });
      return resultAutomationPermissionTargetState(result);
    },
    listApps: async () => {
      const result = await run({ kind: "apps.list" });
      return resultAppRecords(result);
    },
    getAppState: async (app, snapshotId, settle) => {
      const result = await run({
        kind: "app.state",
        app,
        snapshotId,
        ...(settle ? { settle: true } : {}),
      });
      return resultAccessibilityAppStateSnapshot(result);
    },
    openApp: async (app) => {
      return await run({ kind: "app.open", app });
    },
    clickElement: async (args) => {
      return await run({ kind: "element.click", ...args });
    },
    clickPoint: async (args) => {
      const result = await run({ kind: "element.click", ...args });
      return {
        ...result,
        screenX: resultRequiredNumber(result, "screenX"),
        screenY: resultRequiredNumber(result, "screenY"),
      };
    },
    setElementValue: async (args) => {
      return await run({ kind: "element.set_value", ...args });
    },
    performElementAction: async (args) => {
      return await run({ kind: "element.perform_action", ...args });
    },
    typeText: async (args) => {
      const result = await run({ kind: "keyboard.type_text", ...args });
      const role = resultOptionalString(result, "role");
      const description = resultOptionalString(result, "description");
      return {
        ...result,
        ...(role ? { role } : {}),
        ...(description ? { description } : {}),
      };
    },
    pressKey: async (args) => {
      const result = await run({ kind: "keyboard.press_key", ...args });
      return {
        ...result,
        normalizedKey: resultRequiredString(result, "normalizedKey"),
      };
    },
    scrollElement: async (args) => {
      return await run({ kind: "element.scroll", ...args });
    },
  };
}
