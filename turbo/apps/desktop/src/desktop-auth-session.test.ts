import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  DesktopAuthSession,
  type DesktopAuthRefreshEvent,
} from "./desktop-auth-session";
import { resolveDesktopConfig } from "./config";
import {
  buildDesktopAuthConsumeUrl,
  buildDesktopAuthSelectOrgUrl,
  buildDesktopAuthTokenUrl,
  DesktopAuthTeardownError,
} from "./desktop-auth";
import { DesktopQuitConfirmationController } from "./desktop-quit-confirmation";
import { createDesktopClientHeaderInjector } from "./desktop-client-headers";
import type { DesktopAuthWindowRequest } from "./desktop-auth-window";

const api = "https://api.okou.ai";
const signedOut = { status: "signed_out", user: null, organization: null };
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  // A substituted deadline that outlives its own test would silently rewrite
  // every deadline after it, so restoring is teardown rather than a courtesy.
  vi.restoreAllMocks();
});
afterAll(() => server.close());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createSession(
  onChange?: (session: DesktopAuthSession) => void,
  onBackgroundRefresh?: (
    event: DesktopAuthRefreshEvent,
    session: DesktopAuthSession,
  ) => void,
) {
  const config = resolveDesktopConfig();
  const windows: DesktopAuthWindowRequest[] = [];
  const replies: Promise<string | null>[] = [];
  const completed: string[] = [];
  const changes: (string | null)[] = [];
  const refreshes: DesktopAuthRefreshEvent[] = [];
  const session = new DesktopAuthSession({
    apiBaseUrl: api,

    addClientHeaders: createDesktopClientHeaderInjector({
      clientVersion: "0.46.28",
    }),
    tokenUrl: buildDesktopAuthTokenUrl(config.authUrl),
    selectOrgUrl: buildDesktopAuthSelectOrgUrl(config.authUrl, true),
    consumeUrl: (code, id) =>
      buildDesktopAuthConsumeUrl(config.authUrl, code, id),
    runAuthWindow: async (request) => {
      windows.push(request);
      return await (replies.shift() ?? Promise.resolve(null));
    },
    onChange: () => {
      changes.push(session.getCachedToken());
      onChange?.(session);
    },
    onAuthCompleted: () => {
      completed.push("completed");
    },
    onBackgroundRefresh: (event) => {
      refreshes.push(event);
      onBackgroundRefresh?.(event, session);
    },
  });
  return { session, windows, replies, completed, changes, refreshes };
}

function sessionToken(expiresInSeconds: number, label: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + expiresInSeconds }),
  ).toString("base64url");
  return `header.${payload}.${label}`;
}

function identityHandlers(
  options: { userId?: string; orgId?: string; observed?: string[] } = {},
) {
  server.use(
    http.get(`${api}/api/auth/me`, ({ request }) => {
      const token = request.headers.get("authorization");
      options.observed?.push(`me:${token}`);
      expect(request.headers.get("cookie")).toBeNull();
      return HttpResponse.json({
        userId: options.userId ?? token,
        email: "app@example.test",
        orgId: "app-org",
      });
    }),
    http.get(`${api}/api/org`, ({ request }) => {
      const token = request.headers.get("authorization");
      options.observed?.push(`org:${token}`);
      expect(request.headers.get("cookie")).toBeNull();
      return HttpResponse.json({
        id: options.orgId ?? "app-org",
        name: "App workspace",
      });
    }),
  );
}

