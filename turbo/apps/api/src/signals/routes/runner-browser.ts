import { runnerBrowserContract } from "@okouai/api-contracts/contracts/runner-browser";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command } from "ccstate";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  controlBrowserOwner$,
  resolveRunnerBrowserAuthority$,
} from "../services/browser-owner.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";

const cleanupActions = [
  "inspect",
  "retire",
  "completeWindowClose",
  "beginStop",
  "completeStop",
] as const;

const control$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
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
  const body = await get(bodyResultOf(runnerBrowserContract.control));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { runId } = get(pathParamsOf(runnerBrowserContract.control));
  const owner = await set(
    resolveRunnerBrowserAuthority$,
    { runId, runnerIdentity: body.data.runnerIdentity },
    signal,
  );
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
