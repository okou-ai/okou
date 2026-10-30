import {
  browserOwnerProfiles as profiles,
  browserOwnerWindows as windows,
} from "@okouai/db/schema/browser-owner";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { browserSessionTabSnapshots } from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import { and, eq, exists, inArray, sql, type Subquery } from "drizzle-orm";
import { QueryBuilder, type AnyPgColumn } from "drizzle-orm/pg-core";
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
type Window = typeof windows.$inferSelect;
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
    const t = browserSessionTabSnapshots;
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
      const capturedAt = nowDate();
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

/** The source selects only windows whose owning claim/read may publish. */
export function sharedSnapshotPublication(
  capture: SharedSnapshotCapture,
  source: Subquery & { readonly chatThreadId: AnyPgColumn },
) {
  const t = browserSessionTabSnapshots;
  const publication = browserCapturePublication({
    value: t.encryptedTabUrls,
    updatedAt: t.updatedAt,
    previousValue: capture.previousValue,
    capturedAt: capture.capturedAt,
  });
  return {
    source: new QueryBuilder()
      .select({
        chatThreadId: source.chatThreadId,
        encryptedTabUrls: sql`${capture.encryptedTabUrls}`
          .mapWith(t.encryptedTabUrls)
          .as("encrypted_tab_urls"),
        createdAt: sql`${sql.param(capture.capturedAt, t.createdAt)}::timestamp`
          .mapWith(t.createdAt)
          .as("created_at"),
        updatedAt: sql`${sql.param(capture.capturedAt, t.updatedAt)}::timestamp`
          .mapWith(t.updatedAt)
          .as("updated_at"),
      })
      .from(source)
      .getSQL(),
    conflict: {
      target: t.chatThreadId,
      set: {
        encryptedTabUrls: capture.encryptedTabUrls,
        updatedAt: publication.updatedAt,
      },
      setWhere: and(
        exists(
          new QueryBuilder().select({ id: source.chatThreadId }).from(source),
        ),
        publication.canReplace,
      ),
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
    const source = new QueryBuilder()
      .select({ chatThreadId: windows.chatThreadId })
      .from(windows)
      .where(captureOwner)
      .as("captured_shared_window");
    const publication = sharedSnapshotPublication(capture, source);
    const saved = await set(writeDb$)
      .insert(browserSessionTabSnapshots)
      .select(publication.source)
      .onConflictDoUpdate(publication.conflict)
      .returning({ id: browserSessionTabSnapshots.chatThreadId });
    signal.throwIfAborted();
    return saved.length === 1;
  },
);
