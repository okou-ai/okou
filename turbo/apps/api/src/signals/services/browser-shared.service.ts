import { command, computed, type Computed } from "ccstate";
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  or,
} from "drizzle-orm";
import {
  BROWSER_MAX_SCREEN_HEIGHT,
  BROWSER_MIN_SCREEN_HEIGHT,
  BROWSER_PROVIDER_TIMEOUT_MINUTES,
  BROWSER_SCREEN_WIDTH,
  type BrowserSession,
  type BrowserViewerConnection,
} from "@okouai/api-contracts/contracts/browser";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { browserOwnerProfiles as profiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions as windows } from "@okouai/db/schema/browser-chat-session";
import {
  browserThreadProfiles,
  browserSessionInstances,
} from "@okouai/db/schema/browser-session";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishBrowserSessionChangedSafely } from "../external/realtime";
import { settleIncludingAbort } from "../utils";
import {
  ORG_SENTINEL_USER_ID,
  userFeatureSwitchOverridesFromRows,
} from "./feature-switch-scope";
import {
  controlBrowserOwner$,
  authorityStillCurrent,
  type BrowserPublicAuthority,
} from "./browser-owner.service";
import { allocateBrowserOwnerProfile$ } from "./browser-owner-profile.service";
import { createBrowserOwnerWindow$ } from "./browser-owner-window.service";
import {
  browserChatWindow,
  type BrowserChatWindow,
} from "./browser-chat-session";
import {
  ensureSharedBrowserCapacity$,
  resolveBrowserScreenshotUrl$,
  captureAndStoreBrowserScreenshot$,
  type BrowserServiceError,
} from "./browser.service";
import {
  BrowserUseProviderError,
  browserUseWindowExists,
  browserUseNativeConnection,
  createBrowserUseSession,
  findBrowserUseSession,
  resizeBrowserUseSession,
  resolveBrowserUseViewerConnection,
  stopBrowserUseSessionForCleanup,
  type BrowserUseSession,
  type BrowserUseNativeConnection,
} from "./browser-use.service";
import {
  saveSharedSnapshot$,
  sharedBrowserLifetime,
} from "./browser-shared-snapshot.service";
import { reconcileSharedBrowsers$ } from "./browser-shared-reconcile.service";

interface SharedBrowserInput {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly chatThreadId?: string;
  readonly name?: string;
  readonly aspectRatio?: number;
}
type Result<T> =
  { readonly kind: "ok"; readonly value: T } | BrowserServiceError;
type Profile = typeof profiles.$inferSelect;
type Window = BrowserChatWindow;
type Metadata = Pick<
  typeof windows.$inferSelect,
  "chatThreadId" | "orgId" | "userId" | "name" | "createdAt" | "updatedAt"
