import { runnerBrowserContract } from "@okouai/api-contracts/contracts/runner-browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command, computed } from "ccstate";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  controlBrowserOwner$,
  createRunnerBrowserAuthority,
  createRunnerBrowserRead,
} from "../services/browser-owner.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import { createRunnerBrowserAllocation } from "../services/browser-owner-profile.service";
import { BrowserUseProviderError } from "../services/browser-use.service";
import { settle } from "../utils";

const cleanupActions = [
  "inspect",
  "retire",
  "completeWindowClose",
  "beginStop",
  "completeStop",
] as const;

const controlInput$ = computed(async (get) => {
  const body = await get(bodyResultOf(runnerBrowserContract.control));
  return body.ok
    ? { ...get(pathParamsOf(runnerBrowserContract.control)), ...body.data }
    : null;
});
const owner$ = createRunnerBrowserAuthority(controlInput$);
const readAction$ = computed(async (get) => {
  const input = await get(controlInput$);
  return input?.action.kind === "inspect" ? input.action : null;
});
const browserRead$ = createRunnerBrowserRead(owner$, readAction$);
const allocation$ = createRunnerBrowserAllocation(owner$);

const officialRunnerError$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = await set(runnerAuth$, get(authorization$), signal);
    signal.throwIfAborted();
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: { code: "UNAUTHORIZED", message: "Authentication required" },
        },
      };
    }
    if (auth.type !== "official-runner") {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN",
            message: "Official Runner authentication required",
          },
        },
      };
    }
    return null;
  },
);

const control$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const authError = await set(officialRunnerError$, signal);
  signal.throwIfAborted();
  if (authError) {
    return authError;
  }
  const body = await get(bodyResultOf(runnerBrowserContract.control));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const owner = await get(owner$);
  signal.throwIfAborted();
  if (!owner) {
    return { status: 200 as const, body: { outcome: "unavailable" as const } };
  }
  const featureContext = await set(
    loadUserFeatureSwitchContext$,
    owner.orgId,
    owner.userId,
    signal,
  );
  const enabled = isFeatureEnabled(
    FeatureSwitchKey.BrowserSharedOwner,
    featureContext,
  );
  if (
    !enabled &&
    !cleanupActions.some((kind) => {
      return kind === body.data.action.kind;
    })
  ) {
    return { status: 200 as const, body: { outcome: "unavailable" as const } };
  }
  if (body.data.action.kind === "inspect") {
    const result = await get(browserRead$);
    signal.throwIfAborted();
    return { status: 200 as const, body: result };
  }
  if (body.data.action.kind === "allocate") {
    const result = await settle(set(allocation$, signal));
    signal.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof BrowserUseProviderError) {
        return {
          status: result.error.status,
          body: {
            error: {
              code: result.error.code,
              message: "Managed browser provider profile is unavailable",
            },
          },
        };
      }
      throw result.error;
    }
    return { status: 200 as const, body: result.value };
  }
  const result = await set(
    controlBrowserOwner$,
    owner,
    body.data.action,
    signal,
  );
  return { status: 200 as const, body: result };
});

export const runnerBrowserRoutes: readonly RouteEntry[] = [
  { route: runnerBrowserContract.control, handler: control$ },
];
