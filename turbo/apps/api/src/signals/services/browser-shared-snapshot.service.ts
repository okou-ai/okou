import { browserOwnerProfiles as profiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions as windows } from "@okouai/db/schema/browser-chat-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { BrowserChatWindow } from "./browser-chat-session";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { browserCapturePublication } from "./browser-capture-publication";
import {
  BrowserUseProviderError,
  listBrowserUseTabUrls,
  type BrowserUseNativeConnection,
} from "./browser-use.service";
import { encryptPersistentSecretValue } from "./crypto.utils";

type Profile = typeof profiles.$inferSelect;
type Window = BrowserChatWindow;
const RETIREMENT_CAPTURE_TIMEOUT_MS = 15_000;
interface SnapshotOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
}

export function sharedBrowserLifetime(
  owner: SnapshotOwner,
  profile: Profile,
  window: Pick<Window, "primaryWindowId">,
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
export interface SharedSnapshotCapture {
  readonly previousValue: string | null;
  readonly encryptedTabUrls: string;
  readonly capturedAt: Date;
}

/** Capture before retirement; the winning SQL claim owns publication. */
export const captureSharedSnapshot$ = command(
  async (
    { get },
    args: BrowserUseNativeConnection & {
      readonly owner: SnapshotOwner;
      readonly window: Pick<Window, "primaryWindowId">;
      readonly purpose: "active" | "retirement";
    },
    signal: AbortSignal,
  ): Promise<SharedSnapshotCapture | null> => {
    const { owner, window } = args;
    const t = windows;
    const [previous] = await get(db$)
      .select({ encryptedTabUrls: t.encryptedTabUrls })
      .from(t)
      .where(eq(t.chatThreadId, owner.chatThreadId));
    signal.throwIfAborted();
    const captureSignal =
      args.purpose === "retirement"
        ? AbortSignal.any([
            signal,
            AbortSignal.timeout(RETIREMENT_CAPTURE_TIMEOUT_MS),
          ])
        : signal;
    // Only remote capture/encryption is advisory. The database read above and
    // the caller's atomic publication must still fail on local errors.
    const prepared = await settleIncludingAbort(async () => {
      // Order captures before native IO; a late reply is not a newer snapshot.
      const capturedAt = nowDate();
      const observed = await settleIncludingAbort(
        listBrowserUseTabUrls(args, captureSignal, window.primaryWindowId),
      );
      captureSignal.throwIfAborted();
      if (!observed.ok) {
        throw observed.error instanceof BrowserUseProviderError
          ? observed.error
          : new BrowserUseProviderError(
              502,
              "BROWSER_USE_SHARED_OPERATION_FAILED",
              "Managed Browser operation could not be confirmed",
            );
      }
      const snapshot = observed.value;
      // A closed native window cannot replace its last recoverable snapshot.
      // A live window containing only blank pages still deliberately saves [].
      if (!snapshot.windowExists) {
        return null;
      }
      const encryptedTabUrls = await encryptPersistentSecretValue(
        JSON.stringify(snapshot.urls),
        { userId: owner.userId },
        captureSignal,
      );
      captureSignal.throwIfAborted();
      return {
        previousValue: previous?.encryptedTabUrls ?? null,
        encryptedTabUrls,
        capturedAt,
      };
    });
    signal.throwIfAborted();
    if (!prepared.ok) {
      if (args.purpose === "retirement") {
        // Expiry can proceed using only the last accepted snapshot.
        return null;
      }
      throw prepared.error;
    }
    return prepared.value;
  },
);

/** Publish independent capture fields without touching the binding twice. */
export function sharedSnapshotPublication(capture: SharedSnapshotCapture) {
  const publication = browserCapturePublication({
    value: windows.encryptedTabUrls,
    updatedAt: windows.tabUrlsCapturedAt,
    previousValue: capture.previousValue,
    capturedAt: capture.capturedAt,
  });
  return {
    canReplace: publication.canReplace,
    set: {
      encryptedTabUrls: sql`CASE WHEN ${publication.canReplace} THEN ${capture.encryptedTabUrls} ELSE ${windows.encryptedTabUrls} END`,
      tabUrlsCapturedAt: sql`CASE WHEN ${publication.canReplace} THEN ${publication.updatedAt} ELSE ${windows.tabUrlsCapturedAt} END`,
    },
  };
}

export const saveSharedSnapshot$ = command(
  async (
    { set },
    args: BrowserUseNativeConnection & {
      readonly owner: SnapshotOwner;
      readonly profile: Profile;
      readonly window: Window;
    },
    signal: AbortSignal,
  ) => {
    const capture = await set(
      captureSharedSnapshot$,
      { ...args, purpose: "active" },
      signal,
    );
    signal.throwIfAborted();
    if (!capture) {
      return false;
    }
    const { owner, profile, window } = args;
    const captureOwner = and(
      sharedBrowserLifetime(owner, profile, window),
      // Once retirement starts, a later capture may see only partly closed
      // pages. It must not overwrite the complete pre-retirement snapshot.
      eq(windows.state, "active"),
      exists(
        new QueryBuilder()
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, owner.chatThreadId),
              eq(chatThreads.userId, owner.userId),
            ),
          ),
      ),
    );
    const publication = sharedSnapshotPublication(capture);
    const saved = await set(writeDb$)
      .update(windows)
      .set(publication.set)
      .where(and(captureOwner, publication.canReplace))
      .returning({ id: windows.chatThreadId });
    signal.throwIfAborted();
    return saved.length === 1;
  },
);
