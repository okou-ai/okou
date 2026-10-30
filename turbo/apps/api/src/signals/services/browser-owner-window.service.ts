import {
  browserOwnerProfiles,
  browserOwnerWindows,
} from "@okouai/db/schema/browser-owner";
import { browserSessionTabSnapshots } from "@okouai/db/schema/browser-session";
import {
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_SCREEN_WIDTH,
} from "@okouai/api-contracts/contracts/browser";
import { array, string } from "zod";
import { command } from "ccstate";
import { and, eq, exists } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import {
  controlBrowserOwner$,
  type BrowserPublicAuthority,
  type BrowserOwnerResult,
} from "./browser-owner.service";
import {
  BrowserUseProviderError,
  tryCloseBrowserUseWindow,
  initialBrowserUseWindow,
  resizeBrowserUseSession,
  restoreBrowserUseWindowTabUrls,
  createBrowserUseWindow,
  type BrowserUseWindowCandidate,
  type BrowserUseNativeConnection,
} from "./browser-use.service";

const CLEANUP_TIMEOUT_MS = 15_000;
const unavailable = { outcome: "unavailable" } as const;
interface WindowCandidateCleanup extends BrowserUseNativeConnection {
  readonly instanceId: string;
  candidate?: BrowserUseWindowCandidate;
  publicationUncertain: boolean;
}

const cleanupWindowCandidate$ = command(
  async (
    { get },
    args: WindowCandidateCleanup,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.candidate || args.publicationUncertain) {
      // A read cannot exclude a late write, even when another winner is
      // visible. Only a settled publication permits exact loser cleanup.
      return;
    }
    const references = await get(db$)
      .select({
        primaryWindowId: browserOwnerWindows.primaryWindowId,
      })
      .from(browserOwnerWindows)
      .where(
        and(
          eq(browserOwnerWindows.instanceId, args.instanceId),
          eq(
            browserOwnerWindows.primaryWindowId,
            args.candidate.primaryWindowId,
          ),
        ),
      );
    signal.throwIfAborted();
    if (references.length > 0) {
      return;
    }
    await tryCloseBrowserUseWindow(
      args,
      args.candidate.primaryWindowId,
      signal,
    );
  },
);

interface BrowserOwnerWindowInput extends BrowserUseNativeConnection {
  readonly owner: BrowserPublicAuthority;
  readonly instanceId: string;
  readonly initial: boolean;
}

async function prepareBrowserOwnerWindow(
  input: BrowserOwnerWindowInput,
  candidate: BrowserUseWindowCandidate,
  encryptedTabUrls: string | null,
  signal: AbortSignal,
): Promise<void> {
  await resizeBrowserUseSession(
    input.cdpUrl,
    BROWSER_SCREEN_WIDTH,
    BROWSER_INITIAL_SCREEN_HEIGHT,
    signal,
    candidate.primaryWindowId,
  );
  signal.throwIfAborted();
  if (encryptedTabUrls === null) {
    return;
  }
  const decoded = await decryptPersistentSecretValue(encryptedTabUrls, {
    userId: input.owner.userId,
  });
  signal.throwIfAborted();
  const urls = array(string().max(8192)).max(50).parse(JSON.parse(decoded));
  await restoreBrowserUseWindowTabUrls(input, candidate, urls, signal);
  signal.throwIfAborted();
}

/** Publish only a fully prepared native window. */
export const createBrowserOwnerWindow$ = command(
  async (
    { get, set },
    input: BrowserOwnerWindowInput,
    signal: AbortSignal,
  ): Promise<BrowserOwnerResult> => {
    const [snapshot] = await get(db$)
      .select({ encryptedTabUrls: browserSessionTabSnapshots.encryptedTabUrls })
      .from(browserOwnerProfiles)
      .leftJoin(
        browserSessionTabSnapshots,
        eq(browserSessionTabSnapshots.chatThreadId, input.owner.chatThreadId),
      )
      .where(
        and(
          eq(browserOwnerProfiles.orgId, input.owner.orgId),
          eq(browserOwnerProfiles.userId, input.owner.userId),
          eq(browserOwnerProfiles.instanceId, input.instanceId),
          eq(browserOwnerProfiles.status, "active"),
          // The creating request owns first-window setup. Other admissions
          // need a registered window, not just a published provider session.
          input.initial
            ? undefined
            : exists(
                new QueryBuilder()
                  .select({ chatThreadId: browserOwnerWindows.chatThreadId })
                  .from(browserOwnerWindows)
                  .where(eq(browserOwnerWindows.instanceId, input.instanceId)),
              ),
        ),
      );
    signal.throwIfAborted();
    if (!snapshot) {
      return unavailable;
    }
    const cleanup: WindowCandidateCleanup = {
      instanceId: input.instanceId,
      cdpUrl: input.cdpUrl,
      extension: input.extension,
      publicationUncertain: false,
    };
    const creationWork = (async () => {
      const candidate = input.initial
        ? await initialBrowserUseWindow(input.cdpUrl, signal)
        : await createBrowserUseWindow(input.cdpUrl, signal);
      cleanup.candidate = candidate;
      signal.throwIfAborted();
      await prepareBrowserOwnerWindow(
        input,
        candidate,
        snapshot.encryptedTabUrls,
        signal,
      );
      signal.throwIfAborted();
      cleanup.publicationUncertain = true;
      const published = await set(
        controlBrowserOwner$,
        input.owner,
        {
          kind: "admit",
          instanceId: input.instanceId,
          primaryWindowId: candidate.primaryWindowId,
        },
        signal,
      );
      cleanup.publicationUncertain = false;
      return published;
    })();
    const result = await settleIncludingAbort(creationWork);
    if (signal.aborted) {
      await settleIncludingAbort(
        set(
          cleanupWindowCandidate$,
          cleanup,
          AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        ),
      );
      signal.throwIfAborted();
    }
    const accepted =
      result.ok &&
      result.value.outcome === "accepted" &&
      result.value.window?.primaryWindowId ===
        cleanup.candidate?.primaryWindowId;
    if (!accepted) {
      // This cleanup owns its deadline; even expiry cannot replace admission's
      // result. An unreferenced residual window is reclaimed at Browser stop.
      await settleIncludingAbort(
        set(
          cleanupWindowCandidate$,
          cleanup,
          AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        ),
      );
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    if (!result.ok) {
      if (cleanup.publicationUncertain) {
        throw new BrowserUseProviderError(
          502,
          "BROWSER_USE_WINDOW_PUBLICATION_UNCERTAIN",
          "Managed Browser window publication could not be confirmed",
        );
      }
      throw result.error;
    }
    return accepted ? result.value : unavailable;
  },
);
