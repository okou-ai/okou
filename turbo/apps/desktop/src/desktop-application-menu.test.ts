import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { DesktopApplicationMenu } from "./desktop-application-menu";
import { DeveloperToolsController } from "./desktop-developer-tools-controller";

const native = vi.hoisted(() => ({
  installed: [] as MenuItemConstructorOptions[][],
  onBuild: () => {},
  onInstall: () => {},
}));
vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      native.onBuild();
      return template;
    },
    setApplicationMenu: (menu: MenuItemConstructorOptions[]) => {
      native.installed.push(menu);
      native.onInstall();
    },
  },
}));
beforeEach(() => {
  native.installed = [];
  native.onBuild = () => {};
  native.onInstall = () => {};
});

function appMenuItem(label: string) {
  const submenu = native.installed.at(-1)?.[0]?.submenu;
  if (!Array.isArray(submenu)) throw new Error("No application submenu");
  return submenu.find((item) => item.label === label);
}

function clickDeveloperTools() {
  const click = appMenuItem("Developer Tools")?.click;
  if (!click) throw new Error("No developer checkbox");
  // Electron invokes this descriptor's zero-argument click callback.
  Reflect.apply(click, undefined, []);
}

async function application() {
  let updatesEnabled = false;
  const authority = {};
  const developer = new DeveloperToolsController({
    getSessionAuthority: () => authority,
    fetchFeatureSwitches: async () =>
      new Response(JSON.stringify({ effectiveSwitches: { _debug: true } })),
    setFilesystemPluginFeatureEnabled: () => {},
    onChange: () => menu.refresh(),
  });
  const menu = new DesktopApplicationMenu({
    displayName: "Okou",
    developerTools: developer,
    updatesEnabled: () => updatesEnabled,
    checkForUpdates: () => {},
    quit: () => {},
  });
  onTestFinished(() => menu.dispose());
  developer.requestRefresh();
  await vi.waitFor(() => {
    expect(appMenuItem("Developer Tools")?.checked).toBe(false);
  });
  return {
    menu,
    developer,
    installUpdater: () => {
      updatesEnabled = true;
      menu.refresh();
    },
  };
}

describe("application menu event boundary", () => {
  it("defers native installation until after a developer checkbox callback returns", async () => {
    const app = await application();
    const before = native.installed.length;
    clickDeveloperTools();
    expect(app.developer.getState().enabled).toBe(true);
    expect(native.installed).toHaveLength(before);
    await nextTurn();
    expect(appMenuItem("Developer Tools")?.checked).toBe(true);
    expect(native.installed).toHaveLength(before + 1);
  });

  it("coalesces repeated window, driver and updater requests using the latest state", async () => {
    const app = await application();
    const before = native.installed.length;
    app.menu.refresh();
    app.installUpdater();
    app.developer.setEnabled(true);
    app.menu.refresh();
    await nextTurn();
    expect(native.installed).toHaveLength(before + 1);
    expect(appMenuItem("Developer Tools")?.checked).toBe(true);
    expect(appMenuItem("Check for Updates...")?.enabled).toBe(true);
  });

  it("never nests native installation and eventually applies a change made during installation", async () => {
    const app = await application();
    let depth = 0;
    let maxDepth = 0;
    let changed = false;
    native.onInstall = () => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      if (!changed) {
        changed = true;
        app.developer.setEnabled(true);
      }
      depth--;
    };
    app.installUpdater();
    await vi.waitFor(() => {
      expect(appMenuItem("Developer Tools")?.checked).toBe(true);
    });
    expect(maxDepth).toBe(1);
  });

  it("handles two clicks before the pending menu is installed", async () => {
    const app = await application();
    const before = native.installed.length;
    clickDeveloperTools();
    clickDeveloperTools();
    expect(app.developer.getState().enabled).toBe(false);
    await nextTurn();
    expect(appMenuItem("Developer Tools")?.checked).toBe(false);
    expect(native.installed).toHaveLength(before);
  });

  it("settles unchanged refresh requests made by native installation", async () => {
    const app = await application();
    const before = native.installed.length;
    native.onInstall = () => app.menu.refresh();
    app.installUpdater();
    await nextTurn();
    await nextTurn();
    expect(appMenuItem("Check for Updates...")?.enabled).toBe(true);
    expect(native.installed).toHaveLength(before + 1);
  });

  it.each(["queued", "building", "installing"] as const)(
    "discards pending menu work when shutdown starts while %s",
    async (phase) => {
      const app = await application();
      const before = native.installed.length;
      const shutdown = () => {
        app.menu.refresh();
        app.menu.dispose();
        app.menu.refresh();
      };
      if (phase === "building") native.onBuild = shutdown;
      if (phase === "installing") native.onInstall = shutdown;
      app.installUpdater();
      if (phase === "queued") shutdown();
      await nextTurn();
      await nextTurn();
      expect(native.installed).toHaveLength(
        before + (phase === "installing" ? 1 : 0),
      );
    },
  );
});