>;
type Connection = { readonly browser: BrowserSession; readonly cdpUrl: string };
const unavailable = (): BrowserServiceError => {
  return {
    kind: "error",
    status: 409,
    code: "BROWSER_RECLAIMING",
    message:
      "This Browser lifetime is unavailable; retry after its current setup or cleanup completes",
  };
};
const missing = (): BrowserServiceError => {
  return {
    kind: "error",
    status: 404,
    code: "BROWSER_NOT_FOUND",
    message: "Managed browser not found",
  };
};
const off = (): BrowserServiceError => {
  return {
    kind: "error",
    status: 403,
    code: "BROWSER_SHARED_OWNER_DISABLED",
    message: "Shared Browser admission is not enabled",
  };
};
function errorResult(error: unknown): BrowserServiceError {
  if (!(error instanceof BrowserUseProviderError)) {
    throw error;
  }
  return {
    kind: "error",
    status: error.status,
    code: error.code,
    message: error.message,
  };
}
async function provider<T>(
  request: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const result = await settleIncludingAbort(request);
  signal.throwIfAborted();
  if (!result.ok) {
    throw result.error instanceof BrowserUseProviderError
      ? result.error
      : new BrowserUseProviderError(
          502,
          "BROWSER_USE_SHARED_OPERATION_FAILED",
          "Managed Browser operation could not be confirmed",
        );
  }
  return result.value;
}
function liveSharedWindow(
  owner: BrowserPublicAuthority,
  profile: Profile,
  window: Pick<Window, "primaryWindowId">,
) {
  return and(
    sharedBrowserLifetime(owner, profile, window),
    eq(windows.state, "active"),
    gt(windows.expiresAt, nowDate()),
    authorityStillCurrent(owner),
  );
}
const loadSharedBrowserScreenshotUrl$ = command(
  async (
    { get, set },
    owner: Pick<BrowserPublicAuthority, "orgId" | "userId" | "chatThreadId">,
    signal: AbortSignal,
  ) => {
    const [chat] = await get(db$)
      .select({
        screenshotObjectKey: windows.screenshotObjectKey,
        screenshotUrl: windows.screenshotUrl,
      })
      .from(windows)
      .where(
        and(
          eq(windows.chatThreadId, owner.chatThreadId),
          eq(windows.orgId, owner.orgId),
          eq(windows.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
    return chat?.screenshotObjectKey && chat.screenshotUrl
      ? await set(
          resolveBrowserScreenshotUrl$,
          {
            ...owner,
            objectKey: chat.screenshotObjectKey,
            url: chat.screenshotUrl,
          },
          signal,
        )
      : null;
  },
);
function presentation(
  meta: Metadata,
  profile: Profile,
  window: Window | null,
  session: Pick<BrowserUseSession, "status" | "liveUrl"> | null,
  screenshotUrl: string | null,
): BrowserSession {
  const live =
    profile.status === "active" &&
    profile.timeoutAt > nowDate() &&
    window?.state === "active" &&
    window.expiresAt > nowDate() &&
    session?.status === "active";
  return {
    threadId: meta.chatThreadId,
    name: meta.name,
    status: live ? "active" : "suspended",
    viewerUrl: `${env("APP_URL")}/browsers/${meta.chatThreadId}`,
    liveUrl: live ? session.liveUrl : null,
    screenshotUrl,
    proxyCountryCode: null,
    timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
    ...(live
      ? {
          window: {
            instanceId: profile.instanceId,
            primaryWindowId: window.primaryWindowId,
          },
        }
      : {}),
    idleExpiresAt: live ? window.expiresAt.toISOString() : null,
    suspendedAt: live ? null : profile.updatedAt.toISOString(),
    suspensionReason: live ? null : "idle",
    createdAt: meta.createdAt.toISOString(),
    updatedAt: meta.updatedAt.toISOString(),
  };
}

type SharedBrowserInputNode = Computed<
  SharedBrowserInput | null | Promise<SharedBrowserInput | null>
>;

interface ProvisionSharedBrowser {
  readonly owner: BrowserPublicAuthority;
  readonly previous: Profile | null;
}
// Publication and exact losing-candidate cleanup finish even if the HTTP caller disconnects.
const settleSharedInstancePublication$ = command(
  async (
    { set },
    args: {
      readonly owner: BrowserPublicAuthority;
      readonly profile: Profile;
      readonly session: BrowserUseSession;
    },
  ): Promise<Result<Profile>> => {
    const { owner, profile, session } = args;
    const signal = AbortSignal.timeout(15_000);
    const publication = await settleIncludingAbort(
      set(
        controlBrowserOwner$,
        owner,
        {
          kind: "publish",
          instanceId: profile.instanceId,
          providerSessionId: session.id,
          timeoutAt: session.timeoutAt,
        },
        signal,
      ),
    );
    if (!publication.ok) {
      throw publication.error;
    }
    const db = set(writeDb$);
    if (publication.value.outcome !== "accepted") {
      const referenced = await db.$count(
        profiles,
        eq(profiles.providerSessionId, session.id),
      );
      const legacy = await db.$count(
        browserSessionInstances,
        eq(browserSessionInstances.providerSessionId, session.id),
      );
      if (referenced === 0 && legacy === 0) {
        await provider(
          stopBrowserUseSessionForCleanup(
            session.id,
            AbortSignal.timeout(15_000),
          ),
          signal,
        );
      }
      return unavailable();
    }
    signal.throwIfAborted();
    const [published] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.instanceId, profile.instanceId));
    signal.throwIfAborted();
    return published ? { kind: "ok", value: published } : unavailable();
  },
);

const publishSharedInstance$ = command(
  async (
    { set },
    args: { readonly owner: BrowserPublicAuthority; readonly profile: Profile },
    signal: AbortSignal,
  ): Promise<Result<Profile>> => {
    const { owner, profile } = args;
    const creation = await settleIncludingAbort(
      createBrowserUseSession(
        {
          profileId: profile.providerProfileId,
          proxyCountryCode: null,
          timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
          instanceId: profile.instanceId,
        },
        signal,
      ),
    );
    if (signal.aborted) {
      if (creation.ok) {
        await set(settleSharedInstancePublication$, {
          owner,
          profile,
          session: creation.value,
        });
      }
      signal.throwIfAborted();
    }
    if (!creation.ok) {
      signal.throwIfAborted();
      throw creation.error;
    }
    const result = await set(settleSharedInstancePublication$, {
      owner,
      profile,
      session: creation.value,
    });
    signal.throwIfAborted();
    return result;
  },
);

const provisionSharedInstance$ = command(
  async (
    { get, set },
    args: ProvisionSharedBrowser,
    signal: AbortSignal,
  ): Promise<
    Result<{ readonly profile: Profile; readonly created: boolean }>
  > => {
    if (args.previous && args.previous.status !== "stopped") {
      return { kind: "ok", value: { profile: args.previous, created: false } };
    }
    const db = get(db$);
    const [old] = await db
      .select({ id: browserSessionInstances.providerSessionId })
      .from(browserSessionInstances)
      .innerJoin(
        browserThreadProfiles,
        eq(
          browserThreadProfiles.chatThreadId,
          browserSessionInstances.chatThreadId,
        ),
      )
      .where(
        and(
          eq(browserThreadProfiles.orgId, args.owner.orgId),
          eq(browserThreadProfiles.userId, args.owner.userId),
          inArray(browserSessionInstances.status, ["active", "stopping"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (old) {
      return {
        kind: "error",
        status: 409,
        code: "BROWSER_FRESH_CUTOVER_REQUIRED",
        message: "Retire the previous thread Browser before shared admission",
      };
    }
    const capacity = await set(
      ensureSharedBrowserCapacity$,
      args.owner.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (capacity) {
      return capacity;
    }
    const allocation = await set(
      allocateBrowserOwnerProfile$,
      args.owner,
      args.previous,
      signal,
    );
    signal.throwIfAborted();
    if (allocation.outcome !== "accepted") {
      return unavailable();
    }
    const [currentProfile] = await db
      .select()
      .from(profiles)
      .where(
        and(
          eq(profiles.instanceId, allocation.profile.instanceId),
          eq(profiles.status, "creating"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!currentProfile) {
      return unavailable();
    }
    const published = await set(
      publishSharedInstance$,
      { owner: args.owner, profile: currentProfile },
      signal,
    );
    signal.throwIfAborted();
    return published.kind === "error"
      ? published
      : { kind: "ok", value: { profile: published.value, created: true } };
  },
);

interface AdmitSharedWindow extends BrowserUseNativeConnection {
  readonly owner: BrowserPublicAuthority;
  readonly profile: Profile;
  readonly initial: boolean;
}

const admitSharedWindow$ = command(
  async (
    { get, set },
    args: AdmitSharedWindow,
    signal: AbortSignal,
  ): Promise<Result<Window>> => {
    const result = await set(
      createBrowserOwnerWindow$,
      {
        owner: args.owner,
        instanceId: args.profile.instanceId,
        cdpUrl: args.cdpUrl,
        extension: args.extension,
        initial: args.initial,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.outcome !== "accepted" || !result.window) {
      return unavailable();
    }
    const [window] = await get(db$)
      .select({
        chatThreadId: windows.chatThreadId,
        instanceId: windows.instanceId,
        state: windows.state,
        primaryWindowId: windows.primaryWindowId,
        expiresAt: windows.expiresAt,
      })
      .from(windows)
      .where(liveSharedWindow(args.owner, args.profile, result.window));
    signal.throwIfAborted();
    const binding = window ? browserChatWindow(window) : null;
    return binding ? { kind: "ok", value: binding } : unavailable();
  },
);

const publishSharedMetadata$ = command(
  async (
    { set },
    args: {
      readonly owner: BrowserPublicAuthority;
      readonly input: SharedBrowserInput;
      readonly profile: Profile;
      readonly window: Window;
    },
    signal: AbortSignal,
  ): Promise<Result<Metadata>> => {
    const { owner, input, profile, window } = args;
    const db = set(writeDb$);
    const [meta] = await db
      .update(windows)
      .set({ name: input.name ?? windows.name, updatedAt: nowDate() })
      .where(liveSharedWindow(owner, profile, window))
      .returning({
        chatThreadId: windows.chatThreadId,
        orgId: windows.orgId,
        userId: windows.userId,
        name: windows.name,
        createdAt: windows.createdAt,
        updatedAt: windows.updatedAt,
      });
    signal.throwIfAborted();
    if (!meta) {
      return unavailable();
    }
    const [confirmed] = await db
      .select({ id: windows.chatThreadId })
      .from(windows)
      .where(liveSharedWindow(owner, profile, window));
    signal.throwIfAborted();
    if (!confirmed) {
      return unavailable();
    }
    await publishBrowserSessionChangedSafely(owner.userId, {
      threadId: owner.chatThreadId,
    });
    signal.throwIfAborted();
    return { kind: "ok", value: meta };
  },
);

function sharedBrowserMode(input$: SharedBrowserInputNode) {
  return computed(async (get) => {
    const input = await get(input$);
    if (!input) {
      return null;
    }
    const db = get(db$);
    const [rows, owner] = await Promise.all([
      db
        .select({
          userId: userFeatureSwitches.userId,
          switches: userFeatureSwitches.switches,
        })
        .from(userFeatureSwitches)
        .where(
          and(
            eq(userFeatureSwitches.orgId, input.orgId),
            inArray(userFeatureSwitches.userId, [
              input.userId,
              ORG_SENTINEL_USER_ID,
            ]),
          ),
        ),
      db
        .select()
        .from(profiles)
        .where(
          and(
            eq(profiles.orgId, input.orgId),
            eq(profiles.userId, input.userId),
          ),
        ),
    ]);
    const enabled = isFeatureEnabled(FeatureSwitchKey.BrowserSharedOwner, {
      orgId: input.orgId,
      userId: input.userId,
      overrides: userFeatureSwitchOverridesFromRows(rows, input.userId),
    });
    return enabled || owner.length > 0 ? { input, enabled } : null;
  });
}

function sharedBrowserContext(mode$: ReturnType<typeof sharedBrowserMode>) {
  return computed(async (get) => {
    const mode = await get(mode$);
    if (!mode) {
      return null;
    }
    const { input } = mode;
    if (!input.runId && !input.chatThreadId) {
      return {
        kind: "error",
        status: 400,
        code: "BROWSER_RUN_REQUIRED",
        message: "Managed Browser requires a chat Run",
      } as const;
    }
    const [row] = await get(db$)
      .select({
        runId: agentRuns.id,
        chatThreadId: chatThreads.id,
        enabled: chatThreads.cloudBrowserEnabled,
        status: agentRuns.status,
      })
      .from(chatThreads)
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, input.orgId)),
      )
      .innerJoin(
        agentRuns,
        and(
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.agentId, chatThreads.agentId),
          eq(agentRuns.orgId, input.orgId),
          eq(agentRuns.userId, input.userId),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .where(
        and(
          eq(chatThreads.userId, input.userId),
          or(eq(agents.visibility, "public"), eq(agents.owner, input.userId)),
          input.runId ? eq(agentRuns.id, input.runId) : undefined,
          input.chatThreadId
            ? eq(chatThreads.id, input.chatThreadId)
            : undefined,
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (!row) {
      return missing();
    }
    if (!row.enabled) {
      return {
        kind: "error",
        status: 403,
        code: "BROWSER_AUTHORIZATION_REQUIRED",
        message: "Cloud browser is not enabled for this chat thread",
      } as const;
    }
    if (input.runId && !["pending", "running"].includes(row.status)) {
      return {
        kind: "error",
        status: 409,
        code: "BROWSER_RUN_ENDED",
        message: "The chat run already ended",
      } as const;
    }
    const owner: BrowserPublicAuthority = {
      orgId: input.orgId,
      userId: input.userId,
      chatThreadId: row.chatThreadId,
      runId: row.runId,
      requireLiveRun: input.runId !== undefined,
    };
    return { kind: "ok", owner, mode } as const;
  });
}

function sharedBrowserView(context$: ReturnType<typeof sharedBrowserContext>) {
  return computed(async (get) => {
    const ctx = await get(context$);
    if (!ctx || ctx.kind === "error") {
      return null;
    }
    const [view] = await get(db$)
      .select({
        profile: getTableColumns(profiles),
        browser: {
          chatThreadId: windows.chatThreadId,
          instanceId: windows.instanceId,
          state: windows.state,
          primaryWindowId: windows.primaryWindowId,
          expiresAt: windows.expiresAt,
          orgId: windows.orgId,
          userId: windows.userId,
          name: windows.name,
          createdAt: windows.createdAt,
          updatedAt: windows.updatedAt,
        },
      })
      .from(profiles)
      .leftJoin(
        windows,
        and(
          eq(windows.chatThreadId, ctx.owner.chatThreadId),
          eq(windows.orgId, ctx.owner.orgId),
          eq(windows.userId, ctx.owner.userId),
        ),
      )
      .where(
        and(
          eq(profiles.orgId, ctx.owner.orgId),
          eq(profiles.userId, ctx.owner.userId),
        ),
      );
    return view
      ? {
          ...view,
          window: view.browser ? browserChatWindow(view.browser) : null,
        }
      : null;
  });
}

function sharedBrowserPresent(
  context$: ReturnType<typeof sharedBrowserContext>,
  view$: ReturnType<typeof sharedBrowserView>,
) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<Result<BrowserSession> | null> => {
      const ctx = await get(context$);
      signal.throwIfAborted();
      if (!ctx || ctx.kind === "error") {
        return ctx;
      }
      const view = await get(view$);
      signal.throwIfAborted();
      if (!view?.browser) {
        return missing();
      }
      const browser = view.browser;
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<BrowserSession> | null> => {
          const session =
            view.profile.status === "active" && view.profile.providerSessionId
              ? await provider(
                  findBrowserUseSession(view.profile.providerSessionId, signal),
                  signal,
                )
              : null;
          const screenshotUrl = await set(
            loadSharedBrowserScreenshotUrl$,
            ctx.owner,
            signal,
          );
          return {
            kind: "ok",
            value: presentation(
              browser,
              view.profile,
              view.window,
              session,
              screenshotUrl,
            ),
          };
        })(),
      );
      signal.throwIfAborted();
      return operation.ok ? operation.value : errorResult(operation.error);
    },
  );
}

const resolveSharedWindow$ = command(
  async (
    { set },
    args: AdmitSharedWindow & { readonly window: Window | null },
    signal: AbortSignal,
  ): Promise<Result<Window>> => {
    let window = args.window;
    if (window) {
      if (
        window.state !== "active" ||
        window.expiresAt <= nowDate() ||
        !(await provider(
          browserUseWindowExists(args, window.primaryWindowId, signal),
          signal,
        ))
      ) {
        return unavailable();
      }
    } else {
      const admitted = await set(admitSharedWindow$, args, signal);
      signal.throwIfAborted();
      if (admitted.kind === "error") {
        return admitted;
      }
      window = admitted.value;
    }
    const renewed = await set(
      controlBrowserOwner$,
      args.owner,
      {
        kind: "renew",
        instanceId: args.profile.instanceId,
        primaryWindowId: window.primaryWindowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (renewed.outcome !== "accepted" || !renewed.window) {
      return unavailable();
    }
    return {
      kind: "ok",
      value: {
        ...window,
        expiresAt: renewed.window.expiresAt,
      },
    };
  },
);

function sharedBrowserOpen(
  context$: ReturnType<typeof sharedBrowserContext>,
  view$: ReturnType<typeof sharedBrowserView>,
) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<Result<Connection> | null> => {
      const ctx = await get(context$);
      signal.throwIfAborted();
      if (!ctx || ctx.kind === "error") {
        return ctx;
      }
      if (!ctx.mode.enabled) {
        return off();
      }
      // Reclaim expired lifetimes before the graph captures its current rows.
      await set(reconcileSharedBrowsers$, ctx.owner, signal);
      signal.throwIfAborted();
      const view = await get(view$);
      signal.throwIfAborted();
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<Connection>> => {
          const provisioned = await set(
            provisionSharedInstance$,
            {
              owner: ctx.owner,
              previous: view?.profile ?? null,
            },
            signal,
          );
          signal.throwIfAborted();
          if (provisioned.kind === "error") {
            return provisioned;
          }
          const { profile, created } = provisioned.value;
          if (
            profile.status !== "active" ||
            !profile.providerSessionId ||
            profile.timeoutAt <= nowDate()
          ) {
            return unavailable();
          }
          const session = await provider(
            findBrowserUseSession(profile.providerSessionId, signal),
            signal,
          );
          if (!session || session.status !== "active" || !session.cdpUrl) {
            return unavailable();
          }
          const resolved = await set(
            resolveSharedWindow$,
            {
              owner: ctx.owner,
              profile,
              ...browserUseNativeConnection(session),
              initial: created,
              window:
                view?.profile.instanceId === profile.instanceId
                  ? view.window
                  : null,
            },
            signal,
          );
          signal.throwIfAborted();
          if (resolved.kind === "error") {
            return resolved;
          }
          const window = resolved.value;
          const meta = await set(
            publishSharedMetadata$,
            {
              owner: ctx.owner,
              input: ctx.mode.input,
              profile,
              window,
            },
            signal,
          );
          signal.throwIfAborted();
          if (meta.kind === "error") {
            return meta;
          }
          return {
            kind: "ok",
            value: {
              browser: presentation(meta.value, profile, window, session, null),
              cdpUrl: session.cdpUrl,
            },
          };
        })(),
      );
      signal.throwIfAborted();
      return operation.ok ? operation.value : errorResult(operation.error);
    },
  );
}

function sharedBrowserLease(
  context$: ReturnType<typeof sharedBrowserContext>,
  view$: ReturnType<typeof sharedBrowserView>,
) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<Result<BrowserSession> | null> => {
      const ctx = await get(context$);
      signal.throwIfAborted();
      if (!ctx || ctx.kind === "error") {
        return ctx;
      }
      if (!ctx.mode.enabled) {
        return off();
      }
      const view = await get(view$);
      signal.throwIfAborted();
      if (!view?.window || !view.browser) {
        return missing();
      }
      const window = view.window;
      const health = await settleIncludingAbort(async () => {
        if (!view.profile.providerSessionId) {
          return null;
        }
        const session = await provider(
          findBrowserUseSession(view.profile.providerSessionId, signal),
          signal,
        );
        return session?.status === "active" &&
          session.cdpUrl &&
          (await provider(
            browserUseWindowExists(
              browserUseNativeConnection(session),
              window.primaryWindowId,
              signal,
            ),
            signal,
          ))
          ? session
          : null;
      });
      signal.throwIfAborted();
      if (!health.ok) {
        return errorResult(health.error);
      }
      if (!health.value) {
        await set(reconcileSharedBrowsers$, ctx.owner, signal);
        return unavailable();
      }
      const result = await set(
        controlBrowserOwner$,
        ctx.owner,
        {
          kind: "renew",
          instanceId: view.profile.instanceId,
          primaryWindowId: view.window.primaryWindowId,
        },
        signal,
      );
      if (result.outcome !== "accepted" || !result.window) {
        return unavailable();
      }
      const browser = presentation(
        view.browser,
        view.profile,
        {
          ...view.window,
          expiresAt: result.window.expiresAt,
        },
        health.value,
        await set(loadSharedBrowserScreenshotUrl$, ctx.owner, signal),
      );
      return { kind: "ok", value: browser };
    },
  );
}

function sharedBrowserResize(
  context$: ReturnType<typeof sharedBrowserContext>,
  view$: ReturnType<typeof sharedBrowserView>,
) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<Result<BrowserSession> | null> => {
      const ctx = await get(context$);
      signal.throwIfAborted();
      if (!ctx || ctx.kind === "error") {
        return ctx;
      }
      if (!ctx.mode.enabled) {
        return off();
      }
      const view = await get(view$);
      signal.throwIfAborted();
      if (
        !view?.window ||
        !view.browser ||
        view.profile.status !== "active" ||
        !view.profile.providerSessionId ||
        view.window.expiresAt <= nowDate() ||
        !ctx.mode.input.aspectRatio
      ) {
        return unavailable();
      }
      const { window, browser } = view;
      const providerSessionId = view.profile.providerSessionId;
      const aspectRatio = ctx.mode.input.aspectRatio;
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<BrowserSession> | null> => {
          const session = await provider(
            findBrowserUseSession(providerSessionId, signal),
            signal,
          );
          if (!session || session.status !== "active" || !session.cdpUrl) {
            return unavailable();
          }
          const height = Math.min(
            BROWSER_MAX_SCREEN_HEIGHT,
            Math.max(
              BROWSER_MIN_SCREEN_HEIGHT,
              Math.round(BROWSER_SCREEN_WIDTH / aspectRatio),
            ),
          );
          await provider(
            resizeBrowserUseSession(
              session.cdpUrl,
              BROWSER_SCREEN_WIDTH,
              height,
              signal,
              window.primaryWindowId,
            ),
            signal,
          );
          const [currentWindow] = await get(db$)
            .select({
              chatThreadId: windows.chatThreadId,
              instanceId: windows.instanceId,
              state: windows.state,
              primaryWindowId: windows.primaryWindowId,
              expiresAt: windows.expiresAt,
            })
            .from(windows)
            .where(
              and(
                sharedBrowserLifetime(ctx.owner, view.profile, window),
                eq(windows.state, "active"),
                gt(windows.expiresAt, nowDate()),
              ),
            )
            .limit(1);
          if (!currentWindow) {
            return unavailable();
          }
          return {
            kind: "ok",
            value: presentation(
              browser,
              view.profile,
              browserChatWindow(currentWindow),
              session,
              await set(loadSharedBrowserScreenshotUrl$, ctx.owner, signal),
            ),
          };
        })(),
      );
      signal.throwIfAborted();
      return operation.ok ? operation.value : errorResult(operation.error);
    },
  );
}

