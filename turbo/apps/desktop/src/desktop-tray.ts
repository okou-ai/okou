import {
  Menu,
  Tray,
  nativeImage,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import type { DesktopAuthState } from "./desktop-bridge";
import type { DesktopComputerUseState } from "./computer-use-types";
import {
  buildDesktopTrayMenuItems,
  type DesktopTrayMenuActions,
  type DesktopTrayMenuItem,
} from "./desktop-tray-menu";
import { latestWinsGuard } from "./desktop-async-control";

interface DesktopTrayControllerOptions {
  readonly displayName: string;
  readonly iconPath: string;
  readonly disabledIconPath: string;
  readonly runningIconPath: string;
  readonly getComputerUseState: () => DesktopComputerUseState;
  readonly getAuthState: () => Promise<DesktopAuthState>;
  readonly showMainWindow: () => Promise<void>;
  readonly startComputerUse: () => Promise<void>;
  readonly stopComputerUse: () => Promise<void>;
  readonly refreshStatus: () => Promise<void>;
  readonly openSignIn: () => void;
  readonly switchWorkspace: () => Promise<void>;
  readonly signOut: () => Promise<void>;
  readonly requestAccessibilityPermission: () => Promise<void>;
  readonly requestScreenRecordingPermission: () => Promise<void>;
  readonly openAccessibilitySettings: () => void;
  readonly openScreenRecordingSettings: () => void;
  readonly setKeepAwakeEnabled: (enabled: boolean) => Promise<void>;
  readonly quit: () => void;
}

type DesktopTrayIconFrame = "disabled" | "online" | "running" | number;
type DesktopTrayIconMode = "disabled" | "online" | "running";

const RUNNING_TRAY_ICON_FRAME_MS = 50;
const RUNNING_TRAY_ACTIVITY_LINGER_MS = 15_000;

function desktopTrayIcon(
  iconPath: string,
  options: { readonly template: boolean },
): NativeImage {
  const image = nativeImage.createFromPath(iconPath);
  if (options.template && process.platform === "darwin") {
    image.setTemplateImage(true);
  }
  return image;
}

function hasRunningLocalCommand(state: DesktopComputerUseState): boolean {
  return state.host.localCommandLog.some((entry) => {
    return entry.status === "running";
  });
}

function electronMenuItem(
  item: DesktopTrayMenuItem,
): MenuItemConstructorOptions {
  const template: MenuItemConstructorOptions = {};
  if (item.type) {
    template.type = item.type;
  }
  if (item.label) {
    template.label = item.label;
  }
  if (item.enabled !== undefined) {
    template.enabled = item.enabled;
  }
  if (item.checked !== undefined) {
    template.checked = item.checked;
  }
  if (item.click) {
    template.click = item.click;
  }
  if (item.submenu) {
    template.submenu = item.submenu.map(electronMenuItem);
  }
  return template;
}

function electronMenuTemplate(
  items: readonly DesktopTrayMenuItem[],
): MenuItemConstructorOptions[] {
  return items.map(electronMenuItem);
}

export class DesktopTrayController {
  private readonly options: DesktopTrayControllerOptions;
  private tray: Tray | null = null;
  private authState: DesktopAuthState | null = null;
  private authLoading = true;
  private authError: string | null = null;
  private readonly nextAuthRefresh = latestWinsGuard();
  private iconFrame: DesktopTrayIconFrame | null = null;
  private readonly iconCache = new Map<DesktopTrayIconFrame, NativeImage>();
  private runningActivityUntilMs: number | null = null;
  private runningIconFrameIndex = 0;
  private runningIconTimer: ReturnType<typeof setInterval> | null = null;
  private menuSignature: string | null = null;

  constructor(options: DesktopTrayControllerOptions) {
    this.options = options;
  }

  install(): void {
    if (this.tray) {
      return;
    }

    const computerUseState = this.options.getComputerUseState();
    const iconMode = this.iconModeForComputerUseState(computerUseState);
    const iconFrame =
      iconMode === "running" ? this.runningTrayIconFrameAt(0) : iconMode;
    this.tray = new Tray(this.iconForFrame(iconFrame));
    this.iconFrame = iconFrame;
    this.tray.setToolTip(this.options.displayName);
    this.refresh();
    this.refreshAuth();
  }

  refresh(): void {
    const tray = this.tray;
    if (!tray) {
      return;
    }

    const actions = this.menuActions();
    const computerUseState = this.options.getComputerUseState();
    this.refreshIcon(tray, computerUseState);
    const items = buildDesktopTrayMenuItems(
      {
        computerUse: computerUseState,
        auth: this.authState,
        authLoading: this.authLoading,
        authError: this.authError,
      },
      actions,
    );
    const signature = JSON.stringify(items, (_key, value: unknown) => {
      return typeof value === "function" ? "[function]" : value;
    });
    if (signature === this.menuSignature) {
      return;
    }
    this.menuSignature = signature;
    tray.setContextMenu(Menu.buildFromTemplate(electronMenuTemplate(items)));
  }

  private iconForFrame(frame: DesktopTrayIconFrame): NativeImage {
    const cached = this.iconCache.get(frame);
    if (cached) {
      return cached;
    }

    const image =
      typeof frame === "number"
        ? this.runningIconFrame(frame)
        : desktopTrayIcon(this.iconPathForFrame(frame), {
            template: frame === "online",
          });
    this.iconCache.set(frame, image);
    return image;
  }

  private runningIconFrame(index: number): NativeImage {
    const strip = this.iconForFrame("running");
    const size = strip.getSize().height;
    return strip.crop({ x: index * size, y: 0, width: size, height: size });
  }

  private runningTrayIconFrameAt(index: number): DesktopTrayIconFrame {
    const { width, height } = this.iconForFrame("running").getSize();
    return index % (width / height);
  }

  private iconPathForFrame(
    frame: Exclude<DesktopTrayIconFrame, number>,
  ): string {
    switch (frame) {
      case "disabled":
        return this.options.disabledIconPath;
      case "online":
        return this.options.iconPath;
      case "running":
        return this.options.runningIconPath;
    }
  }

  private iconModeForComputerUseState(
    state: DesktopComputerUseState,
  ): DesktopTrayIconMode {
    if (state.host.status !== "online") {
      this.runningActivityUntilMs = null;
      return "disabled";
    }

    if (hasRunningLocalCommand(state)) {
      this.runningActivityUntilMs =
        Date.now() + RUNNING_TRAY_ACTIVITY_LINGER_MS;
      return "running";
    }

    if (
      this.runningActivityUntilMs !== null &&
      Date.now() < this.runningActivityUntilMs
    ) {
      return "running";
    }

    this.runningActivityUntilMs = null;
    return "online";
  }

  private refreshIcon(
    tray: Tray,
    computerUseState: DesktopComputerUseState,
  ): void {
    const iconMode = this.iconModeForComputerUseState(computerUseState);
    if (iconMode === "running") {
      this.startRunningIconAnimation(tray);
      return;
    }

    this.stopRunningIconAnimation();
    this.setTrayIconFrame(tray, iconMode);
  }

  private startRunningIconAnimation(tray: Tray): void {
    if (this.runningIconTimer) {
      return;
    }

    this.runningIconFrameIndex = 0;
    this.setTrayIconFrame(tray, this.runningTrayIconFrameAt(0));
    this.runningIconTimer = setInterval(() => {
      const iconMode = this.iconModeForComputerUseState(
        this.options.getComputerUseState(),
      );
      if (iconMode !== "running") {
        this.stopRunningIconAnimation();
        this.setTrayIconFrame(tray, iconMode);
        return;
      }

      this.runningIconFrameIndex += 1;
      this.setTrayIconFrame(
        tray,
        this.runningTrayIconFrameAt(this.runningIconFrameIndex),
      );
    }, RUNNING_TRAY_ICON_FRAME_MS);
  }

  private stopRunningIconAnimation(): void {
    const timer = this.runningIconTimer;
    if (!timer) {
      return;
    }

    clearInterval(timer);
    this.runningIconTimer = null;
  }

  private setTrayIconFrame(tray: Tray, frame: DesktopTrayIconFrame): void {
    if (frame === this.iconFrame) {
      return;
    }

    this.iconFrame = frame;
    tray.setImage(this.iconForFrame(frame));
  }

  refreshAuth(): void {
    const refresh = this.nextAuthRefresh();
    this.authLoading = true;
    this.refresh();
    void this.options
      .getAuthState()
      .then((authState) => {
        if (!refresh.isCurrent()) {
          return;
        }
        this.authState = authState;
        this.authLoading = false;
        this.authError = null;
        this.refresh();
      })
      .catch((error: unknown) => {
        if (!refresh.isCurrent()) {
          return;
        }
        this.authError = error instanceof Error ? error.message : String(error);
        this.authState = null;
        this.authLoading = false;
        this.refresh();
      });
  }

  private menuActions(): DesktopTrayMenuActions {
    return {
      showMainWindow: this.runAction("show main window", () => {
        return this.options.showMainWindow();
      }),
      startComputerUse: this.runAction("start Computer Use", () => {
        return this.options.startComputerUse();
      }),
      stopComputerUse: this.runAction("stop Computer Use", () => {
        return this.options.stopComputerUse();
      }),
      refreshStatus: this.runAction(
        "refresh status",
        async () => {
          await this.options.refreshStatus();
        },
        { refreshAuth: true },
      ),
      openSignIn: this.runAction(
        "open sign in",
        () => {
          this.options.openSignIn();
        },
        { refreshAuth: true },
      ),
      switchWorkspace: this.runAction(
        "switch workspace",
        () => {
          return this.options.switchWorkspace();
        },
        { refreshAuth: true },
      ),
      signOut: this.runAction(
        "sign out",
        () => {
          return this.options.signOut();
        },
        { refreshAuth: true },
      ),
      requestAccessibilityPermission: this.runAction(
        "request Accessibility permission",
        () => {
          return this.options.requestAccessibilityPermission();
        },
      ),
      requestScreenRecordingPermission: this.runAction(
        "request Screen Recording permission",
        () => {
          return this.options.requestScreenRecordingPermission();
        },
      ),
      openAccessibilitySettings: this.runAction(
        "open Accessibility Settings",
        () => {
          this.options.openAccessibilitySettings();
        },
      ),
      openScreenRecordingSettings: this.runAction(
        "open Screen Recording Settings",
        () => {
          this.options.openScreenRecordingSettings();
        },
      ),
      setKeepAwakeEnabled: (enabled) => {
        this.runAction("set keep-awake enabled", () => {
          return this.options.setKeepAwakeEnabled(enabled);
        })();
      },
      quit: () => {
        this.options.quit();
      },
    };
  }

  private runAction(
    label: string,
    action: () => Promise<void> | void,
    options: { readonly refreshAuth?: boolean } = {},
  ): () => void {
    return () => {
      void Promise.resolve()
        .then(action)
        .catch((error: unknown) => {
          console.error("Desktop tray action failed", label, error);
        })
        .finally(() => {
          if (options.refreshAuth) {
            this.refreshAuth();
            return;
          }
          this.refresh();
        });
    };
  }
}

export function installDesktopTray(
  options: DesktopTrayControllerOptions,
): DesktopTrayController {
  const controller = new DesktopTrayController(options);
  controller.install();
  return controller;
}
