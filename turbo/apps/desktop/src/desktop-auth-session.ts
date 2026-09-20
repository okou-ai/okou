import { authContract } from "@okouai/api-contracts/contracts/auth";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";
import type { DesktopAuthState } from "./desktop-bridge";
import type { DesktopAuthCallback } from "./desktop-auth";
import type { DesktopClientHeaderInjector } from "./desktop-client-headers";
import { singleFlight } from "./desktop-async-control";

const AUTH_ME_PATH = "/api/auth/me";
const ORG_PATH = "/api/org";

type RunAuthWindow = (
  request: DesktopAuthWindowRequest,
) => Promise<string | null>;

/**
 * `signed_out` is the server's authoritative answer: the session is gone and
 * only an interactive sign-in restores it. `unavailable` means the attempt
 * never reached that answer, so a later retry can still succeed.
 */
export type DesktopAuthRestoreFailure = "signed_out" | "unavailable";

export type DesktopAuthRefreshEvent =
  | { readonly phase: "started"; readonly signal: AbortSignal }
  | {
      readonly phase: "completed";
      readonly signal: AbortSignal;
      readonly identity: "initial" | "same" | "changed";
    }
  | {
      readonly phase: "failed";
      readonly signal: AbortSignal;
      readonly classification: DesktopAuthRestoreFailure;
      readonly cause: unknown;
    };

export interface DesktopAuthRequestOptions {
  /** Stateful callers can let their fresh runtime own retry after auth refresh. */
  readonly retryAfterRefresh?: boolean;
  /** A recovery attempt must not open another refresh cycle after rejection. */
  readonly refreshOn401?: boolean;
}

interface DesktopAuthSessionOptions {
  /** Pre-resolved API base URL (`resolveComputerUseApiBaseUrl(platformUrl)`). */
  readonly apiBaseUrl: string;
  readonly addClientHeaders: DesktopClientHeaderInjector;
  /** `buildDesktopAuthTokenUrl(authUrl)`. */
  readonly tokenUrl: string;
  /** `buildDesktopAuthConsumeUrl(authUrl, code, handoffId)`. */
  readonly consumeUrl: (code: string, handoffId: string | null) => string;
  /** `buildDesktopAuthSelectOrgUrl(authUrl, true)`. */
  readonly selectOrgUrl: string;
  readonly runAuthWindow: RunAuthWindow;
  /** Zero-arg "something changed" signal; defaults to a no-op. */
  readonly onChange?: () => void;
  /**
   * Invoked after an interactive consume / org-selection flow completes, so the
   * caller can restart dependent runtimes. Background token refresh does NOT
   * trigger it.
   */
  readonly onAuthCompleted?: (signal: AbortSignal) => Promise<void> | void;
  /** Synchronous lifecycle notification; dependent recovery must not block auth. */
  readonly onBackgroundRefresh?: (event: DesktopAuthRefreshEvent) => void;
}

function signedOutDesktopAuthState(): DesktopAuthState {
  return {
    status: "signed_out",
    user: null,
    organization: null,
  };
}

function signingInDesktopAuthState(): DesktopAuthState {
  return {
    status: "signing_in",
    user: null,
    organization: null,
  };
}

/**
 * Owns the desktop auth token state machine, extracted from `main.ts` and kept
 * free of Electron imports so it can be integration-tested by injecting fakes,
 * mirroring `ComputerUseHostRuntime`'s dependency-injection shape.
 */
export class DesktopAuthSession {
  private readonly apiBaseUrl: string;
  private readonly addClientHeaders: DesktopClientHeaderInjector;
  private readonly tokenUrl: string;
  private readonly consumeUrl: (
    code: string,
    handoffId: string | null,
  ) => string;
  private readonly selectOrgUrl: string;
  private readonly runAuthWindow: RunAuthWindow;
  private readonly onChange: () => void;
  private readonly onAuthCompleted: (
    signal: AbortSignal,
  ) => Promise<void> | void;
  private readonly onBackgroundRefresh: (
    event: DesktopAuthRefreshEvent,
  ) => void;

