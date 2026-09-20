import { stoppedOkouDriverState } from "./test/desktop-driver-state";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { Rectangle, Size } from "electron";
import type {
  ComputerUseLocalCommandLogEntry,
  ComputerUseHostRuntimeStatus,
  DesktopComputerUseState,
} from "./computer-use-types";
import type { DesktopAuthState } from "./desktop-bridge";
import { DesktopTrayController } from "./desktop-tray";

interface MockNativeImage {
  readonly path: string;
  readonly cropRect: Rectangle | null;
  readonly getSize: () => Size;
  readonly crop: (rect: Rectangle) => MockNativeImage;
  templateImage: boolean;
  readonly setTemplateImage: ReturnType<typeof vi.fn<(value: boolean) => void>>;
}

interface MockTrayInstance {
  image: MockNativeImage;
  readonly nextImage: Promise<MockNativeImage>;
  readonly setToolTip: ReturnType<typeof vi.fn<(tooltip: string) => void>>;
  readonly setContextMenu: ReturnType<typeof vi.fn<(menu: unknown) => void>>;
  readonly setImage: ReturnType<typeof vi.fn<(image: MockNativeImage) => void>>;
}

const electronMock = vi.hoisted(() => {
  const trays: MockTrayInstance[] = [];

  function createImage(
    iconPath: string,
    cropRect: Rectangle | null = null,
  ): MockNativeImage {
    const image: MockNativeImage = {
      path: iconPath,
      cropRect,
      getSize: () => ({
        width:
          cropRect?.width ?? (iconPath.endsWith("Running.png") ? 1_080 : 18),
        height: cropRect?.height ?? 18,
      }),
      crop: (rect) => createImage(iconPath, rect),
      templateImage: false,
      setTemplateImage: vi.fn<(value: boolean) => void>((value) => {
        image.templateImage = value;
      }),
    };
    return image;
  }

  class MockTray implements MockTrayInstance {
    image: MockNativeImage;
    private imageChanged: ((image: MockNativeImage) => void) | null = null;
    readonly setToolTip = vi.fn<(tooltip: string) => void>();
    readonly setContextMenu = vi.fn<(menu: unknown) => void>();
    readonly setImage = vi.fn<(image: MockNativeImage) => void>((image) => {
      this.image = image;
      this.imageChanged?.(image);
      this.imageChanged = null;
    });

    get nextImage(): Promise<MockNativeImage> {
      return new Promise((resolve) => {
        this.imageChanged = resolve;
      });
    }

    constructor(image: MockNativeImage) {
      this.image = image;
      trays.push(this);
    }
  }

  return {
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => {
        return { template };
      }),
    },
    Tray: MockTray,
    nativeImage: {
      createFromPath: vi.fn<(iconPath: string) => MockNativeImage>((iconPath) =>
        createImage(iconPath),
      ),
    },
    trays,
  };
});

vi.mock("electron", () => {
  return {
    Menu: electronMock.Menu,
    Tray: electronMock.Tray,
    nativeImage: electronMock.nativeImage,
  };
});

const originalPlatform = process.platform;
const iconPath = "/assets/tray-iconTemplate.png";
const disabledIconPath = "/assets/tray-iconDisabled.png";
const runningIconPath = "/assets/tray-iconRunning.png";

const signedInAuth: DesktopAuthState = {
  status: "signed_in",
  user: {
    userId: "user_1",
    email: "user@example.com",
  },
  organization: {
    id: "org_1",
    name: "Max & Zoe",
  },
};

interface ComputerUseStateOptions {
  readonly runningCommand?: boolean;
}

function runningLocalCommandLogEntry(): ComputerUseLocalCommandLogEntry {
  return {
    commandId: "cmd_1",
    kind: "app.state",
    app: null,
    status: "running",
    payload: {},
    result: null,
    error: null,
    startedAt: "2026-06-17T00:00:00.000Z",
    completedAt: null,
    durationMs: null,
  };
}

function computerUseState(
  status: ComputerUseHostRuntimeStatus,
  options: ComputerUseStateOptions = {},
): DesktopComputerUseState {
  return {
    driver: stoppedOkouDriverState,
    platform: "darwin",
    supported: true,
    permissions: {
      accessibility: true,
      screenRecording: true,
    },
    host: {
      status,
      hostId: status === "online" ? "host_1" : null,
      lastHeartbeatAt: null,
      lastCommandAt: null,
      lastError: null,
      recovery: null,
      errorLog: [],
      localCommandLog: options.runningCommand
        ? [runningLocalCommandLogEntry()]
        : [],
    },
    keepAwake: {
      enabled: false,
      active: false,
    },
  };
}

