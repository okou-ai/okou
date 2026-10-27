import { randomUUID } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  desc,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { array, string } from "zod";
import {
  BROWSER_MAX_SCREEN_HEIGHT,
  BROWSER_MIN_SCREEN_HEIGHT,
  BROWSER_PROVIDER_TIMEOUT_MINUTES,
  BROWSER_SCREEN_WIDTH,
  type BrowserSession,
} from "@okouai/api-contracts/contracts/browser";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import {
  browserOwnerProfiles as profiles,
  browserOwnerWindows as windows,
} from "@okouai/db/schema/browser-owner";
import {
  browserSessions,
  browserSessionInstances,
  browserSessionTabSnapshots,
  browserSessionScreenshots,
  browserSessionScreenshotDeletions,
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
import {
  ensureBrowserCapacity$,
  loadBrowserScreenshotUrl$,
  captureAndStoreBrowserScreenshot$,
  type BrowserServiceError,
} from "./browser.service";
import {
  BrowserUseProviderError,
  browserUseWindowExists,
  closeBrowserUseWindow,
  createBrowserUseWindow,
  createBrowserUseSession,
  getBrowserUseSession,
  initialBrowserUseWindow,
  listBrowserUseTabUrls,
  resizeBrowserUseSession,
  resolveBrowserUseViewerConnection,
  restoreBrowserUseWindowTabUrls,
  stopBrowserUseSessionForCleanup,
  type BrowserUseSession,
} from "./browser-use.service";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";

interface SharedBrowserInput {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly chatThreadId?: string;
  readonly name?: string;
  readonly proxyCountryCode?: string | null;
  readonly aspectRatio?: number;
}
type Result<T> =
  { readonly kind: "ok"; readonly value: T } | BrowserServiceError;
type Profile = typeof profiles.$inferSelect;
type Window = typeof windows.$inferSelect;
type Metadata = typeof browserSessions.$inferSelect;
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
function lifetime(
  owner: BrowserPublicAuthority,
  profile: Profile,
  window: Window,
) {
  return and(
    eq(windows.chatThreadId, owner.chatThreadId),
    eq(windows.instanceId, profile.instanceId),
    eq(windows.primaryWindowId, window.primaryWindowId),
    exists(
      new QueryBuilder()
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.id, profile.id),
            eq(profiles.instanceId, profile.instanceId),
            profile.providerSessionId
              ? eq(profiles.providerSessionId, profile.providerSessionId)
              : sql`false`,
            eq(profiles.orgId, owner.orgId),
            eq(profiles.userId, owner.userId),
            inArray(profiles.status, ["active", "stopping"]),
          ),
        ),
    ),
  );
}
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
    proxyCountryCode: profile.proxyCountryCode,
    timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
    ...(live
      ? {
          window: {
            instanceId: profile.instanceId,
            primaryWindowId: window.primaryWindowId,
          },
          screen: {
            width: BROWSER_SCREEN_WIDTH,
            height: window.screenHeight,
            resizable: true,
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

const saveSharedSnapshot$ = command(
  async (
    { set },
    args: {
      readonly owner: BrowserPublicAuthority;
      readonly profile: Profile;
      readonly window: Window;
      readonly cdpUrl: string;
    },
    signal: AbortSignal,
  ) => {
    const { owner, profile, window, cdpUrl } = args;
    const urls = await provider(
      listBrowserUseTabUrls(cdpUrl, signal, window.primaryWindowId),
      signal,
    );
    const encryptedTabUrls = await encryptPersistentSecretValue(
      JSON.stringify(urls),
      { userId: owner.userId },
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const at = nowDate();
    const t = browserSessionTabSnapshots;
    const source = new QueryBuilder()
      .select({
        chatThreadId: windows.chatThreadId,
        encryptedTabUrls: sql`${encryptedTabUrls}`
          .mapWith(t.encryptedTabUrls)
          .as("encrypted_tab_urls"),
        ownerProfileId: sql`${profile.id}::uuid`
          .mapWith(profiles.id)
          .as("owner_profile_id"),
        createdAt: sql`${sql.param(at, t.createdAt)}::timestamp`
          .mapWith(t.createdAt)
          .as("created_at"),
        updatedAt: sql`${sql.param(at, t.updatedAt)}::timestamp`
          .mapWith(t.updatedAt)
          .as("updated_at"),
      })
      .from(windows)
      .where(lifetime(owner, profile, window));
    await db
      .insert(t)
      .select(source)
      .onConflictDoUpdate({
        target: t.chatThreadId,
        set: { encryptedTabUrls, ownerProfileId: profile.id, updatedAt: at },
        setWhere: exists(
          new QueryBuilder()
            .select({ id: windows.chatThreadId })
            .from(windows)
            .where(lifetime(owner, profile, window)),
        ),
      });
  },
);

type SharedBrowserInputNode = Computed<
  SharedBrowserInput | null | Promise<SharedBrowserInput | null>
>;

interface ProvisionSharedBrowser {
  readonly owner: BrowserPublicAuthority;
  readonly input: SharedBrowserInput;
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
          proxyCountryCode: profile.proxyCountryCode,
          timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
          extensionIds: env("OKOU_BROWSER_USE_EXTENSION_IDS"),
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
    { set },
    args: ProvisionSharedBrowser,
    signal: AbortSignal,
  ): Promise<
    Result<{ readonly profile: Profile; readonly created: boolean }>
  > => {
    if (args.previous && args.previous.status !== "stopped") {
      if (
        args.input.proxyCountryCode &&
        args.input.proxyCountryCode !== args.previous.proxyCountryCode
      ) {
        return {
          kind: "error",
          status: 409,
          code: "BROWSER_PROXY_CONFLICT",
          message: "This owner Browser already uses a different proxy country",
        };
      }
      return { kind: "ok", value: { profile: args.previous, created: false } };
    }
    const db = set(writeDb$);
    const [old] = await db
      .select({ id: browserSessionInstances.providerSessionId })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.chatThreadId, browserSessionInstances.chatThreadId),
      )
      .where(
        and(
          eq(browserSessions.orgId, args.owner.orgId),
          eq(browserSessions.userId, args.owner.userId),
          inArray(browserSessionInstances.status, ["active", "stopping"]),
        ),
      );
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
      ensureBrowserCapacity$,
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
    const [claimed] = await db
      .update(profiles)
      .set({
        proxyCountryCode:
          args.input.proxyCountryCode ??
          args.previous?.proxyCountryCode ??
          null,
      })
      .where(
        and(
          eq(profiles.instanceId, allocation.instance.id),
          eq(profiles.status, "creating"),
        ),
      )
      .returning();
    signal.throwIfAborted();
    if (!claimed) {
      return unavailable();
    }
    const published = await set(
      publishSharedInstance$,
      { owner: args.owner, profile: claimed },
      signal,
    );
    signal.throwIfAborted();
    return published.kind === "error"
      ? published
      : { kind: "ok", value: { profile: published.value, created: true } };
  },
);

interface AdmitSharedWindow {
  readonly owner: BrowserPublicAuthority;
  readonly profile: Profile;
  readonly cdpUrl: string;
  readonly initial: boolean;
  readonly encryptedTabUrls: string | null;
}
async function restoreSharedWindow(
  args: AdmitSharedWindow,
  candidate: Awaited<ReturnType<typeof createBrowserUseWindow>>,
  signal: AbortSignal,
) {
  if (!args.encryptedTabUrls) {
    return;
  }
  const decoded = await decryptPersistentSecretValue(args.encryptedTabUrls, {
    userId: args.owner.userId,
  });
  signal.throwIfAborted();
  const urls = array(string().max(8192)).max(50).parse(JSON.parse(decoded));
  await provider(
    restoreBrowserUseWindowTabUrls(args.cdpUrl, candidate, urls, signal),
    signal,
  );
}
// Once a native candidate is known, retain or clean it before honoring request cancellation.
const settleSharedWindowAdmission$ = command(
  async (
    { set },
    input: {
      readonly args: AdmitSharedWindow;
      readonly candidate: Awaited<ReturnType<typeof createBrowserUseWindow>>;
    },
  ): Promise<Result<Window>> => {
    const { args, candidate } = input;
    const signal = AbortSignal.timeout(15_000);
    let uncertain = false;
    const admission = await settleIncludingAbort(
      (async () => {
        await restoreSharedWindow(args, candidate, signal);
        uncertain = true;
        const result = await set(
          controlBrowserOwner$,
          args.owner,
          {
            kind: "admit",
            instanceId: args.profile.instanceId,
            primaryWindowId: candidate.primaryWindowId,
          },
          signal,
        );
        uncertain = false;
        return result;
      })(),
    );
    const db = set(writeDb$);
    if (!uncertain) {
      const [referenced] = await db
        .select({ id: windows.chatThreadId })
        .from(windows)
        .where(
          and(
            eq(windows.instanceId, args.profile.instanceId),
            eq(windows.primaryWindowId, candidate.primaryWindowId),
          ),
        );
      if (!referenced) {
        await provider(
          closeBrowserUseWindow(
            args.cdpUrl,
            candidate.primaryWindowId,
            AbortSignal.timeout(15_000),
          ),
          signal,
        );
      }
    }
    signal.throwIfAborted();
    if (!admission.ok) {
      throw admission.error;
    }
    if (
      admission.value.outcome !== "accepted" ||
      admission.value.instance.window?.primaryWindowId !==
        candidate.primaryWindowId
    ) {
      return unavailable();
    }
    const [window] = await db
      .select()
      .from(windows)
      .where(
        and(
          eq(windows.chatThreadId, args.owner.chatThreadId),
          eq(windows.instanceId, args.profile.instanceId),
        ),
      );
    signal.throwIfAborted();
    return window ? { kind: "ok", value: window } : unavailable();
  },
);

const admitSharedWindow$ = command(
  async (
    { set },
    args: AdmitSharedWindow,
    signal: AbortSignal,
  ): Promise<Result<Window>> => {
    const creation = await settleIncludingAbort(
      args.initial
        ? initialBrowserUseWindow(args.cdpUrl, signal)
        : createBrowserUseWindow(args.cdpUrl, signal),
    );
    if (signal.aborted) {
      if (creation.ok) {
        await set(settleSharedWindowAdmission$, {
          args,
          candidate: creation.value,
        });
      }
      signal.throwIfAborted();
    }
    if (!creation.ok) {
      signal.throwIfAborted();
      throw creation.error;
    }
    const result = await set(settleSharedWindowAdmission$, {
      args,
      candidate: creation.value,
    });
    signal.throwIfAborted();
    return result;
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
      readonly previous: Metadata | null;
    },
    signal: AbortSignal,
  ): Promise<Result<Metadata>> => {
    const { owner, input, profile, window, previous } = args;
    const db = set(writeDb$);
    if (
      !previous ||
      previous.browserThreadProfileId ||
      previous.browserProfileId
    ) {
      const removed = db
        .$with("previous_browser_preview")
        .as(
          db
            .delete(browserSessionScreenshots)
            .where(
              eq(browserSessionScreenshots.chatThreadId, owner.chatThreadId),
            )
            .returning(),
        );
      await db
        .with(removed)
        .insert(browserSessionScreenshotDeletions)
        .select(
          new QueryBuilder()
            .select({
              objectKey: removed.objectKey,
              chatThreadId: removed.chatThreadId,
              createdAt: removed.createdAt,
            })
            .from(removed),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();
    }
    const [meta] = await db
      .insert(browserSessions)
      .values({
        id: randomUUID(),
        orgId: owner.orgId,
        userId: owner.userId,
        chatThreadId: owner.chatThreadId,
        runId: owner.runId,
        name: input.name ?? previous?.name ?? "browser",
        status: "active",
        proxyCountryCode: profile.proxyCountryCode,
        timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
      })
      .onConflictDoUpdate({
        target: browserSessions.chatThreadId,
        targetWhere: sql`${browserSessions.status} IN ('creating', 'active', 'resuming', 'stopping')`,
        set: {
          runId: owner.runId,
          name: input.name ?? previous?.name ?? "browser",
          status: "active",
          browserThreadProfileId: null,
          browserProfileId: null,
          proxyCountryCode: profile.proxyCountryCode,
          suspendedAt: null,
          suspensionReason: null,
          updatedAt: nowDate(),
        },
        setWhere: and(
          eq(browserSessions.orgId, owner.orgId),
          eq(browserSessions.userId, owner.userId),
        ),
      })
      .returning();
    signal.throwIfAborted();
    if (!meta) {
      return unavailable();
    }
    const [confirmed] = await db
      .select({ id: windows.chatThreadId })
      .from(windows)
      .where(
        and(
          lifetime(owner, profile, window),
          eq(windows.state, "active"),
          gt(windows.expiresAt, nowDate()),
          authorityStillCurrent(owner),
        ),
      );
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
        window: getTableColumns(windows),
        browser: getTableColumns(browserSessions),
        snapshot: {
          encryptedTabUrls: browserSessionTabSnapshots.encryptedTabUrls,
        },
      })
      .from(profiles)
      .leftJoin(
        windows,
        and(
          eq(windows.instanceId, profiles.instanceId),
          eq(windows.chatThreadId, ctx.owner.chatThreadId),
        ),
      )
      .leftJoin(
        browserSessions,
        and(
          eq(browserSessions.chatThreadId, ctx.owner.chatThreadId),
          eq(browserSessions.orgId, ctx.owner.orgId),
          eq(browserSessions.userId, ctx.owner.userId),
          eq(browserSessions.status, "active"),
        ),
      )
      .leftJoin(
        browserSessionTabSnapshots,
        and(
          eq(browserSessionTabSnapshots.chatThreadId, ctx.owner.chatThreadId),
          eq(browserSessionTabSnapshots.ownerProfileId, profiles.id),
        ),
      )
      .where(
        and(
          eq(profiles.orgId, ctx.owner.orgId),
          eq(profiles.userId, ctx.owner.userId),
        ),
      );
    return view ?? null;
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
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<BrowserSession> | null> => {
          if (!view.browser) {
            return missing();
          }
          const session =
            view.profile.status === "active" && view.profile.providerSessionId
              ? await provider(
                  getBrowserUseSession(view.profile.providerSessionId, signal),
                  signal,
                )
              : null;
          const screenshotUrl = await set(
            loadBrowserScreenshotUrl$,
            ctx.owner.chatThreadId,
            signal,
          );
          return {
            kind: "ok",
            value: presentation(
              view.browser,
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
          browserUseWindowExists(args.cdpUrl, window.primaryWindowId, signal),
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
    if (renewed.outcome !== "accepted" || !renewed.instance.window) {
      return unavailable();
    }
    return {
      kind: "ok",
      value: {
        ...window,
        expiresAt: new Date(renewed.instance.window.expiresAt),
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
      const view = await get(view$);
      signal.throwIfAborted();
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<Connection>> => {
          const provisioned = await set(
            provisionSharedInstance$,
            {
              owner: ctx.owner,
              input: ctx.mode.input,
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
            getBrowserUseSession(profile.providerSessionId, signal),
            signal,
          );
          if (
            session.id !== profile.providerSessionId ||
            session.status !== "active" ||
            !session.cdpUrl
          ) {
            return unavailable();
          }
          const resolved = await set(
            resolveSharedWindow$,
            {
              owner: ctx.owner,
              profile,
              cdpUrl: session.cdpUrl,
              initial: created,
              encryptedTabUrls: view?.snapshot?.encryptedTabUrls ?? null,
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
              previous: view?.browser ?? null,
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
      if (result.outcome !== "accepted" || !result.instance.window) {
        return unavailable();
      }
      const browser = presentation(
        view.browser,
        view.profile,
        {
          ...view.window,
          expiresAt: new Date(result.instance.window.expiresAt),
        },
        { status: "active", liveUrl: null },
        await set(loadBrowserScreenshotUrl$, ctx.owner.chatThreadId, signal),
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
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<BrowserSession> | null> => {
          if (
            !view.window ||
            !view.browser ||
            !view.profile.providerSessionId ||
            !ctx.mode.input.aspectRatio
          ) {
            return unavailable();
          }
          const session = await provider(
            getBrowserUseSession(view.profile.providerSessionId, signal),
            signal,
          );
          if (
            session.id !== view.profile.providerSessionId ||
            session.status !== "active" ||
            !session.cdpUrl
          ) {
            return unavailable();
          }
          const height = Math.min(
            BROWSER_MAX_SCREEN_HEIGHT,
            Math.max(
              BROWSER_MIN_SCREEN_HEIGHT,
              Math.round(BROWSER_SCREEN_WIDTH / ctx.mode.input.aspectRatio),
            ),
          );
          await provider(
            resizeBrowserUseSession(
              session.cdpUrl,
              BROWSER_SCREEN_WIDTH,
              height,
              signal,
              view.window.primaryWindowId,
            ),
            signal,
          );
          const [changed] = await set(writeDb$)
            .update(windows)
            .set({ screenHeight: height, updatedAt: nowDate() })
            .where(
              and(
                lifetime(ctx.owner, view.profile, view.window),
                eq(windows.state, "active"),
                gt(windows.expiresAt, nowDate()),
              ),
            )
            .returning();
          if (!changed) {
            return unavailable();
          }
          return {
            kind: "ok",
            value: presentation(
              view.browser,
              view.profile,
              changed,
              session,
              await set(
                loadBrowserScreenshotUrl$,
                ctx.owner.chatThreadId,
                signal,
              ),
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
    ): Promise<Result<{ readonly cdpUrl: string }> | null> => {
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
      const operation = await settleIncludingAbort(
        (async (): Promise<Result<{ readonly cdpUrl: string }> | null> => {
          if (!view.profile.providerSessionId) {
            return unavailable();
          }
          const session = await provider(
            getBrowserUseSession(view.profile.providerSessionId, signal),
            signal,
          );
          if (
            session.id !== view.profile.providerSessionId ||
            session.status !== "active" ||
            !session.cdpUrl
          ) {
            return unavailable();
          }
          return {
            kind: "ok",
            value: {
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
        const operation = await settleIncludingAbort(
          (async (): Promise<Result<Record<string, never>> | null> => {
            if (
              !view.window ||
              !view.browser ||
              !view.profile.providerSessionId
            ) {
              return { kind: "ok", value: {} };
            }
            const session = await provider(
              getBrowserUseSession(view.profile.providerSessionId, signal),
              signal,
            );
            if (
              session.id === view.profile.providerSessionId &&
              session.status === "active" &&
              session.cdpUrl
            ) {
              await set(
                saveSharedSnapshot$,
                {
                  owner: ctx.owner,
                  profile: view.profile,
                  window: view.window,
                  cdpUrl: session.cdpUrl,
                },
                signal,
              );
              await set(captureAndStoreBrowserScreenshot$, view.browser, {
                providerSessionId: view.profile.providerSessionId,
                window: {
                  instanceId: view.profile.instanceId,
                  primaryWindowId: view.window.primaryWindowId,
                },
              });
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