  private token: string | null = null;
  private lifetime = new AbortController();
  private appState: DesktopAuthState = signedOutDesktopAuthState();
  private readonly tokenRefresh = singleFlight(() => this.refreshToken());
  private pendingCallback: DesktopAuthCallback | null = null;
  private signingIn = false;
  private restoreEnabled = true;
  private restorePaused = false;
  private authority: {
    readonly userId: string;
    readonly orgId: string;
    readonly lifetime: AbortSignal;
  } | null = null;

  /** Opaque, current identity/session proof. Never sent over the renderer bridge. */
  getAuthority(): object | null {
    return !this.signingIn && !this.lifetime.signal.aborted
      ? this.authority
      : null;
  }

  private rememberAuthority(
    state: DesktopAuthState,
    lifetime: AbortController,
  ): boolean {
    if (this.lifetime !== lifetime || lifetime.signal.aborted) return false;
    const next =
      state.status === "signed_in" && state.organization
        ? {
            userId: state.user.userId,
            orgId: state.organization.id,
            lifetime: lifetime.signal,
          }
        : null;
    if (
      this.authority?.userId === next?.userId &&
      this.authority?.orgId === next?.orgId &&
      this.authority?.lifetime === next?.lifetime
    )
      return false;
    this.authority = next;
    return true;
  }

