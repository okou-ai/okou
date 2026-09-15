import type { ComputerUseDriverController } from "./computer-use-driver";
import type { ComputerUseNativeShutdownReason } from "./computer-use-native";
import {
  ComputerUseNativePermissionTimeoutError,
  COMPUTER_USE_NATIVE_PERMISSION_TIMEOUT_MS,
} from "./computer-use-native";
import type { ComputerUsePermissionQuery } from "./computer-use-permissions";
import {
  withComputerUseDeadline,
  type ComputerUseLifecycleTimers,
} from "./computer-use-lifecycle-deadline";
import type { DesktopAuthState } from "./desktop-bridge";
import type { DesktopAuthRefreshEvent } from "./desktop-auth-session";
import { latestWinsSingleFlight } from "./desktop-async-control";
import { resolveComputerUseStartupGate } from "./computer-use-startup-gate";
import {
  OFFLINE_COMPUTER_USE_HOST_STATE,
  hasRequiredComputerUsePermissions,
  type ComputerUseHostRuntimeState,
  type ComputerUsePermissionState,
  type DesktopComputerUseDriverState,
} from "./computer-use-types";

const DEFAULT_QUIT_STOP_TIMEOUT_MS = 1_000;

export interface ComputerUsePermissionRecoveryDiagnostic {
  readonly generation: number | null;
  readonly outcome: "recovered" | "failed" | "superseded";
  readonly elapsedMs: number;
}

interface PermissionRefresh {
  readonly promise: Promise<ComputerUsePermissionState | null>;
  readonly cancel: (mode?: "retire" | "drain") => void;
  deadline: number;
}

interface PermissionRecovery {
  readonly check: () => void;
  readonly probe: () => Promise<ComputerUsePermissionState>;
  readonly remaining: () => number;
}

/** The `ComputerUseHostRuntime` surface the controller drives. */
interface ComputerUseRuntimeLike {
  start(options?: { readonly userInitiated?: boolean }): Promise<void>;
  stop(): Promise<void>;
  drainAndStop(): Promise<void>;
  pauseAndDrainCommands(): Promise<() => void>;
  getState(): ComputerUseHostRuntimeState;
}

interface ComputerUseRuntimeControllerOptions {
  readonly onPermissionRecovery?: (
    diagnostic: ComputerUsePermissionRecoveryDiagnostic,
  ) => void;
  /**
   * Runtime factory invoked when the startup gate is ready and no runtime
   * exists. The production implementation wires all Electron/session
   * dependencies into a `ComputerUseHostRuntime`.
   */
  readonly createRuntime: (options: {
    readonly refreshRegistrationAuth: boolean;
  }) => ComputerUseRuntimeLike;
  readonly refreshPermissions: () => Promise<ComputerUsePermissionState>;
  readonly getAuthState: () => Promise<DesktopAuthState>;
  readonly getAuthAuthority?: () => object | null;
  /** Propagates runtime online/offline transitions to the plugin manager. */
  readonly setHostRuntimeOnline: (online: boolean) => void;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  readonly quitStopTimeoutMs?: number;
  readonly driver?: ComputerUseDriverController;
  readonly transitionTimeoutMs?: number;
  readonly lifecycleTimers?: ComputerUseLifecycleTimers;
  readonly getPluginCapabilities?: () => readonly string[];
  readonly preparePlugins?: () => Promise<void>;
}

/**
 * Owns the Computer Use host runtime lifecycle (start/stop/sign-out/quit),
 * extracted from `main.ts` and kept free of Electron imports so it can be
 * integration-tested by injecting fakes, mirroring the `DesktopAuthSession`
 * dependency-injection shape. Collapses the previously duplicated
 * stop-and-detach paths and the ad-hoc quit flags into one owner.
 */