function sharedBrowserViewer(
  context$: ReturnType<typeof sharedBrowserContext>,
  view$: ReturnType<typeof sharedBrowserView>,
) {
  return command(
    async (
      { get },
      signal: AbortSignal,
    ): Promise<Result<BrowserViewerConnection> | null> => {
      const ctx = await get(context$);
      signal.throwIfAborted();
      if (!ctx || ctx.kind === "error") {
        return ctx;
      }
      const view = await get(view$);
      signal.throwIfAborted();
      if (
        !view?.window ||
        !view.browser ||
        view.window.state !== "active" ||
        view.window.expiresAt <= nowDate() ||
        !view.profile.providerSessionId ||
        view.profile.status !== "active"
      ) {
        return unavailable();
      }
      const providerSessionId = view.profile.providerSessionId;
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<BrowserViewerConnection> | null> => {
          const session = await provider(
            findBrowserUseSession(providerSessionId, signal),
            signal,
          );
          if (!session || session.status !== "active" || !session.cdpUrl) {
            return unavailable();
          }
          return {
            kind: "ok",
            value: {
              extension: browserUseNativeConnection(session).extension,
              cdpUrl: await provider(
                resolveBrowserUseViewerConnection(
                  session.cdpUrl,
                  session.liveUrl,
                  signal,
                ),
                signal,
              ),
            },
          };
        })(),
      );
      signal.throwIfAborted();
      return operation.ok ? operation.value : errorResult(operation.error);
    },
  );
}

