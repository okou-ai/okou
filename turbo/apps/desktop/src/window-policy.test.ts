import { describe, expect, it, vi } from "vitest";
import {
  ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
  ComputerUseSnapshotStore,
  type ComputerUseCoordinateBounds,
  executeComputerUseCommand,
  normalizeAccessibilitySnapshot,
  renderAccessibilityTree,
} from "./computer-use-accessibility";
import {
  ComputerUseNativeHelperError,
  resolveComputerUseHelperPath,
  type ComputerUseNativeBackend,
} from "./computer-use-native";
import {
  buildComputerUseRuntimeBody,
  resolveComputerUseApiBaseUrl,
} from "./computer-use-host";
import { resolveDesktopConfig } from "./config";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthStartUrl,
  buildDesktopAuthTokenUrl,
  createDesktopAuthStartGate,
  isDesktopAuthCompletionNavigation,
  isDesktopAuthSelectOrgNavigation,
  isDesktopAuthStartNavigation,
  isElectronNavigationAborted,
  parseDesktopAuthCallbackArgv,
  parseDesktopAuthCallback,
} from "./desktop-auth";
import { decideWindowOpen, isAllowedAppNavigation } from "./window-policy";

function nativeDispatchResult(
  dispatchMode: string,
  dispatchTarget: string,
  inputRisk: string,
): Record<string, unknown> {
  return { dispatchMode, dispatchTarget, inputRisk };
}

function createNativeBackend(
  overrides: Partial<ComputerUseNativeBackend> = {},
): ComputerUseNativeBackend {
  const defaults: ComputerUseNativeBackend = {
    dispose: async () => {},
    getPermissions: async () => {
      return { accessibility: true, screenRecording: true };
    },
    requestAccessibilityPermission: async () => {
      return { accessibility: true, screenRecording: true };
    },
    requestScreenRecordingPermission: async () => {
      return { accessibility: true, screenRecording: true };
    },
    probeAutomationPermission: async () => {
      return {
        status: "unknown",
        updatedAt: null,
        reason: null,
      };
    },
    listApps: async () => [],
    getAppState: async (app, snapshotId) => {
      return { app, snapshotId, elements: [] };
    },
    openApp: async () => {
      return nativeDispatchResult(
        "background_app_open",
        "target_app",
        "background_app_launch",
      );
    },
    clickElement: async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    },
    clickPoint: async (args) => {
      return {
        ...nativeDispatchResult(
          "background_mouse_event",
          "app_process",
          "background_app_pointer",
        ),
        screenX: args.x,
        screenY: args.y,
      };
    },
    setElementValue: async () => {
      return nativeDispatchResult(
        "accessibility_value",
        "element",
        "targeted_app_text",
      );
    },
    performElementAction: async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    },
    typeText: async () => {
      return nativeDispatchResult(
        "accessibility_value",
        "focused_editable_element",
        "targeted_app_text",
      );
    },
    pressKey: async (args) => {
      return {
        ...nativeDispatchResult(
          "background_keyboard_event",
          "app_process",
          "background_app_shortcut",
        ),
        normalizedKey: args.key,
      };
    },
    scrollElement: async () => {
      return nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      );
    },
  };
  return { ...defaults, ...overrides };
}

interface NativeScreenshotFields {
  readonly screenshot: string;
  readonly screenshotMimeType: string;
  readonly screenshotSource: "window";
  readonly screenshotSourceName: string;
  readonly screenshotWidth: number;
  readonly screenshotHeight: number;
  readonly screenshotSourceBounds: ComputerUseCoordinateBounds;
  readonly windowId: number;
  readonly windowFrame: ComputerUseCoordinateBounds;
}

function nativeScreenshotFields(
  overrides: Partial<NativeScreenshotFields> = {},
): NativeScreenshotFields {
  const sourceBounds =
    overrides.screenshotSourceBounds ??
    overrides.windowFrame ??
    ({
      x: 100,
      y: 200,
      width: 800,
      height: 600,
    } satisfies ComputerUseCoordinateBounds);
  return {
    screenshot: "data:image/png;base64,abc123",
    screenshotMimeType: "image/png",
    screenshotSource: "window",
    screenshotSourceName: "Example",
    screenshotWidth: 800,
    screenshotHeight: 600,
    screenshotSourceBounds: sourceBounds,
    windowId: 123,
    windowFrame: sourceBounds,
    ...overrides,
  };
}

function nativeAppStateWithScreenshot(
  app: string,
  snapshotId: string,
  sourceName = "Example",
) {
  return {
    app,
    snapshotId,
    ...nativeScreenshotFields({ screenshotSourceName: sourceName }),
    elements: [],
  };
}

describe("resolveDesktopConfig", () => {
  it("defaults to production", () => {
    const config = resolveDesktopConfig("");

    expect(config.platformUrl.toString()).toBe("https://app.okou.ai/");
    expect(config.webUrl.toString()).toBe("https://www.okou.ai/");
    expect(config.environment).toBe("production");
    expect(config.identity).toMatchObject({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou",
      userDataDirectoryName: "Okou",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop",
      authScheme: "ai.okou.desktop",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-production");
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "https://api.okou.ai",
      "https://app.okou.ai",
      "https://www.okou.ai",
    ]);
  });

  it("recognizes staging", () => {
    const config = resolveDesktopConfig("https://staging-app.omby.ai/");

    expect(config.environment).toBe("staging");
    expect(config.webUrl.toString()).toBe("https://staging-www.omby.ai/");
    expect(config.identity).toMatchObject({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou Dev",
      userDataDirectoryName: "Okou Dev",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop.dev",
      authScheme: "ai.okou.desktop.dev",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-staging");
    expect(config.allowedAppOrigins.has("https://staging-app.omby.ai")).toBe(
      true,
    );
    expect(config.allowedAppOrigins.has("https://staging-www.omby.ai")).toBe(
      true,
    );
    expect(config.allowedAppOrigins.has("https://staging-api.vm6.ai")).toBe(
      true,
    );
  });

  it("treats custom app hostnames as development", () => {
    const config = resolveDesktopConfig("https://app.vm7.ai:8443/");

    expect(config.environment).toBe("development");
    expect(config.webUrl.toString()).toBe("https://www.vm7.ai:8443/");
    expect(config.identity).toMatchObject({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou Dev",
      userDataDirectoryName: "Okou Dev",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop.dev",
      authScheme: "ai.okou.desktop.dev",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-development");
    expect(config.allowedAppOrigins.has("https://app.vm7.ai:8443")).toBe(true);
    expect(config.allowedAppOrigins.has("https://www.vm7.ai:8443")).toBe(true);
    expect(config.allowedAppOrigins.has("https://api.vm7.ai:8443")).toBe(true);
  });

  it("derives matching origins for PR preview hostnames", () => {
    const config = resolveDesktopConfig("https://pr-123-app.omby.ai/");

    expect(config.environment).toBe("development");
    expect(config.webUrl.toString()).toBe("https://pr-123-www.omby.ai/");
    expect(config.identity).toMatchObject({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou Dev",
      userDataDirectoryName: "Okou Dev",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop.dev",
      authScheme: "ai.okou.desktop.dev",
    });
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "https://pr-123-api.vm6.ai",
      "https://pr-123-app.omby.ai",
      "https://pr-123-www.omby.ai",
    ]);
  });

  it("resolves the independent Okou production identity", () => {
    const config = resolveDesktopConfig(undefined, "okou");

    expect(config.platformUrl.toString()).toBe("https://app.okou.ai/");
    expect(config.webUrl.toString()).toBe("https://www.okou.ai/");
    expect(config.environment).toBe("production");
    expect(config.identity).toMatchObject({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou",
      userDataDirectoryName: "Okou",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop",
      authScheme: "ai.okou.desktop",
    });
    expect(config.sessionPartition).toBe("persist:vm0-desktop-production");
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "https://api.okou.ai",
      "https://app.okou.ai",
      "https://www.okou.ai",
    ]);
  });

  it("resolves the independent Okou development identity", () => {
    const config = resolveDesktopConfig("https://pr-123-app.omby.ai/", "okou");

    expect(config.identity).toMatchObject({
      product: "okou",
      brandName: "Okou",
      displayName: "Okou Dev",
      userDataDirectoryName: "Okou Dev",
      updateLine: "ai-okou-desktop",
      bundleId: "ai.okou.desktop.dev",
      authScheme: "ai.okou.desktop.dev",
    });
  });

  it("derives localhost companion origins from the app port", () => {
    const config = resolveDesktopConfig("http://localhost:3002");

    expect(config.environment).toBe("development");
    expect(config.webUrl.toString()).toBe("http://localhost:3000/");
    expect([...config.allowedAppOrigins].sort()).toStrictEqual([
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:3002",
    ]);
  });
});

