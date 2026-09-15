import type { DesktopDeveloperToolsState } from "./desktop-bridge";
import { latestWinsSingleFlight } from "./desktop-async-control";

const OKOU_DEBUG_FEATURE_SWITCH_KEY = "_debug";
const COMPUTER_USE_DESKTOP_PLUGINS_FEATURE_SWITCH_KEY =
  "computerUseDesktopPlugins";
const INTRO_VIDEO_FEATURE_SWITCH_KEY = "introVideo";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function featureSwitchEnabledFromBody(value: unknown, key: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (isRecord(value.effectiveSwitches)) {
    return value.effectiveSwitches[key] === true;
  }
  if (isRecord(value.switches)) {
    return value.switches[key] === true;
  }
  return false;
}

interface DeveloperToolsControllerOptions {
  readonly getSessionAuthority: () => object | null;
  /**
   * Session-authenticated fetch of the feature-switches endpoint
   * (`getAuthSession().fetchWithSessionAuth(...)` in production).
   */
  readonly fetchFeatureSwitches: () => Promise<Response>;
  /** Propagates the `computerUseDesktopPlugins` switch to the plugin manager. */
  readonly setFilesystemPluginFeatureEnabled: (enabled: boolean) => void;
  /**
   * Propagates the `introVideo` switch to the recorder. Turning it off must
   * release the native helper, not just hide the entry point.
   */
  readonly setScreenRecordingFeatureEnabled: (enabled: boolean) => void;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  /** Called when a refresh fails; availability is reset to false first. */
  readonly logRefreshError?: (error: unknown) => void;
}

/**
 * Owns desktop developer-tools availability/enabled state and the coalesced
 * feature-switch refresh, extracted from `main.ts` and kept free of Electron
 * imports so it can be integration-tested by injecting fakes, mirroring the
 * `DesktopAuthSession` dependency-injection shape.
 */
export class DeveloperToolsController {
  private readonly fetchFeatureSwitches: () => Promise<Response>;
  private readonly setFilesystemPluginFeatureEnabled: (
    enabled: boolean,
  ) => void;
  private readonly setScreenRecordingFeatureEnabled: (enabled: boolean) => void;
  private readonly onChange: () => void;
  private readonly logRefreshError: (error: unknown) => void;

  private available = false;
  private enabled = false;
  private revision = 0;
  private readonly refresh = latestWinsSingleFlight(
    () => this.refreshAvailability(),
    {
      onError: (error) => {
        this.logRefreshError(error);
      },
    },
  );

  constructor(private readonly options: DeveloperToolsControllerOptions) {
    this.fetchFeatureSwitches = options.fetchFeatureSwitches;
    this.setFilesystemPluginFeatureEnabled =
      options.setFilesystemPluginFeatureEnabled;
    this.setScreenRecordingFeatureEnabled =
      options.setScreenRecordingFeatureEnabled;
    this.onChange = options.onChange ?? (() => {});
    this.logRefreshError = options.logRefreshError ?? (() => {});
  }

  getState(): DesktopDeveloperToolsState {
    return {
      available: this.available,
      enabled: this.available && this.enabled,
    };
  }

  setEnabled(enabled: boolean): DesktopDeveloperToolsState {
    const nextEnabled = this.available && enabled;
    if (this.enabled !== nextEnabled) {
      this.enabled = nextEnabled;
      this.onChange();
    }
    return this.getState();
  }

  /**
   * Refreshes availability from the feature-switch endpoint. Concurrent
   * requests coalesce onto the in-flight refresh and trigger exactly one
   * follow-up refresh once it settles.
   */
  requestRefresh(): void {
    this.revision++;
    // Withdrawal is synchronous; no old response can authorize a new session.
    this.available = false;
    // Keep the independent panel preference across a same-session refresh;
    // an actual denial below clears it.
    this.onChange();
    this.refresh();
  }

  private setAvailability(available: boolean): void {
    const nextEnabled = available ? this.enabled : false;
    if (this.available === available && this.enabled === nextEnabled) {
      return;
    }
    this.available = available;
    this.enabled = nextEnabled;
    this.onChange();
  }

  private async refreshAvailability(): Promise<void> {
    const revision = this.revision;
    const session = this.options.getSessionAuthority();
    const current = () =>
      revision === this.revision &&
      session === this.options.getSessionAuthority();
    try {
      const response = await this.fetchFeatureSwitches();
      if (!current()) return;
      if (response.status === 401) {
        this.setAvailability(false);
        this.setFilesystemPluginFeatureEnabled(false);
        this.setScreenRecordingFeatureEnabled(false);
        this.onChange();
        return;
      }
      if (!response.ok) {
        throw new Error(
          `Desktop developer tools feature switch failed: ${response.status}`,
        );
      }
      const body: unknown = await response.json();
      if (!current()) return;
      this.setAvailability(
        session !== null &&
          featureSwitchEnabledFromBody(body, OKOU_DEBUG_FEATURE_SWITCH_KEY),
      );
      this.setFilesystemPluginFeatureEnabled(
        featureSwitchEnabledFromBody(
          body,
          COMPUTER_USE_DESKTOP_PLUGINS_FEATURE_SWITCH_KEY,
        ),
      );
      this.setScreenRecordingFeatureEnabled(
        featureSwitchEnabledFromBody(body, INTRO_VIDEO_FEATURE_SWITCH_KEY),
      );
      this.onChange();
    } catch (error) {
      if (!current()) return;
      this.setAvailability(false);
      this.setFilesystemPluginFeatureEnabled(false);
      this.setScreenRecordingFeatureEnabled(false);
      this.onChange();
      throw error;
    }
  }
}
