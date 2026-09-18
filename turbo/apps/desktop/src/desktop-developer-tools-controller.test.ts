import { describe, expect, it, vi } from "vitest";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createController(
  fetchFeatureSwitches: () => Promise<Response> = async () =>
    jsonResponse({ effectiveSwitches: { _debug: true } }),
) {
  const onChange = vi.fn();
  const setFilesystemPluginFeatureEnabled = vi.fn();
  const logRefreshError = vi.fn();
  const fetchSwitches = vi.fn(fetchFeatureSwitches);
  const sessionAuthority = {};
  const controller = new DeveloperToolsController({
    getSessionAuthority: () => sessionAuthority,
    fetchFeatureSwitches: fetchSwitches,
    setFilesystemPluginFeatureEnabled,
    onChange,
    logRefreshError,
  });
  return {
    controller,
    fetchSwitches,
    onChange,
    setFilesystemPluginFeatureEnabled,
    logRefreshError,
  };
}

describe("DeveloperToolsController", () => {
  it("starts unavailable and ignores setEnabled until available", () => {
    const { controller, onChange } = createController();

    expect(controller.getState()).toEqual({ available: false, enabled: false });
    expect(controller.setEnabled(true)).toEqual({
      available: false,
      enabled: false,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("becomes available from effectiveSwitches and propagates the plugin switch", async () => {
    const { controller, onChange, setFilesystemPluginFeatureEnabled } =
      createController(async () =>
        jsonResponse({
          effectiveSwitches: {
            _debug: true,
            computerUseDesktopPlugins: true,
          },
        }),
      );

    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(controller.getState().available).toBe(true);
    });

    expect(onChange).toHaveBeenCalled();
    expect(setFilesystemPluginFeatureEnabled).toHaveBeenCalledWith(true);
  });

  it("reads the legacy switches shape", async () => {
    const { controller } = createController(async () =>
      jsonResponse({ switches: { _debug: true } }),
    );

    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(controller.getState().available).toBe(true);
    });
  });

  it("toggles enabled once available and drops enabled when availability is lost", async () => {
    const responses = [
      jsonResponse({ effectiveSwitches: { _debug: true } }),
      new Response(null, { status: 401 }),
    ];
    const { controller, setFilesystemPluginFeatureEnabled } = createController(
      async () => responses.shift() ?? jsonResponse({}),
    );
    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(controller.getState().available).toBe(true);
    });

    expect(controller.setEnabled(true)).toEqual({
      available: true,
      enabled: true,
    });

    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(controller.getState()).toEqual({
        available: false,
        enabled: false,
      });
    });
    expect(setFilesystemPluginFeatureEnabled).toHaveBeenLastCalledWith(false);
  });

  it("logs and releases feature-gated resources when a refresh fails", async () => {
    const responses = [
      jsonResponse({
        effectiveSwitches: {
          _debug: true,
          computerUseDesktopPlugins: true,
        },
      }),
      new Response(null, { status: 500 }),
    ];
    const { controller, logRefreshError, setFilesystemPluginFeatureEnabled } =
      createController(async () => responses.shift() ?? jsonResponse({}));

    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(setFilesystemPluginFeatureEnabled).toHaveBeenLastCalledWith(true);
    });

    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(logRefreshError).toHaveBeenCalledOnce();
    });
    expect(controller.getState()).toEqual({ available: false, enabled: false });
    expect(setFilesystemPluginFeatureEnabled).toHaveBeenLastCalledWith(false);
  });

  it("coalesces refreshes requested while one is in flight", async () => {
    let release: (() => void) | undefined;
    const { controller, fetchSwitches } = createController(async () => {
      if (!release) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return jsonResponse({ effectiveSwitches: { _debug: true } });
    });

    controller.requestRefresh();
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    controller.requestRefresh();
    controller.requestRefresh();
    release?.();

    await vi.waitFor(() => {
      expect(controller.getState().available).toBe(true);
      expect(fetchSwitches).toHaveBeenCalledTimes(2);
    });
  });
});
