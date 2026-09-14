import type { ClerkUIConstructor } from "@clerk/shared/ui";
import type { ClerkOptions } from "@clerk/shared/types";
import type { ui } from "@clerk/ui";
import type { DebugLoggers } from "./types/global-method";

interface OkouClerkBootstrapRuntime {
  readonly clerk: unknown;
  readonly loaded: Promise<void>;
}

interface OkouClerkBootstrap {
  readonly runtime: Promise<OkouClerkBootstrapRuntime>;
  uiLoaded?: Promise<typeof ui>;
  /**
   * Resolves the hosted UI constructor promise the page passed to its early
   * `clerk.load`. The app calls it once the UI script is available.
   */
  readonly resolveClerkUI: (ui: ClerkUIConstructor) => void;
}

type OkouClerkRouter = NonNullable<ClerkOptions["routerPush"]>;

interface OkouClerkRouterHandlers {
  readonly push: OkouClerkRouter;
  readonly replace: OkouClerkRouter;
}

interface OkouGlobal {
  readonly rootSignal: AbortSignal;
  readonly switchClerkSession: (sessionId: string) => Promise<void>;
  loggers?: DebugLoggers;
  inspectLogs?: () => void;
  getBuildCommitSha?: () => string | null;
  getBuildVersion?: () => string | null;
}

declare global {
  const __OKOU_APP_VERSION__: string;

  interface Window {
    _okou: OkouGlobal | undefined;
    __okouClerkBootstrap?: OkouClerkBootstrap;
    /** Route-owned handlers used by the callbacks captured during Clerk load. */
    __okouClerkRouter?: OkouClerkRouterHandlers;
    __okouClerkUI?: typeof ui;
    /**
     * Set inline in `index.html` at the start of `<head>` parsing. Used by
     * `captureFirstSkeletonHide` to measure total time from page entry to
     * the first time the app skeleton is dismissed.
     */
    __appBootstrapStart?: number;
    /** Set when the entry module graph has finished evaluating. */
    __appBootstrapModuleReady?: number;
    /**
     * Reports whether the main stylesheet became active after crossing a
     * rendering opportunity or failed to load.
     */
    __mainStylesheetLoaded?: Promise<"failed" | "loaded">;
  }
}

export {};