export class ComputerUseRuntimeController {
  private readonly createRuntime: ComputerUseRuntimeControllerOptions["createRuntime"];
  private readonly refreshPermissions: () => Promise<ComputerUsePermissionState>;
  private readonly getAuthState: () => Promise<DesktopAuthState>;
  private readonly setHostRuntimeOnline: (online: boolean) => void;
  private readonly onChange: () => void;
  private readonly quitStopTimeoutMs: number;

  private runtime: ComputerUseRuntimeLike | null = null;
  private blockedHostState: ComputerUseHostRuntimeState | null = null;
  private manualStopRequested = false;
  private quitStopStarted = false;
  private intent = 0;
  private stopping: Promise<void> = Promise.resolve();
  private starting: Promise<void> | null = null;
  private recoveryCount = 0;
  private runningRequested = false;
  private nativeError: string | null = null;
  private phaseStartedAt = performance.now();
  private recoveryTail: Promise<void> = Promise.resolve();
  private readonly driver: ComputerUseDriverController | undefined;
  private readonly transitionTimeoutMs: number;
  private readonly lifecycleTimers: ComputerUseLifecycleTimers | undefined;
  private quitPromise: Promise<void> | null = null;
  private readonly getPluginCapabilities: () => readonly string[];
  private readonly preparePlugins: () => Promise<void>;
  private pluginStartupIntent: number | null = null;
  private permissionRefresh: PermissionRefresh | null = null;
  private backgroundAuthRefresh: {
    readonly signal: AbortSignal;
    authority: object | null;
    refreshed: boolean;
  } | null = null;
  private readonly reconcileAuthRecovery = latestWinsSingleFlight(() =>
    this.recoverAfterAuthRefresh(),
  );

  constructor(private readonly options: ComputerUseRuntimeControllerOptions) {
    this.getPluginCapabilities = options.getPluginCapabilities ?? (() => []);
    this.preparePlugins = options.preparePlugins ?? (async () => {});
    this.lifecycleTimers = options.lifecycleTimers;
    this.driver = options.driver;
    this.transitionTimeoutMs = options.transitionTimeoutMs ?? 30_000;
    this.createRuntime = options.createRuntime;
    this.refreshPermissions = options.refreshPermissions;
    this.getAuthState = options.getAuthState;
    this.setHostRuntimeOnline = options.setHostRuntimeOnline;
    this.onChange = options.onChange ?? (() => {});
    this.quitStopTimeoutMs =
      options.quitStopTimeoutMs ?? DEFAULT_QUIT_STOP_TIMEOUT_MS;
  }

  getHostState(): ComputerUseHostRuntimeState {
    const state =
      this.runtime?.getState() ??
      this.blockedHostState ??
      OFFLINE_COMPUTER_USE_HOST_STATE;
    return this.isTransitioning()
      ? { ...state, driverTransitioning: true }
      : state;
  }

  isRuntimeOnline(): boolean {
    return this.runtime?.getState().status === "online";
  }

  pluginsMayRun(): boolean {
    return this.isRuntimeOnline() || this.pluginStartupIntent === this.intent;
  }

  /** Auth refresh owns fresh authority; the controller owns the user's online intent. */
  handleBackgroundAuthRefresh(event: DesktopAuthRefreshEvent): void {
    if (this.quitStopStarted || event.signal.aborted) return;
    if (event.phase === "started") {
      this.backgroundAuthRefresh = {
        signal: event.signal,
        authority: null,
        refreshed: false,
      };
      return;
    }
    const refresh = this.backgroundAuthRefresh;
    if (refresh?.signal !== event.signal) return;
    if (event.phase === "failed" || event.identity === "changed") {
      // A changed identity must not inherit the previous session's online intent.
      this.runningRequested = false;
      this.backgroundAuthRefresh = null;
      return;
    }
    refresh.authority = this.options.getAuthAuthority?.() ?? null;
    refresh.refreshed = event.identity === "same";
    this.reconcileAuthRecovery();
  }

