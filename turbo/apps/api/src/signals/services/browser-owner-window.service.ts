import type {
  RunnerBrowserAction,
  RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
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
import { command, computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import {
  controlBrowserOwner$,
  createRunnerBrowserRead,
  type BrowserOwnerAuthority,
} from "./browser-owner.service";
import {
  BrowserUseProviderError,
  browserUseWindowExists,
  closeBrowserUseWindow,
  initialBrowserUseWindow,
  resizeBrowserUseSession,
  restoreBrowserUseWindowTabUrls,
  createBrowserUseWindow,
  findBrowserUseSession,
  type BrowserUseWindowCandidate,
} from "./browser-use.service";

const CLEANUP_TIMEOUT_MS = 15_000;
const unavailable = { outcome: "unavailable" } as const;
type AdmissionAction = Extract<RunnerBrowserAction, { kind: "admit" }>;
interface WindowCandidateCleanup {
  readonly instanceId: string;
  cdpUrl?: string;
  candidate?: BrowserUseWindowCandidate;
  publicationUncertain: boolean;
}

function windowAdmissionFailure(
  error: unknown,
  publicationUncertain: boolean,
): BrowserUseProviderError {
  if (publicationUncertain) {
    return new BrowserUseProviderError(
      502,
      "BROWSER_USE_WINDOW_PUBLICATION_UNCERTAIN",
      "Managed Browser window publication could not be confirmed",
    );
  }
  return error instanceof BrowserUseProviderError
    ? error
    : new BrowserUseProviderError(
        502,
        "BROWSER_USE_WINDOW_UNAVAILABLE",
        "Managed Browser window is unavailable",
      );
}

const cleanupWindowCandidate$ = command(
  async (
    { get },
    args: WindowCandidateCleanup,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!args.candidate || !args.cdpUrl || args.publicationUncertain) {
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
    await closeBrowserUseWindow(
      args.cdpUrl,
      args.candidate.primaryWindowId,
      signal,
    );
  },
);

interface BrowserOwnerWindowInput {
  readonly owner: BrowserOwnerAuthority;
  readonly instanceId: string;
  readonly cdpUrl: string;
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
  await restoreBrowserUseWindowTabUrls(input.cdpUrl, candidate, urls, signal);
  signal.throwIfAborted();
}

/** Both admission entry points publish only a fully prepared native window. */
export const createBrowserOwnerWindow$ = command(
  async (
    { get, set },
    input: BrowserOwnerWindowInput,
    signal: AbortSignal,
  ): Promise<RunnerBrowserResponse> => {
    const [snapshot] = await get(db$)
      .select({ encryptedTabUrls: browserSessionTabSnapshots.encryptedTabUrls })
      .from(browserOwnerProfiles)
      .leftJoin(
        browserSessionTabSnapshots,
        and(
          eq(browserSessionTabSnapshots.chatThreadId, input.owner.chatThreadId),
          eq(
            browserSessionTabSnapshots.ownerProfileId,
            browserOwnerProfiles.id,
          ),
        ),
      )
      .where(
        and(
          eq(browserOwnerProfiles.orgId, input.owner.orgId),
          eq(browserOwnerProfiles.userId, input.owner.userId),
          eq(browserOwnerProfiles.instanceId, input.instanceId),
          eq(browserOwnerProfiles.status, "active"),
        ),
      );
    signal.throwIfAborted();
    if (!snapshot) {
      return unavailable;
    }
    const cleanup: WindowCandidateCleanup = {
      instanceId: input.instanceId,
      cdpUrl: input.cdpUrl,
      publicationUncertain: false,
    };
    const result = await settleIncludingAbort(async () => {
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
    });
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
      result.value.instance.window?.primaryWindowId ===
        cleanup.candidate?.primaryWindowId;
    if (!accepted) {
      const cleaned = await settleIncludingAbort(
        set(
          cleanupWindowCandidate$,
          cleanup,
          AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        ),
      );
      signal.throwIfAborted();
      if (!cleaned.ok) {
        throw new BrowserUseProviderError(
          502,
          "BROWSER_USE_WINDOW_CLEANUP_FAILED",
          "Managed Browser window cleanup could not be confirmed",
        );
      }
    }
    signal.throwIfAborted();
    if (!result.ok) {
      if (cleanup.publicationUncertain) {
        throw windowAdmissionFailure(result.error, true);
      }
      throw result.error;
    }
    return accepted ? result.value : unavailable;
  },
);

function createAdmissionContext(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
  action$: Computed<Promise<AdmissionAction | null>>,
) {
  const readAction$ = computed(async (get) => {
    const action = await get(action$);
    return action
      ? { kind: "inspect" as const, instanceId: action.instanceId }
      : null;
  });
  const current$ = createRunnerBrowserRead(owner$, readAction$);
  // This read is first evaluated after native inspection, so it cannot reuse
  // the pre-inspection row if stop/retirement won while CDP was in flight.
  const verifiedCurrent$ = createRunnerBrowserRead(owner$, readAction$);
  const context$ = computed(async (get) => {
    const owner = await get(owner$);
    const action = await get(action$);
    const current = await get(current$);
    if (
      !owner ||
      !action ||
      current.outcome !== "accepted" ||
      current.instance.status !== "active" ||
      Date.parse(current.instance.timeoutAt) <= nowDate().getTime() ||
      !current.instance.providerSessionId
    ) {
      return null;
    }
    return {
      owner,
      action,
      current,
      providerSessionId: current.instance.providerSessionId,
    };
  });
  return { context$, verifiedCurrent$ };
}

/** Runner authentication stays at its entry point; admission has one owner. */
export function createRunnerBrowserAdmission(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
  action$: Computed<Promise<AdmissionAction | null>>,
) {
  const { context$, verifiedCurrent$ } = createAdmissionContext(
    owner$,
    action$,
  );
  return command(
    async (
      { get, set },
      signal: AbortSignal,
    ): Promise<RunnerBrowserResponse> => {
      const context = await get(context$);
      signal.throwIfAborted();
      if (!context) {
        return unavailable;
      }
      const window = context.current.instance.window;
      if (
        window &&
        (window.state !== "active" || window.expiresAt <= nowDate().getTime())
      ) {
        return unavailable;
      }
      const result = await settleIncludingAbort(async () => {
        const provider = await findBrowserUseSession(
          context.providerSessionId,
          signal,
        );
        signal.throwIfAborted();
        if (!provider || provider.status !== "active" || !provider.cdpUrl) {
          return unavailable;
        }
        if (window) {
          if (
            !(await browserUseWindowExists(
              provider.cdpUrl,
              window.primaryWindowId,
              signal,
            ))
          ) {
            return unavailable;
          }
          const verified = await get(verifiedCurrent$);
          signal.throwIfAborted();
          return verified.outcome === "accepted" &&
            verified.instance.status === "active" &&
            Date.parse(verified.instance.timeoutAt) > nowDate().getTime() &&
            verified.instance.window?.state === "active" &&
            verified.instance.window.expiresAt > nowDate().getTime() &&
            verified.instance.window.primaryWindowId === window.primaryWindowId
            ? verified
            : unavailable;
        }
        return await set(
          createBrowserOwnerWindow$,
          {
            owner: context.owner,
            instanceId: context.action.instanceId,
            cdpUrl: provider.cdpUrl,
            initial: false,
          },
          signal,
        );
      });
      signal.throwIfAborted();
      if (!result.ok) {
        throw windowAdmissionFailure(result.error, false);
      }
      return result.value;
    },
  );
}