function installController(getState: () => DesktopComputerUseState) {
  let active = true;
  const controller = new DesktopTrayController({
    displayName: "Okou",
    iconPath,
    disabledIconPath,
    runningIconPath,
    getComputerUseState: () =>
      active ? getState() : computerUseState("offline"),
    getAuthState: async () => signedInAuth,
    showMainWindow: vi.fn(async () => {}),
    startComputerUse: vi.fn(async () => {}),
    stopComputerUse: vi.fn(async () => {}),
    refreshStatus: vi.fn(async () => {}),
    openSignIn: vi.fn(),
    switchWorkspace: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    requestAccessibilityPermission: vi.fn(async () => {}),
    requestScreenRecordingPermission: vi.fn(async () => {}),
    openAccessibilitySettings: vi.fn(),
    openScreenRecordingSettings: vi.fn(),
    setKeepAwakeEnabled: vi.fn(async () => {}),
    quit: vi.fn(),
  });
  onTestFinished(() => {
    active = false;
    controller.refresh();
  });
  controller.install();
  return controller;
}

function installedTray(): MockTrayInstance {
  const tray = electronMock.trays[0];
  if (!tray) {
    throw new Error("Expected a desktop tray to be installed");
  }
  return tray;
}

describe("desktop tray", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    electronMock.trays.length = 0;
    electronMock.Menu.buildFromTemplate.mockClear();
    electronMock.nativeImage.createFromPath.mockClear();
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it.each<ComputerUseHostRuntimeStatus>([
    "offline",
    "connecting",
    "recovering",
    "unauthenticated",
    "needs_organization",
    "disabled",
    "error",
  ])("uses the disabled tray icon while Computer Use is %s", (status) => {
    installController(() => computerUseState(status));

    const tray = installedTray();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.image.templateImage).toBe(false);
  });

  it("uses the template tray icon while Computer Use is online", () => {
    installController(() => computerUseState("online"));

    const tray = installedTray();

    expect(tray.image.path).toBe(iconPath);
    expect(tray.image.templateImage).toBe(true);
  });

  it("updates the tray icon when Computer Use moves online or offline", () => {
    let status: ComputerUseHostRuntimeStatus = "offline";
    const controller = installController(() => computerUseState(status));
    const tray = installedTray();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.setImage).not.toHaveBeenCalled();

    status = "online";
    controller.refresh();

    expect(tray.image.path).toBe(iconPath);
    expect(tray.image.templateImage).toBe(true);
    expect(tray.setImage).toHaveBeenCalledTimes(1);

    status = "error";
    controller.refresh();

    expect(tray.image.path).toBe(disabledIconPath);
    expect(tray.image.templateImage).toBe(false);
    expect(tray.setImage).toHaveBeenCalledTimes(2);
  });

  it("cycles orange rotation frames while a local Computer Use command is running", async () => {
    let status: ComputerUseHostRuntimeStatus = "online";
    const controller = installController(() =>
      computerUseState(status, { runningCommand: true }),
    );
    const tray = installedTray();
    const initialImage = tray.image;

    expect(tray.image.path).toBe(runningIconPath);
    expect(tray.image.cropRect).toEqual({
      x: 0,
      y: 0,
      width: 18,
      height: 18,
    });
    expect(tray.image.templateImage).toBe(false);

    for (let index = 1; index < 60; index += 1) {
      const image = await tray.nextImage;

      expect(image.path).toBe(runningIconPath);
      expect(image.cropRect).toEqual({
        x: index * 18,
        y: 0,
        width: 18,
        height: 18,
      });
      expect(image.templateImage).toBe(false);
    }

    expect(await tray.nextImage).toBe(initialImage);

    status = "offline";
    controller.refresh();

    expect(tray.image.path).toBe(disabledIconPath);

    status = "online";
    controller.refresh();

    expect(tray.image).toBe(initialImage);
    expect((await tray.nextImage).cropRect).toEqual({
      x: 18,
      y: 0,
      width: 18,
      height: 18,
    });

    status = "offline";
    controller.refresh();
  });

  it("keeps animating during the command gap window", async () => {
    let runningCommand = true;
    const startedAt = Date.now();
    const controller = installController(() =>
      computerUseState("online", { runningCommand }),
    );
    const tray = installedTray();

    runningCommand = false;
    controller.refresh();

    expect(tray.image.path).toBe(runningIconPath);

    let image = tray.image;
    while (image.path === runningIconPath) {
      expect(image.templateImage).toBe(false);
      image = await tray.nextImage;
    }

    expect(image.path).toBe(iconPath);
    expect(image.templateImage).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15_000);
  }, 20_000); // Exercise the production 15-second linger with real timers.
});
