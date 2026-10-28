import {
  browserOwnerProfiles as profiles,
  browserOwnerWindows as windows,
} from "@okouai/db/schema/browser-owner";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { browserSessionTabSnapshots } from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { browserCapturePublication } from "./browser-capture-publication";
import {
  BrowserUseProviderError,
  listBrowserUseTabUrls,
} from "./browser-use.service";
import { encryptPersistentSecretValue } from "./crypto.utils";

type Profile = typeof profiles.$inferSelect;
type Window = typeof windows.$inferSelect;
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
export const saveSharedSnapshot$ = command(
  async (
    { get, set },
    args: {
      readonly owner: SnapshotOwner;
      readonly profile: Profile;
      readonly window: Window;
      readonly cdpUrl: string;
    },
    signal: AbortSignal,
  ) => {
    const { owner, profile, window, cdpUrl } = args;
    const t = browserSessionTabSnapshots;
    const [previous] = await get(db$)
      .select({ encryptedTabUrls: t.encryptedTabUrls })
      .from(t)
      .where(eq(t.chatThreadId, owner.chatThreadId));
    signal.throwIfAborted();
    const observed = await settleIncludingAbort(
      listBrowserUseTabUrls(cdpUrl, signal, window.primaryWindowId),
    );
    signal.throwIfAborted();
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
      return false;
    }
    const capturedAt = nowDate();
    const encryptedTabUrls = await encryptPersistentSecretValue(
      JSON.stringify(snapshot.urls),
      { userId: owner.userId },
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const publication = browserCapturePublication({
      value: t.encryptedTabUrls,
      updatedAt: t.updatedAt,
      previousValue: previous?.encryptedTabUrls ?? null,
      capturedAt,
    });
    const captureOwner = and(
      sharedBrowserLifetime(owner, profile, window),
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
      .select({
        chatThreadId: windows.chatThreadId,
        encryptedTabUrls: sql`${encryptedTabUrls}`
          .mapWith(t.encryptedTabUrls)
          .as("encrypted_tab_urls"),
        createdAt: sql`${sql.param(capturedAt, t.createdAt)}::timestamp`
          .mapWith(t.createdAt)
          .as("created_at"),
        updatedAt: sql`${sql.param(capturedAt, t.updatedAt)}::timestamp`
          .mapWith(t.updatedAt)
          .as("updated_at"),
      })
      .from(windows)
      .where(captureOwner);
    await db
      .insert(t)
      .select(source)
      .onConflictDoUpdate({
        target: t.chatThreadId,
        set: {
          encryptedTabUrls,
          updatedAt: publication.updatedAt,
        },
        setWhere: and(
          exists(
            new QueryBuilder()
              .select({ id: windows.chatThreadId })
              .from(windows)
              .where(captureOwner),
          ),
          publication.canReplace,
        ),
      });
    signal.throwIfAborted();
    return true;
  },
);
