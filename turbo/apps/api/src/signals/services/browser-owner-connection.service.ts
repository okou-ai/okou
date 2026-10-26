import type {
  RunnerBrowserAction,
  RunnerBrowserConnectionResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command, computed, type Computed } from "ccstate";
import { now } from "../../lib/time";
import {
  type BrowserOwnerAuthority,
  createRunnerBrowserRead,
} from "./browser-owner.service";
import { getBrowserUseRunnerConnection } from "./browser-use.service";
import { createUserFeatureSwitchContext } from "./feature-switches.service";

type AuthorizationAction = Extract<RunnerBrowserAction, { kind: "authorize" }>;

function createConnectionAuthority(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
  action$: Computed<Promise<AuthorizationAction | null>>,
) {
  const current$ = createRunnerBrowserRead(owner$, action$);
  const features$ = createUserFeatureSwitchContext(owner$);
  return computed(async (get) => {
    const result = await get(current$);
    if (result.outcome === "unavailable") {
      return null;
    }
    const features = await get(features$);
    if (
      !features ||
      !isFeatureEnabled(FeatureSwitchKey.BrowserSharedOwner, features)
    ) {
      return null;
    }
    const { window, providerSessionId } = result.instance;
    if (window === null || providerSessionId === null) {
      throw new Error(
        "Authorized Browser connection is missing its live window",
      );
    }
    return { ...result.instance, window, providerSessionId };
  });
}

/** Separate read nodes revalidate the current decision after external I/O. */
export function createRunnerBrowserConnection(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
  action$: Computed<Promise<AuthorizationAction | null>>,
) {
  const initial$ = createConnectionAuthority(owner$, action$);
  const final$ = createConnectionAuthority(owner$, action$);
  return command(
    async (
      { get },
      signal: AbortSignal,
    ): Promise<RunnerBrowserConnectionResponse> => {
      const initial = await get(initial$);
      signal.throwIfAborted();
      if (!initial) {
        return { outcome: "unavailable" };
      }
      const provider = await getBrowserUseRunnerConnection(
        initial.providerSessionId,
        signal,
      );
      signal.throwIfAborted();
      if (!provider) {
        return { outcome: "unavailable" };
      }
      const current = await get(final$);
      signal.throwIfAborted();
      if (!current) {
        return { outcome: "unavailable" };
      }
      const expiresAt = Math.min(
        Date.parse(current.timeoutAt),
        current.window.expiresAt,
        Date.parse(provider.timeoutAt),
      );
      if (expiresAt <= now()) {
        return { outcome: "unavailable" };
      }
      return {
        outcome: "accepted",
        connection: {
          instanceId: current.id,
          providerSessionId: current.providerSessionId,
          chatThreadId: current.window.chatThreadId,
          primaryWindowId: current.window.primaryWindowId,
          cdpUrl: provider.cdpUrl,
          expiresAt,
        },
      };
    },
  );
}