describe("Okou App session authority", () => {
  it("joins hidden restoration when a change subscriber synchronously reads auth state", async () => {
    identityHandlers();
    const reads: ReturnType<DesktopAuthSession["getAuthState"]>[] = [];
    let depth = 0;
    const { session, replies, windows } = createSession((current) => {
      // Safety cap only for the red run against the original implementation.
      if (depth === 8) return;
      depth++;
      reads.push(current.getAuthState());
      depth--;
    });
    const result = deferred<string | null>();
    replies.push(result.promise);
    const startup = session.getAuthState();
    const requestsAtEntry = windows.length;
    result.resolve("restored");
    await startup;
    for (let settled = 0; settled < reads.length; ) {
      const pending = reads.slice(settled);
      settled = reads.length;
      await Promise.all(pending);
    }

    expect(requestsAtEntry).toBe(1);
    expect(windows).toHaveLength(1);
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_in",
      user: { userId: "Bearer restored" },
    });
    expect(session.getAuthority()).not.toBeNull();
  });

  it("requires a fresh App token before any native request despite legacy cookie-only API success", async () => {
    const { session, windows } = createSession();
    const requests: string[] = [];
    server.use(
      http.get(`${api}/*`, ({ request }) => {
        requests.push(request.url);
        return HttpResponse.json({
          userId: "legacy-user",
          orgId: "legacy-org",
        });
      }),
    );
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(
      (
        await session.fetchWithSessionAuth(new URL(`${api}/api/protected`), {
          headers: {
            cookie: "__session=legacy",
            authorization: "Bearer injected",
          },
        })
      ).status,
    ).toBe(401);
    expect(requests).toEqual([]);
    expect(windows.map((w) => w.url)).toEqual([
      "https://app.okou.ai/desktop-auth/token",
    ]);
  });

  it("restores matching user/org under one bearer and preserves native client headers", async () => {
    const { session, replies } = createSession();
    const observed: string[] = [];
    identityHandlers({ observed });
    replies.push(Promise.resolve("fresh"));
    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "Bearer fresh", email: "app@example.test" },
      organization: { id: "app-org", name: "App workspace" },
    });
    server.use(
      http.post(`${api}/api/protected`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer fresh");
        expect(request.headers.get("cookie")).toBeNull();
        expect(request.credentials).toBe("omit");
        expect(request.redirect).toBe("error");
        expect(request.headers.get("x-client-type")).toBe("Desktop");
        expect(request.headers.get("x-client-version")).toBe("0.46.28");
        return HttpResponse.json(await request.json());
      }),
    );
    const response = await session.fetchWithSessionAuth(
      new URL(`${api}/api/protected`),
      {
        method: "POST",
        body: JSON.stringify({ action: "test" }),
        headers: { cookie: "legacy", authorization: "Bearer wrong" },
        credentials: "include",
        redirect: "follow",
      },
    );
    expect(await response.json()).toEqual({ action: "test" });
    expect(observed).toEqual(["me:Bearer fresh", "org:Bearer fresh"]);
  });

  it("rejects mismatching bearer user/org responses before exposing a cached token", async () => {
    const { session, replies } = createSession();
    identityHandlers({ orgId: "other-org" });
    replies.push(Promise.resolve("fresh"));
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(session.getCachedToken()).toBeNull();
  });

  it("pauses restoration after an unavailable attempt and re-arms it on request", async () => {
    const { session, replies, windows, refreshes } = createSession();
    identityHandlers();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getAuthState();
    failWindow(new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(await pending).toEqual(signedOut);
    expect(refreshes.at(-1)).toMatchObject({
      phase: "failed",
      classification: "unavailable",
    });
    expect(session.canRestoreSession()).toBe(true);

    // A paused restore must not reopen the window on every state read.
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(windows).toHaveLength(1);

    expect(session.requestRestoreRetry()).toBe(true);
    replies.push(Promise.resolve("restored"));
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_in",
      organization: { id: "app-org" },
    });
    expect(windows).toHaveLength(2);
  });

  it("stops restoring once the auth app denies the session", async () => {
    const { session, windows, refreshes } = createSession();

    // The default window reply resolves without a token: sign-in is required.
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(refreshes.at(-1)).toMatchObject({
      phase: "failed",
      classification: "signed_out",
    });
    expect(session.canRestoreSession()).toBe(false);
    expect(session.requestRestoreRetry()).toBe(false);

    expect(await session.getAuthState()).toEqual(signedOut);
    expect(windows).toHaveLength(1);
  });

  it("keeps a signed-in session that has no active workspace", async () => {
    const { session, replies, refreshes } = createSession();
    server.use(
      http.get(`${api}/api/auth/me`, () =>
        HttpResponse.json({
          userId: "app-user",
          email: "app@example.test",
          orgId: null,
        }),
      ),
    );
    replies.push(Promise.resolve("restored"));

    expect(await session.getAuthState()).toEqual({
      status: "signed_in",
      user: { userId: "app-user", email: "app@example.test" },
      organization: null,
    });
    expect(session.getCachedToken()).toBe("restored");
    expect(session.canRestoreSession()).toBe(true);
    expect(refreshes.some((event) => event.phase === "failed")).toBe(false);
  });

  it.each(["status", "protected request"] as const)(
    "renews a near-expiry bearer before the next %s without sending the old token",
    async (request) => {
      const { session, replies, windows } = createSession();
      const observed: string[] = [];
      identityHandlers({ userId: "same-user", observed });
      const old = sessionToken(10, "old");
      const fresh = sessionToken(60, "fresh");
      replies.push(Promise.resolve(old), Promise.resolve(fresh));
      await session.getAuthState();
      observed.length = 0;
      server.use(
        http.get(`${api}/api/protected`, ({ request: incoming }) => {
          observed.push(`protected:${incoming.headers.get("authorization")}`);
          return new HttpResponse(null, { status: 200 });
        }),
      );

      if (request === "status") {
        expect((await session.getAuthState()).status).toBe("signed_in");
      } else {
        expect(
          (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
            .status,
        ).toBe(200);
      }
      expect(observed).toEqual([
        `me:Bearer ${fresh}`,
        `org:Bearer ${fresh}`,
        ...(request === "status" ? [] : [`protected:Bearer ${fresh}`]),
      ]);
      expect(windows).toHaveLength(2);
      expect(session.getCachedToken()).toBe(fresh);
    },
  );

  it("reuses a bearer with sufficient lifetime remaining", async () => {
    const { session, replies, windows } = createSession();
    const observed: string[] = [];
    identityHandlers({ userId: "same-user", observed });
    const token = sessionToken(45, "valid");
    replies.push(Promise.resolve(token));
    await session.getAuthState();
    observed.length = 0;

    expect((await session.getAuthState()).status).toBe("signed_in");
    expect(observed).toEqual([`me:Bearer ${token}`, `org:Bearer ${token}`]);
    expect(windows).toHaveLength(1);
  });

  it("does not deliver a pending request to a different identity during proactive renewal", async () => {
    const { session, replies, windows } = createSession();
    const old = sessionToken(10, "old");
    const fresh = sessionToken(60, "fresh");
    const reply = deferred<string | null>();
    replies.push(Promise.resolve(old), reply.promise);
    const requests: string[] = [];
    server.use(
      http.get(`${api}/api/auth/me`, ({ request }) => {
        const changed =
          request.headers.get("authorization") === `Bearer ${fresh}`;
        return HttpResponse.json({
          userId: changed ? "new-user" : "old-user",
          email: "app@example.test",
          orgId: changed ? "new-org" : "old-org",
        });
      }),
      http.get(`${api}/api/org`, ({ request }) =>
        HttpResponse.json({
          id:
            request.headers.get("authorization") === `Bearer ${fresh}`
              ? "new-org"
              : "old-org",
          name: "Workspace",
        }),
      ),
      http.get(`${api}/api/protected`, ({ request }) => {
        requests.push(request.headers.get("authorization") ?? "missing");
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await session.getAuthState();
    const first = session.fetchWithSessionAuth(new URL(`${api}/api/protected`));
    const second = session.fetchWithSessionAuth(
      new URL(`${api}/api/protected`),
    );
    expect(windows).toHaveLength(2);
    reply.resolve(fresh);
    expect((await first).status).toBe(401);
    expect((await second).status).toBe(401);
    expect(requests).toEqual([]);
    expect((await session.getAuthState()).user).toMatchObject({
      userId: "new-user",
    });
  });

  it("does one bounded App refresh after 401 without a cookie-only retry", async () => {
    const { session, replies, windows } = createSession();
    identityHandlers({ userId: "same-user" });
    replies.push(Promise.resolve("expired"), Promise.resolve("fresh"));
    await session.getToken();
    const tokens: (string | null)[] = [];
    server.use(
      http.get(`${api}/api/protected`, ({ request }) => {
        const token = request.headers.get("authorization");
        tokens.push(token);
        return new HttpResponse(null, {
          status: token === "Bearer fresh" ? 200 : 401,
        });
      }),
    );
    expect(
      (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
        .status,
    ).toBe(200);
    expect(tokens).toEqual(["Bearer expired", "Bearer fresh"]);
    expect(windows).toHaveLength(2);
  });

  it("publishes a verified background identity before notifying recovery and subscribers", async () => {
    identityHandlers({ userId: "same-user" });
    const observed: string[] = [];
    const reads: ReturnType<DesktopAuthSession["getAuthState"]>[] = [];
    const { session, replies, refreshes, completed } = createSession(
      (current) => {
        if (current.getAuthority()) {
          expect(current.getCachedToken()).not.toBeNull();
          observed.push(`change:${current.getCachedToken()}`);
        }
      },
      (event, current) => {
        if (event.phase === "completed") {
          expect(current.getAuthority()).not.toBeNull();
          observed.push(`completed:${current.getCachedToken()}`);
          reads.push(current.getAuthState());
        }
      },
    );
    replies.push(Promise.resolve("old"));
    await session.getToken();
    await Promise.all(reads);
    const previousAuthority = session.getAuthority();
    const previousSignal = refreshes[0]?.signal;
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const refresh = session.getToken({ forceRefresh: true });
    expect(session.getAuthority()).toBeNull();
    expect(session.getCachedToken()).toBeNull();
    expect(previousSignal?.aborted).toBe(true);
    expect(refreshes.map((event) => event.phase)).toEqual([
      "started",
      "completed",
      "started",
    ]);
    reply.resolve("fresh");
    expect(await refresh).toBe("fresh");
    await Promise.all(reads);
    expect(refreshes[3]).toMatchObject({
      phase: "completed",
      identity: "same",
      signal: refreshes[2]?.signal,
    });
    expect(session.getAuthority()).not.toBe(previousAuthority);
    expect(observed).toEqual([
      "completed:old",
      "change:old",
      "completed:fresh",
      "change:fresh",
    ]);
    expect(completed).toEqual([]);
  });

  it.each(["user", "organization"] as const)(
    "does not replay a request after a hidden refresh changes the %s",
    async (changed) => {
      const { session, replies, refreshes } = createSession();
      const requests: (string | null)[] = [];
      const identity = (request: Request) => {
        const fresh = request.headers.get("authorization") === "Bearer fresh";
        return {
          userId: fresh && changed === "user" ? "new-user" : "old-user",
          orgId: fresh && changed === "organization" ? "new-org" : "old-org",
        };
      };
      server.use(
        http.get(`${api}/api/auth/me`, ({ request }) =>
          HttpResponse.json({
            ...identity(request),
            email: "app@example.test",
          }),
        ),
        http.get(`${api}/api/org`, ({ request }) =>
          HttpResponse.json({ id: identity(request).orgId, name: "Workspace" }),
        ),
        http.post(`${api}/api/protected`, ({ request }) => {
          requests.push(request.headers.get("authorization"));
          return new HttpResponse(null, { status: 401 });
        }),
      );
      replies.push(Promise.resolve("old"), Promise.resolve("fresh"));
      const response = await session.fetchWithSessionAuth(
        new URL(`${api}/api/protected`),
        { method: "POST", body: JSON.stringify({ action: "test" }) },
      );
      expect(response.status).toBe(401);
      expect(requests).toEqual(["Bearer old"]);
      expect(session.getCachedToken()).toBe("fresh");
      expect(refreshes.at(-1)).toMatchObject({
        phase: "completed",
        identity: "changed",
      });
    },
  );

  it("remembers the verified identity after an unsuccessful status read withdraws authority", async () => {
    identityHandlers({ userId: "old-user" });
    const { session, replies, refreshes } = createSession();
    replies.push(Promise.resolve("old"));
    await session.getToken();
    server.use(
      http.get(
        `${api}/api/auth/me`,
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    await expect(session.getAuthState()).rejects.toThrow(
      "Desktop auth status failed: 503",
    );
    expect(session.getAuthority()).toBeNull();
    identityHandlers({ userId: "new-user" });
    replies.push(Promise.resolve("fresh"));
    expect(await session.getToken({ forceRefresh: true })).toBe("fresh");
    expect(refreshes.at(-1)).toMatchObject({
      phase: "completed",
      identity: "changed",
    });
  });

  it("shares the current refresh while an older concurrent 401 is cancelled", async () => {
    identityHandlers({ userId: "same-user" });
    const { session, replies, windows, refreshes } = createSession();
    replies.push(Promise.resolve("old"));
    await session.getToken();
    const bothEntered = deferred<void>();
    const firstResponse = deferred<void>();
    const secondResponse = deferred<void>();
    const fresh = deferred<string | null>();
    replies.push(fresh.promise);
    let oldRequests = 0;
    server.use(
      http.get(`${api}/api/protected`, async ({ request }) => {
        if (request.headers.get("authorization") === "Bearer fresh")
          return new HttpResponse(null, { status: 200 });
        oldRequests++;
        if (oldRequests === 2) bothEntered.resolve();
        await (oldRequests === 1
          ? firstResponse.promise
          : secondResponse.promise);
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const first = session.fetchWithSessionAuth(new URL(`${api}/api/protected`));
    const second = session.fetchWithSessionAuth(
      new URL(`${api}/api/protected`),
    );
    const cancelled = expect(second).rejects.toThrow();
    try {
      await bothEntered.promise;
      firstResponse.resolve();
      await vi.waitFor(() => expect(windows).toHaveLength(2));
      const joined = session.getToken({ forceRefresh: true });
      fresh.resolve("fresh");
      expect(await joined).toBe("fresh");
      expect((await first).status).toBe(200);
      secondResponse.resolve();
      await cancelled;
      expect(windows).toHaveLength(2);
      expect(refreshes.map((event) => event.phase)).toEqual([
        "started",
        "completed",
        "started",
        "completed",
      ]);
    } finally {
      firstResponse.resolve();
      secondResponse.resolve();
      fresh.resolve(null);
    }
  });

  it.each([null, "rejected"])(
    "clears rejected credentials when refresh delivers %s",
    async (refreshed) => {
      const { session, replies, windows } = createSession();
      identityHandlers({ userId: "same-user" });
      replies.push(Promise.resolve("expired"), Promise.resolve(refreshed));
      await session.getToken();
      let count = 0;
      server.use(
        http.get(`${api}/api/protected`, () => {
          count++;
          return new HttpResponse(null, { status: 401 });
        }),
      );
      expect(
        (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
          .status,
      ).toBe(401);
      expect(session.getCachedToken()).toBeNull();
      expect(count).toBe(refreshed ? 2 : 1);
      expect(windows).toHaveLength(2);
    },
  );

  it("notifies subscribers of a failed App refresh and waits for explicit sign-in", async () => {
    const { session, replies, windows, changes, refreshes } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("expired"), Promise.resolve(null));
    await session.getToken();
    server.use(
      http.get(
        `${api}/api/protected`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    expect(
      (await session.fetchWithSessionAuth(new URL(`${api}/api/protected`)))
        .status,
    ).toBe(401);
    expect(changes).toEqual([null, "expired", null, null]);
    expect(refreshes.map((event) => event.phase)).toEqual([
      "started",
      "completed",
      "started",
      "failed",
    ]);
    expect(session.getAuthority()).toBeNull();
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(await session.getToken({ forceRefresh: true })).toBeNull();
    expect(windows).toHaveLength(2);
    replies.push(Promise.resolve("explicit"));
    await session.consumeCode("new-code");
    expect(session.getCachedToken()).toBe("explicit");
    expect(windows).toHaveLength(3);
  });

  it("refreshes the entire identity pair when the organization read rejects the old token", async () => {
    const { session, replies } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("old"));
    await session.getToken();
    const observed: string[] = [];
    identityHandlers({ observed });
    server.use(
      http.get(`${api}/api/org`, ({ request }) => {
        const token = request.headers.get("authorization");
        observed.push(`org:${token}`);
        return token === "Bearer old"
          ? new HttpResponse(null, { status: 401 })
          : HttpResponse.json({ id: "app-org", name: "new workspace" });
      }),
    );
    replies.push(Promise.resolve("new"));
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_in",
      user: { userId: "Bearer new" },
      organization: { name: "new workspace" },
    });
    expect(observed).toEqual([
      "me:Bearer old",
      "org:Bearer old",
      "me:Bearer new",
      "org:Bearer new",
    ]);
  });

  it("coalesces refreshes and recognizes a new delivery even if the token bytes are identical", async () => {
    const { session, replies, windows, completed, refreshes } = createSession();
    identityHandlers();
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const first = session.getToken();
    const second = session.getToken();
    reply.resolve("same");
    expect(await Promise.all([first, second])).toEqual(["same", "same"]);
    replies.push(Promise.resolve("same"));
    expect(await session.getToken({ forceRefresh: true })).toBe("same");
    expect(windows).toHaveLength(2);
    expect(completed).toEqual([]);
    expect(refreshes[1]).toMatchObject({
      phase: "completed",
      identity: "initial",
    });
    expect(refreshes[3]).toMatchObject({
      phase: "completed",
      identity: "same",
    });
    replies.push(Promise.resolve(null));
    expect(await session.getToken({ forceRefresh: true })).toBeNull();
    expect(session.getCachedToken()).toBeNull();
  });

  it("invalidates a late refresh on sign-out and accepts only a subsequent explicit flow", async () => {
    const { session, replies, windows, completed } = createSession();
    identityHandlers();
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const refresh = session.getToken();
    session.signOut();
    reply.resolve("late");
    expect(await refresh).toBeNull();
    expect(windows[0]?.signal.aborted).toBe(true);
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(await session.getToken({ forceRefresh: true })).toBeNull();
    replies.push(Promise.resolve("explicit"));
    await session.consumeCode("new-code", "handoff-id");
    expect(session.getCachedToken()).toBe("explicit");
    expect(completed).toEqual(["completed"]);
    expect(windows[1]?.url).toBe(
      "https://app.okou.ai/desktop-auth/consume?code=new-code&handoffId=handoff-id",
    );
  });

  it("discards a superseded consume and keeps the latest organization operation", async () => {
    const { session, replies, windows, completed } = createSession();
    identityHandlers();
    const reply = deferred<string | null>();
    replies.push(reply.promise);
    const old = session.consumeCode("old");
    const rejected = expect(old).rejects.toThrow();
    expect(await session.getAuthState()).toMatchObject({
      status: "signing_in",
    });
    replies.push(Promise.resolve("latest"));
    await session.selectOrganization();
    reply.resolve("late");
    await rejected;
    expect(session.getCachedToken()).toBe("latest");
    expect(completed).toEqual(["completed"]);
    expect(windows[0]?.signal.aborted).toBe(true);
    expect(windows[1]?.url).toBe(
      "https://app.okou.ai/desktop-auth/select-org?force=true",
    );
  });

  it("cannot publish an identity whose delayed API validation outlives sign-out", async () => {
    const { session, replies, completed } = createSession();
    identityHandlers();
    const entered = deferred<void>();
    const reply = deferred<void>();
    server.use(
      http.get(`${api}/api/org`, async () => {
        entered.resolve();
        await reply.promise;
        return HttpResponse.json({ id: "app-org", name: "late" });
      }),
    );
    replies.push(Promise.resolve("late"));
    const consume = session.consumeCode("code");
    const rejected = expect(consume).rejects.toThrow();
    await entered.promise;
    session.signOut();
    reply.resolve();
    await rejected;
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(session.getCachedToken()).toBeNull();
    expect(completed).toEqual([]);
  });

  it("keeps a new callback identity when it supersedes cold-start restoration", async () => {
    const { session, replies, windows } = createSession();
    identityHandlers();
    const old = deferred<string | null>();
    replies.push(old.promise);
    const restore = session.getToken();
    replies.push(Promise.resolve("callback-user"));
    await session.consumeCode("callback-code");
    old.resolve("old-user");
    expect(await restore).toBeNull();
    expect(session.getCachedToken()).toBe("callback-user");
    expect(windows[0]?.signal.aborted).toBe(true);
  });

  it("rejects a newly delivered bearer that the identity API no longer accepts", async () => {
    const { session, replies, completed } = createSession();
    server.use(
      http.get(
        `${api}/api/auth/me`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    replies.push(Promise.resolve("revoked"));
    expect(await session.getAuthState()).toEqual(signedOut);
    expect(session.getCachedToken()).toBeNull();
    expect(completed).toEqual([]);
  });

  it("does not leak a bearer to a non-API request origin", async () => {
    const { session, replies } = createSession();
    identityHandlers();
    replies.push(Promise.resolve("fresh"));
    await expect(
      session.fetchWithSessionAuth(new URL("https://untrusted.test/api")),
    ).rejects.toThrow("Invalid Desktop API origin");
  });
});

describe("App quit", () => {
  it("stops reporting a hidden restore torn down by the quit", async () => {
    const { session, replies, windows, refreshes } = createSession();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    // `before-quit` fires more than once during the quit sequence.
    session.abortForQuit();
    session.abortForQuit();
    failWindow(new Error("Desktop auth window closed"));

    expect(await pending).toBeNull();
    expect(refreshes.map((event) => event.phase)).toEqual(["started"]);
    expect(windows[0]?.signal.aborted).toBe(true);
  });

  it("still reports the same teardown failure while the session is live", async () => {
    const { session, replies, refreshes } = createSession();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    failWindow(new Error("Desktop auth window closed"));

    // The identical failure reports when no quit ended the lifetime, so the
    // suppression is scoped to the quit and is not a message filter.
    expect(await pending).toBeNull();
    expect(refreshes.at(-1)).toMatchObject({
      phase: "failed",
      classification: "unavailable",
    });
  });

  it("still reports a restore that exhausts its deadline", async () => {
    const { session, replies, windows, refreshes } = createSession();
    // Node drives `AbortSignal.timeout` from an internal timer that no timer
    // control can advance, so substituting the deadline signal is the only way
    // to reach the elapsed state without waiting it out.
    const deadline = new AbortController();
    const deadlines: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    timeout.mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      return deadline.signal;
    });
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    timeout.mockRestore();
    expect(deadlines).toEqual([30_000]);
    windows[0]?.signal.addEventListener(
      "abort",
      () => failWindow(new Error("Desktop auth session restore timed out")),
      { once: true },
    );
    deadline.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );

    // A deadline is genuine unavailability: it never ends the lifetime, so it
    // must keep reporting even though the attempt's signal is aborted.
    expect(await pending).toBeNull();
    expect(windows[0]?.signal.aborted).toBe(true);
    expect(refreshes.at(-1)).toMatchObject({
      phase: "failed",
      classification: "unavailable",
    });
  });

  it("gives an interactive sign-in a human-scale window budget", async () => {
    identityHandlers();
    const { session, replies, windows } = createSession();
    const deadlines: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    timeout.mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      return new AbortController().signal;
    });
    replies.push(Promise.resolve("interactive"));

    await session.consumeCode("code");
    timeout.mockRestore();

    // Thirty seconds is no budget for a person: the window phase gets minutes,
    // and validation opens a separate network-shaped one behind it.
    expect(deadlines).toEqual([600_000, 30_000]);
    expect(windows[0]?.signal.aborted).toBe(false);
    expect(session.getCachedToken()).toBe("interactive");
  });

  it("arms the validation budget only after the sign-in window completes", async () => {
    identityHandlers();
    const { session, replies, windows } = createSession();
    const deadlines: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    timeout.mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      return new AbortController().signal;
    });
    const window = deferred<string | null>();
    replies.push(window.promise);

    const pending = session.consumeCode("code");
    await vi.waitFor(() => {
      expect(windows).toHaveLength(1);
    });
    const armedDuringWindow = [...deadlines];
    window.resolve("interactive");
    await pending;
    timeout.mockRestore();

    expect(armedDuringWindow).toEqual([600_000]);
    expect(deadlines).toEqual([600_000, 30_000]);
    expect(session.getCachedToken()).toBe("interactive");
  });

  it("names the validation phase when its own budget runs out", async () => {
    const { session, replies } = createSession();
    // An already-elapsed substitute reaches the state a real budget only
    // reaches after its full wait.
    const elapsed = new AbortController();
    elapsed.abort(
      new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      ),
    );
    const deadlines: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    timeout.mockImplementation((milliseconds) => {
      deadlines.push(milliseconds);
      return milliseconds === 30_000
        ? elapsed.signal
        : new AbortController().signal;
    });
    replies.push(Promise.resolve("interactive"));

    const pending = session.consumeCode("code");

    // Nothing cancelled this attempt, and it is not the window that ran out.
    await expect(pending).rejects.toThrow(
      "Desktop auth identity validation timed out",
    );
    timeout.mockRestore();
    expect(deadlines).toEqual([600_000, 30_000]);
  });

  it("keeps the restored session that sign-out would discard", async () => {
    identityHandlers();
    const { session, replies, changes } = createSession();
    replies.push(Promise.resolve("restored"));
    expect(await session.getAuthState()).toMatchObject({
      status: "signed_in",
      user: { userId: "Bearer restored" },
    });
    session.queuePendingCallback({ code: "pending", handoffId: null });
    const notified = changes.length;

    session.abortForQuit();
    session.abortForQuit();

    expect(session.getCachedToken()).toBe("restored");
    expect(session.canRestoreSession()).toBe(true);
    // Restoration was never paused, so there is nothing to re-arm.
    expect(session.requestRestoreRetry()).toBe(false);
    expect(changes).toHaveLength(notified);
    expect(session.takePendingCallback()).toEqual({
      code: "pending",
      handoffId: null,
    });

    session.signOut();
    expect(session.getCachedToken()).toBeNull();
    expect(session.canRestoreSession()).toBe(false);
    expect(changes.length).toBeGreaterThan(notified);
  });
});

/**
 * The update quit prepares itself instead of going through `before-quit`:
 * `restartForUpdate` awaits this whole function before `quitAndInstall()`
 * closes any window, so the abort provably precedes every teardown. It mirrors
 * `prepareForQuitAndInstall` in main.ts, including the ordering that matters —
 * the lifetime ends only once the Computer Use stop has resolved, because a
 * stop that rejects never reaches `quitAndInstall()` and tears nothing down.
 */
async function prepareForQuitAndInstall(
  session: DesktopAuthSession,
  quitConfirmation: DesktopQuitConfirmationController,
  stopForQuit: () => Promise<void>,
): Promise<void> {
  await stopForQuit();
  session.abortForQuit();
  quitConfirmation.allowQuitWithoutConfirmation();
}

describe("Update quit", () => {
  function quitConfirmationSpy() {
    const quits: string[] = [];
    const quitConfirmation = new DesktopQuitConfirmationController({
      // The user declines whenever anything does ask, so a quit that goes
      // ahead can only be one that never needed confirming.
      confirmQuit: async () => false,
      quit: () => quits.push("quit"),
    });
    return { quitConfirmation, quits };
  }

  it("stops reporting a hidden restore whose load rejects during the update quit", async () => {
    const { session, replies, windows, refreshes } = createSession();
    const { quitConfirmation, quits } = quitConfirmationSpy();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    await prepareForQuitAndInstall(
      session,
      quitConfirmation,
      async () => undefined,
    );
    // The rejection the destroyed window produces is an ordinary error, so
    // before the lifetime ended it was classified as real unavailability.
    failWindow(new Error("Desktop auth page could not load"));

    expect(await pending).toBeNull();
    expect(refreshes.map((event) => event.phase)).toEqual(["started"]);
    expect(windows[0]?.signal.aborted).toBe(true);
    expect(quitConfirmation.isQuitAllowed()).toBe(true);
    expect(quits).toEqual([]);
  });

  it("stops reporting a hidden restore whose window closes during the update quit", async () => {
    const { session, replies, refreshes } = createSession();
    const { quitConfirmation } = quitConfirmationSpy();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    await prepareForQuitAndInstall(
      session,
      quitConfirmation,
      async () => undefined,
    );
    // The other rejection the same teardown produces arrives already typed as
    // teardown. One abort has to cover both, and the guard reads the lifetime
    // rather than the rejection.
    failWindow(new DesktopAuthTeardownError("Desktop auth window closed"));

    expect(await pending).toBeNull();
    expect(refreshes.map((event) => event.phase)).toEqual(["started"]);
  });

  it("keeps the session live when the Computer Use stop rejects", async () => {
    identityHandlers();
    const { session, replies, windows, refreshes } = createSession();
    const { quitConfirmation } = quitConfirmationSpy();
    const reply = deferred<string | null>();
    replies.push(reply.promise);

    const pending = session.getToken();
    await expect(
      prepareForQuitAndInstall(session, quitConfirmation, async () => {
        throw new Error("Computer Use could not stop");
      }),
    ).rejects.toThrow("Computer Use could not stop");

    // The preparation rejects before `quitAndInstall()`, so no window is torn
    // down and the app keeps running. Aborting here would strand it without
    // authority in exchange for suppressing nothing.
    expect(windows[0]?.signal.aborted).toBe(false);
    expect(quitConfirmation.isQuitAllowed()).toBe(false);

    reply.resolve("restored");
    expect(await pending).toBe("restored");
    expect(refreshes.map((event) => event.phase)).toEqual([
      "started",
      "completed",
    ]);
    expect(session.getAuthority()).not.toBeNull();
  });

  it("still reports a failure that arrives while the Computer Use stop runs", async () => {
    const { session, replies, refreshes } = createSession();
    const { quitConfirmation } = quitConfirmationSpy();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    const stop = deferred<undefined>();
    const prepared = prepareForQuitAndInstall(
      session,
      quitConfirmation,
      () => stop.promise,
    );
    // Nothing has been torn down yet, so a page that genuinely failed while
    // the stop was still running is unavailability and has to keep reporting.
    failWindow(new Error("Desktop auth page failed: -2"));

    expect(await pending).toBeNull();
    expect(refreshes.at(-1)).toMatchObject({
      phase: "failed",
      classification: "unavailable",
    });

    stop.resolve(undefined);
    await prepared;
  });

  it("keeps the session live when the user declines a quit", async () => {
    const { session, replies, windows, refreshes } = createSession();
    const { quitConfirmation, quits } = quitConfirmationSpy();
    let failWindow!: (error: Error) => void;
    replies.push(
      new Promise<string | null>((_resolve, reject) => {
        failWindow = reject;
      }),
    );

    const pending = session.getToken();
    // main.ts's `before-quit` handler keeps its abort below this gate, and
    // must: the branch the gate takes leaves the app running.
    const beforeQuit = (): Promise<void> | null => {
      if (!quitConfirmation.isQuitAllowed())
        return quitConfirmation.requestQuit();
      session.abortForQuit();
      return null;
    };
    await beforeQuit();

    expect(quits).toEqual([]);
    expect(quitConfirmation.isQuitAllowed()).toBe(false);
    expect(windows[0]?.signal.aborted).toBe(false);

    // The app carries on, so the teardown failure is still a real one.
    failWindow(new DesktopAuthTeardownError("Desktop auth window closed"));
    expect(await pending).toBeNull();
    expect(refreshes.at(-1)).toMatchObject({
      phase: "failed",
      classification: "cancelled",
    });
  });
});

describe("Desktop callback lifetime", () => {
  it("clears pending callbacks on sign-out", () => {
    const { session } = createSession();
    session.queuePendingCallback({ code: "code", handoffId: null });
    expect(session.takePendingCallback()).toEqual({
      code: "code",
      handoffId: null,
    });
    expect(session.takePendingCallback()).toBeNull();
    session.queuePendingCallback({ code: "late", handoffId: null });
    session.signOut();
    expect(session.takePendingCallback()).toBeNull();
  });
});