  private async recoverAfterAuthRefresh(): Promise<void> {
    const refresh = this.backgroundAuthRefresh;
    if (!refresh?.authority) return;
    const current = () =>
      this.backgroundAuthRefresh === refresh &&
      !refresh.signal.aborted &&
      refresh.authority === this.options.getAuthAuthority?.();
    // Completion is synchronous. Let auth/change subscribers enqueue their
    // cleanup before observing its owner; auth never awaits this recovery.
    await Promise.resolve();
    let intent = this.intent;
    try {
      await withComputerUseDeadline(
        this.stopping,
        this.transitionTimeoutMs,
        this.lifecycleTimers,
      );
      await withComputerUseDeadline(
        this.recoveryTail,
        this.transitionTimeoutMs,
        this.lifecycleTimers,
      );
      if (
        !current() ||
        !this.runningRequested ||
        this.manualStopRequested ||
        this.quitStopStarted ||
        this.runtime?.getState().status === "error"
      )
        return;
      intent = this.intent;
      await this.start({ signal: refresh.signal });
      if (current() && intent === this.intent && this.isRuntimeOnline())
        this.backgroundAuthRefresh = null;
    } catch {
      if (
        !current() ||
        intent !== this.intent ||
        this.manualStopRequested ||
        this.quitStopStarted
      )
        return;
      this.backgroundAuthRefresh = null;
      this.nativeError =
        "Authentication recovered, but Computer Use could not restart. Retry after cleanup.";
      this.onChange();
    }
  }

