import type { ComputerUsePermissionProvider } from "./computer-use-permissions";
import type { ComputerUseCommandBudget } from "./computer-use-command-budget";
import { createComputerUseDrain } from "./computer-use-lifecycle-deadline";
import {
  SUPPORTED_COMPUTER_USE_CAPABILITIES,
  ComputerUseSnapshotStore,
  executeComputerUseCommand,
  type ComputerUseCommand,
  type ComputerUseCommandExecutionResult,
} from "./computer-use-accessibility";
import type {
  ComputerUseNativeBackend,
  ComputerUseNativeShutdownReason,
} from "./computer-use-native";
import {
  hasRequiredComputerUsePermissions,
  type ComputerUsePermissionState,
  type ComputerUseExecutionIdentity,
} from "./computer-use-types";

export interface ComputerUseDriver {
  readonly id: "okou";
  readonly buildVersion?: string;
  readonly createBackend: () => ComputerUseNativeBackend;
}

interface DriverGeneration {
  readonly driver: ComputerUseDriver;
  readonly generation: number;
  readonly backend: ComputerUseNativeBackend;
  readonly snapshots: ComputerUseSnapshotStore;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
  leases: number;
  disposal: Promise<void> | null;
  permissionsReady: boolean;
  permissionRead: Promise<ComputerUsePermissionState> | null;
}

export interface ComputerUseCommandSession {
  readonly identity?: ComputerUseExecutionIdentity;
  beginCommand?(budget: ComputerUseCommandBudget): void;
  getPermissions(
    command?: ComputerUseCommand,
  ): Promise<ComputerUsePermissionState>;
  abort?(): void;
  executeCommand(
    command: ComputerUseCommand,
    permissions: ComputerUsePermissionState,
  ): Promise<ComputerUseCommandExecutionResult>;
  release(): void;
}

/** Owns native resources, including passive permission probes, for one generation. */
export class ComputerUseDriverController {
  private context: DriverGeneration | null = null;
  private retirement: Promise<void> | null = null;
  private retiringContext: DriverGeneration | null = null;
  private nextGeneration = 0;
  private active = false;
  private permissionsPaused = false;
  private closed = false;
  private failure: string | null = null;

  constructor(
    private readonly driver: ComputerUseDriver,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly onChange: () => void = () => {},
  ) {}

  get generation(): number | null {
    return this.context?.generation ?? null;
  }

  get cleanupPending(): boolean {
    return (
      this.retirement !== null ||
      (this.context?.backend.isCleanupPending?.() ?? false)
    );
  }

  getState() {
    const context = this.context ?? this.retiringContext;
    const ready = this.getCapabilities().length > 0;
    return {
      actual: context ? this.identity(context, ready) : null,
      ready,
      cleanupPending: this.cleanupPending,
      error:
        this.failure ??
        (this.context &&
        this.active &&
        this.context.backend.isAvailable?.() === false
          ? "Native driver became unavailable. Retry after cleanup."
          : null),
    };
  }

  resetFailure(): void {
    this.failure = null;
  }

  private identity(
    context: DriverGeneration,
    ready: boolean,
  ): ComputerUseExecutionIdentity {
    return {
      id: context.driver.id,
      generation: context.generation,
      version: ready ? (context.driver.buildVersion ?? null) : null,
    };
  }

  /** Synchronous withdrawal; claimed work cannot admit a new native action. */
  withdrawAdmission(): void {
    this.active = false;
    this.permissionsPaused = true;
    this.context?.snapshots.clear();
    this.onChange();
  }

  private prepare(): DriverGeneration {
    if (this.closed || this.retirement) {
      throw new Error("Computer Use driver retirement is not complete");
    }
    if (!this.context) {
      const { promise, resolve } = createComputerUseDrain();
      this.context = {
        driver: this.driver,
        generation: ++this.nextGeneration,
        backend: this.driver.createBackend(),
        snapshots: new ComputerUseSnapshotStore(),
        drained: promise,
        resolveDrained: resolve,
        leases: 0,
        disposal: null,
        permissionsReady: false,
        permissionRead: null,
      };
      this.onChange();
    }
    return this.context;
  }

  activate(): void {
    this.prepare();
    this.active = true;
    this.permissionsPaused = false;
    this.onChange();
  }

  pausePermissions(): void {
    this.permissionsPaused = true;
  }

  async withPermissionProvider<T>(
    read: (provider: ComputerUsePermissionProvider) => Promise<T>,
  ): Promise<T | null> {
    if (this.closed || this.retirement || this.permissionsPaused) return null;
    // Creating the native helper's probe context does not admit commands.
    const context = this.prepare();
    const release = this.lease(context);
    try {
      const result = await read({
        ...context.backend,
        getPermissions: () => this.readPermissions(context),
      });
      return this.context === context && !this.permissionsPaused
        ? result
        : null;
    } finally {
      release();
    }
  }

