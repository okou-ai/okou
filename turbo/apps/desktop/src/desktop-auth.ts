const DESKTOP_AUTH_HOST = "auth";
const DESKTOP_AUTH_CALLBACK_PATH = "/callback";
const DESKTOP_AUTH_CONSUME_PATH = "/desktop-auth/consume";
const DESKTOP_AUTH_SELECT_ORG_PATH = "/desktop-auth/select-org";
const DESKTOP_AUTH_START_WEB_PATH = "/desktop-auth/start";
const DESKTOP_AUTH_TOKEN_PATH = "/desktop-auth/token";
const DESKTOP_AUTH_CALLBACK_SCHEME_PARAM = "callbackScheme";
const DESKTOP_AUTH_FORCE_ORG_SELECTION_PARAM = "force";
const DESKTOP_AUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const DESKTOP_AUTH_HANDOFF_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DESKTOP_AUTH_COMPLETION_PATH_PATTERN = /^\/(?:en|de|ja|es)\/?$/;
const DESKTOP_AUTH_START_RETRY_MS = 30_000;
const ELECTRON_ERR_ABORTED = -3;

export interface DesktopAuthCallback {
  readonly code: string;
  readonly handoffId: string | null;
}

interface DesktopAuthStartGate {
  readonly shouldOpen: () => boolean;
  readonly suppressRetry: () => void;
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isElectronNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const electronError = error as {
    readonly code?: unknown;
    readonly errno?: unknown;
  };
  return (
    electronError.code === "ERR_ABORTED" ||
    electronError.errno === ELECTRON_ERR_ABORTED
  );
}

/**
 * The auth attempt was abandoned on purpose — superseded by a newer one,
 * cancelled with the auth storage, or torn down with its window — rather than
 * failing to reach an answer. The session layer recognises it by type, so it
 * lives beside the other shared auth helpers instead of in the window module,
 * which cannot be imported without pulling Electron in behind it.
 */
export class DesktopAuthTeardownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopAuthTeardownError";
  }
}

export function parseDesktopAuthCallback(
  rawUrl: string,
  authScheme: string,
): DesktopAuthCallback | null {
  const url = parseUrl(rawUrl);
  if (!url) {
    return null;
  }

  const code = url.searchParams.get("code");
  const handoffId = url.searchParams.get("handoffId");
  if (
    url.protocol !== `${authScheme}:` ||
    url.hostname !== DESKTOP_AUTH_HOST ||
    url.pathname !== DESKTOP_AUTH_CALLBACK_PATH ||
    !code ||
    !DESKTOP_AUTH_CODE_PATTERN.test(code) ||
    (handoffId !== null && !DESKTOP_AUTH_HANDOFF_ID_PATTERN.test(handoffId))
  ) {
    return null;
  }

  return { code, handoffId };
}

export function parseDesktopAuthCallbackArgv(
  argv: readonly string[],
  authScheme: string,
): DesktopAuthCallback | null {
  for (const arg of argv) {
    const callback = parseDesktopAuthCallback(arg, authScheme);
    if (callback) {
      return callback;
    }
  }

  return null;
}

export function buildDesktopAuthConsumeUrl(
  authUrl: URL,
  code: string,
  handoffId: string | null = null,
): string {
  const consumeUrl = new URL(DESKTOP_AUTH_CONSUME_PATH, authUrl);
  consumeUrl.searchParams.set("code", code);
  if (handoffId) {
    consumeUrl.searchParams.set("handoffId", handoffId);
  }
  return consumeUrl.toString();
}

export function buildDesktopAuthSelectOrgUrl(
  authUrl: URL,
  forceSelection = false,
): string {
  const selectOrgUrl = new URL(DESKTOP_AUTH_SELECT_ORG_PATH, authUrl);
  if (forceSelection) {
    selectOrgUrl.searchParams.set(
      DESKTOP_AUTH_FORCE_ORG_SELECTION_PARAM,
      "true",
    );
  }
  return selectOrgUrl.toString();
}

export function buildDesktopAuthStartUrl(
  authUrl: URL,
  authScheme: string,
): string {
  const startUrl = new URL(DESKTOP_AUTH_START_WEB_PATH, authUrl);
  startUrl.searchParams.set(DESKTOP_AUTH_CALLBACK_SCHEME_PARAM, authScheme);
  return startUrl.toString();
}

export function buildDesktopAuthTokenUrl(authUrl: URL): string {
  return new URL(DESKTOP_AUTH_TOKEN_PATH, authUrl).toString();
}

export function isDesktopAuthStartNavigation(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const url = parseUrl(rawUrl);
  return Boolean(
    url &&
    allowedAppOrigins.has(url.origin) &&
    url.pathname === DESKTOP_AUTH_START_WEB_PATH,
  );
}

export function isDesktopAuthSelectOrgNavigation(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const url = parseUrl(rawUrl);
  return Boolean(
    url &&
    allowedAppOrigins.has(url.origin) &&
    url.pathname === DESKTOP_AUTH_SELECT_ORG_PATH,
  );
}

export function isDesktopAuthCompletionNavigation(
  rawUrl: string,
  allowedAppOrigins: ReadonlySet<string>,
): boolean {
  const url = parseUrl(rawUrl);
  return Boolean(
    url &&
    allowedAppOrigins.has(url.origin) &&
    (url.pathname === "/" ||
      DESKTOP_AUTH_COMPLETION_PATH_PATTERN.test(url.pathname)),
  );
}

export function createDesktopAuthStartGate(
  now: () => number = Date.now,
): DesktopAuthStartGate {
  let openedAtMs: number | null = null;

  return {
    shouldOpen: () => {
      const currentMs = now();
      if (
        openedAtMs !== null &&
        currentMs - openedAtMs < DESKTOP_AUTH_START_RETRY_MS
      ) {
        return false;
      }

      openedAtMs = currentMs;
      return true;
    },
    suppressRetry: () => {
      openedAtMs = now();
    },
  };
}