  /** Read-only refreshes share one episode under this lifecycle's current intent.
   * Claimed commands use their pinned driver's permission read directly.
   */
  async refreshNativePermissions(
    query: ComputerUsePermissionQuery = {},
  ): Promise<ComputerUsePermissionState | null> {
    query.signal?.throwIfAborted();
    const refresh = this.permissionRefresh ?? this.beginPermissionRefresh();
    if (query.deadline !== undefined)
      refresh.deadline = Math.min(refresh.deadline, query.deadline);
    const cancel = () => refresh.cancel();
    query.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (refresh.deadline <= performance.now())
        throw new Error("Native permission query budget expired");
      return await withComputerUseDeadline(
        refresh.promise,
        refresh.deadline - performance.now(),
        this.lifecycleTimers,
      );
    } catch (error) {
      refresh.cancel();
      throw error;
    } finally {
      query.signal?.removeEventListener("abort", cancel);
    }
  }

  private beginPermissionRefresh(): PermissionRefresh {
    const intent = this.intent;
    const authority = this.options.getAuthAuthority?.();
    const generation = this.driver?.generation ?? null;
    const eligible =
      !!this.driver &&
      this.runningRequested &&
      !!this.runtime &&
      !this.manualStopRequested &&
      !this.quitStopStarted &&
      !this.starting &&
      !this.recoveryCount &&
      (this.driver?.getCapabilities().length ?? 0) > 0;
    const startedAt = performance.now();
    let cancelled = false;
    let rejectCancelled!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const check = () => {
      if (
        cancelled ||
        intent !== this.intent ||
        authority !== this.options.getAuthAuthority?.() ||
        this.quitStopStarted ||
        refresh.deadline <= performance.now()
      ) {
        refresh.cancel();
        throw new Error("Native permission query was superseded or expired");
      }
    };
    const read = () =>
      this.driver?.withPermissionProvider((provider) =>
        provider.getPermissions(),
      ) ?? Promise.resolve(null);
    const work = async () => {
      // Capture auth before probing. A later identity is never authority for an
      // earlier refresh, even if permission grants themselves remain unchanged.
      const auth = eligible ? await this.getAuthState() : null;
      check();
      try {
        const permissions = await read();
        check();
        return permissions;
      } catch (error) {
        if (
          !(error instanceof ComputerUseNativePermissionTimeoutError) ||
          !eligible ||
          auth?.status !== "signed_in" ||
          !auth.organization
        )
          throw error;
        return this.retryPermissionProbe({
          auth,
          check,
          read,
          remaining: () => refresh.deadline - performance.now(),
          report: (outcome) =>
            this.options.onPermissionRecovery?.({
              generation,
              outcome: cancelled ? "superseded" : outcome,
              elapsedMs: Math.min(
                120_000,
                Math.max(0, Math.round(performance.now() - startedAt)),
              ),
            }),
        });
      }
    };
    const refresh: PermissionRefresh = {
      // The existing attempt bound plus the existing replacement bound is the
      // total cap (90s by default), including drain, old-process exit and retry.
      deadline:
        startedAt +
        COMPUTER_USE_NATIVE_PERMISSION_TIMEOUT_MS +
        this.transitionTimeoutMs,
      promise: Promise.race([Promise.resolve().then(work), aborted]),
      cancel: (mode = "retire") => {
        if (cancelled) return;
        cancelled = true;
        rejectCancelled(new Error("Native permission query was cancelled"));
        if (
          mode === "retire" &&
          this.permissionRefresh === refresh &&
          intent === this.intent
        ) {
          this.driver?.withdrawAdmission();
          void this.driver?.forceRetire().catch(() => {});
        }
      },
    };
    this.permissionRefresh = refresh;
    const finish = () => {
      if (this.permissionRefresh === refresh) this.permissionRefresh = null;
    };
    void refresh.promise.then(finish, finish);
    return refresh;
  }

  private async retryPermissionProbe(options: {
    readonly auth: Extract<DesktopAuthState, { status: "signed_in" }>;
    readonly check: () => void;
    readonly read: () => Promise<ComputerUsePermissionState | null>;
    readonly remaining: () => number;
    readonly report: (outcome: "failed" | "recovered") => void;
  }): Promise<ComputerUsePermissionState | null> {
    const { auth, check, read, remaining, report } = options;
    let outcome: "failed" | "recovered" = "failed";
    try {
      check();
      // The failed probe has released its lease before replacement waits for
      // retirement and any separately claimed command's completion reporting.
      let fresh: ComputerUsePermissionState | null = null;
      this.driver?.resetFailure();
      await this.recoverNativeBackend({
        check,
        remaining,
        probe: async () => {
          const currentAuth = await this.getAuthState();
          check();
          if (
            currentAuth.status !== "signed_in" ||
            currentAuth.user.userId !== auth.user.userId ||
            currentAuth.organization?.id !== auth.organization?.id
          )
            throw new Error("Native permission recovery authorization changed");
          fresh = await read();
          check();
          if (!fresh)
            throw new Error("Native permission recovery was superseded");
          return fresh;
        },
      });
      check();
      if (!fresh || !hasRequiredComputerUsePermissions(fresh))
        throw new Error("Native permission recovery did not restore readiness");
      outcome = "recovered";
      return fresh;
    } finally {
      report(outcome);
    }
  }

  getDriverState(): DesktopComputerUseDriverState {
    const state = this.driver?.getState();
    const error = this.nativeError ?? state?.error ?? null;
    const phase =
      this.nativeError || state?.error
        ? "error"
        : this.recoveryCount > 0
          ? "recovering"
          : state?.cleanupPending
            ? "retiring"
            : this.starting
              ? "starting"
              : state?.ready
                ? "ready"
                : "stopped";
    return {
      actual: state?.actual ?? null,
      phase,
      lifecycleElapsedMs: Math.min(
        120_000,
        Math.max(0, Math.round(performance.now() - this.phaseStartedAt)),
      ),
      cleanupPending: state?.cleanupPending ?? false,
      error,
      canRetry:
        !this.quitStopStarted && !this.isTransitioning() && !state?.ready,
    };
  }

  /**
   * Starts the runtime when permissions and auth pass the startup gate;
   * otherwise stops any existing runtime and records the blocked host state.
   * Non-user-initiated starts are suppressed after a manual stop.
   */
  async start(
    options: {
      readonly userInitiated?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    if (this.backgroundAuthRefresh?.signal.aborted)
      this.backgroundAuthRefresh = null;
    if (
      this.quitStopStarted ||
      ((this.nativeError !== null || this.driver?.getState().error) &&
        options.userInitiated !== true) ||
      (this.manualStopRequested && options.userInitiated !== true)
    )
      return;
    options.signal?.throwIfAborted();
    this.runningRequested = true;
    if (options.userInitiated) {
      // A new explicit Start gets its own auth budget. A pending refresh still
      // owns the completion that will finish Start after credentials arrive.
      if (this.backgroundAuthRefresh?.authority)
        this.backgroundAuthRefresh = null;
      if (this.driver?.getState().error) {
        this.stopping = Promise.all([
          this.stopping,
          this.driver.forceRetire(),
        ]).then(() => {});
      }
      this.nativeError = null;
      this.driver?.resetFailure();
    }
    this.manualStopRequested = false;
    if (this.starting) return this.starting;
    const intent = this.intent;
    const abort = () => {
      if (intent !== this.intent) return;
      this.supersede();
      this.detachRuntime();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const start = this.startRuntime(
      intent,
      this.recoveryTail,
      options.userInitiated,
    );
    this.starting = start;
    this.phaseStartedAt = performance.now();
    try {
      await start;
    } catch (error) {
      if (intent === this.intent)
        this.nativeError = "Driver startup failed. Retry after cleanup.";
      throw error;
    } finally {
      if (this.pluginStartupIntent === intent) {
        this.pluginStartupIntent = null;
        this.setHostRuntimeOnline(this.isRuntimeOnline());
      }
      options.signal?.removeEventListener("abort", abort);
      if (this.starting === start) this.starting = null;
      this.onChange();
    }
  }

  private async startRuntime(
    intent: number,
    transitions: Promise<void>,
    userInitiated = false,
  ): Promise<void> {
    await withComputerUseDeadline(
      this.stopping,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    await withComputerUseDeadline(
      transitions,
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    if (intent !== this.intent) return;
    const authState = await this.getAuthState();
    if (intent !== this.intent) return;
    const permissions = await this.prepareStartupPermissions(authState, intent);
    if (!permissions || intent !== this.intent) return;
    const startupGate = resolveComputerUseStartupGate({
      authState,
      permissions,
      pluginCapabilities: this.getPluginCapabilities(),
    });
    if (startupGate.status !== "ready") {
      await this.detachRuntime();
      if (intent !== this.intent) return;
      if (startupGate.status === "blocked") {
        this.blockedHostState = startupGate.host;
        this.onChange();
      }
      return;
    }
    this.blockedHostState = null;
    if (hasRequiredComputerUsePermissions(permissions)) this.driver?.activate();
    const runtime = (this.runtime ??= this.createRuntime({
      refreshRegistrationAuth: !this.backgroundAuthRefresh?.refreshed,
    }));
    await runtime.start({ userInitiated });
    if (intent !== this.intent) return;
    this.setHostRuntimeOnline(runtime.getState().status === "online");
  }

  private async prepareStartupPermissions(
    authState: DesktopAuthState,
    intent: number,
  ): Promise<ComputerUsePermissionState | null> {
    this.driver?.resumePermissions();
    const permissions = await withComputerUseDeadline(
      this.refreshPermissions(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    ).catch(() => {
      void this.driver?.forceRetire().catch(() => {});
      return { accessibility: false, screenRecording: false };
    });
    if (intent !== this.intent) return null;
    if (
      !hasRequiredComputerUsePermissions(permissions) &&
      authState.status === "signed_in" &&
      authState.organization
    ) {
      this.pluginStartupIntent = intent;
      await withComputerUseDeadline(
        this.preparePlugins(),
        this.transitionTimeoutMs,
        this.lifecycleTimers,
      );
      if (intent !== this.intent) return null;
    }
    return permissions;
  }

  /** The auth owner calls this synchronously when its session proof changes. */
  cancelPermissionRefresh(mode: "retire" | "drain" = "retire"): void {
    this.permissionRefresh?.cancel(mode);
    this.permissionRefresh = null;
  }

  private recoverNativeBackend(recovery: PermissionRecovery): Promise<void> {
    if (!this.driver || this.quitStopStarted) {
      return Promise.reject(new Error("Native helper recovery is unavailable"));
    }
    const intent = this.intent;
    const initialRuntime = this.runtime;
    // Close admission before awaiting any preceding transition.
    const initialDrain = initialRuntime?.pauseAndDrainCommands();
    this.driver.pausePermissions();
    let expired = false;
    const checkIntent = () => {
      recovery.check();
      if (expired || intent !== this.intent)
        throw new Error("Native helper recovery was superseded");
    };
    const previous = this.recoveryTail;
    const work = (async () => {
      await previous;
      checkIntent();
      const runtime = this.runtime;
      this.driver?.pausePermissions();
      const resume = await (runtime === initialRuntime
        ? initialDrain
        : runtime?.pauseAndDrainCommands());
      checkIntent();
      await this.driver?.retire();
      checkIntent();
      this.driver?.resumePermissions();
      if (runtime && !this.manualStopRequested)
        await this.resumeNativeBackend(resume, checkIntent, recovery.probe);
    })();
    const transition = withComputerUseDeadline(
      work,
      Math.min(this.transitionTimeoutMs, recovery.remaining()),
      this.lifecycleTimers,
    ).catch((error: unknown) => {
      expired = true;
      this.handleNativeRecoveryFailure(error, intent);
    });
    this.recoveryCount++;
    this.phaseStartedAt = performance.now();
    // The caller-facing deadline is not proof the underlying work retired.
    this.recoveryTail = work.then(
      () => {},
      () => {},
    );
    void this.recoveryTail.then(() => {
      this.recoveryCount--;
      this.onChange();
    });
    void transition.then(this.onChange, this.onChange);
    this.onChange();
    return transition;
  }

  private handleNativeRecoveryFailure(error: unknown, intent: number): void {
    // A failure withdraws the host rather than advertising empty legacy capabilities.
    if (intent === this.intent) {
      this.nativeError = "Native helper recovery failed. Retry after cleanup.";
      void this.driver?.forceRetire().catch(() => {});
      if (this.getPluginCapabilities().length > 0 && this.runtime) {
        // The rejected transition keeps its native owner retired. Existing
        // host authorization, heartbeat and plugin processes remain intact.
        void this.runtime.pauseAndDrainCommands().then((resume) => resume());
        throw error;
      }
      this.manualStopRequested = true;
      this.supersede(false);
      this.detachRuntime();
      this.blockedHostState = {
        ...OFFLINE_COMPUTER_USE_HOST_STATE,
        status: "error",
        lastError: this.nativeError,
      };
    }
    throw error;
  }

  private async resumeNativeBackend(
    resume: (() => void) | undefined,
    checkIntent: () => void,
    probe: () => Promise<ComputerUsePermissionState>,
  ): Promise<void> {
    if (this.nativeError || this.driver?.getState().error) {
      if (this.getPluginCapabilities().length > 0) resume?.();
      else await this.detachRuntime();
      return;
    }
    const auth = await this.getAuthState();
    checkIntent();
    if (auth.status !== "signed_in" || !auth.organization) {
      await this.detachRuntime();
      return;
    }
    const permissions = await probe();
    checkIntent();
    if (!hasRequiredComputerUsePermissions(permissions)) {
      this.nativeError =
        "Driver permissions are unavailable. Check host permissions and retry.";
      if (this.getPluginCapabilities().length === 0)
        throw new Error("Computer Use permissions are unavailable");
    }
    if (hasRequiredComputerUsePermissions(permissions)) this.driver?.activate();
    resume?.();
  }

  isTransitioning(): boolean {
    return (
      this.recoveryCount > 0 ||
      this.starting !== null ||
      (this.driver?.cleanupPending ?? false)
    );
  }

  /** User-initiated stop; suppresses auto-restarts until the next manual start. */
  async stop(): Promise<void> {
    this.runningRequested = false;
    this.manualStopRequested = true;
    this.supersede();
    await withComputerUseDeadline(
      this.detachRuntime(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
  }

  /** Stops admitting work, lets the active command finish, then stops. */
  async drainAndStop(): Promise<void> {
    this.runningRequested = false;
    this.manualStopRequested = true;
    this.cancelPermissionRefresh("drain");
    this.supersede();
    await this.runtime?.drainAndStop();
    await this.detachRuntime();
  }

  /**
   * Detaches and stops the runtime when the auth session changes (sign-out or
   * a completed sign-in), so a subsequent start builds a fresh runtime.
   */
  async stopForAuthChange(): Promise<void> {
    this.supersede();
    await withComputerUseDeadline(
      this.detachRuntime(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
  }

  /** Auth completion preserves manual Stop intent and cannot revive superseded work. */
  async startForAuthChange(signal: AbortSignal): Promise<void> {
    this.supersede();
    const intent = this.intent;
    await withComputerUseDeadline(
      this.detachRuntime(),
      this.transitionTimeoutMs,
      this.lifecycleTimers,
    );
    signal.throwIfAborted();
    if (intent === this.intent) await this.start({ signal });
  }

  /** Clears a stale blocked host state once required permissions are missing. */
  clearBlockedHostState(): void {
    this.blockedHostState = null;
  }

  /** True when quitting must first stop a live runtime. */
  quitStopRequired(): boolean {
    return this.runtime !== null && !this.quitStopStarted;
  }

  /**
   * Stops the runtime for app quit, bounded by the quit-stop timeout.
   * Idempotent: concurrent quit paths (before-quit, quit-and-install) share
   * one stop attempt.
   */
  stopForQuit(
    reason: ComputerUseNativeShutdownReason = "app_quit",
  ): Promise<void> {
    if (this.quitPromise) return this.quitPromise;
    this.backgroundAuthRefresh = null;
    this.quitStopStarted = true;
    this.supersede();
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) this.setHostRuntimeOnline(false);
    const stop = Promise.resolve().then(() => runtime?.stop());
    // Native disposal has its own process shutdown bound. Do not gate it on HTTP stop.
    const retirement = Promise.resolve().then(() =>
      this.driver?.retire(reason),
    );
    this.quitPromise = Promise.all([
      withComputerUseDeadline(
        stop,
        this.quitStopTimeoutMs,
        this.lifecycleTimers,
      ).catch(() => {}),
      retirement,
    ]).then(() => {});
    return this.quitPromise;
  }

  private supersede(cancelRefresh = true): void {
    if (cancelRefresh) {
      this.cancelPermissionRefresh();
    }
    this.intent++;
    this.phaseStartedAt = performance.now();
    this.starting = null;
    this.driver?.pausePermissions();
  }

  private detachRuntime(): Promise<void> {
    const intent = this.intent;
    const runtime = this.runtime;
    this.runtime = null;
    this.blockedHostState = null;
    this.setHostRuntimeOnline(false);
    const stop = runtime?.stop() ?? Promise.resolve();
    const retirement = this.driver?.forceRetire() ?? Promise.resolve();
    const cleanup = Promise.all([this.stopping, stop, retirement]).then(() => {
      if (intent === this.intent && !this.quitStopStarted)
        this.driver?.resumePermissions();
    });
    this.stopping = cleanup;
    void cleanup.then(this.onChange, this.onChange);
    return cleanup;
  }
}
