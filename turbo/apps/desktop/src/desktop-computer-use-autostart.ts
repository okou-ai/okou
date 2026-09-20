import type {
  ComputerUseHostRuntimeStatus,
  DesktopComputerUseState,
} from "./computer-use-types";

const MAIN_PROCESS_AUTO_START_STATUSES = new Set<ComputerUseHostRuntimeStatus>([
  "unauthenticated",
]);

const RECOVERY_BASE_DELAY_MS = 5_000;
const RECOVERY_DELAY_FACTOR = 3;
const RECOVERY_MAX_DELAY_MS = 15 * 60 * 1000;

/** Growing delay for attempt 1, 2, 3, ... capped at `RECOVERY_MAX_DELAY_MS`. */
function computerUseRecoveryDelayMs(attempt: number): number {
  return Math.min(
    RECOVERY_BASE_DELAY_MS * RECOVERY_DELAY_FACTOR ** Math.max(0, attempt - 1),
    RECOVERY_MAX_DELAY_MS,
  );
}

interface DesktopComputerUseAutoStartSupervisorOptions {
  readonly getState: () => DesktopComputerUseState;
  readonly start: () => Promise<void>;
  readonly logError: (error: unknown) => void;
  /**
   * False once recovery needs the user, so a paced retry cannot succeed. It
   * keeps a signed-out app from probing permissions forever.
   */
  readonly canRecover?: () => boolean;
  readonly setTimeout?: typeof setTimeout;
}

export class DesktopComputerUseAutoStartSupervisor {
  private readonly getState: () => DesktopComputerUseState;
  private readonly start: () => Promise<void>;
  private readonly logError: (error: unknown) => void;
  private readonly canRecover: () => boolean;
  private readonly scheduleTimeout: typeof setTimeout;
  private scheduled = false;
  private running = false;
  private recoveryAttempt = 0;

  constructor(options: DesktopComputerUseAutoStartSupervisorOptions) {
    this.getState = options.getState;
    this.start = options.start;
    this.logError = options.logError;
    this.canRecover = options.canRecover ?? (() => true);
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
  }

  requestStart(): void {
    this.recoveryAttempt = 0;
    this.schedule(0);
  }

  restartRecoverableRuntimeState(): void {
    if (MAIN_PROCESS_AUTO_START_STATUSES.has(this.getState().host.status)) {
      this.schedule(0);
    }
  }

  private schedule(delayMs: number): void {
    if (this.scheduled || this.running) {
      return;
    }

    this.scheduled = true;
    this.scheduleTimeout(() => {
      this.scheduled = false;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.start();
    } catch (error) {
      this.logError(error);
    } finally {
      this.running = false;
      this.scheduleRecovery();
    }
  }

  /**
   * A blocked start publishes the state change that asks for another one, so
   * its own request is dropped while this attempt runs. Owning the next try
   * here keeps recovery alive without spinning on that republished state.
   */
  private scheduleRecovery(): void {
    const status = this.getState().host.status;
    if (status === "online") {
      this.recoveryAttempt = 0;
      return;
    }
    if (!MAIN_PROCESS_AUTO_START_STATUSES.has(status) || !this.canRecover()) {
      return;
    }

    this.recoveryAttempt += 1;
    this.schedule(computerUseRecoveryDelayMs(this.recoveryAttempt));
  }
}