describe("window policy", () => {
  const allowedOrigins = new Set([
    "https://app.okou.ai",
    "https://www.okou.ai",
  ]);

  it("allows app-origin navigation", () => {
    expect(
      isAllowedAppNavigation("https://www.okou.ai/connectors", allowedOrigins),
    ).toBe(true);
  });

  it("blocks unexpected main-window navigation", () => {
    expect(
      isAllowedAppNavigation("https://example.com/docs", allowedOrigins),
    ).toBe(false);
  });

  it("opens app-origin windows inside Electron", () => {
    expect(
      decideWindowOpen("https://app.okou.ai/connectors", allowedOrigins),
    ).toStrictEqual({ action: "allow-in-app" });
  });

  it("keeps Google OAuth windows external", () => {
    expect(
      decideWindowOpen(
        "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fmock-instance.clerk.accounts.dev%2Fv1%2Foauth_callback&state=abc",
        allowedOrigins,
      ),
    ).toStrictEqual({
      action: "open-external",
      url: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fmock-instance.clerk.accounts.dev%2Fv1%2Foauth_callback&state=abc",
    });
  });

  it("keeps ordinary GitHub links external", () => {
    expect(
      decideWindowOpen("https://github.com/vm0-ai/vm0", allowedOrigins),
    ).toStrictEqual({
      action: "open-external",
      url: "https://github.com/vm0-ai/vm0",
    });
  });

  it("opens ordinary http links externally", () => {
    expect(
      decideWindowOpen("https://example.com/docs", allowedOrigins),
    ).toStrictEqual({
      action: "open-external",
      url: "https://example.com/docs",
    });
  });

  it("opens mailto links externally", () => {
    expect(
      decideWindowOpen("mailto:support@okou.ai", allowedOrigins),
    ).toStrictEqual({
      action: "open-external",
      url: "mailto:support@okou.ai",
    });
  });

  it("denies unsafe protocols", () => {
    expect(
      decideWindowOpen("javascript:alert('nope')", allowedOrigins),
    ).toStrictEqual({ action: "deny" });
  });
});

describe("computer use native helper", () => {
  it("prefers the packaged helper path when it exists", () => {
    const packagedPath = "/resources/native/computer-use-helper";
    const localPath = "/app/native/dist/native/computer-use-helper";
    const existing = new Set([packagedPath, localPath]);

    expect(
      resolveComputerUseHelperPath({
        appRoot: "/app",
        resourcesPath: "/resources",
        exists: (candidate) => {
          return existing.has(candidate);
        },
      }),
    ).toBe(packagedPath);
  });

  it("falls back to the local dist helper path", () => {
    expect(
      resolveComputerUseHelperPath({
        appRoot: "/app",
        resourcesPath: "/resources",
        exists: () => {
          return false;
        },
      }),
    ).toBe("/app/native/dist/native/computer-use-helper");
  });
});

