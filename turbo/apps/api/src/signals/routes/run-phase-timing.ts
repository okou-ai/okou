import { runPhaseTimingContract } from "@okouai/api-contracts/contracts/run-phase-timing";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";
import { notFound } from "../../lib/error";
import { runPhaseMarkEvent } from "../../lib/run-phase-mark";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { apiStartTime$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { getDatasetName, ingestAxiomDirect } from "../external/axiom";
import type { RouteEntry } from "../route-entry";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import { settleIncludingAbort } from "../utils";

const identity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return Promise.resolve({ orgId: auth.orgId, userId: auth.userId });
});
const features$ = createUserFeatureSwitchContext(identity$);
const markBody$ = bodyResultOf(runPhaseTimingContract.mark);

const mark$ = command(async ({ get, set }, signal: AbortSignal) => {
  const receivedAt = new Date(get(apiStartTime$));
  set(setResHeader$, "Cache-Control", "no-store");
  const features = await get(features$);
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.ArtifactGenerationTiming, features)) {
    return notFound("Run phase timing is unavailable");
  }
  const body = await get(markBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Phase marks require Run authentication");
  }
  const mark = body.data;
  const event = isFeatureEnabled(
    FeatureSwitchKey.ArtifactThreePointTiming,
    features,
  )
    ? runPhaseMarkEvent(auth, mark, receivedAt)
    : {
        _time: receivedAt.toISOString(),
        schema_version: 1,
        type: "run_phase_mark",
        run_id: auth.runId,
        user_id: auth.userId,
        org_id: auth.orgId,
        phase: mark.phase,
        ...(mark.phase === "generation-start"
          ? {
              generation_kind: mark.kind,
              research_skipped: mark.skipResearch,
            }
          : {}),
      };
  const telemetrySignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  // Acceptance owns one bounded attempt, not delivery. Preserve legal raw marks;
  // the three-point rollout adds the authenticated completion callback.
  waitUntil(
    settleIncludingAbort(
      ingestAxiomDirect(getDatasetName("web-logs"), [event], telemetrySignal),
    ),
  );
  return {
    status: 202 as const,
    body: { schemaVersion: 2 as const, status: "accepted" as const },
  };
});

export const runPhaseTimingRoutes: readonly RouteEntry[] = [
  {
    route: runPhaseTimingContract.mark,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "run-timing:write",
      },
      mark$,
    ),
  },
];