  acquireCommand(): ComputerUseCommandSession {
    const context = this.context;
    if (!this.active || !context || context.backend.isAvailable?.() === false) {
      throw new Error("Computer Use driver is not ready");
    }
    const release = this.lease(context);
    return {
      identity: this.identity(context, true),
      beginCommand: (budget) => context.backend.setCommandBudget?.(budget),
      abort: () => {
        void this.forceRetire().catch(() => {});
      },
      getPermissions: () => this.readPermissions(context),
      executeCommand: async (command, permissions) => {
        if (
          this.context !== context ||
          !this.active ||
          context.backend.isAvailable?.() === false
        )
          return {
            status: "failed",
            error: {
              code: "accessibility_unavailable",
              message:
                "Native generation is retired; re-observe after explicit recovery",
            },
          };
        const { app, snapshotId } = command.payload;
        if (
          typeof app === "string" &&
          typeof snapshotId === "string" &&
          !context.snapshots.get(app, snapshotId)
        ) {
          return {
            status: "failed",
            error: {
              code: "unsupported_command",
              message: `Snapshot not found for ${app}: ${snapshotId}`,
            },
          };
        }
        return executeComputerUseCommand(command, permissions, {
          nativeBackend: context.backend,
          snapshotStore: context.snapshots,
          platform: this.platform,
        });
      },
      release: () => {
        context.backend.setCommandBudget?.(null);
        release();
      },
    };
  }

  getCapabilities(): readonly string[] {
    const context = this.context;
    return this.active &&
      context?.permissionsReady &&
      context.backend.isAvailable?.() !== false
      ? SUPPORTED_COMPUTER_USE_CAPABILITIES
      : [];
  }

  private readPermissions(
    context: DriverGeneration,
  ): Promise<ComputerUsePermissionState> {
    if (context.permissionRead) return context.permissionRead;
    const read = this.readGenerationPermissions(context);
    context.permissionRead = read;
    const finish = () => {
      if (context.permissionRead === read) context.permissionRead = null;
    };
    void read.then(finish, finish);
    return read;
  }

  private async readGenerationPermissions(
    context: DriverGeneration,
  ): Promise<ComputerUsePermissionState> {
    try {
      const permissions = await context.backend.getPermissions();
      context.permissionsReady =
        this.context === context &&
        hasRequiredComputerUsePermissions(permissions);
      if (!context.permissionsReady && this.active) {
        this.failure =
          "Native permissions were withdrawn. Explicit recovery is required.";
        void this.forceRetire().catch(() => {});
      }
      this.onChange();
      return permissions;
    } catch (error) {
      context.permissionsReady = false;
      if (this.context === context) {
        this.failure =
          "Native driver permission check failed. Explicit recovery is required.";
        void this.forceRetire().catch(() => {});
      }
      throw error;
    }
  }

  forceRetire(): Promise<void> {
    const context = this.context ?? this.retiringContext;
    if (context?.backend.forceStop) {
      this.active = false;
      context.snapshots.clear();
      context.disposal ??= Promise.resolve().then(() =>
        context.backend.forceStop?.(),
      );
      // Observe a bounded cleanup rejection even while an old lease is hung.
      // Keep the original rejected promise as the replacement gate.
      void context.disposal.catch(() => {});
    }
    return this.retire();
  }

  private lease(context: DriverGeneration): () => void {
    context.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      context.leases--;
      if (this.context !== context && context.leases === 0) {
        context.resolveDrained();
      }
    };
  }

  retire(reason: ComputerUseNativeShutdownReason = "dispose"): Promise<void> {
    this.active = false;
    this.permissionsPaused = true;
    if (reason !== "dispose") this.closed = true;
    if (this.retirement) {
      if (reason !== "dispose" && this.retiringContext) {
        return this.dispose(this.retiringContext, reason);
      }
      return this.retirement;
    }
    const context = this.context;
    this.context = null;
    if (!context) return Promise.resolve();
    this.retiringContext = context;
    if (context.leases === 0) context.resolveDrained();
    const retirement = Promise.resolve().then(async () => {
      // Quit may terminate native work; a healthy replacement must drain it.
      if (reason === "dispose") await context.drained;
      await this.dispose(context, reason);
    });
    this.retirement = retirement;
    this.onChange();
    void retirement.then(
      () => {
        if (this.retirement === retirement) {
          this.retirement = null;
          this.retiringContext = null;
          this.onChange();
        }
      },
      () => {
        // Keep failed cleanup owned. A retry must not overlap the old backend.
      },
    );
    return retirement;
  }

  private dispose(
    context: DriverGeneration,
    reason: ComputerUseNativeShutdownReason,
  ): Promise<void> {
    context.disposal ??= Promise.resolve()
      .then(() => context.backend.dispose(reason))
      .then(() => {
        context.snapshots.clear();
      });
    return context.disposal;
  }

  resumePermissions(): void {
    if (!this.closed && !this.retirement) this.permissionsPaused = false;
  }
}
