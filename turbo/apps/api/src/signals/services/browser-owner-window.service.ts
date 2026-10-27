import type {
  RunnerBrowserAction,
  RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { browserOwnerWindows } from "@okouai/db/schema/browser-owner";
import { command, computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { settleIncludingAbort } from "../utils";
import {
  controlBrowserOwner$,
  createRunnerBrowserRead,
  type BrowserOwnerAuthority,
} from "./browser-owner.service";
import {
  BrowserUseProviderError,
  browserUseWindowExists,
  closeBrowserUseWindowCandidate,
  createBrowserUseWindow,
  getBrowserUseSession,
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
    await closeBrowserUseWindowCandidate(args.cdpUrl, args.candidate, signal);
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

/** One existing trusted admission operation owns the native candidate. */
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
      const current = context.current;
      const window = current.instance.window;
      if (
        window &&
        (window.state !== "active" || window.expiresAt <= nowDate().getTime())
      ) {
        return unavailable;
      }
      const cleanup: WindowCandidateCleanup = {
        instanceId: context.action.instanceId,
        publicationUncertain: false,
      };
      const result = await settleIncludingAbort(
        (async () => {
          const provider = await getBrowserUseSession(
            context.providerSessionId,
            signal,
          );
          signal.throwIfAborted();
          if (
            provider.id !== context.providerSessionId ||
            provider.status !== "active" ||
            !provider.cdpUrl
          ) {
            return unavailable;
          }
          const cdpUrl = provider.cdpUrl;
          cleanup.cdpUrl = cdpUrl;
          if (window) {
            if (
              !(await browserUseWindowExists(
                cdpUrl,
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
              verified.instance.window.primaryWindowId ===
                window.primaryWindowId
              ? verified
              : unavailable;
          }
          const candidate = await createBrowserUseWindow(cdpUrl, signal);
          cleanup.candidate = candidate;
          signal.throwIfAborted();
          cleanup.publicationUncertain = true;
          const published = await set(
            controlBrowserOwner$,
            context.owner,
            {
              kind: "admit",
              instanceId: context.action.instanceId,
              primaryWindowId: candidate.primaryWindowId,
            },
            signal,
          );
          cleanup.publicationUncertain = false;
          return published;
        })(),
      );
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
      if (!result.ok || result.value.outcome !== "accepted") {
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
        throw windowAdmissionFailure(
          result.error,
          cleanup.publicationUncertain,
        );
      }
      return result.value;
    },
  );
}