describe("desktop auth", () => {
  const allowedOrigins = new Set([
    "https://app.okou.ai",
    "https://www.okou.ai",
  ]);
  const webUrl = new URL("https://www.okou.ai");
  const code = "abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-";

  it("builds the production system-browser desktop auth start URL", () => {
    expect(buildDesktopAuthStartUrl(webUrl, "ai.okou.desktop")).toBe(
      "https://www.okou.ai/desktop-auth/start?callbackScheme=ai.okou.desktop",
    );
  });

  it("builds the development system-browser desktop auth start URL", () => {
    expect(
      buildDesktopAuthStartUrl(
        new URL("https://www.vm7.ai:8443"),
        "ai.okou.desktop.dev",
      ),
    ).toBe(
      "https://www.vm7.ai:8443/desktop-auth/start?callbackScheme=ai.okou.desktop.dev",
    );
  });

  it("builds the Okou system-browser desktop auth start URL", () => {
    expect(
      buildDesktopAuthStartUrl(
        new URL("https://www.okou.ai"),
        "ai.okou.desktop",
      ),
    ).toBe(
      "https://www.okou.ai/desktop-auth/start?callbackScheme=ai.okou.desktop",
    );
  });

  it("deduplicates repeated desktop auth start attempts", () => {
    let now = 1_000;
    const gate = createDesktopAuthStartGate(() => now);

    expect(gate.shouldOpen()).toBe(true);
    expect(gate.shouldOpen()).toBe(false);

    now += 30_000;
    expect(gate.shouldOpen()).toBe(true);
    expect(gate.shouldOpen()).toBe(false);

    now += 30_000;
    gate.suppressRetry();
    expect(gate.shouldOpen()).toBe(false);

    now += 30_000;
    expect(gate.shouldOpen()).toBe(true);
  });

  it("detects explicit desktop auth start navigation", () => {
    expect(
      isDesktopAuthStartNavigation(
        "https://app.okou.ai/sign-in",
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isDesktopAuthStartNavigation(
        "https://app.okou.ai/desktop-auth/start",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthStartNavigation(
        "https://www.okou.ai/desktop-auth/start",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthStartNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("parses a valid desktop callback code", () => {
    expect(
      parseDesktopAuthCallback(
        `ai.okou.desktop://auth/callback?code=${code}`,
        "ai.okou.desktop",
      ),
    ).toStrictEqual({ code, handoffId: null });
    expect(
      parseDesktopAuthCallback(
        `ai.okou.desktop.dev://auth/callback?code=${code}`,
        "ai.okou.desktop.dev",
      ),
    ).toStrictEqual({ code, handoffId: null });
    expect(
      parseDesktopAuthCallback(
        `ai.okou.desktop://auth/callback?code=${code}&handoffId=550e8400-e29b-41d4-a716-446655440000`,
        "ai.okou.desktop",
      ),
    ).toStrictEqual({
      code,
      handoffId: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("parses desktop callbacks from launch arguments", () => {
    expect(
      parseDesktopAuthCallbackArgv(
        [
          "/Applications/Okou.app/Contents/MacOS/Okou",
          `ai.okou.desktop://auth/callback?code=${code}`,
        ],
        "ai.okou.desktop",
      ),
    ).toStrictEqual({ code, handoffId: null });
    expect(
      parseDesktopAuthCallbackArgv(
        ["/Applications/Okou.app/Contents/MacOS/Okou", "--some-flag"],
        "ai.okou.desktop",
      ),
    ).toBe(null);
  });

  it("rejects unsafe desktop callbacks", () => {
    expect(
      parseDesktopAuthCallback(
        "ai.okou.desktop://auth/callback?token=secret",
        "ai.okou.desktop",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        `ai.okou.desktop://auth/callback?code=${code}`,
        "ai.okou.desktop.dev",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        "ai.okou.desktop://other/callback?code=abc",
        "ai.okou.desktop",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        "https://app.okou.ai/desktop-auth/consume?code=abc",
        "ai.okou.desktop",
      ),
    ).toBe(null);
    expect(
      parseDesktopAuthCallback(
        `ai.okou.desktop://auth/callback?code=${code}&handoffId=not-a-uuid`,
        "ai.okou.desktop",
      ),
    ).toBe(null);
  });

  it("builds the Electron web-session consume URL", () => {
    expect(buildDesktopAuthConsumeUrl(webUrl, code)).toBe(
      `https://www.okou.ai/desktop-auth/consume?code=${code}`,
    );
    expect(
      buildDesktopAuthConsumeUrl(
        webUrl,
        code,
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe(
      `https://www.okou.ai/desktop-auth/consume?code=${code}&handoffId=550e8400-e29b-41d4-a716-446655440000`,
    );
  });

  it("builds the Electron web-session organization selection URL", () => {
    expect(buildDesktopAuthSelectOrgUrl(webUrl)).toBe(
      "https://www.okou.ai/desktop-auth/select-org",
    );
    expect(buildDesktopAuthSelectOrgUrl(webUrl, true)).toBe(
      "https://www.okou.ai/desktop-auth/select-org?force=true",
    );
  });

  it("builds the Electron web-session token refresh URL", () => {
    expect(buildDesktopAuthTokenUrl(webUrl)).toBe(
      "https://www.okou.ai/desktop-auth/token",
    );
  });

  it("detects desktop auth organization selection navigation", () => {
    expect(
      isDesktopAuthSelectOrgNavigation(
        "https://app.okou.ai/desktop-auth/select-org",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthSelectOrgNavigation(
        "https://www.okou.ai/desktop-auth/select-org?force=true",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthSelectOrgNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("detects desktop auth completion navigation after locale redirects", () => {
    expect(
      isDesktopAuthCompletionNavigation("https://www.okou.ai/", allowedOrigins),
    ).toBe(true);
    expect(
      isDesktopAuthCompletionNavigation(
        "https://www.okou.ai/en",
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      isDesktopAuthCompletionNavigation(
        "https://www.okou.ai/desktop-auth/token",
        allowedOrigins,
      ),
    ).toBe(false);
    expect(
      isDesktopAuthCompletionNavigation(
        "https://accounts.google.com/signin",
        allowedOrigins,
      ),
    ).toBe(false);
  });

  it("recognizes Electron navigation aborts as non-fatal auth redirects", () => {
    expect(isElectronNavigationAborted({ code: "ERR_ABORTED" })).toBe(true);
    expect(isElectronNavigationAborted({ errno: -3 })).toBe(true);
    expect(isElectronNavigationAborted({ code: "ERR_FAILED" })).toBe(false);
    expect(isElectronNavigationAborted(null)).toBe(false);
  });
});

describe("computer use desktop runtime", () => {
  it("derives the API backend URL from platform URLs", () => {
    expect(resolveComputerUseApiBaseUrl(new URL("https://app.okou.ai"))).toBe(
      "https://api.okou.ai",
    );
    expect(resolveComputerUseApiBaseUrl(new URL("https://app.okou.ai"))).toBe(
      "https://api.okou.ai",
    );
    expect(resolveComputerUseApiBaseUrl(new URL("https://app.vm7.ai"))).toBe(
      "https://api.vm7.ai",
    );
    expect(
      resolveComputerUseApiBaseUrl(new URL("https://staging-app.omby.ai")),
    ).toBe("https://staging-api.vm6.ai");
    expect(
      resolveComputerUseApiBaseUrl(new URL("https://pr-123-app.omby.ai")),
    ).toBe("https://pr-123-api.vm6.ai");
  });

  it("serializes the Desktop host runtime body", () => {
    expect(
      buildComputerUseRuntimeBody({
        installationId: "00000000-0000-4000-8000-000000000001",
        hostName: "lancy-macbook-pro.local",
        appVersion: "0.1.0",
        permissions: { accessibility: true, screenRecording: false },
      }),
    ).toMatchObject({
      installationId: "00000000-0000-4000-8000-000000000001",
      hostName: "lancy-macbook-pro.local",
      appVersion: "0.1.0",
      permissions: { accessibility: true, screenRecording: false },
    });
  });

  it("lists app records with bundle identifiers", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "apps.list", payload: {} },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          listApps: async () => [
            {
              name: "TextEdit",
              bundleId: "com.apple.TextEdit",
              appPath: "/System/Applications/TextEdit.app",
              running: true,
              pid: 42,
            },
            {
              name: "Safari",
              bundleId: "com.apple.Safari",
              appPath: "/Applications/Safari.app",
              running: false,
            },
          ],
        }),
      },
    );

    expect(result).toStrictEqual({
      status: "succeeded",
      result: {
        apps: [
          {
            name: "Safari",
            bundleId: "com.apple.Safari",
            appPath: "/Applications/Safari.app",
            running: false,
          },
          {
            name: "TextEdit",
            bundleId: "com.apple.TextEdit",
            appPath: "/System/Applications/TextEdit.app",
            running: true,
            pid: 42,
          },
        ],
      },
    });
  });

  it("reports app open as a background launch without target preparation", async () => {
    const openApp = vi.fn<ComputerUseNativeBackend["openApp"]>();
    openApp.mockResolvedValue({
      ...nativeDispatchResult(
        "background_app_open",
        "target_app",
        "background_app_launch",
      ),
      frontmostRestored: true,
      frontmostBefore: {
        localizedName: "Notes",
        pid: 200,
      },
      frontmostAfter: {
        localizedName: "Notes",
        pid: 200,
      },
    });
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.open", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          openApp,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          dispatchMode: "background_app_open",
          dispatchTarget: "target_app",
          inputRisk: "background_app_launch",
          frontmostRestored: true,
          frontmostBefore: {
            localizedName: "Notes",
            pid: 200,
          },
          frontmostAfter: {
            localizedName: "Notes",
            pid: 200,
          },
        },
      },
    });
    expect(openApp).toHaveBeenCalledWith("Safari");
  });

  it("renders model-readable accessibility state", () => {
    const snapshot = {
      app: "Safari",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Example",
          children: [
            {
              id: "w0.e0",
              role: "AXButton",
              name: "Open",
              actions: ["AXPress"],
            },
          ],
        },
      ],
    };
    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain("Computer Use state");
    expect(text).toContain("<app_state>");
    expect(text).toContain("App=Safari");
    expect(text).toContain('Window: "Example", App: Safari.');
    expect(text).toContain("0 standard window Example");
    expect(text).toContain("\t1 button Open");
    expect(text).not.toContain("w0.e0");
  });

  it("renders off-Space window diagnostics", () => {
    const snapshot = {
      app: "Things",
      snapshotId: "snap_1",
      windowOnCurrentSpace: false,
      currentSpaceId: 8,
      windowSpaceIds: [9],
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Today",
        },
      ],
    };
    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain(
      "Window is on another macOS Space (current Space 8, window Spaces 9).",
    );
    expect(text).toContain(
      "macOS may expose only a reduced Accessibility tree",
    );
  });

  it("renders accessibility element details and focused element summary", () => {
    const snapshot = {
      app: "Electron",
      appDisplayName: "Okou",
      bundleId: "com.github.Electron",
      pid: 26037,
      appPath: "/Applications/Okou.app",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Okou",
          children: [
            {
              id: "w0.e0",
              role: "AXWebArea",
              roleDescription: "HTML content",
              name: "Okou",
              url: "https://app.vm7.ai/agents/1/chat",
              children: [
                {
                  id: "w0.e0.e0",
                  role: "AXTextArea",
                  name: "Ask me to automate workflows",
                  valueSettable: true,
                  valueType: "string",
                  focused: true,
                },
                {
                  id: "w0.e0.e1",
                  role: "AXButton",
                  description: "Invite people",
                  actions: [
                    "AXPress",
                    "AXRaise",
                    "AXShowMenu",
                    "AXScrollToVisible",
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain(
      "App=/Applications/Okou.app (bundleID com.github.Electron, pid 26037)",
    );
    expect(text).toContain(
      "\t1 HTML content Okou, URL: https://app.vm7.ai/agents/1/chat",
    );
    expect(text).toContain(
      "\t\t2 text entry area (settable, string) Ask me to automate workflows",
    );
    expect(text).toContain(
      "\t\t3 button Invite people, Secondary Actions: Raise",
    );
    expect(text).not.toContain("Show Menu");
    expect(text).not.toContain("ScrollToVisible");
    expect(text).toContain(
      "The focused UI element is 2 text entry area (settable, string) Ask me to automate workflows.",
    );
  });

  it("renders click capability annotations for model target selection", () => {
    const snapshot = {
      app: "Things",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Things",
          children: [
            {
              id: "w0.r0",
              role: "AXRow",
              description: "Inbox",
              selected: false,
              selectable: true,
              mouseClickable: true,
              clickableKind: "select",
            },
            {
              id: "w0.r1",
              role: "AXRow",
              description: "Today",
              selected: true,
              selectable: true,
              mouseClickable: true,
              clickableKind: "select",
            },
            {
              id: "w0.g0",
              role: "AXGroup",
              name: "Reveal details",
              actions: ["AXPress"],
              pressable: true,
              clickableKind: "press",
            },
            {
              id: "w0.m0",
              role: "AXMenuItem",
              name: "Choose workspace",
              actions: ["AXPick"],
              pickable: true,
              clickableKind: "pick",
            },
          ],
        },
      ],
    } as const;

    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain("\t1 row (selectable) Inbox");
    expect(text).toContain("\t2 row (selected) Today");
    expect(text).toContain("\t3 container (pressable) Reveal details");
    expect(text).toContain("\t4 menu item (pickable) Choose workspace");
    expect(text).not.toContain("Secondary Actions: Pick");
  });

  it("compacts structural web wrappers while preserving child controls", () => {
    const snapshot = {
      app: "Slack",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "release-notify (Channel) - Okou - Slack",
          children: [
            {
              id: "w0.e0",
              role: "AXGroup",
              children: [
                {
                  id: "w0.e0.e0",
                  role: "AXWebArea",
                  roleDescription: "HTML content",
                  children: [
                    {
                      id: "w0.e0.e0.e0",
                      role: "AXGroup",
                      expanded: false,
                      children: [
                        {
                          id: "w0.e0.e0.e0.e0",
                          role: "AXGroup",
                          expanded: false,
                          children: [
                            {
                              id: "w0.e0.e0.e0.e0.e0",
                              role: "AXButton",
                              name: "Send message",
                              actions: ["AXPress"],
                            },
                          ],
                        },
                        {
                          id: "w0.e0.e0.e0.e1",
                          role: "AXStaticText",
                          value: "release-notify",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const text = renderAccessibilityTree(
      normalizeAccessibilitySnapshot(snapshot),
    );

    expect(text).not.toContain("w0.e0");
    expect(text).toContain("\t1 HTML content");
    expect(text).toContain("\t\t2 button Send message");
    expect(text).toContain("\t\t3 text release-notify");
    expect(text).not.toContain("\t\t2 container");
  });

  it("applies structural wrapper compaction before the output node budget", () => {
    const noisyProfileLinks = Array.from({ length: 20 }, (_value, index) => {
      const label = `Profile ${index}`;
      return {
        id: `w0.e0.row${index}`,
        role: "AXGroup",
        actions: ["AXShowMenu", "AXScrollToVisible"],
        expanded: false,
        mouseClickable: true,
        children: [
          {
            id: `w0.e0.row${index}.link`,
            role: "AXLink",
            name: label,
            actions: ["AXPress", "AXShowMenu", "AXScrollToVisible"],
            pressable: true,
            children: [
              {
                id: `w0.e0.row${index}.label`,
                role: "AXStaticText",
                value: label,
                actions: ["AXPress", "AXShowMenu", "AXScrollToVisible"],
                expanded: false,
                pressable: true,
                mouseClickable: true,
              },
            ],
          },
        ],
      };
    });
    const snapshot = {
      app: "Google Chrome",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "LinkedIn",
          children: [
            {
              id: "w0.e0",
              role: "AXWebArea",
              roleDescription: "HTML content",
              children: [
                ...noisyProfileLinks,
                {
                  id: "w0.e0.messaging",
                  role: "AXGroup",
                  actions: ["AXShowMenu", "AXScrollToVisible"],
                  children: [
                    {
                      id: "w0.e0.messaging.title",
                      role: "AXStaticText",
                      value: "New message",
                    },
                    {
                      id: "w0.e0.messaging.input",
                      role: "AXTextArea",
                      description: "Write a message...",
                      placeholderValue: "Write a message...",
                      valueSettable: true,
                      valueType: "string",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const normalized = normalizeAccessibilitySnapshot(snapshot, {
      ...ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
      maxNodes: 24,
    });
    const text = renderAccessibilityTree(normalized);

    expect(normalized.truncated).toBeUndefined();
    expect(text).toContain("text New message");
    expect(text).toContain(
      "text entry area (settable, string) Write a message...",
    );
    expect(text).toContain("\t\t2 link Profile 0");
    expect(text).not.toContain("text Profile 0");
    expect(text).not.toContain("Secondary Actions: Show Menu");
    expect(text).not.toContain("ScrollToVisible");
  });

  it("keeps menu bars shallow for app state output", () => {
    const snapshot = {
      app: "Google Chrome",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "LinkedIn",
          children: [
            {
              id: "w0.menu",
              role: "AXMenuBar",
              actions: ["AXCancel"],
              children: [
                {
                  id: "w0.menu.chrome",
                  role: "AXMenuBarItem",
                  name: "Chrome",
                  actions: ["AXCancel", "AXPick"],
                  children: [
                    {
                      id: "w0.menu.chrome.menu",
                      role: "AXMenu",
                      name: "Chrome",
                      actions: ["AXCancel"],
                      children: [
                        {
                          id: "w0.menu.chrome.about",
                          role: "AXMenuItem",
                          name: "About Google Chrome",
                          actions: ["AXPick"],
                        },
                        {
                          id: "w0.menu.chrome.settings",
                          role: "AXMenuItem",
                          name: "Settings...",
                          actions: ["AXPick"],
                        },
                      ],
                    },
                  ],
                },
                {
                  id: "w0.menu.file",
                  role: "AXMenuBarItem",
                  name: "File",
                  actions: ["AXCancel", "AXPick"],
                },
              ],
            },
          ],
        },
      ],
    };

    const text = renderAccessibilityTree(
      normalizeAccessibilitySnapshot(snapshot),
    );

    expect(text).toContain("\t1 menu bar");
    expect(text).toContain("\t\t2 menu bar item Chrome");
    expect(text).toContain("\t\t3 menu bar item File");
    expect(text).not.toContain("About Google Chrome");
    expect(text).not.toContain("Settings...");
    expect(text).not.toContain("Secondary Actions: Cancel");
    expect(text).not.toContain("Secondary Actions: Pick");
  });

  it("compacts child labels already covered by parent action text", () => {
    const snapshot = {
      app: "Google Chrome",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "LinkedIn",
          children: [
            {
              id: "w0.e0",
              role: "AXWebArea",
              roleDescription: "HTML content",
              children: [
                {
                  id: "w0.e0.card",
                  role: "AXLink",
                  name: "Stephan B. Premium · 2nd Director Software Development & Product",
                  url: "https://www.linkedin.com/in/stephangbetz/",
                  actions: ["AXPress"],
                  pressable: true,
                  children: [
                    {
                      id: "w0.e0.card.name",
                      role: "AXLink",
                      name: "Stephan B. Premium",
                      url: "https://www.linkedin.com/in/stephangbetz/",
                      actions: ["AXPress"],
                      pressable: true,
                      children: [
                        {
                          id: "w0.e0.card.name.text",
                          role: "AXStaticText",
                          value: "Stephan B.",
                        },
                        {
                          id: "w0.e0.card.name.empty",
                          role: "AXStaticText",
                          value: "",
                        },
                        {
                          id: "w0.e0.card.name.badge",
                          role: "AXImage",
                          description: "Premium",
                          mouseClickable: true,
                        },
                      ],
                    },
                    {
                      id: "w0.e0.card.degree",
                      role: "AXStaticText",
                      value: "· 2nd",
                    },
                    {
                      id: "w0.e0.card.headline",
                      role: "AXStaticText",
                      value: "Director Software Development & Product",
                    },
                  ],
                },
                {
                  id: "w0.e0.invite",
                  role: "AXButton",
                  name: "Invite Stephan B. to connect",
                  actions: ["AXPress"],
                },
                {
                  id: "w0.e0.post",
                  role: "AXLink",
                  name: "Starting a new position at OpenAI",
                  url: "https://www.linkedin.com/feed/update/1/",
                  actions: ["AXPress"],
                  pressable: true,
                  children: [
                    {
                      id: "w0.e0.post.company",
                      role: "AXLink",
                      name: "OpenAI",
                      url: "https://www.linkedin.com/company/openai/",
                      actions: ["AXPress"],
                      pressable: true,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const text = renderAccessibilityTree(
      normalizeAccessibilitySnapshot(snapshot),
    );

    expect(text).toContain(
      "\t\t2 link Stephan B. Premium · 2nd Director Software Development & Product",
    );
    expect(text).toContain("\t\t3 button Invite Stephan B. to connect");
    expect(text).toContain("\t\t4 link Starting a new position at OpenAI");
    expect(text).toContain("\t\t\t5 link OpenAI");
    expect(text).not.toContain("text Stephan B.");
    expect(text).not.toContain("image Premium");
    expect(text).not.toContain("text · 2nd");
    expect(text).not.toContain("text Director Software Development & Product");
  });

  it("renders browser table row and cell content for model targeting", () => {
    const snapshot = normalizeAccessibilitySnapshot({
      app: "Google Chrome",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Members | Okou | Cloudflare",
          children: [
            {
              id: "w0.e0",
              role: "AXWebArea",
              roleDescription: "HTML content",
              name: "Members | Okou | Cloudflare",
              children: [
                {
                  id: "w0.e0.e0",
                  role: "AXTable",
                  children: [
                    {
                      id: "w0.e0.e0.r0",
                      role: "AXRow",
                      children: [
                        {
                          id: "w0.e0.e0.r0.c0",
                          role: "AXCell",
                          children: [
                            {
                              id: "w0.e0.e0.r0.c0.t0",
                              role: "AXStaticText",
                              value: "Individual Domains",
                            },
                          ],
                        },
                        {
                          id: "w0.e0.e0.r0.c1",
                          role: "AXCell",
                          children: [
                            {
                              id: "w0.e0.e0.r0.c1.t0",
                              role: "AXStaticText",
                              value: "Domain DNS",
                            },
                          ],
                        },
                      ],
                    },
                    {
                      id: "w0.e0.e0.r1",
                      role: "AXRow",
                      children: [
                        {
                          id: "w0.e0.e0.r1.c0",
                          role: "AXCell",
                          children: [
                            {
                              id: "w0.e0.e0.r1.c0.t0",
                              role: "AXStaticText",
                              value:
                                "Cloudflare Zero Trust; Load Balancer; Cloudflare Access",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const text = renderAccessibilityTree(snapshot);

    expect(text).toContain("table");
    expect(text).toContain("row");
    expect(text).toContain("cell");
    expect(text).toContain("Individual Domains");
    expect(text).toContain("Domain DNS");
    expect(text).toContain("Cloudflare Zero Trust; Load Balancer");
  });

  it("marks accessibility snapshots truncated at the output node budget", () => {
    const snapshot = {
      app: "Slack",
      snapshotId: "snap_1",
      elements: [
        {
          id: "w0",
          role: "AXWindow",
          name: "Slack",
          children: Array.from({ length: 5 }, (_value, index) => {
            return {
              id: `w0.e${index}`,
              role: "AXButton",
              name: `Button ${index}`,
            };
          }),
        },
      ],
    };

    const normalized = normalizeAccessibilitySnapshot(snapshot, {
      ...ACCESSIBILITY_SNAPSHOT_OUTPUT_LIMITS,
      maxNodes: 3,
    });
    const text = renderAccessibilityTree(normalized);

    expect(normalized.truncated).toBe(true);
    expect(normalized.truncationReasons).toContain("max_nodes");
    expect(normalized.nodeCount).toBe(3);
    expect(text).toContain("\t1 button Button 0");
    expect(text).toContain("\t2 button Button 1");
    expect(text).not.toContain("Button 2");
  });

  it("returns screenshot metadata with model-readable app state", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: async (app, snapshotId) => {
            return {
              app,
              snapshotId,
              ...nativeScreenshotFields({
                screenshotSourceName: "Example",
              }),
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Example",
                },
              ],
            };
          },
        }),
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(result).toMatchObject({
      result: {
        app: "Safari",
        snapshotId: expect.stringMatching(/^desktop_/),
        screenshot: "data:image/png;base64,abc123",
        screenshotMimeType: "image/png",
        screenshotSource: "window",
        screenshotSourceName: "Example",
        screenshotWidth: 800,
        screenshotHeight: 600,
        screenshotSourceBounds: { x: 100, y: 200, width: 800, height: 600 },
      },
    });
    expect(result.result.appState).toContain("0 standard window Example");
    expect(result.result.elements).toBeUndefined();
    expect(result.result.visibleText).toBeUndefined();
    expect(result.result.visibleElements).toBeUndefined();
    expect(result.result.visibleTextSource).toBeUndefined();
  });

  it("normalizes deep accessibility state from the native helper", async () => {
    const nativeRequests: {
      readonly app: string;
      readonly snapshotId: string;
    }[] = [];
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Slack" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: async (app, snapshotId) => {
            nativeRequests.push({ app, snapshotId });
            return {
              app,
              snapshotId,
              ...nativeScreenshotFields({
                screenshotSourceName: "Slack",
              }),
              nodeCount: 7,
              truncated: false,
              truncationReasons: [],
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "release-notify (Channel) - Okou - Slack",
                  children: [
                    {
                      id: "w0.e0",
                      role: "AXGroup",
                      children: [
                        {
                          id: "w0.e0.e0",
                          role: "AXGroup",
                          children: [
                            {
                              id: "w0.e0.e0.c0",
                              role: "AXWebArea",
                              roleDescription: "HTML content",
                              children: [
                                {
                                  id: "w0.e0.e0.c0.v0",
                                  role: "AXStaticText",
                                  value: "Release notes posted",
                                },
                                {
                                  id: "w0.e0.e0.c0.v1",
                                  role: "AXTextArea",
                                  name: "Message composer",
                                  placeholderValue: "Type a message",
                                  actions: ["AXConfirm"],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            };
          },
        }),
      },
    );

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }
    expect(nativeRequests).toHaveLength(1);
    expect(nativeRequests[0]).toMatchObject({
      app: "Slack",
      snapshotId: expect.stringMatching(/^desktop_/),
    });
    expect(result.result.appState).toContain("Release notes posted");
    expect(result.result.appState).toContain(
      "text entry area Message composer",
    );
    expect(result.result.appState).toContain("Secondary Actions: Confirm");
    expect(result.result.truncated).toBe(false);
  });

  it("resolves action element ids from non-uiElement child sources", async () => {
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Slack", elementId: "w0.c0.v2" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          clickElement,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId, "Slack");
          },
        }),
      },
    );

    expect(result.status).toBe("succeeded");
    expect(clickElement).toHaveBeenCalledWith({
      app: "Slack",
      elementId: "w0.c0.v2",
      button: "left",
      clickCount: 1,
      foregroundRecovery: "on-window-unavailable",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Slack",
          elementId: "w0.c0.v2",
          dispatchMode: "accessibility_action",
        },
      },
    });
  });

  it("returns fresh app state and screenshot after element clicks", async () => {
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Things", elementId: "sidebar.inbox" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          clickElement,
          getAppState: async (app, snapshotId) => {
            return {
              app,
              snapshotId,
              ...nativeScreenshotFields({ screenshotSourceName: "Inbox" }),
              windowTitle: "Inbox",
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Inbox",
                  children: [
                    {
                      id: "w0.todo0",
                      role: "AXStaticText",
                      value: "Can you see this?",
                    },
                  ],
                },
              ],
            };
          },
        }),
      },
    );

    expect(clickElement).toHaveBeenCalledWith({
      app: "Things",
      elementId: "sidebar.inbox",
      button: "left",
      clickCount: 1,
      foregroundRecovery: "on-window-unavailable",
    });
    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected click to succeed");
    }
    expect(result.result).toMatchObject({
      app: "Things",
      windowTitle: "Inbox",
      screenshot: "data:image/png;base64,abc123",
      screenshotSourceName: "Inbox",
      action: {
        app: "Things",
        elementId: "sidebar.inbox",
        dispatchMode: "accessibility_action",
        summary: "Clicked sidebar.inbox",
      },
    });
    expect(result.result.appState).toContain("Can you see this?");
  });

  it("requests a settled snapshot after write actions but not for explicit app state", async () => {
    const postActionGetAppState = vi.fn<
      ComputerUseNativeBackend["getAppState"]
    >(async (app, snapshotId) => {
      return {
        app,
        snapshotId,
        ...nativeScreenshotFields({ screenshotSourceName: "Inbox" }),
        windowTitle: "Inbox",
        elements: [{ id: "w0", role: "AXWindow", name: "Inbox" }],
      };
    });
    const clickResult = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Things", elementId: "sidebar.inbox" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: postActionGetAppState,
        }),
      },
    );
    expect(clickResult.status).toBe("succeeded");
    expect(postActionGetAppState).toHaveBeenCalledWith(
      "Things",
      expect.any(String),
      true,
    );

    const explicitGetAppState = vi.fn<ComputerUseNativeBackend["getAppState"]>(
      async (app, snapshotId) => {
        return {
          app,
          snapshotId,
          ...nativeScreenshotFields({ screenshotSourceName: "Inbox" }),
          windowTitle: "Inbox",
          elements: [{ id: "w0", role: "AXWindow", name: "Inbox" }],
        };
      },
    );
    const stateResult = await executeComputerUseCommand(
      { id: "cmd_2", kind: "app.state", payload: { app: "Things" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: explicitGetAppState,
        }),
      },
    );
    expect(stateResult.status).toBe("succeeded");
    expect(explicitGetAppState).toHaveBeenCalledWith(
      "Things",
      expect.any(String),
      false,
    );
  });

  it("resolves normalized element indexes to native element ids", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickElement = vi.fn<ComputerUseNativeBackend["clickElement"]>();
    clickElement.mockResolvedValue(
      nativeDispatchResult(
        "accessibility_action",
        "element",
        "targeted_app_action",
      ),
    );
    const nativeBackend = createNativeBackend({
      clickElement,
      getAppState: async (app, snapshotId) => {
        return {
          app,
          snapshotId,
          ...nativeScreenshotFields({
            screenshotSourceName: "Example",
          }),
          elements: [
            {
              id: "w0",
              role: "AXWindow",
              name: "Example",
              children: [
                {
                  id: "w0.e0",
                  role: "AXGroup",
                  children: [
                    {
                      id: "w0.e0.e0",
                      role: "AXButton",
                      name: "Open",
                      actions: ["AXPress"],
                    },
                  ],
                },
              ],
            },
          ],
          elementIdsByIndex: ["w0", "w0.e0", "w0.e0.e0"],
        };
      },
    });

    const state = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );
    expect(state.status).toBe("succeeded");
    if (state.status !== "succeeded") {
      throw new Error("expected app.state to succeed");
    }

    const snapshotId = state.result.snapshotId;
    expect(typeof snapshotId).toBe("string");
    if (typeof snapshotId !== "string") {
      throw new Error("expected snapshot id");
    }
    expect(state.result.elements).toBeUndefined();
    expect(state.result.elementIdsByIndex).toStrictEqual(["w0", "w0.e0.e0"]);

    const click = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "element.click",
        payload: { app: "Safari", snapshotId, elementIndex: 1 },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );

    expect(click.status).toBe("succeeded");
    expect(clickElement).toHaveBeenCalledWith({
      app: "Safari",
      elementId: "w0.e0.e0",
      snapshotId,
      elementIndex: 1,
      button: "left",
      clickCount: 1,
      foregroundRecovery: "on-window-unavailable",
    });
    if (click.status !== "succeeded") {
      throw new Error("expected click to succeed");
    }
    expect(click.result).toMatchObject({
      app: "Safari",
      screenshot: "data:image/png;base64,abc123",
      action: {
        app: "Safari",
        snapshotId,
        elementIndex: 1,
        dispatchMode: "accessibility_action",
      },
    });
    const action = click.result.action;
    expect(action).toBeTruthy();
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error("expected click action metadata");
    }
    expect(action).not.toHaveProperty("elementId");
  });

  it("maps screenshot coordinate clicks through cached snapshot bounds", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockResolvedValue({
      ...nativeDispatchResult(
        "background_mouse_event",
        "app_process",
        "background_app_pointer",
      ),
      screenX: 900,
      screenY: 800,
    });
    const nativeBackend = createNativeBackend({
      clickPoint,
      getAppState: async (app) => {
        return {
          app,
          snapshotId: "snap_1",
          ...nativeScreenshotFields({
            screenshotSourceName: "Example",
            screenshotWidth: 800,
            screenshotHeight: 600,
            screenshotSourceBounds: {
              x: 100,
              y: 200,
              width: 1600,
              height: 1200,
            },
            windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
          }),
          elements: [
            {
              id: "w0",
              role: "AXWindow",
              name: "Example",
              bounds: { x: 100, y: 200, width: 1600, height: 1200 },
            },
          ],
        };
      },
    });

    const state = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );
    expect(state.status).toBe("succeeded");
    expect(snapshotStore.get("Safari", "snap_1")).toMatchObject({
      screenshotSource: "window",
      sourceBounds: { x: 100, y: 200, width: 1600, height: 1200 },
      windowId: 123,
      windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
    });

    const click = await executeComputerUseCommand(
      {
        id: "cmd_2",
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "snap_1",
          x: 400,
          y: 300,
          button: "right",
          clickCount: 2,
        },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend,
      },
    );

    expect(click).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          snapshotId: "snap_1",
          x: 400,
          y: 300,
          screenX: 900,
          screenY: 800,
          button: "right",
          clickCount: 2,
          dispatchMode: "background_mouse_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_pointer",
        },
      },
    });
    expect(clickPoint).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "snap_1",
      x: 400,
      y: 300,
      screenshotSource: "window",
      screenshotWidth: 800,
      screenshotHeight: 600,
      sourceBounds: { x: 100, y: 200, width: 1600, height: 1200 },
      windowId: 123,
      windowFrame: { x: 100, y: 200, width: 1600, height: 1200 },
      button: "right",
      clickCount: 2,
      foregroundRecovery: "on-window-unavailable",
    });
  });

  it("surfaces native rejection for coordinate clicks against non-window snapshots", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockRejectedValue(
      new ComputerUseNativeHelperError(
        "unsupported_command",
        "Snapshot is not a target-window screenshot: screen_snap",
      ),
    );
    snapshotStore.set({
      app: "Safari",
      snapshotId: "screen_snap",
      screenshotWidth: 800,
      screenshotHeight: 600,
      screenshotSource: "screen",
      screenshotSourceName: "Built-in Display",
      sourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
    });

    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: {
          app: "Safari",
          snapshotId: "screen_snap",
          x: 400,
          y: 300,
        },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({ clickPoint }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message: "Snapshot is not a target-window screenshot: screen_snap",
      },
    });
    expect(clickPoint).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "screen_snap",
      x: 400,
      y: 300,
      screenshotSource: "screen",
      screenshotWidth: 800,
      screenshotHeight: 600,
      sourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
      button: "left",
      clickCount: 1,
      foregroundRecovery: "on-window-unavailable",
    });
  });

  it("uses fresh native app state for coordinate clicks without a cached snapshot", async () => {
    const snapshotStore = new ComputerUseSnapshotStore();
    let stateCaptureCount = 0;
    const clickPoint = vi.fn<ComputerUseNativeBackend["clickPoint"]>();
    clickPoint.mockResolvedValue({
      ...nativeDispatchResult(
        "background_mouse_event",
        "app_process",
        "background_app_pointer",
      ),
      screenX: 440,
      screenY: 380,
    });

    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "element.click",
        payload: { app: "Safari", x: 200, y: 150 },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        snapshotStore,
        nativeBackend: createNativeBackend({
          clickPoint,
          getAppState: async () => {
            stateCaptureCount += 1;
            return {
              app: "Safari",
              snapshotId: "snap_fresh",
              ...nativeScreenshotFields({
                screenshotSourceName: "Example",
                screenshotWidth: 400,
                screenshotHeight: 300,
                screenshotSourceBounds: {
                  x: 40,
                  y: 80,
                  width: 800,
                  height: 600,
                },
                windowFrame: { x: 40, y: 80, width: 800, height: 600 },
              }),
              elements: [
                {
                  id: "w0",
                  role: "AXWindow",
                  name: "Example",
                  bounds: { x: 40, y: 80, width: 800, height: 600 },
                },
              ],
            };
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        app: "Safari",
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          snapshotId: "snap_fresh",
          x: 200,
          y: 150,
          screenX: 440,
          screenY: 380,
          button: "left",
          clickCount: 1,
          dispatchMode: "background_mouse_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_pointer",
        },
      },
    });
    expect(stateCaptureCount).toBe(2);
    expect(clickPoint).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "snap_fresh",
      x: 200,
      y: 150,
      screenshotSource: "window",
      screenshotWidth: 400,
      screenshotHeight: 300,
      sourceBounds: { x: 40, y: 80, width: 800, height: 600 },
      windowId: 123,
      windowFrame: { x: 40, y: 80, width: 800, height: 600 },
      button: "left",
      clickCount: 1,
      foregroundRecovery: "on-window-unavailable",
    });
  });

  it("requires screen recording permission for app state screenshots", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: false },
      {
        platform: "darwin",
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message: "macOS Screen Recording permission is required",
      },
    });
  });

  it("rejects native app state screenshots that are not target-window captures", async () => {
    const result = await executeComputerUseCommand(
      { id: "cmd_1", kind: "app.state", payload: { app: "Safari" } },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          getAppState: async (app, snapshotId) => {
            return {
              app,
              snapshotId,
              elements: [],
              screenshot: "data:image/png;base64,abc123",
              screenshotMimeType: "image/png",
              screenshotSource: "screen",
              screenshotSourceName: "Built-in Display",
              screenshotWidth: 800,
              screenshotHeight: 600,
              screenshotSourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
            };
          },
        }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "screen_recording_unavailable",
        message:
          "Native Computer Use app.state must return a target-window screenshot",
      },
    });
  });

  it("passes press-key combinations to the native helper", async () => {
    const cases = [
      {
        key: "Command+K",
        normalizedKey: "Command+K",
      },
      {
        key: "Control+K",
        normalizedKey: "Control+K",
      },
      {
        key: "Command+Shift+S",
        normalizedKey: "Command+Shift+S",
      },
      {
        key: "shift+semicolon",
        normalizedKey: "Shift+Semicolon",
      },
      {
        key: "Control_L+J",
        normalizedKey: "Control+J",
      },
      {
        key: "ctrl+alt+n",
        normalizedKey: "Control+Option+N",
      },
      {
        key: "Shift+;",
        normalizedKey: "Shift+Semicolon",
      },
    ];

    for (const testCase of cases) {
      const pressRequests: Array<{
        readonly app: string;
        readonly key: string;
      }> = [];
      const result = await executeComputerUseCommand(
        {
          id: "cmd_1",
          kind: "keyboard.press_key",
          payload: { app: "Safari", key: testCase.key },
        },
        { accessibility: true, screenRecording: true },
        {
          platform: "darwin",
          nativeBackend: createNativeBackend({
            pressKey: async (request) => {
              pressRequests.push(request);
              return { normalizedKey: testCase.normalizedKey };
            },
            getAppState: async (app, snapshotId) => {
              return nativeAppStateWithScreenshot(app, snapshotId);
            },
          }),
        },
      );

      expect(result).toMatchObject({
        status: "succeeded",
        result: {
          screenshot: "data:image/png;base64,abc123",
          action: { key: testCase.normalizedKey },
        },
      });
      expect(pressRequests).toStrictEqual([
        {
          app: "Safari",
          key: testCase.key,
          foregroundRecovery: "on-window-unavailable",
        },
      ]);
    }
  });

  it("posts press-key combinations to the target process without app activation", async () => {
    const openApp = vi.fn<ComputerUseNativeBackend["openApp"]>();
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>();
    pressKey.mockResolvedValue({
      ...nativeDispatchResult(
        "background_keyboard_event",
        "app_process",
        "background_app_shortcut",
      ),
      normalizedKey: "Command+K",
    });
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", key: "Command+K" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          openApp,
          pressKey,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: "data:image/png;base64,abc123",
        action: {
          key: "Command+K",
          dispatchMode: "background_keyboard_event",
          dispatchTarget: "app_process",
          inputRisk: "background_app_shortcut",
        },
      },
    });
    expect(pressKey).toHaveBeenCalledWith({
      app: "Safari",
      key: "Command+K",
      foregroundRecovery: "on-window-unavailable",
    });
    expect(openApp).not.toHaveBeenCalled();
  });

  it("preserves foreground recovery metadata from native key actions", async () => {
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>();
    pressKey.mockResolvedValue({
      ...nativeDispatchResult(
        "background_keyboard_event",
        "app_process",
        "background_app_shortcut",
      ),
      normalizedKey: "Command+N",
      frontmostRestored: false,
      foregroundRecovery: {
        triggered: true,
        policy: "always",
        reason: "policy_always",
        activationMethod: "running_app_activate",
        targetWindowId: 123,
      },
    });
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: {
          app: "Things",
          key: "Command+N",
          foregroundRecovery: "always",
        },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          pressKey,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(pressKey).toHaveBeenCalledWith({
      app: "Things",
      key: "Command+N",
      foregroundRecovery: "always",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        action: {
          key: "Command+N",
          frontmostRestored: false,
          foregroundRecovery: {
            triggered: true,
            policy: "always",
            reason: "policy_always",
            activationMethod: "running_app_activate",
            targetWindowId: 123,
          },
        },
      },
    });
  });

  it("surfaces native press-key syntax rejections", async () => {
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>();
    pressKey.mockRejectedValue(
      new ComputerUseNativeHelperError(
        "unsupported_command",
        "Unsupported key specification: Launchpad. Use xdotool-style names such as shift+semicolon, Control_L+J, ctrl+alt+n, or BackSpace.",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", key: "Command+Launchpad" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({ pressKey }),
      },
    );

    expect(result).toStrictEqual({
      status: "failed",
      error: {
        code: "unsupported_command",
        message:
          "Unsupported key specification: Launchpad. Use xdotool-style names such as shift+semicolon, Control_L+J, ctrl+alt+n, or BackSpace.",
      },
    });
    expect(pressKey).toHaveBeenCalledWith({
      app: "Safari",
      key: "Command+Launchpad",
      foregroundRecovery: "on-window-unavailable",
    });
  });

  it("types text through native keyboard input without requiring an editable AX focus", async () => {
    const typeText = vi.fn<ComputerUseNativeBackend["typeText"]>();
    typeText.mockResolvedValue(
      nativeDispatchResult(
        "background_keyboard_text",
        "app_process",
        "background_app_text",
      ),
    );
    const result = await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.type_text",
        payload: { app: "Safari", text: "hello" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          typeText,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(result).toMatchObject({
      status: "succeeded",
      result: {
        screenshot: "data:image/png;base64,abc123",
        action: {
          app: "Safari",
          dispatchMode: "background_keyboard_text",
          dispatchTarget: "app_process",
          inputRisk: "background_app_text",
        },
      },
    });
    expect(typeText).toHaveBeenCalledWith({
      app: "Safari",
      text: "hello",
      foregroundRecovery: "on-window-unavailable",
    });
  });

  it("forwards the snapshot id to the native backend for press-key", async () => {
    const pressKey = vi.fn<ComputerUseNativeBackend["pressKey"]>();
    pressKey.mockResolvedValue({
      ...nativeDispatchResult(
        "background_keyboard_event",
        "app_process",
        "background_app_shortcut",
      ),
      normalizedKey: "Command+K",
    });
    await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.press_key",
        payload: { app: "Safari", snapshotId: "snap_1", key: "Command+K" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          pressKey,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(pressKey).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "snap_1",
      key: "Command+K",
      foregroundRecovery: "on-window-unavailable",
    });
  });

  it("forwards the snapshot id to the native backend for type-text", async () => {
    const typeText = vi.fn<ComputerUseNativeBackend["typeText"]>();
    typeText.mockResolvedValue(
      nativeDispatchResult(
        "background_keyboard_text",
        "app_process",
        "background_app_text",
      ),
    );
    await executeComputerUseCommand(
      {
        id: "cmd_1",
        kind: "keyboard.type_text",
        payload: { app: "Safari", snapshotId: "snap_1", text: "hello" },
      },
      { accessibility: true, screenRecording: true },
      {
        platform: "darwin",
        nativeBackend: createNativeBackend({
          typeText,
          getAppState: async (app, snapshotId) => {
            return nativeAppStateWithScreenshot(app, snapshotId);
          },
        }),
      },
    );

    expect(typeText).toHaveBeenCalledWith({
      app: "Safari",
      snapshotId: "snap_1",
      text: "hello",
      foregroundRecovery: "on-window-unavailable",
    });
  });
});