  constructor(options: DesktopAuthSessionOptions) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.addClientHeaders = options.addClientHeaders;
    this.tokenUrl = options.tokenUrl;
    this.consumeUrl = options.consumeUrl;
    this.selectOrgUrl = options.selectOrgUrl;
    this.runAuthWindow = options.runAuthWindow;
    this.onChange = options.onChange ?? (() => {});
    this.onAuthCompleted = options.onAuthCompleted ?? (() => {});
    this.onBackgroundRefresh = options.onBackgroundRefresh ?? (() => {});
  }

  async getToken(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<string | null> {
    if (this.signingIn) return null;
    if (!options?.forceRefresh && this.token) {
      return this.token;
    }
    if (!this.restoreEnabled || this.restorePaused) {
      return null;
    }
    return await this.refresh();
  }

  /** False once restoration needs an interactive sign-in. */
  canRestoreSession(): boolean {
    return this.restoreEnabled;
  }

  /**
   * Re-arms a restoration paused by an indeterminate failure, so a paced
   * recovery owns the retry instead of every state read reopening the window.
   * An authoritative sign-out is never re-armed here.
   */
  requestRestoreRetry(): boolean {
    if (!this.restoreEnabled || !this.restorePaused) {
      return false;
    }
    this.restorePaused = false;
    return true;
  }

  /**
   * `init` carries the method and body for non-GET calls. Its `headers` are
   * merged under the session headers, which always win, so a caller cannot
   * accidentally drop the bearer token.
   */
  async fetchWithSessionAuth(
    requestUrl: URL,
    init?: RequestInit,
    options?: DesktopAuthRequestOptions,
  ): Promise<Response> {
    return await this.fetchWithAppAuth(requestUrl, init, options);
  }

  getCachedToken(): string | null {
    return this.token;
  }

  async getAuthState(): Promise<DesktopAuthState> {
    if (this.signingIn) {
      return signingInDesktopAuthState();
    }
    if (!this.restoreEnabled) {
      return signedOutDesktopAuthState();
    }

    return await this.getAppAuthState();
  }

  signOut(): void {
    this.lifetime.abort();
    this.authority = null;
    this.token = null;
    this.appState = signedOutDesktopAuthState();
    this.tokenRefresh.clear();
    this.pendingCallback = null;
    this.signingIn = false;
    this.restoreEnabled = false;
    this.restorePaused = false;
    this.onChange();
  }

  async consumeCode(
    code: string,
    handoffId: string | null = null,
  ): Promise<void> {
    this.tokenRefresh.clear();
    await this.authenticate(this.consumeUrl(code, handoffId), true, false);
  }

  async selectOrganization(): Promise<void> {
    this.tokenRefresh.clear();
    await this.authenticate(this.selectOrgUrl, true, true);
  }

  /**
   * Fire-and-forget consume of a parsed auth callback, so callers just hand
   * the session a callback instead of re-implementing the consume plumbing.
   */
  consumeCallback(
    callback: DesktopAuthCallback,
    onError: (error: unknown) => void,
  ): void {
    void this.consumeCode(callback.code, callback.handoffId).catch(onError);
  }

  queuePendingCallback(callback: DesktopAuthCallback): void {
    this.pendingCallback = callback;
  }

  takePendingCallback(): DesktopAuthCallback | null {
    const callback = this.pendingCallback;
    this.pendingCallback = null;
    return callback;
  }

  private async refresh(): Promise<string | null> {
    return await this.tokenRefresh();
  }

  private async refreshToken(): Promise<string | null> {
    try {
      return await this.authenticate(this.tokenUrl, false, false);
    } catch {
      // A failed App restoration requires explicit sign-in, never another
      // identity source. Interactive failures still reject to the caller.
      return null;
    }
  }

  private async authenticate(
    url: string,
    interactive: boolean,
    visible: boolean,
  ): Promise<string | null> {
    const previousState = this.appState;
    let deniedBySession = false;
    let failureCause: unknown = null;
    this.lifetime.abort();
    const lifetime = new AbortController();
    this.lifetime = lifetime;
    this.authority = null;
    this.restoreEnabled = true;
    this.restorePaused = false;
    this.token = null;
    this.appState = signedOutDesktopAuthState();
    if (!interactive)
      this.onBackgroundRefresh({ phase: "started", signal: lifetime.signal });
    this.setSigningIn(interactive);
    // Even a hidden token restoration replaces session execution authority.
    this.onChange();
    // The lifetime also owns validation requests after the window closes.
    const signal = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      const token = await this.runAuthWindow({
        url,
        visible,
        allowInteractiveFallbacks: interactive,
        signal,
      });
      signal.throwIfAborted();
      if (!token) {
        // A hidden restore resolves without a token only when the auth app
        // sent it back to sign-in or workspace selection: the session is gone.
        deniedBySession = true;
        return null;
      }
      const state = await this.readAppIdentity(token, signal);
      signal.throwIfAborted();
      if (state.status !== "signed_in") {
        deniedBySession = true;
        return null;
      }
      this.appState = state;
      this.token = token;
      this.rememberAuthority(state, lifetime);
      if (!interactive) {
        this.onBackgroundRefresh({
          phase: "completed",
          signal: lifetime.signal,
          identity:
            previousState.status !== "signed_in" || !previousState.organization
              ? "initial"
              : previousState.user.userId === state.user.userId &&
                  previousState.organization.id === state.organization?.id
                ? "same"
                : "changed",
        });
      }
      this.onChange();
      lifetime.signal.throwIfAborted();
      if (interactive) {
        this.setSigningIn(false);
        await this.onAuthCompleted(lifetime.signal);
        lifetime.signal.throwIfAborted();
      }
      return token;
    } catch (error) {
      failureCause = error;
      if (this.lifetime === lifetime) {
        this.token = null;
        this.appState = signedOutDesktopAuthState();
        this.authority = null;
      }
      if (!interactive && signal.aborted) return null;
      throw error;
    } finally {
      if (this.lifetime === lifetime) {
        if (!this.token) {
          // Notify renderer/tray subscribers, and keep their reads from
          // reopening a failed hidden restore. An authoritative denial waits
          // for an explicit sign-in; anything else only pauses restoration
          // until a paced recovery re-arms it, so a transient failure cannot
          // strand a signed-in user.
          if (deniedBySession) this.restoreEnabled = false;
          else this.restorePaused = true;
          if (!interactive && !lifetime.signal.aborted)
            this.onBackgroundRefresh({
              phase: "failed",
              signal: lifetime.signal,
              classification: deniedBySession ? "signed_out" : "unavailable",
              cause: failureCause,
            });
          this.onChange();
        }
        this.setSigningIn(false);
      }
    }
  }

  private async appRequest(
    requestUrl: URL,
    token: string,
    signal: AbortSignal,
    init?: RequestInit,
  ): Promise<Response> {
    if (requestUrl.origin !== new URL(this.apiBaseUrl).origin) {
      throw new Error("Invalid Desktop API origin");
    }
    signal.throwIfAborted();
    const headers = new Headers(init?.headers);
    headers.delete("cookie");
    headers.set("authorization", `Bearer ${token}`);
    this.addClientHeaders(headers);
    const response = await fetch(requestUrl, {
      ...init,
      headers,
      credentials: "omit",
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
    signal.throwIfAborted();
    return response;
  }

  private async readAppIdentity(
    token: string,
    signal: AbortSignal,
  ): Promise<DesktopAuthState> {
    const me = await this.appRequest(
      new URL(AUTH_ME_PATH, this.apiBaseUrl),
      token,
      signal,
    );
    if (me.status === 401) return signedOutDesktopAuthState();
    if (!me.ok) throw new Error(`Desktop auth status failed: ${me.status}`);
    const user = authContract.me.responses[200].parse(await me.json());
    signal.throwIfAborted();
    if (!user.userId) return signedOutDesktopAuthState();
    // Signed in without an active workspace is a state the user resolves by
    // selecting one. Reporting it as signed out would demand a pointless
    // sign-in and discard a valid session.
    if (!user.orgId)
      return {
        status: "signed_in",
        user: { userId: user.userId, email: user.email },
        organization: null,
      };
    // Both reads use the identical server-verified bearer; never refresh only
    // the second half of the user/workspace pair.
    const org = await this.appRequest(
      new URL(ORG_PATH, this.apiBaseUrl),
      token,
      signal,
    );
    if (org.status === 401 || org.status === 404)
      return signedOutDesktopAuthState();
    if (!org.ok)
      throw new Error(`Desktop organization status failed: ${org.status}`);
    const organization: unknown = await org.json();
    signal.throwIfAborted();
    if (
      typeof organization !== "object" ||
      organization === null ||
      !("id" in organization) ||
      organization.id !== user.orgId ||
      !("name" in organization) ||
      typeof organization.name !== "string"
    ) {
      // An unreadable payload is not the server denying the session. Failing
      // here keeps a signed-out verdict authoritative.
      throw new Error("Desktop organization payload is unusable");
    }
    return {
      status: "signed_in",
      user: { userId: user.userId, email: user.email },
      organization: { id: user.orgId, name: organization.name },
    };
  }

  private async getAppAuthState(): Promise<DesktopAuthState> {
    if (!this.token) {
      await this.getToken();
      return this.appState;
    }
    const lifetime = this.lifetime;
    try {
      const state = await this.readAppIdentity(this.token, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (state.status === "signed_in") {
        this.appState = state;
        if (this.rememberAuthority(state, lifetime)) this.onChange();
        return state;
      }
      await this.getToken({ forceRefresh: true });
      return this.appState;
    } catch (error) {
      if (lifetime.signal.aborted) return signedOutDesktopAuthState();
      if (this.rememberAuthority(signedOutDesktopAuthState(), lifetime))
        this.onChange();
      throw error;
    }
  }

  private async fetchWithAppAuth(
    requestUrl: URL,
    init?: RequestInit,
    options?: DesktopAuthRequestOptions,
  ): Promise<Response> {
    const token = await this.getToken();
    if (!token || token !== this.token)
      return new Response(null, { status: 401 });
    const lifetime = this.lifetime;
    const previousState = this.appState;
    const response = await this.appRequest(
      requestUrl,
      token,
      lifetime.signal,
      init,
    );
    if (response.status !== 401 || options?.refreshOn401 === false)
      return response;
    // No cookie-only retry. One App refresh and at most one authenticated retry.
    const refresh = this.getToken({ forceRefresh: true });
    const refreshLifetime = this.lifetime;
    const refreshed = await refresh;
    // A successful refresh is not permission to replay another identity's request.
    if (
      options?.retryAfterRefresh === false ||
      !refreshed ||
      refreshed !== this.token ||
      refreshLifetime !== this.lifetime ||
      previousState.status !== "signed_in" ||
      !previousState.organization ||
      this.appState.status !== "signed_in" ||
      previousState.user.userId !== this.appState.user.userId ||
      previousState.organization.id !== this.appState.organization?.id
    )
      return response;
    const retried = await this.appRequest(
      requestUrl,
      refreshed,
      this.lifetime.signal,
      init,
    );
    if (retried.status === 401) {
      this.restoreEnabled = false;
      this.token = null;
      this.appState = signedOutDesktopAuthState();
      this.authority = null;
      this.onChange();
    }
    return retried;
  }

  private setSigningIn(value: boolean): void {
    if (this.signingIn === value) {
      return;
    }
    this.signingIn = value;
    this.onChange();
  }
}