function sharedBrowserClose(
  context$: ReturnType<typeof sharedBrowserContext>,
  view$: ReturnType<typeof sharedBrowserView>,
) {
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<Result<Record<string, never>> | null> => {
      const ctx = await get(context$);
      signal.throwIfAborted();
      if (!ctx || ctx.kind === "error") {
        return ctx;
      }
      const view = await get(view$);
      signal.throwIfAborted();
      if (
        view?.window &&
        view.browser &&
        view.profile.status === "active" &&
        view.profile.providerSessionId
      ) {
        const { window, browser } = view;
        const providerSessionId = view.profile.providerSessionId;
        const operation = await settleIncludingAbort(
          (async (): Promise<Result<Record<string, never>> | null> => {
            const session = await provider(
              findBrowserUseSession(providerSessionId, signal),
              signal,
            );
            if (session && session.status === "active" && session.cdpUrl) {
              const captured = await set(
                saveSharedSnapshot$,
                {
                  owner: ctx.owner,
                  profile: view.profile,
                  window,
                  ...browserUseNativeConnection(session),
                },
                signal,
              );
              if (captured) {
                await set(captureAndStoreBrowserScreenshot$, browser, {
                  providerSessionId,
                  window: {
                    instanceId: view.profile.instanceId,
                    primaryWindowId: window.primaryWindowId,
                  },
                });
              }
            }
            return { kind: "ok", value: {} };
          })(),
        );
        signal.throwIfAborted();
        return operation.ok ? operation.value : errorResult(operation.error);
      }
      return { kind: "ok", value: {} };
    },
  );
}

export function createSharedBrowserGraph(input$: SharedBrowserInputNode) {
  const mode$ = sharedBrowserMode(input$);
  const context$ = sharedBrowserContext(mode$);
  const view$ = sharedBrowserView(context$);
  return {
    present$: sharedBrowserPresent(context$, view$),
    open$: sharedBrowserOpen(context$, view$),
    lease$: sharedBrowserLease(context$, view$),
    resize$: sharedBrowserResize(context$, view$),
    viewer$: sharedBrowserViewer(context$, view$),
    close$: sharedBrowserClose(context$, view$),
  };
}