describe("explicit Desktop auth origin", () => {
  it.each([
    ["okou", undefined, "https://app.okou.ai"],
    ["okou", "https://app.okou.ai", "https://app.okou.ai"],
    ["okou", "https://staging-app.omby.ai", "https://staging-app.omby.ai"],
    ["okou", "https://pr-123-app.omby.ai", "https://pr-123-app.omby.ai"],
    [
      "okou",
      "https://app.vm7.ai:8443/path?query=1#hash",
      "https://app.vm7.ai:8443",
    ],
    ["okou", "https://custom.example/path", "https://custom.example"],
    ["okou", "http://localhost:3002", "http://localhost:3002"],
    ["okou", "http://127.0.0.1:3002", "http://127.0.0.1:3002"],
  ])(
    "routes every %s auth entry for %s to %s",
    (product, platformUrl, origin) => {
      const config = resolveDesktopConfig(platformUrl, product);
      expect(config.authUrl.origin).toBe(origin);
      expect(
        buildDesktopAuthStartUrl(config.authUrl, config.identity.authScheme),
      ).toBe(
        `${origin}/desktop-auth/start?callbackScheme=${config.identity.authScheme}`,
      );
      expect(
        buildDesktopAuthConsumeUrl(config.authUrl, "code", "handoff"),
      ).toBe(`${origin}/desktop-auth/consume?code=code&handoffId=handoff`);
      expect(buildDesktopAuthTokenUrl(config.authUrl)).toBe(
        `${origin}/desktop-auth/token`,
      );
      expect(buildDesktopAuthSelectOrgUrl(config.authUrl, true)).toBe(
        `${origin}/desktop-auth/select-org?force=true`,
      );
      expect(config.authPartition).not.toBe(config.sessionPartition);
    },
  );

  it("keeps production API, Marketing and update identity independent from App auth", () => {
    const config = resolveDesktopConfig(undefined, "okou");
    expect(resolveComputerUseApiBaseUrl(config.platformUrl)).toBe(
      "https://api.okou.ai",
    );
    expect(config.webUrl.origin).toBe("https://www.okou.ai");
    expect(config.identity.authScheme).toBe("ai.okou.desktop");
    expect(config.identity.updateLine).toBe("ai-okou-desktop");
    expect(config.sessionPartition).toBe("persist:vm0-desktop-production");
    expect(
      resolveDesktopConfig("https://app.okou.ai", "okou").authPartition,
    ).toBe(config.authPartition);
    expect(
      resolveDesktopConfig("https://pr-123-app.omby.ai", "okou").authPartition,
    ).not.toBe(
      resolveDesktopConfig("https://pr-124-app.omby.ai", "okou").authPartition,
    );
  });
});
