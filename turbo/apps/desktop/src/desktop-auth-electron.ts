import type { IpcMainInvokeEvent } from "electron";
import { BrowserWindow, ipcMain } from "electron";
import type { DesktopAuthState } from "./desktop-bridge";
import type { DesktopLoginMethod } from "./desktop-login-method";
import { DESKTOP_AUTH_CHANNELS } from "./desktop-auth-ipc-channels";
import type { DesktopAuthWindow } from "./desktop-auth-window";
import { isDesktopRendererUrl } from "./desktop-renderer-url";

interface DesktopAuthIpcOptions {
  readonly rendererUrl: string;
  readonly authWindow: DesktopAuthWindow;
}

interface DesktopAuthNativeApi {
  readonly getState: () => Promise<DesktopAuthState> | DesktopAuthState;
  readonly getLoginMethod: () => {
    readonly method: DesktopLoginMethod;
    readonly nativeAvailable: boolean;
  };
  readonly setLoginMethod: (method: DesktopLoginMethod) => Promise<void>;
  readonly openSignIn: () => Promise<void> | void;
  readonly openOrgSelection: () => Promise<void>;
  readonly signOut: () => Promise<void>;
}

interface DesktopAuthCompleteSignInPayload {
  readonly token: string;
}

export function notifyDesktopAuthChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(DESKTOP_AUTH_CHANNELS.changed);
    }
  }
}

export function installDesktopAuthIpc(
  api: DesktopAuthNativeApi,
  options: DesktopAuthIpcOptions,
): void {
  const assertDesktopRenderer = (event: IpcMainInvokeEvent): void => {
    if (
      !isDesktopRendererUrl(event.senderFrame?.url ?? "", options.rendererUrl)
    ) {
      throw new Error("Desktop auth is unavailable on this page");
    }
  };

  const parseCompleteSignInPayload = (
    value: unknown,
  ): DesktopAuthCompleteSignInPayload => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      /[\s\p{Cc}]/u.test(value.token)
    ) {
      throw new Error("Desktop auth completion requires a token");
    }
    return { token: value.token };
  };

  ipcMain.handle(DESKTOP_AUTH_CHANNELS.getState, (event) => {
    assertDesktopRenderer(event);
    return api.getState();
  });
  ipcMain.handle(DESKTOP_AUTH_CHANNELS.getLoginMethod, (event) => {
    assertDesktopRenderer(event);
    return api.getLoginMethod();
  });
  ipcMain.handle(
    DESKTOP_AUTH_CHANNELS.setLoginMethod,
    async (event, method: unknown) => {
      assertDesktopRenderer(event);
      if (method !== "browser" && method !== "native") {
        throw new Error("Desktop login method is invalid");
      }
      await api.setLoginMethod(method);
    },
  );
  ipcMain.handle(DESKTOP_AUTH_CHANNELS.openSignIn, async (event) => {
    assertDesktopRenderer(event);
    await api.openSignIn();
  });
  ipcMain.handle(DESKTOP_AUTH_CHANNELS.openOrgSelection, async (event) => {
    assertDesktopRenderer(event);
    await api.openOrgSelection();
  });
  ipcMain.handle(DESKTOP_AUTH_CHANNELS.signOut, async (event) => {
    assertDesktopRenderer(event);
    await api.signOut();
  });
  ipcMain.handle(
    DESKTOP_AUTH_CHANNELS.completeSignIn,
    async (event, payload: unknown) => {
      const parsed = parseCompleteSignInPayload(payload);
      options.authWindow.completeSignIn(event, parsed.token);
    },
  );
}
